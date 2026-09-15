// Python runtime for the code environment, powered by Pyodide (CPython in WASM).
// Supports:
//  - Interactive stdin / input() handling with window.prompt & stdin queue
//  - Non-interactive testing mode for agent code verification
//  - Execution interrupt / stop via interruptBuffer (SIGINT)
//  - Realtime streaming stdout/stderr
//  - Package installation via micropip / PyPI wheels
//  - Matplotlib plot auto-drain

let pyodide = null;
let loadingPromise = null;
let interruptBuffer = null;
let isExecuting = false;
let currentRunAbort = null;
// Pristine interpreter state captured right after boot (see loadPyodideRuntime).
// Used by resetPythonNamespace to distinguish runtime internals from user state.
let pristineSnapshot = { modules: [], globals: [] };
const PYODIDE_VERSION = "0.26.4";
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export function isPyodideLoaded() { return !!pyodide; }
export function isPythonRunning() { return isExecuting; }

// Direct access for advanced flows
export function getPyodide() { return pyodide; }

// Stdin buffer queue & active prompt tracking
let stdinQueue = [];
let pendingPrompt = "";

export function queueStdin(input) {
  if (typeof input === "string") {
    stdinQueue.push(input.endsWith("\n") ? input : input + "\n");
  }
}

export function clearStdin() {
  stdinQueue = [];
  pendingPrompt = "";
}

/**
 * Check if code contains interactive input loops (used to provide safe mock inputs in agent mode)
 */
export function isLikelyInteractivePython(code) {
  const source = String(code ?? "").replace(/#.*$/gm, "");
  return /\binput\s*\(/.test(source) || /^\s*while\s+True\s*:/m.test(source);
}

// Write project files into the Pyodide virtual filesystem
export async function syncFilesToPyFS(files) {
  if (!pyodide) await loadPyodideRuntime();
  let entries = [];
  if (files && typeof files.files === "object" && files.files instanceof Map) {
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
    try { pyodide.FS.writeFile(path, f.content); } catch {}
  }
}

// Names of every package currently loaded in the runtime
export function installedPackages() {
  if (!pyodide) return [];
  try {
    const pkgs = new Set(Object.keys(pyodide.loadedPackages ?? {}));
    try {
      const micropipList = pyodide.runPython(`
try:
    import micropip
    list(micropip.list().keys())
except Exception:
    []
`);
      if (micropipList && typeof micropipList.toJs === "function") {
        for (const p of micropipList.toJs()) pkgs.add(p);
      }
    } catch {}
    return [...pkgs].sort();
  } catch { return []; }
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
        script.onerror = () => reject(new Error("Could not download the Pyodide runtime — check your network connection."));
      });
      document.head.appendChild(script);
      await loaded;
      onStatus?.("Booting CPython…");
      pyodide = await globalThis.loadPyodide({ indexURL: INDEX_URL });

      // Setup SharedArrayBuffer interrupt handler if supported
      try {
        if (typeof SharedArrayBuffer !== "undefined") {
          interruptBuffer = new Uint8Array(new SharedArrayBuffer(1));
          pyodide.setInterruptBuffer(interruptBuffer);
        }
      } catch (e) {
        console.warn("[pyodide] SharedArrayBuffer not available for hardware interrupt buffer:", e);
      }

      // Configure default stdout & stderr with batching
      pyodide.setStdout({
        batched: (s) => {
          sink.stdout.push(s);
          activeStreamCallbacks.onStdout?.(s);
        }
      });
      pyodide.setStderr({
        batched: (s) => {
          sink.stderr.push(s);
          activeStreamCallbacks.onStderr?.(s);
        }
      });

      // Default stdin handler: reads from queue without blocking window.prompt modals
      pyodide.setStdin({
        stdin: () => {
          if (activeNonInteractiveMode) {
            mockInputCount++;
            if (mockInputCount > 6) return "\n";
            return "q\n";
          }
          if (stdinQueue.length > 0) {
            return stdinQueue.shift();
          }
          // Return clean newline so Python input() receives input without freezing or opening browser alert popups
          return "\n";
        },
        isatty: true,
      });

      try { window.__pyodide = pyodide; } catch (_) {}

      // Snapshot the pristine interpreter state right after boot, so a later
      // reset knows exactly what to keep. Capturing this lazily at reset time
      // would be wrong — by then the namespace already holds user state.
      // NOTE: this must not use an `import` statement: `import sys, json`
      // would bind those names in __main__, poisoning the keep-list so `sys`
      // survives every reset. `__import__` is a builtin and binds nothing.
      try {
        const modulesSnap = pyodide.runPython("sorted(__import__('sys').modules.keys())");
        const globalsSnap = pyodide.runPython("sorted(dir())");
        pristineSnapshot = {
          modules: [...modulesSnap],
          globals: [...globalsSnap],
        };
        try { modulesSnap.destroy?.(); } catch {}
        try { globalsSnap.destroy?.(); } catch {}
      } catch (e) {
        console.warn("[pyodide] could not snapshot pristine namespace:", e);
      }

      onStatus?.("Python ready.");
      return pyodide;
    })();
    loadingPromise = loadingPromise.catch((e) => { loadingPromise = null; throw e; });
  }
  return loadingPromise;
}


