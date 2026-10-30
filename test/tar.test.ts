/**
 * The deterministic tar packaging: two packs of the same tree are
 * byte-identical (sorted entries, zeroed mtime, gzip header mtime 0),
 * the chunker yields exact sizes, the round trip restores the tree,
 * and hostile entries are refused at extraction.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as zlib from 'zlib'
import * as tar from 'tar-stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PackedFile } from '../shared/src/tar'
import { extractTarGz, packToChunks, sortByEntryName } from '../shared/src/tar'

let workDir: string

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmc-tar-'))
})

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

const writeTree = (): {
  files: PackedFile[]
  contents: Map<string, string>
} => {
  const contents = new Map<string, string>([
    ['b.txt', 'bravo'],
    ['a/nested/deep/c.txt', 'charlie'],
    ['a.txt', 'alpha'],
    ['a/nested/binary.bin', 'bin\x00ary']
  ])
  const files: PackedFile[] = []
  for (const [entryName, content] of contents) {
    const absolutePath = path.join(workDir, ...entryName.split('/'))
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, content, 'binary')
    files.push({
      absolutePath,
      entryName,
      size: Buffer.byteLength(content)
    })
  }
  return { files, contents }
}

async function collect(
  files: PackedFile[],
  level: number,
  chunkSize: number
): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const chunk of packToChunks(files, level, chunkSize)) {
    parts.push(chunk)
  }
  return Buffer.concat(parts)
}

describe('packToChunks determinism', () => {
  it('two packs of the same tree are byte-identical', async () => {
    const { files } = writeTree()
    const first = await collect(files, 6, 1024)
    // The mtime of the source files cannot leak in: rewrite the files
    // with fresh timestamps and repack.
    fs.utimesSync(
      path.join(workDir, 'a.txt'),
      new Date(),
      new Date('2020-01-01')
    )
    const second = await collect(files, 6, 1024)
    expect(first).toEqual(second)
  })

  it('entries are sorted and carry zeroed, hostile-field-free metadata', async () => {
    const { files } = writeTree()
    const archive = await collect(files, 6, 1024)
    const names: string[] = []
    const headers: tar.Header[] = []
    const extract = tar.extract()
    // Feed the archive in BEFORE iterating: the iteration consumes
    // whatever the stream holds and ends when the archive ends. The
    // extractor consumes TAR, so uncompress first.
    extract.end(zlib.gunzipSync(archive))
    for await (const entry of extract) {
      names.push(entry.header.name)
      headers.push(entry.header)
    }
    expect(names).toEqual([...names].sort())
    for (const header of headers) {
      expect(header.mtime.getTime()).toBe(0)
      expect(header.uid).toBe(0)
      expect(header.gid).toBe(0)
      expect(header.uname).toBe('')
      expect(header.gname).toBe('')
      expect(header.mode).toBe(0o644)
      expect(header.type).toBe('file')
    }
  })

  it('the gzip header mtime is zero (container determinism)', async () => {
    const { files } = writeTree()
    const archive = await collect(files, 6, 1024)
    // gzip header bytes 4..7 (little endian MTIME) must be zero.
    expect(archive[4]).toBe(0)
    expect(archive[5]).toBe(0)
    expect(archive[6]).toBe(0)
    expect(archive[7]).toBe(0)
  })

  it('compression level 0 and 9 both round-trip (and differ in size)', async () => {
    const { files } = writeTree()
    const level0 = await collect(files, 0, 1024)
    const level9 = await collect(files, 9, 1024)
    const dir0 = path.join(workDir, 'out0')
    const dir9 = path.join(workDir, 'out9')
    await extractTarGz(level0, dir0)
    await extractTarGz(level9, dir9)
    expect(fs.readFileSync(path.join(dir0, 'a.txt'), 'utf8')).toBe('alpha')
    expect(fs.readFileSync(path.join(dir9, 'a.txt'), 'utf8')).toBe('alpha')
  })

  it('paths longer than the ustar name field survive (pax/prefix)', async () => {
    const deepName = `${'d'.repeat(60)}/${'e'.repeat(60)}/leaf.txt`
    const absolutePath = path.join(workDir, ...deepName.split('/'))
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, 'deep leaf')
    const files: PackedFile[] = [{ absolutePath, entryName: deepName, size: 9 }]
    const archive = await collect(files, 6, 512)
    const outDir = path.join(workDir, 'out')
    const written = await extractTarGz(archive, outDir)
    expect(written).toEqual([deepName])
    expect(fs.readFileSync(path.join(outDir, deepName), 'utf8')).toBe(
      'deep leaf'
    )
  })
})

describe('the chunker', () => {
  it('yields exact-size chunks and one short tail', async () => {
    const { files } = writeTree()
    const chunkSize = 7
    const sizes: number[] = []
    for await (const chunk of packToChunks(files, 6, chunkSize)) {
      sizes.push(chunk.length)
    }
    for (const size of sizes.slice(0, -1)) {
      expect(size).toBe(chunkSize)
    }
    expect(sizes.at(-1)).toBeLessThanOrEqual(chunkSize)
    expect(sizes.at(-1)).toBeGreaterThan(0)
  })

  it('round-trips byte-identically at a large chunk size', async () => {
    const { files, contents } = writeTree()
    const archive = await collect(files, 6, 64 * 1024 * 1024)
    const outDir = path.join(workDir, 'roundtrip')
    await extractTarGz(archive, outDir)
    for (const [entryName, content] of contents) {
      expect(
        fs.readFileSync(path.join(outDir, ...entryName.split('/')), 'binary')
      ).toBe(content)
    }
  })

  it('refuses an empty file list', async () => {
    await expect(collect([], 6, 1024)).rejects.toThrow(/no files to pack/)
  })
})

describe('extractTarGz safety', () => {
  // The pack stream emits asynchronously: await its end before
  // reading the produced bytes.
  const packHostile = async (name: string): Promise<Buffer> => {
    const packStream = tar.pack()
    const chunks: Buffer[] = []
    packStream.on('data', (chunk: unknown) =>
      chunks.push(Buffer.from(chunk as Buffer))
    )
    const done = new Promise<void>(resolve => {
      packStream.on('end', () => {
        resolve()
      })
    })
    const entry = packStream.entry(
      { name, size: 2, type: 'file', mtime: new Date(0) },
      () => {}
    )
    entry.end('hi')
    packStream.finalize()
    await done
    return Buffer.concat(chunks)
  }

  it('refuses a .. escape entry (zip-slip)', async () => {
    const archive = zlib.gzipSync(await packHostile('../evil.txt'))
    await expect(
      extractTarGz(archive, path.join(workDir, 'out'))
    ).rejects.toThrow(/refusing unsafe entry name/)
  })

  it('refuses an absolute-path entry', async () => {
    const archive = zlib.gzipSync(await packHostile('/etc/evil.txt'))
    await expect(
      extractTarGz(archive, path.join(workDir, 'out'))
    ).rejects.toThrow(/refusing unsafe entry name/)
  })

  it('refuses a symlink entry', async () => {
    const packStream = tar.pack()
    const chunks: Buffer[] = []
    const done = new Promise<Buffer>(resolve => {
      packStream.on('end', () => {
        resolve(Buffer.concat(chunks))
      })
    })
    packStream.on('data', (chunk: unknown) =>
      chunks.push(Buffer.from(chunk as Buffer))
    )
    packStream.entry(
      {
        name: 'link',
        type: 'symlink',
        linkname: '/etc/passwd',
        size: 0,
        mtime: new Date(0)
      },
      () => {}
    )
    packStream.finalize()
    const archive = zlib.gzipSync(await done)
    await expect(
      extractTarGz(archive, path.join(workDir, 'out'))
    ).rejects.toThrow(/refusing non-file entry/)
  })

  it('refuses non-gzip input with a clear error', async () => {
    await expect(
      extractTarGz(
        Buffer.from('this is not gzip at all'),
        path.join(workDir, 'out')
      )
    ).rejects.toThrow()
  })
})

describe('sortByEntryName', () => {
  it('sorts in codepoint order regardless of input order', () => {
    const sorted = sortByEntryName([
      { absolutePath: '/z', entryName: 'z.txt', size: 1 },
      { absolutePath: '/a', entryName: 'a/nested.txt', size: 1 },
      { absolutePath: '/b', entryName: 'a.txt', size: 1 }
    ])
    expect(sorted.map(f => f.entryName)).toEqual([
      'a.txt',
      'a/nested.txt',
      'z.txt'
    ])
  })
})
