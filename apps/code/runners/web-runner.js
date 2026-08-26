// Web runtime for the code environment.
// Composes three virtual files (index.html / style.css / script.js) into a
// sandboxed iframe via srcdoc. The iframe gets `allow-scripts` but NOT
// `allow-same-origin`, so it cannot touch the parent DOM, cookies or storage.
// A console bridge forwards console.* and errors to the app over postMessage.

const BRIDGE_TOKEN = `ws-bridge-${Math.random().toString(36).slice(2)}`;

const BRIDGE_SCRIPT = `
<script>
(function () {
  var TOKEN = ${JSON.stringify(BRIDGE_TOKEN)};
  function send(level, args) {
    try {
      parent.postMessage({ type: "ws-console", token: TOKEN, level: level,
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
export function composeWebDoc(files) {
  // Normalize input: flat map, CodeProject, or legacy trio
  let html = "", css = "", js = "";
  if (files && typeof files === "object") {
    if (files.html !== undefined || files.css !== undefined || files.js !== undefined) {
      html = files.html ?? "";
      css = files.css ?? "";
      js = files.js ?? "";
    } else if (files instanceof Map) {
      for (const [k, v] of files) {
        const c = v?.content ?? v ?? "";
        if (k === "index.html" || k.endsWith("/index.html")) html = c;
      }
      // collect possible css/js
      const get = (p) => {
        const v = files.get(p);
        return v?.content ?? v ?? "";
      };
      css = get("style.css") ?? "";
      js = get("script.js") ?? "";
      if (!html) {
        // fallback: pick any .html
        for (const [k, v] of files) if (k.toLowerCase().endsWith(".html")) { html = v?.content ?? v; break; }
      }
    } else if (files.files instanceof Map) {
      // CodeProject
      return composeWebDoc(files.files);
    } else {
      // plain {path:content}
      if (files["index.html"] != null) html = files["index.html"];
      else if (files["index.html"]?.content != null) html = files["index.html"].content;
      else {
        for (const [k, v] of Object.entries(files)) if (k.toLowerCase().endsWith(".html")) { html = typeof v === "string" ? v : v?.content ?? ""; break; }
      }
      css = files["style.css"] ?? files["style.css"]?.content ?? "";
      if (typeof css !== "string") css = String(css ?? "");
      js = files["script.js"] ?? files["script.js"]?.content ?? "";
      if (typeof js !== "string") js = String(js ?? "");
      // also handle case where files is {files:{...}} from project
      if (!html && files.files) return composeWebDoc(files.files);
    }
  }
  if (!html) html = `<!doctype html><html><head><meta charset="utf-8"></head><body><p>No index.html found.</p></body></html>`;

  // inline <link rel="stylesheet" href="style.css">
  html = html.replace(/<link[^>]*href=["']style\.css["'][^>]*>/gi, () => `<style>\n${css ?? ""}\n</style>`);
  // inline <script src="script.js"></script> (keep script tags out of the bridge's way)
  html = html.replace(/<script[^>]*src=["']script\.js["'][^>]*>\s*<\/script>/gi, () => `<script>\n${js ?? ""}\n<\/script>`);
  // inject the console bridge right after <head> (or at the top)
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${BRIDGE_SCRIPT}`);
  else html = `${BRIDGE_SCRIPT}\n${html}`;
  return html;
}

// Helper to compose from a CodeProject file map with multiple html entries
export function composeWebDocFromProject(project) {
  if (!project) return composeWebDoc({});
  // project is CodeProject instance
  const map = project.files;
  return composeWebDoc(map);
}

export class WebRunner {
  constructor(iframe, { onConsole } = {}) {
    this.iframe = iframe;
    this.onConsole = onConsole ?? (() => {});
    this._listener = (e) => {
      const d = e.data;
      if (!d || d.type !== "ws-console" || d.token !== BRIDGE_TOKEN) return;
      this.onConsole(d.level, (d.args ?? []).join(" "));
    };
    window.addEventListener("message", this._listener);
  }

  run(files) {
    this.clearConsole();
    // Accept CodeProject, Map, plain object, or legacy trio
    if (files && typeof files.files === "object" && files.files instanceof Map) {
      this.iframe.srcdoc = composeWebDoc(files.files);
    } else {
      this.iframe.srcdoc = composeWebDoc(files);
    }
  }

  runProject(project) {
    this.clearConsole();
    this.iframe.srcdoc = composeWebDoc(project?.files ?? project ?? {});
  }

  clearConsole() { /* hook for UI */ }

  dispose() {
    window.removeEventListener("message", this._listener);
    this.iframe.srcdoc = "";
  }
}
