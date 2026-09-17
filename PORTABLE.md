# 📦 Portable release — one HTML file, no server, fully offline

The portable build packs the **entire workstation into a single HTML file** that you
copy to a USB stick, an external drive, or a network share. There is no installer, no
server, no Python, no Node — just Chrome or Edge.

```
dist/portable/
├── gemma4-workstation.html      the whole app (~3 MB: all JS, CSS and fonts inlined)
├── README.txt                   short instructions shipped with the release
└── assets/
    ├── model.safetensors        Gemma 4 E2B QAT weights (~2.4 GB) — OPTIONAL, see below
    ├── models/google/…/         tokenizer + configs
    └── vendor/
        ├── pyodide/             CPython for the Code app, runs offline
        │   └── packages/        numpy/pandas/matplotlib/… (with --with-scientific)
        ├── python-packages/     49 pure-Python wheels
        └── parser/              pdf.js + mammoth for document import
```

The **only file you must have is the HTML**. Everything else is an optimisation:
with no `assets/` folder at all, the app still runs in full — it just streams the model
from the Hugging Face Hub instead of reading it from disk.

## Building it

```bash
npm install                 # release-only build deps (esbuild, CodeMirror, three, …)
npm run vendor:portable     # fetch the Pyodide runtime + copy the parser bundles
npm run build:portable      # → dist/portable/
```

`npm run build:portable:min` skips copying the 2.4 GB checkpoint, which is handy while
iterating; copy `model.safetensors` into `assets/` by hand afterwards.

