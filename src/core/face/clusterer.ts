/**
 * 批量人物聚类的调度：新脸攒够一批、或人脸队列空闲一会儿后跑一次 clusterFaces。
 *
 * 计算是纯 JS（质心点积），每 64 张脸让出一次事件循环，不会长时间卡住主进程；
 * 落单脸一次性读进内存做暴力 KNN（D × 512 次乘加，几千张脸也就几毫秒一次）。
 * 跑的过程中用户可能手动合并 / 改名，applyClusterPlan 会跳过已失效的操作。
 */

import type { DatabaseInstance } from '../db'
import { clusterFaces, dotF, type DormantNeighbor, type PendingFace } from './cluster'

const BATCH_SIZE = 200
const IDLE_MS = 3000

export class FaceClusterer {
  private running = false
  private again = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private db: DatabaseInstance,
    private onChange?: () => void
  ) {}

  /** 每处理完一张照片的人脸后调用 */
  schedule(): void {
    if (this.db.countPendingClusterFaces() >= BATCH_SIZE) {
      void this.run()
      return
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.run() }, IDLE_MS)
  }

  async run(): Promise<void> {
    if (this.running) { this.again = true; return }
    this.running = true
    try {
      do {
        this.again = false
        if (this.db.countPendingClusterFaces() === 0) break
        const t0 = Date.now()
        const dormant = this.db.getDormantFaces()
        const plan = await clusterFaces({
          persons: this.db.getPersonCentroids({ includeHidden: true }),
          pending: this.db.getPendingClusterFaces(),
          rejections: this.db.getFaceRejections(),
          dismissedPairs: this.db.getDismissedPairs(),
          knnDormant: (vec, k) => knn(dormant, vec, k),
          yieldFn: () => new Promise((r) => setImmediate(r)),
        })
        this.db.applyClusterPlan(plan)
        console.log(
          `[faces] cluster: +${plan.assign.length} assigned, ${plan.create.length} new people, ` +
          `${plan.merges.length} merges, ${plan.dormant.length} unmatched (${Date.now() - t0}ms)`
        )
        if (plan.assign.length || plan.create.length || plan.merges.length) this.onChange?.()
      } while (this.again)
    } catch (err) {
      console.error('[faces] cluster failed:', err)
    } finally {
      this.running = false
    }
  }
}

function knn(pool: PendingFace[], vec: Float32Array, k: number): DormantNeighbor[] {
  const out: DormantNeighbor[] = []
  for (const f of pool) {
    const sim = dotF(vec, f.embedding)
    if (out.length < k || sim > out[out.length - 1].sim) {
      out.push({ id: f.id, embedding: f.embedding, quality: f.quality, sim })
      out.sort((a, b) => b.sim - a.sim)
      if (out.length > k) out.pop()
    }
  }
  return out
}
