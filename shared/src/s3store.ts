/**
 * Direct object-store mode (interim): the artifact actions talk to an
 * S3-compatible bucket (Cloudflare R2) with no BMC control plane, so any
 * runner — GitHub-hosted included — can use them while the BMC artifact
 * store is not live.
 *
 * Layout, per artifact:
 *   <prefix>/<owner>/<repo>/<runId>/<name>/artifact.tgz    the deterministic tar.gz
 *   <prefix>/<owner>/<repo>/<runId>/<name>/manifest.json   written LAST (the finalize)
 *
 * The manifest is the commit marker: an artifact exists only once its
 * manifest does, and it carries the SHA-256 the download side verifies.
 */

import * as crypto from 'crypto'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from '@aws-sdk/client-s3'
import { BmcArtifactError, DigestMismatchError } from './errors'
import type { PackedFile } from './tar'
import { packToChunks } from './tar'
import type { Log } from './upload'

/** Multipart part size (S3 minimum is 5 MiB for every part but the last). */
export const S3_PART_BYTES = 32 * 1024 * 1024

export interface S3Config {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  /** Key prefix inside the bucket (no leading/trailing slash). */
  prefix: string
}

export interface S3Scope {
  /** owner/repo whose artifacts these are. */
  repository: string
  runId: string
}

export interface S3Manifest {
  name: string
  size: number
  digest: string
  createdAt: string
}

/** True when the workflow asked for direct object-store mode. */
export function isS3Mode(getInput: (name: string) => string): boolean {
  return getInput('s3-endpoint').trim().length > 0
}

/**
 * Reads and validates the s3-* inputs. Every missing piece is named so a
 * mis-wired secret fails with one actionable sentence, before any network
 * call. (Secrets are empty strings on fork PRs — the usual cause.)
 */
export function readS3Config(getInput: (name: string) => string): S3Config {
  const endpoint = getInput('s3-endpoint').trim()
  const bucket = getInput('s3-bucket').trim()
  const accessKeyId = getInput('s3-access-key').trim()
  const secretAccessKey = getInput('s3-secret-key').trim()
  const missing = [
    ['s3-bucket', bucket],
    ['s3-access-key', accessKeyId],
    ['s3-secret-key', secretAccessKey]
  ]
    .filter(([, v]) => v === '')
    .map(([k]) => k)
  if (missing.length > 0) {
    throw new BmcArtifactError(
      `direct object-store mode (s3-endpoint is set) is missing: ${missing.join(', ')}. ` +
        'If these come from secrets, note that secrets are empty on pull ' +
        'requests from forks and in repositories the org secret is not shared with.'
    )
  }
  if (!/^https?:\/\//.test(endpoint)) {
    throw new BmcArtifactError(
      `s3-endpoint must be an http(s) URL, got '${endpoint}'`
    )
  }
  const prefix = (getInput('s3-prefix').trim() || 'ci').replace(
    /^\/+|\/+$/g,
    ''
  )
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: getInput('s3-region').trim() || 'auto',
    prefix
  }
}

/** Refuses names/segments that could escape the key or extraction tree. */
export function assertSafeSegment(label: string, value: string): void {
  if (
    value === '' ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some(seg => seg === '..' || seg === '.' || seg === '')
  ) {
    throw new BmcArtifactError(`${label} '${value}' is not a safe path`)
  }
}

export class S3ArtifactStore {
  private readonly s3: S3Client
  private readonly base: string

  constructor(
    private readonly cfg: S3Config,
    scope: S3Scope,
    client?: S3Client
  ) {
    assertSafeSegment('repository', scope.repository)
    if (!/^[1-9][0-9]*$/.test(scope.runId)) {
      throw new BmcArtifactError(
        `run id '${scope.runId}' is not a positive integer`
      )
    }
    this.base = `${cfg.prefix}/${scope.repository}/${scope.runId}`
    this.s3 =
      client ??
      new S3Client({
        endpoint: cfg.endpoint,
        region: cfg.region,
        forcePathStyle: true,
        credentials: {
          accessKeyId: cfg.accessKeyId,
          secretAccessKey: cfg.secretAccessKey
        },
        // R2 does not implement the SDK's default CRC32 trailer checksums.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED'
      })
  }

  private dataKey(name: string): string {
    return `${this.base}/${name}/artifact.tgz`
  }
  private manifestKey(name: string): string {
    return `${this.base}/${name}/manifest.json`
  }

  async exists(name: string): Promise<boolean> {
    assertSafeSegment('artifact name', name)
    try {
      await this.s3.send(
        new HeadObjectCommand({
          Bucket: this.cfg.bucket,
          Key: this.manifestKey(name)
        })
      )
      return true
    } catch (err) {
      if (httpStatus(err) === 404) return false
      throw wrap('checking for an existing artifact', err)
    }
  }

