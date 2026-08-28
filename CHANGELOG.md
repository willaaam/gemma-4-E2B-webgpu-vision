# Changelog

All notable changes to this fork are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **Test server stall at ~91% on localhost** — `tools/serve.mjs` now throttles to
  ~1 Gbit/s global by default (token-bucket, `THROTTLE_MBPS` / `--throttle-mbps`,
  `--no-throttle` to disable). The unthrottled loopback burst of 4×128 MiB
  Range requests saturated Chrome's `ReadableStream`+IndexedDB pipeline
  (`gemma-4-e2b.js: md=128<<20, hd=4` → `streamAll` → `writeTensor`), freezing
  `Loading cached weights: 1.79 GB / 1.97 GB (91%)`. Also fixed `HEAD` (engine
  size probe) to not stream a body and added `close`/`error` cleanup for
  `createReadStream` pipes. Documented in `README.md` Option B and
  `tools/serve.mjs:1` header.

### Changed

- `tools/serve.mjs` usage: `node tools/serve.mjs [port] [root] [--throttle-mbps N] [--no-throttle]`; `highWaterMark` 1 MiB for weight streams.

## [2.0.0] — 2026-08-23

The chat page became a multi-app, fully on-device **AI workstation**.

### Added

- **Workstation shell** — hash-routed single page (`#/chat`, `#/research`,
  `#/code`, `#/reports`) with a global top bar: model status pill, load
  progress bar, storage meter and app navigation. The original landing hero is
  preserved as the entry screen.
- **Shared services** — `src/services/model-service.js` (single model load,
  guard orchestration, subscriber-based status), `generation.js` (global
  single-stream lock + thinking-split + stats), `db.js` (IndexedDB persistence:
  conversations, reports, documents, settings), `context.js` (token budgeting,
  chunking, pure-JS BM25 retrieval).
- **Chat app** — behavior-preserving port of the original chat into
  `apps/chat/app.js`, plus conversation history (open/delete), autosave and
  `.md` export.
- **Documents app** — in-browser parsing of PDF (pdf.js), DOCX (mammoth),
  TXT/MD/CSV/JSON; full-text stuffing up to the effective runtime budget with
  automatic BM25 chunk-retrieval fallback; context inspector showing exactly what
  the model sees; canned actions (summarize, action items, key figures,
  compare, study questions); vision-tower OCR for scanned pages/images.
- **Code app** — dual-runtime playground: Python via Pyodide (auto-installs
  imports from the Pyodide distribution; matplotlib figures captured as PNGs;
  micropip installs any pure-Python package from PyPI) and a sandboxed
  HTML/CSS/JS live preview (`srcdoc` iframe without same-origin, console
  bridge via postMessage). AI builder runs a generate → execute → observe
  agent loop (`src/lib/agent-loop.js`) that feeds runtime output back to the
  model for up to three self-correction rounds.
- **Reports app** — staged generation tuned for greedy decoding (strict JSON
  outline → bounded per-section completions), charts emitted as JSON specs and
  rendered by Chart.js with a model-driven "fix" loop for invalid specs, saved
  reports, and a self-contained `.html` export with charts baked in as PNGs.
- **PWA** — `manifest.webmanifest`, `icon.svg` and `sw.js`; the app shell and
  CDN libraries are cached for offline use while weight downloads are
  explicitly excluded to preserve HTTP Range streaming.

### Changed

- `index.html` restructured into the workstation shell; the ~900-line inline
  script replaced by module imports. Chat markup preserved inside the chat view.
- `landing.js` pauses the hero scene whenever a workstation route is active
  (previously scroll-based only).

## [1.0.0] — 2026-08-11

Initial release of the fork as a standalone repository.

### Added

- **Vision support** — a from-scratch WebGPU/WGSL port of the Gemma 4 vision
  tower (`gemma4-vision.js`) plus the multimodal extension
  (`gemma4-vision-inject.js`) that injects image features into the LLM kernel.
  No transformers.js / onnxruntime required.
- **Vision test harness** — `test-vision.html` (QAT matmul GPU-vs-CPU check +
  full encode sanity/timing).
- **8 surgical kernel patches** to `gemma-4-e2b.js` (vision feature injection
  on the live chunked-prefill path), documented in `VISION.md`.
- **NVIDIA / Windows subgroup guard** — `gemma4-sg-guard.js` (MIT, from
  Ar5en1c), wired into `index.html` with `force: true` so Windows + NVIDIA
  output stays coherent.
- **Range-capable static server** — `tools/serve.mjs` (needed to stream the
  2.4 GB safetensors).
- **GitHub Pages-ready config** — `src/model-config.js` streams weights from
  the Hugging Face Hub at runtime; `?localweights=1` switches to a local
  drop-in under `models/`.
- **Release metadata** — `LICENSE` (MIT), `THIRD_PARTY_NOTICES.md`,
  `CHANGELOG.md`, `.gitignore`, `package.json` (`npm run serve`).

### Performance (vision encode, Intel iGPU, 2394-patch image)

- Encode: ~5250 ms (f32 baseline) → ~2050 ms with true int8 matmuls
  (`dot4I8Packed`) + optimized attention — **2.6×**.
- App time-to-first-token (vision prompt): 6601 ms → 3093 ms — **2.1×**.
- Critical fix: `_matmulQkv`/`_matmulGateUp` pipeline-cache keys now include the
  per-layer activation scales (previously layers 1–15 reused layer 0's scales).

### Upstream

- Forked from [webml-community/gemma-4-webgpu-kernels](https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels)
  (Xenova) at commit `158f16ae`.
