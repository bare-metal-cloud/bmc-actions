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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runDownload } from '../download-artifact/src/main'
import { runUpload } from '../upload-artifact/src/main'
import type { FakeServer } from './fake-server'
import { startFakeServer } from './fake-server'
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
    expect(result.error?.message).toContain('names another workflow run')
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
})
