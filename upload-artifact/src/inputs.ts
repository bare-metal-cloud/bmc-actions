/**
 * The upload action's inputs — the upstream v4 grammar (read live from
 * actions/upload-artifact@v4's action.yml), with the BMC mapping:
 * retention-days is accepted with a warning (the org's retention policy
 * governs), compression-level is the tar.gz level, overwrite drives the
 * protocol's re-create arm.
 */

import * as core from '@actions/core'
import { BmcArtifactError } from '../../shared/src/errors'

export const NO_FILE_OPTIONS = ['warn', 'error', 'ignore'] as const
export type NoFileOption = (typeof NO_FILE_OPTIONS)[number]

export interface UploadInputs {
  artifactName: string
  /** Newline-separated glob patterns (the upstream multiline path). */
  searchPaths: string[]
  ifNoFilesFound: NoFileOption
  /** Accepted + warned; never applied (the org policy governs). */
  retentionDays: number | null
  compressionLevel: number
  overwrite: boolean
  includeHiddenFiles: boolean
}

/**
 * Reads and validates the action inputs. Throws (the entry turns the
 * throw into core.setFailed) on any invalid value.
 */
export function getInputs(): UploadInputs {
  const artifactName = core.getInput('name') || 'artifact'
  const rawPath = core.getInput('path', { required: true })
  const searchPaths = rawPath
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
  if (searchPaths.length === 0) {
    throw new BmcArtifactError(
      `the 'path' input is required: no file, directory or wildcard pattern ` +
        'was provided'
    )
  }

  const ifNoFilesFoundRaw = core.getInput('if-no-files-found') || 'warn'
  if (!NO_FILE_OPTIONS.includes(ifNoFilesFoundRaw as NoFileOption)) {
    throw new BmcArtifactError(
      `Unrecognized if-no-files-found input. Provided: ${ifNoFilesFoundRaw}. ` +
        `Available options: ${NO_FILE_OPTIONS.join(', ')}`
    )
  }
  const ifNoFilesFound = ifNoFilesFoundRaw as NoFileOption

  let retentionDays: number | null = null
  const retentionDaysStr = core.getInput('retention-days')
  if (retentionDaysStr.length > 0) {
    retentionDays = Number.parseInt(retentionDaysStr, 10)
    if (Number.isNaN(retentionDays)) {
      throw new BmcArtifactError('Invalid retention-days')
    }
    core.warning(
      'retention-days is accepted for upstream compatibility but does not ' +
        "change BMC retention: the organization's artifact retention " +
        'policy governs how long BMC artifacts live.'
    )
  }

  const compressionLevelStr = core.getInput('compression-level') || '6'
  const compressionLevel = Number.parseInt(compressionLevelStr, 10)
  if (Number.isNaN(compressionLevel)) {
    throw new BmcArtifactError('Invalid compression-level')
  }
  if (compressionLevel < 0 || compressionLevel > 9) {
    throw new BmcArtifactError(
      'Invalid compression-level. Valid values are 0-9'
    )
  }

  return {
    artifactName,
    searchPaths,
    ifNoFilesFound,
    retentionDays,
    compressionLevel,
    overwrite: core.getBooleanInput('overwrite'),
    includeHiddenFiles: core.getBooleanInput('include-hidden-files')
  }
}
