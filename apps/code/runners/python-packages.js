// Bundled (offline) Python packages for the Code app.
//
// `tools/vendor-python-packages.mjs` downloads a curated set of pure-Python
// wheels (tagged `py3-none-any`) plus their dependency closures into
// `vendor/python-packages/`, and writes a `manifest.json` describing them.
// This module exposes that bundle to the UI and installs from it with micropip,
// so those packages work with no network connection at all.
//
// Anything not in the bundle still installs from PyPI as before.

import { getPyodide, loadPyodideRuntime, installedPackages } from "./pyodide-runner.js";

const MANIFEST_URL = new URL("../../../vendor/python-packages/manifest.json", import.meta.url);
const WHEEL_BASE_URL = new URL("../../../vendor/python-packages/", import.meta.url);

let manifestPromise = null;
let manifest = null;

function normalizeName(name) {
  return String(name || "").trim().toLowerCase().replace(/[-_.]+/g, "-");
}

/** Load (and cache) the bundled-package manifest. Resolves to null when absent. */
export function loadBundledManifest() {
  if (manifest) return Promise.resolve(manifest);
  if (!manifestPromise) {
    manifestPromise = (async () => {
      try {
        const res = await fetch(MANIFEST_URL, { cache: "no-cache" });
        if (!res.ok) return null;
        const data = await res.json();
        manifest = {
          generatedAt: data.generatedAt ?? null,
          packages: Array.isArray(data.packages) ? data.packages : [],
          unavailable: data.unavailable && typeof data.unavailable === "object" ? data.unavailable : {},
        };
        return manifest;
      } catch {
        return null;
      } finally {
        // Allow a later retry if the first attempt failed before caching.
        if (!manifest) manifestPromise = null;
      }
    })();
  }
  return manifestPromise;
}

/** Curated top-level packages available offline, for the Packages dialog. */
export async function bundledPackages() {
  const m = await loadBundledManifest();
  if (!m) return { packages: [], unavailable: {}, generatedAt: null };
  return {
    packages: m.packages.filter(p => p.top),
    unavailable: m.unavailable,
    generatedAt: m.generatedAt,
  };
}

export async function isBundled(name) {
  const m = await loadBundledManifest();
  if (!m) return false;
  const key = normalizeName(name);
  return m.packages.some(p => p.key === key || normalizeName(p.name) === key);
}

// Order the requested package's bundled closure dependencies-first, so every
// requirement is already satisfied by the time micropip reaches its dependant.
// That keeps a bundled install completely offline even for packages with deps.
async function closureFor(name) {
  const m = await loadBundledManifest();
  if (!m) return [];
  const key = normalizeName(name);
  const byKey = new Map(m.packages.map(p => [p.key, p]));
  const root = byKey.get(key) ?? m.packages.find(p => normalizeName(p.name) === key);
  if (!root) return [];

  const ordered = [];
  const state = new Map(); // key -> "visiting" | "done"
  const visit = (pkg) => {
    if (!pkg) return;
    const mark = state.get(pkg.key);
    if (mark === "done" || mark === "visiting") return; // visiting ⇒ cycle, stop
    state.set(pkg.key, "visiting");
    for (const dep of pkg.requires ?? []) {
      visit(byKey.get(normalizeName(dep)));
    }
    state.set(pkg.key, "done");
    ordered.push(pkg);
  };
  visit(root);
  return ordered;
}

function wheelUrls(packages) {
  return packages.map(p => new URL(p.file, WHEEL_BASE_URL).href);
}

// Distribution name → importable module name(s), for the packages we expect to
// come from the Pyodide distribution rather than the bundle.
const IMPORT_ALIASES = {
  "scikit-learn": "sklearn",
  "pillow": "PIL",
  "opencv-python": "cv2",
  "pyyaml": "yaml",
  "beautifulsoup4": "bs4",
  "python-dateutil": "dateutil",
  "typing-extensions": "typing_extensions",
};

function importNameCandidates(distName) {
  const key = normalizeName(distName);
  const names = new Set([key.replace(/-/g, "_"), key]);
  if (IMPORT_ALIASES[key]) names.add(IMPORT_ALIASES[key]);
  return [...names];
}

