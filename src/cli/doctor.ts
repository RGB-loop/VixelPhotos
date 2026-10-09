/**
 * vixel doctor / vixel bench —— 不开界面就能定位慢在哪里。
 *
 *   doctor：库的体检。PRAGMA、各表行数、队列积压与失败原因、热点查询的执行计划
 *           （有没有走索引 / 有没有临时排序），以及一些一致性检查。
 *   bench ：在当前库上实测热点操作的耗时（网格分页、文件名 / 全文 / 向量检索、人物列表）。
 *
 * 只读打开，应用开着时也可以跑。
 */

import type { DatabaseInstance } from '../core/db'
import { SearchEngine } from '../core/search'
import { getEmbeddingService } from '../core/embedding'

type Flags = Record<string, string | boolean>

const count = (db: DatabaseInstance, sql: string): number =>
  ((db.raw.prepare(sql).get() as Record<string, number> | undefined) ?? {})['n'] ?? 0

/** 热点查询：与网格 / 搜索 / 人物页实际用的语句同形 */
const HOT_QUERIES: Array<{ name: string; sql: string; params: unknown[] }> = [
  {
    name: 'grid page (created_at)',
    sql: `SELECT p.id FROM photos p WHERE p.deleted_at IS NULL
          AND p.id = (SELECT MIN(p3.id) FROM photos p3 WHERE p3.file_hash = p.file_hash AND p3.deleted_at IS NULL)
          ORDER BY p.created_at DESC LIMIT 200 OFFSET 0`,
    params: [],
  },
  {
    name: 'grid page (taken_at)',
    sql: `SELECT p.id FROM photos p WHERE p.deleted_at IS NULL
          AND p.id = (SELECT MIN(p3.id) FROM photos p3 WHERE p3.file_hash = p.file_hash AND p3.deleted_at IS NULL)
          ORDER BY p.taken_at DESC, p.created_at DESC LIMIT 200 OFFSET 0`,
    params: [],
  },
  { name: 'queue next task', sql: `SELECT id FROM index_queue WHERE status = 'pending' ORDER BY priority DESC, id ASC LIMIT 1`, params: [] },
  { name: 'photos by hash', sql: `SELECT id FROM photos WHERE file_hash = ? AND deleted_at IS NULL`, params: [''] },
  { name: 'faces of person', sql: `SELECT id FROM faces WHERE person_id = ? ORDER BY quality DESC LIMIT 100`, params: [0] },
  { name: 'gps photos', sql: `SELECT id FROM photos WHERE lat IS NOT NULL AND lng IS NOT NULL AND deleted_at IS NULL`, params: [] },
]

function planOf(db: DatabaseInstance, sql: string, params: unknown[]): string[] {
  return (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail)
}

export function cmdDoctor(db: DatabaseInstance, dbPath: string, flags: Flags): void {
  const raw = db.raw
  const pragma = (name: string): unknown => raw.pragma(name, { simple: true })
  const report = {
    database: dbPath,
    pragmas: Object.fromEntries(
      ['journal_mode', 'synchronous', 'cache_size', 'mmap_size', 'page_size', 'page_count', 'freelist_count'].map((p) => [p, pragma(p)])
    ),
    counts: {
      photos: count(db, `SELECT COUNT(*) n FROM photos WHERE deleted_at IS NULL`),
      uniqueContent: count(db, `SELECT COUNT(DISTINCT file_hash) n FROM photos WHERE deleted_at IS NULL`),
      softDeletedPhotos: count(db, `SELECT COUNT(*) n FROM photos WHERE deleted_at IS NOT NULL`),
      videos: count(db, `SELECT COUNT(*) n FROM videos WHERE deleted_at IS NULL`),
      videoSegments: count(db, `SELECT COUNT(*) n FROM video_segments`),
      imageVectors: count(db, `SELECT COUNT(*) n FROM image_vec_map`),
      faces: count(db, `SELECT COUNT(*) n FROM faces`),
      people: count(db, `SELECT COUNT(*) n FROM people`),
    },
    queue: raw.prepare(`SELECT task_type as type, status, COUNT(*) as n FROM index_queue GROUP BY 1, 2 ORDER BY 1, 2`).all(),
    topErrors: raw.prepare(`
      SELECT task_type as type, substr(error_msg, 1, 120) as error, COUNT(*) as n
      FROM index_queue WHERE status = 'error' GROUP BY 1, 2 ORDER BY n DESC LIMIT 10
    `).all(),
    checks: {
      // 有存活照片却没向量的内容（排除音频封面）—— 不为 0 且队列空闲说明 embed 静默失败过
      contentWithoutVector: count(db, `
        SELECT COUNT(DISTINCT p.file_hash) n FROM photos p
        WHERE p.deleted_at IS NULL AND p.file_hash NOT IN (SELECT file_hash FROM image_vec_map)
          AND (p.video_id IS NULL OR p.video_id NOT IN (SELECT id FROM videos WHERE media_kind = 'audio'))`),
      // 向量映射里指向已无存活照片的 hash（GC 漏网）
      orphanVectors: count(db, `
        SELECT COUNT(*) n FROM image_vec_map m
        WHERE NOT EXISTS (SELECT 1 FROM photos p WHERE p.file_hash = m.file_hash AND p.deleted_at IS NULL)`),
      videosWithoutSegments: count(db, `
        SELECT COUNT(*) n FROM videos v WHERE v.deleted_at IS NULL AND v.duration_ms > 0
          AND NOT EXISTS (SELECT 1 FROM video_segments s WHERE s.video_id = v.id)`),
    },
    plans: [] as Array<{ query: string; ok: boolean; plan: string[] }>,
  }
  // 小库上规划器常选全扫 / 临时排序（几百行无所谓），只在库够大时才算问题
  const large = report.counts.photos >= 5000
  report.plans = HOT_QUERIES.map((q) => {
    const plan = planOf(db, q.sql, q.params)
    const warn = plan.some((l) => /TEMP B-TREE/.test(l)) || plan.some((l) => /^SCAN (\w+)$/.test(l))
    return { query: q.name, ok: !(warn && large), plan }
  })

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(`Database  ${report.database}`)
  console.log(`Pragmas   ${Object.entries(report.pragmas).map(([k, v]) => `${k}=${v}`).join('  ')}`)
  console.log('\nCounts')
  for (const [k, v] of Object.entries(report.counts)) console.log(`  ${k.padEnd(20)} ${v}`)
  console.log('\nQueue')
  for (const r of report.queue as Array<{ type: string; status: string; n: number }>) console.log(`  ${r.type.padEnd(16)} ${r.status.padEnd(11)} ${r.n}`)
  if (report.topErrors.length) {
    console.log('\nTop errors')
    for (const r of report.topErrors as Array<{ type: string; error: string; n: number }>) console.log(`  ${String(r.n).padStart(5)}  ${r.type.padEnd(14)} ${r.error}`)
  }
  console.log('\nChecks')
  for (const [k, v] of Object.entries(report.checks)) console.log(`  ${v === 0 ? '✓' : '!'} ${k.padEnd(22)} ${v}`)
  console.log('\nQuery plans')
  for (const p of report.plans) {
    console.log(`  ${p.ok ? '✓' : '!'} ${p.query}`)
    for (const l of p.plan) console.log(`      ${l}`)
  }
}

