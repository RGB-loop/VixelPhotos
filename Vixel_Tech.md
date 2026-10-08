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
>   （**2026-10 已被 EmbeddingGemma 2 取代**，见下）
> - 新增 PaddleOCR v5 全本地 OCR
> - 人脸匹配从 O(N) JS 余弦切换到 sqlite-vec ANN
> - 新增视频抽帧（ffmpeg-static + 关键帧 → 复用图像流水线）
> - FTS5 中文搜索：jieba 分词替代字符级 unicode61
>
> **重大变更（2026-10 重构，EmbeddingGemma 2）：**
> - 所有 embedding 任务统一到 **EmbeddingGemma 2**（文本/图像/音频/视频同一 768 维空间），
>   删除 SigLIP 2 provider 与外部 Embedding API provider —— 纯本地，无 API 兜底
> - 视频从"逐帧当照片"改为 **32s 片段语义向量**（每 4s 一帧的帧序列 + 音轨 → 单向量），
>   新表 `video_segments` + `video_segment_vecs`
> - 新增音轨抽取（`src/core/audio/extract.ts`，ffmpeg → mono 16 kHz f32le）
> - 搜索：删除 caption BM25 通道；新增视频片段向量通道；query 只编码一次
> - 人脸（MobileFaceNet）与 OCR（PaddleOCR）不是 embedding 任务，保持不变

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
│                        │  │  │Embedding-│ │PaddOCR│ │SCRFD +   │ │ │    │
│                        │  │  │Gemma 2   │ │ det/  │ │MobileFace│ │ │    │
│                        │  │  │txt/img/  │ │ rec/  │ │Net       │ │ │    │
│                        │  │  │aud/video │ │ cls   │ │          │ │ │    │
│                        │  │  └──────────┘ └──────┘ └──────────┘ │ │    │
│                        │  └──────────────────────────────────────┘ │    │
│                        │  ┌──────────────────────────────────────┐ │    │
│                        │  │      ffmpeg-static (subprocess)      │ │    │
│                        │  │  32s 片段：8 帧 + 音轨 → 片段向量    │ │    │
│                        │  └──────────────────────────────────────┘ │    │
│                        │  ┌──────────────────────────────────────┐ │    │
│                        │  │    better-sqlite3 + sqlite-vec       │ │    │
│                        │  │  photos | image_vecs(768)            │ │    │
│                        │  │  video_segments | video_segment_vecs │ │    │
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
  ↑ 无 Python，无 llama-server，无外部 API（API provider 已删除）