// Shared per-run output sink
const sink = { stdout: [], stderr: [] };
const activeStreamCallbacks = { onStdout: null, onStderr: null };
let activeNonInteractiveMode = false;
let mockInputCount = 0;

/**
 * Stop/interrupt the currently executing Python code
 */
export function stopPython() {
  if (interruptBuffer) {
    interruptBuffer[0] = 2; // SIGINT
  }
  if (currentRunAbort) {
    currentRunAbort.abort("Execution stopped by user");
    currentRunAbort = null;
  }
  isExecuting = false;
}

/**
 * Reset the Python interpreter namespace: drop every user-defined global
 * (variables, functions, classes) and every module imported at runtime, so the
 * next run starts from a clean slate. The runtime itself (stdout/stderr/stdin
 * handlers, interrupt buffer) is left intact, and project files stay synced.
 *
 * Installed packages are NOT uninstalled — their code stays cached — but their
 * modules are evicted from `sys.modules`, so the next `import x` re-executes
 * the module fresh instead of reusing stale state.
 */
export async function resetPythonNamespace() {
  if (!pyodide) return { cleared: [], modules: [] };
  if (isExecuting) stopPython();
  clearStdin();
  try {
    // The keep-lists come from the pristine boot snapshot (JS side), never from
    // the live namespace — snapshotting live state would treat user variables
    // as "keep" and clear nothing.
    pyodide.globals.set("__ws_keep_modules", pyodide.toPy(pristineSnapshot.modules));
    pyodide.globals.set("__ws_keep_globals", pyodide.toPy(pristineSnapshot.globals));
    // NOTE: no `import` statements in this script. An `import sys` here would
    // bind `sys` in __main__ before the clear list is computed, so it would
    // either be wrongly kept (if snapshotted) or wrongly reported as cleared.
    // `__import__` is a builtin and binds nothing.
    const report = await pyodide.runPythonAsync(`
__ws_sys = __import__("sys")
__ws_cleared = [name for name in list(dir())
                if not name.startswith("__")
                and name not in set(__ws_keep_globals)
                and name not in ("__ws_sys", "__ws_keep_modules", "__ws_keep_globals",
                                 "__ws_cleared", "__ws_evicted", "__ws_name")]
for __ws_name in __ws_cleared:
    try:
        del globals()[__ws_name]
    except Exception:
        pass
__ws_evicted = [name for name in list(__ws_sys.modules.keys())
                if name not in set(__ws_keep_modules) and not name.startswith("__ws_")]
for __ws_name in __ws_evicted:
    try:
        del __ws_sys.modules[__ws_name]
    except Exception:
        pass
try:
    __import__("matplotlib.pyplot").close("all")
except Exception:
    pass
for __ws_name in ("__ws_sys",):
    try:
        del globals()[__ws_name]
    except Exception:
        pass
{"cleared": list(__ws_cleared), "modules": list(__ws_evicted)}
`);
    const js = typeof report?.toJs === "function" ? report.toJs({ dict_converter: Object.fromEntries }) : report;
    try { report?.destroy?.(); } catch {}
    return {
      cleared: [...(js?.cleared ?? [])].map(String),
      modules: [...(js?.modules ?? [])].map(String),
    };
  } catch (err) {
    return { cleared: [], modules: [], error: String(err?.message ?? err) };
  }
}