async function time<T>(fn: () => T | Promise<T>, runs: number): Promise<{ min: number; median: number; max: number }> {
  const ms: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    ms.push(performance.now() - t0)
  }
  ms.sort((a, b) => a - b)
  return { min: ms[0], median: ms[Math.floor(ms.length / 2)], max: ms[ms.length - 1] }
}

export async function cmdBench(db: DatabaseInstance, flags: Flags): Promise<void> {
  const runs = Number(flags.runs) || 5
  const queries = (typeof flags.query === 'string' ? flags.query : '海边,猫,receipt,2024').split(',')
  const engine = new SearchEngine(db)
  const total = count(db, `SELECT COUNT(*) n FROM photos WHERE deleted_at IS NULL`)
  const rows: Array<{ op: string; min: number; median: number; max: number }> = []
  const add = async (op: string, fn: () => unknown): Promise<void> => {
    rows.push({ op, ...(await time(fn, runs)) })
  }

  await add('grid page 1 (200)', () => db.getRepresentativePhotos(200, 0))
  await add('grid page deep (offset 50%)', () => db.getRepresentativePhotos(200, Math.floor(total / 2)))
  await add('library counts', () => db.getLibraryCounts())
  await add('photo stats (progress tick)', () => db.getPhotoStats())
  await add('people list', () => db.getPeople())
  await add('gps photos', () => db.getPhotosWithGPS())

  const embedder = getEmbeddingService()
  await embedder.init().catch(() => {})
  const semantic = embedder.isReady()
  for (const q of queries) {
    // 第一次含模型预热，单独记
    if (semantic) rows.push({ op: `search "${q}" (cold)`, ...(await time(() => engine.search(q, 50), 1)) })
    await add(`search "${q}"`, () => engine.search(q, 50))
  }
  const sample = db.getRepresentativePhotos(1, 0)[0]
  if (sample?.fileHash) await add('similar (vector KNN)', () => engine.findSimilar(sample.fileHash, 24))

  if (flags.json) {
    console.log(JSON.stringify({ photos: total, semantic, runs, results: rows }, null, 2))
    return
  }
  console.log(`Library: ${total} photos · semantic search ${semantic ? 'on' : 'OFF (model unavailable — text/filename only)'} · ${runs} runs each\n`)
  console.log(`  ${'operation'.padEnd(34)} ${'min'.padStart(8)} ${'median'.padStart(8)} ${'max'.padStart(8)}`)
  for (const r of rows) {
    const f = (n: number): string => `${n.toFixed(1)}ms`.padStart(8)
    const flag = r.median > 100 ? '  ← slow' : ''
    console.log(`  ${r.op.padEnd(34)} ${f(r.min)} ${f(r.median)} ${f(r.max)}${flag}`)
  }
}
