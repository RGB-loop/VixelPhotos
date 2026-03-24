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

1. Open **Settings** (gear icon or Cmd+,)
2. In **AI Model** tab, click **Download All** to get the caption model (~3.4GB)
3. Configure **Embedding API** endpoint (for semantic search)
4. Add photo folders in the **Photo Folders** tab
5. Photos will be indexed automatically (thumbnail → embedding → caption)

### Face Recognition

Switch to the **People** view (person icon in title bar) and click **Start Face Scan**. Face models (SCRFD + InsightFace, ~16MB) are bundled with the app.

## Architecture

```
Electron App
├── Main Process (Node.js)
│   ├── SQLite Database (better-sqlite3)
│   ├── File Watcher (chokidar)
│   ├── Indexer (thumbnail → embedding → face → caption pipeline)
│   ├── Search Engine (vector + BM25 + filename, RRF fusion)
│   ├── llama.cpp Server (Qwen3.5-4B caption generation)
│   ├── ONNX Runtime (SCRFD face detection + InsightFace embedding)
│   └── Embedding API Client (external multimodal embedding)
└── Renderer Process (React)
    ├── Photo Grid (search results, status badges)
    ├── Map View (Leaflet + marker clustering)
    ├── People View (face clusters, merge, rename)
    └── Photo Detail (EXIF, caption edit, similar photos, locations)
```

### Data Storage

```
~/Library/Application Support/vixel/   # macOS
├── library.db              # SQLite: photos, faces, people, embeddings, captions
├── thumbnails/             # WebP thumbnails keyed by file hash
├── models/                 # Downloaded AI models (Qwen3.5-4B, mmproj)
├── bin/                    # llama-server binary
├── embedding-config.json   # Embedding API configuration
└── caption-config.json     # Caption language preference
```

### Tech Stack

- **Framework**: Electron + electron-vite
- **Frontend**: React + TypeScript + Tailwind CSS
- **Database**: better-sqlite3 (SQLite with FTS5)
- **Image Processing**: sharp
- **AI**: llama.cpp (captioning), onnxruntime-node (face detection/embedding)
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
