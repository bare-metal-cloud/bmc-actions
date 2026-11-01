import { describe, expect, it } from 'vitest'
import { readRunnerRuntime } from '../shared/src/env'
import { RunnerEnvError } from '../shared/src/errors'

// THE BMC OVERRIDE (the runners drill's live finding, 2026-11-01):
// GitHub's job message unconditionally overwrites ACTIONS_RESULTS_URL and
// ACTIONS_RUNTIME_TOKEN in the runner process env with the GitHub-side
// values — a launch-seam .env (or a start-op render) cannot beat it, so
// the actions hit GitHub's endpoints (or a 404 shaped like the CP's
// paths) instead of the CP's runner-runtime surface. The start operation
// therefore stages the CP's values under the BMC-namespaced names, and
// the reader prefers them, falling back to the standard names.

const RUN = { GITHUB_RUN_ID: '41289613446' }

describe('readRunnerRuntime BMC-name preference', () => {
  it('prefers BMC_ACTIONS_RESULTS_URL over the overridden ACTIONS_RESULTS_URL', () => {
    const rt = readRunnerRuntime({
      ...RUN,
      ACTIONS_RESULTS_URL: 'https://results-receiver.actions.githubusercontent.com',
      BMC_ACTIONS_RESULTS_URL: 'https://cp.example.test/api/v1/runner-runtime',
      ACTIONS_RUNTIME_TOKEN: 'github-token',
      BMC_ACTIONS_RUNTIME_TOKEN: 'bmc-token'
    })
    expect(rt.resultsUrl).toBe('https://cp.example.test/api/v1/runner-runtime')
    expect(rt.runtimeToken).toBe('bmc-token')
  })

  it('falls back to the standard names when the BMC names are absent', () => {
    const rt = readRunnerRuntime({
      ...RUN,
      ACTIONS_RESULTS_URL: 'https://cp.example.test/api/v1/runner-runtime',
      ACTIONS_RUNTIME_TOKEN: 'bmc-token'
    })
    expect(rt.resultsUrl).toBe('https://cp.example.test/api/v1/runner-runtime')
    expect(rt.runtimeToken).toBe('bmc-token')
  })

  it('still refuses when neither name carries a value', () => {
    expect(() =>
      readRunnerRuntime({
        ...RUN,
        ACTIONS_RESULTS_URL: '',
        BMC_ACTIONS_RESULTS_URL: '',
        ACTIONS_RUNTIME_TOKEN: ''
      })
    ).toThrow(RunnerEnvError)
  })
})
