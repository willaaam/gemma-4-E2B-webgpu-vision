# Adding Vision to the Gemma 4 WebGPU Kernel

> **Status:** vision works end-to-end — the model describes uploaded images
> correctly. This document is the authoritative architecture and implementation
> reference for the vision tower and how it plugs into the LLM kernel.

The LLM kernel (`gemma-4-e2b.js`) runs the **text** side of
`google/gemma-4-E2B-it-qat-mobile-transformers` with custom WebGPU/WGSL kernels.
This document describes how **vision** was added on top of it, using the same
philosophy: custom WGSL kernels, the same mobile QAT checkpoint, and a surgical
(guarded) hook into the LLM kernel so the text path stays untouched.

| File | Role |
|------|------|
| `gemma4-vision.js` | The vision tower — image preprocessing + 16-layer encoder + pooling + projection, all WebGPU WGSL. Produces `[num_soft_tokens, 1536]` image features. |
| `gemma4-vision-inject.js` | Wraps `Gemma4Mobile` so `generate()` accepts image content; arms the kernel hook and scatters the features into the LLM's embedding tensor. |
| `gemma-4-e2b.js` | Patched at the `qatEmbed`/prefill sites with `globalThis.__gemmaVisionHook` (guarded; text path unchanged when no hook). |
| `index.html` | Image attach button + inline preview; loads the vision tower and wraps the model after load. |
| `test-vision.html` | Browser harness: QAT-matmul GPU-vs-CPU check + full encode sanity/timing. Needs a real WebGPU browser. |

---

## Why this matters / what it replaces

The vision encoder (`gemma4-vision.js`) replaces the ONNX-based
`vision_encoder_q4f16.onnx` path, so the whole model runs on the custom kernel
runtime without transformers.js / onnxruntime.

---

## The vision tower (as implemented)

Faithful port of `Gemma4VisionModel` in
`transformers/models/gemma4/modeling_gemma4.py` against the **mobile QAT
(w8a8o8)** checkpoint — the same `srq` static-range quantization scheme the text
kernel uses:

```python
srq(x, s)   = s == 0 ? x : clamp(round(x/s), -128, 127) * s
linear(x)   = srq( W_scale[o] * sum_k srq(x[k], inScale) * W_i8[o,k], outScale )
```

Pipeline (all sizes from the model config):

1. **Preprocess** (`Gemma4ImageProcessor` algorithm) — aspect-preserving resize
   so both dims are multiples of `pooling_kernel * patch_size = 48`; rescale to
   `[-1, 1]`; patchify into `16×16×3 = 768`-dim patches + `(col, row)` positions.
   `num_soft_tokens = num_patches / 9` — **dynamic per image**.
2. **Patch embedder** — `input_proj` (BF16 `[768,768]`) + 2-D factored positional
   embedding `table[0][col] + table[1][row]` (BF16 `[2, 10240, 768]`).
3. **16 encoder layers**, each:
   - `input_layernorm` → q/k/v (I8 QAT, `[768,768]`) → per-head `q_norm`/`k_norm`
     (64-d) and `v_norm` (no scale)
   - 2-D RoPE (θ=100; split `head_dim` 64 into two 32-d spatial parts; rotate-half
     within each)
   - bidirectional attention **with no `1/sqrt(head_dim)` scaling**
     (`self.scaling = 1.0`)
   - `o_proj` → `post_attention_layernorm` → residual
   - `pre_feedforward_layernorm` → MLP `down(gelu_tanh(gate(x)) * up(x))` →
     `post_feedforward_layernorm` → residual
4. **Pooler** — average each 3×3 patch block → `num_soft_tokens` tokens,
   × `sqrt(768)`.
5. **embed_vision** — RMSNorm (no scale) + `embedding_projection` (F32
   `[1536,768]`) → `[num_soft_tokens, 1536]` image features.

Weights are streamed from the same `model.safetensors` the text engine uses
(~190 MB for the `vision_tower` + `embed_vision` tensors), cached in IndexedDB.

---

## Kernel injection (how the features reach the LLM)

The LLM prefill embeds token ids with `S.qatEmbed(...)`. The kernel is patched
with **guarded** hooks so the text path is byte-for-byte identical when no hook
is installed:

