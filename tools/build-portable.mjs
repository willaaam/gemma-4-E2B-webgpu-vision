// tools/build-portable.mjs — build the single-file portable release.
//
// Produces ONE html file that runs the whole workstation from disk:
//
//   dist/portable/gemma4-workstation.html      the app (all JS/CSS/fonts inlined)
//   dist/portable/assets/…                     model + Pyodide + wheels (see below)
//
// Everything that used to come from a CDN is bundled in; everything too large to
// inline (the 2.4 GB weights, the Pyodide runtime, the wheel bundle) lives in the
// assets folder and is read through the local fetch shim, which is what removes the
// need for a server and for HTTP Range support.
//
// The dev/served build is untouched: this is a release-only step, and `index.html`
// keeps its import map and CDN behaviour.
//
// Usage: node tools/build-portable.mjs [--out dist/portable] [--no-fonts]

import { readFile, writeFile, mkdir, stat, access, readdir, copyFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT_DIR = resolve(ROOT, argValue("--out", "dist/portable"));
const INLINE_FONTS = !argv.includes("--no-fonts");

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const log = (...args) => console.log(...args);
function human(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
async function exists(p) { try { await access(p); return true; } catch { return false; } }

/**
 * Serialise a value for embedding in a `<script type="application/json">`.
 * `JSON.stringify` does not escape `</script`, which would terminate the tag
 * early, so escape every `<` as `\u003c` — valid JSON, decodes to `<`.
 */
function jsonForInlineScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Inline every `url(...)` reference in a stylesheet as a data URL. */
async function inlineCssUrls(css, { base, filter } = {}) {
  const urls = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2]);
  const unique = [...new Set(urls)];
  const dataUrls = new Map();
  for (const ref of unique) {
    if (/^data:/.test(ref)) continue;
    if (filter && !filter(ref)) continue;
    const href = /^https?:/.test(ref) ? ref : new URL(ref, base).href;
    try {
      const res = await fetch(href, { headers: { "user-agent": CHROME_UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = /\.woff2$/.test(ref) ? "font/woff2"
        : /\.woff$/.test(ref) ? "font/woff"
          : /\.ttf$/.test(ref) ? "font/ttf"
            : "application/octet-stream";
      const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      dataUrls.set(ref, `data:${type};base64,${b64}`);
    } catch (err) {
      log(`    ! could not inline ${ref} (${err.message})`);
    }
  }
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, quote, ref) =>
    dataUrls.has(ref) ? `url("${dataUrls.get(ref)}")` : whole);
}

/**
 * Google Fonts stylesheet → inlined, latin-only.
 *
 * Google returns one @font-face per unicode subset; we keep only the blocks that
 * cover basic latin / latin-ext, which is all the UI uses, then inline the woff2
 * payloads so the fonts work with no network.
 */
async function buildGoogleFontsCss(href) {
  const url = href.replace(/&amp;/g, "&");
  const res = await fetch(url, { headers: { "user-agent": CHROME_UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const css = await res.text();

  const blocks = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  const keep = blocks.filter((block) => {
    const range = /unicode-range:\s*([^;}]+)/i.exec(block)?.[1] ?? "";
    if (!range) return true; // no unicode-range ⇒ a single full-coverage face
    return /U\+0000-00FF/i.test(range) || /U\+0100-02AF/i.test(range);
  });
  const latinOnly = keep.join("\n");
  if (!latinOnly) throw new Error("no latin subsets found");

  const inlined = await inlineCssUrls(latinOnly, { base: url, filter: (r) => /\.woff2?$/.test(r) });
  return { css: inlined, blocks: keep.length, total: blocks.length };
}

/** KaTeX stylesheet: keep the woff2 source only and inline it. */
async function buildKatexCss() {
  const cssPath = resolve(ROOT, "node_modules/katex/dist/katex.min.css");
  if (!await exists(cssPath)) return null;
  let css = await readFile(cssPath, "utf8");
  // Collapse `src:url(x.woff2) format("woff2"),url(x.woff)…,url(x.ttf)…` to just the woff2.
  css = css.replace(
    /src:url\(fonts\/([^)]+?)\.woff2\)\s*format\("woff2"\),url\([^)]+?\.woff\)\s*format\("woff"\),url\([^)]+?\.ttf\)\s*format\("truetype"\)/g,
    (_m, name) => `src:url(fonts/${name}.woff2) format("woff2")`
  );
  return inlineCssUrls(css, { base: "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/", filter: (r) => /\.woff2$/.test(r) });
}

