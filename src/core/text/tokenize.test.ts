import { describe, it, expect } from 'vitest'
import { tokenizeForFtsSync } from './tokenize'

describe('tokenizeForFtsSync', () => {
  it('returns empty string for empty input', () => {
    expect(tokenizeForFtsSync('')).toBe('')
    expect(tokenizeForFtsSync('   ')).toBe('')
  })

  it('passes through pure ASCII unchanged (normalized whitespace)', () => {
    expect(tokenizeForFtsSync('hello world')).toBe('hello world')
    expect(tokenizeForFtsSync('iPhone   15')).toBe('iPhone 15')
  })

  it('cuts CJK text into multi-char tokens (or falls back to raw)', () => {
    const out = tokenizeForFtsSync('海边日落')
    // 若 jieba 加载成功：应包含 "海边" 或 "日落"；若失败：原文回退
    const hasMeaningfulSplit =
      out.includes('海边') || out.includes('日落') || out === '海边日落'
    expect(hasMeaningfulSplit).toBe(true)
    // 不应该被切成单字（即不该是 "海 边 日 落"）的同时还可用
    if (out.includes(' ')) {
      const tokens = out.split(' ')
      // 至少一个 token 是多字符的（jieba 工作了）
      const multiChar = tokens.some((t) => t.length >= 2 && /[一-鿿]/.test(t))
      expect(multiChar).toBe(true)
    }
  })

  it('handles mixed CJK + ASCII without crashing', () => {
    const out = tokenizeForFtsSync('iPhone 海边 sunset')
    expect(out.length).toBeGreaterThan(0)
    expect(out).toMatch(/iPhone/i)
  })
})