```js
globalThis.__gemmaVisionHook = {
  mainEmbed(S, args, seq, hidden, host, offset) { /* scatter features into Q */ },
  perLayerEmbed(S, ne, args, seq, host) { /* image->pad ids for PLE */ },
  paddedChunkIds(ids, offset, blockLen) { /* chunk ids with image->PAD */ },
  runPrefill(or, s, ids, offset, blockLen) { /* embed alone -> scatter -> rest */ },
};
```

### The wrapper (`VisionGemma4Mobile`)

Expands each image in the messages into `<|image|> × num_soft_tokens` +
delimiters (from `tokenizer_config.json`), tokenizes to find the image-token
positions, computes the features, and arms the override. It does **not** reset
the context: the expanded prompt is a strict extension of the previous one
(append-only chat), so the kernel incrementally prefills only the new suffix.
If a prompt ever isn't a clean continuation, the kernel falls back to a full
re-prefill — all segments are armed, so features still land correctly.

### Live (chunked) prefill path — `Or`/g4p

`generate()` uses the **chunked prefill** `Or` (g4p), not the whole-prompt `Ot`
fallback. Two extra patch points make injection work there:

1. `Or.build()` captures `this.hiddenT` (the g4p-hidden tensor).
2. `Or.run()` calls `__gemmaVisionHook.paddedChunkIds(ids, offset, blockLen)` →
   PAD-substituted chunk ids (image → 0), so the main embed's image rows =
   embed(PAD) and the per-layer embed gets PAD at image positions (matches
   transformers).
3. `Or.run()` calls `__gemmaVisionHook.runPrefill(or, s, ids, offset, blockLen)`
   which, when an image segment overlaps the chunk:
   - enqueues the embed step by itself (`or.col.enqueue([or.steps[0]])`),
   - `queue.writeBuffer`s the vision features over the image rows of `hiddenT`
     (a `features.subarray(...)` slice covering exactly the rows needed),
   - enqueues the rest of the prefill (`or.col.enqueue(or.steps.slice(1))`).

The old `mainEmbed`/`perLayerEmbed` wraps remain for the `Ot` fallback (its
offset call site was fixed to pass the token offset).

### The 8 kernel patches (inventory)

Already applied to the shipped `gemma-4-e2b.js`:

1. Remove the temporary `qatEmbed` trace instrumentation
2. Capture `hiddenT` in `Or.build` (`this.hiddenT = S`)
3a. `Or.run` — PAD-substituted chunk ids via `__gemmaVisionHook.paddedChunkIds`
3b. `Or.run` — split enqueue (embed → `runPrefill` scatter → rest)
4. `mainEmbed` hook wrap in the `Ot` fallback prefill (offset arg baked as `r`)
5. `perLayerEmbed` hook wrap in the `Ot` fallback prefill
6. Kernel cache read self-heal (`try{...}catch(_){s(null)}` = cache miss)

> If you re-sync `gemma-4-e2b.js` from upstream, these hooks are lost and must
> be re-applied before vision works.

---

## Performance & optimizations

### Benchmarks (Intel iGPU, 2394-patch image)

| Metric | f32 baseline | int8 + attention | Gain |
|---|---|---|---|
| Vision encode (warm) | ~5250 ms | ~2050 ms | **2.6×** |
| App time-to-first-token (vision prompt) | 6601 ms | 3093 ms | **2.1×** |
| Decode throughput | ~129 tok/s | ~129 tok/s | unchanged |

### What changed

- **True int8 matmuls** — `matmulQat`/`matmulQkv`/`matmulGateUp` read packed
  int8 activations (`array<u32>`, 4 signed int8/word) and use WGSL
  `dot4I8Packed` (i32 accumulate). A `quantizeI8` kernel builds the packed
  inputs, baking each matmul's `input_activation_scale`. Verified **bit-exact**
  vs the old f32 srq math; also halves activation memory traffic.
- **Fused matmuls** — `_matmulQkv` (one dispatch computes Q, K, V; z-dim selects
  the projection) and `_matmulGateUp` (gate + up + `gelu_tanh` in one dispatch)
  replace 6 dispatches/layer with 2. QKV uses load-time concatenated q/k/v
  weights + row scales so it stays within the default
  8-storage-buffer limit.
- **Attention optimized** — vec4 QK dot products + parallel (tree) max/sum
  reductions (previously thread 0 serially scanned all M scores).
