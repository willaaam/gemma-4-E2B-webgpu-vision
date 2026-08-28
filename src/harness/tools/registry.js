// Tool registry — lightweight Opencode pattern + Gemma 4 compatible.
// Each tool: { name, description, argsHint, permission, validate, execute }

import { applyUnifiedPatch, computeDiffPreview } from "../diff.js";
import { sanitizeFileContent } from "../parser.js";

export function defineTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    args: spec.args || {},
    permission: spec.permission || "auto",
    validate: spec.validate || (() => true),
    execute: spec.execute,
  };
}

function toArgHint(args) {
  return Object.entries(args || {}).map(([k, ty]) => `${k}: ${ty}`).join(", ");
}

export function toolSpecPrompt(tools) {
  return tools.map(t => {
    const entries = Object.entries(t.args || {});
    const properties = entries.map(([key, typeHint]) => {
      const type = String(typeHint).replace(/\?$/, "").toUpperCase();
      return `${key}:{description:<|"|>${key} parameter<|"|>,type:<|"|>${type}<|"|>}`;
    }).join(",");
    const required = entries
      .filter(([, typeHint]) => !String(typeHint).endsWith("?"))
      .map(([key]) => `<|"|>${key}<|"|>`)
      .join(",");
    const requiredPart = required ? `,required:[${required}]` : "";
    return `declaration:${t.name}{description:<|"|>${t.description}<|"|>,parameters:{properties:{${properties}}${requiredPart},type:<|"|>OBJECT<|"|>}}`;
  }).join("\n");
}


function normalizePathArg(args) {
  return String(args.path || args.filename || args.file || args.filepath || "").trim();
}

function normalizeEntryArg(args) {
  return String(args.entry || args.path || "").trim();
}

function normalizeContentArg(args) {
  if (!args || typeof args !== "object") return null;
  let c = args.content ?? args.code ?? args.text ?? args.body;
  if (c != null) {
    c = sanitizeFileContent(String(c));
    const contentKeys = new Set(["content", "code", "text", "body", "path", "filename", "file", "filepath", "patch", "diff"]);
    for (const [key, value] of Object.entries(args)) {
      if (contentKeys.has(key) || typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || !value.startsWith("=")) continue;
      c += `${/[\s,]$/.test(c) ? "" : ", "}${key}${value}`;
    }
    return c;
  }
  return null;
}