```

### 1.2 技术栈总览

| 层级 | 选型 | 备注 |
|---|---|---|
| 应用框架 | **Electron 33+** | 单进程；不再依赖 llama-server / Python 子进程 |
| 构建工具 | **electron-vite** | 主+预加载+渲染三套 entry |
| UI 框架 | **React 18 + TypeScript + Tailwind CSS** | — |
| 多模态 Embedding | **EmbeddingGemma 2**（ONNX，文本/视觉 q4、音频 q8） | 768 维；文本 / 图像 / 音频 / 视频同一空间；多语言 |
| ONNX 运行时 | **onnxruntime-node + @huggingface/transformers** | CoreML / CPU EP；Transformers.js 负责 tokenizer + processor |
| OCR（图内文字） | **PaddleOCR v5**（det + cls + rec ONNX） | RapidAI 社区导出；charset 用 ppocr_keys_v1 |
| 人脸检测 | **SCRFD-2.5G-KPS**（InsightFace ONNX） | ~3 MB |
| 人脸 embedding | **MobileFaceNet**（ONNX） | 128 维，L2 归一化 |
| 人脸聚类 | **sqlite-vec ANN** | 取代 v0.1 的 O(N) JS 余弦扫描 |
| 视频 / 音频抽取 | **ffmpeg-static** | 32s 片段，每 4s 一帧（8 帧）+ mono 16 kHz 音轨；时长解析 `ffmpeg -i` stderr |
| 向量存储 | **sqlite-vec**（vec0 虚表） | image_vecs(768) + video_segment_vecs(768) + face_vecs(128) |
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

### 2.1 多模态检索（语义搜索）：EmbeddingGemma 2

| 维度 | 取值 |
|---|---|
| 模型 ID | `onnx-community/embeddinggemma-2-ONNX` |
| 规模 | 740M（文本 270M + 视觉 170M + 音频 300M，模块化编码器） |
| 模态 | 文本 / 图像 / 音频 / 视频，**统一嵌入空间** |
| 嵌入维度 | **768**（Matryoshka 可截断到 512/256/128；当前用满 768） |
| 上下文 | 8K token |
| 默认量化 | 文本 q4、视觉 q4、音频 q8 —— 合计 ~620 MB |
| 量化可调 | 设置页按编码器选 q4 / q8，写入 `embedding-config.json` |

模型文件（每个 `.onnx` 都配一个必需的 `.onnx_data` 外部权重文件）：

| 文件 | 内容 | 大小 |
|---|---|---|
| `onnx/model_q4.onnx` | 文本编码器 + 多模态融合（session `model`） | ~174 MB |
| `onnx/vision_encoder_q4.onnx` | 视觉编码器（图像 + 视频帧） | ~109 MB |
| `onnx/audio_encoder_quantized.onnx` | 音频编码器（q8 → `_quantized` 后缀） | ~340 MB |
| `processor_config.json` | `video_processor.max_frames = 32`，每帧 140 soft token | — |

#### 为什么从 SigLIP 2 换到 EmbeddingGemma 2

| 维度 | SigLIP 2 base（旧） | EmbeddingGemma 2（现） |
|---|---|---|
| 模态 | 文本 + 图像 | 文本 + 图像 + **音频 + 视频** |
| 视频表示 | 每帧一个向量，帧之间互不知情 | 一个片段（帧序列 + 音轨）→ **单向量** |
| 音频 | 无 | 原生音频编码器 |
| 体积 | ~190 MB | ~620 MB |
| 推理成本 | 低 | 更高（待测） |

取舍：体积 ×3、推理更慢，换来的是"视频里**听到**的内容也能搜"和片段级语义
（"狗在沙滩上叫"这种跨帧 + 跨模态的 query）。产品未上线，无存量向量兼容负担，
所以一次性替换，不保留 SigLIP 2 / 外部 API 双轨。

#### 集成

```typescript
// src/core/embedding/providers/gemma2Provider.ts（简化）
import { AutoTokenizer, AutoProcessor, AutoModel, RawImage, RawVideo, env }
  from '@huggingface/transformers'   // ≥ 4.3.1

env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = bundledModelsDir  // <Resources>/models

const tokenizer = await AutoTokenizer.from_pretrained('gemma2')
const processor = await AutoProcessor.from_pretrained('gemma2')
// dtype 按 session 名指定；键写错会静默回退到设备默认 dtype
const model = await AutoModel.from_pretrained('gemma2', {
  dtype: { model: 'q4', vision_encoder: 'q4', audio_encoder: 'q8' },
})

// 文本 query：必须带任务前缀
const ti = tokenizer('task: query | text: 海边日落', { padding: true, truncation: true })
const { sentence_embedding } = await model(ti)          // 768d，已 L2 归一化

