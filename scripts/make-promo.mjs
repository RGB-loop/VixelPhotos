/**
 * 宣传片合成：录屏（VIXEL_RECORD 产出的 raw.mp4 + raw.mp4.timeline.json）
 *   → 片头（图标 + 一句话）+ 每个场景的下三分之一字幕 + 片尾（隐私承诺）→ 1080p mp4。
 *
 *   node scripts/make-promo.mjs <raw.mp4> <out.mp4>
 *
 * 字幕和卡片都用系统中文字体渲染（macOS：Hiragino Sans GB）。
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static')
const sharp = require('sharp')

const [raw, out] = process.argv.slice(2)
if (!raw || !out) { console.error('usage: node scripts/make-promo.mjs <raw.mp4> <out.mp4>'); process.exit(1) }
const timeline = JSON.parse(readFileSync(`${raw}.timeline.json`, 'utf8'))
const FONT = process.env.PROMO_FONT || '/System/Library/Fonts/Hiragino Sans GB.ttc'
const W = 1920, H = 1080, FPS = 30, XF = 0.6
const tmp = mkdtempSync(join(tmpdir(), 'vixel-promo-'))
const run = (args) => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`)
}

// ── 片头 / 片尾卡片（SVG → PNG）──────────────────────────────────────────
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const card = async (lines, file, withIcon) => {
  const icon = withIcon ? await sharp('build/icon.png').resize(260).png().toBuffer() : null
  const top = withIcon ? 560 : 430
  const text = lines.map((l, i) =>
    `<text x="960" y="${top + i * (l.size + 34)}" text-anchor="middle" font-family="Hiragino Sans GB, PingFang SC" font-size="${l.size}" font-weight="${l.weight ?? 400}" fill="${l.color ?? '#F2EDE6'}">${esc(l.text)}</text>`).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><radialGradient id="g" cx="0.5" cy="0.42" r="0.75"><stop offset="0" stop-color="#232637"/><stop offset="1" stop-color="#0B0C11"/></radialGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>${text}</svg>`
  let img = sharp(Buffer.from(svg))
  if (icon) img = img.composite([{ input: icon, left: (W - 260) / 2, top: 200 }])
  await img.png().toFile(file)
}
await card([
  { text: 'Vixel', size: 120, weight: 600 },
  { text: '用一句话，找到照片和视频里的那一刻', size: 54, color: '#D9B48A' },
], join(tmp, 'intro.png'), true)
await card([
  { text: '完全离线 · 数据不出设备', size: 76, weight: 600 },
  { text: '模型在你的 Mac 上运行，不上传、不需要账号', size: 44, color: '#C9C2B8' },
  { text: '开源 · github.com/RGB-loop/VixelPhotos', size: 40, color: '#D9B48A' },
], join(tmp, 'outro.png'), false)

const still = (png, secs, file) =>
  run(['-loop', '1', '-t', String(secs), '-i', png, '-vf', `fps=${FPS},format=yuv420p,fade=in:st=0:d=0.5`, '-c:v', 'libx264', '-crf', '16', file])
still(join(tmp, 'intro.png'), 3.4, join(tmp, 'intro.mp4'))
still(join(tmp, 'outro.png'), 4.4, join(tmp, 'outro.mp4'))

// ── 主体：缩放到 1080p + 每个场景的字幕（淡入淡出）────────────────────────
const captions = timeline.map((s) => {
  const a = s.start + 0.3, b = s.end - 0.2
  const alpha = `if(lt(t,${a}),0,if(lt(t,${a + 0.35}),(t-${a})/0.35,if(lt(t,${b - 0.35}),1,if(lt(t,${b}),(${b}-t)/0.35,0))))`
  const textFile = join(tmp, `cap-${s.name}.txt`)
  writeFileSync(textFile, s.caption)
  return `drawtext=fontfile='${FONT}':textfile='${textFile}':fontsize=46:fontcolor=white:alpha='${alpha}'` +
    `:box=1:boxcolor=black@0.55:boxborderw=26:x=(w-text_w)/2:y=h-150`
}).join(',')
run(['-i', raw, '-vf', `scale=${W}:${H}:flags=lanczos,${captions},format=yuv420p`, '-r', String(FPS), '-c:v', 'libx264', '-crf', '17', '-preset', 'slow', join(tmp, 'main.mp4')])

// ── 拼接：片头 → 主体 → 片尾，交叉淡化 ───────────────────────────────────
const dur = (f) => {
  const r = spawnSync(ffmpeg, ['-i', f], { encoding: 'utf8' })
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr)
  return +m[1] * 3600 + +m[2] * 60 + +m[3]
}
const dIntro = dur(join(tmp, 'intro.mp4')), dMain = dur(join(tmp, 'main.mp4'))
run(['-i', join(tmp, 'intro.mp4'), '-i', join(tmp, 'main.mp4'), '-i', join(tmp, 'outro.mp4'), '-filter_complex',
  `[0][1]xfade=transition=fade:duration=${XF}:offset=${dIntro - XF}[a];[a][2]xfade=transition=fade:duration=${XF}:offset=${dIntro + dMain - 2 * XF}[v]`,
  '-map', '[v]', '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out])
console.log(`promo → ${out} (${dur(out).toFixed(1)}s)`)
