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
//   node tools/serve.mjs [port] [root]
//   # defaults: port 4173, root = repo root
//
// Also fine for plain static hosting (HTML/JS/CSS/images) — it serves
// `index.html` for directories and correct MIME types.

import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(process.argv[3] || process.cwd());
const PORT = Number(process.argv[2] || process.env.PORT || 4173);

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
      createReadStream(file, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType(file),
      "Content-Length": st.size,
      "Accept-Ranges": "bytes",
    });
    createReadStream(file).pipe(res);
  } catch (err) {
    res.writeHead(500);
    res.end(String((err && err.message) || err));
  }
});

server.listen(PORT, () => {
  console.log(`serving ${ROOT}`);
  console.log(`  http://127.0.0.1:${PORT}  (Range: enabled)`);
});