// 图像 / 音频 / 视频：processor(text, images, audio, videos)
await model(await processor(null, rawImage))                    // 图像
await model(await processor(null, null, samples16k))             // 音频
await model(await processor(null, null, audio, new RawVideo(frames, durationSec)))  // 视频片段
```

预热仍在 main 启动后 2s fire-and-forget 触发；冷启动与单次推理耗时**待测**。

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

### 2.4 视频片段语义：ffmpeg-static + EmbeddingGemma 2

| 维度 | 配置 |
|---|---|
| 二进制来源 | `ffmpeg-static` npm（per-platform prebuilt，~80 MB；不带 ffprobe） |
| 时长 | `probeDurationMs()`：解析 `ffmpeg -i` stderr 的 `Duration:`，30s 超时 |
| 切片 | **32s** 一段（`-ss` 在 `-i` 前快速 seek，`-t` 限长） |
| 帧 | 每 4s 一帧（ffmpeg `fps=1/4`），8 帧，长边 ≤ 512 px JPEG |
| 音轨 | `src/core/audio/extract.ts`：ffmpeg → mono 16 kHz f32le |
| 编码 | 帧序列 + 音轨 → `encode({ type: 'multimodal', video, audio })` → 单向量；无音轨退化为纯视频 |
| 存储 | `video_segments`（时间区间）+ `video_segment_vecs`（vec0, 768d） |
| 编排 | indexer task 类型 `extract_frames` |

为什么是 32s / 8 帧：processor 上限 32 帧，但 vision encoder 开销随帧数超线性
增长 —— 实测 M 系列 CPU 上 8 帧 ≈ 14s、16 帧 ≈ 43s、32 帧 ≈ 141s（峰值 3.9 GB），
1 fps 对长视频不可用。8 帧 × 140 token + 32s 音频（~800 token）≈ 2K，远低于 8K 上下文。

ONNX session 关闭了 CPU BFCArena（`enableCpuMemArena: false`）：arena 扩容会一次申请
超大对齐块，Electron 的 PartitionAlloc 分配失败直接 SIGTRAP，纯 Node 下不复现。

代表帧：首段首帧落成 `segment_0_0ms.jpg`，作为一行 `photos`（`video_id`,
`frame_time_ms = 0`）入库，走缩略图 + 图像 embed —— 网格展示、搜索结果落点、
"相似照片"入口都靠它。它**在编码前**写入，所以模型未就绪时视频也会出现在网格里。

单片段失败（抽帧 / 编码异常）只跳过该片段，不让整个视频失败；失败数记进任务的
`error_msg`（如 `3/86 个片段失败`），任务面板可见。全部片段失败才算任务失败。

**纯音频**复用同一套表和 `extract_frames` 任务，按 `videos.media_kind` 分支：
每个 32s 片段只抽音轨 → `encode({ type: 'audio' })`。代表图由
`extractCoverOrWaveform()` 生成：先取内嵌封面（`-map 0:v? -frames:v 1`），
没有则 `showwavespic` 画波形（accent 色 `#d4a574`）。代表图只做缩略图、
不做图像 embed —— 波形向量会污染图片搜索。

**播放**：`vixel://media/<videoId>` 手写 HTTP Range（206 + `Content-Range`，
`createReadStream({start, end})`），不走 `net.fetch(file://)` —— 后者 Range 不可靠，
`<video>` seek 依赖它。Chromium 解不了的编码（如 mpeg4 avi）触发 `onError`，
UI 回退到"在系统播放器中打开"。

---

### 2.5 删除的两个候选（v0.1 计划过但未保留）

| 模型 | 计划用途 | 删除原因 |
|---|---|---|
| Qwen3.5-4B + llama.cpp | 自动 caption | 3.4 GB 下载 + 秒级推理，对"灌进 FTS5 让人能搜到"严重过设计；OCR + 图文 CLIP 双通道已覆盖搜索需求 |
| EmbeddingGemma-300M | 独立文本 embedding | SigLIP 2 文本编码器与图像编码器**同空间**，query 直接走它就够；多一个文本模型是冗余 |

