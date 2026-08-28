// Shared workstation temperature — global top-bar control.
// Persists to localStorage. Controls sampling temperature for all apps.

export const TEMPERATURE_KEY = "ws-temperature";
export const TEMPERATURE_OPTIONS = [0.2, 0.4, 0.7, 1.0, 1.3];
export const DEFAULT_TEMPERATURE = 0.7;

const listeners = new Set();

function readRaw() {
  try {
    const v = localStorage.getItem(TEMPERATURE_KEY);
    if (v == null) return String(DEFAULT_TEMPERATURE);
    const n = Number(v);
    return TEMPERATURE_OPTIONS.includes(n) ? String(n) : String(DEFAULT_TEMPERATURE);
  } catch { return String(DEFAULT_TEMPERATURE); }
}

let current = readRaw();

export function getTemperaturePreference() {
  const n = Number(current);
  return Number.isFinite(n) ? n : DEFAULT_TEMPERATURE;
}

export function getTemperaturePreferenceRaw() {
  return current;
}

export function setTemperaturePreference(value) {
  const n = Number(value);
  const next = TEMPERATURE_OPTIONS.includes(n) ? String(n) : String(DEFAULT_TEMPERATURE);
  current = next;
  try { localStorage.setItem(TEMPERATURE_KEY, next); } catch {}
  for (const fn of listeners) fn(Number(next));
}

export function onTemperatureChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function temperatureLabel(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(DEFAULT_TEMPERATURE);
  return n.toFixed(1);
}

export function temperatureHint(value) {
  const n = Number(value);
  if (n <= 0.3) return "Precise";
  if (n <= 0.5) return "Focused";
  if (n <= 0.8) return "Balanced";
  if (n <= 1.1) return "Creative";
  return "Very creative";
}
