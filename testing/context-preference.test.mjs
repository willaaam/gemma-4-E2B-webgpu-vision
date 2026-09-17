// testing/context-preference.test.mjs — Node unit tests for the shared context
// limit preference: the 32K default and the one-time migration that moves
// existing profiles onto it.
//
// The module reads localStorage at import time, so every case installs a fake
// storage and imports a fresh copy of the module (cache-busted query string).
//
// Usage: node testing/context-preference.test.mjs

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const MODULE_PATH = pathToFileURL(resolve("src/services/context-preference.js")).href;

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial).map(([k, v]) => [k, String(v)]));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    snapshot: () => Object.fromEntries(map),
  };
}

let caseId = 0;
async function load(storage) {
  if (storage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = storage;
  return import(`${MODULE_PATH}?case=${++caseId}`);
}

// --- fresh profile -----------------------------------------------------------

{
  const storage = makeStorage();
  const m = await load(storage);
  eq("fresh: default constant", m.DEFAULT_CONTEXT_LIMIT, 32768);
  eq("fresh: preference defaults to 32K", m.getContextLimitPreference(), "32768");
  eq("fresh: caps the effective window", m.selectedContextLimit(131072), 32768);
  eq("fresh: label", m.contextLimitLabel(m.getContextLimitPreference()), "32K");
  eq("fresh: primary key seeded", storage.getItem(m.CONTEXT_LIMIT_KEY), "32768");
  eq("fresh: legacy key seeded", storage.getItem(m.LEGACY_KEY), "32768");
  eq("fresh: migration flag recorded", storage.getItem(m.MIGRATION_KEY), "1");
  eq("fresh: options keep the higher caps", m.CONTEXT_LIMIT_OPTIONS.join(","), "8192,16384,32768,65536,131072");
}

// --- the one-time migration --------------------------------------------------

for (const stored of ["auto", "65536", "131072"]) {
  const storage = makeStorage({ "ws-context-limit": stored });
  const m = await load(storage);
  eq(`migrate: stored "${stored}" is reset to 32K`, m.getContextLimitPreference(), "32768");
}

{
  // Profiles that only ever wrote the legacy research key.
  const storage = makeStorage({ "ws-research-context-limit": "131072" });
  const m = await load(storage);
  eq("migrate: legacy-only profile is reset to 32K", m.getContextLimitPreference(), "32768");
  eq("migrate: legacy key is synced", storage.getItem("ws-research-context-limit"), "32768");
}

{
  // The reset must happen exactly once: a choice made afterwards survives reloads.
  const storage = makeStorage({ "ws-context-limit": "65536" });
  const first = await load(storage);
  eq("migrate once: first load is 32K", first.getContextLimitPreference(), "32768");
  first.setContextLimitPreference("65536");
  const second = await load(storage); // simulated reload, same storage
  eq("migrate once: a later 64K choice survives the reload", second.getContextLimitPreference(), "65536");
  eq("migrate once: selectedContextLimit honours it", second.selectedContextLimit(131072), 65536);
}

{
  const storage = makeStorage();
  const first = await load(storage);
  first.setContextLimitPreference("auto");
  const second = await load(storage);
  eq("migrate once: Auto chosen afterwards survives", second.getContextLimitPreference(), "auto");
  eq("auto: resolves to the device maximum", second.selectedContextLimit(131072), 131072);
  eq("auto: label", second.contextLimitLabel("auto"), "Auto");
}

// --- fallbacks ---------------------------------------------------------------

{
  const storage = makeStorage({ "ws-context-limit": "banana", "ws-context-limit-default-32k": "1" });
  const m = await load(storage);
  eq("invalid stored value falls back to the default", m.getContextLimitPreference(), "32768");
  eq("cap never exceeds the architecture", m.selectedContextLimit(8192), 8192);
  eq("unknown label", m.contextLimitLabel(undefined), "Auto");
}

// --- setter, mirroring and listeners ----------------------------------------

{
  const storage = makeStorage();
  const m = await load(storage);
  const seen = [];
  const off = m.onContextLimitChange((v) => seen.push(v));
  m.setContextLimitPreference("16384");
  eq("setter: value applied", m.getContextLimitPreference(), "16384");
  eq("setter: listener notified", seen.join(","), "16384");
  eq("setter: primary key written", storage.getItem(m.CONTEXT_LIMIT_KEY), "16384");
  eq("setter: legacy key mirrored", storage.getItem(m.LEGACY_KEY), "16384");
  m.setContextLimitPreference("nonsense");
  eq("setter: invalid argument falls back to the default", m.getContextLimitPreference(), "32768");
  eq("setter: listener saw the fallback", seen.join(","), "16384,32768");
  off();
  m.setContextLimitPreference("8192");
  eq("setter: unsubscribe stops notifications", seen.join(","), "16384,32768");
}

// --- environments without localStorage ---------------------------------------

{
  const m = await load(undefined);
  eq("no localStorage: still defaults to 32K", m.getContextLimitPreference(), "32768");
  m.setContextLimitPreference("8192");
  eq("no localStorage: in-memory value still updates", m.getContextLimitPreference(), "8192");
}

console.log(`\ncontext-preference: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("context-preference: all green");
