// Tiny app-wide settings (localStorage-backed for synchronous access at boot,
// mirrored to IndexedDB settings store opportunistically by callers).
//
// Currently: global Thinking mode — injects the <|think|> system token for
// EVERY app (chat, research Q&A, report stages, code agent), since greedy decode
// benefits from explicit reasoning on all but trivial tasks.

const KEY = "ws-thinking";

const listeners = new Set();

export function getThinking() {
  try { return localStorage.getItem(KEY) !== "0"; } catch { return true; }
}

export function setThinking(value) {
  try { localStorage.setItem(KEY, value ? "1" : "0"); } catch {}
  for (const fn of listeners) fn(!!value);
}

export function onThinking(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Prepend the think token to a message array when enabled.
export function thinkMessages(messages) {
  return getThinking() ? [{ role: "system", content: "<|think|>" }, ...messages] : messages;
}
