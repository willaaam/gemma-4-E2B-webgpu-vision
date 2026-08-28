// Harness parser — Pi-inspired lightweight + Opencode-robust + Gemma 4 Canonical.
// Extracts structured tool calls and final answers from model prose and control tokens.
// Handles:
//  1. Canonical Gemma 4 control tokens: <|tool_call|>call:name{args}<tool_call|>
//  2. Stripped Gemma 4 calls: call:name{args}
//  3. ```tool and ```json fences
//  4. Naked JSON objects { "name": "...", "args": { ... } }
//  5. Direct code blocks: ```python\n# file.py\n...``` fallback for small models (E2B)
//  6. Truncated code recovery for cut-off generations
//  7. Answer extraction & special token cleanup

import { autoFenceNakedCode } from "../lib/markdown.js";

let _toolId = 0;
function nextId() { return `tc_${Date.now().toString(36)}_${++_toolId}`; }

/**
 * Strip only outer wrapping markdown fences from file content.
 * Preserves inner fences (e.g., markdown code blocks inside the file).
 */
export function sanitizeFileContent(content) {
  let s = String(content ?? "");
  // Unescape Gemma string delimiters
  s = s.replace(/<\|"\|>/g, '"').replace(/<\|">/g, '"').replace(/<"\|>/g, '"');
  // Strip leading ```lang fence on its own line at start
  const opening = s.match(/^[ \t]*```[A-Za-z0-9_+-]*[ \t]*\r?\n/);
  if (opening) {
    s = s.slice(opening[0].length);
    // Only remove a line-anchored close when an outer wrapper was found.
    s = s.replace(/\r?\n[ \t]*```[ \t]*$/, "");
    } else {
    const trailingFence = s.match(/\r?\n[ \t]*```[ \t]*\r?\n?$/);
      const standaloneFences = (s.match(/(?:^|\r?\n)[ \t]*```[A-Za-z0-9_+-]*[ \t]*(?=\r?$)/gm) || []).length;
      if (trailingFence && standaloneFences < 2) {
        s = s.slice(0, trailingFence.index);
      } else if (/[^\r\n]```[ \t]*$/.test(s)) {
        // A fence attached directly to a payload is a common generation leak.
        s = s.replace(/```[ \t]*$/, "");
  }
    }
  const trailingComment = s.match(/\n[ \t]*\*\/[ \t]*$/);
  if (trailingComment) {
    const before = s.slice(0, trailingComment.index);
    const opens = (before.match(/\/\*/g) || []).length;
    const closes = (before.match(/\*\//g) || []).length;
    if (closes >= opens) s = before;
  }
  return s;
}


/**
 * Extract tool calls from model text using multi-strategy cascading parser.
 * @param {string} text Raw model generation text
 * @param {object} [context] Context with optional task, activePath, project
 * @returns {Array<{ id: string, name: string, args: object, partial?: boolean, fromCodeBlock?: boolean }>}
 */
export function extractToolCalls(text, context = {}) {
  const src = String(text || "").trim();
  if (!src) return [];
  const out = [];

  // Strategy 1: Canonical Gemma 4 tool call syntax: <|tool_call|>call:name{...}<tool_call|>
  const gemmaCalls = extractGemma4Calls(src);
  for (const c of gemmaCalls) out.push(c);

  // Strategy 2: JSON-native <tool>{"name":...,"args":{...}}</tool> (gemma-coder style)
  if (out.length === 0) {
    const toolTagCalls = extractToolTagCalls(src);
    for (const c of toolTagCalls) out.push(c);
  }

  // Strategy 3: Fenced blocks (```tool, ```json, etc.)
  if (out.length === 0) {
    const fencedCalls = extractFencedToolCalls(src);
    for (const c of fencedCalls) out.push(c);
  }

  // Strategy 4: Naked JSON objects
  if (out.length === 0) {
    for (const cand of extractBalancedCandidates(src)) {
      if (out.length >= 4) break;
      try {
        const o = JSON.parse(cand);
        if (o && typeof o.name === "string" && isValidToolName(o.name)) {
          out.push(normalizeCall(o));
        }
      } catch {}
    }
  }

  // Strategy 5: Direct code block extraction (fallback for when small models emit code in markdown directly)
  if (out.length === 0) {
    const codeBlockCalls = extractCodeBlockCalls(src, context);
    for (const c of codeBlockCalls) out.push(c);
  }

  // Strategy 6: Truncated file call recovery for generation cutoffs
  if (out.length === 0) {
    const partial = extractTruncatedFileCall(src, context);
    if (partial) out.push(partial);
  }

  return deduplicateCalls(out);
}

function extractToolTagCalls(src) {
  let lastCall = null;
  const re = /<tool\b[^>]*>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const bodyStart = re.lastIndex;
    const closeIndex = findUnquotedTag(src, bodyStart, "</tool>");
    if (closeIndex < 0) break;
    const body = src.slice(bodyStart, closeIndex).trim();
    re.lastIndex = closeIndex + 7;
    if (!body) continue;
    try {
      const obj = JSON.parse(body);
      if (obj && typeof obj.name === "string" && isValidToolName(obj.name)) {
        lastCall = normalizeCall(obj);
      }
    } catch {
      try {
        const obj2 = parseLooseJson(body);
        if (obj2 && typeof obj2.name === "string" && isValidToolName(obj2.name)) lastCall = normalizeCall(obj2);
      } catch {}
    }
  }
  return lastCall ? [lastCall] : [];
}