// --- esbuild -----------------------------------------------------------------

/** Map the runtime CDN imports onto the npm packages installed for the build. */
function cdnToNpm() {
  const MAP = [
    [/^https:\/\/esm\.sh\/marked@/, "marked"],
    [/^https:\/\/esm\.sh\/katex@/, "katex"],
    [/^https:\/\/esm\.sh\/chart\.js@/, "chart.js/auto"],
    [/^https:\/\/esm\.sh\/fflate@/, "fflate"],
  ];
  return {
    name: "cdn-to-npm",
    setup(build) {
      build.onResolve({ filter: /^https:\/\/esm\.sh\// }, async (args) => {
        const hit = MAP.find(([re]) => re.test(args.path));
        if (!hit) {
          return { errors: [{ text: `Unmapped CDN import: ${args.path}` }] };
        }
        // Delegate to esbuild's own resolver so each package's `exports` map is
        // honoured (that is how `chart.js/auto` and `katex` find their ESM entries).
        // The replacement is a bare specifier, so it cannot re-enter this filter.
        const resolved = await build.resolve(hit[1], {
          kind: "import-statement",
          resolveDir: ROOT,
          importer: args.importer,
        });
        if (resolved.errors.length) return { errors: resolved.errors };
        return { path: resolved.path, namespace: resolved.namespace };
      });
    },
  };
}

/** Extract the inline `<script type="module">` block that boots the app. */
function extractBootstrapModule(html) {
  const matches = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
  if (!matches.length) throw new Error("No inline module script found in index.html");
  const last = matches[matches.length - 1];
  return { source: last[1], full: last[0] };
}

async function buildBundle(contents, { resolveDir, label }) {
  const result = await esbuild.build({
    stdin: { contents, resolveDir, loader: "js", sourcefile: label },
    bundle: true,
    format: "esm",
    target: ["chrome120"],
    platform: "browser",
    splitting: false,       // inline dynamic imports so the output is one file
    minify: true,
    legalComments: "none",
    write: false,
    logLevel: "silent",
    plugins: [cdnToNpm()],
  });
  if (result.errors?.length) throw new Error(result.errors.map((e) => e.text).join("\n"));
  return result.outputFiles[0].text;
}

// --- main --------------------------------------------------------------------

log("Portable build");
log("────────────────────────────────────────────────────────────");

const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
log(`  version ${pkg.version}`);

// 1. The engine source is inlined — a file:// page cannot fetch it as a module.
const engineSource = await readFile(resolve(ROOT, "gemma-4-e2b.js"), "utf8");
log(`  engine source      ${human(Buffer.byteLength(engineSource))}`);

// 2. Bundle the landing scene and the app bootstrap.
const html = await readFile(resolve(ROOT, "index.html"), "utf8");
const bootstrap = extractBootstrapModule(html);

const PRELUDE = [
  "// --- portable prelude (injected by tools/build-portable.mjs) ---",
  'import { initPortable } from "./src/shell/portable-entry.js";',
  "await initPortable();",
  "// --- end portable prelude ---",
  "",
].join("\n");

// The service worker is meaningless here: it cannot register on file://, and there
// is nothing to cache because every asset is already local. Dropping the block also
// avoids a pointless 404 for ./sw.js on hosts that serve the portable file.
const bootstrapSource = bootstrap.source.replace(
  /\s*if \("serviceWorker" in navigator[\s\S]*?\n\s*\}\n/,
  "\n"
);
if (bootstrapSource.includes("serviceWorker")) {
  log("  ! could not strip the service-worker registration (index.html changed?)");
}

