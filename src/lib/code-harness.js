// Shim — legacy import path now delegates to src/harness.
// All logic lives in src/harness/** (parser, tools/registry, harness, permissions, diff).
// This file kept for backward compatibility; new code should import from src/harness/*.

export { runHarness as runCodeHarness, runHarness } from "../harness/harness.js";
export * from "../harness/parser.js";
export * from "../harness/context/bundler.js";
export { getAutoApprove, setAutoApprove, onAutoApproveChange } from "../harness/permissions.js";

// Legacy CODE_TOOLS alias (now replaced by registry). Kept for docs/tests.
export const CODE_TOOLS = [
  { name: "list_files", description: "List all file paths. Optional dir arg filters by prefix.", args: { dir: "string?" } },
  { name: "read_file", description: "Read file content by path.", args: { path: "string" } },
  { name: "write_file", description: "Create or overwrite a file.", args: { path: "string", content: "string" } },
  { name: "apply_patch", description: "Apply unified diff patch. Args: path + patch.", args: { path: "string", patch: "string" } },
  { name: "delete_file", description: "Delete file at path.", args: { path: "string" } },
  { name: "mkdir", description: "Create a folder.", args: { path: "string" } },
  { name: "search", description: "Keyword search (BM25 code-aware).", args: { query: "string", k: "number?" } },
  { name: "run_python", description: "Execute Python in Pyodide.", args: { path: "string?", code: "string?" } },
  { name: "run_web", description: "Render web entry in preview.", args: { entry: "string?" } },
  { name: "install_package", description: "Install Python package.", args: { name: "string" } },
];
