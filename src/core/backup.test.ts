import { describe, it, expect } from 'vitest'
import { formatBackupName, isBackupName, selectExpired } from './backup'

describe('formatBackupName', () => {
  it('emits filesystem-safe, sortable compact ISO timestamps', () => {
    const d = new Date('2026-05-22T14:05:30.123Z')
    const name = formatBackupName(d)
    expect(name).toBe('library.db.bak.20260522T140530Z')
    // 时间戳部分（前缀之后）不含冒号 / 点 / 短横
    const stamp = name.replace(/^library\.db\.bak\./, '')
    expect(stamp).not.toMatch(/[:.\-]/)
  })

  it('词典序就是时间序', () => {
    const a = formatBackupName(new Date('2026-01-01T00:00:00Z'))
    const b = formatBackupName(new Date('2026-05-22T14:05:30Z'))
    const c = formatBackupName(new Date('2026-12-31T23:59:59Z'))
    expect([c, a, b].sort()).toEqual([a, b, c])
  })
})

describe('isBackupName', () => {
  it('recognizes valid backup file names', () => {
    expect(isBackupName('library.db.bak.20260522T140530Z')).toBe(true)
  })
  it('rejects unrelated files', () => {
    expect(isBackupName('library.db')).toBe(false)
    expect(isBackupName('library.db-wal')).toBe(false)
    expect(isBackupName('thumbnails')).toBe(false)
    expect(isBackupName('something.bak.20260522')).toBe(false)
  })
})

describe('selectExpired', () => {
  const a = 'library.db.bak.20260101T000000Z'
  const b = 'library.db.bak.20260201T000000Z'
  const c = 'library.db.bak.20260301T000000Z'
  const d = 'library.db.bak.20260401T000000Z'

  it('returns [] when count is at or below keep', () => {
    expect(selectExpired([a], 3)).toEqual([])
    expect(selectExpired([a, b, c], 3)).toEqual([])
  })

  it('returns the oldest entries beyond keep', () => {
    const expired = selectExpired([a, b, c, d], 3)
    expect(expired).toEqual([a])
  })

  it('handles unsorted input', () => {
    const expired = selectExpired([c, a, d, b], 2)
    // keep 2 newest = [d, c]; expired = [a, b]
    expect(expired.sort()).toEqual([a, b].sort())
  })

  it('keep < 1 is clamped to 1 (never delete everything)', () => {
    const expired = selectExpired([a, b, c], 0)
    // keep=1 → most recent c stays; a + b expire
    expect(expired.sort()).toEqual([a, b].sort())
  })

  it('ignores unrelated file names in the input list', () => {
    const expired = selectExpired([a, b, c, d, 'library.db', 'library.db-wal', 'thumbnails'], 2)
    expect(expired.sort()).toEqual([a, b].sort())
  })

  it('returns [] on empty input', () => {
    expect(selectExpired([], 3)).toEqual([])
  })
})
