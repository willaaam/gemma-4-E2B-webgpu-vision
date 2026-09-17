// src/lib/portable.js — portable-mode runtime state.
//
// The portable build is ONE html file plus a folder of assets the user points the
// app at once. In that mode three things differ from the normal served build:
//
//   1. Every repo-root-relative asset is served from the virtual asset origin
//      (see asset-store.js / asset-fetch.js) instead of a real URL.
//   2. The text engine (`gemma-4-e2b.js`) cannot be fetched as a file, so its
//      source is inlined into the HTML and injected here.
//   3. Local weights / vendored packages are used unconditionally — there is no
//      `?localweights=1` to opt into, because there is no network to fall back to.
//
// The bootstrap in the portable HTML assigns `globalThis.__PORTABLE__` BEFORE any
// module is evaluated, so reading it at module scope is safe and order-independent.
// Served builds leave the global undefined and every helper here returns null,
// which makes each call site fall back to plain `import.meta.url` behaviour.

const GLOBAL_KEY = "__PORTABLE__";

/** The portable configuration object, or null in a normal served build. */
export function portableConfig() {
  return globalThis[GLOBAL_KEY] ?? null;
}

/** True when running from the single-file portable build. */
export function isPortable() {
  return !!portableConfig();
}

/** The asset origin (always ends with "/"), or null. */
export function assetBase() {
  const base = portableConfig()?.assetBase;
  return typeof base === "string" && base ? base : null;
}

/**
 * Resolve a repo-root-relative path (e.g. "vendor/python-packages/manifest.json")
 * to a URL in the current mode.
 *
 * Returns null for served builds so callers can use `??` to fall back to their
 * original `import.meta.url` computation.
 */
export function rootUrl(relPath) {
  const base = assetBase();
  if (!base) return null;
  return new URL(String(relPath).replace(/^\/+/, ""), base).href;
}

/** Same as `rootUrl`, but throws a clear error when not in portable mode. */
export function requireRootUrl(relPath) {
  const url = rootUrl(relPath);
  if (!url) throw new Error(`rootUrl(${relPath}) requires portable mode`);
  return url;
}

// --- weight source -----------------------------------------------------------
//
// The portable build asks the user where the weights should come from *after* the
// modules have loaded, so the choice has to be readable at load time rather than
// baked in at module scope:
//
//   WEIGHTS_LOCAL — read model.safetensors from the picked assets folder. Fully
//                   offline. This is the default, and the only option when there is
//                   no network.
//   WEIGHTS_HF    — stream from the Hugging Face Hub like a served build does. Lets a
//                   small download (no 2.4 GB of weights) still run the whole app.

export const WEIGHTS_LOCAL = "local";
export const WEIGHTS_HF = "hf";

/** Where the weights come from this session. Defaults to local (i.e. offline). */
export function weightsSource() {
  return portableConfig()?.weightsSource === WEIGHTS_HF ? WEIGHTS_HF : WEIGHTS_LOCAL;
}

/** Record the user's choice. No-op outside the portable build. */
export function setWeightsSource(mode) {
  const cfg = portableConfig();
  if (!cfg) return;
  cfg.weightsSource = mode === WEIGHTS_HF ? WEIGHTS_HF : WEIGHTS_LOCAL;
}

// --- inlined engine source ---------------------------------------------------

let inlineEngineSource = null;

/** Register the text engine's source (called by the portable bootstrap). */
export function setEngineSource(source) {
  inlineEngineSource = typeof source === "string" && source ? source : null;
}

/**
 * The inlined engine source, or null when it must be fetched as a module URL.
 *
 * The portable HTML embeds it in its config block, which a classic script assigns
 * to `globalThis.__PORTABLE__` before any module is evaluated — so this is
 * available at module scope, which is where `gemma-engine.js` needs it.
 */
export function getEngineSource() {
  return inlineEngineSource ?? portableConfig()?.engineSource ?? null;
}
