# Changelog

All notable changes to Vixel will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
