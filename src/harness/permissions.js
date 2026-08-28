// Permission model — Opencode-inspired but with a single toggle.
// Toggle key: ws-code-auto-approve  ("1" = auto, "0" = ask)
//   - auto: read/search/list always auto; write/patch/mkdir/delete/run also auto
//   - ask (default? toggle decides): write/patch/mkdir/delete/run require explicit allow
// The toggle is exposed in the Agent pane header; harness checks getAutoApprove() each call.

const TOGGLE_KEY = "ws-code-auto-approve";
const ASK_KEY = "ws-code-ask-dismissed"; // not used but reserved

export function getAutoApprove() {
  try {
    const v = localStorage.getItem(TOGGLE_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
    // default: ask (false) — safer; user can flip toggle on
    return false;
  } catch { return false; }
}

export function setAutoApprove(value) {
  try { localStorage.setItem(TOGGLE_KEY, value ? "1" : "0"); } catch {}
  // broadcast for listeners in same tab
  try { window.dispatchEvent(new CustomEvent("ws:code-auto-approve", { detail: { auto: !!value } })); } catch {}
}

export function onAutoApproveChange(fn) {
  const handler = (e) => fn(!!e.detail?.auto);
  window.addEventListener("ws:code-auto-approve", handler);
  const storageHandler = (e) => { if (e.key === TOGGLE_KEY) fn(e.newValue === "1"); };
  window.addEventListener("storage", storageHandler);
  return () => {
    window.removeEventListener("ws:code-auto-approve", handler);
    window.removeEventListener("storage", storageHandler);
  };
}

// Classify tools by risk. Mirrors the registry risk field but kept here for quick lookup
// without importing registry (avoid circular).
const AUTO_TOOLS = new Set(["list_files", "read_file", "search"]);
const MUTATING_TOOLS = new Set(["write_file", "append_file", "apply_patch", "delete_file", "mkdir", "run_python", "run_web", "install_package"]);

export function permissionFor(toolName) {
  if (AUTO_TOOLS.has(toolName)) return "auto";
  if (MUTATING_TOOLS.has(toolName)) return getAutoApprove() ? "auto" : "ask";
  return getAutoApprove() ? "auto" : "ask";
}

export function isMutating(toolName) {
  return MUTATING_TOOLS.has(toolName);
}
