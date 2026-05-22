# Vixel

AI-powered local photo & video search. Private. Fast. No cloud.

Vixel is a desktop photo manager that uses on-device AI to understand your
photos and videos. Search with natural language, find text inside images,
browse by location on a map, or find photos by the people in them — all
without sending a single byte to the cloud.

## Features

- **Semantic Search** — Type "sunset over the ocean" and find matching
  photos. Four-way hybrid: SigLIP 2 image-text vectors + caption BM25 +
  OCR text BM25 + filename, fused with RRF. Works in 30+ languages
  out of the box.
- **OCR (image text search)** — Local PaddleOCR v5 scans screenshots,
  receipts, posters, and signs. Find "2024 财报" inside a screenshot
  even if no one labelled it.
- **Face Recognition** — SCRFD detection + MobileFaceNet embedding +
  sqlite-vec ANN clustering. Automatic person grouping, scales to
  50k+ faces. Manual merge and naming.
- **Video Search** — Drop in `.mp4 / .mov / .webm / .mkv / .avi` and
  Vixel extracts keyframes (every 5s, max 20 frames per video) and
  runs them through the full image pipeline. Videos appear in search
  results with a ▶ time-code badge.
- **HEIC / RAW** — On macOS, HEIC + CR2/CR3/NEF/ARW/DNG/RAF/ORF/RW2
  are decoded via system `sips`. EXIF (timestamps, GPS) preserved.
- **Map View** — Photos with GPS data on an interactive dark map
  (Leaflet + CartoDB). Marker clustering for large collections.
- **Deduplication** — xxHash64 content hashing. Same photo in two
  folders shares thumbnail / embedding / OCR / face. Delete a folder,
  shared resources survive.
- **Time Filtering** — Date range picker.
- **Similar Photos** — Click any photo to find visually similar ones
  ranked by embedding distance.
- **Dark Immersive UI** — Photo-first design. Compact grid, glass
  effects, minimal chrome.

## Quick Start

```bash
# Install dependencies
npm install

# Download local models (~210 MB total — SigLIP 2 + PaddleOCR)
npm run models:download

# Run in development
npm run dev

# Production package
npm run build && npm run package
```

### First Launch

1. Add photo folders in the **Photo Folders** tab.
2. Photos are indexed automatically (thumbnail → embedding).
3. (Optional) Open Settings → click **开始扫描图内文字** to run OCR.
4. (Optional) Switch to **People** view → **Start Face Scan**.

No cloud, no API keys. All models live inside the app bundle.

### Advanced: External Embedding API (optional fallback)

If the bundled SigLIP 2 cannot run on your hardware, Settings →
"高级：外部 Embedding API" lets you point Vixel at an OpenAI-compatible
multimodal embedding endpoint (e.g. a self-hosted Qwen3-VL-Embedding).

## Architecture

```
Electron App (single Node.js process)
├── Main Process
│   ├── SQLite + sqlite-vec (better-sqlite3)
│   │   ├─ photos, faces, people, videos
│   │   ├─ image_vecs   (vec0 ANN, 768d)
│   │   ├─ face_vecs    (vec0 ANN, 128d)
│   │   ├─ captions     + captions_fts   (FTS5 + jiebatok UDF)
│   │   └─ image_ocr    + image_ocr_fts  (FTS5 + jiebatok UDF)
│   ├── File Watcher (chokidar)              ← images + videos
│   ├── Indexer pipeline
│   │   thumbnail → embed → face → ocr + extract_frames
│   ├── Search Engine (4-way RRF)
│   ├── ONNX Runtime (onnxruntime-node + @huggingface/transformers)
│   │   ├─ SigLIP 2 base/16-256             (image + text, ~190 MB)
│   │   ├─ PaddleOCR v5 (det + cls + rec)   (~12 MB)
│   │   ├─ SCRFD-2.5G-KPS                   (face detection, ~3 MB)
│   │   └─ MobileFaceNet                    (face embedding, ~5 MB)
│   └── ffmpeg-static (subprocess)           ← video keyframe extraction
└── Renderer Process (React)
    └── PhotoGrid · MapView · PeopleView · PhotoDetail
```

