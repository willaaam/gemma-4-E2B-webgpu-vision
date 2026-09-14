// tools/check-release.mjs — pre-release sanity checks that a linter can't catch.
//
// Verifies, without a browser:
//   1. Module graph — every relative import reachable from the entry points
//      resolves to a file that exists; lists the bare specifiers in use.
//   2. Import map — every bare specifier used by the app, and every
//      `?external=` package an esm.sh bundle is told to leave alone, is mapped
//      (a missing entry means a runtime module-resolution error).
//   3. Offline bundle — every wheel in `vendor/python-packages/manifest.json`
//      exists on disk, and each entry carries a license and import names.
//   4. Stale references — nothing still imports the deleted `src/agent` /
//      `src/harness` modules.
//
// Usage: npm run check:release   (exit code 1 on any problem)
//
// The browser-side checks live in the README's "Browser console checklist";
// this script covers everything that can be verified statically.

import { readFile, access } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEEDS = ["index.html", "landing.js", "sw.js"];
const problems = [];
const notes = [];

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

// --- 1. module graph -------------------------------------------------------

const visited = new Set();
const bareSpecifiers = new Set();

async function walk(relPath) {
  const abs = resolve(ROOT, relPath);
  if (visited.has(abs)) return;
  visited.add(abs);
  if (!(await exists(abs))) {
    problems.push(`missing module: ${relPath}`);
    return;
  }
  const src = await readFile(abs, "utf8");
  const specs = new Set();
  const patterns = [
    /(?:^|\n)\s*import\s+[^"'`]*?from\s+["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\bnew\s+Worker\(\s*["']([^"']+)["']/g,
  ];
  if (abs.endsWith(".html")) {
    patterns.push(/<script[^>]+src=["']([^"']+)["']/g, /<link[^>]+href=["']([^"']+)["']/g);
  }
  for (const re of patterns) for (const m of src.matchAll(re)) specs.add(m[1]);

  for (const spec of specs) {
    if (/^https?:|^data:|^blob:|^#|^\/\//.test(spec)) continue;
    if (spec.startsWith(".") === false && spec.startsWith("/") === false) {
      bareSpecifiers.add(spec);
      continue;
    }
    const target = spec.startsWith("/") ? resolve(ROOT, "." + spec) : resolve(dirname(abs), spec);
    const candidates = [target, `${target}.js`, `${target}.mjs`, resolve(target, "index.js")];
    let hit = null;
    for (const c of candidates) if (await exists(c)) { hit = c; break; }
    if (hit) await walk(relative(ROOT, hit));
    else problems.push(`unresolved import "${spec}" in ${relative(ROOT, abs)}`);
  }
}

for (const seed of SEEDS) await walk(seed);

// --- 2. import map ---------------------------------------------------------

const html = await readFile(resolve(ROOT, "index.html"), "utf8");
const mapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
if (!mapMatch) {
  problems.push("index.html has no import map");
} else {
  const imports = JSON.parse(mapMatch[1]).imports ?? {};
  const keys = Object.keys(imports);
  for (const spec of bareSpecifiers) {
    const mapped = keys.includes(spec) || keys.some(k => k.endsWith("/") && spec.startsWith(k));
    if (!mapped) problems.push(`bare specifier not in the import map: ${spec}`);
  }
  const externals = new Set();
  for (const value of Object.values(imports)) {
    const m = /[?&]external=([^&]+)/.exec(String(value));
    if (!m) continue;
    for (const name of decodeURIComponent(m[1]).split(",")) if (name.trim()) externals.add(name.trim());
  }
  for (const name of externals) {
    if (keys.includes(name) === false) problems.push(`external dependency not in the import map: ${name}`);
  }
  notes.push(`import map: ${keys.length} entries, ${bareSpecifiers.size} bare specifiers used, ${externals.size} externals declared`);
}

// --- 3. offline bundle -----------------------------------------------------

const MANIFEST = resolve(ROOT, "vendor/python-packages/manifest.json");
if (await exists(MANIFEST)) {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const packages = manifest.packages ?? [];
  let wheels = 0;
  for (const p of packages) {
    if (await exists(resolve(ROOT, "vendor/python-packages", p.file))) wheels++;
    else problems.push(`vendor wheel missing on disk: ${p.file}`);
    if (!p.license) problems.push(`vendor entry without a license: ${p.key}`);
    if (!(p.imports ?? []).length) problems.push(`vendor entry without import names: ${p.key}`);
  }
  if (!(await exists(resolve(ROOT, "vendor/python-packages/LICENSES.md")))) {
    problems.push("vendor/python-packages/LICENSES.md is missing (run: npm run vendor:python)");
  }
  const unavailable = Object.keys(manifest.unavailable ?? {});
  notes.push(`offline bundle: ${packages.length} packages (${wheels} wheels on disk), PyPI-only: ${unavailable.join(", ") || "none"}`);
} else {
  notes.push("offline bundle: not vendored (Code app falls back to PyPI)");
}

// --- 4. stale references ---------------------------------------------------

for (const abs of visited) {
  if (abs.includes("node_modules")) continue;
  const src = await readFile(abs, "utf8");
  if (/["'][^"']*\/agent\/|["'][^"']*\/harness\//.test(src)) {
    problems.push(`stale reference to a deleted module in ${relative(ROOT, abs)}`);
  }
}
notes.push(`module graph: ${visited.size} modules reachable from ${SEEDS.join(", ")}`);

// --- report ----------------------------------------------------------------

console.log("Release checks");
console.log("─".repeat(60));
for (const note of notes) console.log("  • " + note);
console.log("");
if (problems.length) {
  console.log(`${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const p of problems) console.log("  ✖ " + p);
  process.exitCode = 1;
} else {
  console.log("✔ all release checks passed");
}
