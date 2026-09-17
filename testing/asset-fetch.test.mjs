// testing/asset-fetch.test.mjs — Node unit tests for the portable asset layer.
//
// Runs without a browser: Node 22 provides Blob, File, Response and DOMException,
// which is everything the shim touches. The engine's contract (a fetch-shaped
// function answering `Range` requests out of a Blob) is fully exercisable here.
//
// Usage: node testing/asset-fetch.test.mjs

import { AssetStore, VIRTUAL_ORIGIN, virtualUrl, normalizeKey } from "../src/lib/asset-store.js";
import { createLocalFetch } from "../src/lib/asset-fetch.js";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// A deterministic 64 KiB payload so range slices can be verified byte-for-byte.
const SIZE = 65536;
const payload = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i++) payload[i] = (i * 31 + 7) & 0xff;
const modelFile = new File([payload], "model.safetensors", { type: "application/octet-stream" });

// A tiny text asset to exercise manifest/wheel-style lookups.
const jsonFile = new File(['{"ok":true}'], "manifest.json", { type: "application/json" });

const store = new AssetStore();
store.addFile(modelFile, "model.safetensors");
store.addFile(jsonFile, "vendor/python-packages/manifest.json");

const localFetch = createLocalFetch(store, {
  fallback: async () => new Response("network", { status: 200 }),
});

// --- key normalization -------------------------------------------------------

eq("normalize: strips virtual origin", normalizeKey(`${VIRTUAL_ORIGIN}vendor/x.whl`), "vendor/x.whl");
eq("normalize: strips ./", normalizeKey("./model.safetensors"), "model.safetensors");
eq("normalize: strips query+fragment", normalizeKey("a/b.whl?v=1#frag"), "a/b.whl");
eq("normalize: strips origin", normalizeKey("https://esm.sh/pkg@1"), "pkg@1");

// --- store resolution --------------------------------------------------------

check("resolve: exact path", store.resolve("model.safetensors") === modelFile);
check("resolve: virtual URL", store.resolve(virtualUrl("model.safetensors")) === modelFile);
check("resolve: nested exact", store.resolve("vendor/python-packages/manifest.json") === jsonFile);
check("resolve: unique basename", store.resolve("manifest.json") === jsonFile);
check("resolve: missing returns null", store.resolve("nope.safetensors") === null);
check("resolveModelFile finds it", store.resolveModelFile() === modelFile);

// Suffix matching: a deep requested path should still find the flattened pick.
const deepStore = new AssetStore();
deepStore.addFile(modelFile, "model.safetensors");
check(
  "resolve: deep path finds flattened file",
  deepStore.resolve("models/google/gemma-4-E2B-it-qat-mobile-transformers/model.safetensors") === modelFile
);

// Ambiguous basenames must NOT be guessed.
const ambiguous = new AssetStore();
ambiguous.addFile(new File(["a"], "conftest.py"), "a/conftest.py");
ambiguous.addFile(new File(["b"], "conftest.py"), "b/conftest.py");
check("resolve: ambiguous basename returns null", ambiguous.resolve("conftest.py") === null);

// --- HEAD -------------------------------------------------------------------

const head = await localFetch(virtualUrl("model.safetensors"), { method: "HEAD" });
check("HEAD: ok", head.ok === true, `status ${head.status}`);
eq("HEAD: content-length", head.headers.get("content-length"), String(SIZE));
eq("HEAD: accept-ranges", head.headers.get("accept-ranges"), "bytes");
check("HEAD: no body", head.body === null, "expected null body");

// --- ranged GET: the engine's actual call shape ------------------------------

const rangeRes = await localFetch(virtualUrl("model.safetensors"), {
  headers: { Range: "bytes=0-7" },
});
eq("range: status 206", rangeRes.status, 206);
eq("range: content-range", rangeRes.headers.get("content-range"), `bytes 0-7/${SIZE}`);
const head8 = new Uint8Array(await rangeRes.arrayBuffer());
eq("range: length", head8.length, 8);
check("range: bytes match", bytesEqual(head8, payload.subarray(0, 8)), "first 8 bytes differ");

