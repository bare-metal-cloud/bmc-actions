/**
 * The fake BMC protocol server — the REAL wire shapes from
 * web/backend/handlers/runner_results.go, implemented small:
 *
 *   POST   /api/v1/runner-runtime/_apis/pipelines/workflows/:runId/artifacts
 *   PATCH  /api/v1/runner-runtime/runner-blob?sig=…&chunk=<index>
 *   PUT    /api/v1/runner-runtime/_apis/pipelines/workflows/:runId/artifacts?artifactName=X
 *   GET    /api/v1/runner-runtime/_apis/pipelines/workflows/:runId/artifacts
 *   GET    /api/v1/runner-runtime/_apis/pipelines/workflows/:runId/artifacts/:name
 *   GET    /api/v1/runner-runtime/runner-files?sig=…
 *   GET    /api/v1/runner-runtime/runner-blob?sig=…
 *   DELETE /api/v1/runner-runtime/_apis/pipelines/workflows/:runId/artifacts?artifactName=X
 *
 * with the handler's status-code vocabularies (401 token law, 404
 * unified refusal, 409 chunk-index/expired/no-chunks/finalized, 413
 * caps) and the signed-URL grammar from services/runnerintake/blob_url.go
 * (base64url(JSON payload) + "." + base64url(HMAC-SHA256(key,
 * "blob|"+payload)), payload {"org","run","aid","p","exp"}).
 *
 * Faults are injectable per scenario so the client's error handling is
 * exercised the way the real server can misbehave.
 */

import * as http from 'http'
import * as crypto from 'crypto'

const PREFIX = '/api/v1/runner-runtime'
const ARTIFACTS = '/_apis/pipelines/workflows'
const BLOB = '/runner-blob'
const FILES = '/runner-files'

export interface FakeRow {
  id: number
  name: string
  runId: number
  state: 'created' | 'finalized'
  chunks: Map<number, Buffer>
  uploadId: string
  digest: string
  size: number
}

export interface FakeFaults {
  /**
   * Abort the connection AFTER receiving a chunk PATCH whose body
   * landed (the lost-response retry scenario). Fires once per
   * configured index.
   */
  dropChunkResponseAt?: number
  /** Answer expired-409 on the next N PATCH/finalize calls. */
  expireUploadTimes?: number
  /** Force every artifact detail/list to answer 404. */
  refuseAllReads?: boolean
}

export interface FakeServer {
  url: string
  close(): Promise<void>
  /** Clears all state (rows, patch counters) between tests. */
  reset(): void
  /** Direct state inspection for assertions. */
  rows(): FakeRow[]
  row(name: string): FakeRow | undefined
  /** The stored (finalized) bytes of one artifact. */
  bytes(name: string): Buffer | undefined
  faults: FakeFaults
  /** Counts of chunk PATCHes RECEIVED (dropped ones included). */
  patchCount(index: number): number
}

