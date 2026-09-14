// Service worker for the Gemma 4 Workstation.
//
// Goal: after the first load, the app shell + CDN libraries work fully offline.
//
// IMPORTANT: the ~2.4 GB model weights are streamed with HTTP Range requests
// and cached by the engine itself (IndexedDB + Cache Storage). The fetch handler
// below deliberately NEVER intercepts:
//   • requests carrying a Range header,
//   • the safetensors weight files (any host),
//   • cross-origin hosts other than the pinned CDNs.
// Interfering with those would break weight streaming and resumable downloads.

const VERSION = "ws-v3";
const SHELL_CACHE = `${VERSION}-shell`;
const LIB_CACHE = `${VERSION}-libs`;
const PYPI_CACHE = `${VERSION}-pypi`;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./landing.js",
  "./manifest.webmanifest",
  "./icon.svg",
];

const CDN_ORIGINS = [
  "https://esm.sh:",
  "https://cdn.jsdelivr.net:",
  "https://cdnjs.cloudflare.com:",
  "https://fonts.googleapis.com:",
  "https://fonts.gstatic.com:",
  // PyPI wheels fetched by micropip. Wheel URLs are immutable and versioned, so
  // caching them keeps installed Python packages usable offline afterwards.
  "https://files.pythonhosted.org:",
  "https://pypi.org:",
];

// Vendored pure-Python wheels shipped with the app (see tools/vendor-python-packages.mjs).
const VENDOR_PREFIX = "/vendor/python-packages/";
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL_ASSETS);
    // Offline Python bundle manifest — optional, so failure must not break install.
    try {
      await cache.add(new Request("./vendor/python-packages/manifest.json", { cache: "no-cache" }));
    } catch { /* bundle not vendored — packages fall back to PyPI */ }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isCdn(url) {
  return CDN_ORIGINS.some((o) => url.startsWith(o));
}

function isWeights(url) {
  return url.includes("safetensors") || url.includes("huggingface.co") || url.includes("hf.co");
}

// A wheel that is safe to cache indefinitely: either vendored with the app or
// downloaded from PyPI by micropip (wheel files are immutable and versioned).
function isCacheableWheel(url) {
  if (!/\.whl(\?|#|$)/i.test(url)) return false;
  return url.includes(VENDOR_PREFIX) || url.includes("pythonhosted.org") || url.includes("pypi.org");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Never touch range requests or model weights — the engine handles those.
  if (req.headers.has("range")) return;
  const url = req.url;
  if (isWeights(url)) return;

  // Wheels are immutable and are the whole point of the offline bundle, so serve
  // them cache-first. (manifest.json deliberately does NOT belong here — it is a
  // mutable index and must be re-fetched, or a re-vendor would never show up.)
  if (isCacheableWheel(url)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok) {
          const c = await caches.open(PYPI_CACHE);
          c.put(req, res.clone());
        }
        return res;
      } catch {
        return new Response("", { status: 504 });
      }
    })());
    return;
  }

  // CDN libraries: cache-first (immutable in practice, versioned URLs).
  if (isCdn(url)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok) {
          const c = await caches.open(LIB_CACHE);
          c.put(req, res.clone());
        }
        return res;
      } catch {
        return new Response("", { status: 504 });
      }
    })());
    return;
  }

  // Same-origin: network-first with cache fallback; navigations fall back to the shell.
  if (new URL(url).origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && (req.mode === "navigate" || url.includes("."))) {
          const c = await caches.open(SHELL_CACHE);
          c.put(req, res.clone());
        }
        return res;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === "navigate") {
          const shell = await caches.match("./index.html");
          if (shell) return shell;
        }
        return new Response("", { status: 504 });
      }
    })());
  }
});
