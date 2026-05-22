#!/usr/bin/env node
/**
 * 模型下载脚本（开发 / CI 用）
 *
 * 从 Hugging Face 下载 SigLIP 2 ONNX 权重到 resources/models/siglip2/
 *
 * 用法：
 *   node scripts/download-models.mjs
 *
 * 模型来源：onnx-community/siglip2-base-patch16-256
 *   - 多语言（含中日韩英）
 *   - 视觉 + 文本编码器同空间
 *   - q8 量化 ONNX：~190 MB
 *
 * 备选：若上述仓库不可用，可改为
 *   - Xenova/siglip-base-patch16-256-multilingual (v1, 仍然可用)
 *   - onnx-community/clip-vit-base-patch16 (英文为主)
 */

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')

const HF_REPO = process.env.SIGLIP_REPO || 'onnx-community/siglip2-base-patch16-256'
const HF_REVISION = process.env.SIGLIP_REVISION || 'main'
const TARGET_DIR = join(ROOT, 'resources', 'models', 'siglip2')

// Transformers.js 期望的最小文件集
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'preprocessor_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx',
  'onnx/model.onnx_data',     // 大模型可能拆分到 .onnx_data 文件
]

// 这些文件可能不存在（视具体导出而定），缺失不视作错误
const OPTIONAL = new Set([
  'special_tokens_map.json',
  'onnx/model.onnx_data',
])

const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
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

async function downloadFile(relPath) {
  const url = `https://huggingface.co/${HF_REPO}/resolve/${HF_REVISION}/${relPath}`
  const target = join(TARGET_DIR, relPath)
  const tempPath = target + '.tmp'

  mkdirSync(dirname(target), { recursive: true })

  if (existsSync(target)) {
    const size = statSync(target).size
    process.stdout.write(`${colors.dim}✓ ${relPath} (cached, ${fmtSize(size)})${colors.reset}\n`)
    return
  }

  process.stdout.write(`${colors.cyan}↓ ${relPath}${colors.reset} ${colors.dim}from ${HF_REPO}${colors.reset}\n`)

  const resp = await fetch(url)
  if (!resp.ok) {
    if (OPTIONAL.has(relPath) && resp.status === 404) {
      process.stdout.write(`${colors.dim}  (optional, skipped: ${resp.status})${colors.reset}\n`)
      return
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
}

async function main() {
  console.log(`${colors.green}Downloading SigLIP 2 model${colors.reset}`)
  console.log(`  repo:     ${HF_REPO}`)
  console.log(`  revision: ${HF_REVISION}`)
  console.log(`  target:   ${TARGET_DIR}\n`)

  mkdirSync(TARGET_DIR, { recursive: true })

  for (const file of FILES) {
    try {
      await downloadFile(file)
    } catch (err) {
      const optional = OPTIONAL.has(file)
      if (optional) {
        console.warn(`${colors.yellow}  warn: ${file} skipped (${err.message})${colors.reset}`)
      } else {
        console.error(`${colors.red}  fail: ${file} - ${err.message}${colors.reset}`)
        try { await rm(join(TARGET_DIR, file + '.tmp'), { force: true }) } catch {}
        process.exit(1)
      }
    }
  }

  console.log(`\n${colors.green}✓ done${colors.reset}`)
}

main().catch((err) => {
  console.error(`${colors.red}fatal: ${err.message}${colors.reset}`)
  process.exit(1)
})
