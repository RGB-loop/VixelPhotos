import { describe, expect, it } from 'vitest'
import { toWav } from './litertProvider'

describe('toWav', () => {
  it('writes a 16-bit mono PCM WAV header LiteRT can parse', () => {
    const wav = toWav(new Float32Array([0, 0.5, -0.5, 1, -1, 2]))
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(20)).toBe(1)        // PCM
    expect(wav.readUInt16LE(22)).toBe(1)        // mono
    expect(wav.readUInt32LE(24)).toBe(16000)    // sample rate
    expect(wav.readUInt16LE(34)).toBe(16)       // bits per sample
    expect(wav.readUInt32LE(40)).toBe(6 * 2)    // data bytes
    expect(wav.length).toBe(44 + 12)
  })

  it('scales and clamps samples to int16', () => {
    const wav = toWav(new Float32Array([0.5, 1, 2, -2]))
    expect(wav.readInt16LE(44)).toBe(16384)
    expect(wav.readInt16LE(46)).toBe(32767)
    expect(wav.readInt16LE(48)).toBe(32767)     // clamped
    expect(wav.readInt16LE(50)).toBe(-32767)    // clamped
  })
})