- **Batched `encode()`** — per-stage / per-layer command encoders via `_batch()`
  (~18 bounded submits instead of ~160 per-op). A single giant submit tripped
  the GPU watchdog (`VK_ERROR_DEVICE_LOST`) — keep batching per-layer.
- **Uniform-buffer cache** — `_uniform(m)` reuses one 16-byte buffer per value
  instead of ~160 `createBuffer`/encode.
- **Image feature cache** — `VisionGemma4Mobile` caches `encode()` output keyed
  by image url/src (bounded 8, cleared on reset/dispose). Disable with
  `opts.cache === false`, `__G4V_NO_CACHE`, or `?nocache=1`.

### Critical bug fixed: pipeline-cache keys

`_matmulQkv`/`_matmulGateUp` cache keys were `qkv_${N}_${K}` / `gup_${I}_${K}` —
they did **not** include the baked-in per-layer activation scales, so layers
1–15 silently reused **layer 0's cached pipeline (layer 0's scales)**. This
corrupted the old f32 baseline too. Fix: keys now include all in/out scales;
after the fix f32 and int8 agree within float-accumulation tolerance.

**Deferred (honest):** f16 elementwise/norm/rope (needs `shader-f16` + f32
fallback; modest gain after int8 storage), deep kernel fusion
(rmsNorm→quantize, residual→norm), BF16-as-2-byte weights.

---

## Shared device / Intel / cache

- **Shared GPU device** — `Gemma4Vision.load(url, { host })` reuses the text
  kernel's device (`model.runtime.host`); a shared device is not destroyed on
  `dispose()`. `index.html` passes `host: model.runtime?.host`.
- **Intel `writeBuffer` workaround** — on Intel adapters, weight uploads use
  `mappedAtCreation` directly instead of `GPUQueue.writeBuffer` (which throws
  for these buffers and spammed warn logs). Other vendors keep chunked
  `writeBuffer` with a try/catch fallback.
- **Configurable vision cache** — `opts.cache === false`, `__G4V_NO_CACHE`, or
  `?nocache=1` (Chrome blob storage can be unreliable).

---

## Debugging gotchas

- **Range server required.** The kernel + vision loader stream
  `model.safetensors` with HTTP Range requests. `python3 -m http.server`
  ignores Range and returns the whole file → `RangeError: Array buffer
  allocation failed`. Always use `node tools/serve.mjs <port>`.
- **Dispatch dimension > 65535 = silent no-op.** A flat-index kernel passed the
  ELEMENT COUNT as the WORKGROUP COUNT to `dispatchWorkgroups(x, …)` → kernels
  never ran, features came back all-zero, with **no error**. Use
  `Math.ceil(elementCount / workgroup_size)`.
- **`writeBuffer` 3-arg wrapper.** The runtime host's `writeBuffer(buffer,
  bufferOffset, data)` writes the WHOLE `data` array (ignores dataOffset/size).
  Passing a 4/5-arg call caused `GPUValidationError: Write range … does not fit`
  — pass a `features.subarray(...)` slice covering exactly the rows needed.
- **Pipeline cache keys must include scales** (see the bug fix above).
- **Default storage-buffer limit.** The fused QKV kernel uses 6 storage buffers
  (≤ default `maxStorageBuffersPerShaderStage` of 8). A 10-buffer first version
  produced an invalid bind group + all-zero features on default-limit devices.

---

## Verification status

- ✅ Weight extraction validated in Node against the real 2.4 GB safetensors
  (header parse, merged Range spans, BF16 decode, I8 raw, shapes, scales).
- ✅ Preprocessing math validated in Node (`getAspectRatioPreservingSize`,
  `patchify`, `decodeBf16`).
- ✅ QAT dequant formula cross-checked against
  `transformers/integrations/gemma_quant.py` and the text kernel's `srq`.
- ✅ WGSL kernels at runtime — `test-vision.html` runs the GPU-vs-CPU matmul
  check and a full encode.

Run the harness:

```bash
node tools/serve.mjs 4173     # Range support required
# open http://localhost:4173/test-vision.html
```

---

## Known limitations

- The vision tower is validated against the CPU reference for the matmul and
  quantization math; the full-tower output is plausible and produces accurate
  descriptions but has not been diffed against a PyTorch/ONNX reference.
- Resizing uses the browser's high-quality canvas resampler (close to, but not
  bit-identical to, the HF image processor).
