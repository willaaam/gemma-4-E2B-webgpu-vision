// Central model service: loads the text+vision model ONCE and shares it with every app.
// Extracted from the original index.html inline script; UI (status pill, progress bar)
// subscribes via listeners instead of direct DOM writes.

import { Gemma4Mobile } from "./gemma-engine.js";
import { gemma4SgGuard } from "../../gemma4-sg-guard.js";
import { Gemma4Vision } from "../../gemma4-vision.js";
import { VisionGemma4Mobile, installVisionHook } from "../../gemma4-vision-inject.js";
import { MODEL_CONFIG } from "../model-config.js";

const LOCAL_MODEL_URL = MODEL_CONFIG.mobileGemma.path;
const VISION_WEIGHTS_URL = new URL("model.safetensors", MODEL_CONFIG.mobileGemma.path).href;

const MAX_LOAD_ATTEMPTS = 2;

const state = {
  model: null,          // VisionGemma4Mobile once fully loaded
  thoughtTokenIds: null, // { soc, eoc } special-token ids for the thought block
  capabilities: null,   // architectural/effective context and device limits
  status: "idle",        // idle | loading | ready | busy | error
  statusText: "Not loaded",
  progress: 0,           // monotonic load fraction [0,1]
  loading: false,
  error: null,
};

const listeners = new Set();

function emit() { for (const fn of listeners) fn({ ...state }); }

export const modelService = {
  get state() { return state; },
  get model() { return state.model; },
  get thoughtTokenIds() { return state.thoughtTokenIds; },
  get capabilities() { return state.capabilities; },
  get ready() { return !!state.model && !state.loading; },

  refreshCapabilities() {
    if (!state.model?.getContextCapabilities) return state.capabilities;
    state.capabilities = state.model.getContextCapabilities();
    emit();
    return state.capabilities;
  },

  subscribe(fn) {
    listeners.add(fn);
    fn({ ...state });
    return () => listeners.delete(fn);
  },

  setStatus(status, text) {
    state.status = status;
    if (text !== undefined) state.statusText = text;
    emit();
  },

  setBusy(busy) {
    if (!state.model) return;
    state.status = busy ? "busy" : "ready";
    state.statusText = busy ? "Generating…" : "Ready · on-device";
    emit();
  },

  setProgress(fraction) {
    // monotonic — never hops backwards
    state.progress = Math.max(Math.min(Number(fraction) || 0, 1), state.progress);
    emit();
  },

  async load() {
    if (state.model || state.loading) return state.model;
    let attempts = 0;
    try {
      return await performLoad();
    } catch (error) {
      attempts++;
      if (attempts < MAX_LOAD_ATTEMPTS) {
        state.setStatus("loading", "Clearing model cache and retrying…");
        await clearKernelCache();
        return performLoad();
      }
      throw error;
    }
  },
};

async function performLoad() {
  state.loading = true;
  state.error = null;
  state.progress = 0;
  modelService.setProgress(0.02);
  modelService.setStatus("loading", "Requesting WebGPU device…");
  const started = performance.now();
  let model = null;
  try {
    // NVIDIA/D3D12: bare subgroupAdd after divergent stores corrupts QatMatMul.
    // force:true — Windows may report exact 32/32 and otherwise skip the patcher.
    const guard = await gemma4SgGuard({ force: true });
    console.info("[gemma4-sg-guard]", guard.mode, guard.adapter, guard.selfTest);
    model = await Gemma4Mobile.load(LOCAL_MODEL_URL, { ...guard.loadOpts, onProgress: updateLoadProgress });
    modelService.setStatus("loading", "Warming up kernels…");
    await model.warmup();

    // Vision: load the Gemma 4 vision tower (WGSL kernels, w8a8o8 QAT weights)
    // and wrap the model so generate() accepts image content. The vision
    // tower reuses the text kernel's WebGPU device (`model.runtime.host`) so
    // we don't request a second one — lighter on integrated GPUs.
    modelService.setStatus("loading", "Loading vision tower…");
    installVisionHook();
    const vision = await Gemma4Vision.load(VISION_WEIGHTS_URL, { host: model.runtime?.host, onProgress: updateVisionProgress });
    model = new VisionGemma4Mobile(model, vision);
    window.__gemmaVision = vision;

    state.model = model;
    state.thoughtTokenIds = model.getSpecialTokenIds?.() ?? null;
    state.capabilities = model.getContextCapabilities?.() ?? null;
    state.loading = false;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    modelService.setProgress(1);
    modelService.setStatus("ready", `Ready in <strong>${seconds}s</strong> · on-device`);
    return model;
  } catch (error) {
    console.error(error);
    try { model?.dispose?.(); } catch (_) {}
    state.model = null;
    state.capabilities = null;
    state.loading = false;
    state.error = error;
    modelService.setStatus("error", `Failed to load: ${escapeHtmlLocal(String(error?.message ?? error))}`);
    throw error;
  }
}

function labelFor(status) {
  return {
    init: "Requesting WebGPU device…",
    tokenizer: "Loading tokenizer…",
    weights: "Downloading weights…",
    ready: "Ready.",
  }[status] ?? status;
}

