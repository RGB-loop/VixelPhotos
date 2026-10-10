# Changelog

All notable changes to Vixel will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Performance
- Startup no longer re-reads and re-hashes the whole library: unchanged images
  and videos (same size / mtime, thumbnail present) are skipped before any IO or
  DB write; file reads are capped at 4 concurrent; offline-deleted videos are
  reconciled. Failed media stays in the task panel instead of re-running each launch.
- Index progress events are coalesced (≤ 4/s); the stats queries behind them no
  longer run per task / per video segment on the main thread.
- Grid paging uses new partial indexes (first page 25 ms → 0.3 ms on 50k rows);
  WAL `synchronous=NORMAL`, larger cache, mmap, in-memory temp store.
- One decode per photo shared by thumbnail / embed / face / OCR tasks.
- Face crops are cached on disk and served via `vixel://face/<id>`; thumbnails,
  face crops and sprites are served with immutable caching (`?v=<fileHash>`).
- Renderer: the grid no longer remounts on sidebar drag / slider / selection;
  index-time refetch throttled; Inspector fetches debounced; People view and map
  load thumbnails via protocol and render incrementally; markers added in bulk.
- Face / OCR ONNX sessions and main-process sharp use at most half the cores.

### Added
- `VIXEL_CAPTURE` (screenshot tour) and `VIXEL_RECORD` + `scripts/make-promo.mjs` (scripted
  real-UI promo recording with titles and captions).
- `VIXEL_PROFILE=1`: slow SQL / IPC / protocol / inference logging, main
  event-loop lag monitor, renderer long-task forwarding, end-of-session summary.
- `vixel doctor` and `vixel bench` CLI commands; `npm run test:db` DB smoke test.
  See `docs/debugging.md`.
- Search results carry `matchedBy`; the grid marks OCR-text and filename hits.
- Accessibility: focus ring, listbox/option grid semantics, dialog roles,
  tabbable sidebar, Home/End/PageUp/PageDown; model-not-ready warning in the status bar.
- Review reports under `docs/review/`.

### Fixed
- **Map crashed in production builds** and its CARTO tiles now require an API key: replaced
  with a bundled offline basemap (Natural Earth, public domain). Vixel makes no network requests.
- **HEIC and most RAW files never indexed on macOS**: sharp read their headers but couldn't
  decode them; they now go straight to the system codec. RAW falls back to the camera's
  embedded preview, which also brings RAW support to Linux / Windows.
- Search relevance gate now works on small libraries (pooled / robust baseline).
- **Text-in-image search never worked**: the PP-OCRv5 recognition model was paired with
  the v1 dictionary and its softmaxed output was softmaxed again. OCR is now validated at
  startup, runs automatically after indexing, reads full-resolution video frames, and
  existing results are re-scanned once.
- **Search no longer pads results**: semantic hits must clearly beat the query's library
  baseline; with no clear match, a few closest items are shown under an explicit notice.
- **People**: new media is face-scanned automatically; video faces are detected on
  full-resolution frames (most were previously too small/blurry to cluster).
- Leftover tasks were never resumed after restart; too-short clips were re-queued every launch.
- Image embedding failures were swallowed (task "done", no vector, silently
  re-queued every launch).
- Inference calls could hang forever; a stall watchdog now restarts the process.
- XSS via file names in map popups; Esc while editing a caption closed the detail view.
- Filename search treated `%` / `_` as wildcards.
- Photos imported mid-session stuck on a broken-image icon.
- CLI semantic search never loaded the model; CLI now opens the library read-only.

### Changed
- New app icon on the macOS icon grid; similar-items view only shows results ≥ 0.80 cosine.
- Release config: real repo URLs, meaningful folder-access prompts, `Vixel-<ver>` artifacts.

### Security
- Renderer sandbox enabled; renderer network access restricted to an allowlist
  (map tiles only); `showInFinder` accepts library paths only.

### Changed
- **Embedding: EmbeddingGemma 2 replaces SigLIP 2** as the single embedding
  model (768d, one space for text / image / video / audio).
- **EmbeddingGemma 2 runs on LiteRT-LM** (Google's official `.litertlm` build) through
  its C API via koffi, on the GPU (Metal on macOS; WebGPU on Windows) with CPU fallback.
  About 15× faster per image than the previous transformers.js / ONNX CPU path on an
  M-series Mac; model download ~465 MB. The ONNX embedding path and its quantization
  settings are removed; Settings → 模型 offers 自动 / GPU / CPU.
- Search is now 4-way RRF: image vectors + video segment vectors + OCR BM25 +
  filename. The query is encoded once and shared by both vector channels.

### Added
- App name and icon in development too: `npm run dev` (predev →
  `scripts/dev-bundle.mjs`) patches the dev Electron.app's CFBundleName /
  CFBundleDisplayName and icon, so the menu bar, Dock, ⌘Tab and About panel
  show "Vixel" with the Vixel icon. The userData directory is unchanged.
- **Person clustering rewrite** (`face/cluster.ts`, `face/clusterer.ts`):
  per-face quality score (size / yaw / sharpness); new faces join a person
  immediately only on a confident KNN vote, the rest are batch-clustered by
  centroid with a merge pass. Thresholds calibrated on LFW. Low-quality faces
  never seed a person. Named people are never auto-merged with each other.
- Person curation backend: merge suggestions, "不是此人" rejections, manual
  face assignment, hidden people (`face_rejections`, `person_dismissed_pairs`).
- **People view curation UI**: double-click to name (clearing a name returns
  the person to unnamed), ⌘/shift-click multi-select and drag-onto-person to
  merge, a "是同一个人吗？" suggestion card, per-face "不是此人" / "移给…" in the
  person detail "人脸" tab, hide / unhide people, live refresh after clustering.
  Merge suggestions no longer have an upper similarity bound.
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
- **UI freeze / spinning cursor while indexing**: embedding, face and OCR
  inference moved out of the main process into an Electron `utilityProcess`
  (nice 10). IPC round-trip during indexing went from p50 2.9 s / max 20 s to
  p95 5 ms / max 32 ms; a full index of the test set also got ~1/3 faster.
  The worker restarts transparently if it crashes.
- Face ANN index was never used: `face_vecs` was declared 128-d but
  MobileFaceNet outputs 512-d, so every insert was skipped and every KNN
  errored into a full scan. The table is rebuilt at 512-d and backfilled.
- **Face alignment produced black images**, so every face got the same
  embedding and people clustering was noise. Alignment is now a pure-JS
  similarity warp on an EXIF-oriented decode shared with detection. Existing
  faces / people are dropped and re-scanned once on upgrade
  (`FACE_PIPELINE_VERSION = 2`).
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
