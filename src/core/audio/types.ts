/**
 * 音频模块类型定义
 */

export interface AudioSegment {
  /** 音频数据（mono 16kHz float32，直接喂给 Gemma 2 audio encoder） */
  samples: Float32Array
  /** 对应源文件的起始时间（毫秒） */
  startMs: number
  /** 对应源文件的结束时间（毫秒） */
  endMs: number
  /** 采样率（当前固定 16000） */
  sampleRate: number
}
