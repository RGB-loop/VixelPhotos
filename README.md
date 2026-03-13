# Vixel - AI-Powered Local Photo Search

Vixel 是一个本地 AI 驱动的照片搜索应用，支持语义搜索和自然语言查询。所有数据和 AI 模型都在本地运行，保护您的隐私。

## 快速开始

### 环境要求

- **Node.js** >= 18
- **macOS** (Apple Silicon 或 Intel) / Windows / Linux
- **磁盘空间**: ~4GB（用于 AI 模型）
- **内存**: 建议 8GB+

### 安装依赖

```bash
npm install
```

### 开发模式运行

```bash
npm run dev
```

### 生产构建

```bash
# 构建
npm run build

# 打包 (macOS)
npm run build:mac

# 打包 (Windows)
npm run build:win

# 打包 (Linux)
npm run build:linux
```

### 首次使用

1. 启动应用后，点击右上角 **设置** 按钮
2. 切换到 **AI 模型** 标签页
3. 点击 **下载全部** 下载所需的模型文件（约 3GB）
4. 下载完成后点击 **启动 AI 服务**
5. 返回 **照片文件夹** 标签页，添加要索引的照片目录

---

## 技术架构

### 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Electron App                              │
├─────────────────────────────────────────────────────────────────┤
│  Renderer Process (React)              Main Process (Node.js)   │
│  ┌─────────────────────┐              ┌─────────────────────┐   │
│  │ - SearchBar         │    IPC       │ - FileWatcher       │   │
│  │ - PhotoGrid         │◄────────────►│ - Indexer           │   │
│  │ - PhotoDetail       │              │ - SearchEngine      │   │
│  │ - FolderManager     │              │ - Database (SQLite) │   │
│  │ - ModelStatus       │              │ - LlamaServer       │   │
│  └─────────────────────┘              └─────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                                │
                                                ▼
                                   ┌─────────────────────┐
                                   │   llama-server      │
                                   │   (localhost:8847)  │
                                   │                     │
                                   │  Qwen3-VL-4B Model  │
                                   └─────────────────────┘
```

### 核心组件

| 组件 | 作用 |
|------|------|
| `FileWatcher` | 监听文件夹变化，自动发现新照片 |
| `Indexer` | 处理照片索引：生成缩略图、提取 embedding、生成 caption |
| `SearchEngine` | 混合搜索：图像相似度 + 文本语义搜索 |
| `LlamaServer` | 管理本地 LLM 服务进程 |
| `CaptionGenerator` | 调用 LLM 生成图片描述 |
| `DownloadManager` | 下载和管理模型文件 |

---

## LLM 集成详解

### 使用的模型

Vixel 使用 **Qwen3-VL-4B** 视觉语言模型来理解图片内容：

| 文件 | 大小 | 用途 |
|------|------|------|
| `Qwen3VL-4B-Instruct-Q4_K_M.gguf` | 2.5 GB | 主模型（语言理解） |
| `mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf` | 454 MB | 视觉编码器（图像理解） |

### 推理引擎

使用 [llama.cpp](https://github.com/ggml-org/llama.cpp) 作为本地推理引擎：

- **版本**: b8300+
- **特性**: 支持 Metal (macOS)、CUDA (NVIDIA)、CPU 推理
- **API**: 提供 OpenAI 兼容的 HTTP API

### LLM 启动流程

```
用户点击"启动 AI 服务"
        │
        ▼
┌───────────────────┐
│ CaptionGenerator  │
│     .init()       │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│   LlamaServer     │
│     .start()      │
└───────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────┐
│  spawn llama-server process                        │
│                                                    │
│  llama-server                                      │
│    -m Qwen3VL-4B-Instruct-Q4_K_M.gguf             │
│    --mmproj mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf  │
│    --host 127.0.0.1                                │
│    --port 8847                                     │
│    -c 4096        # context size                   │
│    -ngl 99        # GPU layers (use all)           │
└───────────────────────────────────────────────────┘
        │
        ▼
  等待 "server is listening" 输出
        │
        ▼
   服务就绪，可以处理请求
```

### 图片描述生成流程

当新照片被添加时：

```
新照片添加
    │
    ▼
┌─────────────────┐
│   FileWatcher   │  检测到新文件
└─────────────────┘
    │
    ▼
┌─────────────────┐
│    Indexer      │
└─────────────────┘
    │
    ├──► 1. 生成缩略图 (sharp)
    │
    ├──► 2. 提取图像 embedding (CLIP/SigLIP)
    │
    └──► 3. 生成 AI 描述 (Qwen3-VL)
              │
              ▼
        ┌─────────────────────────────────────┐
        │        CaptionGenerator             │
        │                                     │
        │  1. 读取原图                         │
        │  2. 缩放到 768x768                   │
        │  3. 转换为 base64                    │
        │  4. 发送到 llama-server             │
        └─────────────────────────────────────┘
              │
              ▼
        ┌─────────────────────────────────────┐
        │     HTTP POST to llama-server       │
        │     /v1/chat/completions            │
        │                                     │
        │  {                                  │
        │    "messages": [{                   │
        │      "role": "user",                │
        │      "content": [                   │
        │        {                            │
        │          "type": "image_url",       │
        │          "image_url": {             │
        │            "url": "data:image/..."  │
        │          }                          │
        │        },                           │
        │        {                            │
        │          "type": "text",            │
        │          "text": "Describe this..." │
        │        }                            │
        │      ]                              │
        │    }]                               │
        │  }                                  │
        └─────────────────────────────────────┘
              │
              ▼
        LLM 返回描述文本
              │
              ▼
        ┌─────────────────────────────────────┐
        │  4. 对描述文本生成 embedding (E5)    │
        │  5. 保存到 SQLite 数据库             │
        └─────────────────────────────────────┘
