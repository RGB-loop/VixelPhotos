# Changelog

All notable changes to Vixel will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Embedding: EmbeddingGemma 2 replaces SigLIP 2** as the single embedding
  model (768d, one space for text / image / video / audio). Model download
  grows from ~210 MB to ~640 MB (text + vision q4, audio q8).
- Quantization is selectable per encoder (q4 / q8) in Settings → 模型.
- Search is now 4-way RRF: image vectors + video segment vectors + OCR BM25 +
  filename. The query is encoded once and shared by both vector channels.

### Added
- **Video segment semantics with audio**: each video is cut into 32s
  segments (1 frame every 4s + audio track) and embedded as one vector per segment
  (`video_segments` / `video_segment_vecs`). Audio-less videos fall back
  to frames only.
- Video duration probing via `ffmpeg -i` (ffmpeg-static ships no ffprobe).

### Fixed
- Video frame extraction returned 0–1 frames for 29.97/59.94 fps footage
  (`select='not(mod(t,N))'` never hits whole seconds after `-ss`); now `fps=1/N`.
- Queuing `extract_frames` failed with a FOREIGN KEY error (`index_queue.photo_id`
  holds `videos.id` for that task type).
- Electron crashed (SIGTRAP) encoding video segments with ≥16 frames: the ONNX
  CPU arena requested a huge aligned block that PartitionAlloc refuses. The arena
  is now disabled.
- Videos were counted twice in search fusion (first-frame image vector + segment
  vector) and crowded out photos.
- `models:download` flattened `onnx/`, so transformers.js couldn't find weights.

### Removed
- External embedding API provider and its settings UI / IPC
  (`TEST_EMBEDDING_API`). Vixel is fully local.
- Caption BM25 channel from search (`captions_fts`, `caption_status`,
  the `caption` task type). Hand-written captions are display-only.
- All schema migrations. The product hasn't shipped, so delete
  `library.db` after schema changes instead of migrating.
- Per-frame photo rows for videos (only the first frame is kept as the
  video's representative photo).

## [0.1.0] - 2026-03-30

### Added
- Semantic photo search with natural language queries
- AI-powered caption generation (Qwen3.5-4B via llama.cpp)
- Face detection and recognition (SCRFD + InsightFace)
- Map view for GPS-tagged photos
- Photo deduplication via xxHash64
- Dark immersive UI with photo-first design

### Technical
- Electron + React + TypeScript architecture
- better-sqlite3 with FTS5 for hybrid search
- ONNX Runtime for face models
- Leaflet for map visualization
