/**
 * 中文分词 helper —— 用于在写入/查询 FTS5 之前预切词。
 *
 * 为什么需要这个：
 *   FTS5 默认的 unicode61 tokenizer 对 CJK 按字符切（每个汉字一个 token），
 *   BM25 在中文上几乎失效。jieba 切出的是有语义的词。
 *
 * 策略：
 *   - ASCII / 拉丁字符：保持原样（按空格/标点切由 unicode61 处理）
 *   - CJK / 非 ASCII：连续段用 jieba 切，再用空格连接
 *   - 写入侧和查询侧都走这个函数，保证 token 一致
 *
 * 依赖：@node-rs/jieba（Rust 实现，带 prebuilt 二进制，无 node-gyp）
 * 懒加载：模块第一次被用到时才 require，启动不付代价。
 */

type JiebaModule = {
  cut: (text: string, hmm?: boolean) => string[]
  cutForSearch?: (text: string, hmm?: boolean) => string[]
}

let jiebaPromise: Promise<JiebaModule> | null = null

function loadJieba(): Promise<JiebaModule> {
  if (!jiebaPromise) {
    jiebaPromise = import('@node-rs/jieba').then((mod) => mod as unknown as JiebaModule)
  }
  return jiebaPromise
}

/** 是否包含 CJK / 全角符号等非 ASCII 字符 —— 决定是否走 jieba。 */
function hasCjk(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return true
  }
  return false
}

/**
 * 把一段文本切成空格分隔的 token 序列，供 FTS5 insert 或 query 使用。
 *
 * - 纯英文 / 数字：去掉多余空白即可
 * - 含 CJK：交给 jieba（search 模式，召回更广）
 *
 * 出错时退化为原文，保证 FTS5 至少能按字符匹配（虽然弱，但不会丢数据）。
 */
export async function tokenizeForFts(text: string): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed) return ''

  if (!hasCjk(trimmed)) {
    return trimmed.replace(/\s+/g, ' ')
  }

  try {
    const { cut, cutForSearch } = await loadJieba()
    const segs = (cutForSearch || cut)(trimmed, true)
    // 去掉空白纯白 token，保留中文标点（去标点会丢"销售/财务"这类带斜杠的细粒度）
    return segs
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/^\s+$/.test(s))
      .join(' ')
  } catch (err) {
    console.warn('jieba tokenize failed, falling back to raw text:', err)
    return trimmed
  }
}

/** 同步版本：仅用于已经预热过的场景。预热未完成时返回原文。 */
export function tokenizeForFtsSync(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  if (!hasCjk(trimmed)) return trimmed.replace(/\s+/g, ' ')

  // 同步路径用 require 兜底（CommonJS interop）
  try {
    // 用 eval 包一层避免被打包器静态分析时找不到模块
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@node-rs/jieba') as JiebaModule
    const segs = (mod.cutForSearch || mod.cut)(trimmed, true)
    return segs
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join(' ')
  } catch {
    return trimmed
  }
}

/** 预热（应用启动时调用一次，避免第一次写入时阻塞）。 */
export async function preloadJieba(): Promise<void> {
  try {
    await loadJieba()
  } catch (err) {
    console.warn('Failed to preload jieba (Chinese tokenization disabled):', err)
  }
}
