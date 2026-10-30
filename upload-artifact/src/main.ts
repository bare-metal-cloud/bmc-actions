/**
 * upload-artifact (BMC) — the run body.
 *
 * ORDER MATTERS: the BMC marker asserts FIRST, before any network call,
 * filesystem write, or input processing that could mask the refusal
 * with a confusing GitHub-API 403/404.
 */

import * as core from '@actions/core'
import { assertBmcArtifactStore } from '../../shared/src/marker'
import { readRunnerRuntime } from '../../shared/src/env'
import { BmcArtifactClient } from '../../shared/src/client'
import { findFilesToUpload, stageFiles } from '../../shared/src/search'
import { uploadArtifact } from '../../shared/src/upload'
import { getInputs } from './inputs'

export async function runUpload(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  // 1. THE MARKER — the loud BMC-only refusal, before anything else.
  assertBmcArtifactStore('upload-artifact', env)

  // 2. Inputs and the runner runtime (all before any network call).
  const inputs = getInputs()
  const runtime = readRunnerRuntime(env)
  const client = new BmcArtifactClient({
    resultsUrl: runtime.resultsUrl,
    runtimeToken: runtime.runtimeToken,
    runId: runtime.runId
  })

  // 3. Search the workspace (the upstream search semantics).
  const search = await findFilesToUpload(
    inputs.searchPaths.join('\n'),
    inputs.includeHiddenFiles
  )

  if (search.files.length === 0) {
    // The upstream if-no-files-found grammar, same wording.
    const message =
      `No files were found with the provided path: ${inputs.searchPaths.join('\n')}. ` +
      'No artifacts will be uploaded.'
    switch (inputs.ifNoFilesFound) {
      case 'warn': {
        core.warning(message)
        return
      }
      case 'error': {
        throw new Error(message)
      }
      case 'ignore': {
        core.info(message)
        return
      }
    }
  }

  const s = search.files.length === 1 ? '' : 's'
  core.info(
    `With the provided path, there will be ${search.files.length} file${s} uploaded`
  )
  core.debug(`Root artifact directory is ${search.rootDirectory}`)
  for (const collision of search.caseCollisions) {
    core.info(
      'Uploads are case insensitive: ' +
        `${collision} was detected that it will be overwritten by another ` +
        'file with the same path'
    )
  }

  // 4. Upload: create → chunk PATCH → finalize (the protocol laws ride
  // in the shared orchestration).
  const outcome = await uploadArtifact({
    client,
    artifactName: inputs.artifactName,
    files: stageFiles(search.files, search.rootDirectory),
    compressionLevel: inputs.compressionLevel,
    overwrite: inputs.overwrite,
    log: core
  })

  core.info(
    `Artifact ${inputs.artifactName} has been successfully uploaded! ` +
      `Final size is ${outcome.size} bytes. Artifact ID is ` +
      `${outcome.artifactId ?? 'unknown'}`
  )
  core.setOutput(
    'artifact-id',
    outcome.artifactId === null ? '' : String(outcome.artifactId)
  )
  core.setOutput('artifact-digest', outcome.digest)

  // The web-UI URL when the workflow context can compose one; BMC has
  // no GitHub API artifact URL (the download flows through
  // download-artifact within the run).
  const artifactUrl = composeArtifactUrl(env, outcome.artifactId)
  if (artifactUrl !== null) {
    core.info(`Artifact download URL: ${artifactUrl}`)
  }
  core.setOutput('artifact-url', artifactUrl ?? '')
}

function composeArtifactUrl(
  env: NodeJS.ProcessEnv,
  artifactId: number | null
): string | null {
  const serverUrl = env['GITHUB_SERVER_URL']
  const repository = env['GITHUB_REPOSITORY']
  const runId = env['GITHUB_RUN_ID']
  if (
    serverUrl === undefined ||
    repository === undefined ||
    runId === undefined ||
    artifactId === null
  ) {
    return null
  }
  return `${serverUrl}/${repository}/actions/runs/${runId}/artifacts/${artifactId}`
}
