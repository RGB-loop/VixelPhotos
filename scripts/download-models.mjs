#!/usr/bin/env node
/**
 * 模型下载脚本（开发 / CI 用）
 *
 * 下载 Vixel 所需的全部本地模型和推理运行时：
 *
 *   resources/models/
 *     ├── litert/embeddinggemma-2-740m.litertlm   (~465 MB)  多模态 embedding（文本/图像/音频/视频）
 *     └── paddleocr/                        (~12 MB)   OCR
 *         ├── ppocr_v5_det.onnx
 *         ├── ppocr_v5_rec.onnx
 *         ├── ppocr_v5_cls.onnx             (可选)
 *         └── ppocrv5_dict.txt
 *
 * 用法：
 *   resources/litert/<platform>-<arch>/          LiteRT-LM 原生库（来自 litert-lm-api wheel）
 *
 * 用法：
 *   node scripts/download-models.mjs                     # 全部（运行时取当前平台）
 *   node scripts/download-models.mjs litert              # 仅 EmbeddingGemma 2（LiteRT 模型）
 *   node scripts/download-models.mjs litert-runtime      # 仅 LiteRT-LM 原生库
 *   LITERT_PLATFORM=win32-x64 node scripts/download-models.mjs litert-runtime   # 给别的平台打包
 *   node scripts/download-models.mjs paddleocr           # 仅 PaddleOCR
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')
const MODELS_ROOT = join(ROOT, 'resources', 'models')

const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
}

// HF token —— 部分网络环境匿名访问被风控，提供 HF_TOKEN 可绕过。
// 设置后所有 huggingface.co 请求自动带 Authorization 头；非 HF URL 不受影响。
const HF_TOKEN = process.env.HF_TOKEN || ''

const MODEL_GROUPS = {
  // ─── 多模态 Embedding ─────────────────────────────────────────
  // EmbeddingGemma 2（LiteRT-LM 官方转换，int4/int8 QAT）：文本/图像/音频/视频统一嵌入空间，768 维
  // 仓库：litert-community/embeddinggemma-2-740m-litert-lm（Apache-2.0，无需登录）；固定 revision 保证可复现
  litert: {
    label: 'EmbeddingGemma 2 · LiteRT (text/image/audio/video, 768D)',
    targetDir: join(MODELS_ROOT, 'litert'),
    sources: [
      {
        baseUrl: `https://huggingface.co/litert-community/embeddinggemma-2-740m-litert-lm/resolve/${process.env.LITERT_MODEL_REVISION || '24d962e906c7d332c6428e71c9676855024569e2'}/`,
        files: [
          { path: 'embeddinggemma-2-740m.litertlm', optional: false, sha256: 'e7a8a2204b91e0f96e92960e84a09a89212e1633dcb7575a9bf3378b4df77f4c' },
        ],
      },
    ],
  },

  // ─── OCR ────────────────────────────────────────────────────────
  // Aquamarinex/PP-OCRv5-onnx 提供 mobile det + rec（无 cls；cls 是可选项）。
  // 字符表 ppocrv5_dict.txt 走 GitHub raw —— PaddleOCR 上游维护。
  // 注意必须和 rec 模型同版本：v5 rec 输出 18385 类，旧的 ppocr_keys_v1.txt 只有 6622 字，
  // 混用时每个字都会映射错（识别结果全是乱码、置信度 ~0，被过滤成空文本）。
  paddleocr: {
    label: 'PaddleOCR v5 (det + rec + charset; cls optional)',
    targetDir: join(MODELS_ROOT, 'paddleocr'),
    sources: [
      {
        baseUrl: `https://huggingface.co/${process.env.PADDLEOCR_REPO || 'Aquamarinex/PP-OCRv5-onnx'}/resolve/${process.env.PADDLEOCR_REVISION || 'main'}/`,
        files: [
          { path: 'PP-OCRv5_mobile_det/inference.onnx', rename: 'ppocr_v5_det.onnx', optional: false },
          { path: 'PP-OCRv5_mobile_rec/inference.onnx', rename: 'ppocr_v5_rec.onnx', optional: false },
        ],
      },
      // PaddleOCR 上游的字符表（GitHub raw，无 HF 风控问题）
      {
        baseUrl: 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/',
        files: [
          { path: 'ppocrv5_dict.txt', optional: false },
        ],
      },
    ],
  },
}

// ─── LiteRT-LM 原生库 ─────────────────────────────────────────────
// litert-lm-api 是 Google 发布的 C API 包（py3-none：wheel 里只有原生库，不含 Python）。
// 只解压原生库到 resources/litert/<platform>-<arch>/，Electron 经 koffi 加载。
// 换版本时同时更新 url / sha256，并核对 wheel 里 _ffi.py 的函数签名（src/core/embedding/providers/litert/native.ts）
const LITERT_RUNTIME_VERSION = '0.18.0'
const LITERT_RUNTIMES = {
  'darwin-arm64': {
    url: 'https://files.pythonhosted.org/packages/cc/df/147e5fa60cf8964bdcbc022cbd38502f91ea415bf82bed2c9335fcf9be9d/litert_lm_api-0.18.0-py3-none-macosx_12_0_arm64.whl',
    sha256: '9fd0c55835e469a035c1b75cde4797b26292963c2c36d9fcdfceb965ffa08a37',
    files: ['liblitert-lm.dylib'],
  },
  // GPU 走 WebGPU → D3D12，需要同目录的 DirectX 着色器编译器（dxcompiler / dxil）
  'win32-x64': {
    url: 'https://files.pythonhosted.org/packages/2e/a4/842c858a90aac25a2ae6e4744197b22764a38fb35e45b15cf9c3b7570656/litert_lm_api-0.18.0-py3-none-win_amd64.whl',
    sha256: 'eb02dc5d0fc6a894a664cfcc63e3aaf3100973ba2c9a6a7eebf4df8749a01038',
    files: ['litert-lm.dll', 'dxcompiler.dll', 'dxil.dll'],
  },
  'linux-x64': {
    url: 'https://files.pythonhosted.org/packages/c9/8f/eb7a5203be1d48440c6b8d6e6382c3f744dd6d338fe400555718b4d695a1/litert_lm_api-0.18.0-py3-none-manylinux_2_27_x86_64.whl',
    sha256: 'b64e2cf6d7dcb90ff094b74af595cc5d53faa07e0889f967d15df8d3e696b53c',
    files: ['liblitert-lm.so'],
  },
}

async function sha256Of(path) {
  const hash = createHash('sha256')
  await new Promise((res, rej) => createReadStream(path).on('data', (d) => hash.update(d)).on('end', res).on('error', rej))
  return hash.digest('hex')
}

async function downloadLiteRtRuntime() {
  const platform = process.env.LITERT_PLATFORM || `${process.platform}-${process.arch}`
  const spec = LITERT_RUNTIMES[platform]
  console.log(`\n${colors.green}▸ LiteRT-LM runtime ${LITERT_RUNTIME_VERSION} (${platform})${colors.reset}`)
  if (!spec) {
    console.error(`${colors.red}  no LiteRT-LM runtime for ${platform} (available: ${Object.keys(LITERT_RUNTIMES).join(', ')})${colors.reset}`)
    return false
  }
  const targetDir = join(ROOT, 'resources', 'litert', platform)
  if (spec.files.every((f) => existsSync(join(targetDir, f)))) {
    console.log(`${colors.dim}✓ ${spec.files.join(', ')} (cached)${colors.reset}`)
    return true
  }
  const wheel = join(tmpdir(), basename(new URL(spec.url).pathname))
  await rm(wheel, { force: true })
  await downloadFile(spec.url, wheel, false)
  const actual = await sha256Of(wheel)
  if (actual !== spec.sha256) {
    console.error(`${colors.red}  sha256 mismatch for ${basename(wheel)}: ${actual}${colors.reset}`)
    return false
  }
  // wheel 就是 zip；macOS / Windows 10+ 自带的 bsdtar 都能解
  const extractDir = join(tmpdir(), `litert-runtime-${platform}`)
  await rm(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  const r = spawnSync('tar', ['-xf', wheel, '-C', extractDir, ...spec.files.map((f) => `litert_lm/${f}`)], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`${colors.red}  failed to extract ${basename(wheel)}${colors.reset}`)
    return false
  }
  mkdirSync(targetDir, { recursive: true })
  for (const f of spec.files) await rename(join(extractDir, 'litert_lm', f), join(targetDir, f))
  await rm(wheel, { force: true })
  console.log(`${colors.green}  ✓ ${spec.files.join(', ')} → ${targetDir}${colors.reset}`)
  return true
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let val = bytes / 1024
  let i = 0
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(1)} ${units[i]}`
}

async function downloadFile(url, target, optional) {
  const tempPath = target + '.tmp'
  mkdirSync(dirname(target), { recursive: true })

  if (existsSync(target)) {
    const size = statSync(target).size
    process.stdout.write(`${colors.dim}✓ ${target.replace(MODELS_ROOT + '/', '')} (cached, ${fmtSize(size)})${colors.reset}\n`)
    return true
  }

  process.stdout.write(`${colors.cyan}↓ ${target.replace(MODELS_ROOT + '/', '')}${colors.reset}\n`)
  // 仅对 huggingface.co 主机带 token；GitHub raw 等不会泄露
  const headers = {}
  if (HF_TOKEN && url.includes('huggingface.co')) {
    headers['Authorization'] = `Bearer ${HF_TOKEN}`
  }
  const resp = await fetch(url, { headers, redirect: 'follow' })
  if (!resp.ok) {
    if (optional && (resp.status === 404 || resp.status === 403)) {
      process.stdout.write(`${colors.dim}  (optional, skipped: ${resp.status})${colors.reset}\n`)
      return true
    }
    throw new Error(`HTTP ${resp.status} for ${url}`)
  }

  const total = parseInt(resp.headers.get('content-length') || '0', 10)
  const reader = resp.body.getReader()
  const out = createWriteStream(tempPath)
  let downloaded = 0
  let lastReport = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out.write(value)
    downloaded += value.length
    const now = Date.now()
    if (total > 0 && now - lastReport > 500) {
      const pct = ((downloaded / total) * 100).toFixed(1)
      process.stdout.write(`\r  ${fmtSize(downloaded)} / ${fmtSize(total)}  (${pct}%)   `)
      lastReport = now
    }
  }
  out.end()
  await new Promise((res, rej) => { out.on('finish', res); out.on('error', rej) })
  process.stdout.write('\n')
  await rename(tempPath, target)
  return true
}

async function downloadGroup(groupKey) {
  const group = MODEL_GROUPS[groupKey]
  if (!group) {
    console.error(`${colors.red}Unknown group: ${groupKey}${colors.reset}`)
    return false
  }

  console.log(`\n${colors.green}▸ ${group.label}${colors.reset}`)
  console.log(`  ${colors.dim}→ ${group.targetDir}${colors.reset}`)

  mkdirSync(group.targetDir, { recursive: true })

  let ok = true
  for (const source of group.sources) {
    for (const file of source.files) {
      const url = source.baseUrl + file.path
      const targetName = file.rename || file.path
      const target = join(group.targetDir, group.preserveSubdirs ? targetName : targetName.split('/').pop())
      mkdirSync(dirname(target), { recursive: true })
      try {
        await downloadFile(url, target, file.optional === true)
        if (file.sha256 && existsSync(target) && (await sha256Of(target)) !== file.sha256) {
          await rm(target, { force: true })
          throw new Error('sha256 mismatch (file removed, re-run to download again)')
        }
      } catch (err) {
        if (file.optional) {
          console.warn(`${colors.yellow}  warn: ${file.path} skipped (${err.message})${colors.reset}`)
        } else {
          console.error(`${colors.red}  fail: ${file.path} - ${err.message}${colors.reset}`)
          try { await rm(target + '.tmp', { force: true }) } catch {}
          ok = false
        }
      }
    }
  }
  return ok
}

async function main() {
  const args = process.argv.slice(2)
  const targets = args.length > 0 ? args : [...Object.keys(MODEL_GROUPS), 'litert-runtime']

  console.log(`${colors.green}Vixel model downloader${colors.reset}`)
  console.log(`  target groups: ${targets.join(', ')}`)

  let allOk = true
  for (const t of targets) {
    const ok = t === 'litert-runtime' ? await downloadLiteRtRuntime() : await downloadGroup(t)
    if (!ok) allOk = false
  }

  if (allOk) {
    console.log(`\n${colors.green}✓ all done${colors.reset}`)
  } else {
    console.error(`\n${colors.red}some downloads failed${colors.reset}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`${colors.red}fatal: ${err.message}${colors.reset}`)
  process.exit(1)
})
