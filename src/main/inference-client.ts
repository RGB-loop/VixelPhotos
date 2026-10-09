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
import { record } from '../core/perf'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  method: InferenceMethod
  sentAt: number
}

/**
 * 卡死看门狗：有在途请求、却这么久没有任何一个完成 → 认为前向卡死（ONNX 死锁 / arena 问题），
 * 杀掉子进程。exit 处理会 reject 在途请求，任务记失败，下次调用自动重启。
 * 最慢的正常前向（32 帧视频片段）约 2.5 分钟，留足余量。
 * 按检查次数计时而不是墙钟：合盖睡眠期间定时器不走，醒来不会把健康的进程误杀。
 */
const STALL_CHECK_MS = 30 * 1000
const STALL_CHECKS = 20 // 20 × 30s = 10 分钟

export class InferenceProcess implements InferenceTransport {
  private child: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private stopped = false
  private idleChecks = 0
  private watchdog: NodeJS.Timeout | null = null
  generation = 0

  constructor(private entry: string) {}

  call<T>(method: InferenceMethod, ...args: unknown[]): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Inference process stopped'))
    const child = this.ensure()
    const id = this.nextId++
    if (this.pending.size === 0) this.idleChecks = 0
    this.armWatchdog()
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method, sentAt: Date.now() })
      child.postMessage({ id, method, args } satisfies InferenceRequest)
    })
  }

  private armWatchdog(): void {
    if (this.watchdog) return
    this.watchdog = setInterval(() => {
      if (this.pending.size === 0) {
        clearInterval(this.watchdog!)
        this.watchdog = null
        return
      }
      if (++this.idleChecks >= STALL_CHECKS && this.child) {
        console.error(`[inference] no response for ${(STALL_CHECKS * STALL_CHECK_MS) / 1000}s with ${this.pending.size} pending — killing stalled process`)
        this.idleChecks = 0
        this.child.kill()
      }
    }, STALL_CHECK_MS)
    this.watchdog.unref?.()
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
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
      this.idleChecks = 0
      // 含排队等待：搜索的文本编码在这里能看出被索引前向挡了多久
      record('infer', p.method, Date.now() - p.sentAt)
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
