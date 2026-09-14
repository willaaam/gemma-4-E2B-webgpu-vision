// Web runtime for the code environment.
// Renders any HTML file from the project into a sandboxed iframe via srcdoc,
// inlining the CSS/JS it references (resolved generically from the file map).
// The iframe gets `allow-scripts` but NOT `allow-same-origin`, so it cannot
// touch the parent DOM, cookies or storage. A console bridge forwards
// console.* and errors to the app over postMessage.

const BRIDGE_TOKEN = `ws-bridge-${Math.random().toString(36).slice(2)}`;
const BRIDGE_RUN_ID_PLACEHOLDER = "__ws_run_id__";

const BRIDGE_SCRIPT = `
<script>
(function () {
  var TOKEN = ${JSON.stringify(BRIDGE_TOKEN)};
  function send(level, args) {
    try {
      parent.postMessage({ type: "ws-console", token: TOKEN, level: level,
        runId: ${JSON.stringify(BRIDGE_RUN_ID_PLACEHOLDER)},
        args: Array.prototype.map.call(args, function (a) {
          try {
            if (a instanceof Error) return a.stack || String(a);
            if (typeof a === "object" && a !== null) return JSON.stringify(a, null, 1);
            return String(a);
          } catch (_) { return String(a); }
        }) }, "*");
    } catch (_) {}
  }
  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var orig = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () { send(level, arguments); orig.apply(console, arguments); };
  });
  window.addEventListener("error", function (e) { send("error", [e.message + " (" + (e.filename||"inline") + ":" + e.lineno + ")"]); });
  window.addEventListener("unhandledrejection", function (e) { send("error", ["Unhandled promise rejection: " + (e.reason && (e.reason.stack || e.reason.message) || e.reason)]); });
})();
<\/script>`;

const PROBE_SCRIPT = `
<script>
(function () {
  var TOKEN = ${JSON.stringify(BRIDGE_TOKEN)};
  var RUN_ID = ${JSON.stringify(BRIDGE_RUN_ID_PLACEHOLDER)};
  function hash(value) {
    var result = 2166136261;
    var text = String(value || "");
    for (var index = 0; index < text.length; index++) {
      result ^= text.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(16);
  }
  function isVisible(element) {
    try {
      var rect = element.getBoundingClientRect();
      var style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    } catch (_) {
      return false;
    }
  }
  function snapshot() {
    var body = document.body;
    var all = body ? Array.prototype.slice.call(body.querySelectorAll("*")) : [];
    var controls = all.filter(function (element) {
      return /^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(element.tagName) || element.getAttribute("role") === "button" || (element.tagName === "A" && element.hasAttribute("href"));
    }).filter(isVisible);
    var canvases = all.filter(function (element) { return element.tagName === "CANVAS"; });
    var canvasStates = canvases.map(function (canvas) {
      try { return canvas.toDataURL().slice(-128); } catch (_) { return ""; }
    });
    var bodyHtml = body ? body.innerHTML : "";
    return {
      bodyText: body ? String(body.innerText || "").trim().slice(0, 500) : "",
      controlCount: controls.length,
      controls: controls.slice(0, 8).map(function (element) { return String(element.textContent || element.value || element.id || "").trim().slice(0, 80); }),
      visibleElements: all.filter(isVisible).length,
      canvasVisible: canvases.some(isVisible),
      canvasCount: canvases.length,
      canvasStates: canvasStates,
      htmlHash: hash(bodyHtml.slice(0, 50000)),
    };
  }
  function changed(before, after) {
    return before.htmlHash !== after.htmlHash || before.bodyText !== after.bodyText || before.canvasStates.join("|") !== after.canvasStates.join("|");
  }
  function emit(probe) {
    try { parent.postMessage({ type: "ws-probe", token: TOKEN, runId: RUN_ID, probe: probe }, "*"); } catch (_) {}
  }
  async function run() {
    var finalState = snapshot();
    var rendered = Boolean(finalState.bodyText && finalState.visibleElements > 0);
    emit({
      ok: rendered,
      rendered: rendered,
      state: finalState,
    });
  }
  setTimeout(function () { run().catch(function (error) { emit({ ok: false, rendered: false, interactive: false, error: String(error && error.message || error) }); }); }, 0);
})();
<\/script>`;

