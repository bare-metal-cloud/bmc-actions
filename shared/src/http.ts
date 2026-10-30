/**
 * Thin fetch wrapper: a timeout on every request AND on every body
 * read, a never-followed redirect policy, and a small retry loop ONLY
 * where the protocol has an idempotent story.
 *
 * Retry law (verified against the backend handler, story B5.2):
 *   - GET is inherently safe to repeat.
 *   - create (POST) re-answers through the server's re-create arm — the
 *     recorded retry law (the upload id rotates; a retry is a clean
 *     namespace).
 *   - finalize (PUT) is idempotent — a finalized row answers the same
 *     200 without re-storing.
 *   - a chunk PATCH of the SAME index is the protocol's idempotent
 *     retry arm: the same last index re-PATCHed overwrites the same
 *     chunk object harmlessly ("the index law"; the handler sweeps and
 *     re-counts conservatively). The caller therefore retries only the
 *     chunk index it is already sending.
 *   - everything else (4xx other than 429, 500) fails fast: the client
 *     never retries a refusal.
 *
 * MESSAGE DISCIPLINE: the underlying fetch layer interpolates the full
 * URL into some of its errors (Node's "Failed to parse URL from …" and
 * socket failures) — and the signed URLs carry a `sig=` credential in
 * their query. Every error leaving this module is therefore either one
 * of the typed, already-redacted errors, or wrapped with the URL's
 * query stripped.
 */

import { ProtocolError } from './errors'

export interface FetchRetryOptions {
  /** Per-attempt timeout in milliseconds (headers AND body read). */
  timeoutMs: number
  /** Total attempts (1 = no retry). */
  attempts: number
  /** Base backoff between attempts, milliseconds. */
  backoffMs: number
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch
  /** Injectable delay for tests (defaults to a real timer). */
  delayImpl?: (ms: number) => Promise<void>
}

export interface FetchResult {
  status: number
  headers: Headers
  body: Uint8Array
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504])

export class TimeoutFetchError extends Error {
  /**
   * @param phase whether the HEADERS or the response BODY stalled —
   *   both are bounded by the same per-request timeout.
   */
  public constructor(
    timeoutMs: number,
    public readonly url: string,
    phase: 'request' | 'response body' = 'request'
  ) {
    super(`${phase} timed out after ${timeoutMs}ms: ${safeUrl(url)}`)
    this.name = 'TimeoutFetchError'
  }
}

/** Strips the query string from a URL for safe display. */
function safeUrl(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

/**
 * Wraps an error from the fetch layer so no raw URL (with its signed
 * query) can leak through the message. Typed errors are already safe
 * and pass through untouched.
 */
function wrapFetchError(err: unknown, url: string): Error {
  if (err instanceof TimeoutFetchError || err instanceof ProtocolError) {
    return err
  }
  const raw = err instanceof Error ? err.message : String(err)
  // Two sweeps: the exact URL this module sent (the common echo), and
  // any credential-shaped query parameter the layer interpolated from
  // another rendering of it.
  let message = raw.split(url).join(safeUrl(url))
  message = message.replace(
    /([?&])(sig|token|access_token)=[^&\s'")\\]+/gi,
    '$1$2=[redacted]'
  )
  return new Error(`request to ${safeUrl(url)} failed: ${message}`)
}

/**
 * Performs the request with hard timeouts and the idempotent retry
 * loop. Network failures, timeouts (headers or body), and the
 * retryable server statuses (429/502/503/504) are retried up to
 * `attempts` total attempts with linear backoff; any other non-2xx
 * returns so the caller maps the protocol vocabulary.
 */
export async function fetchBuffer(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Uint8Array | undefined,
  options: FetchRetryOptions
): Promise<FetchResult> {
  const doFetch = options.fetchImpl ?? fetch
  const delay = options.delayImpl ?? ((ms: number) => timer(ms))
  let lastError: unknown
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      const response = await doFetchWithTimeout(doFetch, options.timeoutMs, {
        method,
        url,
        headers,
        body
      })
      if (RETRYABLE_STATUS.has(response.status) && attempt < options.attempts) {
        lastError = new ProtocolError(
          response.status,
          method,
          url,
          await safeErrorText(response)
        )
        await delay(options.backoffMs * attempt)
        continue
      }
      // The abort race above bounds the HEADERS; the body read gets
      // its own raced timeout so a stalled transfer cannot hang the
      // client forever.
      const body_ = new Uint8Array(
        await readBodyWithTimeout(response, options.timeoutMs, url)
      )
      return { status: response.status, headers: response.headers, body: body_ }
    } catch (err) {
      lastError = wrapFetchError(err, url)
      if (attempt < options.attempts) {
        await delay(options.backoffMs * attempt)
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`request to ${safeUrl(url)} failed`)
}

async function doFetchWithTimeout(
  doFetch: typeof fetch,
  timeoutMs: number,
  req: {
    method: string
    url: string
    headers: Record<string, string>
    body: Uint8Array | undefined
  }
): Promise<Response> {
  const controller = new AbortController()
  // The timeout is a RACE, not just an abort: a fetch that honors the
  // signal rejects on abort, but one that ignores it can never settle —
  // the racing rejection bounds every request either way.
  let timerHandle: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timerHandle = setTimeout(() => {
      controller.abort()
      reject(new TimeoutFetchError(timeoutMs, req.url))
    }, timeoutMs)
  })
  const init: RequestInit = {
    method: req.method,
    headers: req.headers,
    signal: controller.signal,
    // Never follow redirects: the BMC surface never answers with one,
    // and following could carry the bearer token to another origin.
    redirect: 'error'
  }
  if (req.body !== undefined) {
    // Node 20's undici-backed fetch accepts a Uint8Array body.
    init.body = new Uint8Array(req.body)
  }
  try {
    return await Promise.race([doFetch(req.url, init), timeout])
  } finally {
    clearTimeout(timerHandle)
  }
}

/**
 * Reads the response body under its own raced timeout. On timeout the
 * body stream is cancelled (tearing the connection down) and a typed
 * error rejects — a stalled multi-gigabyte transfer cannot hang the
 * client.
 */
async function readBodyWithTimeout(
  response: Response,
  timeoutMs: number,
  url: string
): Promise<ArrayBuffer> {
  let timerHandle: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timerHandle = setTimeout(() => {
      reject(new TimeoutFetchError(timeoutMs, url, 'response body'))
      void response.body?.cancel().catch(() => {})
    }, timeoutMs)
  })
  try {
    return await Promise.race([response.arrayBuffer(), timeout])
  } finally {
    clearTimeout(timerHandle)
  }
}

async function safeErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.length > 300 ? `${text.slice(0, 300)}…` : text
  } catch {
    return ''
  }
}

function timer(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}
