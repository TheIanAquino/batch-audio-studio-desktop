# Batch Audio Studio Desktop

Self-contained Electron + React + Python bridge app for chunked audio generation and timeline editing.

## What is included

- Electron desktop shell (`electron/`)
- React app (`src/`)
- Internal Python bridge (`bridge/`)
- Packaging config for macOS (`electron-builder`)

No parent-workspace Python dependency is required.

## Startup Modes

The app supports three runtime modes:

- Mock mode (default if no backend URLs are configured): generates local placeholder WAV outputs so the app is usable without external TTS services.
- Local TTS mode: uses your local TTS API via `BATCH_AUDIO_LOCAL_API_BASE`.
- Modal mode: uses your remote Modal endpoint via `BATCH_AUDIO_MODAL_API_BASE`.

Mode selection in the UI controls which configured backend is used for generation.

## Quick Start

1. Install Node deps:
   - `npm install`
2. Copy env template:
   - `cp .env.example .env.local`
3. Configure `.env.local` based on your use case:
   - Mock only: leave both backend URLs empty
   - Local TTS: set `BATCH_AUDIO_LOCAL_API_BASE`
   - Modal: set `BATCH_AUDIO_MODAL_API_BASE`
4. Run the app:
   - `npm run dev`

## Setup Examples

### 1) Mock mode only (no external dependencies)

`.env.local`:

```env
BATCH_AUDIO_ENABLE_MOCK_TTS=true
```

### 2) Local TTS setup (example: local Qwen3-TTS API)

`.env.local`:

```env
BATCH_AUDIO_LOCAL_API_BASE=http://127.0.0.1:42003
BATCH_AUDIO_ENABLE_MOCK_TTS=true
```

### 3) Modal setup

`.env.local`:

```env
BATCH_AUDIO_MODAL_API_BASE=https://your-modal-endpoint.modal.run
BATCH_AUDIO_ENABLE_MOCK_TTS=true
```

## Environment Variables

- `BATCH_AUDIO_LOCAL_API_BASE`: local backend URL. Leave unset to avoid local backend dependency.
- `BATCH_AUDIO_MODAL_API_BASE`: Modal backend URL.
- `BATCH_AUDIO_CONFIG_DIR`: bridge state directory (`studio.db`, prompt cache, logs).
- `BATCH_AUDIO_OUTPUT_ROOT`: generated run/audio output directory.
- `BATCH_AUDIO_LOCAL_VOICE_STORE`: optional local voice store directory for local prompt assets.
- `BATCH_AUDIO_ENABLE_MOCK_TTS`: enable/disable mock fallback when no external backend is available.

`.env` and `.env.local` are loaded by the bridge at startup.

## Required vs Optional Dependencies

- Required:
  - Node.js + npm
  - Python 3 (for local bridge process)
- Optional:
  - Local TTS server (for local generation)
  - Modal endpoint (for remote generation)
  - Local voice store path via `BATCH_AUDIO_LOCAL_VOICE_STORE`

## Distribution / Packaging

Current packaging output options:

- `npm run dist`: builds a macOS `.dmg` installer
- `npm run dist:zip`: builds zip artifact
- `npm run dist:dir`: builds unpacked app directory
- `npm run dist:all`: builds dmg + zip

Packaging bundles:

- `bridge/` Python source
- `.tmp/bridge-runtime` Python runtime (built via `npm run build:bridge-runtime`)

## Path Assumption Audit

The runtime code in this repo no longer depends on parent-workspace paths like `../execution` or absolute `/Users/...` project paths.

External tools are optional runtime dependencies configured through environment variables only.

## Legacy Notes

You may still see historical references to previous workspace paths in old planning/spec documents if those files are copied in from prior workspaces; those docs are non-runtime.