log("  bundling landing…");
const landingBundle = await buildBundle(await readFile(resolve(ROOT, "landing.js"), "utf8"), {
  resolveDir: ROOT,
  label: "landing.js",
});

log("  bundling app…");
const appBundle = await buildBundle(PRELUDE + bootstrapSource, {
  resolveDir: ROOT,
  label: "bootstrap.js",
});

// 3. Stylesheets: Google Fonts + KaTeX, fonts inlined.
let googleFontsCss = "";
if (INLINE_FONTS) {
  const href = /<link[^>]+href=["'](https:\/\/fonts\.googleapis\.com[^"']+)["']/.exec(html)?.[1];
  if (href) {
    try {
      const { css, blocks, total } = await buildGoogleFontsCss(href);
      googleFontsCss = css;
      log(`  google fonts       ${blocks}/${total} subsets inlined (${human(Buffer.byteLength(css))})`);
    } catch (err) {
      log(`  ! google fonts not inlined (${err.message}) — falling back to system fonts`);
    }
  }
}

let katexCss = "";
try {
  katexCss = await buildKatexCss() ?? "";
  if (katexCss) log(`  katex css          ${human(Buffer.byteLength(katexCss))}`);
} catch (err) {
  log(`  ! katex css not inlined (${err.message})`);
}

// 4. Assemble the single file.
//
// NOTE: every replacement below uses a *function* replacer. The injected payloads
// are minified JS/CSS which routinely contain `$&`, `$'` and `` $` `` sequences, and
// a string replacer would expand those as backreferences — duplicating the whole
// document and inflating the output from ~3 MB to tens of MB.
const put = (haystack, pattern, replacement) => haystack.replace(pattern, () => replacement);

let out = html;

