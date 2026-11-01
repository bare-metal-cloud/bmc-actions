/**
 * The runner environment the protocol rides (story B5.5).
 *
 * The BMC start operation (agentorch v0.1.36) stages:
 *   - ACTIONS_RESULTS_URL   — the CP results base (v1: platform base +
 *     /api/v1/runner-runtime — the same value ACTIONS_RUNTIME_URL holds)
 *   - ACTIONS_RUNTIME_TOKEN — the job's 24h runtime token, sent as
 *     `Authorization: Bearer <token>` on EVERY control-plane call
 *   - BMC_ARTIFACT_STORE='1' — the store marker (see marker.ts)
 *
 * THE BMC-NAMESPACED OVERRIDE (the runners drill's live finding,
 * 2026-11-01): GitHub's job message unconditionally overwrites
 * ACTIONS_RESULTS_URL and ACTIONS_RUNTIME_TOKEN in the runner process
 * env with the GitHub-side values — no launch-seam .env or start-op
 * render can beat it. The start operation therefore ALSO stages the CP's
 * values under BMC_ACTIONS_RESULTS_URL / BMC_ACTIONS_RUNTIME_TOKEN, and
 * the reader prefers the BMC names, falling back to the standard names
 * for launch seams that can hold the line.
 *
 * The run id comes from GITHUB_RUN_ID, which the runner harness stages
 * for every job the way GitHub-hosted runners do. The token is
 * job-bound and run-bound: the :runId path segment MUST be the token's
 * own run, so the env value is the only correct source.
 *
 * GitHub-hosted runners also set the ACTIONS_* names — with GitHub's
 * values. They are read ONLY after the BMC marker has asserted; the
 * marker is what decides the store, never the URL/token names.
 */

import { RunnerEnvError } from './errors'

export interface RunnerRuntime {
  /** CP results base, without a trailing slash. */
  resultsUrl: string
  /** The job's runtime token (bearer credential). */
  runtimeToken: string
  /** The workflow run id the token is bound to. */
  runId: number
}

/**
 * Reads and validates the runtime environment. Throws RunnerEnvError —
 * before any network call — when a variable is missing or malformed.
 */
export function readRunnerRuntime(env: NodeJS.ProcessEnv): RunnerRuntime {
  const resultsUrl = (
    env['BMC_ACTIONS_RESULTS_URL'] ??
    env['ACTIONS_RESULTS_URL'] ??
    ''
  ).trim()
  if (resultsUrl === '') {
    throw new RunnerEnvError(
      'ACTIONS_RESULTS_URL is not set: this runner job has no BMC results ' +
        'endpoint staged. (The BMC start operation stages it together with ' +
        `BMC_ARTIFACT_STORE='1' — if one is missing, the store is not ` +
        'mounted and the action cannot run. GitHub\u2019s job message ' +
        'overwrites the ACTIONS_* value, so the start operation stages the ' +
        "CP's value as BMC_ACTIONS_RESULTS_URL — the runner must carry it.)"
    )
  }
  const runtimeToken = (
    env['BMC_ACTIONS_RUNTIME_TOKEN'] ??
    env['ACTIONS_RUNTIME_TOKEN'] ??
    ''
  ).trim()
  if (runtimeToken === '') {
    throw new RunnerEnvError(
      'ACTIONS_RUNTIME_TOKEN is not set: this runner job has no BMC runtime ' +
        'token staged, and the artifact protocol authenticates every call ' +
        'with it. (GitHub\u2019s job message overwrites the ACTIONS_* value, ' +
        'so the start operation stages the CP\u2019s token as ' +
        'BMC_ACTIONS_RUNTIME_TOKEN — the runner must carry it.)'
    )
  }
  const runId = parseRunId(env['GITHUB_RUN_ID'] ?? '')
  if (runId === null) {
    throw new RunnerEnvError(
      'GITHUB_RUN_ID is not set or is not a positive integer: the artifact ' +
        "protocol addresses every call at the token job's run, and the run " +
        'id is read from this variable.'
    )
  }
  return {
    resultsUrl: stripTrailingSlash(resultsUrl),
    runtimeToken,
    runId
  }
}

/** Parses a positive-integer run id; answers null for anything else. */
export function parseRunId(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) {
    return null
  }
  return Number.parseInt(value, 10)
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}
