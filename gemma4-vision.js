// gemma4-vision.js — Gemma 4 E2B vision tower as custom WebGPU/WGSL kernels.
//
// Produces the image "soft tokens" that the gemma-4-e2b.js LLM kernel expects
// at the image-token positions in the prompt, so the model can be used for
// vision without transformers.js or onnxruntime.
//
// The implementation is a faithful port of `Gemma4VisionModel` from
// huggingface/transformers (modeling_gemma4.py) using the *mobile QAT*
// checkpoint format (w8a8o8) — the same `srq` static-range-quantization scheme
// the text kernel uses for its QatMatMul ops:
//
//   srq(x, s) = s == 0 ? x : clamp(round(x / s), -128, 127) * s
//   linear(x) = srq( W_scale[o] * sum_k srq(x[k], inScale) * W_i8[o,k], outScale )
//
// Weights are streamed from `model.safetensors` (same file the text kernel
// loads) with HTTP Range requests; only the `vision_tower` + `embed_vision`
// tensors are fetched (~190 MB, cached in IndexedDB after the first run).
//
// Public API:
//   import { Gemma4Vision } from "./gemma4-vision.js";
//   const vision = await Gemma4Vision.load("https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers/resolve/main/model.safetensors", { onProgress });
//   const { image_features, num_soft_tokens } = await vision.encode(image);   // [num_soft_tokens, 1536] Float32Array
//   vision.dispose();

export const G4VISION_CFG = Object.freeze({
  hidden: 768,          // hidden_size
  heads: 12,            // num_attention_heads
  headDim: 64,          // head_dim
  layers: 16,           // num_hidden_layers
  intermediate: 3072,   // intermediate_size
  patchSize: 16,
  poolingKernel: 3,
  maxSoftTokens: 280,
  maxPatches: 2520,     // 280 * 3^2
  positionEmbedSize: 10240,
  ropeTheta: 100,
  eps: 1e-6,
  textHidden: 1536,
});

const WG = 256;                 // workgroup size for element-wise kernels
const WG_ATTN = 128;            // workgroup size for attention
const MAX_PATCHES = 2520;       // attention workgroup-storage bound (10 KB)

// ---------------------------------------------------------------------------
// BF16 -> F32 decode (bfloat16 weights: input_proj, position tables, norms)
// ---------------------------------------------------------------------------
export function decodeBf16(u16) {
  const n = u16.length;
  const out = new Float32Array(n);
  const u32 = new Uint32Array(out.buffer);
  for (let i = 0; i < n; i++) u32[i] = u16[i] << 16;
  return out;
}

function decodeBf16Bytes(bytes, offset) {
  const n = (bytes.length - offset) >> 1;
  const out = new Float32Array(n);
  const u32 = new Uint32Array(out.buffer);
  for (let i = 0; i < n; i++) u32[i] = (bytes[offset + i * 2] | (bytes[offset + i * 2 + 1] << 8)) << 16;
  return out;
}