> **2026-10 复议**：上表第二行针对的是 **EmbeddingGemma v1（300M，纯文本）**，
> 当时"冗余"的判断前提是"它只能编码文本，而 SigLIP 2 已经覆盖了文本+图像"。
> Google 于 2026-10-06 发布 **EmbeddingGemma 2**，前提已不成立：
>
> - 它是 740M 的**多模态**模型（文本 270M + 视觉 170M + 音频 300M，模块化），
>   四种模态**统一嵌入空间**——跟 SigLIP 2 不是一个品类，不是"多一个文本模型"。
> - 基础输出 **768 维**，与本文档的 `EMBEDDING_DIM = 768` 一致，MRL 可截断到 512/256/128。
> - **8K 上下文**（约 58 帧视频 / 5.5 分钟音频），能把一个视频片段编码成**单向量**，
>   而非现在"每帧一个向量、彼此不知情"的做法。
> - **音频编码器**是 Vixel 当前完全空白的能力（全库零 audio 代码）。
>
> 结论：v1 的否决理由**继续成立**（换纯文本模型仍是冗余），但**不再能用来否决 v2**。
>
> **已采纳（2026-10）**：`onnx-community/embeddinggemma-2-ONNX` 提供了 ONNX 导出，
> `@huggingface/transformers` 4.3.1 原生支持 `EmbeddingGemma2Model` /
> `EmbeddingGemma2Processor`，原先的部署阻塞项解除。EmbeddingGemma 2 现在是唯一
> embedding 模型，见 §2.1 / §2.4。

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
  face_status     TEXT DEFAULT 'pending',
  video_id        INTEGER REFERENCES videos(id), -- null=独立照片；否则是视频代表帧
  frame_time_ms   INTEGER,                    -- 视频代表帧时间戳
  deleted_at      DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_photos_folder    ON photos(folder_id);
CREATE INDEX idx_photos_status    ON photos(embed_status);
CREATE INDEX idx_photos_deleted   ON photos(deleted_at);
CREATE INDEX idx_photos_file_hash ON photos(file_hash);
CREATE INDEX idx_photos_video     ON photos(video_id);

-- 索引任务队列
CREATE TABLE index_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id    INTEGER REFERENCES photos(id),  -- task_type='extract_frames' 时是 videos.id
  task_type   TEXT NOT NULL,                  -- thumbnail/embed/face/ocr/extract_frames
  priority    INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  error_msg   TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_queue_status ON index_queue(status, priority DESC);

-- Caption（用户手写，详情页展示；不建 FTS，不参与搜索）
CREATE TABLE captions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash   TEXT NOT NULL UNIQUE,
  lang        TEXT DEFAULT 'en',
  text        TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 图像向量（EmbeddingGemma 2，768d；视频代表帧也在这里）
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
CREATE VIRTUAL TABLE image_ocr_fts USING fts5(text, tokenize='unicode61');

-- INSERT/UPDATE 触发器调用 jiebatok(new.text)
CREATE TRIGGER image_ocr_ai AFTER INSERT ON image_ocr BEGIN
  INSERT INTO image_ocr_fts(rowid, text) VALUES (new.id, jiebatok(new.text));
END;
-- (... 对应 _ad / _au)

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
  media_kind   TEXT NOT NULL DEFAULT 'video',  -- 'video' | 'audio'
  deleted_at   DATETIME,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_videos_folder ON videos(folder_id);
CREATE INDEX idx_videos_hash   ON videos(file_hash);
-- frame_count 现在表示片段数；duration_ms 缺失时由 indexer 用 probeDurationMs 补齐

-- 视频片段（32s 一段；EmbeddingGemma 2 多模态向量）
CREATE TABLE video_segments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id     INTEGER NOT NULL REFERENCES videos(id),
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER NOT NULL,
  file_hash    TEXT NOT NULL,  -- hash(视频 hash + 时间区间)，dedup 用
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_video_segments_video ON video_segments(video_id);
CREATE INDEX idx_video_segments_hash  ON video_segments(file_hash);

-- 片段向量 ANN 索引 + segment_id → rowid 映射
CREATE VIRTUAL TABLE video_segment_vecs USING vec0(embedding FLOAT[768]);
CREATE TABLE video_segment_vec_map (
  rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id  INTEGER NOT NULL UNIQUE REFERENCES video_segments(id)
);

