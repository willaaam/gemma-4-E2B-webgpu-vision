# Third-Party Notices

This repository builds on the work of several projects and people. Attribution
and license terms are recorded here, and in the **Credits** section of the
[README](README.md).

---

## 1. Upstream Gemma 4 WebGPU engine — Xenova / webml-community

| | |
|---|---|
| **Source** | [webml-community/gemma-4-webgpu-kernels](https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels) (Hugging Face Space) |
| **Author** | Xenova (HF Staff) |
| **Forked at** | commit `158f16ae` ("v4 (#2)") |
| **Included files** | `gemma-4-e2b.js` (patched), upstream `index.html` / `landing.js` (heavily modified), `.gitattributes` |
| **License** | **No explicit license grant at time of writing.** The engine is distributed as part of the upstream Space; per the maintainer of the subgroup-fix project, the engine "belongs to Xenova and the webml-community Space and carries no license grant at time of writing". Redistribution here is under the terms of the upstream Space and its community discussions. |

The **text WebGPU kernels** inside the engine were written and optimized by
**Fable 5** for the upstream Space (see Xenova's announcement:
https://x.com/xenovacom/status/2065656427117437213).

## 2. NVIDIA / Windows subgroup guard — Ar5en1c

| | |
|---|---|
| **Source** | [Ar5en1c/gemma4-webgpu-nvidia-subgroup-fix](https://github.com/Ar5en1c/gemma4-webgpu-nvidia-subgroup-fix) |
| **Included file** | `gemma4-sg-guard.js` |
| **License** | **MIT** |

Root-cause analysis and the drop-in runtime guard for the bare-`subgroupAdd`
corruption on NVIDIA/Windows (D3D12).

## 3. Model & weights — Google

| | |
|---|---|
| **Model** | [google/gemma-4-E2B-it-qat-mobile-transformers](https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers) |
| **Weights** | `model.safetensors` (~2.4 GB) — **not** shipped in this repo; streamed from the Hugging Face Hub at runtime |
| **License** | [Google Gemma Terms of Use](https://ai.google.dev/gemma/terms) |

## 4. Front-end libraries (loaded from CDNs at runtime)

| Library | Use | License |
|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) (via jsDelivr) | Landing scene (`landing.js`) | [MIT](https://github.com/mrdoob/three.js/blob/dev/LICENSE) |
| [marked](https://github.com/markedjs/marked) (via esm.sh) | Markdown rendering in the chat | [MIT](https://github.com/markedjs/marked/blob/master/LICENSE.md) |
| [KaTeX](https://github.com/KaTeX/KaTeX) (via esm.sh + jsDelivr CSS) | Math rendering | [MIT](https://github.com/KaTeX/KaTeX/blob/main/LICENSE) |
| [CodeMirror 6](https://github.com/codemirror/dev) + [Lezer](https://github.com/lezer-parser) (via esm.sh) | Code app editor (syntax highlighting, autocomplete, folding) | [MIT](https://github.com/codemirror/dev/blob/main/LICENSE) |
| [Chart.js](https://github.com/chartjs/Chart.js) (via esm.sh) | Reports charts | [MIT](https://github.com/chartjs/Chart.js/blob/master/LICENSE.md) |
| [pdf.js](https://github.com/mozilla/pdf.js) (via cdnjs) | Documents app PDF text extraction | [Apache-2.0](https://github.com/mozilla/pdf.js/blob/master/LICENSE) |
| [mammoth.js](https://github.com/mwilliamson/mammoth.js) (via cdnjs) | Documents app `.docx` extraction | [BSD-2-Clause](https://github.com/mwilliamson/mammoth.js/blob/master/LICENSE) |
| [fflate](https://github.com/101arrowz/fflate) (via esm.sh) | Zip import/export in the Code app | [MIT](https://github.com/101arrowz/fflate/blob/master/LICENSE) |
| Google Fonts — [Geist](https://fonts.google.com/specimen/Geist), [Geist Mono](https://fonts.google.com/specimen/Geist+Mono), [Instrument Serif](https://fonts.google.com/specimen/Instrument+Serif) | UI typography | SIL Open Font License 1.1 |

These are loaded from CDNs at runtime and cached by `sw.js`; none are bundled
into the repository.

## 5. Python runtime — Pyodide (Code app)

| | |
|---|---|
| **Project** | [Pyodide](https://pyodide.org) — CPython compiled to WebAssembly |
| **Version** | 0.26.4, loaded at runtime from `cdn.jsdelivr.net` (cached by `sw.js`) |
| **Included in this repo** | **No** — the runtime is fetched from the CDN, never redistributed |
| **License** | Pyodide is [MPL-2.0](https://github.com/pyodide/pyodide/blob/main/LICENSE); the bundled CPython is [PSF-2.0](https://docs.python.org/3/license.html) |

Packages supplied by the Pyodide distribution (numpy, pandas, matplotlib,
scipy, scikit-learn, sympy, …) are also loaded from that CDN at runtime and keep
their own licenses; they are **not** redistributed here.

## 6. Vendored Python packages (offline bundle)

`vendor/python-packages/` redistributes **49 pure-Python wheels** so the Code app
can install them with no network. Each wheel is unmodified and keeps its own
license; the authoritative text ships inside the wheel (`*.dist-info/licenses/`).

The full, generated attribution table — including each package's version and
license — is in
[`vendor/python-packages/LICENSES.md`](vendor/python-packages/LICENSES.md).
Most bundled packages are MIT / BSD / Apache-2.0 / 0BSD / PSF-2.0 licensed.

> **⚠️ Copyleft dependencies:** two bundled packages are copyleft —
> **pingouin** (GPL-3.0) and **tqdm** (MPL-2.0 AND MIT). They are redistributed
> unmodified as separate works, imported at runtime rather than linked. If your
> policy excludes copyleft dependencies, remove them from `CURATED` in
> `tools/vendor-python-packages.mjs` and re-run the script.

---

## Forked code (this repository)

The vision tower (`gemma4-vision.js`), the multimodal extension
(`gemma4-vision-inject.js`), the test harness (`test-vision.html`), the
configuration, and this documentation were written for this fork and are
released under the [MIT License](LICENSE).

The vision tower is a faithful WebGPU/WGSL port of `Gemma4VisionModel` from
[huggingface/transformers](https://github.com/huggingface/transformers)
(`models/gemma4/modeling_gemma4.py`), used for reference only.