```

### API 交互示例

llama-server 提供 OpenAI 兼容的 API：

```bash
# 测试文本对话
curl http://127.0.0.1:8847/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-vl-4b",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 50
  }'

# 测试图片描述 (需要 base64 编码的图片)
curl http://127.0.0.1:8847/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-vl-4b",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/4AAQ..."}},
        {"type": "text", "text": "Describe this image in one sentence."}
      ]
    }],
    "max_tokens": 100
  }'

# 健康检查
curl http://127.0.0.1:8847/health
```

---

## 搜索原理

### 双通道搜索

Vixel 使用两种搜索方式并合并结果：

```
用户输入: "海边的日落"
        │
        ├────────────────────────────────────┐
        │                                    │
        ▼                                    ▼
┌───────────────────┐              ┌───────────────────┐
│  图像语义搜索      │              │  文本语义搜索      │
│                   │              │                   │
│  1. 用 CLIP 编码   │              │  1. 用 E5 编码     │
│     查询文本       │              │     查询文本       │
│                   │              │                   │
│  2. 与所有图片的   │              │  2. 与所有 caption │
│     image_vec     │              │     的 caption_vec │
│     计算余弦相似度  │              │     计算余弦相似度  │
└───────────────────┘              └───────────────────┘
        │                                    │
        ▼                                    ▼
   图片相似度排名                        文本相似度排名
        │                                    │
        └────────────┬───────────────────────┘
                     │
                     ▼
              ┌─────────────┐
              │  合并排序    │
              │  去重返回    │
              └─────────────┘
```

### Embedding 模型

| 模型 | 维度 | 用途 |
|------|------|------|
| `Xenova/siglip-base-patch16-224` | 768 | 图像 embedding |
| `Xenova/multilingual-e5-small` | 384 | 文本/Caption embedding |

---

## 数据存储

所有数据存储在用户数据目录：

```
~/Library/Application Support/vixel/    # macOS
%APPDATA%/vixel/                         # Windows

├── library.db          # SQLite 数据库
├── thumbnails/         # 缩略图缓存
│   ├── 1.webp
│   ├── 2.webp
│   └── ...
├── models/             # AI 模型文件
│   ├── Qwen3VL-4B-Instruct-Q4_K_M.gguf
│   └── mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf
└── bin/                # llama-server 可执行文件
    ├── llama-server
    └── *.dylib
```

### 数据库结构

```sql
-- 监控的文件夹
watched_folders (id, path, last_scan_at, recursive, created_at)

-- 照片元数据
photos (id, folder_id, file_path, file_name, width, height,
        taken_at, embed_status, caption_status, ...)

-- AI 生成的描述
captions (photo_id, lang, text, created_at)

-- 图像向量 (CLIP embedding)
image_vecs (photo_id, embedding BLOB)

-- 描述向量 (E5 embedding)
caption_vecs (photo_id, embedding BLOB)
```

---

## 开发说明

### 项目结构

```
src/
├── main/                    # Electron 主进程
│   ├── index.ts             # 入口，IPC 处理
│   ├── db/                  # 数据库操作
│   └── services/
│       ├── watcher.ts       # 文件监听
│       ├── indexer.ts       # 索引处理
│       ├── search.ts        # 搜索引擎
│       ├── llamaServer.ts   # LLM 服务管理
│       ├── captionGenerator.ts  # 图片描述生成
│       ├── downloadManager.ts   # 模型下载
│       ├── imageEmbedding.ts    # 图像 embedding
│       └── textEmbedding.ts     # 文本 embedding
├── preload/                 # 预加载脚本
│   └── index.ts             # IPC 桥接
├── renderer/                # React 前端
│   └── src/
│       ├── App.tsx
│       └── components/
│           ├── SearchBar.tsx
│           ├── PhotoGrid.tsx
│           ├── PhotoDetail.tsx
│           ├── FolderManager.tsx
│           ├── ModelStatus.tsx
│           └── IndexProgress.tsx
└── shared/
    └── types.ts             # 共享类型定义
```

### 技术栈

- **框架**: Electron + electron-vite
- **前端**: React + TypeScript + Tailwind CSS
- **数据库**: better-sqlite3
- **图像处理**: sharp
- **ML 推理**: @huggingface/transformers (embedding) + llama.cpp (LLM)
- **文件监听**: chokidar

---

## 常见问题

### Q: 模型下载失败怎么办？

可以手动下载模型文件并放到对应目录：

```bash
# 下载模型
wget https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/Qwen3VL-4B-Instruct-Q4_K_M.gguf
wget https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf

# 移动到模型目录
mv *.gguf ~/Library/Application\ Support/vixel/models/
```

### Q: AI 服务启动超时？

首次启动时模型加载较慢（需要 30-60 秒），请耐心等待。如果持续超时：

1. 检查模型文件是否完整
2. 确保有足够内存（建议 8GB+）
3. 查看控制台日志排查错误

### Q: 如何查看 llama-server 日志？

开发模式下日志会输出到终端。也可以直接运行 llama-server 测试：

```bash
"/Users/xxx/Library/Application Support/vixel/bin/llama-server" \
  -m "/Users/xxx/Library/Application Support/vixel/models/Qwen3VL-4B-Instruct-Q4_K_M.gguf" \
  --mmproj "/Users/xxx/Library/Application Support/vixel/models/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf" \
  --host 127.0.0.1 --port 8848 -c 2048
```

### Q: 搜索结果不准确？

- 确保 AI 服务已启动（照片需要 AI 生成描述才能进行语义搜索）
- 新添加的照片需要时间索引
- 查看设置中的索引进度

---

## License

MIT
