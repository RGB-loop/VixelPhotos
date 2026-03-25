# Vixel CLI

Vixel is a local AI-powered photo search app. Use the CLI to query your photo library programmatically.

## Prerequisites

The Vixel desktop app must have been launched at least once to create the photo library database. Photos must be indexed before they can be searched.

## Commands

### Search photos
```bash
vixel search "sunset over ocean" --json --limit 10
vixel search "cat" --date-from 2024-01-01 --date-to 2024-12-31
```
Combines semantic vector search, caption text matching, and filename search.

### Photo details
```bash
vixel info 42 --json
```
Returns EXIF data, AI caption, detected faces, and file paths.

### Find similar photos
```bash
vixel similar 42 --json --limit 5
```
Finds visually similar photos by embedding distance.

### People (face recognition)
```bash
vixel people --json
vixel people photos 1 --json --limit 20
```

### Library statistics
```bash
vixel stats --json
```
Returns photo count, index status, people count, queue status.

### View or update captions
```bash
vixel caption 42 --json
vixel caption 42 --set "A cat sleeping on a sofa"
```

### List watched folders
```bash
vixel folders --json
```

## Output Format

All commands support `--json` for structured JSON output suitable for parsing. Without `--json`, output is human-readable text.

## Notes

- The CLI is read-only for most operations (search, info, similar, people, stats, folders)
- Caption updates (`--set`) and people naming write to the database
- The CLI can run concurrently with the GUI app (SQLite WAL mode)
- If the GUI is indexing photos, CLI searches still work (concurrent reads)
