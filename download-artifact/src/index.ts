/**
 * The ncc entrypoint: run the download and map any failure onto the
 * action's failure state (the upstream's own `run().catch(...)`
 * idiom).
 */

import * as core from '@actions/core'
import { runDownload } from './main'
import { MARKER_ENV, MARKER_VALUE } from '../../shared/src/marker'

// Defense in depth: mask the runtime token in any log rendering
// before anything runs (only after the marker says this is a BMC
// runner — on anything else the token is not ours to handle).
if (process.env[MARKER_ENV] === MARKER_VALUE) {
  const token = process.env['ACTIONS_RUNTIME_TOKEN']
  if (token !== undefined && token.length > 0) {
    core.setSecret(token)
  }
}

runDownload().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  core.setFailed(`Unable to download artifact(s): ${message}`)
})
