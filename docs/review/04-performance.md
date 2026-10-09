# 性能评审（后端 / 数据通路）

测试台：按 schema 在 /tmp 重建，5 万照片 / 4.5 万唯一 hash，ANALYZE 后用 sqlite3 CLI 测查询计划。

| # | 影响 | 问题 | 修复 |
|---|---|---|---|
| 1 | 很高 | watcher 每次启动全量 readFile + 哈希每张图片（约等于读一遍整个图库） | size+mtime 未变直接返回；限制并发 |
| 2 | 很高 | 每个进度事件两次全表扫描（`COUNT(DISTINCT)` 5 万行 16ms，线性增长），无节流 | 节流 ≤2/s + 统计缓存 |
| 3 | 高 | 网格分页每页都全表扫描 + 临时 B 树排序（5 万行 37ms，与 offset 无关） | `created_at` / `taken_at` 部分索引；长期 keyset 分页 |
| 4 | 高 | 同一照片在 thumbnail/embed/face/OCR 各全分辨率解码一次（HEIC 走 sips 3–5 次）；全分辨率 buffer 经 postMessage 复制给推理进程 | 小 LRU 解码缓存；发送前缩放 |
| 5 | 高（首次导入） | 只设了 WAL；`synchronous=FULL` 下逐行自动提交 | `synchronous=NORMAL`、`mmap_size`、`cache_size`、`temp_store=MEMORY`；批量写入用事务 |
| 6 | 中 | `cleanupStalePhotos` N+1 | 单条查询 + 事务 |
| 7 | 中 | base64-over-IPC 读原图；人脸缩略图每次全图解码裁剪 | 删除；人脸裁剪落盘缓存，经 `vixel://face` 提供 |
| 8 | 中 | `vixel://thumb` 无缓存头，滚动重挂时重复走 handler | `Cache-Control: immutable` |
| 9 | 中→高 | vec0 KNN 为精确全扫（4.5 万 × 768 维 ≈ 138MB/次，每次搜索两路） | Matryoshka 截断到 256 维或二值量化预筛 |
| 10 | 低 | 人物列表 OK | — |
| 11 | 低 | chokidar `depth:99` 忽略文件夹的 recursive 设置 | — |
| 12 | 低 | 人脸/OCR ONNX 会话未设 `intraOpNumThreads`；主进程 sharp 使用全部核心 | 设为 cores/2；`sharp.concurrency(2)` |

## 自动化诊断方案
- `VIXEL_PROFILE=1`：SQL 语句计时（超阈值打印）、IPC handler 计时、`vixel://` 计时、主进程事件循环延迟监测、渲染进程 long task 回传。
- CLI：`vixel doctor`（PRAGMA、表/索引、热点查询的 EXPLAIN QUERY PLAN、队列积压）与 `vixel bench`。
