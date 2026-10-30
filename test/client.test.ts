/**
 * The protocol client against the fake server (the REAL wire shapes):
 * the create → chunk PATCH → finalize sequence, the index law and its
 * idempotent retry arm, the typed vocabularies (401/404/409/413), the
 * signed-URL decode, and the message discipline (never echo the token
 * or a signature).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  artifactIdFromSignedUrl,
  BmcArtifactClient,
  MAX_CHUNK_BYTES
} from '../shared/src/client'
import {
  ArtifactNotFoundError,
  ProtocolError,
  UploadExpiredError
} from '../shared/src/errors'
import type { FakeServer } from './fake-server'
import { startFakeServer } from './fake-server'
import { TEST_RUN_ID, TEST_SIGNING_KEY, TEST_TOKEN } from './helpers'

let server: FakeServer

beforeAll(async () => {
  server = await startFakeServer({
    token: TEST_TOKEN,
    runId: TEST_RUN_ID,
    signingKey: TEST_SIGNING_KEY
  })
})

afterAll(async () => {
  await server.close()
})

// Each test uses unique artifact names; the counters and rows reset so
// assertions like "this index was PATCHed exactly twice" read clean.
beforeEach(() => {
  server.reset()
})

const client = (): BmcArtifactClient =>
  new BmcArtifactClient({
    resultsUrl: server.url,
    runtimeToken: TEST_TOKEN,
    runId: TEST_RUN_ID,
    backoffMs: 1
  })

describe('create → chunk PATCH → finalize', () => {
  it('uploads and finalizes one chunk, byte-identical', async () => {
    const c = client()
    const created = await c.createArtifact('single-chunk')
    expect(created.uploadUrl).toContain(
      '/api/v1/runner-runtime/runner-blob?sig='
    )
    // The signed URL's payload decodes to the artifact's row id.
    expect(created.artifactId).toEqual(server.row('single-chunk')?.id ?? -1)

    const payload = Buffer.from('hello artifact store')
    await c.uploadChunk(created.uploadUrl, 0, payload)
    const finalized = await c.finalizeArtifact('single-chunk')
    expect(finalized.state).toBe('finalized')
    expect(finalized.size).toBe(payload.length)
    expect(finalized.digest).toMatch(/^[0-9a-f]{64}$/)

    // The stored bytes are the concatenated chunks, verbatim.
    expect(server.bytes('single-chunk')).toEqual(payload)
  })

  it('uploads sequential chunks and concatenates in index order', async () => {
    const c = client()
    const created = await c.createArtifact('multi-chunk')
    const a = Buffer.from('chunk-zero|')
    const b = Buffer.from('chunk-one|')
    const d = Buffer.from('chunk-two')
    await c.uploadChunk(created.uploadUrl, 0, a)
    await c.uploadChunk(created.uploadUrl, 1, b)
    await c.uploadChunk(created.uploadUrl, 2, d)
    await c.finalizeArtifact('multi-chunk')
    expect(server.bytes('multi-chunk')).toEqual(Buffer.concat([a, b, d]))
  })

  it('finalize is idempotent (200 twice, one artifact)', async () => {
    const c = client()
    const created = await c.createArtifact('finalize-twice')
    await c.uploadChunk(created.uploadUrl, 0, Buffer.from('bytes'))
    const first = await c.finalizeArtifact('finalize-twice')
    const second = await c.finalizeArtifact('finalize-twice')
    expect(second.digest).toBe(first.digest)
    expect(second.size).toBe(first.size)
  })

  it('finalize without chunks answers 409 with the server vocabulary', async () => {
    const c = client()
    await c.createArtifact('no-chunks')
    await expect(c.finalizeArtifact('no-chunks')).rejects.toThrow(
      /no uploaded chunks to finalize/
    )
  })

  it('a PATCH after finalize refuses 409 (the artifact left the upload state)', async () => {
    const c = client()
    const created = await c.createArtifact('patch-after-finalize')
    await c.uploadChunk(created.uploadUrl, 0, Buffer.from('bytes'))
    await c.finalizeArtifact('patch-after-finalize')
    await expect(
      c.uploadChunk(created.uploadUrl, 1, Buffer.from('late'))
    ).rejects.toThrow(/already finalized/)
  })
})

describe('the chunk index law', () => {
  it('a skip-ahead index is 409 with the expected-index message', async () => {
    const c = client()
    const created = await c.createArtifact('skip-ahead')
    await c.uploadChunk(created.uploadUrl, 0, Buffer.from('zero'))
    const err = await c
      .uploadChunk(created.uploadUrl, 2, Buffer.from('two'))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProtocolError)
    expect((err as ProtocolError).status).toBe(409)
    expect((err as Error).message).toContain('expected 1')
  })

  it('the SAME last index re-PATCHed is the idempotent retry arm', async () => {
    const c = client()
    const created = await c.createArtifact('retry-arm')
    await c.uploadChunk(created.uploadUrl, 0, Buffer.from('zero'))
    // The response was lost but the chunk landed: re-PATCH index 0.
    await c.uploadChunk(created.uploadUrl, 0, Buffer.from('zero'))
    await c.uploadChunk(created.uploadUrl, 1, Buffer.from('one'))
    await c.finalizeArtifact('retry-arm')
    expect(server.bytes('retry-arm')).toEqual(Buffer.from('zeroone'))
  })

  it('a lost chunk response recovers through the transport retry', async () => {
    const c = client()
    const created = await c.createArtifact('lost-response')
    server.faults.dropChunkResponseAt = 0
    await c.uploadChunk(created.uploadUrl, 0, Buffer.from('landed'))
    await c.finalizeArtifact('lost-response')
    expect(server.patchCount(0)).toBe(2)
    expect(server.bytes('lost-response')).toEqual(Buffer.from('landed'))
  })

  it('a 409 with the expired vocabulary surfaces as UploadExpiredError', async () => {
    const c = client()
    const created = await c.createArtifact('expired-mid')
    // One expiry for the chunk PATCH, one for the finalize.
    server.faults.expireUploadTimes = 2
    await expect(
      c.uploadChunk(created.uploadUrl, 0, Buffer.from('x'))
    ).rejects.toThrow(UploadExpiredError)
    await expect(c.finalizeArtifact('expired-mid')).rejects.toThrow(
      UploadExpiredError
    )
    delete server.faults.expireUploadTimes
  })
})

describe('the typed vocabularies', () => {
  it('a wrong token is 401 with the server message', async () => {
    const c = new BmcArtifactClient({
      resultsUrl: server.url,
      runtimeToken: 'wrong-token',
      runId: TEST_RUN_ID,
      attempts: 1
    })
    await expect(c.listArtifacts()).rejects.toThrow(
      /runtime token is malformed/
    )
  })

  it('a wrong run id is 401 with the wrong-job message', async () => {
    const c = new BmcArtifactClient({
      resultsUrl: server.url,
      runtimeToken: TEST_TOKEN,
      runId: 999,
      attempts: 1
    })
    await expect(c.listArtifacts()).rejects.toThrow(/names another job/)
  })

  it('a missing artifact detail is the unified 404', async () => {
    const c = client()
    await expect(c.getArtifact('does-not-exist')).rejects.toThrow(
      ArtifactNotFoundError
    )
  })

  it('an over-cap chunk is 413 with the per-chunk cap named', async () => {
    const c = client()
    const created = await c.createArtifact('too-big')
    const huge = Buffer.alloc(MAX_CHUNK_BYTES + 1, 7)
    const err = await c
      .uploadChunk(created.uploadUrl, 0, huge)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProtocolError)
    expect((err as ProtocolError).status).toBe(413)
    expect((err as Error).message).toContain('per-chunk cap')
  })
})

describe('list, detail, files, download, delete', () => {
  it('the full download flow: list → files → verbatim bytes', async () => {
    const c = client()
    const created = await c.createArtifact('downloadable')
    await c.uploadChunk(created.uploadUrl, 0, Buffer.from('the-payload'))
    await c.finalizeArtifact('downloadable')

    const list = await c.listArtifacts()
    const entry = list.find(a => a.name === 'downloadable')
    expect(entry).toBeDefined()
    expect(entry?.fileContainerResourceUrl).toContain('/runner-files?sig=')

    const files = await c.listFiles(entry!.fileContainerResourceUrl)
    expect(files).toHaveLength(1)
    expect(files[0]?.itemType).toBe('file')
    expect(files[0]?.path).toBe('downloadable.zip')

    const bytes = await c.downloadBytes(files[0]!.contentLocation)
    expect(Buffer.from(bytes).toString('utf8')).toBe('the-payload')
  })

  it('delete removes the artifact (404 afterwards)', async () => {
    const c = client()
    const created = await c.createArtifact('deletable')
    await c.uploadChunk(created.uploadUrl, 0, Buffer.from('x'))
    await c.finalizeArtifact('deletable')
    await c.deleteArtifact('deletable')
    await expect(c.getArtifact('deletable')).rejects.toThrow(
      ArtifactNotFoundError
    )
  })
})

describe('named detail with encoded names (B1)', () => {
  it('a name needing URL encoding resolves through the list fallback', async () => {
    const c = client()
    const created = await c.createArtifact('build output')
    await c.uploadChunk(created.uploadUrl, 0, Buffer.from('encoded-bytes'))
    await c.finalizeArtifact('build output')
    // The backend reads the RAW path segment, so the direct detail of
    // the encoded form 404s; the run-scoped list + exact match rescues.
    const entry = await c.getArtifact('build output')
    expect(entry.name).toBe('build output')
    expect(entry.size).toBe(Buffer.byteLength('encoded-bytes'))
  })
})

describe('transport hardening (B3 / N1)', () => {
  it('an error from a signed-URL endpoint never leaks the sig query', async () => {
    const c = client()
    const created = await c.createArtifact('sig-leak')
    await c.uploadChunk(created.uploadUrl, 0, Buffer.from('x'))
    await c.finalizeArtifact('sig-leak')
    const entry = await c.getArtifact('sig-leak')
    const files = await c.listFiles(entry.fileContainerResourceUrl)
    const location = files[0]!.contentLocation
    const realSig = new URL(location).searchParams.get('sig') ?? ''
    expect(realSig.length).toBeGreaterThan(0)
    // Tamper the signature so the runner-blob GET answers 401 WITH the
    // sig still sitting in the request URL.
    const tampered = location.replace(
      realSig,
      `${'A'.repeat(20)}.${'B'.repeat(20)}`
    )
    const err = await c.downloadBytes(tampered).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).not.toContain(realSig)
    expect(message).not.toContain('sig=')
    expect(message).not.toContain('AAAA')
    expect(message).toContain('the signed blob URL is malformed')
  })

  it('the transport refuses redirects: redirect: error reaches fetch', async () => {
    let capturedInit: RequestInit | undefined
    const c = new BmcArtifactClient({
      resultsUrl: server.url,
      runtimeToken: TEST_TOKEN,
      runId: TEST_RUN_ID,
      attempts: 1,
      backoffMs: 1,
      fetchImpl: ((_url, init) => {
        capturedInit = init
        return Promise.reject(new TypeError('fetch failed'))
      }) as typeof fetch
    })
    await expect(c.listArtifacts()).rejects.toThrow(/failed/)
    // The mutation witness: flipping http.ts to redirect: 'follow'
    // surfaces here and fails this assertion.
    expect(capturedInit?.redirect).toBe('error')
  })

  it('a 302 answer is refused, never followed', async () => {
    let calls = 0
    const c = new BmcArtifactClient({
      resultsUrl: server.url,
      runtimeToken: TEST_TOKEN,
      runId: TEST_RUN_ID,
      attempts: 1,
      fetchImpl: (() => {
        calls++
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://evil.example/steal' }
          })
        )
      }) as typeof fetch
    })
    const err = await c.listArtifacts().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProtocolError)
    expect((err as ProtocolError).status).toBe(302)
    expect(calls).toBe(1)
  })

  it('a stalled response body times out (the body read is bounded too)', async () => {
    const c = new BmcArtifactClient({
      resultsUrl: server.url,
      runtimeToken: TEST_TOKEN,
      runId: TEST_RUN_ID,
      attempts: 1,
      metadataTimeoutMs: 100,
      fetchImpl: (() => {
        // Headers arrive immediately; the body stream never delivers
        // a byte and never closes.
        const body = new ReadableStream<Uint8Array>({ start() {} })
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        )
      }) as typeof fetch
    })
    await expect(c.listArtifacts()).rejects.toThrow(
      /response body timed out after 100ms/
    )
  })

  it('a raw fetch error never echoes the signed URL', async () => {
    const signedUrl = `${server.url}/api/v1/runner-runtime/runner-blob?sig=abc.def`
    const c = new BmcArtifactClient({
      resultsUrl: server.url,
      runtimeToken: TEST_TOKEN,
      runId: TEST_RUN_ID,
      attempts: 1,
      fetchImpl: ((reqUrl: string | URL | Request) => {
        // Node's own layer interpolates the full URL into some errors.
        return Promise.reject(
          new TypeError(`Failed to parse URL from ${reqUrl}`)
        )
      }) as unknown as typeof fetch
    })
    const err = await c.downloadBytes(signedUrl).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).not.toContain('sig=')
    expect(message).not.toContain('abc.def')
    expect(message).toContain('failed')
  })
})

describe('message discipline', () => {
  it('errors never carry the runtime token or a signature', async () => {
    const secretToken = 'super-secret-token-1234567890'
    const c = new BmcArtifactClient({
      resultsUrl: server.url,
      runtimeToken: secretToken,
      runId: TEST_RUN_ID,
      attempts: 1
    })
    const err = await c.listArtifacts().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).not.toContain(secretToken)
    expect(message).not.toContain('sig=')
  })

  it('a hung request times out', async () => {
    const c = new BmcArtifactClient({
      resultsUrl: server.url,
      runtimeToken: TEST_TOKEN,
      runId: TEST_RUN_ID,
      attempts: 1,
      metadataTimeoutMs: 50,
      fetchImpl: () => new Promise<Response>(() => {}) // never settles
    })
    await expect(c.listArtifacts()).rejects.toThrow(/timed out after 50ms/)
  })

  it('protocol errors render the URL with the query stripped', async () => {
    const c = client()
    const err = await c.getArtifact('missing-again').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ArtifactNotFoundError)
    const message = (err as Error).message
    expect(message).not.toContain('sig=')
    expect(message).toContain('artifact not found')
  })
})

describe('the signed-URL payload decode', () => {
  it('decodes the artifact row id from a create URL', async () => {
    const c = client()
    const created = await c.createArtifact('sig-decode')
    const id = artifactIdFromSignedUrl(created.uploadUrl)
    expect(id).toBe(server.row('sig-decode')?.id)
  })

  it('answers null for a URL without a sig or a decodable payload', () => {
    expect(artifactIdFromSignedUrl('https://host/runner-blob')).toBeNull()
    expect(
      artifactIdFromSignedUrl('https://host/runner-blob?sig=not-a-signature')
    ).toBeNull()
    expect(artifactIdFromSignedUrl('not a url at all')).toBeNull()
  })
})
