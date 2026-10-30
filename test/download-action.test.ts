/**
 * The download action end to end against the fake protocol server:
 * the upstream layout rules (single named → directly into path;
 * multiple → per-artifact directories; merge-multiple → merged), the
 * artifact-ids selection over the signed-URL ids, the pattern filter,
 * the not-found vocabulary, the digest warning, and the run-scope
 * guards.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { runDownload } from '../download-artifact/src/main'
import { runUpload } from '../upload-artifact/src/main'
import type { FakeServer } from './fake-server'
import { startFakeServer } from './fake-server'
import { BmcArtifactClient } from '../shared/src/client'
import { packToChunks } from '../shared/src/tar'
import {
  BOOLEAN_INPUT_DEFAULTS,
  captureStdout,
  TEST_RUN_ID,
  TEST_SIGNING_KEY,
  TEST_TOKEN,
  withActionEnv
} from './helpers'

let server: FakeServer
let workspace: string

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

beforeEach(() => {
  server.reset()
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bmc-download-'))
})

const bmcEnv = (): Record<string, string> => ({
  BMC_ARTIFACT_STORE: '1',
  ACTIONS_RESULTS_URL: server.url,
  ACTIONS_RUNTIME_TOKEN: TEST_TOKEN,
  GITHUB_RUN_ID: String(TEST_RUN_ID),
  GITHUB_WORKSPACE: workspace,
  ...BOOLEAN_INPUT_DEFAULTS
})

interface RunResult {
  error: Error | null
  stdout: string
  outputs: Record<string, string>
}

async function runDownloadAction(
  inputs: Record<string, string>
): Promise<RunResult> {
  const sandbox = withActionEnv(inputs, bmcEnv())
  let error: Error | null = null
  const stdout = await captureStdout(async () => {
    try {
      await runDownload()
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err))
    }
  })
  sandbox.restore()
  return { error, stdout, outputs: sandbox.outputs() }
}

/**
 * Seeds an artifact with an arbitrary NAME through the raw protocol
 * client — the backend's create only trims names, so hostile names
 * (`../escape`, absolute paths) can exist and must be refused by the
 * download side.
 */
