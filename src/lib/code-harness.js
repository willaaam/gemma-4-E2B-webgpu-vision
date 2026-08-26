// Agentic harness for the code workspace.
// Mirrors OpenCode/Codex: JSON tool protocol, BM25-backed context stuffing,
// reasoning via <|think|> and history compaction.

import { complete } from "../services/generation.js";
import { thinkMessages } from "../services/settings.js";
import { chunkText, BM25Index, estTokens, RESPONSE_TOKEN_RESERVE } from "../services/context.js";
import { modelService } from "../services/model-service.js";
import { getContextLimitPreference, selectedContextLimit } from "../services/context-preference.js";

// ---- Tool spec (shared with model prompt) ----

export const CODE_TOOLS = [
  { name: "list_files", description: "List all file paths. Optional dir arg filters by prefix.", args: { dir: "string?" } },
  { name: "read_file", description: "Read file content by path.", args: { path: "string" } },
  { name: "write_file", description: "Create or overwrite a file (creates folders implicitly).", args: { path: "string", content: "string" } },
  { name: "edit_file", description: "Exact string replacement. Replaces old_text with new_text inside path; must include at least 20 chars of surrounding context for safety.", args: { path: "string", old_text: "string", new_text: "string" } },
  { name: "delete_file", description: "Delete file at path.", args: { path: "string" } },
  { name: "mkdir", description: "Create a folder (creates .gitkeep).", args: { path: "string" } },
  { name: "search", description: "Keyword search across the codebase (BM25). Returns matching snippets.", args: { query: "string", k: "number?" } },
  { name: "run_python", description: "Execute a Python file in Pyodide (or inline code if path empty but code arg given). Returns stdout/stderr/result.", args: { path: "string?", code: "string?" } },
  { name: "run_web", description: "Render web entry (index.html etc.) in the sandboxed preview and return console output.", args: { entry: "string?" } },
  { name: "install_package", description: "Install Python package via micropip/PyPI in the Pyodide runtime.", args: { name: "string" } },
];

function toolSpecPrompt() {
  return CODE_TOOLS.map(t => {
    const args = Object.entries(t.args).map(([k, ty]) => `${k}: ${ty}`).join(", ");
    return `- ${t.name}(${args}) — ${t.description}`;
  }).join("\n");
}

// ---- JSON extraction ----