function findUnquotedTag(src, start, tag) {
  let quote = null;
  let escaped = false;
  const lowerTag = tag.toLowerCase();
  for (let index = start; index < src.length; index++) {
    const char = src[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (src.slice(index, index + tag.length).toLowerCase() === lowerTag) return index;
  }
  return -1;
}

function parseLooseJson(source) {
  const withJsonStrings = convertSingleQuotedStrings(String(source || ""));
  const withQuotedKeys = quoteLooseObjectKeys(withJsonStrings);
  return JSON.parse(removeTrailingCommas(withQuotedKeys));
}

function convertSingleQuotedStrings(source) {
  let out = "";
  let inDouble = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inDouble) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inDouble = false;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      out += char;
      continue;
    }
    if (char !== "'") {
      out += char;
      continue;
    }

    out += '"';
    for (index++; index < source.length; index++) {
      const inner = source[index];
      if (inner === "\\") {
        const next = source[++index];
        if (next === "'") out += "'";
        else if (next === '"') out += '\\"';
        else out += `\\${next ?? ""}`;
      } else if (inner === "'") {
        out += '"';
        break;
      } else {
        if (inner === '"') out += '\\"';
        else out += inner;
      }
    }
  }
  return out;
}

function quoteLooseObjectKeys(source) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (inString) {
      out += char;
      index++;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index++;
      continue;
    }
    out += char;
    index++;
    if (char !== "{" && char !== ",") continue;

    const whitespaceStart = index;
    while (/[ \t\r\n]/.test(source[index] || "")) index++;
    const keyStart = index;
    while (/[A-Za-z0-9_$-]/.test(source[index] || "")) index++;
    const keyEnd = index;
    while (/[ \t\r\n]/.test(source[index] || "")) index++;
    if (keyEnd > keyStart && source[index] === ":") {
      out += source.slice(whitespaceStart, keyStart) + `"${source.slice(keyStart, keyEnd)}"` + source.slice(keyEnd, index + 1);
      index++;
    } else {
      out += source.slice(whitespaceStart, index);
    }
  }
  return out;
}

function removeTrailingCommas(source) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (/[ \t\r\n]/.test(source[next] || "")) next++;
      if (source[next] === "}" || source[next] === "]") continue;
    }
    out += char;
  }
  return out;
}

/**
 * Known valid tool names for validation
 */
const KNOWN_TOOLS = new Set([
  "write_file", "append_file", "apply_patch", "read_file", "list_files",
  "delete_file", "mkdir", "search", "run_python", "run_web", "install_package",
  "edit_file" // legacy alias
]);