function moduleIsImportable(py, pyName) {
  try {
    py.runPython("import importlib.util");
    return Boolean(py.runPython(`importlib.util.find_spec(${JSON.stringify(pyName)}) is not None`));
  } catch {
    return false;
  }
}

/**
 * Bundled packages often depend on binary/scientific packages that Pyodide ships
 * itself (numpy, pandas, matplotlib, scipy, scikit-learn, …). Those are loaded
 * from the Pyodide distribution instead of being vendored. Failures are reported
 * rather than thrown, so a missing optional dependency never blocks the install.
 */
async function loadExternalRequires(closure, { onStatus } = {}) {
  const m = await loadBundledManifest();
  const bundledKeys = new Set((m?.packages ?? []).map(p => p.key));
  const external = new Set();
  for (const pkg of closure) {
    for (const dep of pkg.externalRequires ?? []) {
      const key = normalizeName(dep);
      if (key && !bundledKeys.has(key)) external.add(key);
    }
  }
  if (external.size === 0) return { loaded: [], missing: [] };

  const py = getPyodide();
  const loaded = [];
  const missing = [];
  for (const dep of external) {
    if (importNameCandidates(dep).some(name => moduleIsImportable(py, name))) continue;
    onStatus?.(`Loading ${dep} from the Pyodide distribution…`);
    let ok = false;
    try {
      await py.loadPackage(dep);
      ok = true;
    } catch { /* name may differ in Pyodide's repodata — try via imports */ }
    if (!ok) {
      for (const candidate of importNameCandidates(dep)) {
        try {
          await py.loadPackagesFromImports(`import ${candidate}`);
          ok = true;
          break;
        } catch { /* keep trying */ }
      }
    }
    if (ok) loaded.push(dep);
    else missing.push(dep);
  }
  return { loaded, missing };
}

/**
 * Install a bundled package (plus its bundled dependencies) from the vendored
 * wheels — no network required for the wheels themselves. Dependencies that live
 * in the Pyodide distribution (numpy/pandas/matplotlib/…) are loaded from there.
 * Returns {ok, error?, packages?, loadedDeps?, missingDeps?}.
 */