export function startFakeServer(options: {
  token: string
  runId: number
  signingKey: Buffer
}): Promise<FakeServer> {
  const rowsByName = new Map<string, FakeRow>()
  const baseUrlHolder = { value: '' }
  let nextId = 100
  const patches = new Map<number, number>()
  const faults: FakeFaults = {}

  const sign = (claims: {
    org: number
    run: number
    aid: number
    p: string
    exp: number
  }): string => {
    const payload = Buffer.from(JSON.stringify(claims), 'utf8')
    const mac = crypto
      .createHmac('sha256', options.signingKey)
      .update('blob|')
      .update(payload)
      .digest()
    return `${payload.toString('base64url')}.${mac.toString('base64url')}`
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(err => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    })
  })

  const readBody = (req: http.IncomingMessage): Promise<Buffer> => {
    const parts: Buffer[] = []
    return new Promise((resolve, reject) => {
      req.on('data', (chunk: Buffer) => parts.push(chunk))
      req.on('end', () => {
        resolve(Buffer.concat(parts))
      })
      req.on('error', reject)
    })
  }

  const json = (
    res: http.ServerResponse,
    status: number,
    body: unknown
  ): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const fail = (
    res: http.ServerResponse,
    status: number,
    message: string
  ): void => {
    json(res, status, { error: message })
  }

  const checkAuth = (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): boolean => {
    const header = req.headers.authorization ?? ''
    if (header !== `Bearer ${options.token}`) {
      fail(res, 401, 'the actions runtime token is malformed')
      return false
    }
    return true
  }

  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathName = url.pathname

    if (!checkAuth(req, res)) {
      return
    }
    // Route matching happens UNDER the CP prefix; the base the client
    // composes from (ACTIONS_RESULTS_URL) includes it.
    if (!pathName.startsWith(`${PREFIX}/`)) {
      fail(res, 404, `no such route: ${req.method} ${pathName}`)
      return
    }
    const rel = pathName.slice(PREFIX.length)

    // ── the metadata surface ──────────────────────────────────────────
    if (rel.startsWith(ARTIFACTS)) {
      const rest = rel.slice(ARTIFACTS.length)
      const runId = Number.parseInt(rest.split('/')[1] ?? '', 10)
      if (runId !== options.runId) {
        fail(
          res,
          401,
          'the runtime token names another job (the run id does not match)'
        )
        return
      }
      if (faults.refuseAllReads === true && req.method === 'GET') {
        fail(res, 404, 'artifact not found')
        return
      }

      // rest is "/<runId>/artifacts" (3 segments) for the collection
      // routes and "/<runId>/artifacts/<name>" (4) for the detail route.
      if (req.method === 'POST' && rest.split('/').length === 3) {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as {
          name?: string
        }
        const name = (body.name ?? '').trim()
        if (name.length === 0) {
          fail(res, 400, 'missing artifact name')
          return
        }
        let row = rowsByName.get(name)
        if (row !== undefined) {
          // The re-create arm: same row, fresh namespace, state resets.
          row.state = 'created'
          row.uploadId = crypto.randomBytes(16).toString('hex')
          row.chunks = new Map()
        } else {
          row = {
            id: nextId++,
            name,
            runId,
            state: 'created',
            chunks: new Map(),
            uploadId: crypto.randomBytes(16).toString('hex'),
            digest: '',
            size: 0
          }
          rowsByName.set(name, row)
        }
        const sig = sign({
          org: 1,
          run: runId,
          aid: row.id,
          p: 'up',
          exp: Math.floor(Date.now() / 1000) + 24 * 3600
        })
        json(res, 201, {
          fileContainerResourceUrl: `${baseUrlHolder.value}${BLOB}?sig=${sig}`
        })
        return
      }

      if (req.method === 'PUT' && rest.split('/').length === 3) {
        const name = (url.searchParams.get('artifactName') ?? '').trim()
        const row = rowsByName.get(name)
        if (row === undefined) {
          fail(res, 404, 'artifact not found')
          return
        }
        if (
          faults.expireUploadTimes !== undefined &&
          faults.expireUploadTimes > 0
        ) {
          faults.expireUploadTimes--
          fail(
            res,
            409,
            'the artifact upload expired — re-create the artifact and upload again'
          )
          return
        }
        if (row.state === 'finalized') {
          json(res, 200, finalizedBody(row))
          return
        }
        if (row.chunks.size === 0) {
          fail(
            res,
            409,
            'no uploaded chunks to finalize — PATCH the container URL first'
          )
          return
        }
        const indexes = [...row.chunks.keys()].sort((a, b) => a - b)
        const contiguous = indexes.every((v, i) => v === i)
        if (!contiguous) {
          fail(
            res,
            409,
            'the artifact upload is missing a stored chunk — re-create the artifact and upload again'
          )
          return
        }
        const assembled = Buffer.concat(indexes.map(i => row.chunks.get(i)!))
        row.digest = crypto.createHash('sha256').update(assembled).digest('hex')
        row.size = assembled.length
        row.state = 'finalized'
        json(res, 200, finalizedBody(row))
        return
      }

      if (req.method === 'GET' && rest.split('/').length === 3) {
        const value = [...rowsByName.values()]
          .filter(row => row.state === 'finalized')
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map(row => entryFor(row, runId))
        json(res, 200, { count: value.length, value })
        return
      }

      if (req.method === 'GET' && rest.split('/').length === 4) {
        const name = decodeURIComponent(rest.split('/')[3] ?? '')
        const row = rowsByName.get(name)
        if (row === undefined || row.state !== 'finalized') {
          fail(res, 404, 'artifact not found')
          return
        }
        const entry = entryFor(row, runId)
        entry['state'] = row.state
        json(res, 200, entry)
        return
      }

      if (req.method === 'DELETE' && rest.split('/').length === 3) {
        const name = (url.searchParams.get('artifactName') ?? '').trim()
        const row = rowsByName.get(name)
        if (row === undefined) {
          fail(res, 404, 'artifact not found')
          return
        }
        rowsByName.delete(name)
        json(res, 200, { name: row.name, deleted: true })
        return
      }
    }

    // ── the signed blob surface ───────────────────────────────────────
    if (rel === BLOB && req.method === 'PATCH') {
      const claims = verifySig(url.searchParams.get('sig'))
      if (claims === null) {
        fail(res, 401, 'the signed blob URL is malformed')
        return
      }
      const row = [...rowsByName.values()].find(
        candidate => candidate.id === claims.aid
      )
      if (row === undefined) {
        fail(res, 404, 'artifact not found')
        return
      }
      if (
        faults.expireUploadTimes !== undefined &&
        faults.expireUploadTimes > 0
      ) {
        faults.expireUploadTimes--
        fail(
          res,
          409,
          'the artifact upload expired — re-create the artifact and upload again'
        )
        return
      }
      if (row.state === 'finalized') {
        fail(
          res,
          409,
          'the artifact is already finalized — re-create it to upload again'
        )
        return
      }
      const index = Number.parseInt(url.searchParams.get('chunk') ?? '', 10)
      if (Number.isNaN(index) || index < 0) {
        fail(res, 400, 'the chunk query parameter is required')
        return
      }
      const body = await readBody(req)
      if (body.length > 64 * 1024 * 1024) {
        fail(
          res,
          413,
          "the artifact upload exceeds this surface's size cap (the per-chunk cap is 67108864 bytes)"
        )
        return
      }
      const received = (patches.get(index) ?? 0) + 1
      patches.set(index, received)
      const next = row.chunks.size
      const lastIndex = next === 0 ? -1 : Math.max(...row.chunks.keys())
      if (index !== next && !(next > 0 && index === lastIndex)) {
        fail(
          res,
          409,
          `the chunk index ${index} is not the next expected chunk (expected ${next})`
        )
        return
      }
      // The chunk lands BEFORE the response can be lost, so the
      // transport's idempotent retry of the SAME index overwrites the
      // same object — the handler's index law.
      row.chunks.set(index, body)
      if (faults.dropChunkResponseAt === index) {
        // The response is lost AFTER the chunk landed — the transport's
        // idempotent retry of the SAME index must recover.
        delete faults.dropChunkResponseAt
        res.destroy()
        return
      }
      json(res, 200, { received: received, index: index })
      return
    }

    if (rel === BLOB && req.method === 'GET') {
      const claims = verifySig(url.searchParams.get('sig'))
      if (claims === null) {
        fail(res, 401, 'the signed blob URL is malformed')
        return
      }
      const row = [...rowsByName.values()].find(
        candidate => candidate.id === claims.aid
      )
      if (row === undefined || row.state !== 'finalized') {
        fail(res, 404, 'artifact not found')
        return
      }
      const bytes = assembledBytes(row)
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length)
      })
      res.end(bytes)
      return
    }

    if (rel === FILES && req.method === 'GET') {
      const claims = verifySig(url.searchParams.get('sig'))
      if (claims === null) {
        fail(res, 401, 'the signed blob URL is malformed')
        return
      }
      const row = [...rowsByName.values()].find(
        candidate => candidate.id === claims.aid
      )
      if (row === undefined || row.state !== 'finalized') {
        fail(res, 404, 'artifact not found')
        return
      }
      const itemSig = sign({
        org: 1,
        run: row.runId,
        aid: row.id,
        p: 'down',
        exp: Math.floor(Date.now() / 1000) + 15 * 60
      })
      json(res, 200, [
        {
          path: `${row.name}.zip`,
          itemType: 'file',
          contentLocation: `${baseUrlHolder.value}${BLOB}?sig=${itemSig}`,
          contentLength: row.size,
          fileLength: row.size
        }
      ])
      return
    }

    fail(res, 404, `no such route: ${req.method} ${rel}`)
  }

  const entryFor = (row: FakeRow, runId: number): Record<string, unknown> => {
    const sig = sign({
      org: 1,
      run: runId,
      aid: row.id,
      p: 'down',
      exp: Math.floor(Date.now() / 1000) + 15 * 60
    })
    return {
      name: row.name,
      run_id: row.runId,
      size: row.size,
      digest: row.digest,
      fileContainerResourceUrl: `${baseUrlHolder.value}${FILES}?sig=${sig}`
    }
  }

  const finalizedBody = (row: FakeRow): Record<string, unknown> => ({
    name: row.name,
    state: row.state,
    size: row.size,
    digest: row.digest,
    finalized_at: new Date().toISOString()
  })

  const assembledBytes = (row: FakeRow): Buffer => {
    const indexes = [...row.chunks.keys()].sort((a, b) => a - b)
    return Buffer.concat(indexes.map(i => row.chunks.get(i)!))
  }

  const verifySig = (
    sig: string | null
  ): {
    org: number
    run: number
    aid: number
    p: string
    exp: number
  } | null => {
    if (sig === null) {
      return null
    }
    const dot = sig.lastIndexOf('.')
    if (dot <= 0) {
      return null
    }
    const payload = Buffer.from(sig.slice(0, dot), 'base64url')
    const mac = crypto
      .createHmac('sha256', options.signingKey)
      .update('blob|')
      .update(payload)
      .digest()
    if (!mac.equals(Buffer.from(sig.slice(dot + 1), 'base64url'))) {
      return null
    }
    try {
      return JSON.parse(payload.toString('utf8'))
    } catch {
      return null
    }
  }

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port =
        typeof address === 'object' && address !== null ? address.port : 0
      baseUrlHolder.value = `http://127.0.0.1:${port}${PREFIX}`
      const api: FakeServer = {
        url: baseUrlHolder.value,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close(err => {
              err === undefined ? resolveClose() : rejectClose(err)
            })
          }),
        reset: () => {
          rowsByName.clear()
          patches.clear()
        },
        rows: () => [...rowsByName.values()],
        row: name => rowsByName.get(name),
        bytes: name => {
          const row = rowsByName.get(name)
          return row === undefined ? undefined : assembledBytes(row)
        },
        faults,
        patchCount: index => patches.get(index) ?? 0
      }
      resolve(api)
    })
  })
}
