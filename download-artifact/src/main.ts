/**
 * The download action's run body.
 *
 * ORDER MATTERS: the BMC marker asserts FIRST, before any network call.
 * The run-id input validates against GITHUB_RUN_ID before any network
 * call too — the BMC protocol is run-scoped (the runtime token names
 * the run; the server refuses another run's id as a typed 401).
 */

import * as core from '@actions/core'
import * as os from 'os'
import * as path from 'path'
import { assertBmcArtifactStore } from '../../shared/src/marker'
import { readRunnerRuntime } from '../../shared/src/env'
import { BmcArtifactClient } from '../../shared/src/client'
import { downloadArtifacts } from '../../shared/src/download'
import { RunnerEnvError } from '../../shared/src/errors'
import {
  isS3Mode,
  readS3Config,
  S3ArtifactStore
} from '../../shared/src/s3store'
import { downloadFromS3 } from '../../shared/src/s3download'

export async function runDownload(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  // 1. THE MARKER — the loud BMC-only refusal, before anything else.
  // Direct object-store mode (s3-endpoint set) skips it: that mode
  // talks to the bucket, never the BMC control plane.
  const s3Mode = isS3Mode(core.getInput)
  if (!s3Mode) assertBmcArtifactStore('download-artifact', env)

  // 2. Inputs (upstream grammar) — all resolved before any network call.
  const name = core.getInput('name')
  const artifactIdsInput = core.getInput('artifact-ids')
  if (name.length > 0 && artifactIdsInput.length > 0) {
    throw new Error(
      `Inputs 'name' and 'artifact-ids' cannot be used together. ` +
        'Please specify only one.'
    )
  }

  let resolvedPath = core.getInput('path')
  if (resolvedPath.length === 0) {
    resolvedPath = env['GITHUB_WORKSPACE'] ?? process.cwd()
  }
  if (resolvedPath.startsWith('~')) {
    resolvedPath = resolvedPath.replace('~', os.homedir())
  }
  const destDir = path.resolve(resolvedPath)
  core.debug(`Resolved path is ${destDir}`)

  const pattern = core.getInput('pattern')
  const mergeMultiple = core.getBooleanInput('merge-multiple')

  if (s3Mode) {
    if (artifactIdsInput.length > 0) {
      throw new Error(
        "the 'artifact-ids' input is not supported in direct object-store " +
          "mode (s3-endpoint is set): select by 'name' or 'pattern'"
      )
    }
    const cfg = readS3Config(core.getInput)
    core.setSecret(cfg.accessKeyId)
    core.setSecret(cfg.secretAccessKey)
    // Direct mode is not run-bound by a token: repository and run-id may
    // name another run (cross-run handoff), defaulting to the current one.
    const store = new S3ArtifactStore(cfg, {
      repository:
        core.getInput('repository') || (env['GITHUB_REPOSITORY'] ?? ''),
      runId: core.getInput('run-id') || (env['GITHUB_RUN_ID'] ?? '')
    })
    const s3Outcome = await downloadFromS3({
      store,
      name: name.length > 0 ? name : undefined,
      pattern: pattern.length > 0 ? pattern : undefined,
      destDir,
      mergeMultiple,
      log: core
    })
    core.setOutput('download-path', s3Outcome.downloadPath)
    core.info('Download artifact has finished successfully')
    return
  }

  const githubToken = core.getInput('github-token')
  if (githubToken.length > 0) {
    core.warning(
      'the github-token input is ignored on BMC: artifacts are scoped to ' +
        "the current workflow run and authorized by the job's runtime " +
        'token — cross-repository downloads do not exist on BMC'
    )
  }
  const repositoryInput = core.getInput('repository')
  const currentRepository = env['GITHUB_REPOSITORY'] ?? ''
  if (
    repositoryInput.length > 0 &&
    currentRepository.length > 0 &&
    repositoryInput !== currentRepository
  ) {
    core.warning(
      `the repository input ('${repositoryInput}') is ignored on BMC: ` +
        'artifacts are scoped to the current workflow run'
    )
  }

  // The BMC token is bound to ITS run; another run's id would be
  // refused server-side. Fail here, loudly, instead — and a run-id
  // that is not a positive integer at all takes the same run-scope
  // error rather than silently falling through to the current run.
  const runIdInput = core.getInput('run-id')
  if (runIdInput.length > 0) {
    const current = env['GITHUB_RUN_ID'] ?? ''
    const wanted = /^[1-9][0-9]*$/.test(runIdInput)
      ? Number.parseInt(runIdInput, 10)
      : null
    const currentId = /^[1-9][0-9]*$/.test(current)
      ? Number.parseInt(current, 10)
      : null
    if (wanted === null || (currentId !== null && wanted !== currentId)) {
      throw new RunnerEnvError(
        `the run-id input ('${runIdInput}') does not name the current ` +
          'workflow run: BMC artifacts are scoped to the current run and ' +
          `the job's runtime token authorizes run ${current} only. ` +
          'Cross-run downloads do not exist on BMC.'
      )
    }
  }

  let artifactIds: number[] = []
  if (artifactIdsInput.length > 0) {
    const idList = artifactIdsInput
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0)
    if (idList.length === 0) {
      throw new Error(`No valid artifact IDs provided in 'artifact-ids' input`)
    }
    artifactIds = idList.map(id => {
      const numericId = Number.parseInt(id, 10)
      if (Number.isNaN(numericId)) {
        throw new Error(`Invalid artifact ID: '${id}'. Must be a number.`)
      }
      return numericId
    })
  }

  // 3. The runner runtime and the protocol client.
  const runtime = readRunnerRuntime(env)
  const client = new BmcArtifactClient({
    resultsUrl: runtime.resultsUrl,
    runtimeToken: runtime.runtimeToken,
    runId: runtime.runId
  })

  // 4. Download + extract (the upstream layout rules ride in the
  // shared orchestration).
  const outcome = await downloadArtifacts({
    client,
    name: name.length > 0 ? name : undefined,
    artifactIds,
    pattern: pattern.length > 0 ? pattern : undefined,
    destDir,
    mergeMultiple,
    log: core
  })

  core.setOutput('download-path', outcome.downloadPath)
  core.info('Download artifact has finished successfully')
}
