# Batch Audio Studio Desktop

Self-contained Electron + React + Python bridge app for chunked audio generation and timeline editing.

## What is included

- Electron desktop shell (`electron/`)
- React app (`src/`)
- Internal Python bridge (`bridge/`)
- Packaging config for macOS (`electron-builder`)

No parent-workspace Python dependency is required.

## Quick start

1. Install Node deps:
   - `npm install`
2. Copy env template:
   - `cp .env.example .env.local`
3. (Optional) Set backend URLs in `.env.local`:
   - `BATCH_AUDIO_LOCAL_API_BASE`
   - `BATCH_AUDIO_MODAL_API_BASE`
4. Run the app:
   - `npm run dev`

## Required vs optional dependencies

- Required:
  - Node.js + npm
  - Python 3 (for local bridge process)
- Optional:
  - Local TTS server (for local generation)
  - Modal endpoint (for remote generation)
  - Pinokio/local voice store path via `BATCH_AUDIO_LOCAL_VOICE_STORE`

If no external TTS backend is configured, the app can run in mock mode (`BATCH_AUDIO_ENABLE_MOCK_TTS=true`) so history/UI flows still work.

## Environment variables

- `BATCH_AUDIO_LOCAL_API_BASE`: local backend URL
- `BATCH_AUDIO_MODAL_API_BASE`: modal backend URL
- `BATCH_AUDIO_CONFIG_DIR`: bridge state directory (db/cache/logs)
- `BATCH_AUDIO_OUTPUT_ROOT`: generated run/audio output directory
- `BATCH_AUDIO_LOCAL_VOICE_STORE`: optional local voice store directory
- `BATCH_AUDIO_ENABLE_MOCK_TTS`: enable/disable mock fallback

`.env` and `.env.local` are loaded by the bridge.

## Packaging notes

- Build bridge runtime:
  - `npm run build:bridge-runtime`
- Build UI:
  - `npm run build`
- Package app:
  - `npm run dist`

The packaged app bundles:
- `bridge/` Python source
- `.tmp/bridge-runtime` Python runtime (built at packaging time)