-- 内部状态（KV）
CREATE TABLE meta_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- 已记录的 keys:
--   last_backup_at   (备份调度节流)
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
const queryVec = await encodeQuery(query)          // EmbeddingGemma 2，只编码一次
const vec      = searchByVector(queryVec, limit * 2)        // image_vecs KNN
const segments = searchVideoSegments(queryVec, limit * 2)   // video_segment_vecs KNN，每视频取最佳片段
const ocrBm25  = db.searchByOcr(query, limit * 2)           // image_ocr_fts BM25
const fileName = db.searchByFileName(query, limit * 2)      // photos.file_name LIKE
// 片段命中 → 该视频代表帧的 fileHash，与照片共用 id 空间
const fused = rrfFuse([vec, segmentHits, ocrBm25, fileName], 60)
```

手写 caption 不参与搜索（caption BM25 通道与 captions_fts 已删除）。

`rrfFuse` 是 `src/core/fusion.ts` 里的纯函数（带 7 个单测）。

### 3.4 文件布局

```
# macOS（生产）
/Applications/Vixel.app/Contents/Resources/models/
├── gemma2/          (~620 MB, 文本/视觉 q4 + 音频 q8 ONNX + .onnx_data, 打进 DMG)
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
│   └── {videoHash}/segment_0_0ms.jpg  ← 每个视频的代表帧
└── embedding-config.json          ← 各编码器量化档位（q4/q8）
```

> 注：模型权重**不在用户目录**，因此卸载应用 = 删除模型；只删用户数据
> 不会影响搜索能力。

### 3.5 启动顺序

```
initDatabase(dbPath)
  1. open DB + WAL + busy_timeout
  2. sqlite-vec.load
  3. db.function('jiebatok', ...)        ← 注册 UDF
  4. db.exec(SCHEMA)                     ← CREATE ... IF NOT EXISTS，幂等
  5. wal_checkpoint(PASSIVE)
  6. cleanupStaleVecMap                  ← image_vec_map 孤立条目清理
```

产品未发布，原则上**不做 schema 迁移**：schema 变更后直接删掉开发库 `library.db` 重建。
例外是 `videos.media_kind`：用 `hasColumn` 判断后 `ALTER TABLE ADD COLUMN`，幂等。
启动时还会 `pruneDoneTasks()` 删除已完成的队列行。
注意 SigLIP 2 与 EmbeddingGemma 2 同为 768d，旧库不会报维度错误，但向量空间不同，必须删库。

---

## 4. 核心模块实现

### 4.1 进程模型

v0.2 是**单 Electron 进程**：main 同时负责 UI 路由、SQLite、ONNX 推理。
没有 Worker 线程、没有 llama-server 子进程、没有 Python。视频抽帧 / 音轨
抽取是唯一的外部子进程（ffmpeg）—— 短命的 spawn-and-wait，不常驻。

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
│  │ EmbeddingGemma 2 / SCRFD / MobileFace / OCR  │ │
│  └──────────────────────────────────────────────┘ │
│        │   spawn (fire-and-wait)                  │
│        ▼                                          │
│  ┌──────────────┐                                 │
│  │ ffmpeg-static│  仅在抽视频帧 / 音轨时启动       │
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
  search(query, limit?, { dateFrom?, dateTo?, kind? }?)  // 结果可带 segment: {startMs, endMs}
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

  // 模型状态 / 量化档位（EmbeddingGemma 2，纯本地）
  getModelStatus() / getEmbeddingConfig() / setEmbeddingConfig(quantPatch)
  openSourceVideo(videoId)

  // 音视频
  getMediaDetail(videoId)  // → { kind, durationMs, width, height, filePath, fileSize, segments }

  // 进度 / 任务面板
  onIndexProgress(cb)  // → { stage, totalPhotos, ..., paused, current?, queue }
  getIndexPaused() / setIndexPaused(paused)
  getTaskOverview() / retryFailedTasks(ids?) / clearFailedTasks()
}
```

> 历史 channel（`download-model` / `download-llama-server` /
> `init-caption-generator` / `regenerate-caption` 等）已在 PR2 全部删除；
> `test-embedding-api` 随 API provider 在 2026-10 重构中删除，
> renderer 不再持有对应回调。

### 4.3 Indexer 任务流水线