async function seedRawArtifact(
  name: string,
  fileName: string,
  content: string
): Promise<void> {
  const client = new BmcArtifactClient({
    resultsUrl: bmcEnv()['ACTIONS_RESULTS_URL'] ?? '',
    runtimeToken: TEST_TOKEN,
    runId: TEST_RUN_ID
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmc-hostile-'))
  const absolutePath = path.join(dir, fileName)
  fs.writeFileSync(absolutePath, content)
  const created = await client.createArtifact(name)
  let index = 0
  for await (const chunk of packToChunks(
    [{ absolutePath, entryName: fileName, size: Buffer.byteLength(content) }],
    6,
    64 * 1024 * 1024
  )) {
    await client.uploadChunk(created.uploadUrl, index, chunk)
    index++
  }
  await client.finalizeArtifact(name)
  fs.rmSync(dir, { recursive: true, force: true })
}

/** Uploads a small two-file artifact through the real upload flow. */
async function seedArtifact(
  name: string,
  files: Record<string, string>
): Promise<void> {
  const dir = path.join(workspace, `seed-${name}`)
  for (const [fileName, content] of Object.entries(files)) {
    const target = path.join(dir, ...fileName.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  const sandbox = withActionEnv(
    { name, path: `${dir}/**/*`, overwrite: 'true' },
    bmcEnv()
  )
  try {
    await captureStdout(async () => {
      await runUpload()
    })
  } finally {
    sandbox.restore()
  }
}

describe('download-artifact end to end', () => {
  it('a named multi-file artifact extracts directly into path', async () => {
    await seedArtifact('bundle', {
      'out/app.js': 'app-bytes',
      'out/lib/deep/util.js': 'util-bytes'
    })
    const dest = path.join(workspace, 'dest-single')
    const result = await runDownloadAction({ name: 'bundle', path: dest })
    expect(result.error).toBeNull()
    expect(result.outputs['download-path']).toBe(dest)
    expect(fs.readFileSync(path.join(dest, 'out/app.js'), 'utf8')).toBe(
      'app-bytes'
    )
    expect(
      fs.readFileSync(path.join(dest, 'out/lib/deep/util.js'), 'utf8')
    ).toBe('util-bytes')
    expect(result.stdout).toContain(
      'Download artifact has finished successfully'
    )
  })

  it('all artifacts (no name) land in per-artifact directories', async () => {
    await seedArtifact('one', { 'f.txt': 'one-content' })
    await seedArtifact('two', { 'f.txt': 'two-content' })
    const dest = path.join(workspace, 'dest-all')
    const result = await runDownloadAction({ path: dest })
    expect(result.error).toBeNull()
    expect(fs.readFileSync(path.join(dest, 'one/f.txt'), 'utf8')).toBe(
      'one-content'
    )
    expect(fs.readFileSync(path.join(dest, 'two/f.txt'), 'utf8')).toBe(
      'two-content'
    )
    expect(result.stdout).toContain('Total of 2 artifact(s) downloaded')
  })

  it('merge-multiple merges every artifact into one directory', async () => {
    await seedArtifact('alpha', { 'alpha.txt': 'A' })
    await seedArtifact('beta', { 'beta.txt': 'B' })
    const dest = path.join(workspace, 'dest-merge')
    const result = await runDownloadAction({
      path: dest,
      'merge-multiple': 'true'
    })
    expect(result.error).toBeNull()
    expect(fs.readFileSync(path.join(dest, 'alpha.txt'), 'utf8')).toBe('A')
    expect(fs.readFileSync(path.join(dest, 'beta.txt'), 'utf8')).toBe('B')
  })

  it('a pattern filters the artifacts by name (minimatch)', async () => {
    await seedArtifact('linux-build', { 'f.txt': 'linux' })
    await seedArtifact('macos-build', { 'f.txt': 'macos' })
    const dest = path.join(workspace, 'dest-pattern')
    const result = await runDownloadAction({
      path: dest,
      pattern: 'linux-*'
    })
    expect(result.error).toBeNull()
    expect(fs.existsSync(path.join(dest, 'linux-build/f.txt'))).toBe(true)
    expect(fs.existsSync(path.join(dest, 'macos-build'))).toBe(false)
  })

  it('no matches at all downloads nothing and succeeds (the upstream behavior)', async () => {
    const dest = path.join(workspace, 'dest-none')
    const result = await runDownloadAction({ path: dest, pattern: 'nope-*' })
    expect(result.error).toBeNull()
    expect(result.stdout).toContain('Total of 0 artifact(s) downloaded')
    expect(result.outputs['download-path']).toBe(dest)
  })

  it("a named artifact that doesn't exist fails with the upstream wording", async () => {
    const result = await runDownloadAction({ name: 'missing', path: workspace })
    expect(result.error?.message).toBe("Artifact 'missing' not found")
  })

  it('artifact-ids selects by the signed-URL row ids', async () => {
    await seedArtifact('pick-me', { 'f.txt': 'picked' })
    await seedArtifact('leave-me', { 'f.txt': 'left' })
    const pickedId = server.row('pick-me')?.id
    expect(pickedId).toBeDefined()
    const dest = path.join(workspace, 'dest-ids')
    const result = await runDownloadAction({
      path: dest,
      'artifact-ids': String(pickedId)
    })
    expect(result.error).toBeNull()
    expect(fs.existsSync(path.join(dest, 'pick-me/f.txt'))).toBe(true)
    expect(fs.existsSync(path.join(dest, 'leave-me'))).toBe(false)
  })

  it('artifact-ids with no match fails; a partial match warns', async () => {
    await seedArtifact('only-one', { 'f.txt': 'x' })
    const missing = await runDownloadAction({
      path: workspace,
      'artifact-ids': '999999'
    })
    expect(missing.error?.message).toBe(
      'None of the provided artifact IDs were found'
    )

    const partial = await runDownloadAction({
      path: workspace,
      'artifact-ids': `${server.row('only-one')?.id},88888888`
    })
    expect(partial.error).toBeNull()
    expect(partial.stdout).toContain(
      'Could not find the following artifact IDs: 88888888'
    )
  })

  it('name and artifact-ids together fail with the upstream wording', async () => {
    const result = await runDownloadAction({
      name: 'x',
      'artifact-ids': '1',
      path: workspace
    })
    expect(result.error?.message).toContain(
      "Inputs 'name' and 'artifact-ids' cannot be used together"
    )
  })

  it('an invalid artifact id fails with the upstream wording', async () => {
    const result = await runDownloadAction({
      path: workspace,
      'artifact-ids': 'not-a-number'
    })
    expect(result.error?.message).toBe(
      "Invalid artifact ID: 'not-a-number'. Must be a number."
    )
  })

  it('a tampered digest warns but still extracts', async () => {
    await seedArtifact('integrity', { 'f.txt': 'intact' })
    const row = server.row('integrity')
    expect(row).toBeDefined()
    row!.digest = '0'.repeat(64)
    const dest = path.join(workspace, 'dest-integrity')
    const result = await runDownloadAction({ name: 'integrity', path: dest })
    expect(result.error).toBeNull()
    expect(result.stdout).toContain(
      "Artifact 'integrity' digest validation failed"
    )
    expect(fs.readFileSync(path.join(dest, 'f.txt'), 'utf8')).toBe('intact')
  })

  it('a run-id input naming another run fails with the BMC run-scope law', async () => {
    const result = await runDownloadAction({
      path: workspace,
      'run-id': '999999999'
    })
    expect(result.error?.message).toContain(
      'does not name the current workflow run'
    )
    expect(result.error?.message).toContain('do not exist on BMC')
  })

  it('a github-token input warns that BMC ignores it', async () => {
    await seedArtifact('tokened', { 'f.txt': 't' })
    const dest = path.join(workspace, 'dest-token')
    const result = await runDownloadAction({
      name: 'tokened',
      path: dest,
      'github-token': 'ghp_somegithubtoken'
    })
    expect(result.error).toBeNull()
    expect(result.stdout).toContain('the github-token input is ignored on BMC')
    expect(fs.readFileSync(path.join(dest, 'f.txt'), 'utf8')).toBe('t')
  })

  it('tilde expansion resolves the destination', async () => {
    // Point HOME at a temp dir so the expansion never writes to the
    // real home directory.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bmc-home-'))
    const sandbox = withActionEnv(
      { name: 'homed', path: '~' },
      { ...bmcEnv(), HOME: fakeHome }
    )
    try {
      await seedArtifact('homed', { 'f.txt': 'home' })
      let error: Error | null = null
      let outputs: Record<string, string> = {}
      await captureStdout(async () => {
        try {
          await runDownload()
        } catch (err) {
          error = err instanceof Error ? err : new Error(String(err))
        }
      })
      outputs = sandbox.outputs()
      expect(error).toBeNull()
      expect(outputs['download-path']).toBe(fakeHome)
      expect(fs.readFileSync(path.join(fakeHome, 'f.txt'), 'utf8')).toBe('home')
    } finally {
      sandbox.restore()
      fs.rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it('the fake mirrors fiber: the detail path segment is served RAW', async () => {
    await seedArtifact('with space', { 'f.txt': 'spacey' })
    // The backend (fiber, UnescapePath off) reads the RAW path segment,
    // so the encoded form of an existing name answers 404. Pinning this
    // fidelity is what proves the client's list-fallback is
    // load-bearing; re-decoding the fake breaks this test.
    const res = await fetch(
      `${bmcEnv()['ACTIONS_RESULTS_URL']}/_apis/pipelines/workflows/${TEST_RUN_ID}/artifacts/with%20space`,
      { headers: { authorization: `Bearer ${TEST_TOKEN}` } }
    )
    expect(res.status).toBe(404)
  })

  it('an artifact name with a space downloads end to end (the raw-path fallback)', async () => {
    await seedArtifact('build output', { 'out/app.js': 'app-bytes' })
    const dest = path.join(workspace, 'dest-space')
    const result = await runDownloadAction({ name: 'build output', path: dest })
    expect(result.error).toBeNull()
    expect(fs.readFileSync(path.join(dest, 'out/app.js'), 'utf8')).toBe(
      'app-bytes'
    )
    expect(result.outputs['download-path']).toBe(dest)
  })

  it('a non-ASCII artifact name downloads end to end', async () => {
    await seedArtifact('résumé-日本語', { 'r.txt': 'unicode-bytes' })
    const dest = path.join(workspace, 'dest-unicode')
    const result = await runDownloadAction({
      name: 'résumé-日本語',
      path: dest
    })
    expect(result.error).toBeNull()
    expect(fs.readFileSync(path.join(dest, 'r.txt'), 'utf8')).toBe(
      'unicode-bytes'
    )
  })

  it('a hostile artifact name is refused and writes nothing outside the destination', async () => {
    // The backend's create only trims the name, so a hostile name can
    // exist; the download side refuses it before the destination join.
    await seedRawArtifact('../escape', 'evil.txt', 'escaped-bytes')
    const dest = path.join(workspace, 'dest-hostile')
    const result = await runDownloadAction({ path: dest })
    expect(result.error?.message).toContain(
      "refusing to extract the artifact '../escape'"
    )
    expect(fs.existsSync(path.join(workspace, 'escape'))).toBe(false)
    expect(fs.existsSync(dest)).toBe(false)
  })

  it('an absolute artifact name is refused', async () => {
    const hostile = path.join(os.tmpdir(), 'bmc-evil-target')
    await seedRawArtifact(hostile, 'evil.txt', 'abs-bytes')
    const result = await runDownloadAction({ name: hostile, path: workspace })
    expect(result.error?.message).toContain('refusing to extract')
    expect(fs.existsSync(hostile)).toBe(false)
  })

  it('a non-numeric run-id input takes the run-scope error before any network call', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const sandbox = withActionEnv(
      { path: workspace, 'run-id': 'not-a-number' },
      bmcEnv()
    )
    try {
      let error: Error | null = null
      await captureStdout(async () => {
        try {
          await runDownload()
        } catch (err) {
          error = err instanceof Error ? err : new Error(String(err))
        }
      })
      const failure = error as Error | null
      expect(failure?.message).toContain(
        'does not name the current workflow run'
      )
      expect(failure?.message).toContain('do not exist on BMC')
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      sandbox.restore()
    }
  })

  it("the upload artifact-id output chains into download's artifact-ids input", async () => {
    // Upload through the real action and take the OUTPUT value.
    const dir = path.join(workspace, 'chain-src')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'chain.txt'), 'chain-bytes')
    const upSandbox = withActionEnv(
      { name: 'chained', path: `${dir}/**/*` },
      bmcEnv()
    )
    await captureStdout(async () => {
      await runUpload()
    })
    const outputs = upSandbox.outputs()
    upSandbox.restore()
    const artifactId = outputs['artifact-id'] ?? ''
    expect(artifactId).toMatch(/^[0-9]+$/)

    // Feed that exact output as download's artifact-ids input.
    const dest = path.join(workspace, 'chain-dest')
    const result = await runDownloadAction({
      'artifact-ids': artifactId,
      path: dest
    })
    expect(result.error).toBeNull()
    // artifact-ids is NOT single-artifact selection: the per-artifact
    // directory layout applies.
    expect(fs.readFileSync(path.join(dest, 'chained/chain.txt'), 'utf8')).toBe(
      'chain-bytes'
    )
  })
})
