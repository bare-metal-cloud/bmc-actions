/**
 * A tiny path-style S3 fake (PutObject, GetObject, HeadObject,
 * ListObjectsV2, multipart create/part/complete/abort) so the direct
 * object-store mode is exercised through the REAL AWS SDK client —
 * signing, path-style addressing and multipart included.
 */

import * as http from 'http'
import * as crypto from 'crypto'

export interface FakeS3 {
  url: string
  objects: Map<string, Buffer>
  /** Multipart uploads started / aborted, for assertions. */
  stats: {
    multipartStarted: number
    multipartCompleted: number
    aborted: number
  }
  requests: string[]
  close(): Promise<void>
}

export async function startFakeS3(bucket: string): Promise<FakeS3> {
  const objects = new Map<string, Buffer>()
  const uploads = new Map<string, Map<number, Buffer>>()
  const stats = { multipartStarted: 0, multipartCompleted: 0, aborted: 0 }
  const requests: string[] = []

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const u = new URL(req.url ?? '/', 'http://x')
      requests.push(`${req.method} ${u.pathname}${u.search}`)
      const prefix = `/${bucket}/`
      const send = (
        code: number,
        text = '',
        headers: Record<string, string> = {}
      ): void => {
        res.writeHead(code, headers)
        res.end(text)
      }
      if (
        (u.pathname === `/${bucket}` || u.pathname === `/${bucket}/`) &&
        u.searchParams.has('list-type')
      ) {
        const pfx = u.searchParams.get('prefix') ?? ''
        const keys = [...objects.keys()].filter(k => k.startsWith(pfx)).sort()
        const xml =
          `<?xml version="1.0"?><ListBucketResult><Name>${bucket}</Name>` +
          `<IsTruncated>false</IsTruncated><KeyCount>${keys.length}</KeyCount>` +
          keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('') +
          '</ListBucketResult>'
        return send(200, xml, { 'content-type': 'application/xml' })
      }
      if (!u.pathname.startsWith(prefix)) return send(404, 'bad bucket')
      const key = decodeURIComponent(u.pathname.slice(prefix.length))
      const uploadId = u.searchParams.get('uploadId')

      if (req.method === 'POST' && u.searchParams.has('uploads')) {
        const id = crypto.randomUUID()
        uploads.set(id, new Map())
        stats.multipartStarted++
        return send(
          200,
          `<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
          { 'content-type': 'application/xml' }
        )
      }
      if (req.method === 'PUT' && uploadId !== null) {
        const n = Number(u.searchParams.get('partNumber'))
        uploads.get(uploadId)?.set(n, body)
        return send(200, '', { etag: `"part-${n}"` })
      }
      if (req.method === 'POST' && uploadId !== null) {
        const parts = uploads.get(uploadId)
        if (parts === undefined) return send(404, 'no such upload')
        const ordered = [...parts.keys()].sort((a, b) => a - b)
        objects.set(
          key,
          Buffer.concat(ordered.map(n => parts.get(n) as Buffer))
        )
        uploads.delete(uploadId)
        stats.multipartCompleted++
        return send(
          200,
          `<?xml version="1.0"?><CompleteMultipartUploadResult><Key>${key}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`,
          { 'content-type': 'application/xml' }
        )
      }
      if (req.method === 'DELETE' && uploadId !== null) {
        uploads.delete(uploadId)
        stats.aborted++
        return send(204)
      }
      if (req.method === 'PUT') {
        objects.set(key, body)
        return send(200, '', { etag: '"obj"' })
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const obj = objects.get(key)
        if (obj === undefined) {
          return send(
            404,
            '<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>',
            { 'content-type': 'application/xml' }
          )
        }
        res.writeHead(200, { 'content-length': String(obj.length) })
        return res.end(req.method === 'HEAD' ? undefined : obj)
      }
      return send(405)
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    objects,
    stats,
    requests,
    close: () => new Promise<void>(r => server.close(() => r()))
  }
}
