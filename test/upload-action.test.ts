/**
 * The upload action end to end against the fake protocol server:
 * inputs, the if-no-files-found arms, the overwrite arms, the retention
 * warning, the outputs, the 64 MiB chunk boundary, and the expired
 * re-create retry — with the marker FIRST law re-pinned here.
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
import { extractTarGz } from '../shared/src/tar'

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
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bmc-upload-'))
})

const bmcEnv = (): Record<string, string> => ({
  BMC_ARTIFACT_STORE: '1',
  ACTIONS_RESULTS_URL: server.url,
  ACTIONS_RUNTIME_TOKEN: TEST_TOKEN,
  GITHUB_RUN_ID: String(TEST_RUN_ID),
  GITHUB_SERVER_URL: 'https://git.example.test',
  GITHUB_REPOSITORY: 'acme/widgets',
  ...BOOLEAN_INPUT_DEFAULTS
})

interface RunResult {
  error: Error | null
  stdout: string
  outputs: Record<string, string>
  restore(): void
}

async function runWith(
  inputs: Record<string, string>,
  envOverrides: Record<string, string> = {}
): Promise<RunResult> {
  const sandbox = withActionEnv(inputs, { ...bmcEnv(), ...envOverrides })
  let error: Error | null = null
  const stdout = await captureStdout(async () => {
    try {
      await runUpload()
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err))
    }
  })
  // Restore the environment BEFORE returning: leaked INPUT_* variables
  // would bleed one test's inputs into the next.
  sandbox.restore()
  return { error, stdout, outputs: sandbox.outputs(), restore: () => {} }
}

describe('upload-artifact end to end', () => {
  it('uploads a multi-file directory as one deterministic artifact and sets the outputs', async () => {
    fs.mkdirSync(path.join(workspace, 'dist'))
    fs.writeFileSync(path.join(workspace, 'dist', 'app.js'), 'console.log(1)')
    fs.writeFileSync(path.join(workspace, 'dist', 'lib.js'), 'console.log(2)')

    const result = await runWith({
      name: 'build-output',
      path: `${workspace}/dist/*`
    })
    expect(result.error).toBeNull()

    // The stored artifact is the deterministic tar.gz of the two files.
    const stored = server.bytes('build-output')
    expect(stored).toBeDefined()
    const outDir = path.join(workspace, 'extracted')
    const written = await extractTarGz(stored!, outDir)
    expect(written.sort()).toEqual(['app.js', 'lib.js'])
    expect(fs.readFileSync(path.join(outDir, 'app.js'), 'utf8')).toBe(
      'console.log(1)'
    )

    expect(result.outputs['artifact-id']).toBe(
      String(server.row('build-output')?.id)
    )
    expect(result.outputs['artifact-digest']).toMatch(/^[0-9a-f]{64}$/)
    expect(result.outputs['artifact-url']).toBe(
      `https://git.example.test/acme/widgets/actions/runs/${TEST_RUN_ID}/artifacts/${server.row('build-output')?.id}`
    )
    expect(result.stdout).toContain('has been successfully uploaded')
  })

  it('a single bare file keeps the v4 restore shape (lands at its basename)', async () => {
    fs.writeFileSync(path.join(workspace, 'report.txt'), 'the-report')
    const result = await runWith({
      name: 'report',
      path: `${workspace}/report.txt`
    })
    expect(result.error).toBeNull()
    const stored = server.bytes('report')
    expect(stored).toBeDefined()
    const outDir = path.join(workspace, 'extracted')
    const written = await extractTarGz(stored!, outDir)
    expect(written).toEqual(['report.txt'])
  })

  describe('if-no-files-found', () => {
    const emptyDir = (): string => {
      const dir = path.join(workspace, 'empty')
      fs.mkdirSync(dir, { recursive: true })
      return dir
    }

    it('warn (default): succeeds with a warning, uploads nothing', async () => {
      const result = await runWith({ path: `${emptyDir()}/*` })
      expect(result.error).toBeNull()
      expect(result.stdout).toContain('::warning::')
      expect(result.stdout).toContain(
        'No files were found with the provided path'
      )
      expect(server.rows()).toHaveLength(0)
    })

    it('error: fails with the same wording', async () => {
      const result = await runWith({
        path: `${emptyDir()}/*`,
        'if-no-files-found': 'error'
      })
      expect(result.error).not.toBeNull()
      expect(result.error?.message).toContain(
        'No files were found with the provided path'
      )
    })

    it('ignore: succeeds silently', async () => {
      const result = await runWith({
        path: `${emptyDir()}/*`,
        'if-no-files-found': 'ignore'
      })
      expect(result.error).toBeNull()
      expect(result.stdout).toContain(
        'No files were found with the provided path'
      )
      expect(result.stdout).not.toContain('::warning::')
    })

    it('an unrecognized value fails with the upstream wording', async () => {
      const result = await runWith({
        path: `${workspace}/*`,
        'if-no-files-found': 'shout'
      })
      expect(result.error?.message).toContain(
        'Unrecognized if-no-files-found input'
      )
    })
  })

  describe('the overwrite arms', () => {
    const stageFile = (): void => {
      fs.writeFileSync(path.join(workspace, 'f.txt'), 'content-1')
    }

    it('overwrite=false refuses an existing name BEFORE any bytes move', async () => {
      stageFile()
      await runWith({ name: 'dupe', path: `${workspace}/f.txt` })
      const before = server.bytes('dupe')

      fs.writeFileSync(path.join(workspace, 'f.txt'), 'content-2-NEW')
      const result = await runWith({ name: 'dupe', path: `${workspace}/f.txt` })
      expect(result.error?.message).toContain(
        "an artifact with the name 'dupe' already exists"
      )
      expect(result.error?.message).toContain('overwrite: true')
      // The old bytes are untouched.
      expect(server.bytes('dupe')).toEqual(before)
    })

    it('overwrite=true re-creates and the store serves the new bytes', async () => {
      stageFile()
      await runWith({ name: 'replaced', path: `${workspace}/f.txt` })
      const firstDigest = server.row('replaced')?.digest

      fs.writeFileSync(path.join(workspace, 'f.txt'), 'content-TWO')
      const result = await runWith({
        name: 'replaced',
        path: `${workspace}/f.txt`,
        overwrite: 'true'
      })
      expect(result.error).toBeNull()
      expect(server.row('replaced')?.digest).not.toBe(firstDigest)
      const out = path.join(workspace, 'replaced-out')
      await extractTarGz(server.bytes('replaced')!, out)
      expect(fs.readFileSync(path.join(out, 'f.txt'), 'utf8')).toContain(
        'content-TWO'
      )
    })
  })

  it("a file literally named '..foo' is a legal entry (the exact-segment guard)", async () => {
    // N6's witness: only an exact '..' path segment escapes the
    // artifact root — a NAME that merely starts with '..' is a legal
    // file. Reverting the guard to a startsWith check fails this test.
    // (include-hidden-files is on because any dot-leading name is
    // excluded by the upstream hidden-file filter otherwise — that
    // exclusion is separate from the escape guard.)
    fs.mkdirSync(path.join(workspace, 'dotdot'))
    fs.writeFileSync(
      path.join(workspace, 'dotdot', '..foo'),
      'dotdot-foo-bytes'
    )
    fs.writeFileSync(path.join(workspace, 'dotdot', 'plain.txt'), 'plain')

    const result = await runWith({
      name: 'dotdot-names',
      path: `${workspace}/dotdot/*`,
      'include-hidden-files': 'true'
    })
    expect(result.error).toBeNull()
    const stored = server.bytes('dotdot-names')
    expect(stored).toBeDefined()
    const out = path.join(workspace, 'dotdot-out')
    const written = await extractTarGz(stored!, out)
    expect(written.sort()).toEqual(['..foo', 'plain.txt'])
    expect(fs.readFileSync(path.join(out, '..foo'), 'utf8')).toBe(
      'dotdot-foo-bytes'
    )
  })

  it('retention-days is accepted with the org-policy warning', async () => {
    fs.writeFileSync(path.join(workspace, 'keep.txt'), 'x')
    const result = await runWith({
      name: 'retained',
      path: `${workspace}/keep.txt`,
      'retention-days': '30'
    })
    expect(result.error).toBeNull()
    expect(result.stdout).toContain('::warning::')
    expect(result.stdout).toContain(
      'retention-days is accepted for upstream compatibility'
    )
  })

  it('hidden files are excluded by default and included with include-hidden-files', async () => {
    fs.mkdirSync(path.join(workspace, 'proj'))
    fs.writeFileSync(path.join(workspace, 'proj', 'visible.txt'), 'v')
    fs.writeFileSync(path.join(workspace, 'proj', '.hidden.txt'), 'h')

    await runWith({ name: 'no-hidden', path: `${workspace}/proj/*` })
    const stored = server.bytes('no-hidden')!
    const out = path.join(workspace, 'out1')
    const written = await extractTarGz(stored, out)
    expect(written).toEqual(['visible.txt'])

    await runWith({
      name: 'with-hidden',
      path: `${workspace}/proj/*`,
      'include-hidden-files': 'true'
    })
    const written2 = await extractTarGz(
      server.bytes('with-hidden')!,
      path.join(workspace, 'out2')
    )
    expect(written2.sort()).toEqual(['.hidden.txt', 'visible.txt'])
  })

  it('an artifact larger than the 64 MiB chunk cap splits into exact chunks', async () => {
    const bigDir = path.join(workspace, 'big')
    fs.mkdirSync(bigDir)
    const firstChunk = Buffer.alloc(64 * 1024 * 1024, 0xaa)
    fs.writeFileSync(path.join(bigDir, 'first.bin'), firstChunk)
    fs.writeFileSync(path.join(bigDir, 'tail.bin'), Buffer.from('the-tail'))

    // compression-level 0 (store) so the archive size tracks the raw
    // size — 64 MiB of 0xaa would otherwise compress far below the cap.
    const result = await runWith({
      name: 'big-artifact',
      path: `${bigDir}/*`,
      'compression-level': '0'
    })
    expect(result.error).toBeNull()
    // 64 MiB chunk + a short tail chunk; each index exactly once.
    expect(server.patchCount(0)).toBe(1)
    expect(server.patchCount(1)).toBe(1)
    // The stored object is the compressed archive: extract and verify
    // the tree instead of the raw bytes.
    const stored = server.bytes('big-artifact')!
    const out = path.join(workspace, 'big-out')
    const written = await extractTarGz(stored, out)
    expect(written.sort()).toEqual(['first.bin', 'tail.bin'])
    const first = fs.readFileSync(path.join(out, 'first.bin'))
    expect(first.length).toBe(64 * 1024 * 1024)
    expect(first.subarray(0, 4).toString('hex')).toBe('aaaaaaaa')
    expect(fs.readFileSync(path.join(out, 'tail.bin'), 'utf8')).toBe('the-tail')
  }, 240_000)

  it('a server-side expiry mid-upload re-creates once and succeeds', async () => {
    fs.writeFileSync(path.join(workspace, 'flaky.txt'), 'flaky-content')
    server.faults.expireUploadTimes = 1
    const result = await runWith({
      name: 'flaky',
      path: `${workspace}/flaky.txt`
    })
    expect(result.error).toBeNull()
    expect(result.stdout).toContain('re-creating')
    const out = path.join(workspace, 'flaky-out')
    await extractTarGz(server.bytes('flaky')!, out)
    expect(fs.readFileSync(path.join(out, 'flaky.txt'), 'utf8')).toBe(
      'flaky-content'
    )
  })

  it('a second expiry exhausts the retries and fails', async () => {
    fs.writeFileSync(path.join(workspace, 'doomed.txt'), 'doomed')
    server.faults.expireUploadTimes = 99
    const result = await runWith({
      name: 'doomed',
      path: `${workspace}/doomed.txt`
    })
    delete server.faults.expireUploadTimes
    expect(result.error?.message).toContain('re-create')
  })

  it('the marker is still asserted first, before the marker-less env reaches the protocol', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const sandbox = withActionEnv(
      { name: 'x', path: workspace },
      {
        ACTIONS_RESULTS_URL: server.url,
        ACTIONS_RUNTIME_TOKEN: TEST_TOKEN,
        GITHUB_RUN_ID: String(TEST_RUN_ID)
        // no BMC_ARTIFACT_STORE
      }
    )
    try {
      await expect(runUpload()).rejects.toThrow(/only runs on BMC runners/)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      sandbox.restore()
    }
  })
})