// ---------------------------------------------------------------------------
// Safetensors reader (HTTP Range)
// ---------------------------------------------------------------------------
export class RangeReader {
  constructor(url, fetchImpl = globalThis.fetch) {
    this.url = url;
    // `fetch` is a Window method and throws "Illegal invocation" when called with
    // a different `this` — always bind it to the global object so `this.fetchImpl(...)`
    // below is safe. Custom fetch implementations ignore the binding.
    this.fetchImpl = typeof fetchImpl === "function" ? fetchImpl.bind(globalThis) : fetchImpl;
  }
  async readHeader() {
    const res = await this.fetchImpl(this.url, {
      headers: { Range: "bytes=0-7" },
    });
    if (!res.ok) throw new Error(`safetensors header probe failed (${res.status})`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.headerLen = Number(dv.getBigUint64(0, true));
    const headRes = await this.fetchImpl(this.url, {
      headers: { Range: `bytes=8-${7 + this.headerLen}` },
    });
    const headBuf = new Uint8Array(await headRes.arrayBuffer());
    this.header = JSON.parse(new TextDecoder().decode(headBuf));
    this.dataStart = 8 + this.headerLen;
  }
  /** byte span [start, end) in file */
  async readRange(start, end) {
    const res = await this.fetchImpl(this.url, {
      headers: { Range: `bytes=${start}-${end - 1}` },
    });
    if (!res.ok) throw new Error(`safetensors range read failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }
  /** Collect the given tensor byte spans (file offsets), merging contiguous ones. */
  async readMerged(spans) {
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    const merged = [];
    for (const s of sorted) {
      const last = merged[merged.length - 1];
      if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
      else merged.push({ start: s.start, end: s.end });
    }
    const buf = new Uint8Array(merged.reduce((a, b) => a + (b.end - b.start), 0));
    let o = 0;
    for (const m of merged) {
      const part = await this.readRange(m.start, m.end);
      buf.set(part, o);
      o += part.length;
    }
    return { buf, merged };
  }
}

// ---------------------------------------------------------------------------
// Weight extraction from safetensors header + merged ranges
// ---------------------------------------------------------------------------
const VISION_TENSOR_NAMES = (() => {
  const names = [
    "model.vision_tower.patch_embedder.input_proj.weight",
    "model.vision_tower.patch_embedder.position_embedding_table",
    "model.embed_vision.embedding_projection.weight",
  ];
  for (let l = 0; l < 16; l++) {
    const p = `model.vision_tower.encoder.layers.${l}`;
    names.push(`${p}.input_layernorm.weight`);
    names.push(`${p}.post_attention_layernorm.weight`);
    names.push(`${p}.pre_feedforward_layernorm.weight`);
    names.push(`${p}.post_feedforward_layernorm.weight`);
    names.push(`${p}.self_attn.q_norm.weight`);
    names.push(`${p}.self_attn.k_norm.weight`);
    for (const proj of ["q_proj", "k_proj", "v_proj", "o_proj"]) {
      names.push(`${p}.self_attn.${proj}.linear.weight`);
      names.push(`${p}.self_attn.${proj}.linear.weight_scale`);
      names.push(`${p}.self_attn.${proj}.linear.input_activation_scale`);
      names.push(`${p}.self_attn.${proj}.linear.output_activation_scale`);
    }
    for (const proj of ["gate_proj", "up_proj", "down_proj"]) {
      names.push(`${p}.mlp.${proj}.linear.weight`);
      names.push(`${p}.mlp.${proj}.linear.weight_scale`);
      names.push(`${p}.mlp.${proj}.linear.input_activation_scale`);
      names.push(`${p}.mlp.${proj}.linear.output_activation_scale`);
    }
  }
  return names;
})();

// ---------------------------------------------------------------------------
// IndexedDB cache for the vision weights (self-healing: any read error = miss,
// so a corrupted/evicted blob just triggers a re-download).
// ---------------------------------------------------------------------------
const VISION_CACHE_DB = "gemma4-vision-cache-v1";
const VISION_CACHE_STORE = "weights";

function visionCacheOpen() {
  if (typeof indexedDB === "undefined") return null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VISION_CACHE_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(VISION_CACHE_STORE)) req.result.createObjectStore(VISION_CACHE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function visionCacheGet(key) {
  let db = null;
  try {
    db = await visionCacheOpen();
    if (!db) return null;
    const blob = await new Promise((res, rej) => {
      const tx = db.transaction(VISION_CACHE_STORE, "readonly");
      const g = tx.objectStore(VISION_CACHE_STORE).get(key);
      g.onsuccess = () => res(g.result ?? null);
      g.onerror = () => rej(g.error);
    });
    if (!blob) return null;
    // If the blob's backing file is gone, arrayBuffer() throws NotReadableError -> treat as miss
    return new Uint8Array(await blob.arrayBuffer());
  } catch (_) {
    return null;
  } finally {
    if (db) try { db.close(); } catch (_) {}
  }
}

async function visionCachePut(key, bytes) {
  let db = null;
  try {
    db = await visionCacheOpen();
    if (!db) return;
    await new Promise((res, rej) => {
      const tx = db.transaction(VISION_CACHE_STORE, "readwrite");
      tx.objectStore(VISION_CACHE_STORE).put(new Blob([bytes.buffer]), key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch (_) {
    /* cache write is best-effort */
  } finally {
    if (db) try { db.close(); } catch (_) {}
  }
}

export async function loadVisionWeights(url, opts = {}) {
  const onProgress = opts.onProgress ?? (() => {});
  const reader = new RangeReader(url, opts.fetch);
  await reader.readHeader();
  onProgress({ status: "weights", phase: "indexing", message: "Indexing vision weights…" });

  // Resolve tensor descriptors (dtype, shape, data_offsets) for every tensor we need.
  const tensors = [];
  for (const name of VISION_TENSOR_NAMES) {
    const t = reader.header[name];
    if (!t) throw new Error(`missing vision tensor: ${name}`);
    const [o0, o1] = t.data_offsets;
    tensors.push({ name, dtype: t.dtype, shape: t.shape, start: reader.dataStart + o0, end: reader.dataStart + o1, bytes: o1 - o0 });
  }
  const totalBytes = tensors.reduce((a, t) => a + t.bytes, 0);

  // Cache key fingerprints the header + total size, so any model change busts it.
  const cacheKey = `${url}#${reader.headerLen}#${totalBytes}`;
  // Cache can be disabled with `opts.cache === false`, a global `__G4V_NO_CACHE`
  // flag, or `?nocache` on the URL (Chrome blob storage can be unreliable here).
  // A custom fetch (tests) always bypasses the cache.
  const urlNoCache = typeof location !== "undefined" && /[?&]nocache(?:[=&]|$)/.test(location.search);
  const useCache = !urlNoCache && opts.cache !== false && !opts.fetch && !globalThis.__G4V_NO_CACHE;

  // 1) cached packed bytes?
  let bytes = useCache ? await visionCacheGet(cacheKey) : null;
  // Chrome blob storage can evict/corrupt the backing file of an IndexedDB blob, which
  // makes blob.arrayBuffer() either throw (NotReadableError, caught above -> miss) or return
  // a truncated buffer. A truncated cache would slice tensors with wrong byte lengths and break
  // writeBuffer 4-byte alignment — treat any length mismatch as a miss and re-download.
  if (bytes && bytes.byteLength !== totalBytes) {
    console.warn(`[gemma4-vision] cache size mismatch (${bytes.byteLength} != ${totalBytes}); re-downloading`);
    bytes = null;
  }

  // 2) download + pack contiguously if we have no (valid) cached bytes
  if (!bytes) {
    const { buf, merged } = await reader.readMerged(tensors.map((t) => ({ start: t.start, end: t.end })));
    const spanBase = new Map();
    {
      let acc = 0;
      for (const m of merged) { spanBase.set(m.start, acc); acc += m.end - m.start; }
    }
    const slice = (filePos, len) => {
      for (const m of merged) {
        if (filePos >= m.start && filePos + len <= m.end) {
          return buf.subarray(spanBase.get(m.start) + (filePos - m.start), spanBase.get(m.start) + (filePos - m.start) + len);
        }
      }
      throw new Error(`bytes [${filePos}, ${filePos + len}) not fully covered by merged ranges`);
    };
    bytes = new Uint8Array(totalBytes);
    let o = 0;
    for (const t of tensors) {
      bytes.set(slice(t.start, t.bytes), o);
      o += t.bytes;
      onProgress({ status: "weights", kind: "bytes", loaded: o, total: totalBytes, fraction: o / totalBytes, message: `Vision weights ${(o / 1048576).toFixed(0)} MB` });
    }
    if (useCache) await visionCachePut(cacheKey, bytes);
  } else {
    onProgress({ status: "weights", kind: "bytes", loaded: totalBytes, total: totalBytes, fraction: 1, message: "Vision weights (cached)" });
  }

  // 3) decode each tensor from the packed buffer
  const out = {};
  let o = 0;
  for (const t of tensors) {
    const data = bytes.subarray(o, o + t.bytes);
    o += t.bytes;
    let arr;
    if (t.dtype === "BF16") {
      arr = decodeBf16Bytes(data, 0);
    } else if (t.dtype === "F32") {
      arr = new Float32Array(data.buffer, data.byteOffset, t.bytes >> 2).slice();
    } else if (t.dtype === "I8" || t.dtype === "U8") {
      // keep raw bytes; the WGSL matmul unpacks signed bytes directly
      arr = data.slice();
    } else {
      throw new Error(`unsupported vision dtype ${t.dtype} for ${t.name}`);
    }
    out[t.name] = { data: arr, dtype: t.dtype, shape: t.shape };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Image preprocessing — faithful port of transformers Gemma4ImageProcessor
// ---------------------------------------------------------------------------
export function getAspectRatioPreservingSize(height, width, patchSize, maxPatches, poolingKernelSize) {
  const targetPx = maxPatches * patchSize ** 2;
  const factor = Math.sqrt(targetPx / (height * width));
  const sideMult = poolingKernelSize * patchSize;
  let targetHeight = Math.floor((factor * height) / sideMult) * sideMult;
  let targetWidth = Math.floor((factor * width) / sideMult) * sideMult;
  if (targetHeight === 0 && targetWidth === 0) {
    throw new Error("Attempting to resize to a 0 x 0 image.");
  }
  const maxSideLength = Math.floor(maxPatches / poolingKernelSize ** 2) * sideMult;
  if (targetHeight === 0) {
    targetHeight = sideMult;
    targetWidth = Math.min(Math.floor(width / height) * sideMult, maxSideLength);
  } else if (targetWidth === 0) {
    targetWidth = sideMult;
    targetHeight = Math.min(Math.floor(height / width) * sideMult, maxSideLength);
  }
  return [targetHeight, targetWidth];
}

/** Patchify an RGBA-typed image into [num_patches, patchSize*patchSize*3] patches + [num_patches, 2] positions. */
export function patchify(hwcData, H, W, C, patchSize) {
  const numPatchesH = Math.floor(H / patchSize);
  const numPatchesW = Math.floor(W / patchSize);
  const numPatches = numPatchesH * numPatchesW;
  const patchDim = patchSize * patchSize * C;
  const patchData = new Float32Array(numPatches * patchDim);
  let out = 0;
  for (let ph = 0; ph < numPatchesH; ++ph) {
    for (let pw = 0; pw < numPatchesW; ++pw) {
      for (let dy = 0; dy < patchSize; ++dy) {
        const rowOffset = (ph * patchSize + dy) * W * C + pw * patchSize * C;
        for (let dx = 0; dx < patchSize; ++dx) {
          const src = rowOffset + dx * C;
          for (let c = 0; c < C; ++c) patchData[out++] = hwcData[src + c];
        }
      }
    }
  }
  const posData = new Int32Array(numPatches * 2);
  let idx = 0;
  for (let row = 0; row < numPatchesH; ++row) {
    for (let col = 0; col < numPatchesW; ++col) {
      posData[idx++] = col;
      posData[idx++] = row;
    }
  }
  return { patches: patchData, positions: posData, numPatches, numSoftTokens: Math.floor(numPatches / 9) };
}

/**
 * Normalize an image into an RGBA Uint8ClampedArray on an OffscreenCanvas.
 * Accepts: {data,width,height,channels} (RawImage-like), ImageData, canvas, or image element.
 */
async function toRgba(image) {
  // RawImage-like already provides data/width/height
  if (image && ArrayBuffer.isView(image.data) && typeof image.width === "number" && typeof image.height === "number") {
    const ch = image.channels ?? 4;
    if (ch === 4) return { data: image.data, width: image.width, height: image.height };
    // expand 1/3-channel to RGBA
    const n = image.width * image.height;
    const rgba = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = image.data[i * ch];
      rgba[i * 4 + 1] = ch > 1 ? image.data[i * ch + 1] : image.data[i * ch];
      rgba[i * 4 + 2] = ch > 1 ? image.data[i * ch + 2] : image.data[i * ch];
      rgba[i * 4 + 3] = 255;
    }
    return { data: rgba, width: image.width, height: image.height };
  }
  // Canvas / image element / ImageData
  const el = image instanceof HTMLCanvasElement || image instanceof HTMLImageElement || image instanceof ImageBitmap ? image : null;
  if (el) {
    const c = new OffscreenCanvas(el.width, el.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(el, 0, 0);
    const id = ctx.getImageData(0, 0, el.width, el.height);
    return { data: id.data, width: el.width, height: el.height };
  }
  if (image instanceof ImageData) return { data: image.data, width: image.width, height: image.height };
  throw new Error("unsupported image input; pass a RawImage-like {data,width,height,channels}, canvas, ImageData, or image element");
}

async function resizeRgba(rgba, tw, th) {
  const c = new OffscreenCanvas(rgba.width, rgba.height);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.putImageData(new ImageData(rgba.data, rgba.width, rgba.height), 0, 0);
  const c2 = new OffscreenCanvas(tw, th);
  const ctx2 = c2.getContext("2d");
  ctx2.imageSmoothingEnabled = true;
  ctx2.imageSmoothingQuality = "high";
  ctx2.drawImage(c, 0, 0, tw, th);
  const id = ctx2.getImageData(0, 0, tw, th);
  return { data: id.data, width: tw, height: th };
}

export async function preprocessImage(image, cfg = G4VISION_CFG) {
  const rgba = await toRgba(image);
  const maxPatches = cfg.maxSoftTokens * cfg.poolingKernel ** 2;
  const [th, tw] = getAspectRatioPreservingSize(rgba.height, rgba.width, cfg.patchSize, maxPatches, cfg.poolingKernel);
  let img = rgba;
  if (th !== rgba.height || tw !== rgba.width) img = await resizeRgba(rgba, tw, th);
  // Convert RGBA -> RGB float, rescale to [-1, 1] (do_rescale 1/255 then patch_embedder 2*(x-0.5)).
  const H = img.height, W = img.width, C = 3;
  const rgb = new Float32Array(H * W * C);
  const src = img.data;
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
    rgb[j] = (src[i] / 255) * 2 - 1;
    rgb[j + 1] = (src[i + 1] / 255) * 2 - 1;
    rgb[j + 2] = (src[i + 2] / 255) * 2 - 1;
  }
  return patchify(rgb, H, W, C, cfg.patchSize);
}

// ---------------------------------------------------------------------------
// WGSL kernels
// ---------------------------------------------------------------------------
const WGSL = {
  srq: `fn srq(x: f32, s: f32) -> f32 {
  if (s == 0.0) { return x; }
  return clamp(round(x / s), -128.0, 127.0) * s;
}`,

  // C[M,N] = srq( W_scale[N] * IN_SCALE * (Q_A · W_i8[N,K]) , outScale )
  // A: packed int8 [M*K/4] u32 (4 signed int8 per word); Wbits: u32 [N*K/4]; Wscale: f32 [N]
  matmulQat: `struct Params { M: u32 };
@group(0) @binding(0) var<storage, read> A: array<u32>;
@group(0) @binding(1) var<storage, read> Wbits: array<u32>;
@group(0) @binding(2) var<storage, read> Wscale: array<f32>;
@group(0) @binding(3) var<storage, read_write> C: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;
const K: u32 = {{K}}u;
const N: u32 = {{N}}u;
const K4: u32 = {{K}}u / 4u;
const IN_SCALE: f32 = {{IN_SCALE}};
const OUT_SCALE: f32 = {{OUT_SCALE}};
{{SRQ}}
@compute @workgroup_size(64, 4, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let m = gid.x;
  let n = gid.y;
  let M = params.M;
  if (m >= M || n >= N) { return; }
  var acc: i32 = 0;
  let aBase = m * K4;
  let wBase = n * K4;
  for (var kk = 0u; kk < K4; kk = kk + 1u) {
    acc = acc + dot4I8Packed(A[aBase + kk], Wbits[wBase + kk]);
  }
  C[m * N + n] = srq(Wscale[n] * IN_SCALE * f32(acc), OUT_SCALE);
}`,

  // Fused Q/K/V projections (one kernel instead of three). The z dimension picks
  // the segment (0=q, 1=k, 2=v). Weights are pre-concatenated at load time into
  // a single [3N, K] buffer (W) + a single [3N] scale buffer (S) so the kernel
  // stays within the DEFAULT maxStorageBuffersPerShaderStage (8). The input is
  // packed int8 (A: u32 [M*K/4]) and the inner loop uses dot4I8Packed.
  matmulQkv: `struct Params { M: u32 };
@group(0) @binding(0) var<storage, read> A: array<u32>;
@group(0) @binding(1) var<storage, read> W: array<u32>;
@group(0) @binding(2) var<storage, read> S: array<f32>;
@group(0) @binding(3) var<storage, read_write> QT: array<f32>;
@group(0) @binding(4) var<storage, read_write> KT: array<f32>;
@group(0) @binding(5) var<storage, read_write> VT: array<f32>;
@group(0) @binding(6) var<uniform> params: Params;
const K: u32 = {{K}}u;
const N: u32 = {{N}}u;
const K4: u32 = {{K}}u / 4u;
const IN_Q: f32 = {{IN_Q}};
const OUT_Q: f32 = {{OUT_Q}};
const IN_K: f32 = {{IN_K}};
const OUT_K: f32 = {{OUT_K}};
const IN_V: f32 = {{IN_V}};
const OUT_V: f32 = {{OUT_V}};
{{SRQ}}
@compute @workgroup_size(64, 4, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let m = gid.x;
  let n = gid.y;
  let seg = gid.z;
  let M = params.M;
  if (m >= M || n >= N || seg >= 3u) { return; }
  let inS = select(select(IN_Q, IN_K, seg == 1u), IN_V, seg == 2u);
  let outS = select(select(OUT_Q, OUT_K, seg == 1u), OUT_V, seg == 2u);
  var acc: i32 = 0;
  let aBase = m * K4;
  let wBase = (seg * N + n) * K4;
  for (var kk = 0u; kk < K4; kk = kk + 1u) {
    acc = acc + dot4I8Packed(A[aBase + kk], W[wBase + kk]);
  }
  let val = srq(S[seg * N + n] * inS * f32(acc), outS);
  if (seg == 0u) {
    QT[m * N + n] = val;
  } else if (seg == 1u) {
    KT[m * N + n] = val;
  } else {
    VT[m * N + n] = val;
  }
}`,

  // Fused gate/up projections + gelu_tanh, one kernel (replaces 3 dispatches:
  // gate matmul, up matmul, geluMul). Input is packed int8 (A: u32 [M*K/4]); the
  // inner loop uses dot4I8Packed for both gate and up (i32 accumulate).
  matmulGateUp: `struct Params { M: u32 };
@group(0) @binding(0) var<storage, read> A: array<u32>;
@group(0) @binding(1) var<storage, read> WG: array<u32>;
@group(0) @binding(2) var<storage, read> WU: array<u32>;
@group(0) @binding(3) var<storage, read> SG: array<f32>;
@group(0) @binding(4) var<storage, read> SU: array<f32>;
@group(0) @binding(5) var<storage, read_write> OUT: array<f32>;
@group(0) @binding(6) var<uniform> params: Params;
const K: u32 = {{K}}u;
const I: u32 = {{I}}u;
const K4: u32 = {{K}}u / 4u;
const IN_G: f32 = {{IN_G}};
const OUT_G: f32 = {{OUT_G}};
const IN_U: f32 = {{IN_U}};
const OUT_U: f32 = {{OUT_U}};
{{SRQ}}
@compute @workgroup_size(64, 4, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let m = gid.x;
  let n = gid.y;
  let M = params.M;
  if (m >= M || n >= I) { return; }
  var ag: i32 = 0;
  var au: i32 = 0;
  let aBase = m * K4;
  let wBase = n * K4;
  for (var kk = 0u; kk < K4; kk = kk + 1u) {
    let ap = A[aBase + kk];
    ag = ag + dot4I8Packed(ap, WG[wBase + kk]);
    au = au + dot4I8Packed(ap, WU[wBase + kk]);
  }
  let gate = srq(SG[n] * IN_G * f32(ag), OUT_G);
  let up = srq(SU[n] * IN_U * f32(au), OUT_U);
  let c = 0.7978845608028654 * (gate + 0.044715 * gate * gate * gate); // sqrt(2/pi)
  let gelu = 0.5 * gate * (1.0 + tanh(c));
  OUT[m * I + n] = gelu * up;
}`,

  // f32 -> packed int8 (4 signed int8 per u32), one thread per 4 elements. Builds
  // matmul inputs so the matmuls can use dot4I8Packed (true int8 dot products).
  quantizeI8: `struct Params { M: u32 };
@group(0) @binding(0) var<storage, read> X: array<f32>;
@group(0) @binding(1) var<storage, read_write> OUT: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;
const SCALE: f32 = {{SCALE}};
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let gi = gid.x;
  if (gi >= params.M) { return; }
  let idx = gi * 4u;
  var packed: u32 = 0u;
  for (var j = 0u; j < 4u; j = j + 1u) {
    let v = X[idx + j];
    let q = i32(clamp(round(v / SCALE), -128.0, 127.0)) & 0xFF;
    packed = packed | (u32(q) << (j * 8u));
  }
  OUT[gi] = packed;
}`,

  // C[M,N] = A[M,K] @ W[N,K]   (plain F32 weights, no srq)
  matmulF32: `struct Params { M: u32 };
@group(0) @binding(0) var<storage, read> A: array<f32>;
@group(0) @binding(1) var<storage, read> W: array<f32>;
@group(0) @binding(2) var<storage, read_write> C: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;
const K: u32 = {{K}}u;
const N: u32 = {{N}}u;
@compute @workgroup_size(64, 4, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let m = gid.x;
  let n = gid.y;
  let M = params.M;
  if (m >= M || n >= N) { return; }
  var acc = 0.0;
  for (var k = 0u; k < K; k = k + 1u) {
    acc = acc + A[m * K + k] * W[n * K + k];
  }
  C[m * N + n] = acc;
}`,

  // y = x * rsqrt(mean(x^2) + eps) * weight   (weight optional via HAS_W)
  rmsNorm: `struct Params { M: u32 };
@group(0) @binding(0) var<storage, read> X: array<f32>;
@group(0) @binding(1) var<storage, read> W: array<f32>;
@group(0) @binding(2) var<storage, read_write> Y: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;
const D: u32 = {{D}}u;
const EPS: f32 = {{EPS}};
const HAS_W: u32 = {{HAS_W}}u;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let m = gid.x;
  let M = params.M;
  if (m >= M) { return; }
  var sum = 0.0;
  for (var d = 0u; d < D; d = d + 1u) {
    let v = X[m * D + d];
    sum = sum + v * v;
  }
  let inv = inverseSqrt(sum / f32(D) + EPS);
  if (HAS_W == 1u) {
    for (var d = 0u; d < D; d = d + 1u) { Y[m * D + d] = X[m * D + d] * inv * W[d]; }
  } else {
    for (var d = 0u; d < D; d = d + 1u) { Y[m * D + d] = X[m * D + d] * inv; }
  }
}`,

  // cos/sin tables for 2D RoPE from patch positions.
  // inv_freq: f32[16]; Pos: i32[M,2]; Cos/Sin: f32[M,64]
  // layout: [x_freqs 16, x_freqs 16, y_freqs 16, y_freqs 16]
  ropeCosSin: `struct Params { M: u32 };
@group(0) @binding(0) var<storage, read> Pos: array<i32>;
@group(0) @binding(1) var<storage, read> InvFreq: array<f32>;
@group(0) @binding(2) var<storage, read_write> Cos: array<f32>;
@group(0) @binding(3) var<storage, read_write> Sin: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;
const SPATIAL: u32 = 32u;
const NF: u32 = 16u;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let m = gid.x;
  let M = params.M;
  if (m >= M) { return; }
  let px = f32(Pos[m * 2 + 0]);
  let py = f32(Pos[m * 2 + 1]);
  for (var i = 0u; i < NF; i = i + 1u) {
    let fx = px * InvFreq[i];
    let fy = py * InvFreq[i];
    let cx = cos(fx); let sx = sin(fx);
    let cy = cos(fy); let sy = sin(fy);
    Cos[m * 64 + i] = cx;       Cos[m * 64 + 16u + i] = cx;
    Cos[m * 64 + 32u + i] = cy; Cos[m * 64 + 48u + i] = cy;
    Sin[m * 64 + i] = sx;       Sin[m * 64 + 16u + i] = sx;
    Sin[m * 64 + 32u + i] = sy; Sin[m * 64 + 48u + i] = sy;
  }
}`,

  // 2D RoPE applied to Q/K (M, NH, 64). Positions are baked into Cos/Sin already.
  ropeApply: `struct Params { M: u32 };
@group(0) @binding(0) var<storage, read> X: array<f32>;
@group(0) @binding(1) var<storage, read> Cos: array<f32>;
@group(0) @binding(2) var<storage, read> Sin: array<f32>;
@group(0) @binding(3) var<storage, read_write> Y: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;
const NH: u32 = {{NH}}u;
const HD: u32 = {{HD}}u;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  let M = params.M;
  if (idx >= M * NH * HD) { return; }
  let m = idx / (NH * HD);
  let hd = idx % (NH * HD);
  let h = hd / HD;
  let d = hd % HD;
  let half = select(1u, 0u, d < 32u);
  let i = d % 32u;
  let partner = select(d - 16u, d + 16u, i < 16u);
  let x = X[idx];
  let xp = X[m * NH * HD + h * HD + partner];
  let cosv = Cos[m * 64 + half * 32 + i];
  let sinv = Sin[m * 64 + half * 32 + i];
  let sign = select(1.0, -1.0, i < 16u);
  Y[idx] = x * cosv + sign * xp * sinv;
}`,

  // Bidirectional attention, NO scale (scaling = 1.0). One workgroup per (m,h).
  // Optimized: vec4<f32> QK dot products + parallel (tree) max/sum reductions
  // (the original had thread 0 scan all M scores serially, which dominated).
  attention: `struct Params { M: u32 };
@group(0) @binding(0) var<storage, read> Q: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> K: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> V: array<f32>;
@group(0) @binding(3) var<storage, read_write> O: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;
const NH: u32 = {{NH}}u;
const HD: u32 = {{HD}}u;
const HD4: u32 = {{HD}}u / 4u;
const MMAX: u32 = {{MMAX}}u;
const WGS: u32 = {{WG}}u;
var<workgroup> scores: array<f32, MMAX>;
var<workgroup> reds: array<f32, {{WG}}>;
@compute @workgroup_size({{WG}})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let M = params.M;
  let mh = wg.x;
  if (mh >= M * NH) { return; }
  let h = mh % NH;
  let tid = lid.x;
  let qw = mh * HD4;
  // 1) scores[j] = dot(q[m,h], k[j,h]) — vec4 QK
  var localMax = -1e30;
  var j = tid;
  loop {
    if (j >= M) { break; }
    var s = 0.0;
    let kw = (j * NH + h) * HD4;
    for (var dd = 0u; dd < HD4; dd = dd + 1u) {
      s = s + dot(Q[qw + dd], K[kw + dd]);
    }
    scores[j] = s;
    localMax = max(localMax, s);
    j = j + WGS;
  }
  // 2) parallel max reduction across the workgroup
  workgroupBarrier();
  reds[tid] = localMax;
  workgroupBarrier();
  var stride = WGS / 2u;
  while (stride > 0u) {
    if (tid < stride) { reds[tid] = max(reds[tid], reds[tid + stride]); }
    workgroupBarrier();
    stride = stride / 2u;
  }
  let maxv = reds[0];
  // 3) exp + parallel sum reduction
  var localSum = 0.0;
  j = tid;
  loop {
    if (j >= M) { break; }
    let e = exp(scores[j] - maxv);
    scores[j] = e;
    localSum = localSum + e;
    j = j + WGS;
  }
  workgroupBarrier();
  reds[tid] = localSum;
  workgroupBarrier();
  stride = WGS / 2u;
  while (stride > 0u) {
    if (tid < stride) { reds[tid] = reds[tid] + reds[tid + stride]; }
    workgroupBarrier();
    stride = stride / 2u;
  }
  let inv = 1.0 / reds[0];
  // 4) output: O[mh,d] = inv * sum_j scores[j] * V[j,h,d]  (parallel over d)
  var d = tid;
  loop {
    if (d >= HD) { break; }
    var acc = 0.0;
    for (var jj = 0u; jj < M; jj = jj + 1u) {
      acc = acc + scores[jj] * V[(jj * NH + h) * HD + d];
    }
    O[mh * HD + d] = acc * inv;
    d = d + WGS;
  }
}`,

  // avg-pool 3x3 patches -> soft tokens, scale by sqrt(hidden)
  pool: `struct Params { M: u32 };
@group(0) @binding(0) var<storage, read> X: array<f32>;
@group(0) @binding(1) var<storage, read> PoolSrc: array<u32>;
@group(0) @binding(2) var<storage, read_write> Out: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;
const D: u32 = {{D}}u;
const PS: u32 = {{PS}}u; // pooling kernel size squared (9)
const SCALE: f32 = {{SCALE}}; // sqrt(hidden)
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  let M = params.M;
  let P = M / PS;
  if (idx >= P * D) { return; }
  let p = idx / D;
  let d = idx % D;
  var acc = 0.0;
  for (var j = 0u; j < PS; j = j + 1u) {
    let s = PoolSrc[p * PS + j];
    acc = acc + X[s * D + d];
  }
  Out[idx] = acc * SCALE / f32(PS);
}`,

  // y = x * rsqrt(mean(x^2)+eps)  (no weight)  — for embed_vision pre-projection norm
  // (reuses rmsNorm with HAS_W=0)
};

// ---------------------------------------------------------------------------
// GPU runtime
// ---------------------------------------------------------------------------
function fmt(n) {
  return Object.is(n, -0) ? "0.0" : String(n);
}

class VisionGPU {
  constructor(device) {
    this.device = device;
    this.pipelines = new Map();
    this.bindGroupLayouts = new Map();
  }
  // modes: per-binding "ro" | "rw" | "uniform" — must EXACTLY match the shader's
  // access modes (a shader `var<storage, read>` requires read-only-storage in the layout;
  // `var<storage, read_write>` requires storage; `var<uniform>` requires uniform).
  _layout(modes) {
    const key = modes.join(",");
    let l = this.bindGroupLayouts.get(key);
    if (l) return l;
    const entries = modes.map((m, i) => ({
      binding: i,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: m === "uniform" ? "uniform" : m === "rw" ? "storage" : "read-only-storage" },
    }));
    l = this.device.createBindGroupLayout({ entries });
    this.bindGroupLayouts.set(key, l);
    return l;
  }
  _pipeline(key, wgsl, modes) {
    let p = this.pipelines.get(key);
    if (p) return p;
    const mod = this.device.createShaderModule({ code: wgsl });
    const pipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._layout(modes)] }),
      compute: { module: mod, entryPoint: "main" },
    });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }
  _bind(pipeline, modes, buffers) {
    const entries = buffers.map((b, i) => ({ binding: i, resource: { buffer: b.buffer, offset: b.offset ?? 0, size: b.size ?? undefined } }));
    return this.device.createBindGroup({ layout: this._layout(modes), entries });
  }
}

