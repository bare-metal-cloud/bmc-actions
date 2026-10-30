/**
 * The BMC artifact-store protocol client (story B5.5 phase 2).
 *
 * THE WIRE — every shape below mirrors web/backend/handlers/runner_results.go
 * (story B5.2) EXACTLY. The routes mount behind the CP results base
 * (ACTIONS_RESULTS_URL, which in v1 equals the runtime URL: platform
 * base + /api/v1/runner-runtime):
 *
 *   POST   {base}/_apis/pipelines/workflows/:runId/artifacts
 *          body {"name": "<name>"} → 201 {"fileContainerResourceUrl"}
 *          (an existing (org, run, name) row re-enters the created
 *          state through the server's re-create arm and answers a fresh
 *          upload URL — the overwrite/retry law)
 *   PATCH  <fileContainerResourceUrl>&chunk=<index>
 *          RAW octet-stream body → 200; the chunk index law: strictly
 *          increasing from 0, the SAME last index re-PATCHed is the
 *          idempotent retry arm, anything else is 409. One chunk is at
 *          most 64 MiB (the per-request cap), the artifact total at
 *          most 4 GiB (refused as 413 as chunks land).
 *   PUT    {base}/_apis/pipelines/workflows/:runId/artifacts
 *          ?artifactName=<name> → 200 {name, state, size, digest,
 *          finalized_at}; idempotent. 409 with the expired vocabulary
 *          when the idle reaper retired the upload — the client
 *          re-creates and re-uploads (the overwrite law).
 *   GET    {base}/_apis/pipelines/workflows/:runId/artifacts
 *          → {"count": n, "value": [entry]} — FINALIZED artifacts only
 *   GET    {base}/_apis/pipelines/workflows/:runId/artifacts/:name
 *          → entry (+ state/created_at/finalized_at); 404 "artifact not
 *          found" for missing AND out-of-scope (the unified refusal)
 *   GET    <fileContainerResourceUrl>  (the runner-files listing)
 *          → [{"path", "itemType", "contentLocation", "contentLength",
 *          "fileLength"}]
 *   GET    <contentLocation>  (the runner-blob download)
 *          → raw stored bytes (verbatim, Content-Type
 *          application/octet-stream)
 *   DELETE {base}/_apis/pipelines/workflows/:runId/artifacts
 *          ?artifactName=<name> → 200 {"name", "deleted": true}
 *
 * AUTH: `Authorization: Bearer <ACTIONS_RUNTIME_TOKEN>` on EVERY call —
 * the metadata endpoints and the signed-URL endpoints alike (the signed
 * URL authorizes the target, the runtime token authorizes the caller;
 * both verify server-side). Writes are JOB-bound, reads RUN-bound.
 *
 * THE 15-MINUTE IDLE WINDOW: the backend's reaper (story B5.3) aborts
 * uploads that idle longer than 15 minutes between chunks. This client
 * PATCHes chunks back-to-back and never idles.
 */

import { parseRunId } from './env'
import {
  ArtifactNotFoundError,
  ProtocolError,
  UploadExpiredError
} from './errors'
import type { FetchRetryOptions } from './http'
import { fetchBuffer } from './http'

/**
 * The per-chunk cap — RunnerResultsMaxChunkBytes in
 * web/backend/handlers/runner_results.go (the body-limit middleware
 * admits exactly this bound on the PATCH route).
 */
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024

/** The vocabulary the server's expired arms answer 409 with. */
const EXPIRED_VOCABULARY = 'expired'

/** A list/detail entry (the wire field names, verbatim). */
export interface ArtifactEntry {
  name: string
  runId: number
  size: number
  digest: string
  fileContainerResourceUrl: string
  /** Detail responses only. */
  state?: string | undefined
}

/** One entry of the runner-files item listing. */
export interface ArtifactFileEntry {
  path: string
  itemType: string
  contentLocation: string
  contentLength: number
  fileLength: number
}

/** The finalize/detail body. */
export interface FinalizedArtifact {
  name: string
  state: string
  size: number
  digest: string
}

