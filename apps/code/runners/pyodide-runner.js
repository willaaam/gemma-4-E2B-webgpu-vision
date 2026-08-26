// Python runtime for the code environment, powered by Pyodide (CPython in
// WASM). Loaded lazily on first use. This is a PLAYGROUND: micropip is
// available and users may install any pure-Python wheel from PyPI.

let pyodide = null;
let loadingPromise = null;
const PYODIDE_VERSION = "0.26.4";
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export function isPyodideLoaded() { return !!pyodide; }

// Direct access for advanced flows (filesystem writes, package listing).
export function getPyodide() { return pyodide; }

// Write project files into the Pyodide virtual filesystem so cross-file
// imports (`import utils`) resolve at run time.
// Accepts legacy array [{name,content}] OR Map OR plain {path:content} OR CodeProject.
export async function syncFilesToPyFS(files) {
  if (!pyodide) await loadPyodideRuntime();
  let entries = [];
  if (files && typeof files.files === "object" && files.files instanceof Map) {
    // CodeProject instance
    entries = [...files.files.entries()].map(([p, v]) => ({ name: p, content: v.content ?? v }));
  } else if (files instanceof Map) {
    entries = [...files.entries()].map(([p, v]) => ({ name: p, content: v?.content ?? v }));
  } else if (Array.isArray(files)) {
    entries = files;
  } else if (files && typeof files === "object") {
    entries = Object.entries(files).map(([k, v]) => ({ name: k, content: v?.content ?? v }));
  }
  for (const f of entries) {
    if (!f?.name || typeof f.content !== "string") continue;
    const rel = String(f.name).replace(/\\/g, "/").replace(/^\//, "");
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    if (dir) {
      try { pyodide.FS.mkdirTree(`/home/pyodide/${dir}`); } catch {}
    }
    const path = `/home/pyodide/${rel}`;
    try { pyodide.FS.writeFile(path, f.content); } catch { /* ignore unwritable paths */ }
  }
}

// Names of every package currently loaded in the runtime (bundled + pip-installed).
export function installedPackages() {
  if (!pyodide) return [];
  try { return Object.keys(pyodide.loadedPackages ?? {}).sort(); } catch { return []; }
}

export async function loadPyodideRuntime({ onStatus } = {}) {
  if (pyodide) return pyodide;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      onStatus?.("Loading Pyodide runtime…");
      const script = document.createElement("script");
      script.src = `${INDEX_URL}pyodide.js`;
      const loaded = new Promise((resolve, reject) => {
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Could not download the Pyodide runtime — check your connection once, it caches afterwards."));
      });
      document.head.appendChild(script);
      await loaded;
      onStatus?.("Booting CPython…");
      pyodide = await globalThis.loadPyodide({ indexURL: INDEX_URL });
      // Batched stdout/stderr capture — handlers replaced per-run.
      pyodide.setStdout({ batched: (s) => sink.stdout.push(s) });
      pyodide.setStderr({ batched: (s) => sink.stderr.push(s) });
      // handy for power users / debugging
      try { window.__pyodide = pyodide; } catch (_) {}
      onStatus?.("Python ready.");
      return pyodide;
    })();
    loadingPromise = loadingPromise.catch((e) => { loadingPromise = null; throw e; });
  }
  return loadingPromise;
}

// Shared per-run output sink (swapped before each execution).
const sink = { stdout: [], stderr: [] };

/**
 * Run Python source in the shared runtime.
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, result:string, error?:string, plots:string[]}>}
 */
export async function runPython(code) {
  if (!pyodide) await loadPyodideRuntime();
  sink.stdout = [];
  sink.stderr = [];
  const plots = [];
  let result = "";
  let error;

  try {
    // Auto-install any imports that are part of the Pyodide distribution
    // (numpy, pandas, matplotlib, …). Anything else goes through micropip.
    try { await pyodide.loadPackagesFromImports(code); } catch { /* offline or unknown package — let the run report it */ }
    // runPythonAsync supports top-level await; stdout/stderr flow through the
    // batched handlers installed at load time.
    const res = await pyodide.runPythonAsync(code);
    if (res !== undefined && res !== null) {
      try { result = res.toString(); } catch { result = String(res); }
    }
  } catch (err) {
    error = String(err?.message ?? err);
  }

  await drainPlots(plots);

  return {
    ok: !error,
    stdout: sink.stdout.join("\n"),
    stderr: sink.stderr.join("\n"),
    result,
    error,
    plots,
  };
}

// Defined once at boot: collects open matplotlib figures as base64 PNGs.
const DRAIN_PLOTS_PY = `
def __ws_drain_plots():
    out = []
    try:
        import io, base64
        import matplotlib.pyplot as plt
        for num in list(plt.get_fignums()):
            fig = plt.figure(num)
            if fig is None:
                continue
            buf = io.BytesIO()
            fig.savefig(buf, format='png', dpi=110, bbox_inches='tight')
            out.append('data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode())
            plt.close(fig)
    except Exception:
        pass
    return out
`;

async function drainPlots(out) {
  try {
    const list = await pyodide.runPythonAsync(DRAIN_PLOTS_PY + "\n__ws_drain_plots()");
    const arr = typeof list.toJs === "function" ? Array.from(list.toJs()) : Array.from(list);
    for (const item of arr) {
      const s = String(item);
      if (s.startsWith("data:image/")) out.push(s);
    }
    try { list.destroy?.(); } catch (_) {}
  } catch { /* matplotlib not installed — fine */ }
}

/**
 * Install a package at runtime (playground mode).
 * Uses micropip for PyPI wheels, loadPackage for Pyodide-bundled ones.
 */
export async function installPackage(name, { onStatus } = {}) {
  if (!pyodide) await loadPyodideRuntime();
  onStatus?.(`Installing ${name}…`);
  try {
    // Try the bundled distribution first (numpy/pandas/matplotlib/… are prebuilt)
    await pyodide.loadPackage(name);
    onStatus?.(`${name} installed.`);
    return true;
  } catch {
    // Fall back to micropip → PyPI (pure-Python wheels). micropip itself is
    // part of the distribution but NOT loaded by default — load it explicitly.
    await pyodide.loadPackage("micropip");
    const micropip = pyodide.pyimport("micropip");
    await micropip.install(name);
    onStatus?.(`${name} installed from PyPI.`);
    return true;
  }
}
