/**
 * The ncc entrypoint: run the upload and map any failure onto the
 * action's failure state (the upstream's own `run().catch(...)`
 * idiom).
 */

import * as core from '@actions/core'
import { runUpload } from './main'

runUpload().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  core.setFailed(`Unable to upload artifact(s): ${message}`)
})
