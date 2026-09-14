// tools/vendor-python-packages.mjs — vendor pure-Python wheels for offline use.
//
// The Code app runs CPython in the browser via Pyodide. Pyodide ships the big
// scientific stack (numpy/pandas/matplotlib/…) from its own CDN, but anything
// else is normally installed from PyPI by micropip — which needs a network
// connection. This script pre-downloads a curated set of *pure-Python* packages
// (wheels tagged `py3-none-any`, so they run unchanged in the WASM runtime) plus
// their transitive pure-Python dependencies into `vendor/python-packages/`, and
// writes `manifest.json` for the Packages dialog in the Code app.
//
// Usage:
//   node tools/vendor-python-packages.mjs            # add missing wheels
//   node tools/vendor-python-packages.mjs --force    # re-download everything
//   node tools/vendor-python-packages.mjs --list     # show the curated set
//   node tools/vendor-python-packages.mjs --only rich,tabulate
//
// Wheels are immutable and content-addressed by filename, so re-running is cheap
// and safe: existing files are kept unless --force is passed.

import { execFile } from "node:child_process";
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = join(ROOT, "vendor", "python-packages");

// Target interpreter inside Pyodide (CPython 3.12 compiled to WASM).
const TARGET = {
  python_version: "3.12",
  python_full_version: "3.12.1",
  sys_platform: "emscripten",
  platform_system: "Emscripten",
  os_name: "posix",
  platform_machine: "wasm32",
};

// Per-wheel size ceiling — keeps the bundle reasonable and flags surprises.
const MAX_WHEEL_BYTES = 8 * 1024 * 1024;

// Packages already provided by the Pyodide distribution. Vendoring our own copy
// would be wasteful, so dependency resolution stops when it reaches one of these
// (they load from the Pyodide CDN, which the service worker caches). Only
// heavyweight/binary builds belong here — anything pure and small is cheaper to
// vendor than to depend on a network fetch.
const PYODIDE_PROVIDED = new Set([
  "numpy", "scipy", "pandas", "matplotlib", "sympy", "scikit-learn",
  "scikit-image", "pillow", "opencv-python", "statsmodels", "pyarrow",
  "sqlalchemy", "tiktoken", "lxml", "pytest",
]);

// Curated top-level packages: popular, genuinely useful, and *pure Python* so the
// same wheel runs in the browser. C-extension packages are deliberately absent —
// Pyodide provides its own builds of those.
const CURATED = [
  { name: "rich", desc: "Beautiful terminal text, tables, progress and syntax highlighting" },
  { name: "tabulate", desc: "Pretty-print tabular data as plain-text tables" },
  { name: "tqdm", desc: "Fast, extensible progress bars" },
  { name: "python-dateutil", desc: "Powerful date parsing, arithmetic and recurrence rules" },
  { name: "pytz", desc: "World timezone definitions (IANA database)" },
  { name: "packaging", desc: "Version parsing, specifiers and dependency utilities" },
  { name: "attrs", desc: "Classes without boilerplate — declarative attributes" },
  { name: "more-itertools", desc: "Extra building blocks for iterators" },
  { name: "toolz", desc: "Functional utilities for iterators, functions and dicts" },
  { name: "beautifulsoup4", desc: "Screen-scrape and parse HTML/XML (bs4)" },
  { name: "networkx", desc: "Create, manipulate and study graphs and networks" },
  { name: "pyparsing", desc: "Recursive-descent parsing made readable" },
  { name: "Pygments", desc: "Syntax highlighting for 500+ languages" },
  { name: "chardet", desc: "Detect character encodings in byte streams" },
  { name: "openpyxl", desc: "Read and write Excel 2010+ .xlsx files" },
  { name: "markdown", desc: "Convert Markdown to HTML" },
  { name: "texttable", desc: "Simple ASCII tables for terminals" },
  { name: "humanize", desc: "Human-readable dates, file sizes and numbers" },
  { name: "xmltodict", desc: "Work with XML as if it were JSON" },
  { name: "six", desc: "Python 2/3 compatibility helpers (still a common dependency)" },
  { name: "pyyaml", desc: "YAML parser and emitter (pure-Python build)" },

  // ---- Data science / analysis ----
  { name: "seaborn", desc: "Statistical data visualization built on matplotlib" },
  { name: "mlxtend", desc: "ML extensions: frequent patterns, association rules, stacking" },
  { name: "imbalanced-learn", desc: "Resampling for imbalanced classification datasets" },
  { name: "yellowbrick", desc: "Visual diagnostics for machine-learning models" },
  { name: "pingouin", desc: "Statistical tests with effect sizes and power (t-test, ANOVA, …)" },
  { name: "faker", desc: "Generate fake datasets — names, addresses, dates, text" },
  { name: "arrow", desc: "Human-friendly dates and times for time-series work" },
  { name: "numpy-financial", desc: "Financial maths: NPV, IRR, PMT and amortization" },
  { name: "prettytable", desc: "Print attractive ASCII tables for reports" },
  { name: "xlsxwriter", desc: "Write formatted .xlsx spreadsheets and charts" },
  { name: "natsort", desc: "Natural sort order for version/label strings" },
  { name: "glom", desc: "Declarative access and transformation of nested data" },
  { name: "petl", desc: "Lightweight ETL over tabular data" },
  { name: "tzdata", desc: "IANA timezone database for offline timezone handling" },
];

