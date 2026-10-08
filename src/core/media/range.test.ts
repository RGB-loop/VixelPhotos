import { describe, expect, it } from 'vitest'
import { mediaMimeType, parseRange } from './range'

describe('parseRange', () => {
  const size = 1000

  it('no header → full file', () => {
    expect(parseRange(null, size)).toBeNull()
    expect(parseRange('', size)).toBeNull()
  })

  it('open-ended range (Chromium first request / seek)', () => {
    expect(parseRange('bytes=0-', size)).toEqual({ start: 0, end: 999 })
    expect(parseRange('bytes=500-', size)).toEqual({ start: 500, end: 999 })
  })

  it('closed range, end clamped to file size', () => {
    expect(parseRange('bytes=10-19', size)).toEqual({ start: 10, end: 19 })
    expect(parseRange('bytes=900-5000', size)).toEqual({ start: 900, end: 999 })
  })

  it('suffix range', () => {
    expect(parseRange('bytes=-100', size)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-5000', size)).toEqual({ start: 0, end: 999 })
  })

  it('unsatisfiable', () => {
    expect(parseRange('bytes=1000-', size)).toBe('unsatisfiable')
    expect(parseRange('bytes=20-10', size)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', size)).toBe('unsatisfiable')
    expect(parseRange('bytes=-', size)).toBe('unsatisfiable')
    expect(parseRange('bytes=abc', size)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
  })

  it('unsupported units / multi-range → ignore, serve full file', () => {
    expect(parseRange('items=0-5', size)).toBeNull()
    expect(parseRange('bytes=0-5,10-15', size)).toBeNull()
  })
})

describe('mediaMimeType', () => {
  it('maps common extensions case-insensitively', () => {
    expect(mediaMimeType('.MP4')).toBe('video/mp4')
    expect(mediaMimeType('.mov')).toBe('video/quicktime')
    expect(mediaMimeType('.m4a')).toBe('audio/mp4')
    expect(mediaMimeType('.flac')).toBe('audio/flac')
    expect(mediaMimeType('.xyz')).toBe('application/octet-stream')
  })
})