function isValidToolName(name) {
  if (!name || typeof name !== "string") return false;
  const clean = name.trim().toLowerCase();
  return KNOWN_TOOLS.has(clean) || clean.includes("file") || clean.includes("run") || clean.includes("patch");
}

// -----------------------------------------------------------------------------
// 1. Gemma 4 Canonical Tool Call Parser
// Follows https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4
// -----------------------------------------------------------------------------

export function extractGemma4Calls(text) {
  const calls = [];
  const src = String(text || "");

  const callStartRegex = /(?:<\|tool_call>)?\s*call:([A-Za-z0-9_]+)\s*\{/g;
  let match;

  while ((match = callStartRegex.exec(src)) !== null) {
    const name = match[1].trim();
    let pos = match.index + match[0].length;
    const len = src.length;
    let depth = 1;
    let inGemmaStr = false;
    let inQuote = null;
    let escaped = false;
    const argsStart = pos;

    while (pos < len) {
      if (src.startsWith('<|"|>', pos)) {
        inGemmaStr = !inGemmaStr;
        pos += 5;
        continue;
      }
      if (inGemmaStr) {
        pos++;
        continue;
      }

      const c = src[pos];
      if (escaped) {
        escaped = false;
        pos++;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        pos++;
        continue;
      }

      if (inQuote) {
        if (c === inQuote) {
          inQuote = null;
        }
        pos++;
        continue;
      }

      if (c === '"' || c === "'") {
        inQuote = c;
        pos++;
        continue;
      }

      if (src.startsWith("<tool_call|>", pos)) {
        break;
      }

      if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          break;
        }
      }
      pos++;
    }

    let argsRaw = src.slice(argsStart, pos).trim();
    if (src.startsWith("<tool_call|>", pos)) {
      pos += 12;
    } else if (pos < len && src[pos] === "}") {
      pos++;
    }
    callStartRegex.lastIndex = pos;

    const args = parseGemma4Args(argsRaw);
    if (Object.keys(args).length > 0 || isValidToolName(name)) {
      calls.push({
        id: nextId(),
        name,
        args,
      });
    }
  }

  return calls;
}



function decodeEscapedString(raw) {

  return String(raw || "").replace(/\\([nrtbf"'\\])/g, (_, esc) => {
    switch (esc) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "b": return "\b";
      case "f": return "\f";
      case '"': return '"';
      case "'": return "'";
      case "\\": return "\\";
      default: return esc;
    }
  });
}

/**
 * Parse argument string formatted in Gemma 4 key-value syntax:
 * e.g. path:<|"|>tetris.py<|"|>,content:<|"|>import sys...<|"|>
 * or path:"script.js", content:"const x = 'abc';\n..."
 */
