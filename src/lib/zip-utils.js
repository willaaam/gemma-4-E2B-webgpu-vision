// Zip import/export via fflate (https://github.com/101arrowz/fflate)
// Loaded lazily from CDN — no build step required.

let fflatePromise = null;

async function getFflate() {
  if (fflatePromise) return fflatePromise;
  fflatePromise = import("https://esm.sh/fflate@0.8.2").catch((e) => {
    fflatePromise = null;
    throw e;
  });
  return fflatePromise;
}

// Unzip a File/Blob/ArrayBuffer/Uint8Array into { path: content } for text files.
// Binary assets are skipped (or stored as data-URL if needed — currently skipped).
export async function unzipToFiles(source) {
  const ff = await getFflate();
  const buf = await toUint8Array(source);
  const unzipped = await new Promise((resolve, reject) => {
    ff.unzip(buf, (err, data) => err ? reject(err) : resolve(data));
  });
  // unzipped: { "a/b.txt": Uint8Array, ... }
  const out = {};
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (const [rawPath, data] of Object.entries(unzipped)) {
    let p = rawPath.replace(/\\/g, "/").replace(/^\//, "").replace(/\/{2,}/g, "/").trim();
    if (!p || p.endsWith("/")) continue; // folder entry
    // Skip macOS junk & hidden
    if (p.startsWith("__MACOSX/") || p.split("/").some(s => s === ".DS_Store")) continue;
    // Skip huge files > 500KB text (prevent OOM)
    if (data.length > 500_000) continue;
    // Heuristic: skip binary (contains NUL byte in first 800 bytes)
    let isBinary = false;
    const sample = data.subarray(0, Math.min(800, data.length));
    for (let i = 0; i < sample.length; i++) if (sample[i] === 0) { isBinary = true; break; }
    if (isBinary) continue;
    // Skip known binary extensions
    const lower = p.toLowerCase();
    const binExt = [".png",".jpg",".jpeg",".gif",".webp",".ico",".woff",".woff2",".ttf",".otf",".pdf",".zip",".wasm",".mp3",".mp4"];
    if (binExt.some(ext => lower.endsWith(ext))) continue;
    try {
      const text = decoder.decode(data);
      // Filter out files that still look binary (many replacement chars)
      if (text.includes("\uFFFD") && (text.match(/\uFFFD/g)||[]).length > 10) continue;
      out[p] = text;
    } catch { /* skip */ }
  }
  return out;
}

export async function zipFromFiles(filesMap) {
  // filesMap: { "a/b.txt": "content", ... } or Map or CodeProject
  const ff = await getFflate();
  const obj = {};
  const enc = new TextEncoder();
  const entries = filesMap instanceof Map ? [...filesMap.entries()] : Object.entries(filesMap);
  for (const [rawPath, contentOrObj] of entries) {
    const content = contentOrObj && typeof contentOrObj === "object" && "content" in contentOrObj ? contentOrObj.content : contentOrObj;
    const p = String(rawPath).replace(/\\/g,"/").replace(/^\//,"");
    obj[p] = enc.encode(String(content ?? ""));
  }
  const zipped = await new Promise((resolve, reject) => {
    ff.zip(obj, (err, data) => err ? reject(err) : resolve(data));
  });
  return zipped; // Uint8Array
}

export async function downloadZip(filesMap, filename = "project.zip") {
  const data = await zipFromFiles(filesMap);
  const blob = new Blob([data], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { bytes: data.length };
}

async function toUint8Array(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
  if (source && typeof source.arrayBuffer === "function") return new Uint8Array(await source.arrayBuffer());
  throw new Error("Unsupported zip source");
}