// Mid-buffer window.
const mid = await localFetch(virtualUrl("model.safetensors"), { headers: { Range: "bytes=1000-1999" } });
const midBytes = new Uint8Array(await mid.arrayBuffer());
eq("range: mid length", midBytes.length, 1000);
check("range: mid bytes match", bytesEqual(midBytes, payload.subarray(1000, 2000)), "mid window differs");

// Single byte at the very end.
const lastByte = await localFetch(virtualUrl("model.safetensors"), {
  headers: { Range: `bytes=${SIZE - 1}-${SIZE - 1}` },
});
const lastBytes = new Uint8Array(await lastByte.arrayBuffer());
eq("range: last byte length", lastBytes.length, 1);
eq("range: last byte value", lastBytes[0], payload[SIZE - 1]);

// Open-ended range (engine's `bytes=a-` form).
const openEnded = await localFetch(virtualUrl("model.safetensors"), {
  headers: { Range: `bytes=${SIZE - 4}-` },
});
eq("range: open-ended length", new Uint8Array(await openEnded.arrayBuffer()).length, 4);

// Suffix range.
const suffix = await localFetch(virtualUrl("model.safetensors"), { headers: { Range: "bytes=-16" } });
const suffixBytes = new Uint8Array(await suffix.arrayBuffer());
eq("range: suffix length", suffixBytes.length, 16);
check("range: suffix bytes match", bytesEqual(suffixBytes, payload.subarray(SIZE - 16)), "suffix differs");

// A range that overruns EOF must clamp, not throw (browsers do the same).
const overrun = await localFetch(virtualUrl("model.safetensors"), {
  headers: { Range: `bytes=${SIZE - 10}-999999` },
});
eq("range: overrun clamps to EOF", new Uint8Array(await overrun.arrayBuffer()).length, 10);

// ReadableStream body must be usable — the engine's progress reader walks it.
const streamed = await localFetch(virtualUrl("model.safetensors"), { headers: { Range: "bytes=0-255" } });
check("range: exposes a readable body", typeof streamed.body?.getReader === "function");
const reader = streamed.body.getReader();
let streamedBytes = 0;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  streamedBytes += value.length;
}
eq("range: streamed byte count", streamedBytes, 256);

// --- full GET ----------------------------------------------------------------

const whole = await localFetch(virtualUrl("model.safetensors"));
eq("full: status 200", whole.status, 200);
eq("full: content-length", whole.headers.get("content-length"), String(SIZE));
eq("full: arrayBuffer length", (await whole.arrayBuffer()).byteLength, SIZE);

// --- error behaviour --------------------------------------------------------

let threw = false;
try {
  await localFetch(virtualUrl("missing.safetensors"));
} catch {
  threw = true;
}
check("virtual miss throws (never silently goes to the network)", threw);

const plainMiss = await localFetch("https://esm.sh/marked@17");
eq("non-virtual miss falls back", await plainMiss.text(), "network");

// Abort must surface as AbortError, like the real fetch.
const controller = new AbortController();
controller.abort();
let abortName = null;
try {
  await localFetch(virtualUrl("model.safetensors"), { signal: controller.signal });
} catch (err) {
  abortName = err.name;
}
eq("aborted signal throws AbortError", abortName, "AbortError");

// --- concurrency (the engine issues 4 parallel 128 MiB reads) ----------------

const slices = await Promise.all(
  [0, 1, 2, 3].map((i) =>
    localFetch(virtualUrl("model.safetensors"), {
      headers: { Range: `bytes=${i * 16384}-${(i + 1) * 16384 - 1}` },
    }).then((r) => r.arrayBuffer().then((b) => new Uint8Array(b)))
  )
);
check(
  "concurrency: 4 parallel ranges are byte-exact",
  slices.every((s, i) => bytesEqual(s, payload.subarray(i * 16384, (i + 1) * 16384))),
  "parallel slices differ"
);

// --- report ------------------------------------------------------------------

console.log(`\nasset-fetch: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("asset-fetch: all green");
