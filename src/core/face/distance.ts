/**
 * 人脸距离换算 —— sqlite-vec 返回 L2 距离，但我们历史阈值用的是 cosine。
 * 抽出来作为纯函数便于单测，避免 face/index.ts 在不同分支重写公式。
 *
 * 推导（对 L2 归一化向量 a, b）：
 *   ||a - b||² = ||a||² + ||b||² - 2(a·b) = 2 - 2·cos(a, b)
 *   ⇒ cos_distance = 1 - cos(a, b) = ||a - b||² / 2
 *   ⇒ cos_distance = (L2)² / 2
 *
 * 关键前提：a 和 b 都是 L2 归一化的（||·|| = 1）。如果模型输出未归一化，
 * 这个公式给出的不是真正的 cosine 距离 —— 写测试时构造的向量都已归一化。
 */
export function l2ToCosineDistance(l2Distance: number): number {
  return (l2Distance * l2Distance) / 2
}

/** dot 产品（CPU），用于测试和兜底分支 */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/** 真正的 L2 距离：sqrt(sum((a_i - b_i)^2))，仅测试与兜底用 */
export function l2Distance(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i]
    s += d * d
  }
  return Math.sqrt(s)
}

/** L2 归一化（返回新数组，不就地改） */
export function l2Normalize(v: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm)
  if (norm === 0) return new Float32Array(v)
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm
  return out
}