/** Minimal GPU buffer helpers (storage + copy-src). */
function makeBuf(device, size) {
  return device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
}

// ---------------------------------------------------------------------------
// Gemma4Vision
// ---------------------------------------------------------------------------
export class Gemma4Vision {
  /**
   * @param {string} weightsUrl path/URL to the mobile QAT model.safetensors
   * @param {{onProgress?: Function, fetch?: typeof fetch, host?: object, cache?: boolean}} opts
   *   `opts.host` — optional kernel runtime host (`Gemma4Mobile` exposes it as
   *   `model.runtime.host`) holding `{ device, adapter, ... }`. When passed, the
   *   vision tower shares the text kernel's WebGPU device instead of requesting a
   *   second one (reduces memory pressure on integrated GPUs). The shared device
   *   is owned by the kernel and is NOT destroyed on `dispose()`.
   */
  static async load(weightsUrl, opts = {}) {
    const cfg = G4VISION_CFG;
    const onProgress = opts.onProgress ?? (() => {});
    // Reuse the text kernel's WebGPU device when the caller passes its runtime
    // host (index.html passes `model.runtime.host`).
    const host = opts.host && opts.host.device ? opts.host : null;
    let device, adapter;
    if (host) {
      device = host.device;
      adapter = host.adapter ?? null;
    } else {
      onProgress({ status: "init", message: "Requesting WebGPU device (vision)…" });
      if (!navigator.gpu) throw new Error("WebGPU is not available");
      adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("no WebGPU adapter");
      device = await adapter.requestDevice();
    }
    const gpu = new VisionGPU(device);

    onProgress({ status: "weights", message: "Downloading vision weights…" });
    const w = await loadVisionWeights(weightsUrl, { onProgress, fetch: opts.fetch, cache: opts.cache });

    // Upload weights into GPU storage buffers.
    // GPUQueue.writeBuffer is unreliable for the big weight buffers on Intel
    // iGPUs (throws validation errors every call, then falls back). Prefer
    // mappedAtCreation there so uploads are silent; other vendors keep the fast
    // writeBuffer path with a try/catch fallback for safety.
    const isIntel = /intel/i.test(adapter?.info?.vendor ?? "");
    const B = {};
    const up = (key, arr, needsPad4) => {
      const raw = arr.byteLength;
      // writeBuffer requires 4-byte aligned sizes; round down defensively (valid
      // tensors are already multiples of 4).
      const bytes = raw - (raw % 4);
      if (bytes <= 0) { B[key] = makeBuf(device, 4); return; }
      const size = needsPad4 ? Math.ceil(bytes / 4) * 4 : bytes;
      const src = arr instanceof Uint8Array ? arr : new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      let buf;
      const mappedPath = () => {
        buf = device.createBuffer({
          size,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
          mappedAtCreation: true,
        });
        const dst = new Uint8Array(buf.getMappedRange());
        dst.set(src.subarray(0, bytes));
        buf.unmap();
      };
      if (isIntel) {
        // Intel iGPU: bypass GPUQueue.writeBuffer entirely (it fails for these
        // buffers and the fallback would spam the console on every upload).
        mappedPath();
      } else {
        try {
          buf = makeBuf(device, size);
          const CHUNK = 4 * 1024 * 1024; // 4 MiB per call
          for (let off = 0; off < bytes; off += CHUNK) {
            const len = Math.min(CHUNK, bytes - off);
            device.queue.writeBuffer(buf, off, arr, off, len);
          }
        } catch (e) {
          console.warn(`[gemma4-vision] writeBuffer failed for ${key} (byteLength=${raw}), falling back to mappedAtCreation`, e);
          try { buf?.destroy?.(); } catch (_) {}
          mappedPath();
        }
      }
      B[key] = buf;
    };
    const scalar = (t) => t.data[0] ?? 0;

    // `loadVisionWeights` returns a map keyed by tensor name -> { data, dtype, shape };
    // upload every tensor except the static activation scales (baked into the kernels).
    for (const [name, t] of Object.entries(w)) {
      if (name.includes("_activation_scale")) continue; // baked into kernels as constants
      up(name, t.data, true);
    }
    // scalars referenced by name
    const sc = (name) => scalar(w[name]);

    // norm weight tensors (BF16) uploaded; ones-buffer for no-scale norms
    const ones768 = new Float32Array(cfg.hidden).fill(1);
    const ones64 = new Float32Array(cfg.headDim).fill(1);
    up("__ones768", ones768, true);
    up("__ones64", ones64, true);

    const invFreq = new Float32Array(16);
    for (let i = 0; i < 16; i++) invFreq[i] = Math.pow(cfg.ropeTheta, -i / 16);
    up("__invFreq", invFreq, true);

    // Concatenate each layer's q/k/v projection weights + row scales into single
    // [3*N, K] I8 and [3*N] F32 buffers. The fused QKV kernel reads them through
    // one storage binding each, keeping it within the DEFAULT
    // maxStorageBuffersPerShaderStage (8) so it also works on devices that don't
    // request the higher limit (e.g. test-vision.html's default-limit device).
    for (let l = 0; l < cfg.layers; l++) {
      const p = `model.vision_tower.encoder.layers.${l}`;
      const wq = w[`${p}.self_attn.q_proj.linear.weight`].data;
      const wk = w[`${p}.self_attn.k_proj.linear.weight`].data;
      const wv = w[`${p}.self_attn.v_proj.linear.weight`].data;
      const rowBytes = wq.byteLength; // N * K bytes
      const wCombined = new Uint8Array(rowBytes * 3);
      wCombined.set(wq, 0); wCombined.set(wk, rowBytes); wCombined.set(wv, 2 * rowBytes);
      up(`__qkv_w_${l}`, wCombined, true);

      const sq = w[`${p}.self_attn.q_proj.linear.weight_scale`].data;
      const sk = w[`${p}.self_attn.k_proj.linear.weight_scale`].data;
      const sv = w[`${p}.self_attn.v_proj.linear.weight_scale`].data;
      const sCombined = new Float32Array(3 * cfg.hidden);
      sCombined.set(sq, 0); sCombined.set(sk, cfg.hidden); sCombined.set(sv, 2 * cfg.hidden);
      up(`__qkv_s_${l}`, sCombined, true);
    }

    // Reference weight accessors
    const ref = (n) => w[n].data;

    const vision = new Gemma4Vision({ device, gpu, adapter, B, w, ref, sc, cfg, weightsUrl, onProgress, sharedDevice: !!host });
    vision._uploaded = true;
    return vision;
  }