export function extractToolCalls(text) {
  // Find all ```tool fences; each should contain JSON {name, args}
  const re = /```tool\s*\r?\n([\s\S]*?)```/g;
  const out = [];
  let m;
  while ((m = re.exec(String(text || "")))) {
    const body = m[1].trim();
    try {
      const obj = JSON.parse(body);
      if (obj && typeof obj.name === "string") out.push(obj);
      else if (Array.isArray(obj)) for (const o of obj) if (o?.name) out.push(o);
    } catch {
      // try last-resort: object without wrapping
      try {
        const fixed = body.replace(/'/g, '"');
        const obj2 = JSON.parse(fixed);
        if (obj2?.name) out.push(obj2);
      } catch {}
    }
  }
  // Also support naked JSON lines that look like tool calls (no fence) — last attempt for small models
  if (out.length === 0) {
    const jsonRe = /\{\s*"name"\s*:\s*"(\w+)"[\s\S]*?\}/g;
    let mm;
    while ((mm = jsonRe.exec(String(text || "")))) {
      try { const o = JSON.parse(mm[0]); if (o?.name) out.push(o); } catch {}
    }
    // De-duplicate if we found only naked and fence missing
    if (out.length > 3) out.splice(3); // cap abuse
  }
  return out;
}

export function hasAnswer(text) {
  const t = String(text || "");
  return /```answer/i.test(t) || /\bDONE\b/.test(t);
}

export function extractAnswer(text) {
  const src = String(text || "");
  const m = src.match(/```answer\s*\r?\n([\s\S]*?)```/i);
  if (m) return m[1].trim();
  // fallback: text after DONE marker
  const doneIdx = src.search(/\bDONE\b/);
  if (doneIdx !== -1) return src.slice(0, doneIdx).trim();
  return src.trim();
}

// ---- Context budgeting for files ----

function tokenCounterForModel() {
  const model = modelService.model;
  if (model?.countTextTokens) return (t) => Math.max(0, Math.ceil(Number(model.countTextTokens(t)) || 0)) + 8;
  return estTokens;
}

export function buildCodeContext({ project, query, budget }) {
  const countTokens = tokenCounterForModel();
  const docs = project.listFiles().map(f => ({ id: f.path, name: f.path, text: f.content, chunks: chunkText(f.content) }));
  if (docs.length === 0) return { mode: "none", blocks: [], estTokensUsed: 0, budgetTokens: budget };

  // Use existing buildContext logic but with file docs
  // Import dynamically to avoid circular? Reimplement small variant.
  const total = docs.reduce((s, d) => s + countTokens(d.text), 0);
  if (total <= budget) {
    return { mode: "stuff", blocks: docs.map(d => ({ label: d.name, provenance: "full file", text: d.text })), estTokensUsed: total, budgetTokens: budget };
  }
  // BM25 over chunks
  const idx = new BM25Index();
  for (const d of docs) {
    for (let i = 0; i < d.chunks.length; i++) idx.add(d.chunks[i], { docName: d.name, chunk: i + 1, of: d.chunks.length });
  }
  const hits = idx.search(query || "", 12);
  if (hits.length === 0) {
    // head truncation
    const blocks = [];
    let used = 0;
    for (const d of docs.slice(0, 4)) {
      const text = d.text.slice(0, 6000);
      const fits = countTokens(text) <= (budget - used);
      const clipped = fits ? text : text.slice(0, Math.max(0, (budget - used) * 4));
      if (!clipped) break;
      blocks.push({ label: d.name, provenance: "head (no keyword match)", text: clipped });
      used += countTokens(clipped);
      if (used >= budget) break;
    }
    return { mode: "bm25", blocks, estTokensUsed: used, budgetTokens: budget, truncated: true };
  }
  const blocks = [];
  let used = 0;
  for (const h of hits) {
    const avail = budget - used;
    if (avail <= 16) break;
    let text = h.text;
    if (countTokens(text) > avail) {
      // truncate by chars (approx)
      text = text.slice(0, Math.max(0, avail * 4));
    }
    blocks.push({ label: `${h.meta.docName} · chunk ${h.meta.chunk}/${h.meta.of}`, provenance: `BM25 score ${h.score.toFixed(2)}`, text });
    used += countTokens(text);
    if (used >= budget) break;
  }
  return { mode: "bm25", blocks, estTokensUsed: used, budgetTokens: budget, truncated: blocks.length < hits.length };
}

function renderCodeContextBlocks(blocks) {
  return blocks.map((b, i) => `[File ${i + 1}: ${b.label} — ${b.provenance}]\n${b.text}`).join("\n\n---\n\n");
}

// ---- History compaction ----

async function countTokensForMessages(messages) {
  const model = modelService.model;
  if (model?.countPromptTokens) {
    try { return Math.max(0, Math.floor(Number(await model.countPromptTokens(messages)) || 0)); } catch {}
  }
  // fallback char estimate
  let chars = 0;
  for (const m of messages) {
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    chars += c.length;
  }
  return Math.ceil(chars * 0.25);
}

async function summarizeHistory(messagesToSummarize, signal) {
  const prompt = `Summarize this coding session history concisely for a code agent. Preserve:
- file paths that were read/written/edited and their intent
- tool results and any errors/stack traces (keep salient lines)
- user requests
Keep under 900 tokens. Output plain markdown, no code fences.`;
  const body = messagesToSummarize.map(m => `${m.role.toUpperCase()}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content).slice(0, 6000)}`).join("\n\n---\n\n").slice(0, 24000);
  try {
    const res = await complete({
      messages: thinkMessages([{ role: "user", content: `${prompt}\n\nHISTORY:\n${body}` }]),
      owner: "code-summarize",
      maxNewTokens: 900,
      signal,
      skipLock: true,
    });
    const text = (res.answerText || res.reply || "").trim();
    if (text) return text;
  } catch {}
  // fallback: truncate oldest
  return messagesToSummarize.slice(-2).map(m => `${m.role}: ${(String(m.content).slice(0, 400))}`).join("\n");
}

export async function compactHistoryIfNeeded({ messages, systemPrompt, effectiveLimit, signal }) {
  // Keep system prompt out of history for counting? Provide helper.
  const reserve = RESPONSE_TOKEN_RESERVE + 1;
  // we want messages + systemPrompt to fit in effectiveLimit
  const base = [{ role: "system", content: systemPrompt }];
  let withSystem = [...base, ...messages];
  let tokens = await countTokensForMessages(thinkMessages(withSystem));
  if (tokens + 512 <= effectiveLimit) return { messages, compacted: false };
  // need compaction: keep last 4 turns verbatim, summarize the rest
  const keepTail = Math.min(8, messages.length); // keep last 8 messages (~4 turns)
  const head = messages.slice(0, Math.max(0, messages.length - keepTail));
  if (head.length === 0) {
    // still too large even with tail — truncate head content
    return { messages: messages.slice(-keepTail), compacted: true, note: "history truncated (even tail exceeds limit)" };
  }
  const summary = await summarizeHistory(head, signal);
  const compacted = [
    { role: "user", content: `[Conversation summary of first ${head.length} messages — older context compressed]\n${summary}` },
    { role: "assistant", content: "Acknowledged. Continuing with summarized history." },
    ...messages.slice(-keepTail),
  ];
  return { messages: compacted, compacted: true };
}

// ---- Main harness loop ----

export async function runCodeHarness({
  project,
  task,
  selection, // { path, text } optional
  history = [],
  signal,
  maxSteps = 12,
  onEvent, // {type, ...}
  executors, // { listFiles, readFile, writeFile, editFile, deleteFile, mkdir, search, runPython, runWeb, installPackage }
}) {
  const arch = Number(modelService.capabilities?.architecturalMax) || 131072;
  const effectiveRaw = Number(modelService.capabilities?.effectiveContextMax) || arch;
  const contextLimit = selectedContextLimit(arch);
  const effectiveLimit = Math.min(effectiveRaw, contextLimit);

  let messages = [...history]; // {role, content}
  // Prepare initial context block for system prompt
  const countTokens = tokenCounterForModel();

  async function buildSystemPrompt() {
    // Budget for files = effectiveLimit - estimated prompt tokens for history+task - reserve
    // Estimate via counting
    const prelim = thinkMessages([{ role: "system", content: "__placeholder__" }, ...messages, { role: "user", content: task }]);
    const prelimTokens = await countTokensForMessages(prelim);
    const fileBudget = Math.max(800, effectiveLimit - prelimTokens - RESPONSE_TOKEN_RESERVE - 800);
    const ctx = buildCodeContext({ project, query: task + (selection?.text ? " " + selection.text.slice(0, 400) : ""), budget: fileBudget });
    const filesBlock = ctx.blocks.length ? renderCodeContextBlocks(ctx.blocks) : "(no files in project)";
    const modeNote = ctx.mode === "bm25" ? "Some files were retrieved via keyword search because the codebase exceeds the token budget." : ctx.mode === "stuff" ? "All files are included." : "Project is empty.";
    const selectionBlock = selection?.text
      ? `\n\n=== SELECTED CODE (user highlighted in ${selection.path}) ===\n\`\`\`\n${selection.text.slice(0, 6000)}\n\`\`\``
      : "";

    const sys = [
      "You are an agentic coding assistant in a browser IDE. You have tools to read/write/search/run code.",
      "HARNESS RULES — follow exactly:",
      "1. You MUST act via JSON tool calls in ```tool fences. One tool per fence, but you may emit up to 3 consecutive fences before waiting for results.",
      "2. Available tools:",
      toolSpecPrompt(),
      "3. To finish, emit ```answer fence with a summary of what you did (including files changed and how to run). Also write DONE on its own line.",
      "4. Prefer small, safe edits. Use `edit_file` with exact old_text when changing existing files.",
      "5. Always `read_file` before `edit_file`.",
      "6. Use `search` to locate code before editing large projects.",
      "7. After writing Python, call `run_python` to verify; after writing Web files, call `run_web`.",
      "",
      `PROJECT CONTEXT (${modeNote} — ${ctx.estTokensUsed.toLocaleString()} tokens, budget ${ctx.budgetTokens.toLocaleString()}):`,
      filesBlock,
      selectionBlock,
      "",
      `Context window: ${effectiveLimit.toLocaleString()} tokens effective, ${arch.toLocaleString()} architectural (user cap ${contextLimit.toLocaleString()}). Do not exceed it.`,
    ].join("\n");
    return { sys, ctx };
  }

  let { sys: systemPrompt } = await buildSystemPrompt();
  let allMessagesForModel = [{ role: "system", content: systemPrompt }, ...messages, { role: "user", content: task }];

  // Compact before starting if needed
  const compactPre = await compactHistoryIfNeeded({ messages: [...messages, { role: "user", content: task }], systemPrompt, effectiveLimit, signal });
  if (compactPre.compacted) {
    const lastUser = compactPre.messages[compactPre.messages.length - 1];
    const histWithoutLast = compactPre.messages.slice(0, -1);
    messages = histWithoutLast;
    allMessagesForModel = [{ role: "system", content: systemPrompt }, ...messages, lastUser];
    onEvent?.({ type: "compact", note: "History summarized to fit context window." });
  }

  const steps = [];
  let finalAnswer = "";

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) break;
    onEvent?.({ type: "step", step, of: maxSteps, effectiveLimit, contextLimit });

    // Ensure we still fit; rebuild system context every 3 steps or when files changed
    if (step > 1 && step % 3 === 1) {
      const rebuilt = await buildSystemPrompt();
      systemPrompt = rebuilt.sys;
      // replace first message
      allMessagesForModel[0] = { role: "system", content: systemPrompt };
    }

    // Compact if oversize mid-loop
    const countNow = await countTokensForMessages(thinkMessages(allMessagesForModel));
    if (countNow + RESPONSE_TOKEN_RESERVE + 1 > effectiveLimit) {
      // Remove oldest non-system turns until fits or summarize
      const withoutSystem = allMessagesForModel.slice(1);
      const compacted = await compactHistoryIfNeeded({ messages: withoutSystem, systemPrompt, effectiveLimit, signal });
      if (compacted.compacted) {
        allMessagesForModel = [{ role: "system", content: systemPrompt }, ...compacted.messages];
        onEvent?.({ type: "compact", note: "Mid-loop compaction performed." });
      } else {
        // still over — truncate system files block? This is last resort
        onEvent?.({ type: "warn", message: "Context still large after compaction; truncating file context." });
      }
    }

    const turn = await complete({
      messages: thinkMessages(allMessagesForModel),
      owner: "code-harness",
      signal,
      maxNewTokens: 1600,
      contextMax: contextLimit,
      skipLock: true,
    });

    const answerText = turn.answerText || turn.reply || "";
    const raw = answerText || turn.reply || "";
    onEvent?.({ type: "model_raw", step, raw, thinking: turn.thinkingText || "" });

    if (hasAnswer(raw)) {
      finalAnswer = extractAnswer(raw);
      allMessagesForModel.push({ role: "assistant", content: raw });
      onEvent?.({ type: "answer", step, answer: finalAnswer });
      return { ok: true, steps, answer: finalAnswer, allMessages: allMessagesForModel };
    }

    const calls = extractToolCalls(raw);
    if (calls.length === 0) {
      // No tool, no answer — nudge
      const nudge = "You must either emit ```tool JSON fences to act, or ```answer fence to finish. Do not output bare prose.";
      allMessagesForModel.push({ role: "assistant", content: raw });
      allMessagesForModel.push({ role: "user", content: nudge });
      onEvent?.({ type: "nudge", step });
      continue;
    }

    allMessagesForModel.push({ role: "assistant", content: raw });
    const results = [];
    for (const call of calls.slice(0, 3)) {
      onEvent?.({ type: "tool_call", step, call });
      const res = await executeTool(call, executors, project);
      results.push(res);
      onEvent?.({ type: "tool_result", step, call, result: res });
    }
    const observation = results.map(r => `[tool ${r.name} ${r.ok ? "OK" : "ERR"}]\n${truncate(r.output, 5000)}`).join("\n\n---\n\n");
    allMessagesForModel.push({ role: "user", content: observation });
    steps.push({ step, calls, results });
    // after tool results, loop continues
    // Heuristic: if all tools succeeded and we ran code, ask model to check
    onEvent?.({ type: "observation", step, observation });
  }

  // Exhausted steps without answer — return best-effort
  return { ok: false, steps, answer: finalAnswer, allMessages: allMessagesForModel, truncated: true };
}

