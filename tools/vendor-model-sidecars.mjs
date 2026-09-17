// tools/vendor-model-sidecars.mjs — fetch the model's small files (NOT the weights).
//
// The engine resolves its tokenizer and configs relative to the model path
// (`<modelUrl>/tokenizer_config.json`, …), so a portable release must ship them or the
// offline path breaks on the very first load. They total ~31 MB, almost all of it
// `tokenizer.json`.
//
// They cannot simply be committed: `.gitignore` excludes `models/**` so a 2.4 GB
// checkpoint is never accidentally tracked, and that rule catches the sidecars too.
// CI therefore fetches them here. Same for a fresh clone.
//
// Usage:
//   node tools/vendor-model-sidecars.mjs                # the 8 small files (~31 MB)
//   node tools/vendor-model-sidecars.mjs --force         # re-download
//   node tools/vendor-model-sidecars.mjs --with-weights  # also the checkpoint (2.4 GB!)

import { mkdir, writeFile, readFile, access, stat } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_ID = "google/gemma-4-E2B-it-qat-mobile-transformers";
const DEST = resolve(ROOT, "models", MODEL_ID);
const BASE = `https://huggingface.co/${MODEL_ID}/resolve/main/`;

const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");
const WITH_WEIGHTS = args.has("--with-weights");

// Everything the loader reads except the tensors. Keep this in step with what the
// engine actually requests — it is derived from the model path at load time.
const SIDECARS = [
  "README.md",
  "chat_template.jinja",
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "processor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
];
const WEIGHTS = "model.safetensors";

const log = (...a) => console.log(...a);
function human(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GiB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
async function exists(p) { try { await access(p); return true; } catch { return false; } }

async function download(name) {
  const dest = join(DEST, name);
  if (!FORCE && await exists(dest) && (await stat(dest)).size > 0) {
    return { skipped: true, bytes: (await stat(dest)).size };
  }
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`GET ${name} → ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await mkdir(DEST, { recursive: true });
  await writeFile(dest, buf);
  return { skipped: false, bytes: buf.byteLength };
}

log("Model sidecars");
log("────────────────────────────────────────────────────────────");
log(`  ${MODEL_ID}`);

await mkdir(DEST, { recursive: true });
let total = 0;
let missing = 0;
for (const name of SIDECARS) {
  const result = await download(name);
  total += result.bytes;
  log(`  ${result.skipped ? "·" : "+"} ${name.padEnd(30)} ${human(result.bytes)}`);
}

if (WITH_WEIGHTS) {
  log("\nCheckpoint (this is the 2.4 GB file — the portable release deliberately excludes it)");
  const result = await download(WEIGHTS);
  total += result.bytes;
  log(`  ${result.skipped ? "·" : "+"} ${WEIGHTS.padEnd(30)} ${human(result.bytes)}`);
}

log("────────────────────────────────────────────────────────────");
log(`  ${SIDECARS.length - missing}/${SIDECARS.length} sidecars, ${human(total)} total`);
log("\n  Note: these files are gitignored by design. Re-run this after a fresh clone");
log("  (or `npm run vendor:portable`, which the release build needs anyway).");
