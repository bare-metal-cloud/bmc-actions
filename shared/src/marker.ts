/**
 * The BMC runner marker (story B5.5 phase 2; epic #3782).
 *
 * The BMC start operation (agentorch v0.1.36) stages
 * `BMC_ARTIFACT_STORE='1'` into every runner job's environment that has
 * the artifact store mounted. GitHub never sets it — and GitHub-hosted
 * runners DO carry ACTIONS_RUNTIME_URL / ACTIONS_RESULTS_URL /
 * ACTIONS_RUNTIME_TOKEN with GitHub's own values, so those names are
 * NEVER consulted for the store decision. Every action in this repo
 * asserts the marker FIRST and fails loudly before any network call, so
 * a mis-routed workflow gets one clear sentence instead of a confusing
 * GitHub-API 403/404.
 */

import { MarkerMissingError } from './errors'

/** The environment variable the BMC start op stages. */
export const MARKER_ENV = 'BMC_ARTIFACT_STORE'

/** The exact value the start op stages. */
export const MARKER_VALUE = '1'

/**
 * Human guidance rendered when the marker is missing. Names the
 * situation, the env var, and what to do on GitHub-hosted runners.
 */
export function markerMissingMessage(actionName: string): string {
  return (
    `${actionName}: this action only runs on BMC runners with the artifact ` +
    'store — your runner has no BMC artifact store mounted ' +
    `(environment variable ${MARKER_ENV} is not '${MARKER_VALUE}'). ` +
    'No network calls were made. On GitHub-hosted runners keep ' +
    'actions/upload-artifact and actions/download-artifact.'
  )
}

/**
 * True when the marker proves a BMC artifact store is mounted.
 * Anything but the exact staged value counts as absent.
 */
export function hasBmcArtifactStore(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env[MARKER_ENV] === MARKER_VALUE
}

/**
 * Asserts the marker and throws the loud refusal otherwise. The action
 * entrypoints call this before touching the network, the filesystem, or
 * anything else.
 */
export function assertBmcArtifactStore(
  actionName: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!hasBmcArtifactStore(env)) {
    throw new MarkerMissingError(markerMissingMessage(actionName))
  }
}
