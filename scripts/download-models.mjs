#!/usr/bin/env node
/**
 * 模型下载脚本（开发 / CI 用）
 *
 * 下载 Vixel 所需的全部本地模型到 resources/models/：
 *
 *   resources/models/
 *     ├── siglip2/                          (~190 MB)  图文 CLIP
 *     └── paddleocr/                        (~12 MB)   OCR
 *         ├── ppocr_v5_det.onnx
 *         ├── ppocr_v5_rec.onnx
 *         ├── ppocr_v5_cls.onnx             (可选)
 *         └── ppocr_keys_v1.txt
 *
 * 用法：
 *   node scripts/download-models.mjs              # 全部
 *   node scripts/download-models.mjs siglip       # 仅 SigLIP 2
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

const MODEL_GROUPS = {
  // ─── 图文 CLIP ───────────────────────────────────────────────────
  siglip: {
    label: 'SigLIP 2 base/16-256 (multilingual)',
    targetDir: join(MODELS_ROOT, 'siglip2'),
    sources: [
      {
        baseUrl: `https://huggingface.co/${process.env.SIGLIP_REPO || 'onnx-community/siglip2-base-patch16-256'}/resolve/${process.env.SIGLIP_REVISION || 'main'}/`,
        files: [
          { path: 'config.json', optional: false },
          { path: 'tokenizer.json', optional: false },
          { path: 'tokenizer_config.json', optional: false },
          { path: 'preprocessor_config.json', optional: false },
          { path: 'special_tokens_map.json', optional: true },
          { path: 'onnx/model_quantized.onnx', optional: false },
          { path: 'onnx/model.onnx_data', optional: true },
        ],
      },
    ],
  },

  // ─── OCR ────────────────────────────────────────────────────────
  paddleocr: {
    label: 'PaddleOCR v5 (det + cls + rec + charset)',
    targetDir: join(MODELS_ROOT, 'paddleocr'),
    sources: [
      // RapidAI 维护着社区导出的 PaddleOCR ONNX 包，许可与 Paddle 上游一致 (Apache 2.0)。
      // 如官方仓库改名，可通过 PADDLEOCR_REPO 环境变量覆盖。
      {
        baseUrl: `https://huggingface.co/${process.env.PADDLEOCR_REPO || 'RapidAI/RapidOCR'}/resolve/${process.env.PADDLEOCR_REVISION || 'main'}/onnx/PP-OCRv5/`,
        files: [
          { path: 'ch_PP-OCRv5_det_infer.onnx', rename: 'ppocr_v5_det.onnx', optional: false },
          { path: 'ch_PP-OCRv5_rec_infer.onnx', rename: 'ppocr_v5_rec.onnx', optional: false },
          { path: 'ch_ppocr_mobile_v2.0_cls_infer.onnx', rename: 'ppocr_v5_cls.onnx', optional: true },
        ],
      },
      // PaddleOCR 上游的字符表（也可用社区镜像）
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
  const resp = await fetch(url)
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