export async function installBundledPackage(name, { onStatus } = {}) {
  const closure = await closureFor(name);
  if (closure.length === 0) {
    return { ok: false, error: `"${name}" is not in the offline bundle` };
  }
  onStatus?.(`Installing ${name} from the offline bundle…`);
  try {
    await loadPyodideRuntime({ onStatus });
    const py = getPyodide();
    await py.loadPackage("micropip");
    const urls = wheelUrls(closure);
    // deps=False: the wheel closure above already contains every requirement.
    // (micropip before 0.5 has no `deps` kwarg — fall back to the default.)
    const installer = py.runPython(`
import micropip

async def __ws_install_bundled(urls, skip_deps=True):
    try:
        await micropip.install(list(urls), deps=(not skip_deps))
    except TypeError:
        await micropip.install(list(urls))
__ws_install_bundled
`);
    await installer(urls, true);
    try { installer.destroy?.(); } catch {}
    const { loaded, missing } = await loadExternalRequires(closure, { onStatus });
    onStatus?.(`${name} installed from the offline bundle.`);
    return {
      ok: true,
      packages: closure.map(p => p.name),
      loadedDeps: loaded,
      missingDeps: missing,
      offline: true,
    };
  } catch (err) {
    const msg = String(err?.message || err);
    onStatus?.(`Bundled install failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

// Binary/scientific packages that Pyodide ships and bundled packages build on.
// They cannot be vendored (no pure-Python wheel), so they are cached instead:
// loading them once populates the service worker cache and they then work offline.
// (pyarrow is intentionally absent — Pyodide 0.26 does not ship it.)
export const SCIENTIFIC_STACK = [
  "numpy", "pandas", "matplotlib", "scipy", "scikit-learn", "sympy",
];

/**
 * Load the scientific stack so it is cached for offline use. `loadPackage` goes
 * through the service worker, which caches the Pyodide CDN cache-first.
 */
export async function prepareOfflineStack({ onStatus, packages = SCIENTIFIC_STACK } = {}) {
  await loadPyodideRuntime({ onStatus });
  const py = getPyodide();
  await py.loadPackage("micropip");
  const loaded = [];
  const failed = [];
  for (const name of packages) {
    onStatus?.(`Caching ${name}…`);
    try {
      await py.loadPackage(name);
      loaded.push(name);
    } catch {
      failed.push(name);
    }
  }
  return { loaded, failed };
}

/**
 * Install a package by name, preferring the offline bundle and falling back to
 * PyPI via micropip. Used by the Packages dialog and by "install this import"
 * flows so a cached/vendored package wins over a network round-trip.
 */
export async function installPackagePreferred(name, { onStatus, preferBundled = true } = {}) {
  const pkgName = String(name || "").trim();
  if (!pkgName) return { ok: false, error: "Package name required" };

  if (preferBundled && await isBundled(pkgName)) {
    const res = await installBundledPackage(pkgName, { onStatus });
    if (res.ok) return res;
    onStatus?.(`Offline bundle failed for ${pkgName} — trying PyPI…`);
  }

  // Pyodide distribution first, then PyPI (micropip).
  await loadPyodideRuntime({ onStatus });
  const py = getPyodide();
  onStatus?.(`Installing ${pkgName}…`);
  try {
    await py.loadPackage(pkgName);
    return { ok: true, output: `${pkgName} loaded from the Pyodide distribution.` };
  } catch { /* not a Pyodide package — fall through */ }
  try {
    await py.loadPackage("micropip");
    const micropip = py.pyimport("micropip");
    await micropip.install(pkgName);
    onStatus?.(`${pkgName} installed from PyPI.`);
    return { ok: true, output: `${pkgName} installed from PyPI.` };
  } catch (e) {
    const msg = String(e?.message || e);
    return { ok: false, error: `Installation failed: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Offline imports
// ---------------------------------------------------------------------------

/**
 * Top-level module names referenced by `import x` / `from x import y`.
 * Deliberately a light scan — it only needs to recognise bundled packages so
 * their wheels can be installed before the script runs.
 */
export function importedModules(code) {
  const found = new Set();
  const source = String(code ?? "").replace(/#.*$/gm, "");
  for (const line of source.split("\n")) {
    const m = /^[ \t]*(?:from[ \t]+([A-Za-z_][\w.]*)[ \t]+import|import[ \t]+(.+))/.exec(line);
    if (!m) continue;
    if (m[1]) {
      found.add(m[1].split(".")[0]);
      continue;
    }
    for (const part of m[2].split(",")) {
      const name = part.trim().split(/[ \t]+as[ \t]+/)[0].trim().split(".")[0];
      if (/^[A-Za-z_]\w*$/.test(name)) found.add(name);
    }
  }
  return found;
}

/**
 * Install any bundled package that the given source imports and that is not yet
 * available, so running a script that uses e.g. `rich` works with no network.
 * Returns the list of package names installed from the bundle.
 */
export async function ensureBundledImports(code, { onStatus } = {}) {
  const m = await loadBundledManifest();
  if (!m || m.packages.length === 0) return [];
  const byImport = new Map();
  for (const pkg of m.packages) {
    for (const imp of pkg.imports ?? []) byImport.set(String(imp).toLowerCase(), pkg);
  }

  const py = getPyodide();
  if (!py) return [];

  const already = new Set(installedPackages().map(normalizeName));
  const wanted = [];
  for (const imp of importedModules(code)) {
    const pkg = byImport.get(imp.toLowerCase());
    if (!pkg || already.has(normalizeName(pkg.key))) continue;
    if (!wanted.some(p => p.key === pkg.key)) wanted.push(pkg);
  }

  const installed = [];
  for (const pkg of wanted) {
    // A module already importable is built into Pyodide — no install needed.
    let present = false;
    try {
      py.runPython("import importlib.util");
      present = Boolean(py.runPython(`importlib.util.find_spec(${JSON.stringify(pkg.imports?.[0] || pkg.key)}) is not None`));
    } catch { present = false; }
    if (present) continue;
    const res = await installBundledPackage(pkg.name, { onStatus });
    if (res.ok) installed.push(pkg.name);
  }
  return installed;
}
