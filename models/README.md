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

1. Download
   [`model.safetensors`](https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers/blob/main/model.safetensors)
   ([direct download](https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers/resolve/main/model.safetensors))
   and place it at
   `models/google/gemma-4-E2B-it-qat-mobile-transformers/model.safetensors`.
   Or fetch it with `npm run vendor:model -- --with-weights` (2.4 GB).
2. Serve this folder with the bundled Range-capable server:
   `node tools/serve.mjs 4173`
3. Open `http://localhost:4173/?localweights=1` (add the same query param to
   `test-vision.html`).

> ℹ️ The `.gitignore` deliberately excludes everything under `models/` so a
> 2.4 GB checkpoint is never accidentally committed.
