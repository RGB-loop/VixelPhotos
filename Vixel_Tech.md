# Vixel · 技术架构与选型文档
**版本 v0.3 · 2026-03-13 · Electron 版本**

> 本文档面向研发工程师，覆盖 Vixel MVP 的完整技术选型理由、系统架构、数据模型、核心模块实现指南与性能预估。
>
> **MVP 范围：** macOS only。架构设计兼顾跨平台，核心逻辑与平台相关逻辑分离，Windows 支持为 v2 目标。

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
┌──────────────────────────────────────────────────────────────────┐
│                         Vixel App (Electron)                      │
│  ┌────────────────┐    ┌──────────────────────────────────┐       │
│  │   Renderer     │    │        Main Process              │       │
│  │   (React)      │◄──►│  ┌──────────────────────────┐   │       │
│  └────────────────┘    │  │   AI Pipeline Service    │   │       │
│         │         IPC  │  │  ┌──────────┐ ┌────────┐ │   │       │
│         ▼              │  │  │ SigLIP 2 │ │Qwen3.5 │ │   │       │
│  ┌────────────────┐    │  │  │ (ONNX)   │ │(llama) │ │   │       │
│  │  Search UI     │    │  │  └──────────┘ └────────┘ │   │       │
│  │  (瀑布流展示)   │    │  └──────────────────────────┘   │       │
│  └────────────────┘    │              │                   │       │
│                        │  ┌───────────▼──────────────┐   │       │
│                        │  │   SQLite + sqlite-vec    │   │       │
│                        │  │   (better-sqlite3)       │   │       │
│                        │  └──────────────────────────┘   │       │
│                        │              │                   │       │
│                        │  ┌───────────▼──────────────┐   │       │
│                        │  │   File Watcher Service   │   │       │
│                        │  │   (chokidar)             │   │       │
│                        │  └──────────────────────────┘   │       │
│                        └──────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────────┘
  ↑ 零网络请求    ↑ 所有数据本地    ↑ 照片文件原位引用，不复制
```

### 1.2 技术栈总览

| 层级 | 选型 | 理由 |
|---|---|---|
| 应用框架 | **Electron 33+** | 生态成熟，跨平台稳定，开发效率高 |
| 构建工具 | **electron-vite** | 快速开发，HMR 支持，开箱即用 |
| UI 框架 | **React 18 + TypeScript** | 生态成熟，开发效率高 |
| 样式方案 | **Tailwind CSS** | 快速开发，一致性好 |
| 图像 Embedding | **SigLIP 2 ViT-B/16**（ONNX） | 86M 参数，端侧最佳精度/速度比 |
| Caption 生成 | **Qwen3.5-4B**（node-llama-cpp） | 原生多模态，200+ 语言 |
| 文本 Embedding | **EmbeddingGemma-300M**（ONNX） | 300M 参数，100+ 语言 |
| 向量存储 | **sqlite-vec**（SQLite 扩展） | 单文件，零依赖，支持 ANN 检索 |
| 元数据存储 | **better-sqlite3** | 同步 API，性能好，与 sqlite-vec 兼容 |
| 模型推理（ONNX） | **onnxruntime-node** | 跨平台，支持 CoreML / CUDA |
| 模型推理（LLM） | **node-llama-cpp** | llama.cpp Node 绑定，Metal / CUDA 支持 |
| 文件监听 | **chokidar** | 成熟的跨平台文件监听方案 |
| EXIF 解析 | **exifr** | 快速，支持多种格式 |
| 图片处理 | **sharp** | 基于 libvips，高性能 |

---

## 2. AI 模型选型详解

### 2.1 图像 Embedding：SigLIP 2

#### 为什么选 SigLIP 2 而不是 CLIP？

| 模型 | 零样本准确率 | 参数量 | 端侧推理速度 |
|---|---|---|---|
| CLIP ViT-L/14 | 75.3% | 307M | ~120ms/张（CPU） |
| **SigLIP 2 ViT-B/16 ★** | **79.1%（+3.8%）** | **86M** | **~35ms/张（CPU）** |
| MobileCLIP S2 | 74.8% | 35M | ~15ms/张（CPU） |

#### 集成方式

```typescript
// main/services/embedding.ts
import * as ort from 'onnxruntime-node';

class ImageEmbedding {
  private session: ort.InferenceSession;

  async init(modelPath: string) {
    this.session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['coreml', 'cpu'], // macOS 优先用 CoreML
    });
  }

  async encode(imageBuffer: Buffer): Promise<Float32Array> {
    // 预处理：resize 到 224x224，归一化
    const tensor = await this.preprocess(imageBuffer);
    const results = await this.session.run({ pixel_values: tensor });
    return results.image_embeds.data as Float32Array; // 512 维
  }
}
```

- 输入：224×224 RGB 图像张量 → 输出：512 维 float32 向量
- 模型文件大小：~330MB

---

### 2.2 Caption 生成：Qwen3.5-4B

#### 运行配置

```typescript
// main/services/caption.ts
import { LlamaModel, LlamaContext, LlamaChatSession } from 'node-llama-cpp';

class CaptionGenerator {
  private model: LlamaModel;
  private context: LlamaContext;

  async init(modelPath: string) {
    this.model = new LlamaModel({ modelPath });
    this.context = new LlamaContext({
      model: this.model,
      contextSize: 2048,
      gpuLayers: 35, // Apple Silicon 全量 offload
    });
  }

  async generate(imageBase64: string, lang: string = 'zh'): Promise<string> {
    const session = new LlamaChatSession({ context: this.context });
    const prompt = `Describe this photo in ${lang}. Be concise but specific. Include: main subjects, actions, setting, mood. Maximum 2 sentences.`;

    return await session.prompt(prompt, {
      images: [imageBase64],
      maxTokens: 100,
    });
  }
}
```

#### 预期生成速度

| 硬件 | 速度 | Caption 耗时 |
|---|---|---|
| Apple M2 | ~8 tokens/s | 3-5 秒/张 |
| Intel i7 (CPU) | ~2 tokens/s | 10-15 秒/张 |
| RTX 3060 (GPU) | ~25 tokens/s | 1-2 秒/张 |

---

### 2.3 文本 Embedding：EmbeddingGemma-300M

```typescript
// main/services/textEmbedding.ts
import * as ort from 'onnxruntime-node';

class TextEmbedding {
  private session: ort.InferenceSession;
  private tokenizer: any; // transformers.js tokenizer

  async encode(text: string): Promise<Float32Array> {
    const tokens = this.tokenizer.encode(text);
    const results = await this.session.run({ input_ids: tokens });
    return results.embeddings.data as Float32Array; // 768 维
  }
}
```

- 输入：用户搜索文本 → 输出：768 维 float32 向量
- 延迟：~25ms/次
- 支持 100+ 语言

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
