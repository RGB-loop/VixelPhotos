/**
 * 视频处理通用类型
 */

export interface ExtractedFrame {
  /** JPEG 字节流，可直接喂给 sharp / OCR / 人脸 pipeline */
  buffer: Buffer
  /** 帧在视频中的时间戳（毫秒） */
  timestampMs: number
}

export interface ExtractOptions {
  /** 每隔多少秒取一帧，默认 5 */
  intervalSec?: number
  /** 最多抽取多少帧，默认 20 */
  maxFrames?: number
  /** 输出帧长边像素，默认 512（再下游 sharp resize 到缩略图） */
  maxSide?: number
  /** 从视频第几秒开始抽帧，默认 0（片段模式用） */
  startSec?: number
  /** 只抽这么长的一段，默认不限（片段模式用） */
  durationSec?: number
}
