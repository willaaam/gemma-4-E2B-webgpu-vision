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

const VERSION = "ws-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const LIB_CACHE = `${VERSION}-libs`;

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
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
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

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Never touch range requests or model weights — the engine handles those.
  if (req.headers.has("range")) return;
  const url = req.url;
  if (isWeights(url)) return;

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
