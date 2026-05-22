import { describe, it, expect } from 'vitest'
import { buildFtsQuery } from './fts-query'

describe('buildFtsQuery', () => {
  it('returns empty string on empty / whitespace input', () => {
    expect(buildFtsQuery('')).toBe('')
    expect(buildFtsQuery('   ')).toBe('')
  })

  it('quotes a single ASCII word', () => {
    expect(buildFtsQuery('cat')).toBe('"cat"')
  })

  it('OR-joins multiple ASCII tokens', () => {
    expect(buildFtsQuery('iPhone 15')).toBe('"iPhone" OR "15"')
  })

  it('strips FTS5 syntax chars to avoid injection / syntax error', () => {
    // 这些字符如果原样进 FTS5 都会炸：" ( ) * + : < > { } ^ ~ -
    const out = buildFtsQuery('foo"bar (baz) -qux')
    // 不应出现裸的引号、括号、连字符
    expect(out).not.toMatch(/[()\-]/)
    expect(out).toMatch(/"foobar"/) // 引号去掉后剩下 foobar
    expect(out).toMatch(/"baz"/)
    expect(out).toMatch(/"qux"/)
  })

  it('drops bare FTS5 keywords (NEAR/AND/OR/NOT)', () => {
    const out = buildFtsQuery('cat NEAR dog AND fish')
    expect(out).not.toContain('"NEAR"')
    expect(out).not.toContain('"AND"')
    expect(out).toContain('"cat"')
    expect(out).toContain('"dog"')
    expect(out).toContain('"fish"')
  })

  it('handles tokens that become empty after stripping (silent drop)', () => {
    expect(buildFtsQuery('---')).toBe('')
    expect(buildFtsQuery('()()')).toBe('')
  })

  it('CJK input is tokenized into >=1 quoted tokens', () => {
    const out = buildFtsQuery('海边日落')
    // 至少有一个被引号包裹的 token
    expect(out).toMatch(/^"[^"]+"(\s+OR\s+"[^"]+")*$/)
  })

  it('mixed CJK + ASCII produces both kinds of tokens', () => {
    const out = buildFtsQuery('海边 sunset')
    expect(out).toMatch(/"sunset"/i)
    expect(out).toMatch(/"[一-鿿]+"/) // 至少一个 CJK token
  })

  it('queries with only FTS5 syntax chars yield empty (caller skips DB call)', () => {
    expect(buildFtsQuery('*"^')).toBe('')
  })
})