  constructor(deps) {
    Object.assign(this, deps);
    this._tmp = [];
    this._disposed = false;
    this._pipe = this.gpu;
  }

  _buf(size) {
    const b = makeBuf(this.device, Math.max(size, 4));
    this._tmp.push(b);
    return b;
  }
  _f32buf(arr) {
    const b = this._buf(arr.byteLength);
    this.device.queue.writeBuffer(b, 0, arr);
    return { buffer: b };
  }

  // ---- kernel invocation helpers ----
  // When `_batchEnc` is set, kernels are recorded into that command encoder (one
  // compute pass each) instead of submitting per-op; `_batch()` submits once.
  // This cuts ~200 queue.submit calls down to one per encode().
  _run(key, wgsl, modes, buffers, x, y, z) {
    const pipeline = this._pipe._pipeline(key, wgsl, modes);
    const bg = this._pipe._bind(pipeline, modes, buffers);
    const enc = this._batchEnc ?? this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(x, y, z);
    pass.end();
    if (!this._batchEnc) this.device.queue.submit([enc.finish()]);
  }

  /** Run `fn`'s kernels in a single command encoder + one queue.submit. */
  _batch(fn) {
    if (this._batchEnc) return fn(); // nested batch — just record
    const enc = this.device.createCommandEncoder();
    this._batchEnc = enc;
    try { fn(); } finally { this._batchEnc = null; }
    this.device.queue.submit([enc.finish()]);
  }

