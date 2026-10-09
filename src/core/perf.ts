/**
 * 性能诊断：环境变量 VIXEL_PROFILE=1 打开（CLI 加 --profile 同效）。
 *
 *   [perf] ipc   search                 182.4ms
 *   [perf] sql   getRepresentativePhotos  38.2ms
 *   [perf] loop  main event loop blocked 412ms
 *
 * 关着时所有包装都是直通，零开销。打开后超过阈值的才打印，
 * 同时进环形缓冲（最近 500 条），`perfSnapshot()` 汇总给 doctor / 调试面板。
 */

export const PROFILE = process.env.VIXEL_PROFILE === '1'

/** 超过这些阈值才打印：主进程同步工作 > 16ms 就会掉一帧 */
const THRESHOLD_MS: Record<PerfKind, number> = { sql: 8, ipc: 16, proto: 16, infer: 2000, loop: 50, task: 0 }

export type PerfKind = 'sql' | 'ipc' | 'proto' | 'infer' | 'loop' | 'task'

interface Sample { kind: PerfKind; name: string; ms: number; at: number }

const RING_SIZE = 500
const ring: Sample[] = []

export function record(kind: PerfKind, name: string, ms: number): void {
  if (!PROFILE) return
  ring.push({ kind, name, ms, at: Date.now() })
  if (ring.length > RING_SIZE) ring.shift()
  if (ms >= THRESHOLD_MS[kind]) console.log(`[perf] ${kind.padEnd(5)} ${name.padEnd(28)} ${ms.toFixed(1)}ms`)
}

/** 计时同步或异步函数；关闭时直接返回 fn 本身 */
export function timed<A extends unknown[], R>(kind: PerfKind, name: string, fn: (...args: A) => R): (...args: A) => R {
  if (!PROFILE) return fn
  return (...args: A): R => {
    const t0 = performance.now()
    const out = fn(...args)
    if (out instanceof Promise) {
      return out.finally(() => record(kind, name, performance.now() - t0)) as R
    }
    record(kind, name, performance.now() - t0)
    return out
  }
}

/**
 * 给 better-sqlite3 的 prepared statement 表加计时：run / get / all 超阈值就打印语句名。
 * 关闭时原样返回。
 */
export function instrumentStatements<T extends Record<string, unknown>>(stmts: T): T {
  if (!PROFILE) return stmts
  for (const [name, stmt] of Object.entries(stmts)) {
    const s = stmt as Record<string, unknown>
    if (!s || typeof s.run !== 'function') continue
    for (const m of ['run', 'get', 'all'] as const) {
      const orig = (s[m] as (...a: unknown[]) => unknown).bind(s)
      s[m] = timed('sql', name, orig)
    }
  }
  return stmts
}

/**
 * 事件循环卡顿监测：定时器实际触发比预期晚多少，就说明循环被同步工作占了多久。
 * 返回停止函数。
 */
export function watchEventLoop(label: string, describe?: () => string | undefined): () => void {
  if (!PROFILE) return () => {}
  const INTERVAL = 200
  let expected = performance.now() + INTERVAL
  const timer = setInterval(() => {
    const now = performance.now()
    const lag = now - expected
    expected = now + INTERVAL
    if (lag >= THRESHOLD_MS.loop) {
      const ctx = describe?.()
      record('loop', `${label} blocked${ctx ? ` (${ctx})` : ''}`, lag)
    }
  }, INTERVAL)
  timer.unref?.()
  return () => clearInterval(timer)
}

export interface PerfSummary { kind: PerfKind; name: string; count: number; p50: number; p95: number; max: number }

/** 按 kind+name 汇总环形缓冲：p50 / p95 / max，按 p95 降序 */
export function perfSnapshot(): PerfSummary[] {
  const groups = new Map<string, Sample[]>()
  for (const s of ring) {
    const key = `${s.kind}\u0000${s.name}`
    let g = groups.get(key)
    if (!g) groups.set(key, (g = []))
    g.push(s)
  }
  const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  return [...groups.values()]
    .map((g) => {
      const ms = g.map((s) => s.ms).sort((a, b) => a - b)
      return { kind: g[0].kind, name: g[0].name, count: g.length, p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: ms[ms.length - 1] }
    })
    .sort((a, b) => b.p95 - a.p95)
}
