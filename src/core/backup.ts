/**
 * library.db 备份的纯函数 helpers。
 *
 * 真正的 fs / SQLite 操作在 db.ts 的 backupTo() 和 main 的 scheduler；
 * 这里只负责：
 *   1. 给文件起名（包含时间戳，可排序）
 *   2. 决定一组备份里哪些是该清理的（保留最新 N 份）
 *
 * 抽出来便于单测，也让"未来想换文件名/换策略"时改一处即可。
 */

const PREFIX = 'library.db.bak.'

/**
 * 备份文件命名：`library.db.bak.<ISO 时间戳无冒号>`
 *   library.db.bak.20260522T140530Z
 *
 * 用 UTC ISO 字符串去掉冒号和毫秒，文件名安全 + 词典序 == 时间序。
 */
export function formatBackupName(date: Date): string {
  // 2026-05-22T14:05:30.123Z → 20260522T140530Z
  const iso = date.toISOString()
  const compact = iso
    .replace(/[-:.]/g, '')
    .replace(/\d{3}Z$/, 'Z') // drop millis
  return `${PREFIX}${compact}`
}

/**
 * 判断文件名是不是备份文件（用于过滤同目录下其它无关文件）。
 */
export function isBackupName(name: string): boolean {
  return name.startsWith(PREFIX)
}

/**
 * 给一组备份文件名（同目录下），返回哪些应当被删除以保留最新 `keep` 份。
 *
 * - 输入不需要预排序；返回值不保证顺序
 * - keep < 1 视作 1（永远至少保留最新一份）
 * - 不是备份命名的条目忽略（不会被推荐删除，但也不会被计入）
 */
export function selectExpired(names: string[], keep: number): string[] {
  const k = Math.max(1, keep)
  const backups = names.filter(isBackupName).slice() // copy
  if (backups.length <= k) return []
  // 词典序降序就是时间倒序（因为 formatBackupName 的设计）
  backups.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  return backups.slice(k)
}