  _uniform(m) {
    // uniform struct `{ M: u32 }` is padded to 16 bytes by WGSL; the buffer MUST
    // carry GPUBufferUsage.UNIFORM (a storage buffer can't back a uniform binding).
    // Cache one buffer per distinct value: there are ~160 dispatches per encode and
    // each used to create a fresh 16-byte buffer — reusing avoids that churn.
    let b = this._uniformCache?.get(m);
    if (!b) {
      b = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      (this._uniformCache ??= new Map()).set(m, b);
    }
    const arr = new Uint32Array([m, 0, 0, 0]);
    this.device.queue.writeBuffer(b, 0, arr);
    return { buffer: b };
  }

  _read(buf, len) {
    const size = Math.max(len, 4);
    const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(buf, 0, staging, 0, size);
    this.device.queue.submit([enc.finish()]);
    return staging.mapAsync(GPUMapMode.READ).then(() => {
      const out = new Float32Array(staging.getMappedRange().slice(0, len)).slice();
      staging.unmap();
      staging.destroy();
      return out;
    });
  }

  _matmulQat(key, aT, bitsT, scaleT, outT, M, N, K, inScale, outScale) {
    const wgsl = WGSL.matmulQat
      .replaceAll("{{K}}", fmt(K)).replaceAll("{{N}}", fmt(N))
      .replaceAll("{{IN_SCALE}}", fmt(inScale)).replaceAll("{{OUT_SCALE}}", fmt(outScale))
      .replace("{{SRQ}}", WGSL.srq);
    const buffers = [aT, { buffer: bitsT }, { buffer: scaleT }, outT, this._uniform(M)];
    this._run(`qat_${N}_${K}_${inScale}_${outScale}`, wgsl, ["ro", "ro", "ro", "rw", "uniform"], buffers, Math.ceil(M / 64), Math.ceil(N / 4), 1);
  }

