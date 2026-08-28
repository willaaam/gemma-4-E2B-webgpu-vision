// Web runtime for the code environment.
// Composes three virtual files (index.html / style.css / script.js) into a
// sandboxed iframe via srcdoc. The iframe gets `allow-scripts` but NOT
// `allow-same-origin`, so it cannot touch the parent DOM, cookies or storage.
// A console bridge forwards console.* and errors to the app over postMessage.

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
  function trackCount(value) {
    if (!value || value === "none") return 0;
    return String(value).trim().split(/\s+/).filter(Boolean).length;
  }
  function snapshot() {
    var body = document.body;
    var all = body ? Array.prototype.slice.call(body.querySelectorAll("*")) : [];
    var controls = all.filter(function (element) {
      return /^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(element.tagName) || element.getAttribute("role") === "button" || (element.tagName === "A" && element.hasAttribute("href"));
    }).filter(isVisible);
    var boards = all.filter(function (element) {
      return /board|grid|canvas/i.test((element.id || "") + " " + (element.className || ""));
    });
    var board = boards.find(function (element) { return /board/i.test((element.id || "") + " " + (element.className || "")) && isVisible(element); }) || boards.find(isVisible) || null;
    var boardStyle = board ? getComputedStyle(board) : null;
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
      boardCount: boards.length,
      boardVisible: boards.some(isVisible),
      canvasVisible: canvases.some(isVisible),
      board: board ? {
        width: board.getBoundingClientRect().width,
        height: board.getBoundingClientRect().height,
        columns: trackCount(boardStyle.gridTemplateColumns),
        rows: trackCount(boardStyle.gridTemplateRows),
        children: board.children.length,
      } : null,
      cellCount: body ? body.querySelectorAll(".cell,[data-cell]").length : 0,
      blockCount: body ? body.querySelectorAll(".block,.filled,.occupied,[data-filled='true'],[data-occupied='true']").length : 0,
      canvasCount: canvases.length,
      canvasStates: canvasStates,
      htmlHash: hash(bodyHtml.slice(0, 50000)),
    };
  }
  function changed(before, after) {
    return before.htmlHash !== after.htmlHash || before.bodyText !== after.bodyText || before.blockCount !== after.blockCount || before.canvasStates.join("|") !== after.canvasStates.join("|");
  }
  function delay(milliseconds) { return new Promise(function (resolve) { setTimeout(resolve, milliseconds); }); }
  function emit(probe) {
    try { parent.postMessage({ type: "ws-probe", token: TOKEN, runId: RUN_ID, probe: probe }, "*"); } catch (_) {}
  }
  async function run() {
    var initial = snapshot();
    var launchControl = Array.prototype.slice.call(document.querySelectorAll("button,[role='button'],input[type='button'],input[type='submit']")).find(function (element) {
      return isVisible(element) && /start|play|begin|launch|run/i.test(String(element.textContent || element.value || ""));
    });
    var launchChanged = false;
    if (launchControl) {
      try {
        launchControl.click();
        await delay(80);
        launchChanged = changed(initial, snapshot());
      } catch (_) {}
    }
    var before = snapshot();
    var keyboard = [];
    var keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "];
    for (var index = 0; index < keys.length; index++) {
      var key = keys[index];
      try {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: key, code: key === " " ? "Space" : key, bubbles: true, cancelable: true }));
      } catch (_) {}
      await delay(35);
      var after = snapshot();
      keyboard.push({ key: key, changed: changed(before, after) });
      before = after;
    }
    var finalState = snapshot();
    var rendered = Boolean(finalState.bodyText && finalState.visibleElements > 0 && (finalState.boardVisible || finalState.canvasCount > 0 || finalState.controlCount > 0));
    var keyboardChanged = keyboard.some(function (entry) { return entry.changed; });
    emit({
      ok: rendered && Boolean(launchChanged || keyboardChanged),
      rendered: rendered,
      interactive: Boolean(launchChanged || keyboardChanged),
      launchControl: launchControl ? String(launchControl.textContent || launchControl.value || launchControl.id || "").trim().slice(0, 80) : "",
      launchChanged: launchChanged,
      keyboardChanged: keyboardChanged,
      keyboard: keyboard,
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
 * Supports both legacy {html,css,js} shape and new flat project map.
 * Relative references to style.css / script.js are inlined when those exist.
 */
function contentOf(value) {
  return typeof value === "string" ? value : value?.content ?? value ?? "";
}

function normalizeEntry(entry) {
  return String(entry || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function composeWebDoc(files, entry = null, runId = null) {
  // Normalize input: flat map, CodeProject, or legacy trio
  const requestedEntry = normalizeEntry(entry);
  let html = "", css = "", js = "";
  if (files && typeof files === "object") {
    if (files.html !== undefined || files.css !== undefined || files.js !== undefined) {
      html = files.html ?? "";
      css = files.css ?? "";
      js = files.js ?? "";
    } else if (files instanceof Map) {
      for (const [k, v] of files) {
        const c = contentOf(v);
        if (requestedEntry && k === requestedEntry && /\.html?$/i.test(k)) html = c;
        else if (!requestedEntry && (k === "index.html" || k.endsWith("/index.html"))) html = c;
      }
      if (!html && requestedEntry) {
        for (const [k, v] of files) {
          if (/\.html?$/i.test(k)) { html = contentOf(v); break; }
        }
      }
      // collect possible css/js
      const get = (p) => {
        const v = files.get(p);
        return contentOf(v);
      };
      css = get("style.css") ?? "";
      js = get("script.js") ?? "";
      if (!html) {
        // fallback: pick any .html
        for (const [k, v] of files) if (/\.html?$/i.test(k)) { html = contentOf(v); break; }
      }
    } else if (files.files instanceof Map) {
      // CodeProject
      return composeWebDoc(files.files, entry, runId);
    } else {
      // plain {path:content}
      if (requestedEntry && files[requestedEntry] != null) html = contentOf(files[requestedEntry]);
      else if (files["index.html"] != null) html = contentOf(files["index.html"]);
      else {
        for (const [k, v] of Object.entries(files)) if (/\.html?$/i.test(k)) { html = contentOf(v); break; }
      }
      css = contentOf(files["style.css"]);
      js = contentOf(files["script.js"]);
      // also handle case where files is {files:{...}} from project
      if (!html && files.files) return composeWebDoc(files.files, entry, runId);
    }
  }
  if (!html) html = `<!doctype html><html><head><meta charset="utf-8"></head><body><p>No index.html found.</p></body></html>`;

  // inline <link rel="stylesheet" href="style.css">
  html = html.replace(/<link[^>]*href=["']style\.css["'][^>]*>/gi, () => `<style>\n${css ?? ""}\n</style>`);
  // inline <script src="script.js"></script> (keep script tags out of the bridge's way)
  html = html.replace(/<script[^>]*src=["']script\.js["'][^>]*>\s*<\/script>/gi, () => `<script>\n${js ?? ""}\n<\/script>`);
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
  // project is CodeProject instance
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
    // Accept CodeProject, Map, plain object, or legacy trio
    const srcdoc = files && typeof files.files === "object" && files.files instanceof Map
      ? composeWebDoc(files.files, entry, runId)
      : composeWebDoc(files, entry, runId);
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