  async upload(
    name: string,
    files: PackedFile[],
    compressionLevel: number,
    overwrite: boolean,
    log: Log,
    partSize: number = S3_PART_BYTES
  ): Promise<S3Manifest> {
    assertSafeSegment('artifact name', name)
    if (!overwrite && (await this.exists(name))) {
      throw new BmcArtifactError(
        `an artifact with the name '${name}' already exists on this run. ` +
          'Set overwrite: true to replace it, or choose a different name.'
      )
    }
    const key = this.dataKey(name)
    const hash = crypto.createHash('sha256')
    let size = 0
    let uploadId: string | undefined
    const parts: { ETag: string; PartNumber: number }[] = []
    try {
      let held: Buffer | undefined
      for await (const chunk of packToChunks(
        files,
        compressionLevel,
        partSize
      )) {
        hash.update(chunk)
        size += chunk.length
        if (held === undefined) {
          held = chunk
          continue
        }
        // A second chunk exists: this is a multipart upload.
        if (uploadId === undefined) {
          const created = await this.s3.send(
            new CreateMultipartUploadCommand({
              Bucket: this.cfg.bucket,
              Key: key,
              ContentType: 'application/gzip'
            })
          )
          uploadId = created.UploadId
          if (uploadId === undefined) {
            throw new BmcArtifactError('the store returned no multipart id')
          }
        }
        parts.push(await this.putPart(key, uploadId, parts.length + 1, held))
        held = chunk
      }
      if (held === undefined) {
        throw new BmcArtifactError(
          'the packaged artifact produced no bytes — nothing to upload'
        )
      }
      if (uploadId === undefined) {
        await this.s3.send(
          new PutObjectCommand({
            Bucket: this.cfg.bucket,
            Key: key,
            Body: held,
            ContentType: 'application/gzip'
          })
        )
      } else {
        parts.push(await this.putPart(key, uploadId, parts.length + 1, held))
        await this.s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.cfg.bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts }
          })
        )
      }
    } catch (err) {
      if (uploadId !== undefined) {
        await this.s3
          .send(
            new AbortMultipartUploadCommand({
              Bucket: this.cfg.bucket,
              Key: key,
              UploadId: uploadId
            })
          )
          .catch(() => undefined)
      }
      throw wrap(`uploading '${name}'`, err)
    }
    const manifest: S3Manifest = {
      name,
      size,
      digest: hash.digest('hex'),
      createdAt: new Date().toISOString()
    }
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.cfg.bucket,
          Key: this.manifestKey(name),
          Body: JSON.stringify(manifest),
          ContentType: 'application/json'
        })
      )
    } catch (err) {
      throw wrap(`finalizing '${name}'`, err)
    }
    log.info(
      `uploaded artifact '${name}' (${size} bytes, ${uploadId === undefined ? 'single' : `${parts.length}-part`} upload)`
    )
    return manifest
  }

  private async putPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer
  ): Promise<{ ETag: string; PartNumber: number }> {
    const res = await this.s3.send(
      new UploadPartCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body
      })
    )
    if (res.ETag === undefined) {
      throw new BmcArtifactError(`part ${partNumber} returned no ETag`)
    }
    return { ETag: res.ETag, PartNumber: partNumber }
  }

  /** Finalized artifacts of the run (those whose manifest exists). */
  async list(): Promise<S3Manifest[]> {
    const keys: string[] = []
    let token: string | undefined
    try {
      do {
        const page = await this.s3.send(
          new ListObjectsV2Command({
            Bucket: this.cfg.bucket,
            Prefix: `${this.base}/`,
            ContinuationToken: token
          })
        )
        for (const obj of page.Contents ?? []) {
          if (obj.Key?.endsWith('/manifest.json') === true) keys.push(obj.Key)
        }
        token =
          page.IsTruncated === true ? page.NextContinuationToken : undefined
      } while (token !== undefined)
    } catch (err) {
      throw wrap('listing artifacts', err)
    }
    const out: S3Manifest[] = []
    for (const key of keys) {
      out.push(await this.readManifestAt(key))
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  async getManifest(name: string): Promise<S3Manifest | null> {
    assertSafeSegment('artifact name', name)
    if (!(await this.exists(name))) return null
    return this.readManifestAt(this.manifestKey(name))
  }

  private async readManifestAt(key: string): Promise<S3Manifest> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key })
      )
      const text = (await res.Body?.transformToString()) ?? ''
      const parsed = JSON.parse(text) as S3Manifest
      assertSafeSegment('artifact name', parsed.name)
      return parsed
    } catch (err) {
      throw wrap(`reading ${key}`, err)
    }
  }

  /** Downloads the artifact bytes and verifies the manifest's SHA-256. */
  async download(manifest: S3Manifest): Promise<Buffer> {
    let bytes: Buffer
    try {
      const res = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.cfg.bucket,
          Key: this.dataKey(manifest.name)
        })
      )
      bytes = Buffer.from((await res.Body?.transformToByteArray()) ?? [])
    } catch (err) {
      throw wrap(`downloading '${manifest.name}'`, err)
    }
    const actual = crypto.createHash('sha256').update(bytes).digest('hex')
    if (actual !== manifest.digest) {
      throw new DigestMismatchError(
        `artifact '${manifest.name}' failed digest validation ` +
          `(expected ${manifest.digest}, got ${actual}); refusing to extract`
      )
    }
    return bytes
  }
}

function httpStatus(err: unknown): number | undefined {
  const e = err as { $metadata?: { httpStatusCode?: number } }
  return e.$metadata?.httpStatusCode
}

function wrap(what: string, err: unknown): Error {
  if (err instanceof BmcArtifactError) return err
  const status = httpStatus(err)
  const msg = err instanceof Error ? err.message : String(err)
  return new BmcArtifactError(
    `object store error while ${what}${status === undefined ? '' : ` (HTTP ${status})`}: ${msg}`
  )
}