export interface BmcClientOptions {
  /** CP results base (ACTIONS_RESULTS_URL), trailing slash tolerated. */
  resultsUrl: string
  /** The job's runtime token. Never logged, never echoed. */
  runtimeToken: string
  /** The token job's run id (GITHUB_RUN_ID). */
  runId: number
  /** Per-attempt timeout for metadata calls (default 30 s). */
  metadataTimeoutMs?: number
  /** Per-attempt timeout for one chunk PATCH (default 10 min). */
  chunkTimeoutMs?: number
  /** Per-attempt timeout for the download GET (default 10 min). */
  downloadTimeoutMs?: number
  /** Total attempts per request, 1 disables retry (default 3). */
  attempts?: number
  /** Base backoff between attempts (default 1000 ms). */
  backoffMs?: number
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch
}

const DEFAULT_METADATA_TIMEOUT_MS = 30_000
const DEFAULT_CHUNK_TIMEOUT_MS = 600_000
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 600_000
const DEFAULT_ATTEMPTS = 3
const DEFAULT_BACKOFF_MS = 1_000

export class BmcArtifactClient {
  private readonly base: string
  private readonly token: string
  private readonly runId: number
  private readonly metadataTimeoutMs: number
  private readonly chunkTimeoutMs: number
  private readonly downloadTimeoutMs: number
  private readonly attempts: number
  private readonly backoffMs: number
  private readonly fetchImpl: typeof fetch