  _matmulF32(key, aT, wT, outT, M, N, K) {
    const wgsl = WGSL.matmulF32.replaceAll("{{K}}", fmt(K)).replaceAll("{{N}}", fmt(N));
    const buffers = [aT, { buffer: wT }, outT, this._uniform(M)];
    this._run(`f32_${N}_${K}`, wgsl, ["ro", "ro", "rw", "uniform"], buffers, Math.ceil(M / 64), Math.ceil(N / 4), 1);
  }

  // Fused q/k/v projections: one dispatch computes Q, K and V from the same
  // normalized input (z dimension selects the projection), writing 3 buffers.
  // `wqkvT`/`sqkvT` are the load-time concatenated [3N,K] I8 / [3N] F32 buffers.
  _matmulQkv(key, aT, wqkvT, sqkvT, qT, kT, vT, M, N, K, { inQ, outQ, inK, outK, inV, outV }) {
    const wgsl = WGSL.matmulQkv
      .replaceAll("{{K}}", fmt(K)).replaceAll("{{N}}", fmt(N))
      .replaceAll("{{IN_Q}}", fmt(inQ)).replaceAll("{{OUT_Q}}", fmt(outQ))
      .replaceAll("{{IN_K}}", fmt(inK)).replaceAll("{{OUT_K}}", fmt(outK))
      .replaceAll("{{IN_V}}", fmt(inV)).replaceAll("{{OUT_V}}", fmt(outV))
      .replace("{{SRQ}}", WGSL.srq);
    const buffers = [aT, { buffer: wqkvT }, { buffer: sqkvT }, qT, kT, vT, this._uniform(M)];
    // 6 storage + 1 uniform = 7 bindings (<= default maxStorageBuffersPerShaderStage 8)
    // The key MUST include the baked-in per-layer activation scales, otherwise
    // layers 1-15 reuse layer 0's cached pipeline (with layer 0's scales) and the
    // q/k/v values (and thus the whole network) are computed with the wrong scales.
    this._run(`qkv_${N}_${K}_${inQ}_${outQ}_${inK}_${outK}_${inV}_${outV}`, wgsl, ["ro", "ro", "ro", "rw", "rw", "rw", "uniform"], buffers, Math.ceil(M / 64), Math.ceil(N / 4), 3);
  }

