# 架构 / 解决方案评审

总体：架构扎实——推理独立 utilityProcess + 代际崩溃恢复、按 hash 去重内容、全程 vec0 ANN、可恢复任务队列、纯函数融合带测试、`vixel://` 按 id 取文件并手写 Range。问题集中在可恢复性/幂等性的边缘和主进程阻塞热点。

## Bugs / 正确性

| # | 严重度 | 问题 | 位置 | 修复 |
|---|---|---|---|---|
| B1 | 高 | 每次启动全库重读、重哈希、重解码、重解析 EXIF（chokidar `ignoreInitial:false` → `handleAdd` 无“未变化”短路；`processThumbnail` 先 decode 再检查缩略图） | watcher.ts `handleAdd`，indexer.ts `processThumbnail` | size+mtime 未变且缩略图在 → 跳过；`hasOpenTask` 去重；先 stat 缩略图 |
| B2 | 高 | 图片 embedding 失败被吞，任务记 done；`requeueMissingEmbeddings` 每次启动无限重排 | indexer.ts `processEmbedding` | 抛出交给 `failTask`；区分“模型未就绪”和单文件失败 |
| B3 | 中 | 会话内修改的视频不会重新索引 | watcher.ts `handleChange` | 按 `classifyMedia` 分流到 `handleAddVideo` |
| B4 | 中 | 应用关闭期间删除的视频永不清理 | watcher.ts `cleanupStalePhotos` | 增加 `cleanupStaleVideos` |
| B5 | 中 | 推理 RPC 无超时，ONNX 卡死会永久卡住索引 | inference-client.ts `call` | 每次调用超时，超时杀掉并重启子进程 |
| B6 | 中 | CLI 语义搜索因无模型目录永远退化为 BM25；数据目录大小写与打包版不一致 | cli/index.ts | 传入模型目录或明确提示；路径与 Electron 一致 |
| B7 | 低 | `videos.width/height` 从未写入 | indexer.ts | 抽帧时写入 |
| B8 | 低 | 文件名 LIKE 未转义 `%`/`_` | db.ts `searchByFileName` | `ESCAPE '\'` |
| B9 | 低 | 原地修改图片后旧 hash 的向量/OCR/人脸/缩略图孤儿化 | watcher.ts `handleChange` | 引用计数为 0 时 GC |

## 主进程阻塞（卡顿）

| # | 严重度 | 问题 | 修复 |
|---|---|---|---|
| M1 | 高 | `emitProgress` 每个任务 / 每个视频段都在主进程同步全表聚合（`getPhotoStats` 含 `COUNT(DISTINCT)`） | 节流 + 统计缓存 |
| M2 | 中 | `GET_FULL_IMAGE_DATA` / `GET_THUMBNAIL_DATA` 仍以 base64 走 IPC（PeopleView、MapView 在用） | 改用 `vixel://` |
| M3 | 中 | 地图一次取 5000 条完整 Photo 行 | 只返回 `{id,lat,lng}` |
| M4 | 低 | 搜索对每个命中逐条同步查询 | `IN (...)` 批量 |

## 设计债

- **D1 db.ts 上帝模块**：2025 行、约 90 个方法，混合 DDL / 迁移 / 队列 / 照片 / 视频 / FTS / 备份 / 人脸质心计算；“按 hash 删除内容”内联三次。建议按仓储拆分，质心计算移入 `core/face`。
- **D2 安全**：`sandbox:false` 不必要；技术文档 §6.1 的零网络 `webRequest` 拦截**并不存在**，地图在请求 `basemaps.cartocdn.com`，“零网络请求”承诺与事实不符；`SHOW_IN_FINDER` 接受任意路径。
- **D3 CLI 并发**：CLI 每次启动都执行 DDL + 迁移（写操作），可能对运行中的 app 触发 `face_vecs` 重建。只读命令应以 `readonly` 打开。
- **D4 文档偏差**：base64 handler 残留；主进程仍做 sharp/sips 解码和人脸聚类。
- **D5**：软删除的 photos 永不清理；`hasVideoSegmentForHash` 未被使用，同一视频的多份拷贝会被重复编码。
