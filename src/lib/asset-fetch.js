// src/lib/asset-fetch.js — a `fetch` that answers from user-picked local files.
//
// THE PROBLEM IT SOLVES
// The engine streams `model.safetensors` (≈2.4 GB) with HTTP `Range` requests, and
// Pyodide/micropip fetch their own runtime files. On a double-clicked `file://` page
// none of that can work: `fetch()` of a sibling file is blocked by CORS, there is no
// HTTP Range support, and there is no server to add it to.
//
// THE WORKAROUND
// A user-picked `File` is randomly accessible through `Blob.slice(a, b)`. So we
// present every picked file under a reserved virtual origin and answer `fetch()`
// calls — including `Range` — straight out of the `Blob`. Every consumer keeps using
// ordinary `https://` URLs, so the model loaders, Pyodide, micropip and pdf.js need
// no special-casing beyond being handed this function.
//
// Nothing here touches the network. Virtual-origin URLs never fall back: a missing
// entry is a hard error, because silently hitting the network would defeat the point.

import { VIRTUAL_ORIGIN, isVirtualUrl } from "./asset-store.js";

/** Parse a single-range `Range` header. Returns null when absent/unsupported. */
function parseRange(header, size) {
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(String(header ?? ""));
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;

  let start;
  let end; // inclusive
  if (rawStart === "") {
    // Suffix range: last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || start < 0 || start > end || start >= size) return null;
  return { start, end };
}

function readHeader(init, name) {
  const headers = init?.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

/** Build a Response, tolerating headers the platform refuses to let us set. */
function respond(body, status, headers) {
  const res = new Response(body, { status });
  for (const [key, value] of Object.entries(headers)) {
    try { res.headers.set(key, value); } catch { /* forbidden header — non-fatal */ }
  }
  return res;
}

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Wrap an `AssetStore` as a fetch-compatible function.
 *
 * @param {import("./asset-store.js").AssetStore} store
 * @param {{fallback?: typeof fetch, strict?: boolean}} [opts]
 *   `fallback` answers URLs the store does not hold (defaults to the real fetch).
 *   `strict` (default true) makes virtual-origin misses throw instead of falling back.
 */
export function createLocalFetch(store, { fallback, strict = true } = {}) {
  const fallbackFetch = fallback ?? globalThis.fetch?.bind(globalThis);

  return async function localFetch(input, init = {}) {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : String(input?.url ?? input);

    const virtual = isVirtualUrl(url);
    const file = store.resolve(url);

    if (!file) {
      if (virtual && strict) {
        throw new Error(
          `Portable asset not available: ${url}\n` +
          `Point the app at the assets folder that contains this file. ` +
          `Known assets: ${store.size}`
        );
      }
      if (typeof fallbackFetch !== "function") {
        throw new Error(`No fetch implementation available for ${url}`);
      }
      return fallbackFetch(input, init);
    }

    if (init.signal?.aborted) throw abortError();

    const type = file.type || "application/octet-stream";
    const size = file.size ?? 0;
    const method = String(init.method ?? "GET").toUpperCase();

    // HEAD: the engine's size/range probe. The model loaders pass `knownSize` and
    // `knownAcceptsRanges`, so this is normally skipped, but Pyodide probing and
    // future callers still expect it to be correct.
    if (method === "HEAD") {
      return respond(null, 200, {
        "Content-Type": type,
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
      });
    }

    const range = parseRange(readHeader(init, "Range"), size);

    if (range) {
      const { start, end } = range;
      const slice = file.slice(start, end + 1);
      return respond(slice, 206, {
        "Content-Type": type,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
      });
    }

    // Full read. Streamed from the Blob, so a consumer that only walks the body
    // never materialises the whole file.
    return respond(file, 200, {
      "Content-Type": type,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
    });
  };
}

// --- global installation -----------------------------------------------------

let installed = null;

/**
 * Install a store-backed fetch as `globalThis.fetch`.
 *
 * This is what makes Pyodide work with no server: its `python_stdlib.zip`,
 * `pyodide.asm.wasm`, `pyodide-lock.json` and every micropip wheel are fetched
 * through `globalThis.fetch`, so intercepting it serves them all from disk.
 * Non-virtual URLs the store cannot resolve still reach the real network.
 */
export function installLocalFetch(store) {
  if (installed) uninstallLocalFetch();
  const original = globalThis.fetch?.bind(globalThis);
  const local = createLocalFetch(store, { fallback: original });
  installed = { original, local };
  globalThis.fetch = local;
  return local;
}

export function uninstallLocalFetch() {
  if (!installed) return;
  globalThis.fetch = installed.original;
  installed = null;
}

export function isLocalFetchInstalled() {
  return !!installed;
}

/**
 * A `blob:` URL for a stored asset. Needed where a *real* URL is structurally
 * required and `fetch` interception cannot help — notably dynamic `import()`
 * (Pyodide's `pyodide.asm.js`) and `new Worker(...)`.
 */
export function blobUrlFor(store, ref, { type = "text/javascript" } = {}) {
  const file = store.resolve(ref);
  if (!file) return null;
  // Always re-wrap so the MIME type is what the consumer requires: a folder pick
  // often yields an empty `type`, and a module import with the wrong MIME fails.
  return URL.createObjectURL(new Blob([file], { type }));
}

/** Convenience: is this reference resolvable from the store right now? */
export function hasAsset(store, ref) {
  return store.has(ref);
}

export { VIRTUAL_ORIGIN };