  // Fused gate/up projections + gelu_tanh: one dispatch produces the gated MLP
  // input directly (no intermediate gate/up buffers, no separate gelu pass).
  _matmulGateUp(key, aT, wgT, wuT, sgT, suT, outT, M, I, K, { inG, outG, inU, outU }) {
    const wgsl = WGSL.matmulGateUp
      .replaceAll("{{K}}", fmt(K)).replaceAll("{{I}}", fmt(I))
      .replaceAll("{{IN_G}}", fmt(inG)).replaceAll("{{OUT_G}}", fmt(outG))
      .replaceAll("{{IN_U}}", fmt(inU)).replaceAll("{{OUT_U}}", fmt(outU))
      .replace("{{SRQ}}", WGSL.srq);
    const buffers = [aT, { buffer: wgT }, { buffer: wuT }, { buffer: sgT }, { buffer: suT }, outT, this._uniform(M)];
    // key MUST include the baked-in per-layer scales (see _matmulQkv note)
    this._run(`gup_${I}_${K}_${inG}_${outG}_${inU}_${outU}`, wgsl, ["ro", "ro", "ro", "ro", "ro", "rw", "uniform"], buffers, Math.ceil(M / 64), Math.ceil(I / 4), 1);
  }

  _rms(key, xT, wT, outT, M, D, hasW, eps = G4VISION_CFG.eps) {
    const wgsl = WGSL.rmsNorm.replaceAll("{{D}}", fmt(D)).replaceAll("{{EPS}}", fmt(eps)).replaceAll("{{HAS_W}}", hasW ? "1" : "0");
    const buffers = [xT, { buffer: wT }, outT, this._uniform(M)];
    // rmsNorm workgroup_size is 64; dispatch x = workgroup count (covers M rows)
    this._run(`rms_${D}_${hasW}`, wgsl, ["ro", "ro", "rw", "uniform"], buffers, Math.ceil(M / 64), 1, 1);
  }

  // Quantize an f32 activation to packed int8 (4 per u32) so matmuls can use
  // dot4I8Packed. `total4` = number of packed words = M*D/4 (D is always a
  // multiple of 4). The kernel bakes the per-matmul input_activation_scale.
  _quantizeI8(key, xT, outT, total4, scale) {
    const wgsl = WGSL.quantizeI8.replaceAll("{{SCALE}}", fmt(scale));
    const buffers = [xT, outT, this._uniform(total4)];
    this._run(`q8_${scale}`, wgsl, ["ro", "rw", "uniform"], buffers, Math.ceil(total4 / 256), 1, 1);
  }

