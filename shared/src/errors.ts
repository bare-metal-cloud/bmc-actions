/**
 * Typed errors for the BMC artifact protocol client and the two actions.
 *
 * Message discipline: NO error message ever contains the runtime token or
 * a signed-URL query string. `redactUrl` strips queries before any URL is
 * interpolated into a message.
 */

/** Base class for every failure this package raises on purpose. */
export class BmcArtifactError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * The BMC_ARTIFACT_STORE marker is absent (or not '1'): the action ran
 * somewhere that has no BMC artifact store mounted. Raised BEFORE any
 * network call, always.
 */
export class MarkerMissingError extends BmcArtifactError {}

/**
 * The runner environment is incomplete: a variable the protocol needs
 * (the results URL, the runtime token, the run id) is missing or
 * malformed. Raised before any network call.
 */
export class RunnerEnvError extends BmcArtifactError {}

/**
 * The server answered with a non-success status. `status` and the
 * (redacted) request context ride as fields so callers can branch on
 * typed outcomes — 404 vs 409 — instead of parsing messages.
 */
export class ProtocolError extends BmcArtifactError {
  public readonly status: number
  /** The request method — useful in the rendered message. */
  public readonly method: string
  /** The request URL with its query string redacted away. */
  public readonly redactedUrl: string
  /** The server's own `error` message, when the body carried one. */
  public readonly serverMessage: string

  public constructor(
    status: number,
    method: string,
    url: string,
    serverMessage: string
  ) {
    const redacted = redactUrl(url)
    const detail = serverMessage.length > 0 ? `: ${serverMessage}` : ''
    super(`${method} ${redacted} failed with HTTP ${status}${detail}`)
    this.status = status
    this.method = method
    this.redactedUrl = redacted
    this.serverMessage = serverMessage
  }
}

/**
 * The server answered 409 with the expired/re-create vocabulary (the
 * B5.3 reaper retired the upload, or the row was re-created underneath
 * us). The protocol's documented recovery: re-create the artifact and
 * upload again.
 */
export class UploadExpiredError extends BmcArtifactError {}

/**
 * The server answered 404 for an artifact that was expected to exist.
 * The blob-surface refusal is the SAME 404 for missing and out-of-scope,
 * so the message must not claim which one it is.
 */
export class ArtifactNotFoundError extends BmcArtifactError {
  public constructor(method: string, url: string) {
    super(`${method} ${redactUrl(url)}: artifact not found`)
  }
}

/** The download's bytes fail their integrity check (digest mismatch). */
export class DigestMismatchError extends BmcArtifactError {}

/**
 * Strips the query string from a URL for safe inclusion in error
 * messages. The query carries the runtime-authorized signature (`sig=`)
 * — a credential, never to be echoed — and the message must never carry
 * the runtime token, which is never part of a URL in the first place.
 * A URL that fails to parse is rendered as `[unparseable URL]`.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    // Not an absolute URL (path-only signed URL): cut at the '?'.
    const q = url.indexOf('?')
    return q === -1 ? url : url.slice(0, q)
  }
}
