/**
 * The upload orchestration the upload-artifact action drives: the
 * create → chunk PATCH → finalize sequence from
 * web/backend/handlers/runner_results.go, with the protocol's two
 * documented client laws:
 *
 *   - overwrite=false refuses an existing name BEFORE any bytes move
 *     (upstream v4 fails the action on a duplicate name; the BMC create
 *     would otherwise take the re-create arm, so the check is ours);
 *     overwrite=true goes straight to create, whose re-create arm IS
 *     the overwrite (the server rotates the upload namespace, releases
 *     the old digest at the new finalize, aborts the stale chunks).
 *   - a 409 with the expired vocabulary (the B5.3 idle reaper retired
 *     the upload, or the row was re-created underneath us) is retried
 *     ONCE with a full re-create + re-upload — the recovery the
 *     protocol's 409 message names. Chunks never idle: they PATCH
 *     back-to-back, well inside the 15-minute window.
 */

import type { BmcArtifactClient } from './client'
import {
  ArtifactNotFoundError,
  BmcArtifactError,
  UploadExpiredError
} from './errors'
import type { PackedFile } from './tar'
import { packToChunks } from './tar'

/** The structured logger the orchestration talks to (@actions/core fits). */
export interface Log {
  info(message: string): void
  warning(message: string): void
  debug?(message: string): void
}

export interface UploadRequest {
  client: BmcArtifactClient
  artifactName: string
  /** The staged files (entry names relative to the artifact root). */
  files: PackedFile[]
  /** gzip level 0–9 (the upstream compression-level input). */
  compressionLevel: number
  overwrite: boolean
  log: Log
  /** Test seam; defaults to the protocol's 64 MiB chunk cap. */
  chunkSize?: number
  /** Full re-create attempts on the expired vocabulary (default 2). */
  maxCreateAttempts?: number
}

export interface UploadOutcome {
  artifactId: number | null
  digest: string
  size: number
}

/**
 * Uploads the staged files as ONE deterministic gzip'd tar artifact.
 */
export async function uploadArtifact(
  req: UploadRequest
): Promise<UploadOutcome> {
  const chunkSize = req.chunkSize ?? 64 * 1024 * 1024
  const maxAttempts = req.maxCreateAttempts ?? 2

  if (!req.overwrite) {
    // The duplicate-name refusal happens BEFORE the first byte moves.
    if (await artifactExists(req.client, req.artifactName)) {
      throw new BmcArtifactError(
        `an artifact with the name '${req.artifactName}' already exists on this ` +
          'run. Set overwrite: true to replace it, or choose a different name.'
      )
    }
  }
  return createAndUpload(req, chunkSize, maxAttempts)
}

/**
 * Answers whether the named artifact exists on this run. The server's
 * blob-surface 404 unifies missing and out-of-scope, so both read as
 * "no visible artifact to refuse".
 */
async function artifactExists(
  client: BmcArtifactClient,
  name: string
): Promise<boolean> {
  try {
    await client.getArtifact(name)
    return true
  } catch (err) {
    if (err instanceof ArtifactNotFoundError) {
      return false
    }
    throw err
  }
}

async function createAndUpload(
  req: UploadRequest,
  chunkSize: number,
  maxAttempts: number
): Promise<UploadOutcome> {
  let lastExpired: UploadExpiredError | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await uploadOnce(req, chunkSize)
    } catch (err) {
      if (err instanceof UploadExpiredError && attempt < maxAttempts) {
        lastExpired = err
        req.log.warning(
          `the upload expired server-side; re-creating '${req.artifactName}' ` +
            'and uploading again (attempt ' +
            `${attempt + 1} of ${maxAttempts})`
        )
        continue
      }
      throw err
    }
  }
  throw lastExpired ?? new BmcArtifactError('the upload could not complete')
}

async function uploadOnce(
  req: UploadRequest,
  chunkSize: number
): Promise<UploadOutcome> {
  const created = await req.client.createArtifact(req.artifactName)
  let chunkIndex = 0
  let bytesSent = 0
  for await (const chunk of packToChunks(
    req.files,
    req.compressionLevel,
    chunkSize
  )) {
    // Back-to-back PATCHes: the 15-minute idle window is never idled.
    await req.client.uploadChunk(created.uploadUrl, chunkIndex, chunk)
    bytesSent += chunk.length
    chunkIndex++
  }
  if (chunkIndex === 0) {
    throw new BmcArtifactError(
      'the packaged artifact produced no bytes — nothing to upload'
    )
  }
  req.log.info(
    `uploaded artifact '${req.artifactName}' in ${chunkIndex} chunk(s), ` +
      `${bytesSent} bytes total`
  )
  const finalized = await req.client.finalizeArtifact(req.artifactName)
  return {
    artifactId: created.artifactId,
    digest: finalized.digest,
    size: finalized.size
  }
}
