/**
 * Direct object-store download: the selection and layout rules of
 * downloadArtifacts (name | pattern | all; per-artifact directories
 * unless merge-multiple) over the S3 store. Unlike the BMC path, a
 * digest mismatch FAILS (nothing is extracted from unverified bytes).
 */

import * as path from 'path'
import { Minimatch } from 'minimatch'
import {
  assertExtractionRootUnderDestination,
  assertSafeArtifactName
} from './download'
import type { DownloadOutcome } from './download'
import type { S3ArtifactStore, S3Manifest } from './s3store'
import { extractTarGz } from './tar'
import type { Log } from './upload'

export interface S3DownloadRequest {
  store: S3ArtifactStore
  name?: string | undefined
  pattern?: string | undefined
  destDir: string
  mergeMultiple: boolean
  log: Log
}

export async function downloadFromS3(
  req: S3DownloadRequest
): Promise<DownloadOutcome> {
  const single = req.name !== undefined && req.name !== ''
  let artifacts: S3Manifest[]
  if (single) {
    req.log.info('Downloading single artifact')
    const name = req.name ?? ''
    const manifest = await req.store.getManifest(name)
    if (manifest === null) {
      throw new Error(`Artifact '${name}' not found`)
    }
    artifacts = [manifest]
  } else {
    artifacts = await req.store.list()
    if (req.pattern !== undefined && req.pattern !== '') {
      req.log.info(`Filtering artifacts by pattern '${req.pattern}'`)
      const matcher = new Minimatch(req.pattern)
      artifacts = artifacts.filter(a => matcher.match(a.name))
    } else {
      req.log.info(
        'No input name or pattern specified, downloading all artifacts'
      )
    }
  }

  const names: string[] = []
  for (const artifact of artifacts) {
    assertSafeArtifactName(artifact.name)
    const target =
      single || req.mergeMultiple
        ? req.destDir
        : path.join(req.destDir, artifact.name)
    assertExtractionRootUnderDestination(req.destDir, target)
    req.log.info(
      `- ${artifact.name} (Size: ${artifact.size}, Digest: ${artifact.digest})`
    )
    const bytes = await req.store.download(artifact)
    const written = await extractTarGz(bytes, target)
    req.log.info(
      `extracted ${written.length} file(s) from '${artifact.name}' into ${target}`
    )
    names.push(artifact.name)
  }
  req.log.info(`Total of ${names.length} artifact(s) downloaded`)
  return { downloadPath: req.destDir, artifactNames: names }
}