export function createTools({ project, executors }) {
  const tools = [
    defineTool({
      name: "list_files",
      description: "List all file paths. Optional dir arg filters by prefix. Use to discover project structure.",
      args: { dir: "string?" },
      permission: "auto",
      validate: () => true,
      execute: async (args) => {
        const dir = args.dir ? String(args.dir).replace(/^\//, "") : "";
        const paths = project.listPaths().filter(p => !p.endsWith("/.gitkeep") && p !== ".gitkeep").filter(p => !dir || p === dir || p.startsWith(dir + "/"));
        return { ok: true, output: paths.length ? paths.join("\n") : "(empty)" };
      }
    }),

    defineTool({
      name: "read_file",
      description: "Read file content by path. Returns file with fence. Use before patching.",
      args: { path: "string" },
      permission: "auto",
      validate: (a) => Boolean(normalizePathArg(a)),
      execute: async (args) => {
        const path = normalizePathArg(args);
        if (!path) throw new Error("path required");
        const content = project.getContent(path);
        if (content == null) throw new Error(`Not found: ${path}`);
        return { ok: true, output: `File: ${path}\n\`\`\`\n${content}\n\`\`\`` };
      }
    }),

    defineTool({
      name: "write_file",
      description: "Create or overwrite a file in the project. Args: path + content.",
      args: { path: "string", content: "string" },
      permission: "ask",
      validate: (a) => Boolean(normalizePathArg(a) && normalizeContentArg(a) !== null),
      execute: async (args) => {
        const path = normalizePathArg(args);
        const content = sanitizeFileContent(normalizeContentArg(args) ?? "");
        if (!path) throw new Error("path required");
        const res = await executors.writeFile?.(path, content);
        if (res && res.ok === false) throw new Error(res.error || "write failed");
        return { ok: true, output: `Wrote ${path} (${content.length} chars)` };
      }
    }),

    defineTool({
      name: "append_file",
      description: "Append continuation chunk to an existing file. Args: path + content.",
      args: { path: "string", content: "string" },
      permission: "ask",
      validate: (a) => Boolean(normalizePathArg(a) && normalizeContentArg(a)),
      execute: async (args) => {
        const path = normalizePathArg(args);
        const content = sanitizeFileContent(normalizeContentArg(args) ?? "");
        if (!path) throw new Error("path required");
        if (!content) throw new Error("content required");
        const current = project.getContent(path);
        if (current == null) throw new Error(`Not found: ${path} — use write_file for the first chunk`);
        if (current.endsWith(content)) return { ok: true, output: `Skipped duplicate chunk for ${path} (${current.length} chars total)` };
        const next = current + content;
        const res = await executors.writeFile?.(path, next);
        if (res && res.ok === false) throw new Error(res.error || "append failed");
        return { ok: true, output: `Appended ${path} (+${content.length} chars, ${next.length} total)` };
      }
    }),

    defineTool({
      name: "apply_patch",
      description: "Apply a unified diff patch to an existing file. Args: path + patch (with @@ hunks). Use after read_file.",
      args: { path: "string", patch: "string" },
      permission: "ask",
      validate: (a) => Boolean(normalizePathArg(a) && (a.patch || a.diff)),
      execute: async (args) => {
        const path = normalizePathArg(args);
        const patch = sanitizeFileContent(String(args.patch ?? args.diff ?? ""));
        if (!path) throw new Error("path required");
        if (!patch) throw new Error("patch required");
        const cur = project.getContent(path);
        if (cur == null) throw new Error(`Not found: ${path} — use write_file for new files`);
        let next;
        try {
          next = applyUnifiedPatch(cur, patch);
        } catch (e) {
          throw new Error(`Patch failed: ${e.message}. Hint: read_file first and copy exact context lines.`);
        }
        const diff = computeDiffPreview(cur, next);
        await executors.writeFile?.(path, next);
        return { ok: true, output: `Patched ${path} (${diff.removed}→${diff.added} lines)\n${diff.preview}` };
      }
    }),

    defineTool({
      name: "delete_file",
      description: "Delete file at path.",
      args: { path: "string" },
      permission: "ask",
      validate: (a) => Boolean(normalizePathArg(a)),
      execute: async (args) => {
        const path = normalizePathArg(args);
        if (!path) throw new Error("path required");
        await executors.deleteFile?.(path);
        return { ok: true, output: `Deleted ${path}` };
      }
    }),

    defineTool({
      name: "mkdir",
      description: "Create a folder.",
      args: { path: "string" },
      permission: "ask",
      validate: (a) => Boolean(normalizePathArg(a)),
      execute: async (args) => {
        const path = normalizePathArg(args);
        if (!path) throw new Error("path required");
        await executors.mkdir?.(path);
        return { ok: true, output: `Created folder ${path}` };
      }
    }),

    defineTool({
      name: "search",
      description: "Keyword search across the codebase. Returns matching snippets.",
      args: { query: "string", k: "number?" },
      permission: "auto",
      validate: (a) => typeof a.query === "string" && a.query.length > 0,
      execute: async (args) => {
        const q = String(args.query || "");
        const k = Math.min(20, Math.max(1, Number(args.k) || 8));
        const hits = await executors.search?.(q, k);
        if (hits == null) throw new Error("search not available");
        return { ok: true, output: typeof hits === "string" ? hits : JSON.stringify(hits, null, 2) };
      }
    }),

    defineTool({
      name: "run_python",
      description: "Execute or verify a Python file. Returns stdout/stderr/error. Safe verification mode runs without blocking interactive games.",
      args: { path: "string?", code: "string?" },
      permission: "ask",
      validate: () => true,
      execute: async (args) => {
        const path = normalizePathArg(args);
        const code = normalizeContentArg(args);
        const r = await executors.runPython?.(path || code, { code: code || null, path: path || null, nonInteractive: true });
        if (!r) throw new Error("runPython not available");
        const parts = [];
        if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
        if (r.result) parts.push(`result: ${r.result}`);
        if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
        if (r.error) parts.push(`error:\n${r.error}`);
        if (r.plots?.length) parts.push(`plots: ${r.plots.length} image(s)`);
        parts.push(r.ok ? "exit: execution completed successfully" : "exit: execution returned error");
        return { ok: !!r.ok, output: parts.join("\n") };
      }
    }),

    defineTool({
      name: "run_web",
      description: "Render web entry (index.html etc.) in preview and return console output.",
      args: { entry: "string?" },
      permission: "ask",
      validate: () => true,
      execute: async (args) => {
        const entry = normalizeEntryArg(args) || "index.html";
        const r = await executors.runWeb?.(entry);
        if (!r) throw new Error("runWeb not available");
        const output = r.log ? `console:\n${r.log}` : r.output || "preview updated";
        const probe = r.probe ? `\nprobe:\n${JSON.stringify(r.probe)}` : "";
        return { ok: !!r.ok, output: output + probe, log: r.log, error: r.error, probe: r.probe ?? null };
      }
    }),

    defineTool({
      name: "install_package",
      description: "Install Python package via micropip/PyPI in Pyodide.",
      args: { name: "string" },
      permission: "ask",
      validate: (a) => Boolean(a.name || a.package || a.pkg),
      execute: async (args) => {
        const pkg = String(args.name || args.package || args.pkg || "").trim();
        if (!pkg) throw new Error("package name required");
        const r = await executors.installPackage?.(pkg);
        return { ok: !!r?.ok, output: r?.output || `${pkg} installed` };
      }
    }),
  ];

  const byName = new Map(tools.map(t => [t.name, t]));
  return { tools, byName, toolSpecPrompt: toolSpecPrompt(tools) };
}