export function parseGemma4Args(argsStr) {
  const args = {};
  const str = String(argsStr || "").trim();
  if (!str) return args;

  // 1. Check if it's valid JSON
  try {
    const parsed = JSON.parse(`{${str}}`);
    if (typeof parsed === "object" && parsed !== null) return parsed;
  } catch {}

  // 2. Extract path/entry/name parameter
  const pathMatch = str.match(/(?:^|[\s,])(?:path|filename|file|filepath|entry|name)\s*[:=]\s*(?:<\|"\|>([^<]*?)<\|"\|>|"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s,{}]+))/i);
  if (pathMatch) {
    args.path = (pathMatch[1] ?? pathMatch[2] ?? pathMatch[3] ?? pathMatch[4] ?? "").trim();
    if (args.path) {
      args.path = args.path.replace(/^['"]+|['"]+$/g, "");
    }
  }

  // 3. Extract content/code/patch/text payload
  const contentMatch = str.match(/(?:^|[\s,])(content|code|patch|text|body|diff)\s*[:=]\s*([\s\S]*)$/i);
  if (contentMatch) {
    const payloadKey = contentMatch[1].toLowerCase();
    let rawPayload = contentMatch[2].trim();

    // Case A: <|"|> delimiter
    if (rawPayload.startsWith('<|"|>')) {
      rawPayload = rawPayload.slice(5);
      const closeIdx = rawPayload.indexOf('<|"|>');
      if (closeIdx !== -1) rawPayload = rawPayload.slice(0, closeIdx);
      args[payloadKey] = sanitizeFileContent(rawPayload);
    }
    // Case B: Quoted string "..." or '...'
    else if (rawPayload.startsWith('"') || rawPayload.startsWith("'")) {
      const q = rawPayload[0];
      rawPayload = rawPayload.slice(1);
      // Strip trailing quote if it ends with quote or quote followed by } or <tool_call|>
      rawPayload = rawPayload.replace(new RegExp(`(?:${q}\\s*(?:\\}|<tool_call\\|>)?|\\}|<tool_call\\|>)\\s*$`), "");
      let decoded = decodeEscapedString(rawPayload);
      decoded = sanitizeFileContent(decoded);
      args[payloadKey] = decoded;
    }
    // Case C: Raw unquoted code payload
    else {
      rawPayload = rawPayload.replace(/(?:\}|<tool_call\|>)\s*$/, "");
      rawPayload = sanitizeFileContent(rawPayload);
      args[payloadKey] = rawPayload;
    }

    return args;
  }

  // 4. Generic key-value scanner for small non-payload tools (e.g. read_file, run_python, install_package)
  const kvRegex = /([A-Za-z0-9_$-]+)\s*[:=]\s*(?:<\|"\|>([\s\S]*?)<\|"\|>|"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s,{}]+))/g;
  let m;
  while ((m = kvRegex.exec(str)) !== null) {
    const key = m[1].trim();
    const val = m[2] ?? (m[3] != null ? decodeEscapedString(m[3]) : null) ?? (m[4] != null ? decodeEscapedString(m[4]) : null) ?? castValue(m[5]);
    args[key] = val;
  }

  if (args.path) {
    args.path = String(args.path).replace(/^['"]+|['"]+$/g, "").trim();
  }

  // If path is present but content was not explicitly keyed with content:
  if (args.path && !args.content && !args.patch && !args.code) {
    const afterMatch = str.match(/(?:path|filename|file|filepath)\s*[:=]\s*(?:<\|"\|>[^<]*<\|"\|>|"[^"]*"|'[^']*'|[^\s,{}]+)\s*[,;:]?\s*([\s\S]*)$/i);
    if (afterMatch && afterMatch[1].trim()) {
      let body = afterMatch[1].trim();
      body = body.replace(/^[,;]\s*/, "").replace(/^"[^"]*"\s*[:=]\s*/, "").replace(/^[a-zA-Z0-9_$-]+\s*[:=]\s*["']?/, "");
      body = body.replace(/(?:\}|<tool_call\|>)\s*$/, "").replace(/^['"]|['"]$/g, "");
      args.content = sanitizeFileContent(decodeEscapedString(body));
    }
  }

  return args;
}


function castValue(v) {

  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  if (trimmed.toLowerCase() === "true") return true;
  if (trimmed.toLowerCase() === "false") return false;
  if (trimmed.toLowerCase() === "null" || trimmed.toLowerCase() === "none") return null;
  return trimmed.replace(/^['"]|['"]$/g, "");
}

// -----------------------------------------------------------------------------
// 2. Fenced Tool Call Parser (```tool, ```json, etc.)
// -----------------------------------------------------------------------------

function extractFencedToolCalls(src) {
  const out = [];
  for (const block of scanFencedBlocks(src, { respectJsonStrings: true })) {
    const body = block.body.trim();
    if (!body) continue;

    // Check for Gemma 4 syntax inside fence: call:name{...}
    if (body.startsWith("call:") || body.includes("<|tool_call>")) {
      const gCalls = extractGemma4Calls(body);
      for (const gc of gCalls) out.push(gc);
      if (gCalls.length > 0) continue;
    }

    try {
      const obj = JSON.parse(body);
      if (Array.isArray(obj)) {
        for (const o of obj) if (o?.name) out.push(normalizeCall(o));
      } else if (obj && typeof obj.name === "string") {
        out.push(normalizeCall(obj));
      }
    } catch {
      // Try relaxed parsing (single quotes, trailing commas, unquoted keys)
      try {
        const obj2 = parseLooseJson(body);
        if (Array.isArray(obj2)) for (const o of obj2) if (o?.name) out.push(normalizeCall(o));
        else if (obj2?.name) out.push(normalizeCall(obj2));
      } catch {}
    }
  }

  return out;
}

function scanFencedBlocks(src, { respectJsonStrings = false } = {}) {
  const blocks = [];
  const openRegex = /(^|\r?\n)[ \t]*```([A-Za-z0-9_+-]*)(?::([^\r\n]*?))?[ \t]*\r?\n/gi;
  let match;
  while ((match = openRegex.exec(src)) !== null) {
    const bodyStart = match.index + match[0].length;
    const language = (match[2] || "").trim();
    const jsonShaped = /^[ \t\r\n]*[\[{]/.test(src.slice(bodyStart));
    const quoteAware = respectJsonStrings && (language.toLowerCase() === "json" || !language || jsonShaped);
    const closeIndex = findFencedClose(src, bodyStart, quoteAware);
    if (closeIndex < 0) break;
    blocks.push({
      start: match.index,
      language,
      explicitFile: (match[3] || "").trim(),
      body: src.slice(bodyStart, closeIndex),
    });
    openRegex.lastIndex = closeIndex + 3;
  }
  return blocks;
}

function findFencedClose(src, start, respectJsonStrings = false) {
  let quote = null;
  let escaped = false;
  for (let index = start; index < src.length; index++) {
    const char = src[index];
    if (respectJsonStrings && quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (respectJsonStrings && char === '"') {
      quote = char;
      continue;
    }
    if (src.startsWith("```", index) && isLineAnchoredFence(src, index)) return index;
  }
  return -1;
}

function isLineAnchoredFence(src, index) {
  const lineStart = src.lastIndexOf("\n", index - 1) + 1;
  if (src.slice(lineStart, index).trim()) return false;
  const lineEnd = src.indexOf("\n", index + 3);
  const suffix = src.slice(index + 3, lineEnd < 0 ? src.length : lineEnd);
  return /^[ \t]*\r?$/.test(suffix);
}

// -----------------------------------------------------------------------------
// 3. Direct Markdown Code Block Extraction (E2B Fallback)
// -----------------------------------------------------------------------------

/**
 * When small models output code directly in response to a coding prompt
 * instead of formatting a tool call, extract the code and synthesize a write_file action.
 */
export function extractCodeBlockCalls(text, context = {}) {
  let src = String(text || "").trim();
  if (!src.includes("```")) {
    src = autoFenceNakedCode(src);
  }
  const out = [];

  for (const block of scanFencedBlocks(src)) {
    const lang = block.language.toLowerCase();
    const explicitFile = block.explicitFile;
    const code = block.body.replace(/\r?\n$/, "");

    // Skip tool / json / answer / thinking fences
    if (["tool", "json", "tool_call", "answer", "thought", "output"].includes(lang) && !explicitFile) {
      continue;
    }

    if (!code || code.trim().length < 40) continue;

    const textBefore = src.slice(Math.max(0, block.start - 300), block.start);
    const path = inferFilePath(code, { lang, explicitFile, textBefore, ...context });
    if (path) {
      out.push({
        id: nextId(),
        name: "write_file",
        args: { path, content: code },
        fromCodeBlock: true,
      });
      break;
    }
  }

  return out;
}

/**
 * Extract target file path strictly from the model's explicit metadata:
 * 1. Explicit tag on the fence (```lang:filename)
 * 2. Comment header inside the code (// script.js, # main.py, /* style.css *\/, <!-- index.html -->)
 * 3. Preceding heading / text (### Step 2: `style.css`)
 * 4. Explicit file mentioned in the task / active task
 */
export function inferFilePath(code, { lang = "", explicitFile = "", textBefore = "", task = "", activeTask = "" } = {}) {
  if (explicitFile) {
    return explicitFile.replace(/^[/#\s]+/, "").trim();
  }

  // 1. Check top comments for explicit filename
  const lines = code.split("\n").slice(0, 5);
  for (const line of lines) {
    const m = line.match(/(?:#|\/\/|<!--|\/\*)\s*(?:File\s*:\s*|Filename\s*:\s*)?([A-Za-z0-9_./-]+\.(?:py|html|css|js|ts|json|md|txt))/i);
    if (m && m[1]) return m[1].replace(/^[/#\s]+/, "").trim();
  }

  // 2. Check preceding heading (e.g. "### Step 2: `style.css`" or "### style.css")
  if (textBefore) {
    const headingMatch = textBefore.match(/(?:###?|Step\s*\d+:?|File:?)\s*`?([A-Za-z0-9_./-]+\.(?:py|html|css|js|ts|json|md|txt))`?/i);
    if (headingMatch && headingMatch[1]) {
      return headingMatch[1].replace(/^[/#\s]+/, "").trim();
    }
  }

  // 3. Check explicit filename mentioned in active task or user prompt
  const targetStr = `${activeTask} ${task}`.trim();
  if (targetStr) {
    const taskFileMatches = [...targetStr.matchAll(/\b([A-Za-z0-9_/-]+\.(?:py|html|css|js|ts|json|md|txt))\b/gi)];
    for (const match of taskFileMatches) {
      const fn = match[1];
      if (isValidForLang(fn, lang)) return fn;
    }
  }

  return null;
}

function isValidForLang(path, lang) {
  const p = String(path || "").toLowerCase();
  const l = String(lang || "").toLowerCase();
  if (!l) return true;
  if ((l === "python" || l === "py") && (p.endsWith(".py") || p.endsWith(".pyw"))) return true;
  if ((l === "html" || l === "htm") && (p.endsWith(".html") || p.endsWith(".htm"))) return true;
  if ((l === "javascript" || l === "js" || l === "mjs") && (p.endsWith(".js") || p.endsWith(".mjs"))) return true;
  if (l === "css" && p.endsWith(".css")) return true;
  if (l === "json" && p.endsWith(".json")) return true;
  if ((l === "markdown" || l === "md") && (p.endsWith(".md") || p.endsWith(".markdown"))) return true;
  return false;
}



// -----------------------------------------------------------------------------
// 4. Truncation & Truncated Code Recovery
// -----------------------------------------------------------------------------

export function extractTruncatedFileCall(text, context = {}) {
  const src = String(text || "");

  // Match partial Gemma 4 call: call:write_file{path:<|"|>...<|"|>,content:<|"|>...
  const gemmaPartial = src.match(/(?:<\|tool_call>)?\s*call:(write_file|append_file)\s*\{([\s\S]*)/i);
  if (gemmaPartial) {
    const name = gemmaPartial[1];
    const rest = gemmaPartial[2];
    const pathMatch = rest.match(/path\s*:\s*(?:<\|"\|>|"|')([^<"'\n]+)/i);
    const contentMatch = rest.match(/content\s*:\s*(?:<\|"\|>|"|')([\s\S]*)/i);
    if (pathMatch && contentMatch) {
      let content = contentMatch[1];
      // strip closing delimiter if present
      content = content.replace(/<\|"\|>.*$/, "").replace(/["']\s*\}?.*$/, "");
      if (content.length >= 60) {
        return {
          id: nextId(),
          name,
          args: { path: pathMatch[1].trim(), content: sanitizeFileContent(content) },
          partial: true,
        };
      }
    }
  }

  // Match partial JSON: {"name":"write_file","args":{"path":"...","content":"...
  const nameMatch = src.match(/"name"\s*:\s*"(write_file|append_file)"/i);
  if (nameMatch) {
    const searchFrom = nameMatch.index + nameMatch[0].length;
    const path = extractJsonStringField(src, "path", searchFrom);
    const contentStart = findJsonStringField(src, "content", searchFrom);
    if (path && contentStart >= 0) {
      const decoded = decodeJsonStringPrefix(src, contentStart);
      if (decoded.value && decoded.value.length >= 60) {
        const content = decoded.complete ? decoded.value : decoded.value.slice(0, decoded.value.lastIndexOf("\n") + 1);
        if (content.length >= 60) {
          return {
            id: nextId(),
            name: nameMatch[1],
            args: { path, content: sanitizeFileContent(content) },
            partial: !decoded.complete,
          };
        }
      }
    }
  }

  // Match unclosed markdown code block: ```python\n... (cut off before closing ```)
  const unclosedCodeMatch = src.match(/```([A-Za-z0-9_+-]*)\s*\r?\n([\s\S]{80,})$/);
  if (unclosedCodeMatch && !src.endsWith("```")) {
    const lang = unclosedCodeMatch[1].toLowerCase();
    if (!["tool", "json", "answer", "thought"].includes(lang)) {
      let rawCode = unclosedCodeMatch[2].replace(/```.*$/, "");
      let validCode = rawCode.slice(0, rawCode.lastIndexOf("\n") + 1);
      if (validCode.length >= 60) {
        validCode = sanitizeFileContent(validCode);
        const path = inferFilePath(validCode, { lang, ...context });
        if (path) {
          return {
            id: nextId(),
            name: "write_file",
            args: { path, content: validCode },
            partial: true,
            fromCodeBlock: true,
          };
        }
      }
    }
  }

  return null;
}

function findJsonStringField(src, field, from = 0) {
  const match = new RegExp(`"${field}"\\s*:\\s*"`, "i").exec(src.slice(from));
  return match ? from + match.index + match[0].length : -1;
}

function extractJsonStringField(src, field, from = 0) {
  const start = findJsonStringField(src, field, from);
  if (start < 0) return "";
  const decoded = decodeJsonStringPrefix(src, start);
  return decoded.complete ? decoded.value : "";
}

function decodeJsonStringPrefix(src, start) {
  let value = "";
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') return { value, complete: true };
    if (ch !== "\\") {
      if (ch === "\n" || ch === "\r") return { value, complete: false };
      value += ch;
      continue;
    }
    if (i + 1 >= src.length) return { value, complete: false };
    const escaped = src[++i];
    const escapes = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    if (Object.prototype.hasOwnProperty.call(escapes, escaped)) {
      value += escapes[escaped];
      continue;
    }
    if (escaped === "u" && /^[0-9a-f]{4}$/i.test(src.slice(i + 1, i + 5))) {
      value += String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16));
      i += 4;
      continue;
    }
    return { value, complete: false };
  }
  return { value, complete: false };
}

// -----------------------------------------------------------------------------
// 5. Normalization & Deduplication
// -----------------------------------------------------------------------------

function normalizeCall(o) {
  const name = String(o.name || "").trim();
  let args = o.args ?? o.arguments ?? o.params ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) args = {};
  // Sanitize file content args at normalization time
  if (args.content != null) args.content = sanitizeFileContent(String(args.content));
  if (args.code != null) args.code = sanitizeFileContent(String(args.code));
  if (args.patch != null) args.patch = sanitizeFileContent(String(args.patch));
  if (args.diff != null) args.diff = sanitizeFileContent(String(args.diff));
  if (args.text != null && (name === "write_file" || name === "append_file")) args.text = sanitizeFileContent(String(args.text));
  return { id: o.id || nextId(), name, args };
}

export function deduplicateCalls(calls) {
  const seen = new Set();
  const out = [];
  for (const c of calls) {
    const key = `${c.name}::${canonicalArgs(c.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function canonicalArgs(args) {
  try {
    const keys = Object.keys(args || {}).sort();
    const obj = {};
    for (const k of keys) obj[k] = args[k];
    return JSON.stringify(obj);
  } catch { return JSON.stringify(args || {}); }
}

export function hashCalls(calls) {
  return (calls || []).map(c => `${c.name}:${canonicalArgs(c.args)}`).join("|");
}

// -----------------------------------------------------------------------------
// 6. Answer & Prose Handling
// -----------------------------------------------------------------------------

export function hasAnswer(text) {
  const t = String(text || "");
  if (/^\s*```answer\b/im.test(t)) return true;
  if (/^\s*DONE\s*$/m.test(t)) return true;
  return false;
}

export function extractAnswer(text) {
  const src = String(text || "");
  const m = src.match(/^\s*```answer\s*\r?\n([\s\S]*?)```/im);
  if (m) return cleanProse(m[1]);
  const done = src.match(/^\s*DONE\s*$/m);
  if (done?.index !== undefined) return cleanProse(src.slice(0, done.index));
  return cleanProse(src);
}

/**
 * Remove any leftover internal control tokens or tool call markers from user-facing text.
 */
export function cleanProse(text) {
  let s = String(text || "");
  // Channel thought blocks
  s = s.replace(/<\|?channel\|?>\s*thought[\s\S]*?<\|?channel\|?>/gi, "");
  // Complete tool call blocks
  s = s.replace(/<\|?tool_call\|?>[\s\S]*?<\|?tool_call\|?>/gi, "");
  s = s.replace(/<\|?tool_response\|?>[\s\S]*?<\|?tool_response\|?>/gi, "");
  // Bare or unclosed Gemma tool calls: call:func{...} or call:func{...
  s = s.replace(/(?:<\|tool_call>)?\s*call:\w+\{[\s\S]*?(?:\}(?:\s*<tool_call\|>)?|$)/g, "");
  // Standalone control tokens (e.g. <|tool_call|>, <tool_call|>, <|turn>model, <turn|>, <channel|>, etc.)
  s = s.replace(/<\|?[a-zA-Z0-9_]+(?::[a-zA-Z0-9_]+)?\|?>/g, "");
  // Unescape string delimiters
  s = s.replace(/<\|"\|>/g, '"');
  s = s.replace(/<\|">/g, '"');
  s = s.replace(/<"\|>/g, '"');
  // Fences
  s = s.replace(/```answer\s*\r?\n?/gi, "");
  s = s.replace(/```tool\s*\r?\n[\s\S]*?```/gi, "");
  s = s.replace(/```tool[\s\S]*$/gi, "");
  s = s.replace(/```\s*$/g, "");
  return s.trim();
}




export function hasUnclosedToolFence(text) {
  const src = String(text || "");
  const opening = /```(?:tool|json)?\s*\r?\n/gi;
  let match;
  while ((match = opening.exec(src))) {
    const bodyStart = match.index + match[0].length;
    const closeIndex = findFencedClose(src, bodyStart, true);
    if (closeIndex < 0) return true;
    opening.lastIndex = closeIndex + 3;
  }
  return false;
}

/**
 * Heuristic: if model produced substantive prose after tools were executed, treat as final answer.
 */
export function looksLikeFinalAnswer(text, { step = 1, hasToolsInHistory = false } = {}) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (hasAnswer(t)) return true;
  const stripped = cleanProse(t);
  if (stripped.length < 50) return false;
  if (step >= 2 && stripped.length >= 60) return true;
  if (hasToolsInHistory && stripped.length >= 60) return true;
  return false;
}

function extractBalancedCandidates(src) {
  const out = [];
  const len = src.length;
  let i = 0;
  while (i < len) {
    const start = src.indexOf('{', i);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let j = start; j < len; j++) {
      const ch = src[j];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
      } else {
        if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { end = j; break; }
        }
      }
      if (j - start > 12000) break;
    }
    if (end !== -1) {
      const cand = src.slice(start, end + 1);
      if (cand.includes('"name"') && cand.includes('"args"') || cand.includes('"name"')) {
        out.push(cand);
      }
      i = end + 1;
    } else {
      i = start + 1;
    }
    if (out.length >= 8) break;
  }
  return out;
}

export function _resetId() { _toolId = 0; }
