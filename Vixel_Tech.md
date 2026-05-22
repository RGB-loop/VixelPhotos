# Vixel · 技术架构与选型文档
**版本 v0.2 · 2026-05 · Electron 版本**

> 本文档面向研发工程师，覆盖 Vixel **当前实际形态**（v0.2）的完整技术选型理由、系统架构、数据模型、核心模块实现指南与性能特征。
>
> **平台范围：** macOS first（HEIC/RAW、视频帧抽取走系统 `sips`/`ffmpeg`）；Linux/Windows 上图像与人脸/OCR 可用，HEIC/RAW 走 v0.3 计划的兜底路径。
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
| 图片处理 | **sharp**（libvips） | EXIF auto-rotate；HEIC/RAW 走 macOS sips |
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

### 3.1 数据库 Schema

```sql
-- library.db (SQLite + sqlite-vec, WAL mode)

-- 监控文件夹表
CREATE TABLE watched_folders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  path          TEXT NOT NULL UNIQUE,
  last_scan_at  DATETIME,
  recursive     BOOLEAN DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 照片主表
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
  deleted_at      DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_photos_hash ON photos(file_hash);
CREATE INDEX idx_photos_folder ON photos(folder_id);
CREATE INDEX idx_photos_status ON photos(embed_status, caption_status);

-- 索引任务队列
CREATE TABLE index_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id    INTEGER REFERENCES photos(id),
  task_type   TEXT NOT NULL,
  priority    INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  error_msg   TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_queue_status ON index_queue(status, priority DESC);

-- 图像向量表（sqlite-vec 虚表）
CREATE VIRTUAL TABLE image_vecs USING vec0(
  photo_id    INTEGER PRIMARY KEY,
  embedding   FLOAT[512]
);

-- Caption 表
CREATE TABLE captions (
  photo_id    INTEGER PRIMARY KEY REFERENCES photos(id),
  lang        TEXT DEFAULT 'zh',
  text        TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Caption 向量表
CREATE VIRTUAL TABLE caption_vecs USING vec0(
  photo_id    INTEGER PRIMARY KEY,
  embedding   FLOAT[768]
);

-- 全文搜索（FTS5）
CREATE VIRTUAL TABLE captions_fts USING fts5(
  text,
  content=captions,
  content_rowid=photo_id
);
```

### 3.2 better-sqlite3 + sqlite-vec 集成

```typescript
// main/db/index.ts
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export function createDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // 启用 WAL 模式
  db.pragma('journal_mode = WAL');

  // 加载 sqlite-vec 扩展
  sqliteVec.load(db);

  return db;
}

// 向量搜索示例
export function searchByVector(
  db: Database.Database,
  queryVec: Float32Array,
  limit: number = 50
): SearchResult[] {
  const stmt = db.prepare(`
    SELECT p.id, p.file_path, v.distance
    FROM image_vecs v
    JOIN photos p ON p.id = v.photo_id
    WHERE v.embedding MATCH ?
      AND v.k = ?
    ORDER BY v.distance
  `);

  return stmt.all(queryVec, limit);
}
```

### 3.3 文件布局

```
# macOS
~/Library/Application Support/Vixel/
├── library.db                     ← 主数据库
├── models/
│   ├── siglip2-vit-b16.onnx      ← 330MB
│   ├── embedding-gemma-300m.onnx  ← 280MB
│   └── qwen3.5-4b.Q4_K_M.gguf    ← 2.5GB
├── thumbnails/
│   └── {photo_id}.webp
└── logs/
    └── app.log

# Windows
C:\Users\{user}\AppData\Roaming\Vixel\
```

---

## 4. 核心模块实现

### 4.1 Electron 进程架构

```
┌─────────────────────────────────────────────────────┐
│                   Main Process                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │ IndexWorker │  │ FileWatcher │  │   Database  │ │
│  │ (Worker)    │  │ (chokidar)  │  │ (sqlite)    │ │
│  └─────────────┘  └─────────────┘  └─────────────┘ │
│         │                │                │         │
│         └────────────────┼────────────────┘         │
│                          │ IPC                      │
└──────────────────────────┼──────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────┐
│                   Renderer Process                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │  SearchBar  │  │  PhotoGrid  │  │   Settings  │ │
│  └─────────────┘  └─────────────┘  └─────────────┘ │
└──────────────────────────────────────────────────────┘
```