```
file enters watcher
  │
  ├─ image  → addPhoto → enqueue('thumbnail', 'embed')
  └─ video / audio → addVideo(kind) → enqueue('extract_frames')
                     （内容未变且已扫过 / 已在队列中 → 跳过，避免每次启动重编码）

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
                            getEmbeddingService().encodeImage(decoded)   ← EmbeddingGemma 2
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
                            清理旧 segments + 旧帧 photo 行 + 帧目录
                            probeDurationMs()        ← 无时长 → frameCount=0 返回
                            for 每个 32s 片段:
                              extractKeyframes({startSec, durationSec, 每 4s, 8 帧})
                              首段：首帧 → segment_0_0ms.jpg → addPhoto(videoId, 0)
                                    → enqueue('thumbnail', 'embed')（编码前写入）
                              extractAudioTrack()    ← 失败则纯视频
                              encode(multimodal) / encodeVideo()
                              → db.saveVideoSegment(videoId, startMs, endMs, hash, vec)
                            frameCount = 片段数

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
| `.mp3 .m4a .aac .wav .flac .ogg .opus` | `audio` 路径，同上（`media_kind = 'audio'`） |
| 其它 | 忽略 |

视频条目的 `file_hash` 用 `(path|size|mtime)` 轻量哈希，避免 watcher 在
GB 级文件上读取全部字节阻塞。代表帧的内容 hash 在 indexer 抽帧后计算；
片段 hash = hash(视频 hash + 时间区间)。

chokidar 启动时对已有文件逐个触发 `add`。`handleAddVideo` 在轻量哈希未变、
且 `frame_count` 非空（已扫过；坏文件为 0）或已有 pending / processing 的
`extract_frames` 任务时不再入队 —— 否则每次启动都会清掉片段从头重编码。

### 4.5 搜索引擎

```typescript
// src/core/search.ts （简化）
async search(query, limit, options) {
  if (!query.trim()) return getRecentPhotos(limit) // 含日期过滤分支

  const queryVec = await this.encodeQuery(query)        // 模型未就绪 → null，向量通道为空
  const vec      = this.searchByVector(queryVec, limit * 2)
  const segments = this.searchVideoSegments(queryVec, limit * 2) // 每视频最佳片段
  const ocrBm25  = db.searchByOcr(query, limit * 2)       // image_ocr_fts BM25
  const fileName = db.searchByFileName(query, limit * 2)  // LIKE %query%

  // 片段 → 视频代表帧（第一个未删除的帧 photo）的 fileHash
  const segmentHits = segments.flatMap((seg) => {
    const frame = db.getFramePhotosByVideo(seg.videoId).find((p) => !p.deletedAt)
    return frame ? [{ fileHash: frame.fileHash, distance: seg.distance }] : []
  })

  const fused = rrfFuse([
    [...vec].sort((a, b) => a.distance - b.distance),
    segmentHits,
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
| processEmbedding | ~3.4 s / 张 | EmbeddingGemma 2 视觉 q4（旧 SigLIP 2 为 ~80 ms CPU / ~25 ms CoreML） |
| processFace（按需） | ~30 ms / 张（不含 detect） | SCRFD + MobileFaceNet |
| processOcr（按需） | ~150–400 ms / 张 | PaddleOCR det+rec |
| 单视频片段（32s） | ~14 s | ffmpeg 抽 8 帧 + 音轨 + 一次多模态编码 |

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
| EmbeddingGemma 2（q4/q4/q8 + tokenizer + processor） | 待测（权重 ~620 MB，预计显著高于旧 SigLIP 2 的 ~400 MB） |
| onnxruntime + face / OCR sessions | ~150 MB |
| SQLite WAL + caches | < 100 MB |
| **稳态总计** | **待测**（旧 SigLIP 2 版本 < 1 GB） |

视频抽帧 / 音轨抽取期间 ffmpeg 短暂吃额外内存，结束后释放。

### 5.4 已应用的优化

1. **模型预热**：jieba + EmbeddingGemma 2 在启动后 fire-and-forget 预加载
2. **SQL UDF `deterministic: true`**：FTS5 触发器密集写入时缓存 jieba 结果
3. **decodeImage 单读**：避免对 HEIC 重复触发 sharp metadata 探测
4. **缩略图共享**：按 file_hash 复用，重复文件零额外存储
5. **vec0 ANN**：所有向量搜索（image + video segment + face）走 vec0
6. **query 只编码一次**：图像通道与视频片段通道共享同一个 query 向量
7. **CoreML execution provider 优先**：Apple Silicon 上 ONNX 3-4x 加速

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
│   ├── main/index.ts              # Electron 入口 + IPC handlers + vixel:// 协议
│   ├── preload/index.ts           # contextBridge 暴露 window.api
│   ├── shared/types.ts            # main / renderer 共享类型
│   ├── cli/index.ts               # 命令行入口
│   ├── core/
│   │   ├── db.ts                  # SQLite schema + 全部查询
│   │   ├── watcher.ts             # chokidar；classifyMedia(image/video)
│   │   ├── indexer.ts             # 任务队列 + 各阶段 handler（含视频片段流水线）
│   │   ├── search.ts              # 4-way RRF
│   │   ├── fusion.ts              # 纯函数 rrfFuse()
│   │   ├── backup.ts              # SQLite 在线备份 + 轮换
│   │   ├── embedding/
│   │   │   ├── index.ts           # EmbeddingService 单例 + embedding-config.json
│   │   │   ├── types.ts           # EmbeddingInput / 维度常量
│   │   │   └── providers/gemma2Provider.ts  # EmbeddingGemma 2（唯一 provider）
│   │   ├── video/extract.ts       # 片段抽帧 + probeDurationMs
│   │   ├── audio/extract.ts       # 音轨抽取（mono 16 kHz f32le）
│   │   ├── face/                  # SCRFD + MobileFaceNet + ANN 匹配
│   │   ├── ocr/                   # PaddleOCR det / cls / rec
│   │   ├── image/decode.ts        # sharp + sips / heic-convert 兜底
│   │   └── text/                  # jieba 分词 + FTS5 query 转义
│   └── renderer/src/              # React 前端
│       ├── App.tsx
│       └── components/            # SearchBar / PhotoGrid / PhotoDetail / MapView /
│                                  # PeopleView / FolderManager / IndexProgress / ModelStatus
├── scripts/download-models.mjs    # 模型下载（gemma2 / paddleocr / face）
├── resources/models/              # 开发期模型目录
├── electron.vite.config.ts
└── package.json
```

### 7.3 开发任务拆解

| 优先级 | 任务 | 预估工时 |
|---|---|---|
| P0 | 项目骨架 + electron-vite 配置 | 1 天 |
| P0 | SQLite + sqlite-vec 集成 | 1 天 |
| P0 | 照片导入 + 文件扫描 + EXIF 解析 | 2 天 |
| P0 | chokidar 文件监听 | 1 天 |
| P0 | ~~SigLIP 2 ONNX 集成~~ | ~~2 天~~ **已被 EmbeddingGemma 2 取代** |
| P0 | EmbeddingGemma 2 provider（文本 / 图像 / 音频 / 视频） | ✅ 已完成 |
| P0 | 视频 32s 片段 + 音轨抽取 + video_segments 存储 | ✅ 已完成 |
| P0 | 搜索：删 caption 通道，加视频片段通道，query 单次编码 | ✅ 已完成 |
| P0 | 删除外部 Embedding API provider；设置页改为量化档位选择 | ✅ 已完成 |
| P0 | gemma2Provider 端到端冒烟（真实模型文件 + 多模态编码） | 待做 |
| P1 | 检索质量验证（~200 图 + ~30 中文 query）；性能 / 内存实测回填 §5 | 待做 |
| P1 | 模型未就绪时视频片段任务应失败重试，而非静默完成 | 待做 |
| P0 | 向量存取 + 基础搜索 | 2 天 |
| P0 | 搜索 UI + 结果展示 | 2 天 |
| P1 | ~~EmbeddingGemma 文本向量化~~ | ~~1 天~~ **已删除** |
| P1 | ~~Qwen3.5-4B Caption 生成~~ | ~~3 天~~ **已删除** |
| P1 | 多路搜索 + RRF 融合 | 1 天 |
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
