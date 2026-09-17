// Shared workstation context limit — global top-bar control.
// Persists to localStorage and mirrors research's previous key for backwards compat.

export const CONTEXT_LIMIT_KEY = "ws-context-limit";
export const LEGACY_KEY = "ws-research-context-limit";
export const MIGRATION_KEY = "ws-context-limit-default-32k";
export const CONTEXT_LIMIT_OPTIONS = [8192, 16384, 32768, 65536, 131072];

// The shared default. 32K keeps prompts and the KV cache modest on device;
// Auto (the device maximum) and bigger caps stay selectable in the top bar.
export const DEFAULT_CONTEXT_LIMIT = 32768;
export const DEFAULT_CONTEXT_LIMIT_VALUE = String(DEFAULT_CONTEXT_LIMIT);

const listeners = new Set();

function readRaw() {
  try {
    let v = localStorage.getItem(CONTEXT_LIMIT_KEY);
    if (v == null) v = localStorage.getItem(LEGACY_KEY);
    if (v == null) return DEFAULT_CONTEXT_LIMIT_VALUE;
    if (v === "auto") return "auto"; // explicit choice since the reset below
    const n = Number(v);
    return CONTEXT_LIMIT_OPTIONS.includes(n) ? String(n) : DEFAULT_CONTEXT_LIMIT_VALUE;
  } catch { return DEFAULT_CONTEXT_LIMIT_VALUE; }
}

// One-time reset to the new default: profiles created under the old "auto"
// default (i.e. everything up to 128K) would otherwise never see 32K. The flag
// makes this run exactly once, so a later explicit choice of Auto, 8K, 16K,
// 64K or 128K survives every reload.
function migrateDefault() {
  try {
    if (localStorage.getItem(MIGRATION_KEY) === "1") return;
    localStorage.setItem(CONTEXT_LIMIT_KEY, DEFAULT_CONTEXT_LIMIT_VALUE);
    localStorage.setItem(LEGACY_KEY, DEFAULT_CONTEXT_LIMIT_VALUE);
    localStorage.setItem(MIGRATION_KEY, "1");
  } catch {}
}

migrateDefault();

let current = readRaw();

export function getContextLimitPreference() {
  return current;
}

export function setContextLimitPreference(value) {
  const next = value === "auto"
    ? "auto"
    : CONTEXT_LIMIT_OPTIONS.includes(Number(value))
      ? String(Number(value))
      : DEFAULT_CONTEXT_LIMIT_VALUE;
  current = next;
  try {
    localStorage.setItem(CONTEXT_LIMIT_KEY, next);
    // keep legacy in sync so old research check doesn't desync on rollback
    localStorage.setItem(LEGACY_KEY, next);
  } catch {}
  for (const fn of listeners) fn(next);
}

export function onContextLimitChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function selectedContextLimit(architectural) {
  const arch = Number(architectural) || 131072;
  if (current === "auto") return arch;
  return Math.min(arch, Number(current));
}

export function contextLimitLabel(value) {
  if (value === "auto" || value == null) return "Auto";
  const n = Number(value);
  if (!Number.isFinite(n)) return "Auto";
  return `${(n / 1024).toLocaleString()}K`;
}