### 4.2 IPC 接口设计

```typescript
// shared/types.ts
export interface Photo {
  id: number;
  filePath: string;
  fileName: string;
  width: number;
  height: number;
  takenAt?: Date;
  caption?: string;
}

export interface SearchResult {
  photo: Photo;
  score: number;
}

export interface IndexProgress {
  total: number;
  done: number;
  currentFile: string;
  etaSeconds: number;
}

// preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  // 搜索
  search: (query: string, limit?: number) =>
    ipcRenderer.invoke('search', query, limit),

  // 文件夹管理
  addFolder: (path: string) =>
    ipcRenderer.invoke('add-folder', path),
  removeFolder: (id: number) =>
    ipcRenderer.invoke('remove-folder', id),
  getFolders: () =>
    ipcRenderer.invoke('get-folders'),

  // 照片详情
  getPhotoDetail: (id: number) =>
    ipcRenderer.invoke('get-photo-detail', id),
  getThumbnail: (id: number) =>
    ipcRenderer.invoke('get-thumbnail', id),

  // 进度监听
  onIndexProgress: (callback: (progress: IndexProgress) => void) => {
    ipcRenderer.on('index-progress', (_, progress) => callback(progress));
  },

  // 打开文件所在位置
  showInFinder: (filePath: string) =>
    ipcRenderer.invoke('show-in-finder', filePath),
});
```

### 4.3 索引管线

```typescript
// main/services/indexer.ts
import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';

export class Indexer extends EventEmitter {
  private worker: Worker;
  private db: Database.Database;
  private queue: IndexTask[] = [];
  private isProcessing = false;

  constructor(db: Database.Database) {
    super();
    this.db = db;
    this.worker = new Worker('./indexWorker.js');
    this.worker.on('message', this.handleWorkerMessage.bind(this));
  }

  async addToQueue(photoId: number, taskType: 'embed' | 'caption') {
    const priority = taskType === 'embed' ? 10 : 5;
    this.db.prepare(`
      INSERT INTO index_queue (photo_id, task_type, priority)
      VALUES (?, ?, ?)
    `).run(photoId, taskType, priority);

    this.processNext();
  }

  private async processNext() {
    if (this.isProcessing) return;

    const task = this.db.prepare(`
      SELECT * FROM index_queue
      WHERE status = 'pending'
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `).get();

    if (!task) return;

    this.isProcessing = true;
    this.db.prepare(`UPDATE index_queue SET status = 'processing' WHERE id = ?`)
      .run(task.id);

    this.worker.postMessage({ type: task.task_type, photoId: task.photo_id });
  }

  private handleWorkerMessage(msg: any) {
    if (msg.type === 'embed-done') {
      this.saveImageEmbedding(msg.photoId, msg.embedding);
      // 添加 caption 任务
      this.addToQueue(msg.photoId, 'caption');
    } else if (msg.type === 'caption-done') {
      this.saveCaption(msg.photoId, msg.caption, msg.embedding);
    }

    this.isProcessing = false;
    this.emitProgress();
    this.processNext();
  }
}
```

### 4.4 文件监听

