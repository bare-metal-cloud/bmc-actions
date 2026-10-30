/**
 * The marker-refusal tests: no BMC_ARTIFACT_STORE (or a wrong value)
 * means the LOUD BMC-only refusal BEFORE any network call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertBmcArtifactStore,
  markerMissingMessage
} from '../shared/src/marker'
import { MarkerMissingError } from '../shared/src/errors'
import { runUpload } from '../upload-artifact/src/main'
import { runDownload } from '../download-artifact/src/main'
import { withActionEnv } from './helpers'

const LOUD = 'this action only runs on BMC runners with the artifact store'

describe('the BMC artifact-store marker', () => {
  it('passes when the start op staged the marker', () => {
    expect(() => {
      assertBmcArtifactStore('upload-artifact', { BMC_ARTIFACT_STORE: '1' })
    }).not.toThrow()
  })

  it('refuses when the marker is absent', () => {
    expect(() => {
      assertBmcArtifactStore('upload-artifact', {})
    }).toThrow(MarkerMissingError)
  })

  it('refuses any value but the staged one', () => {
    expect(() => {
      assertBmcArtifactStore('upload-artifact', { BMC_ARTIFACT_STORE: 'true' })
    }).toThrow(MarkerMissingError)
    expect(() => {
      assertBmcArtifactStore('upload-artifact', { BMC_ARTIFACT_STORE: '0' })
    }).toThrow(MarkerMissingError)
  })

  it('the loud message names the situation and the GitHub guidance', () => {
    const message = markerMissingMessage('upload-artifact')
    expect(message).toContain(LOUD)
    expect(message).toContain('BMC_ARTIFACT_STORE')
    expect(message).toContain(
      'On GitHub-hosted runners keep actions/upload-artifact'
    )
    expect(message).toContain('No network calls were made')
  })
})

describe('the actions refuse loudly before any network call', () => {
  const fetchSpy = vi.fn()

  beforeEach(() => {
    // A fetch spy proves no call is attempted on the refusal path.
    fetchSpy.mockClear()
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('upload-artifact: GitHub env present, marker absent, fetch never called', async () => {
    // The GitHub-hosted simulation: GitHub's own ACTIONS_* values (and
    // GITHUB_RUN_ID) are set — only the marker is missing. The env
    // names must NOT drive the store decision.
    const sandbox = withActionEnv(
      { name: 'artifact', path: '.' },
      {
        ACTIONS_RUNTIME_URL: 'https://results.github.com/api/v1/runner-runtime',
        ACTIONS_RESULTS_URL: 'https://results.github.com/api/v1/runner-runtime',
        ACTIONS_RUNTIME_TOKEN: 'github-runtime-token-should-never-be-used',
        GITHUB_RUN_ID: '1234567890',
        GITHUB_WORKSPACE: process.cwd()
      }
    )
    try {
      await expect(runUpload()).rejects.toThrow(MarkerMissingError)
      await expect(runUpload()).rejects.toThrow(LOUD)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      sandbox.restore()
    }
  })

  it('download-artifact: GitHub env present, marker absent, fetch never called', async () => {
    const sandbox = withActionEnv(
      {},
      {
        ACTIONS_RUNTIME_URL: 'https://results.github.com/api/v1/runner-runtime',
        ACTIONS_RESULTS_URL: 'https://results.github.com/api/v1/runner-runtime',
        ACTIONS_RUNTIME_TOKEN: 'github-runtime-token-should-never-be-used',
        GITHUB_RUN_ID: '1234567890',
        GITHUB_WORKSPACE: process.cwd()
      }
    )
    try {
      await expect(runDownload()).rejects.toThrow(MarkerMissingError)
      await expect(runDownload()).rejects.toThrow(LOUD)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      sandbox.restore()
    }
  })

  it('marker absent AND the BMC env fully staged still refuses before any call', async () => {
    const sandbox = withActionEnv(
      { path: '.' },
      {
        ACTIONS_RESULTS_URL: 'https://cp.example.test/api/v1/runner-runtime',
        ACTIONS_RUNTIME_TOKEN: 'some-token',
        GITHUB_RUN_ID: '310'
      }
    )
    try {
      await expect(runUpload()).rejects.toThrow(MarkerMissingError)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      sandbox.restore()
    }
  })
})