### Data Storage

```
# Inside the app bundle (read-only, ships with DMG)
Vixel.app/Contents/Resources/models/
├── siglip2/             # ~190 MB ONNX (q8)
├── paddleocr/           # ~12 MB ONNX + charset
├── scrfd_2.5g_kps.onnx
└── mobilefacenet.onnx

# User data
~/Library/Application Support/vixel/   # macOS
├── library.db                # SQLite (WAL)
├── thumbnails/<hash>.webp    # shared, hash-keyed
├── video_frames/<vh>/<ms>.jpg
└── embedding-config.json     # only when user opts into API fallback
```

### Tech Stack

- **Framework**: Electron + electron-vite + React + TypeScript + Tailwind
- **Database**: better-sqlite3 + sqlite-vec (vec0 ANN) + FTS5
- **Chinese segmentation**: @node-rs/jieba via a `jiebatok` SQL UDF
- **Image processing**: sharp (libvips, EXIF auto-rotate) + system `sips`
  fallback for HEIC/RAW on macOS
- **AI**: onnxruntime-node + @huggingface/transformers
  (SigLIP 2, PaddleOCR v5, SCRFD, MobileFaceNet)
- **Video**: ffmpeg-static (per-platform prebuilt binary)
- **Maps**: Leaflet + leaflet.markercluster
- **File hashing**: xxhash-wasm

### Format Support Matrix

| Platform | JPG/PNG/WebP/GIF/TIFF/BMP/AVIF | HEIC/HEIF | RAW (CR2/NEF/ARW/...) | Video (mp4/mov/...) |
|---|---|---|---|---|
| macOS | ✅ sharp | ✅ sips | ✅ sips | ✅ ffmpeg |
| Linux / Windows | ✅ sharp | ✅ heic-convert (libheif WASM) | ⚠️ v0.4+ (libraw-wasm under evaluation) | ✅ ffmpeg |

## Development

```
src/
├── main/index.ts              # Electron entry, IPC handlers
├── preload/index.ts           # contextBridge surface
├── shared/types.ts            # IPC types shared by main + renderer
├── core/
│   ├── db.ts                  # SQLite schema + all queries
│   ├── watcher.ts             # chokidar; classifyMedia(image/video)
│   ├── indexer.ts             # Task queue + per-stage handlers
│   ├── search.ts              # 4-way RRF
│   ├── fusion.ts              # Pure rrfFuse()  (7 unit tests)
│   ├── embedding/             # SigLIP 2 (onnx) + optional API provider
│   ├── face/                  # SCRFD + MobileFaceNet + ANN matcher
│   ├── ocr/                   # PaddleOCR det / cls / rec / orchestrator
│   ├── video/                 # ffmpeg-static keyframe extractor
│   ├── image/decode.ts        # sharp + sips fallback decoder
│   └── text/
│       ├── tokenize.ts        # jieba helper (4 tests)
│       └── fts-query.ts       # FTS5 query escape (9 tests)
├── renderer/src/
│   ├── App.tsx
│   └── components/
│       ├── PhotoGrid.tsx      # Virtualized grid + ▶ video badge
│       ├── PhotoDetail.tsx    # EXIF + caption + video provenance
│       ├── MapView.tsx        # Leaflet map
│       ├── PeopleView.tsx     # Face clusters
│       ├── SearchBar.tsx
│       ├── IndexProgress.tsx  # Status bar
│       ├── FolderManager.tsx
│       └── ModelStatus.tsx    # Settings + OCR scan trigger
└── cli/index.ts               # `vixel` CLI for scripting
```

### Tests

```bash
npm test         # 24 unit tests in vitest, <1s
```

Covered: RRF fusion ranking, jieba tokenizer, FTS5 query escaping,
image decoder routing.

## License

MIT
