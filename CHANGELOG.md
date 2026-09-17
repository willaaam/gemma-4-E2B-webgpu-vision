# Changelog

All notable changes to this fork are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **Reports: charts went unrendered when the fence was not tagged `chart`** — extraction
  matched only the literal chart-tagged fence, but that tag is not reliable at this model
  size: a real report came back with the same valid JSON under a bare fence, so a perfectly
  good spec was rendered as an ordinary code block with its JSON visible as text. A fenced
  block now counts as a chart when it is tagged `chart` **or** when its body parses as a
  valid chart spec — so bare and `json`-tagged fences both work, while genuine code blocks
  and unrelated JSON are left alone, and a chart-tagged block with broken JSON still shows
  the error card and its Fix button. The Fix button's write-back shared the root cause: it
  rewrote only chart-tagged blocks, so correcting a chart under a bare fence appeared to
  work and then saved nothing. Extraction and replacement now share one matcher
  (`replaceChartBodies`) so the two cannot disagree. `npm run test:reports` covers all of
  this — 50 assertions, including the reported spec verbatim.

## [3.2.1] — 2026-09-17

### Fixed

- **Reports: a chart at the end of a section broke that section** — sections are generated
  one completion at a time, and the model sometimes wraps a whole section in a ``` fence, so
  each section was "unwrapped" by stripping the first fence and the last fence
  *independently*. But a section that ends with a ```chart block also ends in ```, so the
  chart's closing fence was deleted: the block never terminated, its JSON ran on past the end
  of the section, and — since `extractCharts` needs a closing fence — either the chart
  silently vanished and the raw JSON showed up as text, or the block matched all the way to
  the next fence and swallowed the following section into the chart spec. Unwrapping now
  happens only when both the first and last lines are bare fences, and
  `npm run test:reports` covers the trailing-chart, trailing-code-block, genuinely-wrapped
  and wrapped-plus-chart cases — including the previous failure mode, so the naive strip
  cannot come back as a "simplification". `apps/reports/` is now syntax-checked like the
  other apps.

## [3.2.0] — 2026-09-17

### Added

- **Research: context grouped by document** — retrieval results now read as documents
  rather than as a flat list of chunks, in both the prompt and the context inspector.
  The inspector shows one entry per selected document, expanded, with that document's
  chunks nested inside it and collapsed, and the header reports
  `10 documents · 30 chunks`. The prompt renders `[Document 1: name — 3 chunks]`
  followed by `[Chunk 2/7 — top match for this document (score …)]` blocks. A
  ten-document comparison used to list roughly thirty chunk entries that each repeated
  the document name; this is what makes "Compare docs" read as a document-level task.
  A document contributing a single block keeps the previous compact one-line form
  byte-for-byte, with a regression test guarding that.

## [3.1.0] — 2026-09-17

### Added

- **Automated releases** — `.github/workflows/release.yml` builds and attaches the portable
  release on a `v*` tag (or a manual run, which drafts by default): it rejects a tag that
  disagrees with `package.json`, caches and vendors the offline runtime, fetches the model
  sidecars, runs the suite, then packages the zip and its `SHA256SUMS.txt`. Release notes
  are the how-to-use steps (`docs/RELEASE-HOWTO.md`) followed by a condensed changelog
  section, produced by `npm run changelog <version> --brief --usage …`; the full detail
  stays here. Re-running replaces the existing release's assets and notes instead of
  failing. A companion `ci.yml` runs `npm ci && npm test` on pushes and PRs. Supporting
  changes: `npm run vendor:model` downloads the tokenizer and configs (`models/**` is
  gitignored, so a fresh clone and CI have none — `build:release` now fails loudly rather
  than shipping an artifact that cannot work offline), `build:release` clears previous
  output and exits non-zero if an asset would exceed GitHub's 2 GiB per-file limit,
  `package-lock.json` is no longer in `.gitignore` (`npm ci` needs it tracked), and Node is
  pinned via `engines`.
- **Portable single-file release** — `npm run build:portable` produces one
  `gemma4-workstation.html` (~3 MB: every module, stylesheet and font inlined) that runs
  the entire workstation from disk with **no server and no installation**. Since a
  `file://` page cannot fetch its neighbours and has no HTTP `Range`, the app asks for
  its `assets` folder once and then streams the weights by slicing the picked `File`
  (`Blob.slice`) behind a shimmed `fetch` that speaks `Range` — the engine's existing
  `options.fetch` / `knownSize` / `knownAcceptsRanges` seam means **no kernel changes**.
  The same shim serves the vendored Pyodide runtime, its standard library and every
  micropip wheel from disk, and `pyodide.asm.js` is pre-imported from a `blob:` URL so
  Pyodide skips the dynamic `import()` a patched `fetch` cannot intercept. New
  `npm run vendor:portable` (13 MB core; `--with-scientific` adds the 148 MB DS stack),
  `npm run build:portable[:min]` and `npm run test:portable` (37 byte-exact Range
  assertions). `tools/check-release.mjs` now also fails on a missing or stale vendored
  runtime, and the build refuses to emit a bundle containing a runtime `fetch`/`import`
  of a remote URL. See [PORTABLE.md](PORTABLE.md).
- **Portable release can run without the checkpoint** — the start screen now offers
  *Stream from Hugging Face* alongside the offline assets folder, and the weight source is
  resolved per load instead of being fixed at import time (`weightsBaseUrl()` /
  `weightsAreLocal()` in `src/model-config.js`, `weightsSource()` in `src/lib/portable.js`).
  That is what makes a small download possible: `npm run build:release` packages a **67 MB**
  zip (app + full offline runtime, no weights) with `SHA256SUMS.txt`, checking it against
  GitHub's 2 GiB per-asset limit. The checkpoint cannot legally ride along — it is 2.29 GiB
  raw and still 2.02 GiB deflated, since the QAT int8 tensors are ~90 % incompressible and
  LZMA does no better than deflate — so it streams on demand instead. Verified end-to-end
  against the real Hub: 34 requests, 2.23 GB cached, working generation, no page errors.
- **Code: Run selection for Python** — highlighting code in a `.py` file shows a
  `▶ Run selection` button next to `▶ Run Python`. It runs just the highlighted
  code, exactly as written — the file itself is not executed. Output is appended
  to the Python console (the log is kept, not cleared) and plots render inline.
- **Code: `clear` resets the Python environment** — clearing the Python console
  also drops every user-defined variable, function and class, evicts runtime
  imports from `sys.modules`, and closes open matplotlib figures, so the next
  run starts clean instead of reusing stale state. The console confirms what was
  cleared (e.g. "cleared 2 variables and 1 module"). Installed packages stay
  cached — the next `import` simply re-executes them fresh. The web console is
  unaffected.
- **Research: Clear button** — the document chat now has a `Clear` button beside
  `Ask`. It clears the conversation, the thread and the context inspector, and
  aborts an answer that is still streaming; the document library and your
  selection stay untouched.
- **Research: per-document BM25 retrieval** — when the selection is too large to
  inline, retrieval now runs once per selected document *before* the remaining
  budget is spent on the globally highest-scoring chunks, so every selected
  document contributes context. Blocks stay grouped per document in the context
  inspector, which is what makes "Compare docs" answerable, and a document with
  no keyword match contributes its opening text instead of dropping out.

### Fixed

- **Code: Python and web output shared one console** — the Console tab now keeps
  a separate buffer per runner and is labelled `Console · Python` or
  `Console · Web`, so Python stdout/stderr and the preview's `console.*` output no
  longer interleave. Opening or running a file points the console at that runner;
  output arriving while its console is off screen is counted with a badge on the
  tab (cleared when you open it). `clear` empties only the console you are looking
  at, and each preview render starts a fresh web log, the way a page reload does.
- **Code: the Preview tab was offered for files that cannot preview** — it now
  appears only when it is relevant to the file being edited: an HTML file, or an
  asset the currently previewed page references (so editing a stylesheet still
  shows its live effect). Editing a Python file no longer shows a Preview tab
  that does nothing, and opening an HTML file renders it straight away so the
  pane is never blank.
- **Research: BM25 retrieval could ignore every document but one** — chunk
  ranking was global, so a single long or term-dense document could fill the
  whole budget and leave the other selected documents with no context at all.
  Retrieval now guarantees a block per selected document, then fills the rest by
  score (see *per-document BM25 retrieval* above).

### Changed

- **The context window now defaults to 32K** — the shared top-bar `Context`
  selector starts at 32K instead of `Auto` (the full 128K architecture), so a
  fresh profile spends less memory on the KV cache and prefills faster, and
  loading the model allocates 32K up front. A one-time migration (flag
  `ws-context-limit-default-32k`) moves existing profiles to the same default,
  after which your own selection — `Auto`, 8K, 16K, 64K or 128K — is remembered
  across reloads.

## [3.0.0] — 2026-09-13

Major version because the **agentic Code loop was removed** (a headline 2.0.0
feature): the Code app no longer plans tasks, writes files, runs tools or asks
for permissions. Everything else in this release is additive or a bug fix.

### Added

- **Offline Python package bundle** — `tools/vendor-python-packages.mjs`
  downloads a curated set of popular *pure-Python* packages plus their
  pure-Python dependency closures into `vendor/python-packages/` (49 wheels,
  ~11 MB) with a `manifest.json`. **34 curated packages:**
  - *General*: rich, tabulate, tqdm, python-dateutil, pytz, packaging, attrs,
    more-itertools, toolz, beautifulsoup4, networkx, pyparsing, Pygments,
    chardet, openpyxl, markdown, texttable, humanize, xmltodict, six.
  - *Data science*: seaborn, mlxtend, imbalanced-learn, yellowbrick, pingouin,
    faker, arrow, numpy-financial, prettytable, xlsxwriter, natsort, glom, petl,
    tzdata.

  The Code app's **Packages** dialog lists them with one-click install from
  disk, running a Python file auto-installs any bundled package it imports, and
  `sw.js` caches `.whl` files (vendored *and* PyPI) so packages keep working with
  no network. Bundled packages that depend on Pyodide's binary builds
  (numpy/pandas/matplotlib/scipy/scikit-learn/statsmodels) load those from the
  Pyodide distribution automatically, and the dialog shows which ones each
  package needs; a **Cache scientific stack** button pre-loads numpy, pandas,
  matplotlib, scipy, scikit-learn and sympy into the service-worker cache for
  later offline use. Packages with no pure wheel (e.g. PyYAML) are reported as
  PyPI-only. New `npm run vendor:python`.
- **Release/attribution tooling** — `tools/check-release.mjs` (`npm run
  check:release`, also part of `npm test`) verifies the module graph resolves,
  every bare specifier and `?external=` dependency is covered by the import map,
  every vendored wheel exists with a license and import names, and nothing still
  references the deleted `src/agent` / `src/harness` modules. The vendor script
  also generates `vendor/python-packages/LICENSES.md`, a per-package license
  index with a copyleft callout, and `THIRD_PARTY_NOTICES.md` now covers the
  Python runtime, the vendored wheels, and the remaining CDN libraries
  (CodeMirror/Lezer, KaTeX, Chart.js, pdf.js, mammoth, fflate).
- **File-aware Code chat** — `@`-mention autocomplete, attachment pills
  (up to 8, persisted across turns), editor-selection context, explorer
  right-click *Explain / Review / Add to Chat*, image paste, and a **Copy**
  button on every suggested code snippet for manual apply. Chat is
  read-only and never edits project files.

### Fixed

- **Code: clicking an HTML file did not switch the bottom pane to Preview** —
  a syntax-highlighter exception during the editor update rejected `openFile()`
  before it reached the pane switch, leaving the Console tab and the Python Run
  button on screen. The editor update is now non-fatal, so the correct runner is
  always selected.
- **Code: preview `console.log()` output appeared in a strip below the iframe** —
  web and Python logs now share one Console tab; the `ws-preview-console` strip
  is gone.
- **Code: the web runner silently fell back to `index.html`** — the preview now
  renders exactly the active HTML file (or the page already on screen), and
  reports "not an HTML file" instead of guessing. `.css`/`.js`/`.md` no longer
  offer a "Refresh Preview" button they cannot honour.
- **Code: hardcoded `style.css` / `script.js` inlining** — every relative
  `<link href>` / `<script src>` is now resolved against the project file map
  (exact path, path relative to the entry's folder, or a unique basename) and
  inlined, so nested entry points and arbitrary file names work.
- **CodeMirror "Unrecognized extension" / `Cannot read properties of undefined`
  crash** — every `@codemirror/*` and `@lezer/*` package is now loaded from
  esm.sh with `?external=` (replacing the brittle version-redirect list in the
  import map), so `@codemirror/state` and `@lezer/common` exist as a single
  shared instance. Markdown files no longer open with the HTML parser.
- **Stale offline bundle after re-vendoring** — `sw.js` treated
  `vendor/python-packages/manifest.json` as an immutable asset, so a cache-first
  hit hid newly vendored packages. Only `.whl` files are cached now; the
  manifest is revalidated (and still falls back to cache when offline). Cache
  version bumped to `ws-v3`.
- **Test server stall at ~91% on localhost** — `tools/serve.mjs` now throttles to
  ~1 Gbit/s global by default (token-bucket, `THROTTLE_MBPS` / `--throttle-mbps`,
  `--no-throttle` to disable). The unthrottled loopback burst of 4×128 MiB
  Range requests saturated Chrome's `ReadableStream`+IndexedDB pipeline
  (`gemma-4-e2b.js: md=128<<20, hd=4` → `streamAll` → `writeTensor`), freezing
  `Loading cached weights: 1.79 GB / 1.97 GB (91%)`. Also fixed `HEAD` (engine
  size probe) to not stream a body and added `close`/`error` cleanup for
  `createReadStream` pipes. Documented in `README.md` Option B and
  `tools/serve.mjs:1` header.

### Known limitations

- **A CPU-bound or endless Python script freezes the tab.** Pyodide executes on
  the browser main thread, so `while True: ...` blocks rendering, events and the
  `⏹ Stop` button itself; the only recovery is reloading the tab. `stopPython()`
  sets the SharedArrayBuffer interrupt flag, but that is only observed at
  interpreter check points — a blocked `time.sleep` or a tight loop may never
  reach one, and the click cannot be dispatched while the thread is busy.
  Mitigations added: an *unbounded `while True:` loop with no `break`* warning
  before the run, and a run-in-progress marker (`ws-code-run-pending`) so the
  next load explains that a previous run never finished instead of looking
  broken. The documented `options.timeout` on `runPython` is still unimplemented.
  The real fix is to move the runtime into a Web Worker (see below).

### Removed

- **Agentic Code loop** — deleted `src/agent/` (task-list controller +
  protocol parsers), `src/harness/` (prompts, permissions, diff, tool
  registry) and `testing/agent.test.js`. The Code app no longer plans,
  writes files, runs tools, asks permissions, or keeps an undo stack.
- **Agent/Chat tabs in Code** — the right pane is now a single *Chat with
  files* view. Removed the Auto-approve and Agentic-mode toggles, task
  list, permission cards, and human-steering cards.

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
  bridge via postMessage). AI builder uses the task-list controller
  (`src/agent/controller.js`) to assign one bounded task at a time and feed
  runtime output back to the model for self-correction.
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
