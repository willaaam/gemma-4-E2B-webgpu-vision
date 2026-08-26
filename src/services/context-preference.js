// Shared workstation context limit — global top-bar control.
// Persists to localStorage and mirrors research's previous key for backwards compat.

export const CONTEXT_LIMIT_KEY = "ws-context-limit";
export const LEGACY_KEY = "ws-research-context-limit";
export const CONTEXT_LIMIT_OPTIONS = [8192, 16384, 32768, 65536, 131072];

const listeners = new Set();

function readRaw() {
  try {
    let v = localStorage.getItem(CONTEXT_LIMIT_KEY);
    if (v == null) v = localStorage.getItem(LEGACY_KEY);
    if (v == null) return "auto";
    if (v === "auto") return "auto";
    const n = Number(v);
    return CONTEXT_LIMIT_OPTIONS.includes(n) ? String(n) : "auto";
  } catch { return "auto"; }
}

let current = readRaw();

export function getContextLimitPreference() {
  return current;
}

export function setContextLimitPreference(value) {
  const next = value === "auto" ? "auto" : CONTEXT_LIMIT_OPTIONS.includes(Number(value)) ? String(Number(value)) : "auto";
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
