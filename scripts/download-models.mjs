#!/usr/bin/env node
/**
 * 模型下载脚本（开发 / CI 用）
 *
 * 下载 Vixel 所需的全部本地模型到 resources/models/：
 *
 *   resources/models/
 *     ├── gemma2/                           (~620 MB)  多模态 embedding（文本/图像/音频/视频）
 *     └── paddleocr/                        (~12 MB)   OCR
 *         ├── ppocr_v5_det.onnx
 *         ├── ppocr_v5_rec.onnx
 *         ├── ppocr_v5_cls.onnx             (可选)
 *         └── ppocr_keys_v1.txt
 *
 * 用法：
 *   node scripts/download-models.mjs              # 全部
 *   node scripts/download-models.mjs gemma2       # 仅 EmbeddingGemma 2
 *   node scripts/download-models.mjs paddleocr    # 仅 PaddleOCR
 */

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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
  // EmbeddingGemma 2: 文本/图像/音频/视频统一嵌入空间，768 维
  // 仓库：onnx-community/embeddinggemma-2-ONNX
  // 量化档位：文本/视觉 q4 (284MB)，音频 q8 (340MB，官方建议)
  gemma2: {
    label: 'EmbeddingGemma 2 (text/image/audio/video, 768D)',
    targetDir: join(MODELS_ROOT, 'gemma2'),
    sources: [
      {
        baseUrl: `https://huggingface.co/${process.env.GEMMA2_REPO || 'onnx-community/embeddinggemma-2-ONNX'}/resolve/${process.env.GEMMA2_REVISION || 'main'}/`,
        files: [
          { path: 'config.json', optional: false },
          { path: 'tokenizer.json', optional: false },
          { path: 'tokenizer_config.json', optional: false },
          { path: 'preprocessor_config.json', optional: false },
          { path: 'processor_config.json', optional: false },
          { path: 'chat_template.jinja', optional: true },
          // 文件名须与 transformers.js 的 session 名 + dtype 后缀一致：
          //   session: model / vision_encoder / audio_encoder
          //   后缀: q4 → _q4, q8 → _quantized
          // 权重在 .onnx_data 外部数据文件里（config.json 的 use_external_data_format），必需。
          // 文本编码器（q4）
          { path: 'onnx/model_q4.onnx', optional: false },
          { path: 'onnx/model_q4.onnx_data', optional: false },
          // 视觉编码器（q4）
          { path: 'onnx/vision_encoder_q4.onnx', optional: false },
          { path: 'onnx/vision_encoder_q4.onnx_data', optional: false },
          // 音频编码器（q8）
          { path: 'onnx/audio_encoder_quantized.onnx', optional: false },
          { path: 'onnx/audio_encoder_quantized.onnx_data', optional: false },
        ],
      },
    ],
  },

  // ─── OCR ────────────────────────────────────────────────────────
  // Aquamarinex/PP-OCRv5-onnx 提供 mobile det + rec（无 cls；cls 是可选项）。
  // 字符表 ppocr_keys_v1.txt 走 GitHub raw —— PaddleOCR 上游维护。
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
        baseUrl: 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/release/2.7/ppocr/utils/',
        files: [
          { path: 'ppocr_keys_v1.txt', optional: false },
        ],
      },
    ],
  },
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
      const target = join(group.targetDir, targetName.includes('/') ? targetName.split('/').pop() : targetName)
      try {
        await downloadFile(url, target, file.optional === true)
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
  const targets = args.length > 0 ? args : Object.keys(MODEL_GROUPS)

  console.log(`${colors.green}Vixel model downloader${colors.reset}`)
  console.log(`  target groups: ${targets.join(', ')}`)

  let allOk = true
  for (const t of targets) {
    const ok = await downloadGroup(t)
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
