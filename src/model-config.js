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

const HF_BASE =
  "https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers/resolve/main/";

// Local weights resolve relative to this module (./src) up to the repo root.
const LOCAL_BASE = new URL(
  "../models/google/gemma-4-E2B-it-qat-mobile-transformers/",
  import.meta.url
).href;

const useLocalWeights =
  typeof globalThis.location !== "undefined" &&
  new URLSearchParams(globalThis.location.search).has("localweights");

export const MODEL_CONFIG = Object.freeze({
  mobileGemma: Object.freeze({
    id: "google/gemma-4-E2B-it-qat-mobile-transformers",
    path: useLocalWeights ? LOCAL_BASE : HF_BASE,
  }),
});
