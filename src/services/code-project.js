// Virtual file-system for the agentic code workstation.
// Stores a flat map path → { content, mtime } and derives directory tree on demand.
// Path semantics: POSIX, no leading slash, `a/b/c.py`. Folders are implicit via prefixes.
// Persists to IndexedDB settings key `code-project-v3` (replaces code-buffers-v2).
// Migrates legacy `code-buffers-v2` (pyFiles + webFiles) on first load.

import { db } from "./db.js";

const STORAGE_KEY = "code-project-v3";
const LEGACY_KEY = "code-buffers-v2";
const LEGACY_KEY_V1 = "code-buffers";

const DEFAULT_PY = `# Python playground — real CPython compiled to WASM.
# Add modules with the + button or create folders in the explorer — any file
# can be imported via its dotted path (e.g. utils/helpers.py -> from utils.helpers import foo).
import sys

print("Hello from Python", sys.version.split()[0])
`;

const DEFAULT_WEB_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head>
<body>
  <main>
    <h1>Hello from the sandbox</h1>
    <p>Edit files in the explorer — preview refreshes automatically.</p>
    <button id="go">Click me</button>
    <output id="out"></output>
  </main>
  <script src="script.js"><\/script>
</body>
</html>
`;
const DEFAULT_WEB_CSS = `body {
  font-family: system-ui, sans-serif;
  display: grid; place-items: center;
  min-height: 100vh; margin: 0;
  background: #0b0d12; color: #e8ecf4;
}
main { text-align: center; }
button { padding: .6em 1.2em; border-radius: 8px; border: 1px solid #3a4358;
  background: #171c26; color: inherit; cursor: pointer; font-size: 1rem; }
button:hover { background: #202736; }
output { display: block; margin-top: 1em; color: #64ffa0; min-height: 1.5em; }`;
const DEFAULT_WEB_JS = `let n = 0;
document.getElementById("go").addEventListener("click", () => {
  n++;
  document.getElementById("out").textContent = \`clicked \${n} time\${n === 1 ? "" : "s"}\`;
  console.log("clicked", n);
});`;

const DEFAULT_FILES = {
  "README.md": `# Project

Welcome to the agentic code workspace.

* Create files & folders in the explorer on the left
* Open files to edit with syntax highlighting (CodeMirror)
* Ask the agent on the right to build, refactor, or fix code
* Run Python files via Pyodide or preview Web files in the sandbox
* Select code in the editor → “Add selection” to give the agent extra context
* Upload a .zip to import a codebase, Download .zip to export
* Reset Project clears everything back to this template

## Quick start

- \`main.py\` — Python entry point (run with ▶ Run)
- \`index.html\` / \`style.css\` / \`script.js\` — Web entry point (auto-previewed)
`,
  "main.py": DEFAULT_PY,
  "index.html": DEFAULT_WEB_HTML,
  "style.css": DEFAULT_WEB_CSS,
  "script.js": DEFAULT_WEB_JS,
};

function normalizePath(p) {
  let s = String(p || "").trim().replace(/\\/g, "/");
  // remove leading ./, /, duplicate slashes
  s = s.replace(/^\.?\//, "").replace(/\/+/g, "/");
  // remove trailing slash except root
  s = s.replace(/\/$/, "");
  // collapse . segments
  const parts = s.split("/").filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function isValidPath(p) {
  if (!p) return false;
  if (p.length > 240) return false;
  if (p.includes("\0")) return false;
  // each segment
  const segs = p.split("/");
  for (const s of segs) {
    if (!s || s === "." || s === "..") return false;
    if (/^\s|\s$/.test(s)) return false;
    if (/[<>:"|?*]/.test(s)) return false;
  }
  return true;
}

function dirname(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function basename(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export function normalizePathExport(p) { return normalizePath(p); }
export { isValidPath, dirname, basename };

// ---- Project Class ----

export class CodeProject {
  constructor(files = {}) {
    this.files = new Map(); // path → { content:string, mtime:number }
    for (const [k, v] of Object.entries(files)) {
      const p = normalizePath(k);
      if (!isValidPath(p)) continue;
      this.files.set(p, { content: String(v ?? ""), mtime: Date.now() });
    }
  }

  static fromStorage(obj) {
    if (!obj || typeof obj !== "object") return new CodeProject(DEFAULT_FILES);
    const files = obj.files && typeof obj.files === "object" ? obj.files : obj;
    // handle legacy map shape
    const flat = {};
    if (Array.isArray(files)) {
      for (const f of files) if (f?.name) flat[f.name] = f.content;
    } else {
      for (const [k, v] of Object.entries(files)) {
        if (v && typeof v === "object" && "content" in v) flat[k] = v.content;
        else flat[k] = v;
      }
    }
    if (Object.keys(flat).length === 0) return new CodeProject(DEFAULT_FILES);
    const p = new CodeProject(flat);
    // ensure template completeness
    return p;
  }

  toStorage() {
    const out = {};
    for (const [k, v] of this.files) out[k] = v.content;
    return { files: out, v: 3, updatedAt: Date.now() };
  }

  listFiles() {
    return [...this.files.entries()].map(([path, { content }]) => ({ path, content })).sort((a, b) => a.path.localeCompare(b.path));
  }

  listPaths() {
    return [...this.files.keys()].sort();
  }

  has(path) {
    const p = normalizePath(path);
    return this.files.has(p);
  }

  get(path) {
    const p = normalizePath(path);
    return this.files.get(p) || null;
  }

  getContent(path) {
    const f = this.get(path);
    return f ? f.content : null;
  }

  set(path, content) {
    const p = normalizePath(path);
    if (!isValidPath(p)) throw new Error(`Invalid path: ${path}`);
    this.files.set(p, { content: String(content ?? ""), mtime: Date.now() });
    return p;
  }

  delete(path) {
    const p = normalizePath(path);
    return this.files.delete(p);
  }

  // folder helpers: delete folder recursively
  deleteFolder(folderPath) {
    const prefix = normalizePath(folderPath);
    if (!prefix) throw new Error("Cannot delete root");
    let count = 0;
    for (const k of [...this.files.keys()]) {
      if (k === prefix || k.startsWith(prefix + "/")) { this.files.delete(k); count++; }
    }
    return count;
  }

  rename(oldPath, newPath) {
    const from = normalizePath(oldPath);
    const to = normalizePath(newPath);
    if (!isValidPath(to)) throw new Error(`Invalid path: ${newPath}`);
    if (!this.files.has(from)) throw new Error(`Not found: ${oldPath}`);
    if (this.files.has(to)) throw new Error(`Already exists: ${newPath}`);
    const data = this.files.get(from);
    this.files.delete(from);
    this.files.set(to, { content: data.content, mtime: Date.now() });
    return to;
  }

  moveFolder(oldFolder, newFolder) {
    const from = normalizePath(oldFolder);
    const to = normalizePath(newFolder);
    if (!from) throw new Error("Cannot move root");
    if (!isValidPath(to)) throw new Error(`Invalid destination: ${newFolder}`);
    if (from === to) return 0;
    const entries = [...this.files.entries()].filter(([k]) => k === from || k.startsWith(from + "/"));
    if (entries.length === 0) throw new Error(`Folder not found: ${oldFolder}`);
    // check collisions
    for (const [k] of entries) {
      const rel = k.slice(from.length);
      const dest = (to + rel).replace(/\/+/g, "/");
      if (this.files.has(dest) && !entries.some(([kk]) => kk === dest)) throw new Error(`Would overwrite: ${dest}`);
    }
    let count = 0;
    for (const [k, v] of entries) {
      const rel = k.slice(from.length);
      const dest = normalizePath(to + rel);
      this.files.set(dest, { content: v.content, mtime: Date.now() });
      this.files.delete(k);
      count++;
    }
    return count;
  }

  ensureFolder(folderPath) {
    // folders are implicit; this validates name
    const p = normalizePath(folderPath);
    if (p && !isValidPath(p + "/dummy")) throw new Error(`Invalid folder: ${folderPath}`);
    return p;
  }

  // Tree for explorer: { name, path, type:'dir'|'file', children[] }
  getTree() {
    const root = { name: "", path: "", type: "dir", children: [] };
    const nodes = new Map([["", root]]);
    for (const p of [...this.files.keys()].sort()) {
      const parts = p.split("/");
      let curPath = "";
      let parent = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        curPath = curPath ? `${curPath}/${part}` : part;
        if (!nodes.has(curPath)) {
          const isFile = i === parts.length - 1;
          const node = { name: part, path: curPath, type: isFile ? "file" : "dir", children: isFile ? undefined : [] };
          nodes.set(curPath, node);
          parent.children.push(node);
        }
        parent = nodes.get(curPath);
      }
    }
    const sortRec = (n) => {
      if (n.children) {
        n.children.sort((a, b) => {
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        n.children.forEach(sortRec);
      }
    };
    sortRec(root);
    return root;
  }

  // Stats
  getStats() {
    let totalChars = 0;
    for (const { content } of this.files.values()) totalChars += content.length;
    return { files: this.files.size, totalChars };
  }
}

// ---- Persistence ----

export async function loadProject() {
  // Try v3
  try {
    const saved = await db.get("settings", STORAGE_KEY);
    if (saved && saved.files) {
      return CodeProject.fromStorage(saved);
    }
  } catch {}
  // Migrate legacy v2 shape {pyFiles:[{name,content}], web:{html,css,js}}
  try {
    const legacy = await db.get("settings", LEGACY_KEY) ?? await db.get("settings", LEGACY_KEY_V1);
    if (legacy) {
      const files = {};
      if (legacy.pyFiles?.length) {
        for (const f of legacy.pyFiles) if (f?.name) files[f.name] = f.content ?? "";
      } else if (typeof legacy.py === "string") {
        files["main.py"] = legacy.py;
      }
      if (legacy.web && typeof legacy.web === "object") {
        if (legacy.web.html) files["index.html"] = legacy.web.html;
        if (legacy.web.css) files["style.css"] = legacy.web.css;
        if (legacy.web.js) files["script.js"] = legacy.web.js;
      }
      // Also handle legacy single HTML blob maybe
      if (Object.keys(files).length > 0) {
        const proj = new CodeProject({ ...DEFAULT_FILES, ...files });
        await saveProject(proj);
        return proj;
      }
    }
  } catch {}
  // Fresh
  const proj = new CodeProject(DEFAULT_FILES);
  try { await saveProject(proj); } catch {}
  return proj;
}

export async function saveProject(project) {
  try {
    await db.put("settings", project.toStorage(), STORAGE_KEY);
  } catch (e) { console.warn("saveProject failed", e); }
}

export async function resetProject() {
  const proj = new CodeProject(DEFAULT_FILES);
  await saveProject(proj);
  return proj;
}

export function getDefaultFiles() { return { ...DEFAULT_FILES }; }
