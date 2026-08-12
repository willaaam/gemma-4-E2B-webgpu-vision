# ⚡ Gemma 4 E2B · WebGPU Kernels

> Run **Gemma 4 E2B (QAT Mobile)** entirely in your browser — **text *and* vision** —
> 100% on-device with WebGPU. No server, no API calls, no transformers.js.
> Weights download once from Hugging Face, cache in IndexedDB, and every token is
> produced on your own GPU.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Model](https://img.shields.io/badge/Model-Gemma%204%20E2B%20QAT-1f8acb?logo=huggingface&logoColor=yellow)](https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers)
[![Runtime](https://img.shields.io/badge/Runtime-WebGPU%20(WGSL)-purple)](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)
[![Upstream](https://img.shields.io/badge/Fork%20of-webml--community%20Space-9cf)](https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels)

This repository is a fork of the
[`webml-community/gemma-4-webgpu-kernels`](https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels)
Hugging Face Space by **Xenova**, with two big additions on top of the custom
kernel:

1. 🛡️ **NVIDIA / Windows subgroup fix** — a runtime guard that keeps generation
   coherent on Windows + NVIDIA (D3D12), where stock kernels can silently produce
   gibberish (see [NVIDIA-WINDOWS-GIBBERISH-FIX.md](NVIDIA-WINDOWS-GIBBERISH-FIX.md)).
2. 🖼️ **Vision** — a from-scratch WebGPU/WGSL port of the Gemma 4 vision tower,
   so the model can understand images with no ONNX runtime (see [VISION.md](VISION.md)).

---

## ✨ Features

| | |
|---|---|
| **Model** | [`google/gemma-4-E2B-it-qat-mobile-transformers`](https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers) |
| **Effective size** | ~2.3B params (QAT mobile, w8a8o8) |
| **Context** | up to 128K (engine / memory dependent) |
| **Runtime** | WebGPU compute — custom WGSL kernels |
| **Multimodal** | Text **+** images, fully on-device |
| **Privacy** | Prompts never leave your machine |

- **Text** — streaming chat with the QAT kernel, flash-style attention, fused
  decode norms/projections, per-layer embedding (PLE) paths.
- **Vision** — attach an image; the custom vision tower (16-layer WGSL encoder +
  pooling + projection) produces the soft tokens that are injected straight into
  the LLM kernel's embedding tensor.
- **NVIDIA guard** — on-device self-test; patches the bare `subgroupAdd` reduce
  into a portable butterfly (or falls back to disabling subgroups) so Windows +
  NVIDIA output stays correct.
- **On-device only** — no telemetry, no API keys, nothing leaves the browser.

---

## 🚀 Quick start

### Requirements

- Chrome or Edge with WebGPU enabled (recent builds)
- A GPU that exposes WebGPU (discrete NVIDIA / AMD or Apple Silicon; integrated
  GPUs may work but are slower)
- A secure context — `localhost` or HTTPS (browsers require this for WebGPU)

### Option A — GitHub Pages (hosted)

The app is fully static and Pages-friendly: serve the repo root and open
`index.html`. All module imports are relative, and weights stream from the
Hugging Face Hub (CORS + Range enabled) so **no server and no local models are
needed**.

> ⚠️ First load downloads ~2.4 GB of weights from Hugging Face. After that they
> live in IndexedDB and load from cache.

To deploy: repo **Settings → Pages → Deploy from a branch → `main` / root**.
No build step required.

### Option B — Run locally

> ⚠️ You MUST use a server that supports HTTP `Range` requests. The kernel and
> the vision loader stream the 2.4 GB `model.safetensors` with byte-range
> fetches. `python3 -m http.server` ignores `Range` and returns the whole file,
> which crashes with `RangeError: Array buffer allocation failed`. Use the
> bundled server:

```bash
# from this repo's root
node tools/serve.mjs 4173
# or: npm run serve
```

Then open [http://localhost:4173/](http://localhost:4173/) → **Load model** → chat.

> 💡 **Fully offline?** Place `model.safetensors` under
> `models/google/gemma-4-E2B-it-qat-mobile-transformers/` and open the page with
> `?localweights=1` (both `index.html` and `test-vision.html` respect this).

---

## 🧠 How it works

```text
Browser page (index.html)
        │
        ├─ landing.js                 Three.js hero (WebGL); pauses when chat is active
        │
        └─ load model
               │
               ├─ gemma4-sg-guard.js       self-test + patch bare subgroupAdd (or disable subgroups)
               │
               └─ gemma-4-e2b.js           Gemma4Mobile runtime (patched with vision hooks)
                      │
                      ├─ request WebGPU device
                      ├─ fetch tokenizer + chat template (HF Hub or local)
                      ├─ fetch / cache safetensors weights (IndexedDB)
                      ├─ compile device-selected WGSL kernels
                      └─ generate() streams tokens on-GPU
        └─ vision (optional)
               └─ gemma4-vision.js         custom 16-layer WGSL vision tower
                      └─ gemma4-vision-inject.js   injects image features into the LLM kernel
```

- **`index.html`** — vanilla HTML/CSS/JS, no bundler. Loads the model, runs the
  subgroup guard, wraps the model with vision, then streams
  `model.generate(messages, { maxNewTokens: 4096 })`. Has a **“View Kernels”**
  overlay that shows the *actually compiled* WGSL for your GPU.
- **`gemma-4-e2b.js`** — self-contained ES module engine: tokenizer + Jinja chat
  template, IndexedDB weight cache, and fused WebGPU/WGSL op templates for Gemma 4
  decode/prefill. Patched with **8 surgical vision hooks** (already applied; see
  [VISION.md](VISION.md)).
- **`gemma4-vision.js`** — faithful port of `Gemma4VisionModel` from
  `huggingface/transformers` (mobile QAT w8a8o8): preprocessing, patch embedder,
  2-D RoPE, bidirectional attention, 3×3 pooling, and the embedding projection →
  `[num_soft_tokens, 1536]` image features.
- **`gemma4-sg-guard.js`** — [MIT](https://github.com/Ar5en1c/gemma4-webgpu-nvidia-subgroup-fix)
  drop-in guard that patches the NVIDIA/Windows subgroup bug at load time.

---

## 🖼️ Vision

Attach an image in the composer and the model answers with vision. The image
encoder is a **custom WebGPU/WGSL port of the Gemma 4 vision tower** that loads
the vision weights from the same mobile QAT safetensors the text engine uses
(HTTP Range requests, ~190 MB, no transformers.js / onnxruntime). See
[VISION.md](VISION.md) for the full architecture, the chunked-prefill injection
design, and the implementation notes.

Highlights:

- **True int8 matmuls** — `matmulQat`/`matmulQkv`/`matmulGateUp` use packed int8
  activations + WGSL `dot4I8Packed` (i32 accumulate), bit-exact vs the f32 path.
- **Optimized attention** — vec4 QK dots + parallel (tree) max/sum reductions.
- **Incremental multimodal chat** — text-only follow-ups after an image re-prefill
  only the new suffix (no full context reset).

### Performance (Intel iGPU, 2394-patch image)

| Metric | f32 baseline | int8 + attention | Gain |
|---|---|---|---|
| Vision encode (warm) | ~5250 ms | ~2050 ms | **2.6×** |
| App time-to-first-token (vision prompt) | 6601 ms | 3093 ms | **2.1×** |
| Decode throughput | ~129 tok/s | ~129 tok/s | unchanged |

---

## 🛡️ NVIDIA / Windows gibberish fix

On some Windows + NVIDIA (D3D12) stacks, a bare WGSL `subgroupAdd` after
lane-divergent stores returns **wrong sums** inside `QatMatMul`. The model still
runs fast and reports no errors, but tokens become gibberish / repetition loops.

Before load, this fork:

1. Forces an on-device self-test (`force: true`), and never takes the Apple-style
   “exact 32/32 → do nothing” shortcut on Windows.
2. If a portable butterfly reduce passes → wraps `createShaderModule` and rewrites
   bare reduces to `subgroupShuffleXor` butterflies (`patched-sg`).
3. If that still fails → disables `subgroups` for the engine
   (`nosubgroups-fallback`, slightly slower but correct).

Details, console expectations, and upstream links:
**[NVIDIA-WINDOWS-GIBBERISH-FIX.md](NVIDIA-WINDOWS-GIBBERISH-FIX.md)**

---

## 📁 Project layout

```text
.
├── index.html                      Chat UI + load/generate orchestration (image attach UI)
├── gemma-4-e2b.js                  WebGPU inference engine + embedded WGSL (vision hooks applied)
├── gemma4-vision.js                Vision tower: preprocessing + 16-layer WGSL encoder + pooling + projection
├── gemma4-vision-inject.js         Wraps Gemma4Mobile so generate() accepts image content + injects features
├── gemma4-sg-guard.js              NVIDIA/Windows subgroup correctness guard (MIT, from Ar5en1c)
├── landing.js                      Three.js landing scene
├── test-vision.html                WebGPU vision test harness (QAT matmul vs CPU + encode sanity)
├── src/
│   └── model-config.js             Weight URL config (HF Hub default, ?localweights=1 override)
├── models/
│   └── README.md                   Optional local weights drop-in (see below)
├── tools/
│   └── serve.mjs                   Range-capable static server (required for weight streaming)
├── VISION.md                       Vision architecture + implementation notes
├── NVIDIA-WINDOWS-GIBBERISH-FIX.md Deep dive on the Windows gibberish bug
├── CHANGELOG.md                    Release history
└── README.md                       This file
```

No build step or bundler — the page is plain static files.

---

## 🖥️ Browser console checklist

After **Load model**, you should see something like:

```text
[gemma4-sg-guard] patched-sg { …adapter… } { bare: "FAIL(…)", butterfly: "PASS" }
```

or `nosubgroups-fallback`. On Windows you should **not** see `exact32-stock {}`
(that path leaves the broken kernels unpatched).

---

## 🙏 Credits

- **Xenova / [webml-community](https://huggingface.co/webml-community)** — the
  original Space and the Gemma 4 WebGPU engine this repo is forked from
  ([upstream](https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels),
  forked at commit `158f16ae`). The **text kernels were written and optimized by
  Fable 5** for the upstream Space.
- **[Ar5en1c](https://github.com/Ar5en1c)** — root-cause analysis of the
  NVIDIA/Windows subgroup bug and the
  [`gemma4-sg-guard.js`](https://github.com/Ar5en1c/gemma4-webgpu-nvidia-subgroup-fix)
  runtime guard (MIT).
- **DeepSeek V4 Flash** — authored the **vision tower** (`gemma4-vision.js`),
  the **multimodal extension** (`gemma4-vision-inject.js`), the 8 kernel patches,
  and the test harness, as custom WebGPU kernels.
- **Google** — the [Gemma 4 E2B QAT Mobile](https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers)
  model and weights.
- **Three.js** ([MIT](https://github.com/mrdoob/three.js/blob/dev/LICENSE)) — the
  landing scene, loaded from jsDelivr.
- **marked** ([MIT](https://github.com/markedjs/marked/blob/master/LICENSE.md)) —
  markdown rendering in the chat, loaded from esm.sh.

Upstream Space: https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels  
This repo: https://github.com/<your-username>/gemma-4-webgpu-kernels

---

## 📄 License

The code written for **this fork** — the vision tower, multimodal extension,
kernel patches, tools, and documentation — is released under the
[MIT License](LICENSE).

Third-party components keep their own terms; full attribution is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Please note the upstream
**Xenova engine** (`gemma-4-e2b.js`, upstream `index.html`/`landing.js`) carries
**no explicit license grant** at the time of writing, and the **model weights**
are governed by Google's
[Gemma Terms of Use](https://ai.google.dev/gemma/terms).
