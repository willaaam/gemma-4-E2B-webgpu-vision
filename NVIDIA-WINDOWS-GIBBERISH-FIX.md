# NVIDIA / Windows WebGPU gibberish fix

This document explains why Gemma 4 E2B produced corrupted, repetitive output on
Windows (especially NVIDIA + Chrome/Edge), and what this fork changed to make
generation coherent again.

**Status:** Confirmed working on this machine after the runtime guard was forced
to self-test and patch (or fall back) instead of taking the Apple-style
`exact32-stock` early exit.

---

## Symptom

The model loaded successfully, WebGPU reported no errors, and decode was fast —
but every reply was nonsense. Typical patterns:

- Opening with fragments like `Aula?` / `Aula:`
- Immediate collapse into repetition loops, e.g. repeating  
  `The key is to have a solid plan.` hundreds of times
- Stats still looked healthy (high tok/s, low TTFT)

This matched community reports on the upstream Hugging Face Space:

| Source | What it describes |
|--------|-------------------|
| [Space discussion #10](https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels/discussions/10) | `"Aula..."` then flood/repetition |
| [Space discussions #1 / #8](https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels/discussions/1) | NVIDIA adapter / subgroup issues; disable-subgroups workaround |
| [Space PR / discussion #13](https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels/discussions/13) | Root-cause fix (ready to merge, not on `main` at time of writing) |
| [Ar5en1c/gemma4-webgpu-nvidia-subgroup-fix](https://github.com/Ar5en1c/gemma4-webgpu-nvidia-subgroup-fix) | Full write-up, reproducer, and drop-in guard |

Apple Silicon was largely unaffected. The Space is tuned for M4 Max; NVIDIA on
Windows was the broken path.

---

## Root cause

### Not a model / tokenizer / UI bug

Weights downloaded and cached fine. The chat template and tokenizer were fine.
There was no JavaScript exception during generate. The corruption was numerical:
wrong values coming out of GPU matmul reductions, which the sampler then turned
into garbage tokens and loops.

### Where it breaks: QatMatMul + bare `subgroupAdd`

The engine bundle [`gemma-4-e2b.js`](gemma-4-e2b.js) embeds WGSL (Jinja) kernels.
Most reduction helpers already branch on `sgExact32`:

- **Exact 32-wide subgroup adapters** (typical Apple Metal): use hardware  
  `subgroupAdd`
- **Ranged-width adapters** (typical NVIDIA D3D12 reports 32–128): use a
  32-lane `subgroupShuffleXor` butterfly

**Eight QatMatMul-family sites did not.** They emitted a bare reduce:

```wgsl
fn reduce(value: f32, tid: u32) -> f32 {
  return subgroupAdd(value);
}
```

On NVIDIA’s D3D12 stack (Tint → HLSL → DXC → driver), a spec-valid
`subgroupAdd` executed **immediately after lane-divergent stores**
(`if (tid == 0u) { ... }`) can return **wrong sums**. That shows up especially
in `N_ROWS = 2` QatMatMul shapes (one workgroup writing two output rows).

Important nuance from the upstream investigation:

> In-kernel `@builtin(subgroup_size)` can still report **32** while the sums
> are wrong. This is not simply “wave width ≠ 32.” It is a platform
> miscompile / reconvergence failure around divergent control flow + subgroup
> reduction.

So: Xenova’s WGSL is correct per the WebGPU/WGSL spec; the platform executes
that pattern incorrectly on affected NVIDIA/Windows configurations.

### Why output looks like “language” then loops

Small, systematic errors in matmul logits do not crash the model. They skew the
argmax / sampling distribution. Early tokens look like random fragments
(`Aula?`); once the KV cache is polluted, decode often locks into a
high-probability repetition loop.

---

## What we tried first (and why it failed here)

We added the community drop-in runtime guard:

- File: [`gemma4-sg-guard.js`](gemma4-sg-guard.js)  
  (from [Ar5en1c/gemma4-webgpu-nvidia-subgroup-fix](https://github.com/Ar5en1c/gemma4-webgpu-nvidia-subgroup-fix), MIT)
- Wired in [`index.html`](index.html) before `Gemma4Mobile.load`

The guard’s intended ladder:

1. Adapter reports exact 32/32 → leave engine untouched (`exact32-stock`)
2. Ranged-width adapter → on-device self-test → rewrite bare reduce → butterfly  
   (`patched-sg`)
3. If butterfly still fails → disable `subgroups` entirely  
   (`nosubgroups-fallback`)

### First failure mode on this machine

Console showed:

```text
[gemma4-sg-guard] exact32-stock {}
```

Empty `selfTest` meant the guard hit:

```js
const exact32 = ad.info?.subgroupMinSize === 32
             && ad.info?.subgroupMaxSize === 32;
if (exact32 && !force) return result; // no patch, no self-test
```

Chrome on this Windows adapter reported **fixed 32/32**, so the guard assumed
the Apple-safe path and did nothing. Stock QatMatMul kept using bare
`subgroupAdd` → gibberish continued.

### Why upstream PR #13 alone would also miss this case

HF discussion #13 patches the Jinja templates to wrap those eight sites in
`{% if sgExact32 %} … {% else %} butterfly {% endif %}`.

If the adapter reports exact 32/32, `sgExact32` is true, so the templates still
emit bare `subgroupAdd`. This machine therefore needed a **runtime rewrite**
(or disable-subgroups), not only the template PR.

---

## What we changed (final fix)

### 1. Force the guard path in `index.html`

Before loading the model:

```js
import { gemma4SgGuard } from "./gemma4-sg-guard.js";

const guard = await gemma4SgGuard({ force: true });
console.info("[gemma4-sg-guard]", guard.mode, guard.adapter, guard.selfTest);
model = await Gemma4Mobile.load(null, {
  ...guard.loadOpts,
  onProgress: updateLoadProgress,
});
```

`force: true` skips the “exact 32 → do nothing” early return, runs the
on-device self-test, and then either:

- installs a `GPUDevice.prototype.createShaderModule` wrapper that rewrites
  bare `fn reduce… { return subgroupAdd(value); }` bodies to the
  `subgroupShuffleXor` butterfly (`mode: "patched-sg"`), or
- passes `runtimeOptions.disabledFeatures` to turn subgroups off
  (`mode: "nosubgroups-fallback"`).

### 2. Never take `exact32-stock` on Windows in `gemma4-sg-guard.js`

Even without `force`, Windows hosts skip the Apple early-return:

```js
function isWindowsHost() { /* platform / userAgent check */ }

if (exact32 && !force && !isWindowsHost()) return result;
```

Rationale: Windows can report 32/32 and still miscompile the bare reduce after
divergent stores. Apple keeps the bit-identical fast path.

### 3. Files touched

| File | Role |
|------|------|
| [`gemma4-sg-guard.js`](gemma4-sg-guard.js) | Self-test + shader rewriter / subgroups fallback; Windows bypass |
| [`index.html`](index.html) | Import guard, `force: true`, diagnostic logging, spread `loadOpts` into load |
| [`gemma-4-e2b.js`](gemma-4-e2b.js) | **Unmodified** — shaders are patched at `createShaderModule` time |

We deliberately did not hand-edit the 557KB minified engine. The guard patches
rendered WGSL as modules are compiled (kernels are created lazily, so
`guard.patched` increments during warmup / first generate).

---

## How to verify

1. Serve the Space locally (WebGPU needs a secure context / localhost), e.g.  
   `python -m http.server 8080`
2. Open `http://localhost:8080`, hard-refresh (Ctrl+Shift+R)
3. Click **Load model**
4. In DevTools console, expect something like:

   ```text
   [gemma4-sg-guard] patched-sg { vendor, subgroupMinSize, subgroupMaxSize, ... }
     { bare: "FAIL(...)", butterfly: "PASS" }
   ```

   or:

   ```text
   [gemma4-sg-guard] nosubgroups-fallback ...
   ```

   You should **not** see `exact32-stock {}` on Windows anymore.

5. Chat with a normal prompt. Answers should be coherent; no `Aula?` / sentence
   loops.

### Unrelated console noise

`THREE.WebGLRenderer: EXT_color_buffer_float extension not supported` comes from
the Three.js landing hero in [`landing.js`](landing.js). It is unrelated to
inference quality.

`powerPreference option is currently ignored … on Windows` is a Chromium
limitation ([crbug.com/369219127](https://crbug.com/369219127)), also unrelated.

---

## Architecture of the fix

```text
Load model
   │
   ▼
gemma4SgGuard({ force: true })
   │
   ├─ Apple exact-32 (no force, non-Windows) ──► exact32-stock (engine untouched)
   │
   ├─ self-test bare subgroupAdd
   │     FAIL on broken NVIDIA stacks
   ├─ self-test butterfly
   │     PASS → install createShaderModule patcher ──► patched-sg
   │     FAIL → disable subgroups feature          ──► nosubgroups-fallback
   │
   ▼
Gemma4Mobile.load(..., guard.loadOpts)
   │
   ▼
QatMatMul shaders compiled
   │  (patcher rewrites bare reduce → butterfly when subgroups stay on)
   ▼
Coherent token stream
```

---

## Performance notes

On the investigator’s RTX 5070 (Chrome 150, Windows):

| Config | Decode | Output |
|--------|--------|--------|
| Stock, subgroups on | ~218 tok/s | Corrupted |
| Disable subgroups (old workaround) | ~193 tok/s | Correct |
| Butterfly patch, subgroups on | ~213–223 tok/s | Correct |

So the preferred outcome is `patched-sg` (full subgroup speed, fixed reduces).
`nosubgroups-fallback` is slower but still correct — use it when the butterfly
self-test cannot pass.

---

## References

- Upstream Space:  
  https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels
- Root-cause PR:  
  https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels/discussions/13
- Standalone analysis + guard source:  
  https://github.com/Ar5en1c/gemma4-webgpu-nvidia-subgroup-fix
- Narrative write-up:  
  https://ar5en1c.hashnode.dev/on-device-llm-nvidia-webgpu-subgroup-bug
- Model:  
  `google/gemma-4-E2B-it-qat-mobile-transformers`

---

## Credits

- **Xenova / webml-community** — Gemma 4 E2B WebGPU engine and Space
- **Ar5en1c** — root-cause isolation, reproducer, HF PR #13, and `gemma4-sg-guard.js`
- **Intellipedia / igorls** — early NVIDIA reports and the disable-subgroups workaround
- This fork — forced guard + Windows early-exit bypass so adapters that report
  exact 32/32 still get patched or safely fall back
