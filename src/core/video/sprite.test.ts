import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { generateSprite, ensureSprite, SPRITE_FRAMES, SPRITE_TILE } from './sprite'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpeg = require('ffmpeg-static') as string | null

describe.skipIf(!ffmpeg)('generateSprite', () => {
  let dir: string
  let video: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vixel-sprite-'))
    video = join(dir, 'clip.mp4')
    // 6 秒 16:9 测试图：验证正方形裁切和格数
    execFileSync(ffmpeg!, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=6', '-pix_fmt', 'yuv420p', video])
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('tiles SPRITE_FRAMES square frames horizontally', async () => {
    const out = join(dir, 'a', 'sprite.jpg')
    await generateSprite(video, 6000, out)
    const meta = await sharp(out).metadata()
    expect(meta.width).toBe(SPRITE_TILE * SPRITE_FRAMES)
    expect(meta.height).toBe(SPRITE_TILE)
  }, 60_000)

  it('dedupes concurrent on-demand requests', async () => {
    const out = join(dir, 'b', 'sprite.jpg')
    const a = ensureSprite(video, 6000, out)
    expect(ensureSprite(video, 6000, out)).toBe(a)
    await a
  }, 60_000)

  it('rejects unknown duration', async () => {
    await expect(generateSprite(video, 0, join(dir, 'c.jpg'))).rejects.toThrow()
  })
})
