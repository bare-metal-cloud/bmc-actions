/**
 * The ncc entrypoint: run the download and map any failure onto the
 * action's failure state (the upstream's own `run().catch(...)`
 * idiom).
 */

import * as core from '@actions/core'
import { runDownload } from './main'

runDownload().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  core.setFailed(`Unable to download artifact(s): ${message}`)
})
