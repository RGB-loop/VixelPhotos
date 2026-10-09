/**
 * 推理进程的转发通道。
 *
 * EmbeddingGemma 2 的一次前向在 transformers.js 里会同步占住线程（实测视频片段单次可达 10s），
 * 人脸 / OCR 的前后处理也是纯 JS。放在主进程里，索引期间事件循环几乎一直被占满，
 * 窗口拖动、IPC、光标全部卡住（macOS 上就是一直转圈）。
 *
 * 所以 main 启动时 setInferenceTransport() 把推理挪到 utilityProcess（src/main/inference.ts）；
 * embedding / face / ocr 的入口函数看到 transport 就转发过去，没有时（单测、无头脚本、推理进程本身）
 * 照旧在本进程里跑。
 */

export type InferenceMethod =
  | 'embed.init'
  | 'embed.encode'
  | 'embed.dispose'
  | 'face.init'
  | 'face.process'
  | 'ocr.init'
  | 'ocr.process'

export interface InferenceTransport {
  call<T>(method: InferenceMethod, ...args: unknown[]): Promise<T>
  /** 推理进程每（重新）启动一次加一；进程里的模型状态只在同一代内有效 */
  readonly generation: number
}

export interface InferenceRequest {
  id: number
  method: InferenceMethod
  args: unknown[]
}

export type InferenceResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

let transport: InferenceTransport | null = null

export function setInferenceTransport(t: InferenceTransport | null): void {
  transport = t
}

export function getInferenceTransport(): InferenceTransport | null {
  return transport
}

/**
 * 记住"某个远端模型在哪一代进程里初始化过"。推理进程崩溃重启后 generation 变了，
 * ready 自动失效，下次调用前重新 init。
 */
export class RemoteReady {
  private gen = -1

  isReady(t: InferenceTransport): boolean {
    return this.gen === t.generation
  }

  mark(t: InferenceTransport, ok: boolean): void {
    this.gen = ok ? t.generation : -1
  }
}