export const DEFAULT_WEB_FILES = {
  html: `<!doctype html>
<html>
<head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head>
<body>
  <main>
    <h1>Hello from the sandbox</h1>
    <p>Edit the files on the left — preview refreshes automatically.</p>
    <button id="go">Click me</button>
    <output id="out"></output>
  </main>
  <script src="script.js"><\/script>
</body>
</html>`,
  css: `body {
  font-family: system-ui, sans-serif;
  display: grid; place-items: center;
  min-height: 100vh; margin: 0;
  background: #0b0d12; color: #e8ecf4;
}
main { text-align: center; }
button { padding: .6em 1.2em; border-radius: 8px; border: 1px solid #3a4358;
  background: #171c26; color: inherit; cursor: pointer; font-size: 1rem; }
button:hover { background: #202736; }
output { display: block; margin-top: 1em; color: #64ffa0; min-height: 1.5em; }`,
  js: `let n = 0;
document.getElementById("go").addEventListener("click", () => {
  n++;
  document.getElementById("out").textContent = \`clicked \${n} time\${n === 1 ? "" : "s"}\`;
  console.log("clicked", n);
});`,
};

/**
 * Compose virtual files into a full HTML document string.
 *
 * Generic by design: the entry is any .html file in the project, and every
 * relative `<link href>` / `<script src>` reference is resolved against the
 * project file map and inlined. Resolution tries the exact path, the path
 * relative to the entry's own folder (so nested entry points work), then a
 * unique basename match. No file names are hardcoded.
 */
function contentOf(value) {
  return typeof value === "string" ? value : value?.content ?? value ?? "";
}

