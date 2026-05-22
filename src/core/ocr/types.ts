/**
 * OCR 通用类型
 *
 * 流水线：det(detection) → cls(orientation) → rec(recognition)
 */

/** 检测器输出的文本框：四个角点，归一化到原图坐标（0~1） */
export interface TextBox {
  /** 四角点，顺序为 [左上, 右上, 右下, 左下] —— pixel 坐标（原图） */
  polygon: [number, number][]
  /** 0~1 置信度 */
  score: number
}

/** 单个识别结果 */
export interface RecognizedLine {
  text: string
  /** 来源 box（pixel 坐标） */
  polygon: [number, number][]
  /** rec 阶段输出的 CTC 置信度（平均字符 prob） */
  score: number
}

/** 完整 OCR 输出 */
export interface OcrResult {
  /** 拼成的全文（按 y 中心、x 左缘排序） */
  text: string
  lines: RecognizedLine[]
}
