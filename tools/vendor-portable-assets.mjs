// tools/vendor-portable-assets.mjs — fetch the runtime files the portable build
// needs to work with no network at all.
//
// Three groups:
//   1. Pyodide core            → vendor/pyodide/   (pyodide.js, pyodide.asm.js,
//      pyodide.asm.wasm, python_stdlib.zip, pyodide-lock.json)
//   2. Pyodide binary packages → vendor/pyodide/packages/  (opt-in, --with-scientific)
//      numpy/pandas/matplotlib/scipy/scikit-learn/sympy and their dependency
//      closures, resolved from the lock file so nothing is missed.
//   3. Document parsers        → vendor/parser/    (pdf.js + mammoth UMD builds,
//      copied from node_modules so their versions match package.json)
//
// Usage:
//   node tools/vendor-portable-assets.mjs                  # core + parsers
//   node tools/vendor-portable-assets.mjs --with-scientific # + the DS stack (~200 MB)
//   node tools/vendor-portable-assets.mjs --force           # re-download everything
//
// The pure-Python wheel bundle (`vendor/python-packages/`) is produced separately by
// `npm run vendor:python`; the portable assembler copies it as-is.

import { mkdir, writeFile, readFile, access, copyFile, stat } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PYODIDE_DIR = resolve(ROOT, "vendor/pyodide");
const PARSER_DIR = resolve(ROOT, "vendor/parser");

const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");
const WITH_SCIENTIFIC = args.has("--with-scientific");

/** Keep the vendored runtime in lockstep with the loader by reading its constant. */
async function pyodideVersion() {
  const src = await readFile(resolve(ROOT, "apps/code/runners/pyodide-runner.js"), "utf8");
  const m = /PYODIDE_VERSION\s*=\s*["']([^"']+)["']/.exec(src);
  if (!m) throw new Error("Could not read PYODIDE_VERSION from pyodide-runner.js");
  return m[1];
}

