/**
 * 主进程侧的推理进程客户端：按需 fork，崩了就把在途请求全部 reject，下次调用时重新拉起。
 * 模型状态随进程丢失，靠 generation 让各服务下次调用前重新 init（见 core/inference/transport.ts）。
 */

import { utilityProcess, type UtilityProcess } from 'electron'
import type {
  InferenceMethod,
  InferenceRequest,
  InferenceResponse,
  InferenceTransport,
} from '../core/inference/transport'
import { lowerPriority } from '../core/video/extract'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class InferenceProcess implements InferenceTransport {
  private child: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private stopped = false
  generation = 0

  constructor(private entry: string) {}

  call<T>(method: InferenceMethod, ...args: unknown[]): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Inference process stopped'))
    const child = this.ensure()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      child.postMessage({ id, method, args } satisfies InferenceRequest)
    })
  }

  stop(): void {
    this.stopped = true
    this.child?.kill()
    this.child = null
  }

  private ensure(): UtilityProcess {
    if (this.child) return this.child
    const child = utilityProcess.fork(this.entry, [], { serviceName: 'Vixel Inference', stdio: 'inherit' })
    this.generation++
    // 后台索引让位于前台：和 ffmpeg 一样降低调度优先级
    child.once('spawn', () => lowerPriority(child.pid))
    child.on('message', (res: InferenceResponse) => {
      const p = this.pending.get(res.id)
      if (!p) return
      this.pending.delete(res.id)
      if (res.ok) p.resolve(res.result)
      else p.reject(new Error(res.error))
    })
    child.once('exit', (code) => {
      if (this.child === child) this.child = null
      if (!this.stopped) console.warn(`[inference] process exited (code ${code}), will restart on next call`)
      const err = new Error(`Inference process exited (code ${code})`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    })
    this.child = child
    return child
  }
}
