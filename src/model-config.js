// src/model-config.js — release build configuration for the Gemma 4 E2B WebGPU app.
//
// The app streams model weights over HTTP Range requests, then caches them in
// IndexedDB after the first load. This config controls WHERE those weights come
// from:
//
//   Default (no URL params):
//     Weights are fetched at runtime from the Hugging Face Hub:
//       https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers
//     HF serves public model files with CORS enabled and supports byte-range
//     requests, so this works from any static host — including GitHub Pages.
//     ~2.4 GB is downloaded on first load (cached afterwards).
//
//   ?localweights=1
//     Use a LOCAL copy of the weights instead. This is for fully offline use:
//     place `model.safetensors` (+ the small config/tokenizer files) under
//     ./models/google/gemma-4-E2B-it-qat-mobile-transformers/ and open the page
//     with ?localweights=1. Serve the folder with `node tools/serve.mjs` so
//     Range requests are honored.
//
//   Portable build (one HTML + an assets folder, opened from disk):
//     The weights come from the picked assets folder instead, resolved through the
//     virtual asset origin. There is no network to fall back to, so local weights
//     are used unconditionally and `?localweights=1` is unnecessary.

import { isPortable, rootUrl, weightsSource, WEIGHTS_HF } from "./lib/portable.js";

const HF_BASE =
  "https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers/resolve/main/";

const MODEL_SUBDIR = "models/google/gemma-4-E2B-it-qat-mobile-transformers/";

// Local weights resolve relative to this module (./src) up to the repo root.
const REPO_LOCAL_BASE = new URL(`../${MODEL_SUBDIR}`, import.meta.url).href;

const hasLocalWeightsParam = () =>
  typeof globalThis.location !== "undefined" &&
  new URLSearchParams(globalThis.location.search).has("localweights");

/**
 * Where the weights come from, re-resolved on every access.
 *
 * This has to be dynamic rather than a module-scope constant: the portable build asks
 * the user *after* the modules have evaluated whether to read `model.safetensors` from
 * a folder they picked (fully offline) or to stream it from the Hugging Face Hub. A
 * constant would freeze the answer to the pre-decision default.
 */
export function weightsBaseUrl() {
  if (isPortable() && weightsSource() === WEIGHTS_HF) return HF_BASE;
  if (isPortable() || hasLocalWeightsParam()) {
    return rootUrl(MODEL_SUBDIR) ?? REPO_LOCAL_BASE;
  }
  return HF_BASE;
}

/** True when the weights are read from disk rather than fetched from the Hub. */
export function weightsAreLocal() {
  return weightsBaseUrl() !== HF_BASE;
}

export const MODEL_CONFIG = Object.freeze({
  mobileGemma: Object.freeze({
    id: "google/gemma-4-E2B-it-qat-mobile-transformers",
    // A getter, so callers see the current choice instead of the value at import time.
    get path() { return weightsBaseUrl(); },
  }),
});
