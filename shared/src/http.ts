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
      const result = await requestOnce(doFetch, options.timeoutMs, {
        method,
        url,
        headers,
        body
      })
      if (RETRYABLE_STATUS.has(result.status) && attempt < options.attempts) {
        lastError = new ProtocolError(
          result.status,
          method,
          url,
          safeErrorText(result)
        )
        await delay(options.backoffMs * attempt)
        continue
      }
      return result
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

/**
 * ONE request attempt: the headers arrive under a raced timeout, and
 * the SAME request-level AbortController stays alive through the body
 * read under a second raced timeout — a stalled body aborts the actual
 * fetch (the signal is what tears the undici connection down), where a
 * post-hoc body.cancel() cannot (the stream is locked by the reader).
 * The timeout is a RACE, not just an abort: a fetch that honors the
 * signal rejects on abort, but one that ignores it can never settle —
 * the racing rejection bounds every phase either way.
 */
async function requestOnce(
  doFetch: typeof fetch,
  timeoutMs: number,
  req: {
    method: string
    url: string
    headers: Record<string, string>
    body: Uint8Array | undefined
  }
): Promise<FetchResult> {
  const controller = new AbortController()
  const stall = (
    phase: 'request' | 'response body'
  ): {
    timeout: Promise<never>
    clear: () => void
  } => {
    let timerHandle: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timerHandle = setTimeout(() => {
        controller.abort()
        reject(new TimeoutFetchError(timeoutMs, req.url, phase))
      }, timeoutMs)
    })
    return {
      timeout,
      clear: () => {
        clearTimeout(timerHandle)
      }
    }
  }

  const headers = stall('request')
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

  let response: Response
  try {
    response = await Promise.race([doFetch(req.url, init), headers.timeout])
  } finally {
    headers.clear()
  }

  const bodyStall = stall('response body')
  try {
    const buffer = await Promise.race([
      response.arrayBuffer(),
      bodyStall.timeout
    ])
    return {
      status: response.status,
      headers: response.headers,
      body: new Uint8Array(buffer)
    }
  } finally {
    bodyStall.clear()
  }
}

function safeErrorText(result: Pick<FetchResult, 'body'>): string {
  const text = new TextDecoder().decode(result.body)
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

function timer(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}