async function executeTool(call, executors, project) {
  const name = call.name;
  const args = call.args || call.arguments || {};
  try {
    switch (name) {
      case "list_files": {
        const dir = args.dir ? String(args.dir).replace(/^\//, "") : "";
        const paths = project.listPaths().filter(p => !dir || p === dir || p.startsWith(dir + "/"));
        return { name, ok: true, output: paths.length ? paths.join("\n") : "(empty)" };
      }
      case "read_file": {
        const path = String(args.path || "");
        if (!path) throw new Error("path required");
        const content = project.getContent(path);
        if (content == null) throw new Error(`Not found: ${path}`);
        return { name, ok: true, output: `File: ${path}\n\`\`\`\n${content.slice(0, 20000)}\n\`\`\`` };
      }
      case "write_file": {
        const path = String(args.path || "");
        const content = String(args.content ?? "");
        if (!path) throw new Error("path required");
        // delegate to executor so it can persist + notify
        const res = await executors.writeFile?.(path, content);
        if (res && res.ok === false) throw new Error(res.error || "write failed");
        return { name, ok: true, output: `Wrote ${path} (${content.length} chars)` };
      }
      case "edit_file": {
        const path = String(args.path || "");
        const oldText = String(args.old_text ?? args.oldText ?? "");
        const newText = String(args.new_text ?? args.newText ?? "");
        if (!path) throw new Error("path required");
        if (!oldText) throw new Error("old_text required (exact context)");
        const cur = project.getContent(path);
        if (cur == null) throw new Error(`Not found: ${path}`);
        if (!cur.includes(oldText)) throw new Error(`old_text not found verbatim in ${path} — copy exact whitespace.`);
        const next = cur.replace(oldText, newText);
        await executors.writeFile?.(path, next);
        return { name, ok: true, output: `Edited ${path} (${oldText.length} → ${newText.length} chars)` };
      }
      case "delete_file": {
        const path = String(args.path || "");
        if (!path) throw new Error("path required");
        await executors.deleteFile?.(path);
        return { name, ok: true, output: `Deleted ${path}` };
      }
      case "mkdir": {
        const path = String(args.path || "");
        if (!path) throw new Error("path required");
        await executors.mkdir?.(path);
        return { name, ok: true, output: `Created folder ${path}` };
      }
      case "search": {
        const q = String(args.query || "");
        const k = Math.min(20, Math.max(1, Number(args.k) || 8));
        const hits = await executors.search?.(q, k);
        if (!hits) throw new Error("search not available");
        return { name, ok: true, output: typeof hits === "string" ? hits : JSON.stringify(hits, null, 2) };
      }
      case "run_python": {
        const path = args.path ? String(args.path) : "";
        const code = args.code ? String(args.code) : "";
        const r = await executors.runPython?.(path || code, { code: code || null, path: path || null });
        if (!r) throw new Error("runPython not available");
        const parts = [];
        if (r.stdout) parts.push(`stdout:\n${truncate(r.stdout, 4000)}`);
        if (r.result) parts.push(`result: ${truncate(String(r.result), 1000)}`);
        if (r.stderr) parts.push(`stderr:\n${truncate(r.stderr, 3000)}`);
        if (r.error) parts.push(`error: ${truncate(String(r.error), 3000)}`);
        if (r.plots?.length) parts.push(`plots: ${r.plots.length} image(s)`);
        parts.push(r.ok ? "exit: success" : "exit: FAILURE");
        return { name, ok: !!r.ok, output: parts.join("\n") };
      }
      case "run_web": {
        const entry = args.entry ? String(args.entry) : "index.html";
        const r = await executors.runWeb?.(entry);
        if (!r) throw new Error("runWeb not available");
        return { name, ok: !!r.ok, output: r.log ? `console:\n${truncate(r.log, 4000)}` : r.output || "preview updated" };
      }
      case "install_package": {
        const pkg = String(args.name || args.package || "");
        if (!pkg) throw new Error("name required");
        const r = await executors.installPackage?.(pkg);
        return { name, ok: !!r?.ok, output: r?.output || `${pkg} installed` };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return { name, ok: false, output: `Error: ${String(err?.message ?? err)}` };
  }
}

function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more chars)` : s;
}