function normalizeEntry(entry) {
  return String(entry || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function isExternalRef(ref) {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(ref) || /^[a-z][a-z0-9+.-]*:/i.test(ref);
}

function isHtmlPath(p) {
  return /\.html?$/i.test(String(p || ""));
}

function dirOf(p) {
  const i = String(p || "").lastIndexOf("/");
  return i === -1 ? "" : String(p).slice(0, i);
}

// Collapse "." and ".." segments out of a POSIX-ish path.
function collapse(p) {
  const out = [];
  for (const part of String(p || "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** Normalize any supported project shape (Map, CodeProject, flat map, legacy trio) to Map<path, content>. */
export function toFileMap(files) {
  const map = new Map();
  if (!files || typeof files !== "object") return map;
  if (files instanceof Map) {
    for (const [k, v] of files) map.set(normalizeEntry(k), contentOf(v));
    return map;
  }
  if (files.files instanceof Map) return toFileMap(files.files);
  if (files.html !== undefined || files.css !== undefined || files.js !== undefined) {
    map.set("index.html", contentOf(files.html));
    map.set("style.css", contentOf(files.css));
    map.set("script.js", contentOf(files.js));
    return map;
  }
  for (const [k, v] of Object.entries(files)) {
    if (k === "files") continue;
    map.set(normalizeEntry(k), contentOf(v));
  }
  return map;
}

/** Resolve one relative href/src reference to a project path, or null when it is external/missing.
 *  Ambiguous basenames are left alone rather than silently picking the wrong file. */
export function resolveWebRef(ref, entryPath, map) {
  let raw = String(ref || "").trim();
  if (!raw || isExternalRef(raw) || raw.startsWith("data:")) return null;
  raw = raw.split(/[?#]/)[0].replace(/^\.\//, "");
  if (!raw) return null;
  const candidates = [];
  if (raw.startsWith("/")) {
    candidates.push(collapse(raw));
  } else {
    const base = dirOf(entryPath);
    if (base) candidates.push(collapse(`${base}/${raw}`));
    candidates.push(collapse(raw));
  }
  for (const c of candidates) if (c && map.has(c)) return c;
  const base = collapse(raw).split("/").pop();
  if (base) {
    const matches = [...map.keys()].filter((k) => k.split("/").pop() === base);
    if (matches.length === 1) return matches[0];
  }
  return null;
}

// Inline every resolvable stylesheet / script reference from the project.
function inlineProjectAssets(html, entryPath, map) {
  let out = String(html);
  out = out.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) return tag;
    const m = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
    const resolved = m ? resolveWebRef(m[1], entryPath, map) : null;
    if (!resolved) return tag;
    return `<style data-ws-src="${resolved}">\n${map.get(resolved) ?? ""}\n</style>`;
  });
  out = out.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (tag, attrs) => {
    const m = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (!m) return tag;
    const resolved = resolveWebRef(m[1], entryPath, map);
    if (!resolved) return tag;
    return `<script data-ws-src="${resolved}">\n${map.get(resolved) ?? ""}\n</script>`;
  });
  return out;
}

/** Which HTML file a run would render: the explicit entry when valid, else the first HTML file. */
export function pickWebEntry(files, entry = null) {
  const map = toFileMap(files);
  const requested = normalizeEntry(entry);
  if (requested && map.has(requested) && isHtmlPath(requested)) return requested;
  return [...map.keys()].find(isHtmlPath) ?? null;
}

export function composeWebDoc(files, entry = null, runId = null) {
  const map = toFileMap(files);
  const entryPath = pickWebEntry(map, entry);
  let html = entryPath ? map.get(entryPath) : "";
  if (!html) {
    html = `<!doctype html><html><head><meta charset="utf-8"></head><body><p>No HTML file found in this project.</p></body></html>`;
  } else {
    html = inlineProjectAssets(html, entryPath, map);
  }
  // inject the console bridge right after <head> (or at the top)
  const bridgeScript = BRIDGE_SCRIPT.replace(JSON.stringify(BRIDGE_RUN_ID_PLACEHOLDER), JSON.stringify(String(runId || "")));
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${bridgeScript}`);
  else html = `${bridgeScript}\n${html}`;
  const probeScript = PROBE_SCRIPT.replace(JSON.stringify(BRIDGE_RUN_ID_PLACEHOLDER), JSON.stringify(String(runId || "")));
  if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, `${probeScript}\n$&`);
  else html = `${html}\n${probeScript}`;
  return html;
}

// Helper to compose from a CodeProject file map with multiple html entries
export function composeWebDocFromProject(project, entry = null, runId = null) {
  if (!project) return composeWebDoc({});
  const map = project.files;
  return composeWebDoc(map, entry, runId);
}

export class WebRunner {
  constructor(iframe, { onConsole, onProbe } = {}) {
    this.iframe = iframe;
    this.onConsole = onConsole ?? (() => {});
    this.onProbe = onProbe ?? (() => {});
    this._runSequence = 0;
    this._activeRunId = null;
    this._probeWaiters = new Map();
    this._listener = (e) => {
      const d = e.data;
      if (!d || d.token !== BRIDGE_TOKEN || d.runId !== this._activeRunId) return;
      if (d.type === "ws-console") {
        this.onConsole(d.level, (d.args ?? []).join(" "));
        return;
      }
      if (d.type === "ws-probe") {
        this.onProbe(d.probe);
        const waiter = this._probeWaiters.get(d.runId);
        if (waiter) waiter(d.probe);
      }
    };
    window.addEventListener("message", this._listener);
  }

  run(files, { entry = null } = {}) {
    this.clearConsole();
    const runId = `run-${++this._runSequence}`;
    this._activeRunId = runId;
    // Accepts CodeProject, Map, plain object, or legacy trio (see toFileMap).
    const srcdoc = composeWebDoc(files, entry, runId);
    const probe = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._probeWaiters.delete(runId);
        resolve(null);
      }, 1800);
      this._probeWaiters.set(runId, (value) => {
        clearTimeout(timer);
        this._probeWaiters.delete(runId);
        resolve(value);
      });
    });
    const ready = new Promise((resolve) => {
      let settled = false;
      let settleTimer = 0;
      const settle = () => {
        if (settled) return;
        settled = true;
        this.iframe.removeEventListener("load", onLoad);
        clearTimeout(settleTimer);
        resolve({ runId });
      };
      const onLoad = () => {
        if (this._activeRunId !== runId) {
          settle();
          return;
        }
        settleTimer = setTimeout(settle, 60);
      };
      this.iframe.addEventListener("load", onLoad);
      settleTimer = setTimeout(settle, 1200);
      this.iframe.srcdoc = srcdoc;
    });
    return ready.then(async result => ({ ...result, probe: await probe }));
  }

  runProject(project, { entry = null } = {}) {
    return this.run(project?.files ?? project ?? {}, { entry });
  }

  clearConsole() { /* hook for UI */ }

  dispose() {
    this._activeRunId = null;
    for (const [runId, resolve] of this._probeWaiters) {
      this._probeWaiters.delete(runId);
      resolve(null);
    }
    window.removeEventListener("message", this._listener);
    this.iframe.srcdoc = "";
  }
}