function normalizeName(name) {
  return String(name || "").trim().toLowerCase().replace(/[-_.]+/g, "-");
}

// A wheel is "pure" when tagged `py3-none-any` (or the dual-tag `py2.py3-none-any`),
// i.e. no compiled extensions and no build for a specific interpreter/platform.
function isPureWheel(filename) {
  return /-py[23](?:\.py[23])?-none-any\.whl$/i.test(filename);
}

function wheelNameFromUrl(url) {
  return decodeURIComponent(String(url).split("/").pop().split("#")[0]);
}

// ---------------------------------------------------------------------------
// Minimal PEP 508 environment-marker evaluation.
// Anything we cannot confidently evaluate is treated as *true* (better to vendor
// a harmless extra wheel than to break an offline install).
// ---------------------------------------------------------------------------
function splitTopLevel(text, op) {
  const parts = [];
  let depth = 0, current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && text.slice(i, i + op.length) === op) {
      parts.push(current);
      current = "";
      i += op.length - 1;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map(p => p.trim()).filter(Boolean);
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function evalMarker(marker) {
  let text = String(marker || "").trim();
  if (!text) return true;
  // Extras are never installed implicitly.
  if (/\bextra\s*==/.test(text)) return false;
  // Strip redundant parentheses.
  while (text.startsWith("(") && text.endsWith(")")) {
    const inner = text.slice(1, -1);
    if (splitTopLevel(inner, " and ").length + splitTopLevel(inner, " or ").length === 2) { text = inner.trim(); }
    else break;
  }
  const orParts = splitTopLevel(text, " or ");
  if (orParts.length > 1) return orParts.some(evalMarker);
  const andParts = splitTopLevel(text, " and ");
  if (andParts.length > 1) return andParts.every(evalMarker);

  const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(===|==|!=|<=|>=|<|>)\s*["']([^"']*)["']$/.exec(text.trim());
  if (!m) return true; // unknown shape → keep the dependency
  const [, key, op, raw] = m;
  const value = TARGET[key] ?? "";
  const isVersion = key === "python_version" || key === "python_full_version";
  const cmp = isVersion ? compareVersions(value, raw) : (value < raw ? -1 : value > raw ? 1 : 0);
  switch (op) {
    case "==": return cmp === 0;
    case "!=": return cmp !== 0;
    case "<": return cmp < 0;
    case "<=": return cmp <= 0;
    case ">": return cmp > 0;
    case ">=": return cmp >= 0;
    case "===": return String(value) === String(raw);
    default: return true;
  }
}

// Parse a Requires-Dist line down to a bare, normalized package name.
function depNameFromRequires(line) {
  const [req, marker] = String(line).split(";");
  if (!evalMarker(marker)) return null;
  const name = req.split(/[\s(<>=!~;\[]/)[0].trim();
  return name ? normalizeName(name) : null;
}

// ---------------------------------------------------------------------------
// PyPI access
// ---------------------------------------------------------------------------
async function fetchJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "gemma4-workstation-vendor" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function resolvePackage(name) {
  const meta = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  const info = meta.info ?? {};
  const version = info.version;
  const files = meta.urls ?? [];
  const wheel = files.find(f => isPureWheel(f.filename)) ||
                files.find(f => f.packagetype === "bdist_wheel" && isPureWheel(f.filename));
  if (!wheel) {
    return { skipped: `no pure-Python (py3-none-any) wheel published for ${name} ${version}` };
  }
  return {
    name: normalizeName(info.name || name),
    displayName: info.name || name,
    version,
    summary: info.summary || "",
    requiresDist: info.requires_dist ?? [],
    // PyPI metadata is the fallback for wheels that ship no license field.
    pypiLicense: info.license || "",
    pypiLicenseClassifiers: (info.classifiers ?? [])
      .filter(c => /^License\s*::/i.test(c))
      .map(c => c.replace(/^License\s*::\s*/i, "").trim()),
    url: wheel.url,
    file: wheelNameFromUrl(wheel.url),
    size: wheel.size ?? 0,
  };
}

async function readWheelMetadata(path) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", path, "*.dist-info/METADATA"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

// Best-effort license identification from wheel metadata, with the PyPI JSON
// metadata as a fallback for wheels that omit the field. Prefers an SPDX
// expression, then OSI classifiers, then a truncated free-text License field.
function licenseFor(metadataText, rec = {}, hint = null) {
  const lines = String(metadataText || "").split("\n");
  const field = (name) => {
    const hit = lines.find(l => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
    return hit ? hit.slice(hit.indexOf(":") + 1).trim() : "";
  };
  const short = (text) => {
    const firstLine = String(text || "").split("\n")[0].trim();
    if (!firstLine) return "";
    return firstLine.length > 60 ? "" : firstLine;
  };

  const expression = field("License-Expression");
  if (expression) return expression;

  const wheelClassifiers = lines
    .filter(l => /^Classifier:\s*License\s*::/i.test(l))
    .map(l => l.replace(/^Classifier:\s*License\s*::\s*/i, "").trim());
  if (wheelClassifiers.length) return wheelClassifiers.join(", ");

  if ((rec.pypiLicenseClassifiers ?? []).length) return rec.pypiLicenseClassifiers.join(", ");
  const shortField = short(field("License")) || short(rec.pypiLicense);
  if (shortField) return shortField;

  // Nothing declared — fall back to the license file shipped inside the wheel.
  if (hint?.family) return hint.family;
  if (hint?.file) return `see ${hint.file} in wheel`;
  return "see wheel metadata";
}

// Recognize a license family from the text of a LICENSE file shipped in a wheel.
function detectLicenseFamily(text) {
  const t = String(text || "");
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(t)) return "AGPL-3.0";
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(t)) return "LGPL";
  if (/GNU GENERAL PUBLIC LICENSE\s*(?:Version|v\.?)\s*3/i.test(t)) return "GPL-3.0";
  if (/GNU GENERAL PUBLIC LICENSE\s*(?:Version|v\.?)\s*2/i.test(t)) return "GPL-2.0";
  if (/Mozilla Public License,?\s*(?:v\.?|Version)?\s*2/i.test(t)) return "MPL-2.0";
  if (/Apache License,?\s*(?:Version)?\s*2\.0/i.test(t)) return "Apache-2.0";
  if (/Permission is hereby granted, free of charge/i.test(t)) return "MIT";
  if (/Redistribution and use in source and binary forms/i.test(t)) {
    return /neither the name/i.test(t) ? "BSD-3-Clause" : "BSD-2-Clause";
  }
  if (/THE SOFTWARE IS PROVIDED "AS IS"/i.test(t)) return "MIT";
  if (/This is free and unencumbered software released into the public domain/i.test(t)) return "Unlicense";
  if (/BSD Zero Clause|0BSD/i.test(t)) return "0BSD";
  return "";
}

// Last-resort license identification: read the license file the wheel ships.
// `License-File:` paths are relative to the `.dist-info` directory (or the
// archive root), so each declared name is also tried as a glob, and any
// LICENSE/COPYING entry is scanned as a final fallback.
async function readWheelLicenseHint(path, metadataText) {
  const declared = [...String(metadataText || "").matchAll(/^License-File:\s*(.+)$/gim)]
    .map(m => m[1].trim())
    .filter(Boolean);

  const tryRead = async (pattern) => {
    try {
      const { stdout } = await execFileAsync("unzip", ["-p", path, pattern], { maxBuffer: 2 * 1024 * 1024 });
      const family = detectLicenseFamily(stdout);
      return family ? { family, file: pattern } : null;
    } catch {
      return null;
    }
  };

  for (const name of declared) {
    for (const pattern of [name, `*/${name}`, `*${name}`]) {
      const hit = await tryRead(pattern);
      if (hit) return hit;
    }
  }

  let entries = [];
  try {
    const { stdout } = await execFileAsync("unzip", ["-Z1", path], { maxBuffer: 32 * 1024 * 1024 });
    entries = stdout
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => /(^|\/)(LICEN[CS]E|COPYING)(\.[A-Za-z0-9]+)?$/i.test(l));
  } catch { /* unreadable wheel — nothing to add */ }

  for (const entry of entries.slice(0, 4)) {
    const hit = await tryRead(entry);
    if (hit) return hit;
  }
  if (declared.length) return { family: "", file: declared[0] };
  return entries.length ? { family: "", file: entries[0] } : null;
}

// Importable top-level module names for a wheel. Distribution names and import
// names often differ (`beautifulsoup4` → `bs4`, `markdown-it-py` → `markdown_it`),
// and the app needs the import names to satisfy `import x` offline.
async function readWheelTopLevel(path) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", path, "*.dist-info/top_level.txt"], {
      maxBuffer: 1 * 1024 * 1024,
    });
    const names = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (names.length) return [...new Set(names)];
  } catch { /* many wheels have no top_level.txt */ }
  try {
    const { stdout } = await execFileAsync("unzip", ["-Z1", path], { maxBuffer: 32 * 1024 * 1024 });
    const names = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry || entry.includes(".dist-info/") || entry.includes(".data/")) continue;
      const top = entry.split("/")[0];
      if (!top) continue;
      if (top.endsWith(".py")) names.add(top.slice(0, -3));
      else if (!top.includes(".")) names.add(top);
    }
    return [...names];
  } catch {
    return [];
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return buf.length;
}

