/**
 * Deterministic gzip'd tar packaging for the BMC artifact store.
 *
 * ONE BMC artifact = ONE object: a multi-file `path` packages as a
 * deterministic gzip'd tar — entries sorted by name (codepoint order),
 * zeroed mtimes, zero uid/gid, empty owner names, fixed modes, no pax
 * extras — so two packs of the same tree are byte-identical (pinned by
 * test). The download side extracts the same format back to the tree,
 * refusing hostile entries (absolute paths, `..` escapes, non-file
 * types) at the boundary.
 *
 * gzip carries `mtime: 0` so the container header is deterministic too;
 * the compression level is the upstream `compression-level` input.
 *
 * tar-stream v3 is built on streamx streams, whose pipe semantics are
 * compatible with Node streams but not with `stream.promises.pipeline`;
 * the plumbing below awaits pipes by hand.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import {
  pack as tarPack,
  extract as tarExtract,
  type Header,
  type Pack
} from 'tar-stream'
import type { Readable as XReadable } from 'streamx'
import { Readable } from 'stream'

/** One file staged for packing, entry-name relative to the artifact root. */
export interface PackedFile {
  /** Absolute path on disk to read the bytes from. */
  absolutePath: string
  /** The tar entry name — POSIX separators, relative, pre-normalized. */
  entryName: string
  /** The file size in bytes (from stat; the tar header needs it). */
  size: number
}

/**
 * Sorts files by entry name in codepoint order — the deterministic
 * archive order.
 */
export function sortByEntryName(files: PackedFile[]): PackedFile[] {
  return [...files].sort((a, b) =>
    a.entryName < b.entryName ? -1 : a.entryName > b.entryName ? 1 : 0
  )
}

/**
 * Packs the files into a deterministic gzip'd tar and answers an async
 * generator of exactly-sized chunks (the last one possibly short).
 * Backpressure flows end to end (file stream → tar entry → gzip → the
 * chunk consumer), so peak memory stays bounded regardless of the
 * artifact size.
 *
 * @param files the staged files (sorted by sortByEntryName; a copy is
 *   sorted here anyway, so callers cannot ship an unsorted archive)
 * @param compressionLevel 0–9 (the upstream `compression-level` input)
 * @param chunkSize the exact chunk size to yield
 */
export async function* packToChunks(
  files: PackedFile[],
  compressionLevel: number,
  chunkSize: number
): AsyncGenerator<Buffer, void, void> {
  if (files.length === 0) {
    throw new Error('packToChunks: no files to pack')
  }
  const packStream = tarPack()
  // mtime is a real zlib option (the gzip header timestamp) supported
  // at runtime; this @types/node revision omits it from ZlibOptions.
  const gzip = zlib.createGzip({
    level: compressionLevel,
    mtime: 0
  } as zlib.ZlibOptions)
  packStream.pipe(gzip)

  // Drive the entries sequentially; the tar pack stream propagates the
  // gzip stream's backpressure into each entry write, so the whole
  // assembly stays memory-bounded.
  const packing = (async () => {
    try {
      for (const file of sortByEntryName(files)) {
        await addFileEntry(packStream, file)
      }
      packStream.finalize()
    } catch (err) {
      packStream.destroy(err instanceof Error ? err : new Error(String(err)))
      gzip.destroy(err instanceof Error ? err : new Error(String(err)))
    }
  })()

  // Yield exact-size chunks from the gzip stream.
  const queue: Buffer[] = []
  let queued = 0
  const takeExact = (want: number): Buffer => {
    const parts: Buffer[] = []
    let taken = 0
    while (taken < want) {
      const head = queue[0]
      if (head === undefined) {
        throw new Error('packToChunks: chunk queue ran dry (internal error)')
      }
      if (taken + head.length <= want) {
        parts.push(head)
        taken += head.length
        queue.shift()
      } else {
        parts.push(head.subarray(0, want - taken))
        queue[0] = head.subarray(want - taken)
        taken = want
      }
    }
    queued -= taken
    return parts.length === 1 && parts[0] !== undefined
      ? parts[0]
      : Buffer.concat(parts)
  }

  try {
    // zlib streams are typed loosely (any per chunk); pin the element.
    for await (const buf of gzip as AsyncIterable<Buffer>) {
      queue.push(buf)
      queued += buf.length
      while (queued >= chunkSize) {
        yield takeExact(chunkSize)
      }
    }
    if (queued > 0) {
      yield Buffer.concat(queue)
      queue.length = 0
      queued = 0
    }
    await packing
  } catch (err) {
    // The packing side must not keep streaming after a consumer error.
    packStream.destroy(err instanceof Error ? err : new Error(String(err)))
    throw err
  }
}

