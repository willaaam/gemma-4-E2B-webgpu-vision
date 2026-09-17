// Dry-run: resolve the scientific stack's dependency closure from the vendored
// Pyodide lock file, then report the real download cost with HEAD requests.
// Validates the resolution logic used by `vendor-portable-assets.mjs --with-scientific`.
//
// Usage: node testing/check-scientific-closure.mjs

import { readFile } from "node:fs/promises";

const lock = JSON.parse(await readFile("vendor/pyodide/pyodide-lock.json", "utf8"));
const pkgs = lock.packages ?? {};
const want = new Set();

function visit(name) {
  if (want.has(name) || !pkgs[name]) return;
  want.add(name);
  for (const dep of pkgs[name].depends ?? []) visit(dep);
}

for (const name of ["numpy", "pandas", "matplotlib", "scipy", "scikit-learn", "sympy"]) visit(name);

const missing = [];
const files = [];
for (const name of [...want].sort()) {
  const entry = pkgs[name];
  if (!entry?.file_name) { missing.push(name); continue; }
  files.push(entry.file_name);
}

console.log("resolved packages :", want.size);
console.log("unresolvable      :", missing.length ? missing.join(", ") : "none");
console.log("packages          :", [...want].sort().join(", "));

// The lock file carries no size, so ask the CDN. A plain HEAD is unreliable here
// (jsDelivr omits `content-length` on some responses), so ask for a single byte and
// read the total out of `content-range` — that is always present on a 206.
const base = `https://cdn.jsdelivr.net/pyodide/v${lock.info?.version ?? "0.26.4"}/full/`;
let total = 0;
let failed = 0;
await Promise.all(files.map(async (file) => {
  try {
    const res = await fetch(base + file, { headers: { Range: "bytes=0-0" } });
    const total_ = Number(/\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1]);
    if (!Number.isFinite(total_)) { failed++; return; }
    total += total_;
  } catch { failed++; }
}));
console.log(`download          : ${(total / 1048576).toFixed(1)} MB across ${files.length} wheels` +
  (failed ? ` (${failed} could not be sized; actual is larger)` : ""));
