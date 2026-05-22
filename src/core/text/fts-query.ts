/**
 * 用户 query → FTS5 MATCH 表达式。
 *
 * - 经 jieba 切词（保证与写入侧 token 边界一致）
 * - 过滤 FTS5 语法保留字符与关键字（NEAR / AND / OR / NOT）
 *   避免输入 `iPhone-15` 或 `a NEAR b` 时炸 FTS5 syntax
 * - 每个 token 用双引号包裹，OR 拼接
 */

import { tokenizeForFtsSync } from './tokenize'

export function buildFtsQuery(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const tokenized = tokenizeForFtsSync(trimmed)
  const tokens = tokenized
    .split(/\s+/)
    .map((t) =>
      t
        .replace(/["()*+:<>{}^~-]/g, '')
        .replace(/^(NEAR|AND|OR|NOT)$/i, '')
        .trim()
    )
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return ''
  return tokens.map((t) => `"${t}"`).join(' OR ')
}
