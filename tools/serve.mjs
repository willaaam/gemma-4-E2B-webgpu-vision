// tools/serve.mjs — minimal static file server with HTTP Range support (206).
//
// Why this exists:
//   The Gemma 4 kernel (`gemma-4-e2b.js`) and the vision loader
//   (`gemma4-vision.js`) stream model weights with HTTP Range requests
//   (`Range: bytes=a-b`). Python's `python3 -m http.server` IGNORES Range and
//   returns the WHOLE file (e.g. 2.4 GB for model.safetensors), which makes the
//   browser fail with `RangeError: Array buffer allocation failed`.
//
// Usage (from the repo root):
//   node tools/serve.mjs [port] [root] [--throttle-mbps N] [--no-throttle]
//   # defaults: port 4173, root = repo root
//   # Throttling defaults to ~1 Gbit/s (see THROTTLE_MBPS below) to avoid the
//   # localhost stall at ~91% (1.79/1.97 GB) when Chrome's fetch+IDB pipeline
//   # is saturated by unbounded loopback bandwidth. See "Local testing: 1 Gbit
//   # throttle" section below.
//
// Also fine for plain static hosting (HTML/JS/CSS/images) — it serves
// `index.html` for directories and correct MIME types.
//
// Local testing: 1 Gbit throttle
//   At loopback the kernel fetches 4×128 MiB Range requests concurrently
//   (gemma-4-e2b.js: md=128<<20, hd=4). Unthrottled that bursts >>1 Gbit, filling
//   kernel SNDBUF faster than the browser's `ReadableStream`+IndexedDB write
//   pipeline (streamAll → writeTensor per chunk) can drain. Backpressure stalls
//   the last 1–2 chunks and progress freezes at ~91% (e.g. "Loading cached
//   weights: 1.79 GB / 1.97 GB"). Capping each response stream to ~1 Gbit
//   (shared global bucket, default) spaces IDB commits and prevents the stall.
//   Disable with `--no-throttle` or `THROTTLE_MBPS=0`; override with
//   `THROTTLE_MBPS=500` or `--throttle-mbps 500`.

import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, resolve } from "node:path";
import { Transform } from "node:stream";

const rawArgs = process.argv.slice(2);
const flagNoThrottle = rawArgs.includes("--no-throttle");
const flagThrottleIdx = rawArgs.findIndex((a) => a === "--throttle-mbps" || a === "--throttle");
const flagThrottleVal =
  flagThrottleIdx !== -1 ? Number(rawArgs[flagThrottleIdx + 1]) : undefined;
const positional = rawArgs.filter((a) => !a.startsWith("-") && a !== String(flagThrottleVal));

const ROOT = resolve(positional[1] || process.cwd());
const PORT = Number(positional[0] || process.env.PORT || 4173);

// Global throttle: 1 Gbit/s (≈125 MB/s) shared across all responses. 0 = disabled.
const THROTTLE_MBPS = flagNoThrottle
  ? 0
  : Number.isFinite(flagThrottleVal)
    ? flagThrottleVal
    : Number(process.env.THROTTLE_MBPS ?? 1000);
const THROTTLE_BPS = THROTTLE_MBPS > 0 ? (THROTTLE_MBPS * 1e6) / 8 : 0;

// Token-bucket shared across all throttle streams (global 1 Gbit, not per-connection).
let bucketTokens = THROTTLE_BPS; // start full
let bucketLast = performance.now();

class Throttle extends Transform {
  _transform(chunk, _enc, cb) {
    if (!THROTTLE_BPS) return cb(null, chunk);
    const now = performance.now();
    const elapsed = (now - bucketLast) / 1000;
    bucketLast = now;
    bucketTokens = Math.min(THROTTLE_BPS, bucketTokens + elapsed * THROTTLE_BPS);
    if (chunk.length <= bucketTokens) {
      bucketTokens -= chunk.length;
      cb(null, chunk);
    } else {
      const needed = chunk.length - bucketTokens;
      const delayMs = (needed / THROTTLE_BPS) * 1000;
      bucketTokens = 0;
      setTimeout(() => cb(null, chunk), delayMs);
    }
  }
}

function throttledPipe(readable, res) {
  const throttle = THROTTLE_BPS ? new Throttle() : null;
  const onClose = () => {
    try { readable.destroy(); } catch {}
    try { throttle?.destroy(); } catch {}
  };
  res.on("close", onClose);
  readable.on("error", (err) => {
    res.removeListener("close", onClose);
    if (!res.headersSent) res.writeHead(500);
    try { res.end(String(err?.message ?? err)); } catch {}
  });
  if (throttle) readable.pipe(throttle).pipe(res);
  else readable.pipe(res);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".safetensors": "application/octet-stream",
  ".onnx": "application/octet-stream",
  ".onnx_data": "application/octet-stream",
  ".gguf": "application/octet-stream",
  ".bin": "application/octet-stream",
};

function contentType(p) {
  return MIME[extname(p).toLowerCase()] || "application/octet-stream";
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let path = decodeURIComponent(url.pathname);
    // resolve within ROOT (no path traversal)
    let file = resolve(join(ROOT, path));
    if (file !== ROOT && !file.startsWith(ROOT + "/")) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    let st;
    try {
      st = await stat(file);
    } catch {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    if (st.isDirectory()) {
      file = join(file, "index.html");
      try {
        st = await stat(file);
      } catch {
        res.writeHead(404);
        res.end("not found");
        return;
      }
    }

    // HEAD must not send a body (engine probes size/Accept-Ranges via HEAD).
    const isHead = req.method === "HEAD";
    if (isHead) {
      res.writeHead(200, {
        "Content-Type": contentType(file),
        "Content-Length": st.size,
        "Accept-Ranges": "bytes",
      });
      res.end();
      return;
    }

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] !== "" ? parseInt(m[1], 10) : null;
      let end = m && m[2] !== "" ? parseInt(m[2], 10) : null;
      if (start === null) {
        // suffix range: "bytes=-N" -> last N bytes
        const n = end === null ? 0 : end;
        start = Math.max(st.size - n, 0);
        end = st.size - 1;
      } else {
        if (end === null || end >= st.size) end = st.size - 1;
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
        res.end();
        return;
      }
      const length = end - start + 1;
      res.writeHead(206, {
        "Content-Type": contentType(file),
        "Content-Length": length,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${st.size}`,
        "Cache-Control": "no-cache",
      });
      throttledPipe(createReadStream(file, { start, end, highWaterMark: 1 << 20 }), res);
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType(file),
      "Content-Length": st.size,
      "Accept-Ranges": "bytes",
    });
    throttledPipe(createReadStream(file, { highWaterMark: 1 << 20 }), res);
  } catch (err) {
    res.writeHead(500);
    res.end(String((err && err.message) || err));
  }
});

server.listen(PORT, () => {
  console.log(`serving ${ROOT}`);
  console.log(`  http://127.0.0.1:${PORT}  (Range: enabled)`);
  if (THROTTLE_BPS) console.log(`  throttle: ${THROTTLE_MBPS} Mbit/s (~${(THROTTLE_BPS / (1024 * 1024)).toFixed(0)} MB/s global) — use --no-throttle or THROTTLE_MBPS=0 to disable`);
  else console.log(`  throttle: disabled`);
});
