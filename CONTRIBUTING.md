# Contributing to Vixel

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
# Clone and install
git clone https://github.com/your-org/vixel.git
cd vixel
npm install

# Run in development mode
npm run dev
```

### Prerequisites

- **Node.js** >= 18
- **macOS** (primary), Windows/Linux (community support)
- **Disk space**: ~4GB for AI models

### First Run

1. Launch with `npm run dev`
2. Open Settings (Cmd+,) → AI Model tab
3. Download caption model (~3.4GB)
4. Configure Embedding API endpoint (for semantic search)
5. Add a photo folder

## Project Structure

```
src/
├── core/          # Shared business logic (no Electron dependency)
│   ├── db.ts      # SQLite database
│   ├── search.ts  # Hybrid search engine
│   ├── indexer.ts  # Photo processing pipeline
│   ├── embedding/  # External embedding API client
│   ├── face/       # Face detection + recognition
│   └── llama/      # llama.cpp server manager
├── main/          # Electron main process (thin shell)
├── cli/           # CLI entry point
├── renderer/      # React frontend
├── preload/       # Electron IPC bridge
└── shared/        # Shared TypeScript types
```

## Key Commands

```bash
npm run dev          # Development mode with hot reload
npm run build        # Build Electron app
npm run build:cli    # Build CLI
npm run package:mac  # Package as .dmg
npm run typecheck    # TypeScript check
```

## Architecture Principles

- **Core modules have zero Electron dependency** — they work in both Electron and CLI contexts
- **All AI runs locally** — caption via llama.cpp, face detection via ONNX Runtime
- **SQLite is the single source of truth** — WAL mode for concurrent GUI + CLI access
- **Deduplication by file hash** — thumbnails, embeddings, captions are shared across duplicate files

## Making Changes

1. Create a branch from `main`
2. Make your changes
3. Ensure `npm run build` passes
4. Test the affected features manually
5. Submit a pull request

## Code Style

- TypeScript strict mode
- Functional components with hooks (React)
- Tailwind CSS for styling (dark theme, `surface-*` and `accent` color tokens)
- No unnecessary abstractions — keep it simple

## Reporting Issues

Please include:
- Steps to reproduce
- Expected vs actual behavior
- Console logs (if applicable)
- OS and Node.js version
