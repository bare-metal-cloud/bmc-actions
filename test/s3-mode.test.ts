/**
 * Direct object-store mode end to end: the real actions' run bodies
 * against a fake S3 through the real AWS SDK. No BMC marker, no BMC
 * control plane.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runUpload } from '../upload-artifact/src/main'
import { runDownload } from '../download-artifact/src/main'
import type { FakeS3 } from './fake-s3'
import { startFakeS3 } from './fake-s3'
import { BOOLEAN_INPUT_DEFAULTS, captureStdout, withActionEnv } from './helpers'
import { S3_PART_BYTES } from '../shared/src/s3store'

const BUCKET = 'bmc-artifacts'
let s3: FakeS3
let ws: string

beforeAll(async () => {
  s3 = await startFakeS3(BUCKET)
})
afterAll(async () => {
  await s3.close()
})
beforeEach(() => {
  s3.objects.clear()
  s3.requests.length = 0
  s3.stats.multipartStarted = s3.stats.multipartCompleted = s3.stats.aborted = 0
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bmc-s3-'))
})

const s3Inputs = (): Record<string, string> => ({
  's3-endpoint': s3.url,
  's3-bucket': BUCKET,
  's3-access-key': 'AKIATEST',
  's3-secret-key': 'secretsecretsecret',
  's3-region': 'auto',
  's3-prefix': 'ci'
})
// Deliberately NO BMC_ARTIFACT_STORE and NO ACTIONS_* variables.
const ghEnv = (runId = '777'): Record<string, string | undefined> => ({
  BMC_ARTIFACT_STORE: undefined,
  ACTIONS_RESULTS_URL: undefined,
  ACTIONS_RUNTIME_TOKEN: undefined,
  GITHUB_RUN_ID: runId,
  GITHUB_REPOSITORY: 'acme/widgets',
  GITHUB_WORKSPACE: ws,
  ...BOOLEAN_INPUT_DEFAULTS
})

async function upload(
  inputs: Record<string, string>,
  runId = '777'
): Promise<{ error: Error | null; outputs: Record<string, string> }> {
  const sandbox = withActionEnv({ ...s3Inputs(), ...inputs }, ghEnv(runId))
  let error: Error | null = null
  try {
    await captureStdout(() => runUpload(process.env))
  } catch (e) {
    error = e as Error
  }
  const outputs = sandbox.outputs()
  sandbox.restore()
  return { error, outputs }
}

async function download(
  inputs: Record<string, string>,
  runId = '777'
): Promise<{ error: Error | null }> {
  const sandbox = withActionEnv({ ...s3Inputs(), ...inputs }, ghEnv(runId))
  let error: Error | null = null
  try {
    await captureStdout(() => runDownload(process.env))
  } catch (e) {
    error = e as Error
  }
  sandbox.restore()
  return { error }
}

const write = (rel: string, data: string | Buffer): void => {
  const p = path.join(ws, 'src', rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
}

describe('direct object-store mode', () => {
  it('round-trips a tree with no BMC marker and no control plane', async () => {
    write('a.txt', 'hello')
    write('sub/b.txt', 'world')
    const up = await upload({ name: 'build', path: path.join(ws, 'src') })
    expect(up.error).toBeNull()
    expect(up.outputs['artifact-digest']).toMatch(/^[0-9a-f]{64}$/)
    expect([...s3.objects.keys()].sort()).toEqual([
      'ci/acme/widgets/777/build/artifact.tgz',
      'ci/acme/widgets/777/build/manifest.json'
    ])
    const manifest = JSON.parse(
      s3.objects.get('ci/acme/widgets/777/build/manifest.json')!.toString()
    )
    const stored = s3.objects.get('ci/acme/widgets/777/build/artifact.tgz')!
    expect(manifest.digest).toBe(
      crypto.createHash('sha256').update(stored).digest('hex')
    )
    expect(up.outputs['artifact-digest']).toBe(manifest.digest)

    const out = path.join(ws, 'out')
    const dl = await download({ name: 'build', path: out })
    expect(dl.error).toBeNull()
    expect(fs.readFileSync(path.join(out, 'a.txt'), 'utf8')).toBe('hello')
    expect(fs.readFileSync(path.join(out, 'sub/b.txt'), 'utf8')).toBe('world')
  })

  it('uses multipart for artifacts larger than one part and the bytes survive', async () => {
    // Incompressible data > 2 parts at the 32 MiB part size.
    const big = crypto.randomBytes(S3_PART_BYTES * 2 + 1024 * 1024)
    write('big.bin', big)
    const up = await upload({
      name: 'big',
      path: path.join(ws, 'src'),
      'compression-level': '0'
    })
    expect(up.error).toBeNull()
    expect(s3.stats.multipartStarted).toBe(1)
    expect(s3.stats.multipartCompleted).toBe(1)
    const out = path.join(ws, 'out')
    expect((await download({ name: 'big', path: out })).error).toBeNull()
    expect(
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(out, 'big.bin')))
        .digest('hex')
    ).toBe(crypto.createHash('sha256').update(big).digest('hex'))
  }, 120_000)

  it('refuses a duplicate name unless overwrite is true', async () => {
    write('a.txt', 'one')
    expect(
      (await upload({ name: 'x', path: path.join(ws, 'src') })).error
    ).toBeNull()
    const dup = await upload({ name: 'x', path: path.join(ws, 'src') })
    expect(dup.error?.message).toMatch(/already exists/)
    write('a.txt', 'two')
    const over = await upload({
      name: 'x',
      path: path.join(ws, 'src'),
      overwrite: 'true'
    })
    expect(over.error).toBeNull()
    const out = path.join(ws, 'out')
    await download({ name: 'x', path: out })
    expect(fs.readFileSync(path.join(out, 'a.txt'), 'utf8')).toBe('two')
  })

  it('downloads all artifacts of a run into per-artifact dirs, and by pattern', async () => {
    write('f.txt', 'f')
    await upload({ name: 'one', path: path.join(ws, 'src') })
    await upload({ name: 'two', path: path.join(ws, 'src') })
    const all = path.join(ws, 'all')
    expect((await download({ path: all })).error).toBeNull()
    expect(fs.existsSync(path.join(all, 'one/f.txt'))).toBe(true)
    expect(fs.existsSync(path.join(all, 'two/f.txt'))).toBe(true)
    const pat = path.join(ws, 'pat')
    expect((await download({ pattern: 'tw*', path: pat })).error).toBeNull()
    expect(fs.existsSync(path.join(pat, 'two/f.txt'))).toBe(true)
    expect(fs.existsSync(path.join(pat, 'one'))).toBe(false)
  })

  it('reads another run via run-id (cross-run handoff)', async () => {
    write('f.txt', 'from run 5')
    await upload({ name: 'h', path: path.join(ws, 'src') }, '5')
    const out = path.join(ws, 'out')
    const dl = await download({ name: 'h', path: out, 'run-id': '5' }, '999')
    expect(dl.error).toBeNull()
    expect(fs.readFileSync(path.join(out, 'f.txt'), 'utf8')).toBe('from run 5')
  })

  it('fails (and extracts nothing) when the stored bytes do not match the manifest digest', async () => {
    write('f.txt', 'good')
    await upload({ name: 't', path: path.join(ws, 'src') })
    const key = 'ci/acme/widgets/777/t/artifact.tgz'
    const b = Buffer.from(s3.objects.get(key)!)
    b.writeUInt8((b.readUInt8(b.length - 5) ^ 0xff) & 0xff, b.length - 5)
    s3.objects.set(key, b)
    const out = path.join(ws, 'out')
    const dl = await download({ name: 't', path: out })
    expect(dl.error?.message).toMatch(/digest validation/)
    expect(fs.existsSync(out)).toBe(false)
  })

  it('reports a missing artifact and unsafe names, and rejects artifact-ids', async () => {
    const out = path.join(ws, 'out')
    expect((await download({ name: 'nope', path: out })).error?.message).toBe(
      "Artifact 'nope' not found"
    )
    write('f.txt', 'x')
    expect(
      (await upload({ name: '../evil', path: path.join(ws, 'src') })).error
        ?.message
    ).toMatch(/not a safe path/)
    expect(
      (await download({ 'artifact-ids': '1', path: out })).error?.message
    ).toMatch(/not supported in direct object-store mode/)
  })

  it('names the missing s3 inputs (the fork-PR empty-secret case)', async () => {
    write('f.txt', 'x')
    const r = await upload({
      name: 'a',
      path: path.join(ws, 'src'),
      's3-access-key': '',
      's3-secret-key': ''
    })
    expect(r.error?.message).toMatch(/missing: s3-access-key, s3-secret-key/)
    expect(s3.requests).toHaveLength(0)
  })

  it('without s3-endpoint the BMC marker law still refuses first', async () => {
    const sandbox = withActionEnv(
      { name: 'a', path: ws },
      { ...ghEnv(), BMC_ARTIFACT_STORE: undefined }
    )
    let error: Error | null = null
    try {
      await captureStdout(() => runUpload(process.env))
    } catch (e) {
      error = e as Error
    }
    sandbox.restore()
    expect(error?.message).toMatch(/only runs on BMC runners/)
  })
})
