/**
 * The download orchestration the download-artifact action drives — the
 * live actions/download-artifact v4 src/download-artifact.ts flow over
 * the BMC protocol:
 *
 *   - a `name` selects one artifact via the detail endpoint; a miss
 *     fails the action (`Artifact '<name>' not found` — the upstream
 *     wording)
 *   - `artifact-ids` selects by the row ids the signed URLs carry; a
 *     zero match fails (`None of the provided artifact IDs were
 *     found`), a partial match warns with the upstream wording
 *   - a `pattern` filters the run's artifacts by name (minimatch, the
 *     upstream matcher); no matches at all downloads nothing and
 *     SUCCEEDS (the upstream behavior)
 *   - one named artifact (or merge-multiple) extracts directly into the
 *     destination; multiple artifacts extract into per-artifact
 *     subdirectories unless merge-multiple
 *
 * The protocol's reads are RUN-bound, so a later job of the same run
 * downloads an earlier job's artifact — the v4 cross-job semantics.
 */

import * as crypto from 'crypto'
import * as path from 'path'
import { Minimatch } from 'minimatch'
import type { ArtifactEntry, BmcArtifactClient } from './client'
import { artifactIdFromSignedUrl } from './client'
import { ArtifactNotFoundError } from './errors'
import type { Log } from './upload'
import { extractTarGz } from './tar'

export interface DownloadRequest {
  client: BmcArtifactClient
  /** Single-artifact selection (exclusive with artifactIds). */
  name?: string | undefined
  /** Selection by artifact row ids (exclusive with name). */
  artifactIds?: number[] | undefined
  /** Glob filter on artifact names (ignored when name is set). */
  pattern?: string | undefined
  /** Destination directory (resolved, tilde-expanded by the caller). */
  destDir: string
  mergeMultiple: boolean
  log: Log
}

export interface DownloadOutcome {
  /** The resolved destination (the download-path output). */
  downloadPath: string
  /** The names of the artifacts that were downloaded. */
  artifactNames: string[]
}

/**
 * Resolves the artifact selection and extracts every match into the
 * destination tree.
 */
export async function downloadArtifacts(
  req: DownloadRequest
): Promise<DownloadOutcome> {
  const isSingleArtifactDownload = req.name !== undefined && req.name !== ''
  const isDownloadByIds =
    req.artifactIds !== undefined && req.artifactIds.length > 0

  let artifacts: ArtifactEntry[]
  if (isSingleArtifactDownload) {
    req.log.info('Downloading single artifact')
    const name = req.name ?? ''
    try {
      artifacts = [await req.client.getArtifact(name)]
    } catch (err) {
      if (err instanceof ArtifactNotFoundError) {
        throw new Error(`Artifact '${name}' not found`)
      }
      throw err
    }
  } else if (isDownloadByIds) {
    req.log.info('Downloading artifacts by ID')
    const ids = req.artifactIds ?? []
    const all = await req.client.listArtifacts()
    artifacts = all.filter(artifact => {
      const id = artifactIdFromSignedUrl(artifact.fileContainerResourceUrl)
      return id !== null && ids.includes(id)
    })
    if (artifacts.length === 0) {
      throw new Error('None of the provided artifact IDs were found')
    }
    if (artifacts.length < ids.length) {
      const found = new Set(
        artifacts
          .map(a => artifactIdFromSignedUrl(a.fileContainerResourceUrl))
          .filter((id): id is number => id !== null)
      )
      const missing = ids.filter(id => !found.has(id))
      req.log.warning(
        `Could not find the following artifact IDs: ${missing.join(', ')}`
      )
    }
  } else {
    artifacts = await req.client.listArtifacts()
    req.log.debug?.(`Found ${artifacts.length} artifacts in run`)
    if (req.pattern !== undefined && req.pattern !== '') {
      req.log.info(`Filtering artifacts by pattern '${req.pattern}'`)
      const matcher = new Minimatch(req.pattern)
      artifacts = artifacts.filter(artifact => matcher.match(artifact.name))
    } else {
      req.log.info(
        'No input name, artifact-ids or pattern filtered specified, ' +
          'downloading all artifacts'
      )
    }
  }

  if (artifacts.length > 0) {
    req.log.info('Preparing to download the following artifacts:')
    for (const artifact of artifacts) {
      req.log.info(
        `- ${artifact.name} (ID: ` +
          `${artifactIdFromSignedUrl(artifact.fileContainerResourceUrl) ?? 'unknown'}, ` +
          `Size: ${artifact.size}, Digest: ${artifact.digest})`
      )
    }
  }

  const names: string[] = []
  for (const artifact of artifacts) {
    // Upstream layout: a single named artifact (or merge-multiple)
    // extracts straight into the destination; multiple artifacts land
    // in per-artifact directories.
    const target =
      isSingleArtifactDownload || req.mergeMultiple
        ? req.destDir
        : path.join(req.destDir, artifact.name)
    await downloadOne(req, artifact, target)
    names.push(artifact.name)
  }

  req.log.info(`Total of ${names.length} artifact(s) downloaded`)
  return { downloadPath: req.destDir, artifactNames: names }
}

async function downloadOne(
  req: DownloadRequest,
  artifact: ArtifactEntry,
  targetDir: string
): Promise<void> {
  const files = await req.client.listFiles(artifact.fileContainerResourceUrl)
  const file = files[0]
  if (files.length !== 1 || file === undefined) {
    throw new Error(
      `the artifact '${artifact.name}' lists ${files.length} item(s); the ` +
        'BMC store holds exactly one blob per artifact'
    )
  }
  const bytes = await req.client.downloadBytes(file.contentLocation)

  // Integrity: the store's sha256 of the stored bytes. A mismatch warns
  // (the upstream wording) but does not fail the action.
  const actual = crypto.createHash('sha256').update(bytes).digest('hex')
  if (actual !== artifact.digest) {
    req.log.warning(
      `Artifact '${artifact.name}' digest validation failed. Please verify ` +
        'the integrity of the artifact.'
    )
  }

  const written = await extractTarGz(bytes, targetDir)
  req.log.info(
    `extracted ${written.length} file(s) from '${artifact.name}' into ` +
      targetDir
  )
}
