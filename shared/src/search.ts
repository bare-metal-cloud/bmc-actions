/**
 * File search for the upload action — a faithful port of the live
 * actions/upload-artifact v4 src/shared/search.ts semantics (Apache-2.0
 * / MIT upstream, credited in the README), driven through the same
 * @actions/glob package the upstream uses:
 *
 *   - glob options: followSymbolicLinks, implicitDescendants,
 *     omitBrokenSymbolicLinks, excludeHiddenFiles = !includeHiddenFiles
 *   - directories are filtered out of the results
 *   - case-collision detection (uploads are case-insensitive server-side)
 *   - multiple patterns: the least common ancestor of the search paths
 *     becomes the artifact root
 *   - a single file named WITHOUT a directory or wildcard keeps v4's
 *     restore shape: the root becomes the file's parent directory, so
 *     the archive holds the file at its basename and a download
 *     extracts it to path/<original filename>
 */

import * as fs from 'fs'
import * as path from 'path'
import * as glob from '@actions/glob'

export interface FoundFile {
  absolutePath: string
  size: number
}

export interface SearchResult {
  files: FoundFile[]
  rootDirectory: string
  /** Files that would silently overwrite each other (case-insensitive). */
  caseCollisions: string[]
}

interface GlobberLike {
  glob(): Promise<string[]>
  getSearchPaths(): string[]
}

function getDefaultGlobOptions(includeHiddenFiles: boolean): glob.GlobOptions {
  return {
    followSymbolicLinks: true,
    implicitDescendants: true,
    omitBrokenSymbolicLinks: true,
    excludeHiddenFiles: !includeHiddenFiles
  }
}

/**
 * The least common ancestor of the (normalized) search paths — the
 * upstream getMultiPathLCA, verbatim in behavior.
 */
function getMultiPathLCA(searchPaths: string[]): string {
  if (searchPaths.length < 2) {
    throw new Error('At least two search paths must be provided')
  }
  const commonPaths = new Array<string>()
  const splitPaths = new Array<string[]>()
  let smallestPathLength = Number.MAX_SAFE_INTEGER
  for (const searchPath of searchPaths) {
    const splitSearchPath = path.normalize(searchPath).split(path.sep)
    smallestPathLength = Math.min(smallestPathLength, splitSearchPath.length)
    splitPaths.push(splitSearchPath)
  }
  if (searchPaths[0]?.startsWith(path.sep) === true) {
    commonPaths.push(path.sep)
  }
  let splitIndex = 0
  const isPathTheSame = (): boolean => {
    const compare = splitPaths[0]?.[splitIndex]
    for (let i = 1; i < splitPaths.length; i++) {
      if (compare !== splitPaths[i]?.[splitIndex]) {
        return false
      }
    }
    return true
  }
  while (splitIndex < smallestPathLength) {
    if (!isPathTheSame()) {
      break
    }
    const segment = splitPaths[0]?.[splitIndex]
    if (segment !== undefined) {
      commonPaths.push(segment)
    }
    splitIndex++
  }
  return path.join(...commonPaths)
}

/**
 * Finds the files the upload action should package for `searchPath`
 * (newline-separated patterns were already split by the caller).
 */
export async function findFilesToUpload(
  searchPath: string,
  includeHiddenFiles: boolean
): Promise<SearchResult> {
  const globber: GlobberLike = await glob.create(
    searchPath,
    getDefaultGlobOptions(includeHiddenFiles)
  )
  const rawSearchResults: string[] = await globber.glob()

  const files: FoundFile[] = []
  const caseCollisions: string[] = []
  const seen = new Set<string>()
  for (const searchResult of rawSearchResults) {
    // stat (not lstat): a symlinked file uploads its target's bytes, the
    // upstream behavior.
    const stats = await fs.promises.stat(searchResult)
    if (!stats.isDirectory()) {
      files.push({ absolutePath: searchResult, size: stats.size })
      const lower = searchResult.toLowerCase()
      if (seen.has(lower)) {
        caseCollisions.push(searchResult)
      } else {
        seen.add(lower)
      }
    }
  }

  const searchPaths: string[] = globber.getSearchPaths()
  if (searchPaths.length > 1) {
    return {
      files,
      rootDirectory: getMultiPathLCA(searchPaths),
      caseCollisions
    }
  }

  // v4's single-file special case: a bare file (no directory or
  // wildcard) uploads at its basename — the restore shape v4 keeps.
  const firstPath = searchPaths[0]
  const firstResult = files[0]
  if (
    files.length === 1 &&
    firstPath !== undefined &&
    firstResult !== undefined &&
    firstPath === firstResult.absolutePath
  ) {
    return {
      files,
      rootDirectory: path.dirname(firstResult.absolutePath),
      caseCollisions
    }
  }

  return {
    files,
    rootDirectory: firstPath ?? process.cwd(),
    caseCollisions
  }
}

/**
 * Projects found files onto the packer's file list: entry names are the
 * paths relative to the artifact root, POSIX-separated.
 */
export function stageFiles(
  files: FoundFile[],
  rootDirectory: string
): { absolutePath: string; entryName: string; size: number }[] {
  return files.map(file => {
    const relative = path.relative(rootDirectory, file.absolutePath)
    // Only an exact '..' path segment escapes the root; a name that
    // merely STARTS with '..' (a file literally named '..foo') is a
    // legal entry.
    const segments = relative.split(path.sep)
    if (path.isAbsolute(relative) || segments.includes('..')) {
      throw new Error(
        `found file ${file.absolutePath} escapes the artifact root ${rootDirectory}`
      )
    }
    return {
      absolutePath: file.absolutePath,
      entryName: segments.join('/'),
      size: file.size
    }
  })
}
