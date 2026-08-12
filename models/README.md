# models/

This folder is **empty on purpose** — the model weights are **not** shipped in
this repository.

By default the app streams `model.safetensors` (~2.4 GB) directly from the
Hugging Face Hub at runtime and caches it in IndexedDB, so nothing needs to be
downloaded manually. This works from any static host, including GitHub Pages.

```
models/
└── google/
    └── gemma-4-E2B-it-qat-mobile-transformers/
        └── model.safetensors   (optional local copy — ~2.4 GB, do NOT commit)
```

## Fully offline use (optional)

If you want to run without network access to Hugging Face:

1. Download the checkpoint from the
   [model card](https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers)
   and place it at
   `models/google/gemma-4-E2B-it-qat-mobile-transformers/model.safetensors`.
2. Serve this folder with the bundled Range-capable server:
   `node tools/serve.mjs 4173`
3. Open `http://localhost:4173/?localweights=1` (add the same query param to
   `test-vision.html`).

> ℹ️ The `.gitignore` deliberately excludes everything under `models/` so a
> 2.4 GB checkpoint is never accidentally committed.