```typescript
// main/services/watcher.ts
import chokidar from 'chokidar';
import path from 'path';

const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.heic', '.webp', '.cr2', '.nef', '.arw'];

export class FileWatcher {
  private watchers: Map<number, chokidar.FSWatcher> = new Map();
  private db: Database.Database;
  private indexer: Indexer;

  constructor(db: Database.Database, indexer: Indexer) {
    this.db = db;
    this.indexer = indexer;
  }

  watchFolder(folderId: number, folderPath: string) {
    const watcher = chokidar.watch(folderPath, {
      ignored: /(^|[\/\\])\../, // 忽略隐藏文件
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100,
      },
    });

    watcher
      .on('add', (filePath) => this.handleAdd(folderId, filePath))
      .on('change', (filePath) => this.handleChange(filePath))
      .on('unlink', (filePath) => this.handleRemove(filePath));

    this.watchers.set(folderId, watcher);
  }

  private async handleAdd(folderId: number, filePath: string) {
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) return;

    const stats = await fs.stat(filePath);
    const photoId = this.db.prepare(`
      INSERT INTO photos (folder_id, file_path, file_name, file_size, file_mtime)
      VALUES (?, ?, ?, ?, ?)
    `).run(folderId, filePath, path.basename(filePath), stats.size, stats.mtimeMs).lastInsertRowid;

    this.indexer.addToQueue(photoId as number, 'embed');
  }

  private async handleRemove(filePath: string) {
    this.db.prepare(`
      UPDATE photos SET deleted_at = CURRENT_TIMESTAMP WHERE file_path = ?
    `).run(filePath);
  }
}
```

### 4.5 搜索引擎

```typescript
// main/services/search.ts
export class SearchEngine {
  private db: Database.Database;
  private textEmbedding: TextEmbedding;

  async search(query: string, limit: number = 50): Promise<SearchResult[]> {
    // 1. 生成查询向量 (~25ms)
    const queryVec = await this.textEmbedding.encode(query);

    // 2. 双路检索
    const [imgResults, capResults] = await Promise.all([
      this.searchImageVecs(queryVec, limit * 2),
      this.searchCaptionVecs(queryVec, limit * 2),
    ]);

    // 3. RRF 融合
    const merged = this.rrfMerge(imgResults, capResults);

    return merged.slice(0, limit);
  }

  private rrfMerge(
    list1: SearchResult[],
    list2: SearchResult[],
    k: number = 60
  ): SearchResult[] {
    const scores = new Map<number, number>();

    list1.forEach((r, i) => {
      const score = 1 / (k + i + 1);
      scores.set(r.photo.id, (scores.get(r.photo.id) || 0) + score);
    });

    list2.forEach((r, i) => {
      const score = 1 / (k + i + 1);
      scores.set(r.photo.id, (scores.get(r.photo.id) || 0) + score);
    });

    const all = [...list1, ...list2];
    const seen = new Set<number>();
    const unique = all.filter(r => {
      if (seen.has(r.photo.id)) return false;
      seen.add(r.photo.id);
      return true;
    });

    return unique.sort((a, b) =>
      (scores.get(b.photo.id) || 0) - (scores.get(a.photo.id) || 0)
    );
  }
}
```

---

## 5. 性能设计

### 5.1 各硬件配置性能预估

| 硬件配置 | Embedding 速度 | Caption 速度 | 10 万张预计时间 |
|---|---|---|---|
| Apple M2（16GB） | ~20 张/秒 | ~0.2 张/秒 | Embed: 1.4h / Caption: 14h |
| Intel i7 + RTX 3060 | ~35 张/秒（CUDA） | ~0.5 张/秒 | Embed: 50m / Caption: 6h |
| Intel i5（无独显） | ~6 张/秒 | ~0.07 张/秒 | Embed: 4.5h / Caption: 40h |

### 5.2 内存占用预估

| 组件 | 内存占用 |
|---|---|
| Electron 基础 | ~150MB |
| React UI | ~50MB |
| SigLIP 2 模型 | ~400MB |
| EmbeddingGemma | ~350MB |
| Qwen3.5-4B (INT4) | ~3GB |
| SQLite + 缓存 | ~100MB |
| **总计** | **~4GB** |

> 建议最低配置：8GB RAM

### 5.3 优化策略

1. **模型懒加载** - Caption 模型在首次需要时才加载
2. **Worker 隔离** - AI 推理在 Worker 线程，不阻塞 UI
3. **批量处理** - Embedding 支持 batch inference
4. **虚拟列表** - PhotoGrid 使用 react-window
5. **缩略图缓存** - 预生成 WebP 缩略图

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