  public constructor(options: BmcClientOptions) {
    this.base = options.resultsUrl.endsWith('/')
      ? options.resultsUrl.slice(0, -1)
      : options.resultsUrl
    this.token = options.runtimeToken
    this.runId = options.runId
    this.metadataTimeoutMs =
      options.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS
    this.chunkTimeoutMs = options.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS
    this.downloadTimeoutMs =
      options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
    this.attempts = options.attempts ?? DEFAULT_ATTEMPTS
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** The metadata surface path (the v4-create grammar's route). */
  private get artifactsPath(): string {
    return `${this.base}/_apis/pipelines/workflows/${this.runId}/artifacts`
  }

  /**
   * Creates (or re-creates — the server's overwrite arm) the artifact
   * and answers the signed upload URL plus the artifact's row id
   * (decoded from the signed URL's payload; null when the URL does not
   * decode — the id is informational, never load-bearing).
   */
  public async createArtifact(name: string): Promise<{
    uploadUrl: string
    artifactId: number | null
  }> {
    const body = Buffer.from(JSON.stringify({ name }), 'utf8')
    const res = await this.request(
      'POST',
      this.artifactsPath,
      { 'content-type': 'application/json' },
      new Uint8Array(body),
      this.metadataTimeoutMs
    )
    this.expectStatus(res, 201)
    const parsed = parseJsonObject(res.body)
    const uploadUrl = requireString(parsed, 'fileContainerResourceUrl')
    return { uploadUrl, artifactId: artifactIdFromSignedUrl(uploadUrl) }
  }

  /**
   * PATCHes one chunk at `index` through the signed upload URL. The
   * chunk index law makes a retry of the SAME index idempotent, so this
   * method is safe to retry on network failures (and the transport
   * does).
   */
  public async uploadChunk(
    uploadUrl: string,
    index: number,
    data: Uint8Array
  ): Promise<void> {
    const separator = uploadUrl.includes('?') ? '&' : '?'
    const url = `${uploadUrl}${separator}chunk=${index}`
    const res = await this.request(
      'PATCH',
      url,
      { 'content-type': 'application/octet-stream' },
      data,
      this.chunkTimeoutMs
    )
    if (res.status === 409 && res.text().includes(EXPIRED_VOCABULARY)) {
      throw new UploadExpiredError(expiredMessage())
    }
    this.expectStatus(res, 200)
  }

  /**
   * Finalizes the artifact (commits the bytes to the store). Idempotent
   * server-side; a 409 with the expired vocabulary surfaces as
   * UploadExpiredError so the caller can re-create.
   */
  public async finalizeArtifact(name: string): Promise<FinalizedArtifact> {
    const url = `${this.artifactsPath}?artifactName=${encodeURIComponent(name)}&finalize=true`
    const res = await this.request(
      'PUT',
      url,
      {},
      undefined,
      this.metadataTimeoutMs
    )
    if (res.status === 409 && res.text().includes(EXPIRED_VOCABULARY)) {
      throw new UploadExpiredError(expiredMessage())
    }
    this.expectStatus(res, 200)
    const parsed = parseJsonObject(res.body)
    return {
      name: requireString(parsed, 'name'),
      state: requireString(parsed, 'state'),
      size: requireNumber(parsed, 'size'),
      digest: requireString(parsed, 'digest')
    }
  }

  /** Lists the run's FINALIZED artifacts (the download population). */
  public async listArtifacts(): Promise<ArtifactEntry[]> {
    const res = await this.request(
      'GET',
      this.artifactsPath,
      {},
      undefined,
      this.metadataTimeoutMs
    )
    this.expectStatus(res, 200)
    const parsed = parseJsonObject(res.body)
    const value = parsed['value']
    if (!Array.isArray(value)) {
      throw new ProtocolError(
        res.status,
        'GET',
        this.artifactsPath,
        'the list response is missing its "value" array'
      )
    }
    return value.map(parseEntry)
  }

  /** Gets one finalized artifact's detail (404 when missing/out-of-scope). */
  public async getArtifact(name: string): Promise<ArtifactEntry> {
    const url = `${this.artifactsPath}/${encodeURIComponent(name)}`
    const res = await this.request(
      'GET',
      url,
      {},
      undefined,
      this.metadataTimeoutMs
    )
    this.expectStatusOrNotFound(res, 'GET', url)
    return parseEntry(parseJsonObject(res.body))
  }

  /**
   * Lists the files the artifact holds (the runner-files container
   * listing). v1 answers the single assembled blob as one file.
   */
  public async listFiles(containerUrl: string): Promise<ArtifactFileEntry[]> {
    const res = await this.request(
      'GET',
      containerUrl,
      {},
      undefined,
      this.metadataTimeoutMs
    )
    this.expectStatusOrNotFound(res, 'GET', containerUrl)
    const parsed: unknown = JSON.parse(new TextDecoder().decode(res.body))
    if (!Array.isArray(parsed)) {
      throw new ProtocolError(
        res.status,
        'GET',
        containerUrl,
        'the container listing is not the item array'
      )
    }
    return parsed.map(item => {
      if (typeof item !== 'object' || item === null) {
        throw new ProtocolError(
          res.status,
          'GET',
          containerUrl,
          'a container listing item is not an object'
        )
      }
      const obj = item as Record<string, unknown>
      return {
        path: requireString(obj, 'path'),
        itemType: requireString(obj, 'itemType'),
        contentLocation: requireString(obj, 'contentLocation'),
        contentLength: requireNumber(obj, 'contentLength'),
        fileLength: requireNumber(obj, 'fileLength')
      }
    })
  }

  /**
   * Downloads the artifact's stored bytes (the runner-blob GET; the
   * stored bytes stream verbatim).
   */
  public async downloadBytes(contentLocation: string): Promise<Uint8Array> {
    const res = await this.request(
      'GET',
      contentLocation,
      {},
      undefined,
      this.downloadTimeoutMs
    )
    this.expectStatusOrNotFound(res, 'GET', contentLocation)
    return res.body
  }

  /** Deletes the artifact (the v4 delete grammar). */
  public async deleteArtifact(name: string): Promise<void> {
    const url = `${this.artifactsPath}?artifactName=${encodeURIComponent(name)}`
    const res = await this.request(
      'DELETE',
      url,
      {},
      undefined,
      this.metadataTimeoutMs
    )
    this.expectStatusOrNotFound(res, 'DELETE', url)
  }

  // ── internals ────────────────────────────────────────────────────────

  private request(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Uint8Array | undefined,
    timeoutMs: number
  ): Promise<ProtocolResponse> {
    const options: FetchRetryOptions = {
      timeoutMs,
      attempts: this.attempts,
      backoffMs: this.backoffMs,
      fetchImpl: this.fetchImpl
    }
    const withAuth: Record<string, string> = {
      ...headers,
      // The bearer token NEVER enters a URL or a message — only this
      // header, which the transport keeps out of any error rendering.
      authorization: `Bearer ${this.token}`
    }
    return fetchBuffer(method, url, withAuth, body, options).then(
      raw => new ProtocolResponse(raw, method, url)
    )
  }

  private expectStatus(res: ProtocolResponse, want: number): void {
    if (res.status === want) {
      return
    }
    throw this.mapFailure(res)
  }

  private expectStatusOrNotFound(
    res: ProtocolResponse,
    method: string,
    url: string
  ): void {
    if (res.status === 404) {
      throw new ArtifactNotFoundError(method, url)
    }
    if (res.status < 200 || res.status >= 300) {
      throw this.mapFailure(res)
    }
  }

  private mapFailure(res: ProtocolResponse): Error {
    if (res.status === 409 && res.text().includes(EXPIRED_VOCABULARY)) {
      return new UploadExpiredError(expiredMessage())
    }
    return new ProtocolError(
      res.status,
      res.method,
      res.url,
      res.serverMessage()
    )
  }
}

/**
 * The one request response the client works with: status, body, and the
 * lazily-parsed server `error` field (the house error renderer answers
 * {"error": "<message>"}; anything else passes through verbatim).
 */
class ProtocolResponse {
  public constructor(
    private readonly raw: {
      status: number
      headers: Headers
      body: Uint8Array
    },
    private readonly reqMethod: string,
    private readonly reqUrl: string
  ) {}

  public get status(): number {
    return this.raw.status
  }

  public get body(): Uint8Array {
    return this.raw.body
  }

  public get method(): string {
    return this.reqMethod
  }

  public get url(): string {
    return this.reqUrl
  }

  public text(): string {
    return new TextDecoder().decode(this.raw.body)
  }

  public serverMessage(): string {
    const parsed = tryParseJsonObject(this.text())
    if (parsed !== null && typeof parsed['error'] === 'string') {
      return parsed['error']
    }
    return this.text()
  }
}

function expiredMessage(): string {
  return (
    'the artifact upload expired server-side (the idle-upload reaper ' +
    'retired it, or the artifact was re-created): re-create the artifact ' +
    'and upload again'
  )
}

function parseJsonObject(body: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(body)
  const parsed = tryParseJsonObject(text)
  if (parsed === null) {
    throw new Error(
      `the server response is not a JSON object: ${text.slice(0, 200)}`
    )
  }
  return parsed
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `the server response is missing the "${field}" string field`
    )
  }
  return value
}