const SCIENTIFIC_ROOT_PACKAGES = [
  "numpy", "pandas", "matplotlib", "scipy", "scikit-learn", "sympy",
];
// Pure-Python wheels are already shipped by vendor/python-packages; these are the
// binary ones Pyodide builds itself, which have no pure wheel to vendor.
const CORE_FILES = [
  "pyodide.js",
  "pyodide.mjs",
  "pyodide.asm.js",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function human(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

async function download(url, dest, { force = FORCE } = {}) {
  if (!force && await exists(dest)) {
    const info = await stat(dest);
    if (info.size > 0) return { skipped: true, bytes: info.size };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return { skipped: false, bytes: buf.byteLength };
}

// --- 1 + 2: Pyodide ----------------------------------------------------------

async function vendorPyodide() {
  const version = await pyodideVersion();
  const base = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;
  console.log(`\nPyodide ${version}`);
  await mkdir(PYODIDE_DIR, { recursive: true });

  let coreBytes = 0;
  for (const file of CORE_FILES) {
    const result = await download(base + file, join(PYODIDE_DIR, file));
    coreBytes += result.bytes;
    console.log(`  ${result.skipped ? "·" : "+"} ${file}  (${human(result.bytes)})`);
  }

  const lock = JSON.parse(await readFile(join(PYODIDE_DIR, "pyodide-lock.json"), "utf8"));
  const packages = lock.packages ?? {};

  // Resolve the transitive closure over Pyodide's own dependency metadata so a
  // partial download can never happen (e.g. pandas pulling python-dateutil+pytz).
  const wanted = new Set();
  const visit = (name) => {
    if (wanted.has(name) || !packages[name]) return;
    wanted.add(name);
    for (const dep of packages[name].depends ?? []) visit(dep);
  };
  if (WITH_SCIENTIFIC) for (const name of SCIENTIFIC_ROOT_PACKAGES) visit(name);

  const pkgDir = join(PYODIDE_DIR, "packages");
  let pkgBytes = 0;
  const pkgFiles = [];

  if (WITH_SCIENTIFIC) {
    console.log(`\nPyodide binary packages (${wanted.size} resolved from the lock file)`);
    for (const name of [...wanted].sort()) {
      const entry = packages[name];
      if (!entry?.file_name) continue;
      const dest = join(pkgDir, entry.file_name);
      const result = await download(base + entry.file_name, dest);
      pkgBytes += result.bytes;
      pkgFiles.push(entry.file_name);
      console.log(`  ${result.skipped ? "·" : "+"} ${name.padEnd(22)} ${entry.file_name}  (${human(result.bytes)})`);
    }
  } else {
    console.log("\nPyodide binary packages: skipped (pass --with-scientific to include the DS stack)");
  }

  return { version, coreBytes, pkgBytes, pkgCount: pkgFiles.length, pkgFiles };
}

// --- 3: document parsers -----------------------------------------------------

/** Copy a UMD build out of node_modules, so the version always matches package.json. */
async function vendorParsers() {
  const sources = [
    { from: "node_modules/pdfjs-dist/build/pdf.min.js", to: "pdf.min.js" },
    { from: "node_modules/pdfjs-dist/build/pdf.worker.min.js", to: "pdf.worker.min.js" },
    { from: "node_modules/mammoth/mammoth.browser.min.js", to: "mammoth.browser.min.js" },
  ];
  console.log("\nDocument parsers (from node_modules)");
  await mkdir(PARSER_DIR, { recursive: true });
  const files = [];
  let bytes = 0;
  for (const { from, to } of sources) {
    const src = resolve(ROOT, from);
    if (!await exists(src)) {
      throw new Error(`Missing ${from} — run \`npm install\` first.`);
    }
    const dest = join(PARSER_DIR, to);
    if (FORCE || !await exists(dest)) await copyFile(src, dest);
    const info = await stat(dest);
    bytes += info.size;
    files.push(to);
    console.log(`  ${to}  (${human(info.size)})`);
  }
  return { files, bytes };
}

// --- manifest ----------------------------------------------------------------

async function writeManifest({ pyodide, parsers }) {
  const manifest = {
    note: "Generated by tools/vendor-portable-assets.mjs — runtime files for the portable build.",
    generatedAt: new Date().toISOString(),
    pyodide: {
      version: pyodide.version,
      coreBytes: pyodide.coreBytes,
      packageBytes: pyodide.pkgBytes,
      packages: pyodide.pkgFiles,
      license: "MPL-2.0 (Pyodide); CPython is PSF-2.0",
      source: `https://cdn.jsdelivr.net/pyodide/v${pyodide.version}/full/`,
    },
    parsers: {
      files: parsers.files,
      bytes: parsers.bytes,
      licenses: {
        "pdf.min.js": "Apache-2.0 (pdf.js)",
        "pdf.worker.min.js": "Apache-2.0 (pdf.js)",
        "mammoth.browser.min.js": "BSD-2-Clause (mammoth.js)",
      },
    },
  };
  await writeFile(resolve(ROOT, "vendor/portable-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

// --- main --------------------------------------------------------------------

const pyodide = await vendorPyodide();
const parsers = await vendorParsers();
const manifest = await writeManifest({ pyodide, parsers });

console.log("\n────────────────────────────────────────────────────────────");
console.log(`  Pyodide core        ${human(manifest.pyodide.coreBytes)}`);
console.log(`  Pyodide packages    ${human(manifest.pyodide.packageBytes)} (${manifest.pyodide.packages.length} wheels)`);
console.log(`  Parsers             ${human(manifest.parsers.bytes)}`);
console.log(`  Manifest            vendor/portable-manifest.json`);
console.log(WITH_SCIENTIFIC
  ? "  Ready: fully offline, including the scientific stack."
  : "  Ready: fully offline for text/vision/parsers + pure-Python packages.\n" +
    "  Pass --with-scientific to also run numpy/pandas/matplotlib/scipy/scikit-learn/sympy offline.");
