# Vixel · 技术架构与选型文档
**版本 v0.2 · 2026-05 · Electron 版本**

> 本文档面向研发工程师，覆盖 Vixel **当前实际形态**（v0.2）的完整技术选型理由、系统架构、数据模型、核心模块实现指南与性能特征。
>
> **平台范围：** macOS first。HEIC 全平台可用（mac 走 `sips`，Linux/Win 走
> `heic-convert` libheif WASM）；视频在全平台均可用（ffmpeg-static）。
> RAW (CR2/NEF/ARW/...) 当前仍是 macOS only（`sips`），Linux/Windows 的
> RAW 兜底（libraw-wasm）在 v0.4+ 评估。
>
> **重大变更（v0.1 → v0.2）：**
> - 移除 Qwen3.5-4B caption 生成（3.4 GB LLM 下载已删除）
> - SigLIP 2 base/16-256 ONNX 取代外部 Embedding API 成为默认 provider
> - 新增 PaddleOCR v5 全本地 OCR
> - 人脸匹配从 O(N) JS 余弦切换到 sqlite-vec ANN
> - 新增视频抽帧（ffmpeg-static + 关键帧 → 复用图像流水线）
> - FTS5 中文搜索：jieba 分词替代字符级 unicode61

---

## 目录

1. [系统架构概览](#1-系统架构概览)
2. [AI 模型选型详解](#2-ai-模型选型详解)
3. [数据存储设计](#3-数据存储设计)
4. [核心模块实现](#4-核心模块实现)
5. [性能设计](#5-性能设计)
6. [隐私与安全设计](#6-隐私与安全设计)
7. [开发环境与工程规范](#7-开发环境与工程规范)
8. [技术风险与备选方案](#8-技术风险与备选方案)

---

## 1. 系统架构概览

### 1.1 整体架构图

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      Vixel App (Electron, single Node process)            │
│  ┌────────────────┐    ┌────────────────────────────────────────────┐    │
│  │   Renderer     │    │              Main Process                  │    │
│  │   (React)      │◄──►│  ┌──────────────────────────────────────┐ │    │
│  └────────────────┘    │  │           Indexer Pipeline           │ │    │
│       │         IPC    │  │  thumbnail → embed → face → ocr      │ │    │
│       ▼                │  │              ↑                       │ │    │
│  ┌────────────────┐    │  │       extract_frames (video)         │ │    │
│  │  Photo Grid    │    │  └──────────────────────────────────────┘ │    │
│  │  Map / People  │    │  ┌──────────────────────────────────────┐ │    │
│  │  PhotoDetail   │    │  │     ONNX Runtime (onnxruntime-node)  │ │    │
│  └────────────────┘    │  │  ┌──────────┐ ┌──────┐ ┌──────────┐ │ │    │
│                        │  │  │ SigLIP 2 │ │PaddOCR│ │SCRFD +   │ │ │    │
│                        │  │  │ via 🤗   │ │ det/  │ │MobileFace│ │ │    │
│                        │  │  │ Transfor-│ │ rec/  │ │Net       │ │ │    │
│                        │  │  │ mers.js  │ │ cls   │ │          │ │ │    │
│                        │  │  └──────────┘ └──────┘ └──────────┘ │ │    │
│                        │  └──────────────────────────────────────┘ │    │
│                        │  ┌──────────────────────────────────────┐ │    │
│                        │  │      ffmpeg-static (subprocess)      │ │    │
│                        │  │     视频抽帧 → 复用图像流水线         │ │    │
│                        │  └──────────────────────────────────────┘ │    │
│                        │  ┌──────────────────────────────────────┐ │    │
│                        │  │    better-sqlite3 + sqlite-vec       │ │    │
│                        │  │  photos | image_vecs(768)            │ │    │
│                        │  │  captions+FTS5 (jieba UDF)           │ │    │
│                        │  │  image_ocr+FTS5 (jieba UDF)          │ │    │
│                        │  │  faces | face_vecs(128) ANN          │ │    │
│                        │  │  people | videos | meta_state        │ │    │
│                        │  └──────────────────────────────────────┘ │    │
│                        │  ┌──────────────────────────────────────┐ │    │
│                        │  │       File Watcher (chokidar)        │ │    │
│                        │  └──────────────────────────────────────┘ │    │
│                        └────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
  ↑ 零网络请求    ↑ 所有数据本地    ↑ 照片文件原位引用，不复制
  ↑ 无 Python，无 llama-server，无外部 API（除非用户显式启用 API fallback）
```

### 1.2 技术栈总览

| 层级 | 选型 | 备注 |
|---|---|---|
| 应用框架 | **Electron 33+** | 单进程；不再依赖 llama-server / Python 子进程 |
| 构建工具 | **electron-vite** | 主+预加载+渲染三套 entry |
| UI 框架 | **React 18 + TypeScript + Tailwind CSS** | — |
| 图文 Embedding | **SigLIP 2 base/16-256**（ONNX 量化） | 768 维；视觉 + 文本同空间；多语言（含中日韩） |
| ONNX 运行时 | **onnxruntime-node + @huggingface/transformers** | CoreML / CPU EP；Transformers.js 负责 tokenizer + processor |
| OCR（图内文字） | **PaddleOCR v5**（det + cls + rec ONNX） | RapidAI 社区导出；charset 用 ppocr_keys_v1 |
| 人脸检测 | **SCRFD-2.5G-KPS**（InsightFace ONNX） | ~3 MB |
| 人脸 embedding | **MobileFaceNet**（ONNX） | 128 维，L2 归一化 |
| 人脸聚类 | **sqlite-vec ANN** | 取代 v0.1 的 O(N) JS 余弦扫描 |
| 视频抽帧 | **ffmpeg-static** | 每 5s 一帧、上限 20；temp dir → image2 输出 |
| 向量存储 | **sqlite-vec**（vec0 虚表） | image_vecs(768) + face_vecs(128) |
| 元数据存储 | **better-sqlite3 + FTS5** | 同进程 sync API |
| 中文分词 | **@node-rs/jieba**（UDF jiebatok） | FTS5 写入/查询两端对称切词 |
| 文件监听 | **chokidar** | 图片 + 视频统一 add/change/unlink |
| EXIF 解析 | **exifr** | 直接读 HEIC/RAW 元数据，不依赖解码 |
| 图片处理 | **sharp**（libvips） | EXIF auto-rotate；HEIC 走 sips(mac) / heic-convert(Linux/Win)；RAW 走 sips(mac only) |
| 文件去重 | **xxhash-wasm** | photo 内容哈希（dedup 缩略图/embedding） |
| 测试 | **vitest** | 24 个单测，<1s |

---

## 2. AI 模型选型详解

> **思路**：不押宝单个大 LLM 干一切；每个能力配一个**专门的小模型**，统一通过
> onnxruntime-node 跑、统一收口到 SQLite/sqlite-vec。这是 v0.2 取代 v0.1 的
> "Qwen3.5-4B 包打天下"路线后留下来的核心原则。

### 2.1 图文检索（语义搜索）：SigLIP 2 base/16-256

| 维度 | 取值 |
|---|---|
| 模型 ID | `onnx-community/siglip2-base-patch16-256` |
| 视觉 + 文本编码器 | 同空间（直接内积比相似度） |
| 嵌入维度 | **768** |
| 量化 | q8 ONNX，~190 MB |
| 多语言 | 30+（含中、日、韩、英） |
| 许可 | Apache 2.0 |

#### 为什么是 SigLIP 2 而不是 Chinese-CLIP / OpenCLIP

| 候选 | 中文 | 多语言 | 公开 benchmark | 体积 |
|---|---|---|---|---|
| **SigLIP 2 base ★** | ✓ | ✓✓ (30+) | XM3600 / Crossmodal | ~190 MB |
| Chinese-CLIP B/16 | ✓✓ (强) | ✗ (中英为主) | COCO-CN / MUGE | ~190 MB |
| MobileCLIP S2 | 弱 | ✗ | DataCompDR | ~140 MB |

PRD 明确要求"日语搜樱花照片"这类多语言场景；如果未来用户群偏中文重度，
可加 Chinese-CLIP 作为"中文专项模式"二选一。

#### 集成

```typescript
// src/core/embedding/providers/onnxProvider.ts
import { AutoTokenizer, AutoProcessor, AutoModel, RawImage, env }
  from '@huggingface/transformers'

env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = bundledModelsDir  // <Resources>/models

const tokenizer = await AutoTokenizer.from_pretrained('siglip2')
const processor = await AutoProcessor.from_pretrained('siglip2')
const model = await AutoModel.from_pretrained('siglip2', { dtype: 'q8' })

// 图像 → 768d
const inputs = await processor(await RawImage.read(blob))
const { data } = await model.get_image_features(inputs)
// 文本 → 768d（同空间，直接内积比相似度）
const ti = tokenizer(query, { padding: 'max_length', truncation: true })
const { data: tdata } = await model.get_text_features(ti)
```

预热在 main 启动后 2s 触发；首次推理冷启动 2-5s，之后 ~80 ms/张 CPU、
~25 ms/张 CoreML（M2）。

---

### 2.2 OCR（图内文字）：PaddleOCR v5（det + cls + rec）

| 子模型 | ONNX 大小 | 用途 |
|---|---|---|
| `ppocr_v5_det` | ~3 MB | 文本框检测（DB / Differentiable Binarization） |
| `ppocr_v5_cls` | ~1 MB | 180° 方向分类（可选） |
| `ppocr_v5_rec` | ~8 MB | CRNN + CTC 文字识别 |
| `ppocr_keys_v1.txt` | 60 KB | 字符表（~6.6k 字符，含中英） |

来源：RapidAI/RapidOCR 社区导出（Apache 2.0），与 PaddleOCR 上游官方
模型一致。

#### 流水线（src/core/ocr）

```
detection.ts → detectTextBoxes()
  resize (long side ≤ 960, 32 对齐) → normalize → ONNX
  → sigmoid prob map → 二值化(>0.3) → BFS 连通块
  → AABB 近似最小矩形 → unclip (area*ratio/perimeter)
  → 按 score 排序

cls.ts → detectFlips()  (可选)
  按框 crop → (48, 192) → softmax 二分类
  > 0.9 置信度 → 标记 180° flip

recognition.ts → recognizeBoxes()
  按框 crop → resize 到 (48, 动态宽) → 批量 (B, 3, 48, maxW)
  → ONNX → [B, T, C] / [B, C, T] 自适应
  → CTC greedy decode + 去重 + 去 blank
  → 平均字符 prob 作为 line score

index.ts → processPhotoOcr()
  det → cls → rec
  → 按 y 中心、x 左缘排序
  → 丢弃 score < 0.5
  → 用换行 join 成 text
```

输出文本走 `image_ocr` 表 + FTS5 BM25 (jieba 分词) 索引。

---

### 2.3 人脸识别：SCRFD + MobileFaceNet + sqlite-vec ANN

| 组件 | 体积 | 来源 |
|---|---|---|
| SCRFD-2.5G-KPS（检测 + 5 关键点） | ~3 MB | InsightFace |
| MobileFaceNet（embedding） | ~5 MB | InsightFace |
| 聚类 | (无模型) | sqlite-vec ANN，Immich 风格增量匹配 |

```typescript
// src/core/face/index.ts (简化)
const candidates = db.searchFaceKnn(embedding, 10, /* excludeFaceId */ newFaceId)
for (const c of candidates) {
  const cosDistance = (c.distance * c.distance) / 2  // vec0 L2 → cos
  if (cosDistance > MAX_DISTANCE) break  // 已升序
  if (c.personId != null) return assignTo(c.personId)
}
return createNewPerson()
```

为什么不用 buffalo_l (~166 MB) 的 ArcFace r50：
- MobileFaceNet 在 LFW 上 ~99.5%，buffalo_l ~99.85%；0.3% 收益换 33x 体积，
  对个人相册量级（一般 < 50k 张）不划算。

性能曲线（PR5 之前 → 之后）：

| 库内人脸数 | JS 暴力 O(N) | sqlite-vec ANN |
|---|---|---|
| 1 k | ~50 ms | < 1 ms |
| 10 k | ~500 ms | ~1 ms |
| 50 k | 多秒掉帧 | ~1 ms |

---

### 2.4 视频抽帧：ffmpeg-static

| 维度 | 配置 |
|---|---|
| 二进制来源 | `ffmpeg-static` npm（per-platform prebuilt，~80 MB） |
| 抽帧策略 | 固定 5s 一帧，cap 20 帧/视频 |
| 输出 | 长边 ≤ 512 px JPEG，落到 `<userData>/video_frames/<videoHash>/<ms>.jpg` |
| 编排 | indexer 新 task 类型 `extract_frames` |

抽出来的每一帧都作为常规 `photos` 行入库，反向引用 `videos.id`：
图像流水线（thumbnail / embed / face / OCR）**零分支**复用。

为什么固定间隔而非 scene-change：scene detection 对静态长视频会返回
0 帧；固定间隔行为可预测，对个人相册的搜索召回足够。

---

### 2.5 删除的两个候选（v0.1 计划过但未保留）

| 模型 | 计划用途 | 删除原因 |
|---|---|---|
| Qwen3.5-4B + llama.cpp | 自动 caption | 3.4 GB 下载 + 秒级推理，对"灌进 FTS5 让人能搜到"严重过设计；OCR + 图文 CLIP 双通道已覆盖搜索需求 |
| EmbeddingGemma-300M | 独立文本 embedding | SigLIP 2 文本编码器与图像编码器**同空间**，query 直接走它就够；多一个文本模型是冗余 |

---

## 3. 数据存储设计

### 3.1 数据库 Schema（v0.2 实际）

```sql
-- library.db (SQLite + sqlite-vec, WAL mode, busy_timeout=5000)

-- 监控文件夹
CREATE TABLE watched_folders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  path          TEXT NOT NULL UNIQUE,
  last_scan_at  DATETIME,
  recursive     BOOLEAN DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 照片主表（视频抽出的帧也是一行 photos，video_id 反向引用）
CREATE TABLE photos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id       INTEGER REFERENCES watched_folders(id),
  file_path       TEXT NOT NULL UNIQUE,
  file_name       TEXT NOT NULL,
  file_size       INTEGER NOT NULL,
  file_mtime      INTEGER NOT NULL,
  file_hash       TEXT,
  width           INTEGER,
  height          INTEGER,
  taken_at        DATETIME,
  lat             REAL,
  lng             REAL,
  embed_status    TEXT DEFAULT 'pending',
  caption_status  TEXT DEFAULT 'pending',
  face_status     TEXT DEFAULT 'pending',     -- ALTER 加入
  video_id        INTEGER REFERENCES videos(id), -- ALTER 加入；null=独立照片
  frame_time_ms   INTEGER,                    -- ALTER 加入；视频帧时间戳
  deleted_at      DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_photos_folder    ON photos(folder_id);
CREATE INDEX idx_photos_status    ON photos(embed_status, caption_status);
CREATE INDEX idx_photos_deleted   ON photos(deleted_at);
CREATE INDEX idx_photos_file_hash ON photos(file_hash);
CREATE INDEX idx_photos_video     ON photos(video_id);

-- 索引任务队列
CREATE TABLE index_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id    INTEGER REFERENCES photos(id),  -- task_type='extract_frames' 时是 videos.id
  task_type   TEXT NOT NULL,                  -- thumbnail/embed/face/ocr/extract_frames/caption(legacy)
  priority    INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  error_msg   TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_queue_status ON index_queue(status, priority DESC);

-- Caption（用户手写；保留 schema 但 v0.2 indexer 不再自动写）
CREATE TABLE captions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash   TEXT NOT NULL UNIQUE,
  lang        TEXT DEFAULT 'en',
  text        TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 图像向量（SigLIP 2，768d）
-- vec0 要求 rowid 是整数；image_vec_map 把 file_hash → rowid 映射
CREATE TABLE image_vec_map (
  rowid     INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash TEXT NOT NULL UNIQUE
);
CREATE VIRTUAL TABLE image_vecs USING vec0(embedding FLOAT[768]);

-- OCR 文本（按 file_hash 去重共享；独立于 captions）
CREATE TABLE image_ocr (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash   TEXT NOT NULL UNIQUE,
  text        TEXT NOT NULL,
  detected_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- FTS5（unicode61，但插入/查询前由 jiebatok UDF 切词；中英都好）
CREATE VIRTUAL TABLE captions_fts  USING fts5(text, tokenize='unicode61');
CREATE VIRTUAL TABLE image_ocr_fts USING fts5(text, tokenize='unicode61');

-- INSERT/UPDATE 触发器调用 jiebatok(new.text)
CREATE TRIGGER captions_ai AFTER INSERT ON captions BEGIN
  INSERT INTO captions_fts(rowid, text) VALUES (new.id, jiebatok(new.text));
END;
-- (... 对应 _ad / _au；image_ocr 三份同型)

-- 人脸
CREATE TABLE faces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash   TEXT NOT NULL,
  face_index  INTEGER NOT NULL,
  bbox        TEXT NOT NULL,        -- JSON {x,y,w,h} 归一化
  confidence  REAL NOT NULL,
  embedding   BLOB NOT NULL,         -- source-of-truth；face_vecs 是 ANN 索引
  person_id   INTEGER REFERENCES people(id),
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(file_hash, face_index)
);
CREATE INDEX idx_faces_file_hash ON faces(file_hash);
CREATE INDEX idx_faces_person    ON faces(person_id);

-- 人脸 ANN 索引（rowid == faces.id；无需 map 表）
CREATE VIRTUAL TABLE face_vecs USING vec0(embedding FLOAT[128]);

-- 人物
CREATE TABLE people (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT,
  cover_face_id INTEGER,
  face_count    INTEGER DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 视频
CREATE TABLE videos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id    INTEGER REFERENCES watched_folders(id),
  file_path    TEXT NOT NULL UNIQUE,
  file_name    TEXT NOT NULL,
  file_size    INTEGER NOT NULL,
  file_mtime   INTEGER NOT NULL,
  file_hash    TEXT,                -- 轻量哈希 (path|size|mtime)
  duration_ms  INTEGER,
  width        INTEGER,
  height       INTEGER,
  frame_count  INTEGER DEFAULT 0,
  deleted_at   DATETIME,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_videos_folder ON videos(folder_id);
CREATE INDEX idx_videos_hash   ON videos(file_hash);

-- 一次性迁移标记 / 内部状态
CREATE TABLE meta_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- 已记录的 keys:
--   fts5_jieba_rebuilt_v1            (PR4.4)
--   face_vecs_backfilled_dim128_v1   (PR5.4)
```

### 3.2 中文分词 UDF：`jiebatok(text)`

```typescript
db.function('jiebatok', { deterministic: true, varargs: false }, (text) => {
  if (typeof text !== 'string' || text.length === 0) return ''
  return tokenizeForFtsSync(text)
})
```

`tokenizeForFtsSync` 内部：
- 纯 ASCII：去多余空白返回
- 含 CJK：交给 @node-rs/jieba `cutForSearch`（更宽召回）
- jieba 加载失败：返回原文（FTS5 退化为 char-level，至少不丢数据）

`deterministic: true` 让 SQLite 缓存重复输入的结果，触发器密集写入时显著省 CPU。

### 3.3 向量搜索（4-way RRF）

```typescript
// src/core/search.ts （简化）
const [vec, captionBm25, ocrBm25, fileName] = await Promise.all([
  searchByVector(query, limit * 2),                // SigLIP 2 文本 → KNN
  db.searchByText(query, limit * 2),               // captions_fts BM25
  db.searchByOcr(query, limit * 2),                // image_ocr_fts BM25
  db.searchByFileName(query, limit * 2),           // photos.file_name LIKE
])
const fused = rrfFuse([vec, captionBm25, ocrBm25, fileName], 60)
```

`rrfFuse` 是 `src/core/fusion.ts` 里的纯函数（带 7 个单测）。

### 3.4 文件布局

```
# macOS（生产）
/Applications/Vixel.app/Contents/Resources/models/
├── siglip2/         (~190 MB, q8 ONNX, 打进 DMG)
├── paddleocr/       (~12 MB, 4 个 ONNX + ppocr_keys_v1.txt)
├── scrfd_2.5g_kps.onnx
└── mobilefacenet.onnx

# 用户态
~/Library/Application Support/Vixel/
├── library.db                     ← 主数据库 (WAL)
├── library.db-wal
├── library.db-shm
├── thumbnails/
│   └── {file_hash}.webp           ← 共享去重缩略图
├── video_frames/
│   └── {videoHash}/{ms}.jpg       ← 每个视频的关键帧
└── embedding-config.json          ← 仅当用户切到外部 API 兜底时存在
```

> 注：模型权重**不在用户目录**，因此卸载应用 = 删除模型；只删用户数据
> 不会影响搜索能力。

### 3.5 迁移与启动顺序

```
initDatabase(dbPath)
  1. open DB + WAL + busy_timeout
  2. sqlite-vec.load
  3. db.function('jiebatok', ...)        ← 注册 UDF
  4. migrateIfNeeded                     ← v0.0 → v0.1 旧 schema 兜底
  5. migrateToVec0                       ← 普通表 → vec0 虚表
  6. migrateVectorDimension(768)         ← 旧 2048 (Qwen3-VL) → 768 (SigLIP 2)
  7. migrateFtsTriggersToJieba           ← 触发器替换为带 jiebatok 的版本
  8. db.exec(SCHEMA)                     ← 创建所有缺失的表 / 触发器
  9. wal_checkpoint(PASSIVE)
 10. ensureFaceStatusColumn              ← face_status 列若缺则 ALTER
 11. ensureVideoFrameColumns             ← video_id / frame_time_ms 若缺则 ALTER
 12. cleanupStaleVecMap                  ← image_vec_map 孤立条目清理
 13. rebuildFtsIndicesIfNeeded           ← 旧 FTS5 数据用 jieba 重切一遍
 14. backfillFaceVecsIfNeeded            ← faces.embedding BLOB → face_vecs
```

每一步都是 **idempotent**，靠 `meta_state` flag 或 `IF NOT EXISTS`/`PRAGMA table_info` 检测。
失败统一软降级（搜索仍工作）+ 下次启动重试。

---

## 4. 核心模块实现

### 4.1 进程模型

v0.2 是**单 Electron 进程**：main 同时负责 UI 路由、SQLite、ONNX 推理。
没有 Worker 线程、没有 llama-server 子进程、没有 Python。视频抽帧是
唯一的外部子进程（ffmpeg）—— 短命的 spawn-and-wait，不常驻。

```
┌───────────────────────────────────────────────────┐
│                  Main Process                     │
│  ┌───────────┐  ┌────────────┐  ┌─────────────┐  │
│  │ Indexer   │  │ Watcher    │  │ SQLite +    │  │
│  │ EventEm.  │◄─│ chokidar   │─►│ sqlite-vec  │  │
│  └─────┬─────┘  └────────────┘  └─────────────┘  │
│        │                                          │
│        ▼   onnxruntime-node / 🤗 Transformers.js  │
│  ┌──────────────────────────────────────────────┐ │
│  │ SigLIP 2 / SCRFD / MobileFaceNet / PaddleOCR │ │
│  └──────────────────────────────────────────────┘ │
│        │   spawn (fire-and-wait)                  │
│        ▼                                          │
│  ┌──────────────┐                                 │
│  │ ffmpeg-static│  仅在抽视频帧时启动              │
│  └──────────────┘                                 │
└──────────────┬────────────────────────────────────┘
               │ contextBridge + ipcMain/Renderer
┌──────────────▼────────────────────────────────────┐
│              Renderer Process (React)             │
│   PhotoGrid · MapView · PeopleView · PhotoDetail  │
│   SearchBar · FolderManager · ModelStatus         │
└───────────────────────────────────────────────────┘
```

### 4.2 IPC 表面

[`src/preload/index.ts`](src/preload/index.ts) 暴露的全部 API（v0.2）。
全部走 `ipcRenderer.invoke`，没有同步 IPC，没有 `nodeIntegration`。

```typescript
window.api = {
  // 搜索
  search(query, limit?, { dateFrom?, dateTo? }?)
  findSimilar(photoId, limit?)
  getPhotosWithGPS()

  // 文件夹
  selectFolder() / addFolder(path) / removeFolder(id)
  getFolders() / getFolderStats(id)

  // 照片
  getPhotoDetail(id) / getThumbnailData(id) / getFullImageData(id)
  getPhotoLocations(id) / showInFinder(path)
  updateCaption(id, text)

  // OCR
  startOcrScan()

  // 人脸
  startFaceScan() / getPeople()
  getPersonPhotos(id, limit?) / setPersonName(id, name)
  mergePeople(target, sources[]) / getFaceThumbnail(faceId)
  getPhotoFaces(photoId)

  // 模型状态 / Embedding provider 切换
  getModelStatus() / getEmbeddingConfig() / setEmbeddingConfig(c|null)
  testEmbeddingApi()

  // 进度
  onIndexProgress(cb)  // → { stage, totalPhotos, indexedPhotos, ocrPhotos, ... }
}
```

> 历史 channel（`download-model` / `download-llama-server` /
> `init-caption-generator` / `regenerate-caption` 等）已在 PR2 全部删除，
> renderer 不再持有对应回调。

### 4.3 Indexer 任务流水线

```
file enters watcher
  │
  ├─ image  → addPhoto → enqueue('thumbnail', 'embed')
  └─ video  → addVideo → enqueue('extract_frames')

indexer.processNext() loop:
  task                    handler
  ─────────────────       ────────────────────────────────
  thumbnail               processThumbnail
                            decodeImage()           ← sharp → sips(mac HEIC/RAW) → heic-convert(HEIC fallback)
                            parseAndUpdateMeta()    ← exifr on original bytes
                            sharp.rotate().resize(512).webp
                            → <userData>/thumbnails/<hash>.webp
  embed                   processEmbedding
                            decodeImage()
                            getEmbeddingService().encodeImage(decoded)
                            → db.saveImageVec(hash, Float32Array<768>)
  face                    processFace
                            decodeImage()
                            SCRFD detect → MobileFaceNet embed
                            → db.saveFace(...)        ← 同时写 face_vecs
                            → assignFaceToPerson(...)  ← ANN k=10 匹配
  ocr                     processOcr
                            decodeImage()
                            processPhotoOcr()        ← det/cls/rec
                            → db.saveOcrText(hash, joined)
  extract_frames          processExtractFrames (task.photoId 是 videos.id)
                            extractKeyframes()       ← ffmpeg-static
                            → 每帧落 <userData>/video_frames/<vh>/<ms>.jpg
                            → 每帧 addPhoto(videoCtx={videoId, frameTimeMs})
                            → 每帧 enqueue('thumbnail', 'embed')

  caption                 legacy queue 残留，直接 completeTask
```

关键设计点：

- **single-flight `isProcessing` flag**：v0.2 仍是串行处理 task；并发是后续
  优化方向（image embedding 走 CoreML 时 ~25 ms，多核 CPU 可受益）。
- **task 失败 ≠ 全局停摆**：`failTask` 写 retry_count + error_msg，下一轮
  recoverStuckTasks 把 processing 状态拉回 pending 重试。
- **decodeImage 是流水线唯一的读文件入口**：所有阶段都通过它拿 buffer，
  自动处理 HEIC/RAW；EXIF 走原始字节避免 sips 转码丢失 GPS。

### 4.4 文件监听（chokidar）

[`src/core/watcher.ts`](src/core/watcher.ts) 的 `FileWatcher.handleAdd` 现在
按 `classifyMedia(ext)` 分流：

| 扩展名 | 走向 |
|---|---|
| `.jpg .png .webp .gif .tiff .bmp .avif .heic .heif .cr2 .cr3 .nef .arw .dng .raf .orf .rw2` | `image` 路径，addPhoto + enqueue thumbnail/embed |
| `.mp4 .mov .m4v .webm .mkv .avi` | `video` 路径，addVideo + enqueue extract_frames |
| 其它 | 忽略 |

视频条目的 `file_hash` 用 `(path|size|mtime)` 轻量哈希，避免 watcher 在
GB 级文件上读取全部字节阻塞。真正的内容 hash 在 indexer 抽出帧后逐帧算。

### 4.5 搜索引擎

```typescript
// src/core/search.ts （简化）
async search(query, limit, options) {
  if (!query.trim()) return getRecentPhotos(limit) // 含日期过滤分支

  const [vec, captionBm25, ocrBm25, fileName] = await Promise.all([
    searchByVector(query, limit * 2),       // SigLIP text encoder → vec0 KNN
    db.searchByText(query, limit * 2),      // captions_fts BM25
    db.searchByOcr(query, limit * 2),       // image_ocr_fts BM25
    db.searchByFileName(query, limit * 2),  // LIKE %query%
  ])

  const fused = rrfFuse([
    [...vec].sort((a, b) => a.distance - b.distance),
    [...captionBm25].sort((a, b) => b.score - a.score),
    [...ocrBm25].sort((a, b) => b.score - a.score),
    fileName,
  ], 60)

  // dedup：同 hash 只取一次；同 video 只取最佳帧
  const results = []
  const seenHashes = new Set(); const seenVideos = new Set()
  for (const { fileHash, score } of fused) {
    if (seenHashes.has(fileHash)) continue; seenHashes.add(fileHash)
    const photo = db.getRepresentativeByHash(fileHash)
    if (!photo || photo.deletedAt) continue
    if (photo.videoId != null) {
      if (seenVideos.has(photo.videoId)) continue
      seenVideos.add(photo.videoId)
    }
    if (dateFrom && photo.takenAt < dateFrom) continue
    if (dateTo   && photo.takenAt > dateTo)   continue
    results.push({ photo, score })
    if (results.length >= limit) break
  }
  return results
}
```

`rrfFuse` 抽到 [`src/core/fusion.ts`](src/core/fusion.ts) 作纯函数 + 7 个单测；
`buildFtsQuery` 抽到 [`src/core/text/fts-query.ts`](src/core/text/fts-query.ts)
作纯函数 + 9 个单测（覆盖 jieba 分词 + FTS5 语法字符转义 + keyword 过滤）。

---

## 5. 性能特征

### 5.1 单照片索引耗时（Apple M2, CoreML EP）

| 阶段 | 耗时 | 说明 |
|---|---|---|
| decodeImage | < 5 ms (JPEG) / ~200 ms (HEIC via sips) / ~600 ms (HEIC via heic-convert WASM) | |
| parseAndUpdateMeta | ~10 ms | exifr |
| generateThumbnail | ~20 ms | sharp resize → webp 512px |
| processEmbedding | ~80 ms CPU / ~25 ms CoreML | SigLIP 2 |
| processFace（按需） | ~30 ms / 张（不含 detect） | SCRFD + MobileFaceNet |
| processOcr（按需） | ~150–400 ms / 张 | PaddleOCR det+rec |
| 单视频抽帧 | ~2 s + (每帧 embedding ~80 ms) | ffmpeg + 20 帧上限 |

### 5.2 大库性能 (PR5 前后)

| 操作 | v0.1 | v0.2 |
|---|---|---|
| 新人脸入库（10k 已有脸） | ~500 ms / 张 (JS 暴力余弦) | ~1 ms / 张 (vec0 ANN) |
| 中文 query "海边" | 字符级 BM25，召回错乱 | jieba 分词后 BM25 + vec 并行 |
| HEIC 索引 | 静默失败 | sips fallback 正确解码 |

### 5.3 内存占用

| 组件 | 内存（M2 实测，加载完） |
|---|---|
| Electron 基础 + React UI | ~250 MB |
| SigLIP 2 模型（q8 + tokenizer + processor） | ~400 MB |
| onnxruntime + face / OCR sessions | ~150 MB |
| SQLite WAL + caches | < 100 MB |
| **稳态总计** | **< 1 GB** |

视频抽帧期间 ffmpeg 短暂吃额外 ~100 MB，结束后释放。

### 5.4 已应用的优化

1. **模型预热**：jieba + SigLIP 2 在启动后 fire-and-forget 预加载
2. **SQL UDF `deterministic: true`**：FTS5 触发器密集写入时缓存 jieba 结果
3. **decodeImage 单读**：避免对 HEIC 重复触发 sharp metadata 探测
4. **缩略图共享**：按 file_hash 复用，重复文件零额外存储
5. **vec0 ANN**：所有向量搜索（image + face）O(log N)
6. **CoreML execution provider 优先**：Apple Silicon 上 ONNX 3-4x 加速

### 5.5 仍是单线程的部分（后续优化方向）

- Indexer 流水线 `isProcessing` 串行；可并行的有：
  - 多个 embed 任务并发（CPU/Metal 都未饱和）
  - thumbnail 与 embed 解耦（thumb 是 IO，embed 是计算）
- IPC `getThumbnailData` 走 base64 base64 over IPC；可换 `vixel://` 自定义
  协议直接 stream，省一次内存拷贝
- search 各通道并发但 `rrfFuse` 是 JS 单 fold；对 limit=50 量级无所谓

---

## 6. 隐私与安全设计

### 6.1 零网络请求保障

```typescript
// main/index.ts
app.on('ready', () => {
  // 禁用所有网络请求（模型下载除外）
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const isModelDownload = details.url.includes('huggingface.co');
    if (!isModelDownload && details.url.startsWith('http')) {
      console.log('Blocked network request:', details.url);
      callback({ cancel: true });
    } else {
      callback({});
    }
  });
});
```

### 6.2 数据安全

- 照片原文件：只读引用，不复制
- 索引文件：存储在用户目录，不共享
- Embedding 向量：无法反向还原原图
- 日志：不记录照片内容

---

## 7. 开发环境与工程规范

### 7.1 环境依赖

```json
// package.json
{
  "name": "vixel",
  "version": "0.1.0",
  "main": "dist/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "package": "electron-builder"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "sqlite-vec": "^0.1.0",
    "onnxruntime-node": "^1.17.0",
    "node-llama-cpp": "^3.0.0",
    "chokidar": "^3.6.0",
    "sharp": "^0.33.0",
    "exifr": "^7.1.0"
  },
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-vite": "^2.3.0",
    "electron-builder": "^25.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "typescript": "^5.5.0",
    "tailwindcss": "^3.4.0",
    "react-window": "^1.8.0"
  }
}
```

### 7.2 项目结构

```
vixel/
├── src/
│   ├── main/                      # Electron 主进程
│   │   ├── index.ts               # 入口
│   │   ├── ipc.ts                 # IPC 处理
│   │   ├── db/
│   │   │   ├── index.ts           # 数据库初始化
│   │   │   ├── schema.ts          # 建表 SQL
│   │   │   └── migrations/
│   │   ├── services/
│   │   │   ├── indexer.ts         # 索引调度
│   │   │   ├── embedding.ts       # SigLIP + EmbeddingGemma
│   │   │   ├── caption.ts         # Qwen3.5-4B
│   │   │   ├── search.ts          # 搜索引擎
│   │   │   ├── watcher.ts         # 文件监听
│   │   │   └── thumbnail.ts       # 缩略图生成
│   │   └── workers/
│   │       └── indexWorker.ts     # AI 推理 Worker
│   ├── preload/
│   │   └── index.ts               # 预加载脚本
│   ├── renderer/                  # React 前端
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── SearchBar.tsx
│   │   │   ├── PhotoGrid.tsx
│   │   │   ├── PhotoDetail.tsx
│   │   │   ├── FolderManager.tsx
│   │   │   └── IndexProgress.tsx
│   │   ├── hooks/
│   │   │   ├── useSearch.ts
│   │   │   └── useIndexProgress.ts
│   │   └── styles/
│   │       └── globals.css
│   └── shared/
│       └── types.ts               # 共享类型定义
├── resources/                     # 静态资源
├── electron.vite.config.ts
├── tailwind.config.js
├── tsconfig.json
└── package.json
```

### 7.3 开发任务拆解

| 优先级 | 任务 | 预估工时 |
|---|---|---|
| P0 | 项目骨架 + electron-vite 配置 | 1 天 |
| P0 | SQLite + sqlite-vec 集成 | 1 天 |
| P0 | 照片导入 + 文件扫描 + EXIF 解析 | 2 天 |
| P0 | chokidar 文件监听 | 1 天 |
| P0 | SigLIP 2 ONNX 集成 | 2 天 |
| P0 | 向量存取 + 基础搜索 | 2 天 |
| P0 | 搜索 UI + 结果展示 | 2 天 |
| P1 | EmbeddingGemma 文本向量化 | 1 天 |
| P1 | Qwen3.5-4B Caption 生成 | 3 天 |
| P1 | 双路搜索 + RRF 融合 | 1 天 |
| P1 | 缩略图生成 + 虚拟列表 | 2 天 |
| P1 | PhotoDetail + EXIF 展示 | 1 天 |
| P2 | 索引进度条 | 1 天 |
| P2 | 设置页 + 模型下载 | 2 天 |
| P2 | 性能优化 + 错误处理 | 2 天 |

**总计：~24 天（1 人）/ ~12 天（2 人）**

---

## 8. 技术风险与备选方案

| 风险 | 概率 | 应对方案 |
|---|---|---|
| node-llama-cpp 兼容性问题 | 中 | 使用 llama.cpp HTTP server + fetch 调用 |
| onnxruntime-node CoreML 不生效 | 中 | 降级到 CPU，或使用 Python sidecar |
| sqlite-vec Node 绑定问题 | 低 | 使用 better-sqlite3 扩展加载 |
| sharp HEIC 解码失败 | 低 | macOS 使用 sips 命令行工具 |
| 内存占用超预期 | 中 | 模型懒加载 + 卸载不用的模型 |
| 模型下载慢（中国用户） | 高 | 提供 ModelScope 镜像 |

---

*Vixel 技术文档 v0.3 · Electron 版本*