  // ---- public API ----
  /**
   * Encode an image into soft tokens.
   * @returns {Promise<{image_features: Float32Array, num_soft_tokens: number, num_patches: number}>}
   */
  async encode(image) {
    if (this._disposed) throw new Error("Gemma4Vision has been disposed");
    const cfg = this.cfg;
    const d = this.device;
    const { patches, positions, numPatches, numSoftTokens } = await preprocessImage(image, cfg);
    const M = numPatches;

    // scratch tensors
    const B = this.B;
    const pad = (arr) => { const b = this._buf(arr.byteLength); d.queue.writeBuffer(b, 0, arr); return { buffer: b }; };
    const patchBuf = pad(patches);
    const posBuf = pad(positions);
    const f32 = (key, len) => ({ buffer: this._buf(len * 4) });

    const hidden = f32("h", M * cfg.hidden);
    const q = f32("q", M * cfg.hidden), k = f32("k", M * cfg.hidden), v = f32("v", M * cfg.hidden);
    const qn = f32("qn", M * cfg.hidden), kn = f32("kn", M * cfg.hidden), vn = f32("vn", M * cfg.hidden);
    const cos = f32("cos", M * 64), sin = f32("sin", M * 64);
    const attn = f32("attn", M * cfg.hidden);
    const oproj = f32("oproj", M * cfg.hidden);
    const gated = f32("gated", M * cfg.intermediate);
    const down = f32("down", M * cfg.hidden);
    const normed = f32("normed", M * cfg.hidden);
    const pooled = f32("pooled", numSoftTokens * cfg.hidden);
    const normedP = f32("normedP", numSoftTokens * cfg.hidden);
    const feats = f32("feats", numSoftTokens * cfg.textHidden);

    // packed int8 matmul inputs (4 signed int8 per u32). Storing the activations
    // that feed matmuls as int8 (instead of f32) cuts activation traffic 4x and
    // lets the matmuls use WGSL dot4I8Packed (true int8 dot products).
    const u32w = (key, words) => ({ buffer: this._buf(words * 4) });
    const qkvInI8 = u32w("qkvIn", (M * cfg.hidden) / 4);
    const attnInI8 = u32w("attnIn", (M * cfg.hidden) / 4);
    const guInI8 = u32w("guIn", (M * cfg.hidden) / 4);
    const downInI8 = u32w("downIn", (M * cfg.intermediate) / 4);

    // pooling source map: each soft token p owns the 9 patches of its 3x3 block.
    // derive grid from positions: num_patches_w = number of distinct cols
    let maxCol = -1, maxRow = -1;
    for (let i = 0; i < numPatches; i++) {
      maxCol = Math.max(maxCol, positions[i * 2]);
      maxRow = Math.max(maxRow, positions[i * 2 + 1]);
    }
    const PW = maxCol + 1;              // patches per row (multiple of 3)
    const PH = maxRow + 1;              // patches per column (multiple of 3)
    const a = PH / 3;                   // row blocks
    const b = PW / 3;                   // col blocks
    if (a * b !== numSoftTokens) throw new Error(`pool grid mismatch: ${a}x${b} blocks != ${numSoftTokens} soft tokens`);
    const poolSrc = new Uint32Array(numSoftTokens * 9);
    {
      let o = 0;
      for (let rb = 0; rb < a; rb++) {
        for (let cb = 0; cb < b; cb++) {
          for (let dr = 0; dr < 3; dr++) {
            for (let dc = 0; dc < 3; dc++) {
              const row = 3 * rb + dr, col = 3 * cb + dc;
              poolSrc[o++] = row * PW + col;
            }
          }
        }
      }
    }
    const poolSrcBuf = pad(poolSrc);

    // Run the forward pass in a few bounded command encoders (one per stage /
    // layer) instead of a single giant submit or one per kernel op. This keeps
    // most of the batching speedup (~18 submits vs ~160) without risking a GPU
    // watchdog timeout on integrated GPUs from one huge submit.
    // 1) patch embedder + RoPE tables
    this._batch(() => {
    this._matmulF32("patch", patchBuf, B["model.vision_tower.patch_embedder.input_proj.weight"], hidden, M, cfg.hidden, cfg.hidden);
    // pos embed: gather table[0][col] + table[1][row]
    {
      const wgsl = `struct Params { M: u32 };
@group(0) @binding(0) var<storage, read> Pos: array<i32>;
@group(0) @binding(1) var<storage, read> Table: array<f32>;
@group(0) @binding(2) var<storage, read_write> H: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;
const D: u32 = {{D}}u;
const PS: u32 = {{PS}}u; // position_embedding_size
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let m = gid.x;
  let M = params.M;
  if (m >= M) { return; }
  let col = u32(max(Pos[m * 2], 0));
  let row = u32(max(Pos[m * 2 + 1], 0));
  for (var d = 0u; d < D; d = d + 1u) {
    let xe = Table[col * D + d];
    let ye = Table[PS * D + row * D + d];
    H[m * D + d] = H[m * D + d] + xe + ye;
  }
}`;
      const layout = wgsl.replaceAll("{{D}}", fmt(cfg.hidden)).replaceAll("{{PS}}", fmt(cfg.positionEmbedSize));
      const buffers = [posBuf, { buffer: B["model.vision_tower.patch_embedder.position_embedding_table"] }, hidden, this._uniform(M)];
      this._run("pos_embed", layout, ["ro", "ro", "rw", "uniform"], buffers, M, 1, 1);
    }

    // 2) RoPE tables (positions fixed per image)
    this._run("rope_cs", WGSL.ropeCosSin, ["ro", "ro", "rw", "rw", "uniform"], [posBuf, { buffer: B.__invFreq }, cos, sin, this._uniform(M)], M, 1, 1);
    });

    // 3) transformer layers — one bounded submit per layer
    for (let l = 0; l < cfg.layers; l++) {
      const p = `model.vision_tower.encoder.layers.${l}`;
      const W = (name) => B[name];
      const inScale = (name) => this.sc(name); // sc(name) already looks up w[name] and returns data[0]
      const norm = (name, out, x) => this._rms("l", x, B[name], out, M, cfg.hidden, true);
      // q_norm/k_norm/v_norm are per-head (D=64) over ALL heads: M rows -> M*num_heads rows.
      const headNorm = (name, out, x, dim) => this._rms("l", x, B[name], out, M * cfg.heads, dim, true);

      this._batch(() => {
      // attention
      norm(`${p}.input_layernorm.weight`, normed, hidden);
      // quantize the normed activation to packed int8, then fused q/k/v (dot4I8Packed)
      this._quantizeI8("qkvIn", normed, qkvInI8, (M * cfg.hidden) / 4, inScale(`${p}.self_attn.q_proj.linear.input_activation_scale`));
      this._matmulQkv("qkv", qkvInI8,
        B[`__qkv_w_${l}`], B[`__qkv_s_${l}`],
        q, k, v, M, cfg.hidden, cfg.hidden,
        {
          inQ: inScale(`${p}.self_attn.q_proj.linear.input_activation_scale`), outQ: inScale(`${p}.self_attn.q_proj.linear.output_activation_scale`),
          inK: inScale(`${p}.self_attn.k_proj.linear.input_activation_scale`), outK: inScale(`${p}.self_attn.k_proj.linear.output_activation_scale`),
          inV: inScale(`${p}.self_attn.v_proj.linear.input_activation_scale`), outV: inScale(`${p}.self_attn.v_proj.linear.output_activation_scale`),
        });
      headNorm(`${p}.self_attn.q_norm.weight`, qn, q, cfg.headDim);
      headNorm(`${p}.self_attn.k_norm.weight`, kn, k, cfg.headDim);
      this._rms("v", v, B.__ones64, vn, M * cfg.heads, cfg.headDim, true);
      // ropeApply workgroup_size is 64; dispatch x is the WORKGROUP count (elem_count/64)
      this._run("rope_q", WGSL.ropeApply.replaceAll("{{NH}}", fmt(cfg.heads)).replaceAll("{{HD}}", fmt(cfg.headDim)), ["ro", "ro", "ro", "rw", "uniform"], [qn, cos, sin, q, this._uniform(M)], Math.ceil((M * cfg.heads * cfg.headDim) / 64), 1, 1);
      this._run("rope_k", WGSL.ropeApply.replaceAll("{{NH}}", fmt(cfg.heads)).replaceAll("{{HD}}", fmt(cfg.headDim)), ["ro", "ro", "ro", "rw", "uniform"], [kn, cos, sin, k, this._uniform(M)], Math.ceil((M * cfg.heads * cfg.headDim) / 64), 1, 1);
      // attention (no scale) — V comes from vn (the v_norm output), not raw v
      const attnWgsl = WGSL.attention.replaceAll("{{NH}}", fmt(cfg.heads)).replaceAll("{{HD}}", fmt(cfg.headDim)).replaceAll("{{MMAX}}", fmt(MAX_PATCHES)).replaceAll("{{WG}}", fmt(WG_ATTN));
      this._run("attn", attnWgsl, ["ro", "ro", "ro", "rw", "uniform"], [q, k, vn, attn, this._uniform(M)], M * cfg.heads, 1, 1);
      // quantize the attention output -> o_proj input (packed int8)
      this._quantizeI8("attnIn", attn, attnInI8, (M * cfg.hidden) / 4, inScale(`${p}.self_attn.o_proj.linear.input_activation_scale`));
      this._matmulQat("o", attnInI8, W(`${p}.self_attn.o_proj.linear.weight`), W(`${p}.self_attn.o_proj.linear.weight_scale`), oproj, M, cfg.hidden, cfg.hidden, inScale(`${p}.self_attn.o_proj.linear.input_activation_scale`), inScale(`${p}.self_attn.o_proj.linear.output_activation_scale`));
      norm(`${p}.post_attention_layernorm.weight`, normed, oproj);
      this._addInPlace(hidden, normed, M * cfg.hidden);

      // MLP (sandwich norms) — fused gate/up + gelu_tanh in one dispatch
      norm(`${p}.pre_feedforward_layernorm.weight`, normed, hidden);
      // quantize the normed activation -> gate/up input (packed int8)
      this._quantizeI8("guIn", normed, guInI8, (M * cfg.hidden) / 4, inScale(`${p}.mlp.gate_proj.linear.input_activation_scale`));
      this._matmulGateUp("gateup", guInI8,
        W(`${p}.mlp.gate_proj.linear.weight`), W(`${p}.mlp.up_proj.linear.weight`),
        W(`${p}.mlp.gate_proj.linear.weight_scale`), W(`${p}.mlp.up_proj.linear.weight_scale`),
        gated, M, cfg.intermediate, cfg.hidden,
        {
          inG: inScale(`${p}.mlp.gate_proj.linear.input_activation_scale`), outG: inScale(`${p}.mlp.gate_proj.linear.output_activation_scale`),
          inU: inScale(`${p}.mlp.up_proj.linear.input_activation_scale`), outU: inScale(`${p}.mlp.up_proj.linear.output_activation_scale`),
        });
      // quantize the gated (gelu) output -> down_proj input (packed int8)
      this._quantizeI8("downIn", gated, downInI8, (M * cfg.intermediate) / 4, inScale(`${p}.mlp.down_proj.linear.input_activation_scale`));
      this._matmulQat("down", downInI8, W(`${p}.mlp.down_proj.linear.weight`), W(`${p}.mlp.down_proj.linear.weight_scale`), down, M, cfg.hidden, cfg.intermediate, inScale(`${p}.mlp.down_proj.linear.input_activation_scale`), inScale(`${p}.mlp.down_proj.linear.output_activation_scale`));
      norm(`${p}.post_feedforward_layernorm.weight`, normed, down);
      this._addInPlace(hidden, normed, M * cfg.hidden);
      });
    }

    // 4) pooling -> soft tokens, then embed_vision (RMSNorm(no-scale) -> projection)
    this._batch(() => {
    // pool workgroup_size is 256; dispatch x = workgroup count
    this._run("pool", WGSL.pool.replaceAll("{{D}}", fmt(cfg.hidden)).replaceAll("{{PS}}", "9").replaceAll("{{SCALE}}", fmt(Math.sqrt(cfg.hidden))), ["ro", "ro", "rw", "uniform"], [hidden, poolSrcBuf, pooled, this._uniform(M)], Math.ceil((numSoftTokens * cfg.hidden) / 256), 1, 1);
    this._rms("preproj", pooled, B.__ones768, normedP, numSoftTokens, cfg.hidden, true);
    this._matmulF32("proj", normedP, B["model.embed_vision.embedding_projection.weight"], feats, numSoftTokens, cfg.textHidden, cfg.hidden);
    });

    // 5) read back
    const imageFeatures = await this._read(feats.buffer, numSoftTokens * cfg.textHidden * 4);

    // cleanup scratch buffers
    for (const b of this._tmp) b.destroy();
    this._tmp = [];
    // also destroy input pads
    patchBuf.buffer.destroy(); posBuf.buffer.destroy(); poolSrcBuf.buffer.destroy();

    return { image_features: imageFeatures, num_soft_tokens: numSoftTokens, num_patches: numPatches };
  }

  _addInPlace(a, b, count) {
    // In-place add kernel: a = a + b (count elements)
    const wgsl = `struct Params { Count: u32 };
@group(0) @binding(0) var<storage, read_write> A: array<f32>;
@group(0) @binding(1) var<storage, read> B: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.Count) { return; }
  A[i] = A[i] + B[i];
}`;
    this._run("addInPlace", wgsl, ["rw", "ro", "uniform"], [a, b, this._uniform(count)], Math.ceil(count / 256), 1, 1);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    // release cached uniform buffers
    if (this._uniformCache) {
      for (const b of this._uniformCache.values()) { try { b.destroy(); } catch (_) {} }
      this._uniformCache.clear();
    }
    // Only destroy a device we created ourselves. A shared device (opts.host)
    // is owned by the text kernel runtime and must outlive this vision tower.
    if (!this.sharedDevice) {
      try { this.device.destroy(); } catch (_) { /* ignore */ }
    }
  }
}