// 4a. Drop the preconnects and the CDN stylesheet links — nothing is remote now.
out = out.replace(/\s*<link rel="preconnect"[^>]*>/g, "");
out = out.replace(/\s*<link rel="stylesheet" href="https:\/\/cdn\.jsdelivr\.net[^>]*>/g, "");
out = out.replace(/\s*<link href="https:\/\/fonts\.googleapis\.com[^>]*>/g, "");
// The PWA manifest is pointless here: a file:// page cannot be installed, and the
// link would just be a guaranteed 404 next to the single HTML file.
out = out.replace(/\s*<link rel="manifest"[^>]*>/g, "");

// 4b. Remove the import map: everything is bundled, so a remote specifier would be
//     a bug rather than a feature.
out = out.replace(/\s*<script type="importmap">[\s\S]*?<\/script>/g, "");

// 4c. Inject the inlined fonts/KaTeX CSS.
const styleInject = [
  googleFontsCss ? `<style data-portable="fonts">\n${googleFontsCss}\n</style>` : "",
  katexCss ? `<style data-portable="katex">\n${katexCss}\n</style>` : "",
].filter(Boolean).join("\n");
if (styleInject) out = put(out, "</head>", `${styleInject}\n</head>`);

// 4d. Inline the bundled landing scene.
out = put(
  out,
  /<script type="module" src="\.\/landing\.js"><\/script>/,
  `<script type="module">\n${landingBundle}\n</script>`
);

// 4e. Portability config, read by src/lib/portable.js at module-evaluation time.
//     This MUST be a classic script that runs before any module.
const portableConfig = `<script id="portable-config" type="application/json">${jsonForInlineScript({
  assetBase: "https://assets.local/",
  engineSource,
  version: pkg.version,
})}</script>
<script data-portable="bootstrap">
(function () {
  var cfg = JSON.parse(document.getElementById("portable-config").textContent);
  window.__PORTABLE__ = cfg;
})();
</script>
`;
out = put(out, "<body>", `<body>\n${portableConfig}`);

// 4f. Replace the inline bootstrap module with the bundled one.
if (!out.includes(bootstrap.full)) {
  throw new Error("Could not locate the bootstrap module to replace — index.html changed shape?");
}
out = put(out, bootstrap.full, `<script type="module">\n${appBundle}\n</script>`);

// 5. Write the HTML.
await mkdir(OUT_DIR, { recursive: true });
const outFile = join(OUT_DIR, "gemma4-workstation.html");
await writeFile(outFile, out, "utf8");
const htmlInfo = await stat(outFile);

// 6. HARD GUARD: a runtime fetch()/import() of a remote URL would break offline and
//    is easy to introduce by accident (e.g. adding a new CDN helper). Fail loudly.
const hazards = [];
for (const [label, text] of [["app bundle", appBundle], ["landing bundle", landingBundle]]) {
  for (const m of text.matchAll(/\b(?:fetch|import)\s*\(\s*["'`]https:/g)) {
    hazards.push(`${label}: ${m[0]}`);
  }
}
if (hazards.length) {
  log("\n✗ Runtime network access found in the bundle:");
  for (const h of hazards) log(`    ${h}`);
  log("  Add it to the cdn-to-npm map in this script, or vendor it.");
  process.exit(1);
}

// 7. Assemble the assets folder next to the HTML.
const ASSETS_DIR = join(OUT_DIR, "assets");
const SKIP_WEIGHTS = argv.includes("--no-weights");

async function copyTree(from, to) {
  if (!await exists(from)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) {
      const sub = await copyTree(src, dest);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      const srcInfo = await stat(src);
      if (!await exists(dest) || (await stat(dest)).size !== srcInfo.size) {
        await copyFile(src, dest);
      }
      files++;
      bytes += srcInfo.size;
    }
  }
  return { files, bytes };
}

log("────────────────────────────────────────────────────────────");
log("  assets/");

const parts = [];
for (const [label, from, to] of [
  ["Pyodide runtime", "vendor/pyodide", join(ASSETS_DIR, "vendor/pyodide")],
  ["document parsers", "vendor/parser", join(ASSETS_DIR, "vendor/parser")],
  ["pure-Python wheels", "vendor/python-packages", join(ASSETS_DIR, "vendor/python-packages")],
]) {
  const result = await copyTree(resolve(ROOT, from), to);
  if (!result.files) {
    log(`    ! ${label}: ${from}/ not found — run \`npm run vendor:portable\` first.`);
    continue;
  }
  parts.push([label, result.bytes]);
  log(`    + ${label.padEnd(19)} ${String(result.files).padStart(4)} files  ${human(result.bytes)}`);
}

// The weights are far too large to inline, so they ship beside the HTML.
const MODEL_DIR = "models/google/gemma-4-E2B-it-qat-mobile-transformers";
const weightsSource = resolve(ROOT, MODEL_DIR, "model.safetensors");
const weightsDest = join(ASSETS_DIR, "model.safetensors");

// The engine derives its sidecar URLs from the model URL, so the small files
// (tokenizer, config, chat template) must sit in the same relative place they do in
// the repo. Without these the loader fails immediately after the weight header.
const sidecarDir = join(ASSETS_DIR, MODEL_DIR);
let sidecarCount = 0;
let sidecarBytes = 0;
if (await exists(resolve(ROOT, MODEL_DIR))) {
  await mkdir(sidecarDir, { recursive: true });
  for (const entry of await readdir(resolve(ROOT, MODEL_DIR), { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "model.safetensors") continue;
    const src = resolve(ROOT, MODEL_DIR, entry.name);
    const dest = join(sidecarDir, entry.name);
    const srcInfo = await stat(src);
    if (!await exists(dest) || (await stat(dest)).size !== srcInfo.size) await copyFile(src, dest);
    sidecarCount++;
    sidecarBytes += srcInfo.size;
  }
  log(`    + model sidecars      ${String(sidecarCount).padStart(4)} files  ${human(sidecarBytes)}`);
  parts.push(["model sidecars", sidecarBytes]);
} else {
  log(`    ! ${MODEL_DIR}/ not found — tokenizer/config files are required.`);
}

if (SKIP_WEIGHTS) {
  log("    · model.safetensors   skipped (--no-weights)");
} else if (await exists(weightsSource)) {
  const srcSize = (await stat(weightsSource)).size;
  if (await exists(weightsDest) && (await stat(weightsDest)).size === srcSize) {
    log(`    · model.safetensors   already present (${human(srcSize)})`);
  } else {
    log(`    + model.safetensors   copying ${human(srcSize)}…`);
    await copyFile(weightsSource, weightsDest);
  }
  parts.push(["weights", srcSize]);
} else {
  log("    ! model.safetensors   not found locally — copy it into assets/ by hand.");
}

// 8. Instructions the user actually needs when the stick is plugged in.
const readme = `Gemma 4 E2B — portable release ${pkg.version}
================================================

WHAT THIS IS
  One HTML file that runs the whole workstation from disk: chat, vision,
  document research, reports and the Python/web code environment. Nothing is
  sent anywhere and no server or installation is needed.

HOW TO RUN
  Open gemma4-workstation.html in Chrome or Edge, then pick one of:

  A) OFFLINE (needs the model on this disk)
     1. Keep this file next to the "assets" folder.
     2. When asked, choose that folder.
     3. Everything — model, Python runtime, packages — is read from disk.

  B) ONLINE (no model file needed)
     Click "Stream from Hugging Face" instead. The model (~2.4 GB) is fetched
     from the Hugging Face Hub on first load and cached by your browser, so
     later loads are local. You can point it at an assets folder at any time
     to switch to fully offline use.

  If model.safetensors is missing from assets/, use option B, or download the
  checkpoint from
    https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers
  and place it at assets/model.safetensors, then use option A.

WHY IT ASKS FOR A FOLDER
  A page opened from disk (file://) is not allowed to read its neighbouring
  files by itself, and it has no HTTP Range support — which is how the engine
  normally streams the 2.4 GB of weights. Files *you* pick are readable at any
  byte offset, so the app asks once and then streams from your choice.

WHAT IS IN assets/
  model.safetensors        the Gemma 4 E2B QAT model (~2.4 GB, optional)
  models/google/.../       tokenizer + configs (needed with model.safetensors)
  vendor/pyodide/          CPython for the Code app, runs offline
  vendor/python-packages/  49 pure-Python wheels, install offline
  vendor/parser/           pdf.js + mammoth for document import

REQUIREMENTS
  - Chrome or Edge (recent), and a GPU exposing WebGPU.
  - Offline mode: ~2.5 GB where the assets live, plus storage for cached tensors.
  - Online mode: a connection for the first load only (~2.4 GB).

NOTES
  - First load decodes the weights and caches what it can in the browser, so
    later loads are faster. Browser storage may be cleared at any time.
  - "Clear" in the Python console resets the interpreter; installed packages
    stay cached.
  - The Python console's Stop button is best-effort here: file:// pages cannot
    use SharedArrayBuffer, which is what normally delivers a hard interrupt.

Licences and attribution: see THIRD_PARTY_NOTICES.md in the source repository.
`;
await writeFile(join(OUT_DIR, "README.txt"), readme, "utf8");

// 9. Summary.
const assetsBytes = parts.reduce((sum, [, bytes]) => sum + bytes, 0);
log("────────────────────────────────────────────────────────────");
log(`  ${outFile.replace(ROOT + "/", "")}   ${human(htmlInfo.size)}`);
log(`  ${join(OUT_DIR, "assets").replace(ROOT + "/", "")}${" ".repeat(22)}${human(assetsBytes)}`);
log(`  ${"release total".padEnd(48)}${human(htmlInfo.size + assetsBytes)}`);
log(`\n  Ready. Copy dist/portable/ to the target machine and open gemma4-workstation.html.`);