function updateLoadProgress(event) {
  if (event.status !== "weights") {
    modelService.setStatus("loading", labelFor(event.status));
    setPhaseProgress(event.status, event.fraction);
    return;
  }
  const kind = event.kind ?? inferProgressKind(event);
  const fraction = finiteNumber(event.fraction) ? clamp(event.fraction, 0, 1) : null;
  // Drive the bar off the BYTE download only. The "tensors" stream counts materialized tensors,
  // which races far ahead of the download (the many small tensors finish while the big embedding
  // weights are still downloading by size), so it would leap the bar past the real progress.
  if (kind !== "tensors") setPhaseProgress("weights", fraction);
  modelService.setStatus("loading", formatWeightProgress(event, fraction));
}

// Map each load phase onto an increasing slice of the bar (weights — the byte download — owns the bulk).
function setPhaseProgress(status, frac) {
  const [lo, hi] = status === "weights"
    ? [0.04, 1.0]
    : ({ init: [0, 0.02], tokenizer: [0.02, 0.04], ready: [1, 1] }[status] ?? [0, 1]);
  const f = finiteNumber(frac) ? clamp(frac, 0, 1) : 0;
  modelService.setProgress(lo + (hi - lo) * f);
}

function formatWeightProgress(event, fraction) {
  const kind = event.kind ?? inferProgressKind(event);
  const pct = fraction === null ? "" : ` (${Math.round(fraction * 100)}%)`;
  const loaded = finiteNumber(event.loaded) ? event.loaded : null;
  const total = finiteNumber(event.total) ? event.total : null;
  if (kind === "bytes") {
    const verb = event.fromCache ? "Loading cached weights" : "Downloading weights";
    if (loaded !== null && total !== null) return `${verb}: ${formatBytes(loaded)} / ${formatBytes(total)}${pct}`;
    if (total !== null) return `${verb}: ${formatBytes(total)} total`;
    return `${escapeHtmlLocal(event.message || verb)}…`;
  }
  if (loaded !== null && total !== null) {
    const label = event.message ? ` (${escapeHtmlLocal(event.message)})` : "";
    return `Preparing GPU weights: ${formatInteger(loaded)} / ${formatInteger(total)} tensors${pct}${label}`;
  }
  return event.message ? `Preparing GPU weights: ${escapeHtmlLocal(event.message)}` : "Preparing GPU weights…";
}

function inferProgressKind(event) {
  if (event.kind === "bytes" || event.kind === "tensors") return event.kind;
  if (finiteNumber(event.total) && event.total > 1_000_000) return "bytes";
  return "tensors";
}

function updateVisionProgress(event) {
  if (event.status === "init") return;
  const pct = event.status === "weights" && finiteNumber(event.fraction) ? ` (${Math.round(event.fraction * 100)}%)` : "";
  modelService.setStatus("loading", `Loading vision tower${event.message ? ` · ${event.message}` : ""}${pct}`);
}

// Clear model caches so a corrupted cache (from an interrupted download — Chrome throws
// `NotReadableError` when a cached Blob's backing file is gone) doesn't break future loads.
// Covers the kernel's "safetensors-cache-v1" (chunks/meta stores), the vision loader's
// "gemma4-vision-cache-v1" (weights store), and CacheStorage (tokenizer/config).
export async function clearKernelCache() {
  try {
    const dbs = (await (indexedDB.databases?.().catch(() => []))) ?? [];
    await Promise.all(dbs.map((d) => d.name ? new Promise((resolve) => {
      try {
        const req = indexedDB.open(d.name);
        req.onsuccess = () => {
          const db = req.result;
          try {
            const stores = Array.from(db.objectStoreNames);
            if (stores.length === 0) { db.close(); resolve(); return; }
            const t = db.transaction(stores, "readwrite");
            stores.forEach((s) => t.objectStore(s).clear());
            t.oncomplete = t.onerror = t.onabort = () => { db.close(); resolve(); };
          } catch (_) { db.close(); resolve(); }
        };
        req.onerror = req.onblocked = () => resolve();
      } catch (_) { resolve(); }
    }) : Promise.resolve()));
  } catch (_) {}
  try {
    for (const name of ["safetensors-cache-v1", "gemma4-vision-cache-v1"]) {
      await new Promise((resolve) => {
        try {
          const req = indexedDB.open(name);
          req.onsuccess = () => {
            const db = req.result;
            try {
              const stores = Array.from(db.objectStoreNames);
              if (stores.length === 0) { db.close(); resolve(); return; }
              const t = db.transaction(stores, "readwrite");
              stores.forEach((s) => t.objectStore(s).clear());
              t.oncomplete = t.onerror = t.onabort = () => { db.close(); resolve(); };
            } catch (_) { db.close(); resolve(); }
          };
          req.onerror = req.onblocked = () => resolve();
        } catch (_) { resolve(); }
      });
    }
  } catch (_) {}
  try {
    const keys = await caches.keys().catch(() => []);
    await Promise.all(keys.map((k) => caches.delete(k).catch(() => {})));
  } catch (_) {}
}

// ---- small local helpers (kept private to avoid a util module dependency cycle) ----
function finiteNumber(v) { return typeof v === "number" && Number.isFinite(v); }
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function formatInteger(v) { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v); }
function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"]; let v = bytes, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  const digits = u === 3 ? 2 : (v >= 10 || u === 0 ? 0 : 1);
  return `${v.toFixed(digits)} ${units[u]}`;
}
function escapeHtmlLocal(v) {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