async function addFileEntry(packStream: Pack, file: PackedFile): Promise<void> {
  if (file.entryName.includes('\\') || file.entryName.startsWith('/')) {
    throw new Error(
      `packToChunks: entry name must be a relative POSIX path: ${file.entryName}`
    )
  }
  await new Promise<void>((resolve, reject) => {
    const entry = packStream.entry(
      {
        name: file.entryName,
        size: file.size,
        // Deterministic, "no hostile fields": fixed metadata everywhere.
        mode: 0o644,
        mtime: new Date(0),
        type: 'file',
        uid: 0,
        gid: 0,
        uname: '',
        gname: ''
      },
      err => {
        // Resolves when the entry has fully drained into the pack
        // stream (backpressure-aware); rejects on any entry error.
        if (err !== undefined && err !== null) reject(err)
        else resolve()
      }
    )
    const source = fs.createReadStream(file.absolutePath)
    source.on('error', reject)
    entry.on('error', reject)
    // The entry callback above resolves when the entry has fully drained
    // into the pack stream (backpressure-aware).
    source.pipe(entry)
  })
}

/**
 * Extracts a gzip'd tar (this module's own pack format) under `destDir`,
 * creating parent directories as needed. Answers the entry names it
 * wrote, in archive order. Refuses: absolute entry paths, `..` escapes,
 * backslashes, and any non-file entry (the packer only ever writes
 * plain files — anything else in the stream is hostile or corrupt).
 */
export async function extractTarGz(
  tarGz: Uint8Array,
  destDir: string
): Promise<string[]> {
  const written: string[] = []
  const extractStream = tarExtract()
  const gunzip = zlib.createGunzip()
  const source = Readable.from(Buffer.from(tarGz))

  // A failure anywhere in the chain destroys the extractor, so the
  // async iteration below rejects instead of waiting forever.
  const fail = (err: Error): void => {
    source.destroy()
    gunzip.destroy()
    extractStream.destroy(err)
  }
  gunzip.on('error', fail)
  source.on('error', fail)

  source.pipe(gunzip)
  gunzip.pipe(extractStream)

  try {
    for await (const entry of extractStream) {
      written.push(await writeEntry(destDir, entry.header, entry))
    }
  } finally {
    source.destroy()
  }
  return written
}

async function writeEntry(
  destDir: string,
  header: Header,
  entry: XReadable
): Promise<string> {
  if (header.type !== 'file') {
    throw new Error(
      `extractTarGz: refusing non-file entry "${header.name}" (type ${header.type})`
    )
  }
  const name = header.name
  if (name.startsWith('/') || name.includes('\\')) {
    throw new Error(`extractTarGz: refusing unsafe entry name: ${name}`)
  }
  const segments = name.split('/')
  if (segments.some(seg => seg === '..' || seg === '')) {
    throw new Error(`extractTarGz: refusing unsafe entry name: ${name}`)
  }
  const target = path.join(destDir, ...segments)
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(target, { mode: 0o644 })
    out.on('error', reject)
    out.on('finish', resolve)
    entry.on('error', reject)
    entry.pipe(out)
  })
  return name
}
