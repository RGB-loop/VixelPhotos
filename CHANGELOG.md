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
- **Standalone audio** (`.mp3 .m4a .aac .wav .flac .ogg .opus`): cut into 32s
  segments, each embedded from the audio track alone, stored in the same
  `videos` / `video_segments` tables (`videos.media_kind = 'audio'`). The grid
  tile is the embedded cover art, or a rendered waveform when there is none
  (thumbnail only, no image vector).
- **In-app playback** via `vixel://media/<id>` with HTTP Range (206) streaming,
  so `<video>` / `<audio>` can seek. Formats Chromium can't decode fall back
  to "open in system player".
- **Media browsing rewrite**: grid cards show kind + duration and a "命中 m:ss"
  pill for segment hits; hovering a video plays a muted preview from the hit
  segment. The detail view opens a player that auto-seeks to the hit, has a
  32s segment timeline (hit highlighted, click to seek), Space / J / L / M
  shortcuts, and a 媒体信息 panel (duration, resolution, indexed segments).
- Search results carry the matching segment (`SearchResult.segment`), and a
  全部 / 图片 / 视频 / 音频 filter sits in the title bar.
- **Task drawer** (click the status bar): current file with per-segment
  progress and ETA, overall image / segment progress, upcoming queue by type,
  failed tasks with error messages and retry / clear. Partial segment failures
  are recorded on the task. Finished tasks are pruned at startup.
- Pause / resume background indexing from the status bar. The paused state
  survives restarts; a long video stops between segments and resumes from
  the next one.
- **Appearance**: 跟随系统 / 浅色 / 深色 (Settings → 通用). Colours are CSS
  variables behind the Tailwind tokens; the choice drives `nativeTheme.themeSource`
  so native menus, scrollbars and the window background follow. Full-screen
  detail and Quick Look stay dark.
- **Settings window** (⌘,): a standalone window with 通用 / 文件夹 / AI 模型
  tabs, replacing the modal folder manager. Folder changes are broadcast to
  every window.
- **Grid density** (G, or the status-bar toggle): 沉浸式 (tight gaps, only
  the duration badge) is the browsing default; 信息式 (rank, hit pill,
  file name always shown) is the default for search results.
- **Sidebar 搜索 group**: recent searches (kept once a query settles and has
  results; typing continuations replace the previous entry; last 8 kept, 5
  shown) and saved searches (☆ in the search field). Clicking a row re-runs
  it; hover × removes it.
- **Hover scrubbing**: indexing a video also renders a 12-frame sprite
  (`video_frames/<hash>/sprite.jpg`, square 240 px tiles). Moving the mouse
  across a card scrubs through it, with the position line and timestamp
  following. Videos indexed earlier get their sprite generated on first
  hover (`vixel://sprite/<id>`, serialised); without a sprite the card
  falls back to the muted playback preview.
- **Video segment semantics with audio**: each video is cut into 32s
  segments (1 frame every 4s + audio track) and embedded as one vector per segment
  (`video_segments` / `video_segment_vecs`). Audio-less videos fall back
  to frames only.
- Video duration probing via `ffmpeg -i` (ffmpeg-static ships no ffprobe).

### Fixed
- Every launch re-queued and re-encoded all videos / audio from scratch
  (chokidar's initial scan fires `add` for every file). Unchanged media that
  was already scanned or is already queued is now skipped.
- Video frame extraction uses VideoToolbox hardware decode on macOS (4K HEVC
  32s segment: 22.8s → 2.8s), falling back to software decode on failure.
- Removing a folder left its videos, segment vectors and `extract_frames`
  tasks behind, so indexing kept running after the folder was gone.
- Background indexing of a large video folder pegged every core. ONNX now
  uses half the cores (`intraOpNumThreads`), ffmpeg runs with `-threads 2`
  at nice 10, and `extract_frames` is queued at priority 6 (after image
  embed / face) so photos become searchable before long videos finish.
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