To also run the data-science stack (numpy, pandas, matplotlib, scipy, scikit-learn,
sympy) with no network, vendor it too — it adds **148 MB** (20 wheels, resolved from
Pyodide's lock file so the dependency closure is complete):

```bash
npm run vendor:portable -- --with-scientific
node testing/check-scientific-closure.mjs   # show the cost without downloading
```

## Running it

Open `gemma4-workstation.html` in **Chrome or Edge**, then pick one of the two modes the
start screen offers:

**A · Offline** — keep the file next to the `assets` folder, choose that folder when asked
(or drag it onto the window). The model, the Python runtime and every package are then read
from disk. Nothing touches the network.

**B · Online** — click *Stream from Hugging Face*. The model (~2.4 GB) is fetched from the
Hub on first load and cached by your browser (IndexedDB), so later loads are local. You can
point it at an `assets` folder at any time to switch to fully offline use.

Mode B is what makes a small download viable: the whole app ships as ~67 MB rather than
2.5 GB, because the checkpoint — the one part that cannot be compressed or inlined — is
fetched on demand from the same place the served build already gets it.

### Verifying the online path

Mode B was verified end-to-end against the real Hub rather than assumed: starting from the
single HTML file, choosing *Stream from Hugging Face*, and loading the model produced 34
requests to `huggingface.co` (`tokenizer.json`, `tokenizer_config.json`,
`chat_template.jinja`, `generation_config.json`, `config.json`, then `model.safetensors`
redirected to the xet CDN), 2.23 GB cached locally, and a working generation
(`Hello, how are you?` — TTFT 275 ms, 52.4 tok/s) with no page errors.

## Packaging a release

```bash
npm run build:release        # → dist/release/gemma4-workstation-portable-<version>.zip
```

That produces a **67 MB** archive (plus `SHA256SUMS.txt`) containing the app and the whole
offline runtime, but **no weights** — and it checks the result against GitHub's limits
before telling you it is fine.

### Why the weights are not in it

GitHub release assets must each be **under 2 GiB** ([About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)),
with no limit on the total size or bandwidth. Measured sizes:

| Artifact | Bytes | Size | vs 2 GiB |
|---|---:|---:|---|
| `model.safetensors` raw | 2,458,111,846 | 2.289 GiB | over by 296 MB |
| `model.safetensors`, deflated | 2,165,181,343 | 2.016 GiB | over by 17 MB |
| full portable release, zipped | 2,247,774,681 | 2.093 GiB | over by 96 MB |
| **app + runtime, no weights** | **70,520,768** | **67.3 MB** | ✅ 1.93 GiB spare |

The checkpoint cannot be squeezed under the limit by any compressor: the QAT int8 tensors
are ~90% incompressible, and LZMA does no better than deflate on them (sampled at five
offsets — the first 32 MB compresses to 31%, the bulk to ~90%). Git LFS is not an escape
either; its per-file ceiling is 2 GB on Free *and* Pro.

So: attach the small zip to the release, and let mode B supply the weights. If you want a
single fully-offline download, host the assembled folder on the
[Hugging Face Hub](https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers)
next to the model (no 2 GiB per-file limit) and link it from the release notes.

## Automated releases (GitHub Actions)

Two workflows are included, and both are deliberately thin — every decision lives in the
`tools/` scripts, so you can reproduce either one locally with `npm`.

| Workflow | Trigger | Does |
|---|---|---|
| `.github/workflows/ci.yml` | push to `main`, PRs, manual | `npm ci` + `npm test` |
| `.github/workflows/release.yml` | tag `v*`, or manual | builds and attaches the release |

**CI is fast and needs no vendoring.** `vendor/pyodide/` (core) and `vendor/parser/` are
tracked, so `npm test` passes on a bare checkout. Only the 148 MB scientific stack is
gitignored, and nothing in CI requires it.

**To cut a release:** bump the version in `package.json` *and* `package-lock.json`, move
the `## [Unreleased]` heading to `## [x.y.z] — <date>`, then push a tag:

```bash
git tag v3.1.0 && git push origin v3.1.0
```

The release workflow then:

1. fails if the tag does not match `package.json` (asset names come from the version, so a
   mismatch would ship a file whose name contradicts its contents);
2. caches the vendored Pyodide keyed on `PYODIDE_VERSION`, then runs
   `vendor:portable --with-scientific`;
3. runs `vendor:model` — `models/**` is gitignored, so a fresh clone has **no tokenizer or
   configs**, and the release genuinely needs them (`build:release` fails loudly rather
   than publishing an artifact that cannot work offline);
4. runs `npm test`, then `build:release`, which itself refuses to finish if an asset would
   exceed the 2 GiB limit;
5. takes the notes from the CHANGELOG via `npm run changelog <version>`, and
6. creates the release, or updates and re-uploads if it already exists (`--clobber`).

Running the workflow manually creates a **draft** by default, so you can inspect the assets
before they go public. Pushing a tag publishes straight away.

Both workflows were verified against a clean-tree simulation (no `node_modules`, no
`models/`, no gitignored Pyodide packages) and linted with `actionlint`. That simulation
reproduced the local hashes byte-for-byte, which is the reproducibility claim actually
being tested rather than assumed.

## Why it has to ask for a folder

This is the interesting part, and it is the reason the previous "one self-contained
file" idea never worked.

The engine streams `model.safetensors` with **HTTP Range requests** — it pulls 128 MiB
chunks so it never has to hold 2.4 GB in memory. A page opened from `file://` has no
server, and:

| | on `file://` |
|---|---|
| Relative ES-module imports | ❌ blocked (CORS, opaque origin) |
| `fetch()` of a sibling file | ❌ blocked |
| HTTP `Range` support | ❌ does not exist |
| Service worker | ❌ cannot register |

So a double-clicked HTML file cannot read its own neighbours, and there is no server
to add Range support to. **But a file the user picks is different**: a `File` object is
randomly accessible through `Blob.slice(a, b)`, locally and instantly.

So the portable build:

1. Presents every picked file under a reserved virtual origin
   (`https://assets.local/…`).
2. Installs a `fetch` that answers requests from that origin — **including `Range`
   requests** — by slicing the local `Blob`.
3. Hands that `fetch` to the model loaders, which support it natively
   (`Gemma4Engine` reads `options.fetch`, `knownSize`, `knownAcceptsRanges` and
   `requireRangeRequests`; the vision tower threads `opts.fetch` into its
   `RangeReader`).

Nothing in the engine changed. Range requests simply stopped being HTTP requests.

The same shim covers the Python runtime: Pyodide fetches `python_stdlib.zip`,
`pyodide.asm.wasm` and every wheel through `globalThis.fetch`, so intercepting it
serves them all from disk. The one file Pyodide loads with a dynamic `import()`
instead — `pyodide.asm.js` — is pre-imported from a `blob:` URL, which defines
`globalThis._createPyodideModule` and makes Pyodide skip that step entirely.

## Verified behaviour

The Range path is unit-tested in Node (`npm run test:portable`, 37 assertions:
byte-exact slice, open-ended and suffix ranges, EOF clamping, `HEAD`, aborts, four
concurrent ranges, and ambiguity handling). It was also verified end-to-end against
the real, unmodified engine in a browser:

```
GET  …/tokenizer_config.json
GET  …/chat_template.jinja
GET  …/generation_config.json
GET  …/config.json
HEAD …/model.safetensors                    → size + Accept-Ranges
GET  …/model.safetensors   Range: bytes=0-79 → served from the local Blob
→ "Missing required tensors: model.language_model.embed_tokens.embedding_quantized, …"
```

That final error is the proof: the engine read and parsed a safetensors header through
the shimmed `Range` request, and only failed because the fixture contained no real
tensors.

## Requirements and limits

- **Chrome or Edge.** `file://` is treated as a secure context (per the W3C Secure
  Contexts spec, and per MDN's table), so WebGPU is available. Firefox and Safari are
  not supported targets: `file://` IndexedDB and WebGPU support are unreliable there.
- **~2.5 GB free** where the assets live, plus room for the browser's tensor cache.
- The engine appends sidecar names to the model path, so `assets/models/google/…/`
  must contain `tokenizer.json`, `config.json`, `generation_config.json`,
  `chat_template.jinja` and the processor configs. `npm run build:portable` copies them.
- **The Stop button in the Python console is best-effort** here. `file://` pages cannot
  use `SharedArrayBuffer` (no COOP/COEP headers), which is what normally delivers a
  hard interrupt to the interpreter. The code already degrades gracefully.
- Weights are **not** copied into IndexedDB by the portable layer — the engine already
  caches the tensors it decodes, and duplicating 2.4 GB of blobs would be slow and
  would risk the storage quota. You re-select the folder once per browser session.

## If `file://` ever misbehaves

Everything above is unnecessary when the app is served over HTTP, where Range requests
work normally. The portable folder therefore also works exactly as-is from the bundled
Range-capable server:

```bash
node tools/serve.mjs 4173 dist/portable
# then open http://127.0.0.1:4173/gemma4-workstation.html
```

The built file always runs in portable mode (it has the portable config inlined), so it
will still ask for the assets folder — but this is the right fallback if you hit a
browser-specific `file://` problem on some machine.

## Attribution

Vendoring the runtime does not change anyone's licence. Pyodide (MPL-2.0), CPython
(PSF-2.0), pdf.js (Apache-2.0) and mammoth.js (BSD-2-Clause) are redistributed
unmodified; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and
`vendor/portable-manifest.json`.
