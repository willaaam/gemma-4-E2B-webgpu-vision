// src/lib/asset-store.js — local asset registry for the portable (no-server) build.
//
// WHY THIS EXISTS
// A `file://` page cannot `fetch()` its sibling files (CORS, opaque origin) and has
// no HTTP Range support. But a user-picked `File` can be read at arbitrary byte
// offsets via `Blob.slice(a, b).arrayBuffer()`. So instead of asking a server for
// ranges, we ask the *user* for the files once and read them directly.
//
// A picked `File` is exposed through a reserved virtual origin (see asset-fetch.js)
// so that every consumer — the model loaders, Pyodide, micropip, pdf.js — keeps
// seeing ordinary `https://` URLs and needs no special-casing.
//
// Dev / served builds never touch this module: `import.meta.url` relative paths
// work normally there.

/** Reserved origin that is always answered from the local registry, never the network. */
export const VIRTUAL_ORIGIN = "https://assets.local/";

/** True for URLs that belong to the virtual asset origin. */
export function isVirtualUrl(ref) {
  return typeof ref === "string" && ref.startsWith(VIRTUAL_ORIGIN);
}

/** Build a virtual URL for a registry-relative path (e.g. "pyodide/pyodide.asm.wasm"). */
export function virtualUrl(path) {
  return VIRTUAL_ORIGIN + String(path).replace(/^\/+/, "");
}

/** Normalize any reference (absolute URL, virtual URL, ./assets/x, bare name) to a
 *  registry key: no origin, no query/hash, no leading "./" or "/". */
export function normalizeKey(ref) {
  let s = String(ref ?? "").trim();
  if (!s) return "";
  s = s.replace(/^blob:[^/]*\//, "");
  // Strip an origin from absolute http(s) URLs, including the virtual one.
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]*\/(.*)$/i.exec(s);
  if (m) s = m[1];
  s = s.split("#")[0].split("?")[0];
  s = s.replace(/^\.\//, "").replace(/^\/+/, "");
  return s;
}

/** Decode a `data:` URL body into bytes (used for small inlined assets). */
function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) throw new Error("Malformed data URL");
  const meta = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(decodeURIComponent(body));
}

/**
 * Registry of locally available files, keyed by registry-relative path.
 *
 * Sources of entries:
 *   • `addPicked(files, prefix)` — from `<input type="file" webkitdirectory>` (keeps
 *     the `webkitRelativePath` sub-tree) or a multi-file `<input type="file">`.
 *   • `addFile(file, path)` — an explicit logical path (e.g. `model.safetensors`).
 *   • `addFromDataTransfer(dt)` — drag & drop onto the page.
 *
 * Lookup is deliberately forgiving (`resolve`): exact path → path relative to the
 * input's directory → unique basename. An ambiguous basename resolves to `null`
 * rather than guessing, matching the web runner's `resolveWebRef` behaviour.
 */
export class AssetStore {
  #byPath = new Map();
  #byBasename = new Map();
  #version = 0;
  #listeners = new Set();