// ---------------------------------------------------------------------------
// Attribution index (release/legal hygiene)
// ---------------------------------------------------------------------------

async function writeLicenceIndex(entries) {
  const rows = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  const curated = rows.filter(e => e.top);
  const deps = rows.filter(e => !e.top);
  const table = (list) => [
    "| Package | Version | License |",
    "| --- | --- | --- |",
    ...list.map(e => `| ${e.name} | ${e.version} | ${e.license || "see wheel metadata"} |`),
  ].join("\n");

  // Redistribution-relevant licenses deserve a callout rather than a table row.
  const copyleft = rows.filter(e => /GPL|AGPL|LGPL|MPL|EUPL|CC-BY-SA/i.test(e.license || ""));
  const copyleftNote = copyleft.length
    ? `\n## ⚠️ Copyleft packages\n\n${copyleft.length} bundled package${copyleft.length === 1 ? " is" : "s are"} under a copyleft license. They are redistributed **unmodified** as separate works (the app only imports them at runtime), and each keeps its own license terms:\n\n` +
      table(copyleft) +
      `\n\nIf your distribution policy excludes copyleft dependencies, remove ${copyleft.map(e => `\`${e.key}\``).join(", ")} from \`CURATED\` in \`tools/vendor-python-packages.mjs\` and re-run the script.\n`
    : "";

  const body = `# Vendored Python packages — licenses

Generated by \`tools/vendor-python-packages.mjs\`. **Do not edit by hand.**

These pure-Python wheels are redistributed unmodified so the Code app can install
them offline. Each wheel keeps its own license; the authoritative text ships
inside the wheel itself (\`unzip -p <wheel> '*.dist-info/licenses/*'\` or the
\`License-File\` entries in its METADATA). Nothing here relicenses a dependency.

Packages supplied by the Pyodide distribution (numpy, pandas, matplotlib, scipy,
scikit-learn, …) are **not** redistributed by this repository; they are loaded at
runtime from the Pyodide CDN and remain under their own licenses.

## Curated packages (${curated.length})

${table(curated)}

## Transitive pure-Python dependencies (${deps.length})

${table(deps)}
${copyleftNote}`;

  await writeFile(join(VENDOR_DIR, "LICENSES.md"), body);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx !== -1 ? new Set(args[onlyIdx + 1].split(",").map(normalizeName)) : null;

  if (args.includes("--list")) {
    for (const p of CURATED) console.log(`${p.name.padEnd(18)} ${p.desc}`);
    return;
  }

  await mkdir(VENDOR_DIR, { recursive: true });
  const existing = new Set((await readdir(VENDOR_DIR)).filter(f => f.endsWith(".whl")));

  const targets = CURATED.filter(p => !only || only.has(normalizeName(p.name)));
  const resolved = new Map();   // normalized name -> record
  const queue = [];
  const notes = [];

  for (const p of targets) {
    try {
      const rec = await resolvePackage(p.name);
      if (rec.skipped) { notes.push(`skip ${p.name}: ${rec.skipped}`); continue; }
      rec.top = true;
      rec.desc = p.desc;
      resolved.set(rec.name, rec);
      queue.push(rec);
    } catch (err) {
      notes.push(`skip ${p.name}: ${String(err.message || err)}`);
    }
  }

  // Breadth-first dependency closure, pure-Python only.
  while (queue.length) {
    const pkg = queue.shift();
    for (const line of pkg.requiresDist ?? []) {
      const dep = depNameFromRequires(line);
      if (!dep || dep === pkg.name || resolved.has(dep)) continue;
      if (PYODIDE_PROVIDED.has(dep)) continue;
      if (dep.includes("[")) continue;
      try {
        const rec = await resolvePackage(dep);
        if (rec.skipped) { notes.push(`skip ${dep}: ${rec.skipped} (dependency of ${pkg.name})`); continue; }
        rec.top = false;
        rec.desc = `Dependency of ${pkg.displayName}`;
        resolved.set(rec.name, rec);
        queue.push(rec);
      } catch (err) {
        notes.push(`skip ${dep}: ${String(err.message || err)} (dependency of ${pkg.name})`);
      }
    }
  }

  // Download wheels, then read each wheel's own Requires-Dist for the manifest.
  const entries = [];
  for (const rec of resolved.values()) {
    const dest = join(VENDOR_DIR, rec.file);
    let size = rec.size;
    if (!force && existing.has(rec.file)) {
      try { size = (await stat(dest)).size; } catch {}
    } else {
      if (rec.size > MAX_WHEEL_BYTES) {
        notes.push(`skip ${rec.name}: wheel is ${(rec.size / 1048576).toFixed(1)} MB (over the ${MAX_WHEEL_BYTES / 1048576} MB cap)`);
        continue;
      }
      process.stdout.write(`  downloading ${rec.file} … `);
      size = await download(rec.url, dest);
      console.log(`${(size / 1024).toFixed(0)} KB`);
    }
    const metadata = await readWheelMetadata(dest);
    const requires = metadata
      .split("\n")
      .filter(l => /^Requires-Dist:/i.test(l))
      .map(l => l.replace(/Requires-Dist:\s*/i, "").trim())
      .map(depNameFromRequires)
      .filter(Boolean);
    const imports = await readWheelTopLevel(dest);
    const licenseHint = await readWheelLicenseHint(dest, metadata);
    entries.push({
      name: rec.displayName,
      key: rec.name,
      version: rec.version,
      description: rec.desc || rec.summary || "",
      file: rec.file,
      size,
      top: !!rec.top,
      imports,
      license: licenseFor(metadata, rec, licenseHint),
      requires: [...new Set(requires)],
    });
  }

  entries.sort((a, b) => (b.top - a.top) || a.key.localeCompare(b.key));

  // Requirements that are *not* in the bundle: typically binary/scientific
  // packages supplied by the Pyodide distribution (numpy, pandas, matplotlib,
  // scikit-learn, …). The app loads these from Pyodide when installing, so the
  // dialog can show exactly what an offline install will pull in.
  const bundledKeys = new Set(entries.map(e => e.key));
  for (const e of entries) {
    e.externalRequires = [...new Set((e.requires ?? [])
      .map(normalizeName)
      .filter(r => r && !bundledKeys.has(r)))];
  }

  const unpinned = Object.fromEntries(
    CURATED.filter(p => !entries.some(e => e.key === normalizeName(p.name))).map(p => [normalizeName(p.name), p.desc])
  );

  const manifest = {
    generatedAt: new Date().toISOString(),
    python: TARGET.python_version,
    runtime: "pyodide",
    note: "Pure-Python wheels (py3-none-any) vendored for offline install in the Code app.",
    packages: entries,
    unavailable: unpinned,
  };
  await writeFile(join(VENDOR_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeLicenceIndex(entries);

  const total = entries.reduce((n, e) => n + (e.size || 0), 0);
  console.log("");
  console.log(`vendored ${entries.length} wheels (${entries.filter(e => e.top).length} curated + deps), ${(total / 1048576).toFixed(2)} MB`);
  console.log(`manifest: vendor/python-packages/manifest.json`);
  console.log(`licenses: vendor/python-packages/LICENSES.md`);
  if (notes.length) {
    console.log("");
    console.log("notes:");
    for (const n of notes) console.log("  - " + n);
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
