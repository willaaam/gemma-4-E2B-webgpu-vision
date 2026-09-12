const TOOL_NAMES = new Set([
  "write_file", "append_file", "apply_patch", "read_file", "list_files",
  "delete_file", "mkdir", "search", "run_python", "run_web", "install_package",
]);

const MAX_TASKS = 8;

let callId = 0;

function nextCallId() {
  callId += 1;
  return `call_${Date.now().toString(36)}_${callId}`;
}

function validToolName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  return TOOL_NAMES.has(normalized) ? normalized : null;
}

/**
 * Parse only the planner's answer channel. Thinking text is deliberately not
 * accepted here; the controller owns the channel split before calling this.
 */
export function parsePlan(text) {
  const source = String(text || "").replace(/\r/g, "");
  if (!source || /<tool\b|call:[A-Za-z0-9_]+\s*\{/i.test(source)) return [];

  const explicitPlan = /<plan\b[^>]*>|<\/plan>|^\s*plan\s*:/im.test(source);
  const checklist = /^\s*(?:[-*]|\d+[.)])\s*\[([ x/])\]\s*(.+?)\s*$/gim;
  const tasks = [];
  let match;
  while ((match = checklist.exec(source)) && tasks.length < MAX_TASKS) {
    const title = match[2].replace(/\s+/g, " ").trim();
    if (!title || title.length < 2 || title.length > 240) continue;
    tasks.push({
      id: `task_${tasks.length + 1}`,
      title,
      done: match[1].toLowerCase() === "x",
      inProgress: match[1] === "/",
    });
  }

  const contentLines = source.split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^plan\s*:?$/i.test(line) && !/^<\/?plan\s*>$/i.test(line));
  const checklistOnly = contentLines.length > 0 && contentLines.every(line => /^(?:[-*]|\d+[.)])\s*\[[ x/]\]\s*.+$/i.test(line));
  // A checklist-only answer is also a plan. This still rejects a random
  // checkbox embedded in prose or a file excerpt.
  return (explicitPlan || checklistOnly) ? tasks : [];
}

/** Parse one line-based tool block from the execution answer channel. */
export function parseToolCall(text) {
  const source = String(text || "").trim();
  if (!source || /<\|(?:think|channel)>|<\|tool_call\|>/i.test(source)) return null;
  const match = source.match(/<tool\b[^>]*>([\s\S]*?)(?:<\/tool>|$)/i);
  if (!match) return null;

  const lines = match[1].replace(/\r/g, "").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const nameLine = lines.shift()?.match(/^name\s*:\s*(\S.*?)\s*$/i);
  const name = validToolName(nameLine?.[1]);
  if (!name) return null;

  const args = {};
  let rawKey = null;
  let rawLines = [];
  for (const line of lines) {
    if (rawKey) {
      rawLines.push(line);
      continue;
    }
    const header = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!header) continue;
    const key = header[1];
    const value = header[2];
    if (["content", "patch", "code", "body"].includes(key.toLowerCase())) {
      rawKey = key.toLowerCase() === "body" ? "content" : key.toLowerCase();
      if (value) rawLines.push(value);
    } else {
      args[key] = castScalar(value);
    }
  }
  if (rawKey) args[rawKey] = rawLines.join("\n");
  return { id: nextCallId(), name, args };
}

export function parseToolCallFromThinking(text) {
  const source = String(text || "").replace(/\r/g, "");
  // Preferred: an explicit "Action:" line that ends with a tool block.
  const candidates = source.matchAll(/(?:^|\n)\s*action\s*:\s*(<tool\b[\s\S]*?<\/tool>)\s*$/gi);
  let recovered = null;
  for (const candidate of candidates) recovered = parseToolCall(candidate[1]);
  if (recovered) return recovered;
  // Fallback: the model sometimes emits the tool block inside its thinking
  // instead of the answer channel. Take the LAST well-formed block so a
  // block quoted mid-reasoning does not shadow the final decision.
  const blocks = [...source.matchAll(/<tool\b[^>]*>[\s\S]*?<\/tool>/gi)];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const parsed = parseToolCall(blocks[i][0]);
    if (parsed) return parsed;
  }
  return null;
}

function castScalar(raw) {
  const value = String(raw || "").trim();
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^(?:null|none)$/i.test(value)) return null;
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

export function parseAskHuman(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  const match = rawText.match(/<ask_human>\s*([\s\S]*?)\s*(?:<\/ask_human>|$)/i);
  if (!match) return null;
  const question = match[1].trim();
  return question.length > 0 ? question : null;
}

export function parseReflectionStatus(rawText) {
  if (!rawText || typeof rawText !== "string") {
    return { status: "RETRY", explanation: "No reflection response received." };
  }

  const statusMatch = rawText.match(/<status>\s*(COMPLETE|RETRY)\s*(?:<\/status>|$)/i);
  const status = statusMatch ? statusMatch[1].toUpperCase() : null;
  const explanation = rawText
    .replace(/<status>\s*(?:COMPLETE|RETRY)?\s*(?:<\/status>|$)/gi, "")
    .replace(/<\/?status>/gi, "")
    .trim();

  if (!status) {
    return {
      status: "RETRY",
      explanation: explanation || "Model failed to output a clear <status>COMPLETE</status> or <status>RETRY</status> tag.",
    };
  }
  return { status, explanation: explanation || "No detailed explanation provided." };
}

export function formatCompactTools(tools = []) {
  return tools.map(tool => {
    const argsSig = Object.entries(tool.args || {})
      .map(([name, type]) => `${name}: ${type}`)
      .join(", ");
    return `- ${tool.name}(${argsSig}): ${tool.description}`;
  }).join("\n");
}

export function cleanForDisplay(text) {
  return String(text || "")
    .replace(/<tool\b[^>]*>[\s\S]*?<\/tool>/gi, "")
    .replace(/<\|(?:think|channel|tool_call)\|?>/gi, "")
    .replace(/<channel\|>/gi, "")
    .replace(/<plan\s*>|<\/plan\s*>/gi, "")
    .replace(/^\s*```answer\s*\n?/i, "")
    .replace(/\n?\s*```\s*$/i, "")
    .trim();
}

export const cleanProse = cleanForDisplay;

export function sanitizeFileContent(content) {
  let value = String(content ?? "");
  const opening = value.match(/^\s*```[A-Za-z0-9_+-]*\s*\r?\n/);
  if (opening) {
    value = value.slice(opening[0].length);
    value = value.replace(/\r?\n\s*```\s*$/, "");
  } else {
    value = value.replace(/\r?\n\s*```\s*$/, "");
  }
  return value;
}
