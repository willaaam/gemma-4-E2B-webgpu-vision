# Changelog

All notable changes to this fork are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
