# Vixel

AI-powered local photo search. Private. Fast. No cloud.

Vixel is a desktop photo manager that uses on-device AI to understand your photos. Search with natural language, browse by location on a map, or find photos by the people in them — all without sending a single byte to the cloud.

## Features

- **Semantic Search** — Type "sunset over the ocean" and find matching photos. Hybrid search combines vector similarity, caption text matching, and filename search with RRF fusion.
- **AI Captions** — Local Qwen3.5-4B generates descriptions for every photo via llama.cpp. Configurable language (English / Chinese).
- **Face Recognition** — SCRFD detection + InsightFace embedding + Chinese Whispers clustering. Automatic person grouping with manual merge and naming.
- **Map View** — Photos with GPS data displayed on an interactive dark map (Leaflet + CartoDB). Marker clustering for large collections.
- **Deduplication** — xxHash64 file hashing. Duplicate photos across folders share thumbnails, embeddings, and captions. Delete a folder, shared resources survive.
- **Time Filtering** — Date range picker for browsing photos by period.
- **Similar Photos** — Click any photo to see visually similar ones ranked by embedding distance.
- **Dark Immersive UI** — Photo-first design. Compact grid, glass effects, minimal chrome.

## Quick Start

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build
```

### First Launch

1. **Download the local model** (~190 MB):
   ```bash
   npm run models:download
   ```
   This pulls SigLIP 2 base/16-256 (multilingual image-text CLIP) into `resources/models/siglip2/`.
2. Add photo folders in the **Photo Folders** tab.
3. Photos are indexed automatically (thumbnail → embedding).

That's it — no cloud, no API keys. Face models (SCRFD + MobileFaceNet, ~8 MB) are committed to the repo.

### Face Recognition

Switch to the **People** view (person icon in title bar) and click **Start Face Scan**.

### Advanced: External Embedding API (optional fallback)

If the bundled model cannot run on your hardware, Settings → "高级：外部 Embedding API" lets you point Vixel at an OpenAI-compatible multimodal embedding endpoint (e.g. a self-hosted Qwen3-VL-Embedding server).

## Architecture

```
Electron App (single Node.js process)
├── Main Process
│   ├── SQLite + sqlite-vec (better-sqlite3)
│   │     • photos, faces, people, embeddings, captions
│   │     • image_vecs (vec0 ANN, 768-dim)
│   │     • FTS5 captions full-text
│   ├── File Watcher (chokidar)
│   ├── Indexer (thumbnail → embedding → face)
│   ├── Search Engine (vector + BM25 + filename, RRF fusion)
│   └── ONNX Runtime
│         • SigLIP 2 (image + text embedding, via @huggingface/transformers)
│         • SCRFD (face detection)
│         • MobileFaceNet (face embedding)
└── Renderer Process (React)
    ├── Photo Grid · Map · People · Photo Detail
```

### Data Storage

```
~/Library/Application Support/vixel/   # macOS
├── library.db              # SQLite: photos, faces, people, embeddings, captions
├── thumbnails/             # WebP thumbnails keyed by file hash
└── embedding-config.json   # Only present if user opted into API fallback
```

The actual model weights live inside the app bundle at
`Vixel.app/Contents/Resources/models/`, not in user data.

### Tech Stack

- **Framework**: Electron + electron-vite + React + TypeScript + Tailwind CSS
- **Database**: better-sqlite3 + sqlite-vec (vector ANN) + FTS5 (full-text)
- **Image Processing**: sharp (libvips, EXIF auto-rotate)
- **AI**: onnxruntime-node + @huggingface/transformers (SigLIP 2, SCRFD, MobileFaceNet)
- **Maps**: Leaflet + leaflet.markercluster
- **File Hashing**: xxhash-wasm

## Development

```
src/
├── main/                        # Electron main process
│   ├── db/index.ts              # Database schema and queries
│   ├── index.ts                 # App entry, IPC handlers
│   └── services/
│       ├── watcher.ts           # File system monitoring
│       ├── indexer.ts           # Processing pipeline
│       ├── search.ts            # Hybrid search engine
│       ├── embedding/           # External embedding API client
│       ├── llama/               # llama.cpp server manager
│       ├── face/                # Face detection, embedding, clustering
│       └── downloadManager.ts   # Model download manager
├── renderer/src/                # React frontend
│   ├── App.tsx                  # Main app with view switching
│   └── components/
│       ├── PhotoGrid.tsx        # Photo grid with status badges
│       ├── PhotoDetail.tsx      # Detail view with EXIF, caption, similar
│       ├── MapView.tsx          # Leaflet map with GPS photos
│       ├── PeopleView.tsx       # Face clustering and person management
│       ├── SearchBar.tsx        # Search input with debounce
│       ├── IndexProgress.tsx    # Status bar with progress
│       ├── FolderManager.tsx    # Folder and settings management
│       └── ModelStatus.tsx      # AI model download and config
└── shared/types.ts              # Shared TypeScript types
```

## License

MIT
