// tools/build-release.mjs — package the app-only portable release for download.
//
// WHY THIS EXISTS
// GitHub release assets must each be under 2 GiB, and the weights blow straight
// through that: `model.safetensors` is 2.29 GiB raw and still 2.02 GiB deflated
// (the QAT int8 tensors are ~90% incompressible, so LZMA does not help either).
// Even the whole release zipped is 2.09 GiB. Measurements, for the record:
//
//   model.safetensors             2,458,111,846 B   2.289 GiB
//   model.safetensors (deflate)   2,165,181,343 B   2.016 GiB
//   full portable release (.zip)  2,247,774,681 B   2.093 GiB
//   app + runtime, no weights        ~62 MB          fine
//
// So this script deliberately produces a small artifact WITHOUT the checkpoint.
// The app streams the weights from the Hugging Face Hub when they are not on disk
// (see the gate in src/shell/portable-entry.js), which keeps the download usable
// on its own. Users who want the fully offline build then drop model.safetensors
// into assets/ next to the HTML.
//
// Usage:
//   node tools/build-release.mjs                    # app-only zip (default)
//   node tools/build-release.mjs --with-weights     # include the checkpoint (will exceed 2 GiB)

import { readFile, writeFile, mkdir, stat, rm, readdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { zipSync } from "fflate";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const WITH_WEIGHTS = argv.includes("--with-weights");

const GITHUB_ASSET_LIMIT = 2147483648; // 2 GiB, per docs.github.com "About releases"
const OUT_DIR = resolve(ROOT, "dist/release");
const STAGE_DIR = resolve(ROOT, "dist/.release-stage");
const MODEL_DIR = "models/google/gemma-4-E2B-it-qat-mobile-transformers";

const log = (...a) => console.log(...a);
function human(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GiB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

/** Run the portable builder as a child process (it is a top-level script). */
function runBuild() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(ROOT, "tools/build-portable.mjs"), "--out", STAGE_DIR,
        ...(WITH_WEIGHTS ? [] : ["--no-weights"])],
      { cwd: ROOT, stdio: "inherit" }
    );
    child.on("error", reject);
    child.on("exit", (code) => (code === 0
      ? resolvePromise()
      : reject(new Error(`build-portable.mjs exited with code ${code}`))));
  });
}

/** Recursively collect files as { archivePath, absolutePath }. */
async function collect(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await collect(abs, rel));
    else if (entry.isFile()) out.push({ archivePath: rel, absolutePath: abs });
  }
  return out;
}

// --- main --------------------------------------------------------------------

const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
const baseName = `gemma4-workstation-portable-${pkg.version}`;

log("Release package");
log("────────────────────────────────────────────────────────────");
log(`  version ${pkg.version}`);
log(`  weights ${WITH_WEIGHTS ? "INCLUDED (will exceed the GitHub 2 GiB per-asset limit)" : "excluded (streamed from the Hub on demand)"}`);

await rm(STAGE_DIR, { recursive: true, force: true });
// Clear previous output too: the release workflow uploads `dist/release/*`, so a stale
// artifact from an earlier version would otherwise get attached alongside the new one.
await rm(OUT_DIR, { recursive: true, force: true });
await runBuild();

// Verify the checkpoint really is absent when we claim it is.
const stagedWeights = join(STAGE_DIR, "assets/model.safetensors");
if (!WITH_WEIGHTS && await exists(stagedWeights)) {
  throw new Error("staged build unexpectedly contains model.safetensors — refusing to package");
}

// The engine resolves its tokenizer and configs relative to the model path, so a release
// without them breaks the offline path on the very first load. `models/**` is gitignored,
// so a fresh clone — and CI — must run `npm run vendor:model` first. Fail rather than
// quietly publish an artifact that cannot work offline.
const REQUIRED_SIDECARS = ["tokenizer.json", "tokenizer_config.json", "config.json", "chat_template.jinja"];
const missingSidecars = [];
for (const name of REQUIRED_SIDECARS) {
  if (!await exists(join(STAGE_DIR, "assets", MODEL_DIR, name))) missingSidecars.push(name);
}
if (missingSidecars.length) {
  throw new Error(
    `staged build is missing model sidecars: ${missingSidecars.join(", ")}\n` +
    "Run `npm run vendor:model` first — without them the offline (assets folder) path fails."
  );
}