  get version() { return this.#version; }
  get size() { return this.#byPath.size; }

  get totalBytes() {
    let total = 0;
    for (const file of this.#byPath.values()) total += file.size ?? 0;
    return total;
  }

  paths() { return [...this.#byPath.keys()].sort(); }

  onChange(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit() {
    this.#version++;
    for (const fn of this.#listeners) {
      try { fn(this); } catch { /* listener errors must not break ingestion */ }
    }
  }

  /** Register one file under an explicit registry path. Returns the normalized key. */
  addFile(file, path) {
    if (!file) return null;
    const key = normalizeKey(path ?? file.name ?? "");
    if (!key) return null;
    this.#byPath.set(key, file);
    const base = key.split("/").pop();
    if (!this.#byBasename.has(base)) this.#byBasename.set(base, []);
    const bucket = this.#byBasename.get(base);
    if (!bucket.includes(key)) bucket.push(key);
    return key;
  }

  /**
   * Register every file from a FileList.
   * @param {FileList|File[]} files
   * @param {{prefix?: string, useRelativePath?: boolean}} [opts]
   *   `useRelativePath` (default true) keeps `webkitRelativePath`, and the first
   *   path segment is dropped so picking a folder called `assets` yields
   *   `pyodide/…` and `model.safetensors` rather than `assets/pyodide/…`.
   *   Set `prefix` to prepend an explicit directory.
   */
  addPicked(files, { prefix = "", useRelativePath = true } = {}) {
    const added = [];
    for (const file of Array.from(files ?? [])) {
      if (!file) continue;
      let rel = "";
      if (prefix) {
        rel = `${String(prefix).replace(/^\/+|\/+$/g, "")}/${file.name}`;
      } else if (useRelativePath && typeof file.webkitRelativePath === "string" && file.webkitRelativePath) {
        const parts = file.webkitRelativePath.split("/").filter(Boolean);
        // Drop the picked folder's own name; it is not meaningful to the app.
        rel = parts.slice(1).join("/") || file.name;
      } else {
        rel = file.name;
      }
      const key = this.addFile(file, rel);
      if (key) added.push(key);
    }
    if (added.length) this.#emit();
    return added;
  }

  /**
   * Register files under explicit logical paths.
   * @param {Array<{file: File, path: string}>} entries
   */
  addMapped(entries) {
    const added = [];
    for (const entry of entries ?? []) {
      if (!entry?.file) continue;
      const key = this.addFile(entry.file, entry.path ?? entry.file.name);
      if (key) added.push(key);
    }
    if (added.length) this.#emit();
    return added;
  }

  /** Drag & drop: accepts a DataTransfer and walks directory entries when available. */
  async addFromDataTransfer(dataTransfer) {
    const added = [];
    const items = dataTransfer?.items ? Array.from(dataTransfer.items) : [];
    const entries = items
      .filter((it) => it.kind === "file")
      .map((it) => (typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null));

    if (entries.some(Boolean)) {
      const walk = async (entry, prefix) => {
        if (!entry) return;
        if (entry.isFile) {
          const file = await new Promise((res, rej) => entry.file(res, rej));
          const key = this.addFile(file, `${prefix}${file.name}`);
          if (key) added.push(key);
          return;
        }
        if (entry.isDirectory) {
          const reader = entry.createReader();
          // readEntries() returns at most ~100 entries per call; loop until empty.
          for (;;) {
            const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
            if (!batch.length) break;
            for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
          }
        }
      };
      for (const entry of entries) await walk(entry, "");
    } else if (dataTransfer?.files?.length) {
      for (const file of Array.from(dataTransfer.files)) {
        const key = this.addFile(file, file.name);
        if (key) added.push(key);
      }
    }
    if (added.length) this.#emit();
    return added;
  }

  /** Add a small asset from a `data:` URL. */
  addDataUrl(dataUrl, path) {
    const bytes = dataUrlToBytes(dataUrl);
    const blob = new Blob([bytes], { type: "" });
    return this.addFile(blob, path);
  }

  has(ref) { return this.resolve(ref) !== null; }

  /**
   * Find the file for a reference.
   *
   * Consumers ask for deep paths (`models/google/…/model.safetensors`) while the
   * user's picked folder is usually flatter, so we degrade gracefully:
   * exact path → unique path-tail match → unique basename. Anything ambiguous
   * resolves to `null` rather than guessing — serving the wrong tensor file would
   * fail confusingly much later.
   */
  resolve(ref) {
    const key = normalizeKey(ref);
    if (!key) return null;

    const exact = this.#byPath.get(key);
    if (exact) return exact;

    // Path-tail match: the requested key ends with a stored path, or vice versa.
    const tails = new Set();
    for (const [stored, file] of this.#byPath) {
      if (key.endsWith(`/${stored}`) || stored.endsWith(`/${key}`)) tails.add(file);
    }
    if (tails.size === 1) return [...tails][0];

    // Last resort: a unique basename match.
    const base = key.split("/").pop();
    const bucket = this.#byBasename.get(base);
    if (bucket?.length === 1) return this.#byPath.get(bucket[0]) ?? null;

    return null;
  }

  /** The file that should serve as `model.safetensors`, if present. */
  resolveModelFile() {
    if (this.has("model.safetensors")) return this.resolve("model.safetensors");
    const matches = this.paths().filter((p) => /(^|\/)model\.safetensors$/.test(p));
    if (matches.length === 1) return this.resolve(matches[0]);
    return null;
  }

  clear() {
    this.#byPath.clear();
    this.#byBasename.clear();
    this.#emit();
  }

  /** Serializable summary for the UI / diagnostics. */
  describe() {
    return {
      files: this.size,
      bytes: this.totalBytes,
      hasModel: !!this.resolveModelFile(),
      hasPyodide: this.has("pyodide/pyodide.asm.wasm"),
      paths: this.paths(),
    };
  }
}

/** Process-wide store shared by the shell, the model service and the runners. */
export const assetStore = new AssetStore();