function requireNumber(obj: Record<string, unknown>, field: string): number {
  const value = obj[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `the server response is missing the "${field}" number field`
    )
  }
  return value
}

function parseEntry(value: unknown): ArtifactEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error('a list entry is not an object')
  }
  const obj = value as Record<string, unknown>
  const runId = requireNumber(obj, 'run_id')
  return {
    name: requireString(obj, 'name'),
    runId,
    size: requireNumber(obj, 'size'),
    digest: requireString(obj, 'digest'),
    fileContainerResourceUrl: requireString(obj, 'fileContainerResourceUrl'),
    state: typeof obj['state'] === 'string' ? obj['state'] : undefined
  }
}

/**
 * Decodes the artifact's ROW id from a signed blob URL. The signature
 * wire shape (services/runnerintake/blob_url.go) is
 * base64url(JSON payload) + "." + base64url(HMAC-SHA256) with the
 * payload carrying {"org","run","aid","p","exp"}; the payload half is
 * plain base64url JSON, so the (unauthenticated but unambiguous) row id
 * reads back for the artifact-id output. Tampering cannot forge a
 * signature — this only READS what the server already signed.
 */
export function artifactIdFromSignedUrl(url: string): number | null {
  const q = url.indexOf('?')
  if (q === -1) {
    return null
  }
  const params = new URLSearchParams(url.slice(q + 1))
  const sig = params.get('sig')
  if (sig === null) {
    return null
  }
  const dot = sig.lastIndexOf('.')
  if (dot <= 0) {
    return null
  }
  try {
    const payloadJson = Buffer.from(sig.slice(0, dot), 'base64url').toString(
      'utf8'
    )
    const payload: unknown = JSON.parse(payloadJson)
    if (
      typeof payload === 'object' &&
      payload !== null &&
      typeof (payload as Record<string, unknown>)['aid'] === 'number'
    ) {
      const aid = (payload as Record<string, unknown>)['aid']
      return typeof aid === 'number' && Number.isInteger(aid) && aid > 0
        ? aid
        : null
    }
    return null
  } catch {
    return null
  }
}

/**
 * Re-exports parseRunId for action packages (they validate the run-id
 * input against GITHUB_RUN_ID).
 */
export { parseRunId }