const files = await collect(STAGE_DIR);
let raw = 0;
for (const f of files) raw += (await stat(f.absolutePath)).size;

log("────────────────────────────────────────────────────────────");
log(`  staging ${files.length} files, ${human(raw)} raw`);

// Build the archive. Every entry is nested under a versioned folder so extracting
// does not scatter files into the user's current directory.
//
// Timestamps and Unix modes are pinned so the archive is byte-reproducible: the
// SHA256 published alongside it can then be verified by rebuilding. `SOURCE_DATE_EPOCH`
// is honoured if set, otherwise the DOS epoch is used — the neutral choice for
// deterministic zips (DOS time cannot represent anything earlier).
const SOURCE_DATE_EPOCH = Number(process.env.SOURCE_DATE_EPOCH);
const MTIME = new Date(Number.isFinite(SOURCE_DATE_EPOCH) && SOURCE_DATE_EPOCH > 0
  ? SOURCE_DATE_EPOCH * 1000
  : Date.UTC(1980, 0, 1));
const FILE_ATTRS = 0o100644 << 16; // regular file, rw-r--r--

log("  compressing…");
const entries = {};
for (const f of files) {
  const buf = new Uint8Array(await readFile(f.absolutePath));
  entries[`${baseName}/${f.archivePath}`] = [buf, {
    level: 6,
    mtime: MTIME,
    os: 3,
    attrs: FILE_ATTRS,
  }];
}
const zip = zipSync(entries, { level: 6 });

await mkdir(OUT_DIR, { recursive: true });
const zipPath = join(OUT_DIR, `${baseName}.zip`);
await writeFile(zipPath, zip);

const digest = createHash("sha256").update(zip).digest("hex");

// Also publish the bare HTML: it is the headline artifact (one file that runs the whole
// app by streaming the model from the Hub) and small enough to grab on its own.
const htmlName = `gemma4-workstation-${pkg.version}.html`;
const htmlPath = join(OUT_DIR, htmlName);
await copyFile(join(STAGE_DIR, "gemma4-workstation.html"), htmlPath);
const htmlDigest = createHash("sha256").update(await readFile(htmlPath)).digest("hex");

const sumsPath = join(OUT_DIR, "SHA256SUMS.txt");
await writeFile(sumsPath, `${digest}  ${baseName}.zip\n${htmlDigest}  ${htmlName}\n`);

await rm(STAGE_DIR, { recursive: true, force: true });

// --- report ------------------------------------------------------------------

const over = zip.length >= GITHUB_ASSET_LIMIT;
log("────────────────────────────────────────────────────────────");
log(`  ${relative(ROOT, zipPath)}`);
log(`    ${zip.length} bytes  (${human(zip.length)})    sha256 ${digest.slice(0, 16)}`);
log(`  ${relative(ROOT, htmlPath)}`);
log(`    ${htmlName}  sha256 ${htmlDigest.slice(0, 16)}`);
log(`  ${relative(ROOT, sumsPath)}`);
log("");
log(`  GitHub per-asset limit: 2.00 GiB (${GITHUB_ASSET_LIMIT} bytes)`);
log(`  verdict: ${over
  ? "✗ OVER — this asset cannot be uploaded"
  : `✓ fits, with ${human(GITHUB_ASSET_LIMIT - zip.length)} to spare`}`);
log("");
if (!WITH_WEIGHTS) {
  log("  This artifact does NOT contain the model. On first run the app offers");
  log("  \"Stream from Hugging Face\" (~2.4 GB, cached by the browser afterwards).");
  log("  For a fully offline build, also ship the checkpoint separately — but note it");
  log("  cannot be a single GitHub asset: it is 2.29 GiB raw / 2.02 GiB compressed.");
  log("  Options: split it, or host it on the Hugging Face Hub next to the model.");
}
log("");
log(`  Attach everything in ${relative(ROOT, OUT_DIR)}/ to the release.`);

// Failing here stops CI before it tries to publish something GitHub will reject.
if (over) process.exitCode = 1;