/**
 * Run Python source in Pyodide.
 * @param {string} code Python code to execute
 * @param {object} [options] Execution options
 * @param {boolean} [options.nonInteractive] When true, provides mock inputs for smoke testing
 * @param {Function} [options.onStdout] Realtime stdout callback
 * @param {Function} [options.onStderr] Realtime stderr callback
 * @param {number} [options.timeout] Execution timeout in ms
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, result:string, error?:string, plots:string[]}>}
 */
export async function runPython(code, options = {}) {
  if (!pyodide) await loadPyodideRuntime();
  if (interruptBuffer) interruptBuffer[0] = 0; // Reset interrupt flag

  sink.stdout = [];
  sink.stderr = [];
  const plots = [];
  let result = "";
  let error;

  activeStreamCallbacks.onStdout = options.onStdout || null;
  activeStreamCallbacks.onStderr = options.onStderr || null;
  activeNonInteractiveMode = Boolean(options.nonInteractive);
  mockInputCount = 0;
  isExecuting = true;

  const runCode = String(code ?? "");

  // Automated verification for interactive programs uses syntax checking,
  // import checks, and finite smoke testing.
  if (options.nonInteractive && isLikelyInteractivePython(runCode)) {
    try {
      // 1. Check syntax compilation first
      const filename = "<agent-verify>";
      await pyodide.runPythonAsync(`compile(${JSON.stringify(runCode)}, ${JSON.stringify(filename)}, "exec")`);

      // 2. Run with safe bounded mock execution
      const wrappedVerify = `
import sys, io
__ws_old_stdin = sys.stdin
sys.stdin = io.StringIO("\\n")
try:
    exec(${JSON.stringify(runCode)}, {})
except SystemExit:
    pass
except (KeyboardInterrupt, EOFError):
    pass
finally:
    sys.stdin = __ws_old_stdin
`;
      try {
        await pyodide.loadPackagesFromImports(runCode);
      } catch {}

      try {
        await pyodide.runPythonAsync(wrappedVerify);
      } catch (runErr) {
        // Input exhaustion or normal termination does not indicate a failure.
        const msg = String(runErr?.message || runErr);
        if (!msg.includes("EOFError") && !msg.includes("SystemExit") && !msg.includes("KeyboardInterrupt")) {
          // If there was a genuine NameError / SyntaxError / TypeError, report it
          error = msg;
        }
      }
      result = "Syntax and smoke test verified successfully.";
    } catch (syntaxErr) {
      error = String(syntaxErr?.message || syntaxErr);
    }

    isExecuting = false;
    await drainPlots(plots);

    return {
      ok: !error,
      stdout: sink.stdout.join("\n"),
      stderr: sink.stderr.join("\n"),
      result: result || (error ? "" : "Verified"),
      error,
      plots,
    };
  }

  // Standard interactive user execution
  try {
    try { await pyodide.loadPackagesFromImports(runCode); } catch {}
    const res = await pyodide.runPythonAsync(runCode);
    if (res !== undefined && res !== null) {
      try { result = res.toString(); } catch { result = String(res); }
    }
  } catch (err) {
    error = String(err?.message ?? err);
  } finally {
    isExecuting = false;
    activeStreamCallbacks.onStdout = null;
    activeStreamCallbacks.onStderr = null;
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
// Collect open matplotlib figures as base64 PNGs
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
  } catch {}
}

/**
 * Install a package at runtime via micropip / PyPI wheels
 */
export async function installPackage(name, { onStatus } = {}) {
  if (!pyodide) await loadPyodideRuntime({ onStatus });
  const pkgName = String(name || "").trim();
  if (!pkgName) return { ok: false, error: "Package name required" };

  onStatus?.(`Installing ${pkgName}…`);
  try {
    // Try bundled Pyodide distribution first
    await pyodide.loadPackage(pkgName);
    onStatus?.(`${pkgName} installed.`);
    return { ok: true, output: `Package ${pkgName} installed successfully.` };
  } catch {
    // Fall back to micropip
    try {
      await pyodide.loadPackage("micropip");
      const micropip = pyodide.pyimport("micropip");
      await micropip.install(pkgName);
      onStatus?.(`${pkgName} installed from PyPI.`);
      return { ok: true, output: `Package ${pkgName} installed from PyPI.` };
    } catch (e) {
      const msg = String(e?.message || e);
      onStatus?.(`Failed to install ${pkgName}: ${msg}`);
      return { ok: false, error: `Installation failed: ${msg}` };
    }
  }
}
