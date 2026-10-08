import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { serveMediaFile } from './serve'

describe('serveMediaFile', () => {
  let dir: string
  let file: string
  const content = Buffer.from(Array.from({ length: 256 }, (_, i) => i))

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vixel-serve-'))
    file = join(dir, 'clip.MP4')
    await writeFile(file, content)
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('no Range → 200 full body', async () => {
    const res = await serveMediaFile(file, null)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe('256')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(content)
  })

  it('Range → 206 exact slice', async () => {
    const res = await serveMediaFile(file, 'bytes=100-149')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 100-149/256')
    expect(res.headers.get('content-length')).toBe('50')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(content.subarray(100, 150))
  })

  it('open-ended + suffix ranges', async () => {
    const tail = await serveMediaFile(file, 'bytes=250-')
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(content.subarray(250))
    const suffix = await serveMediaFile(file, 'bytes=-6')
    expect(suffix.headers.get('content-range')).toBe('bytes 250-255/256')
  })

  it('out of range → 416 with size', async () => {
    const res = await serveMediaFile(file, 'bytes=256-')
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */256')
  })
})
