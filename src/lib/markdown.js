// Shared markdown → HTML pipeline.
// Extracted verbatim from the original index.html inline script so every app
// (chat, research, reports) renders model output identically.
//
// Streamed markdown → HTML. `streamdown` itself is React-only (peer deps react/react-dom plus a
// mermaid + unified/remark/rehype dep tree), so we use `marked` — the very parser streamdown is
// built on — loaded lazily from a CDN. Until it loads (or if the CDN is unreachable) we fall
// back to a tiny inline renderer, so rendering never depends on it.

let marked = null;
import("https://esm.sh/marked@17")
  .then((m) => { marked = m.marked; marked.use({ gfm: true, breaks: true }); })
  .catch(() => { marked = null; });

// KaTeX for LaTeX math. Mirrors the marked pattern:
// lazy ESM from CDN, graceful null fallback if offline so apps still work.
let katex = null;
import("https://esm.sh/katex@0.16.11")
  .then((m) => { katex = m.default ?? m; })
  .catch(() => { katex = null; });

export function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function formatInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+?)`/g, "<code>$1</code>")
    .replace(/(?:^|\n)\s*-\s*\[([ xX/])\]\s*/g, (_, mark) => {
      const checked = mark.toLowerCase() === "x" ? ' checked="" disabled=""' : ' disabled=""';
      return `<input type="checkbox"${checked}> `;
    });
}

// ---- Math rendering (KaTeX) ----
// Extract LaTeX to placeholders so marked/sanitize don't corrupt it, then
// restore as katex.renderToString HTML. Code fences and inline code are
// protected first so $ inside code is never treated as math.

// Placeholder tokens
const MATH_PH = "@@MATH";
const CODE_PH = "@@CODE";

/**
 * Wrap naked (unfenced) code in ``` fences so downstream markdown parsing
 * renders it inside <pre><code> blocks instead of as plain text.
 *
 * CRITICAL: This function tracks existing ``` fence state. Lines inside a
 * model-opened ``` block are passed through unchanged — we never auto-fence
 * code that is already inside a fence.
 */
export function autoFenceNakedCode(text) {
  const lines = String(text || "").split("\n");
  const result = [];
  let inExistingFence = false; // inside a ``` block the model already opened
  let inAutoFence = false;     // inside a code block WE are building
  let codeBuffer = [];
  let codeLang = "javascript";

  const isMarkdownLine = (line) => {
    const t = line.trim();
    if (!t) return false;
    if (/^\s*(?:#{1,6}\s+|[-*+]\s*\[[ xX/]\]|[-*+o]\s+|\d+[.)]\s+)/i.test(line)) return true;
    if (/^\s*(?:\*\*[^*]+\*\*|__[^_]+__):?\s*$/.test(t)) return true;
    // Prose sentences (starts with uppercase, contains spaces, no code-like chars at end)
    if (/^[A-Z][a-z]/.test(t) && t.includes(" ") && !/[{};=]$/.test(t)) return true;
    return false;
  };

  const isCodeStartLine = (line) => {
    const t = line.trim();
    if (isMarkdownLine(line)) return false;
    if (/^(?:function\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|class\s+\w+|import\s+|export\s+|def\s+\w+\s*\(|from\s+\w+\s+import|<!doctype\s+html)/i.test(t)) return true;
    if (/^(?:body|\.[\w-]+|#[\w-]+)\s*\{\s*$/i.test(t)) return true;
    return false;
  };

  const isCodeBodyLine = (line) => {
    const t = line.trim();
    if (!t) return true; // empty line inside code block is preserved
    if (isMarkdownLine(line)) return false;
    if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return true;
    if (/^(?:return\s+|if\s*\(|else\s*\{|else\s+if|for\s*\(|while\s*\(|switch\s*\(|case\s+|try\s*\{|catch\s*\(|document\.|window\.|console\.)/i.test(t)) return true;
    if (/^(?:elif\s+|except\s*|print\s*\()/i.test(t)) return true;
    if (/^[a-z-]+:\s*[^;]+;/i.test(t)) return true; // CSS property
    if (/[{}\[\];]$/.test(t) || /=>\s*\{?$/.test(t)) return true;
    if (/^\s{2,}\S/.test(line)) return true;
    return false;
  };

  const flushAutoFence = () => {
    if (codeBuffer.length > 0) {
      result.push(`\`\`\`${codeLang}\n${codeBuffer.join("\n")}\n\`\`\``);
    }
    codeBuffer = [];
    inAutoFence = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this line is a ``` fence marker
    if (line.trim().startsWith("```")) {
      // First, flush any auto-fence we were building
      if (inAutoFence) {
        flushAutoFence();
      }

      if (inExistingFence) {
        // This is the closing ``` of an existing fenced block
        inExistingFence = false;
        result.push(line);
      } else {
        // This is the opening ``` of a new fenced block
        inExistingFence = true;
        // Normalize fence header: keep only clean alphanumeric language tag
        const fenceMatch = line.match(/^(\s*```)([A-Za-z0-9_]*)/);
        if (fenceMatch) {
          result.push(fenceMatch[1] + fenceMatch[2]);
        } else {
          result.push("```");
        }
      }
      continue;
    }

    // If inside an existing ``` fence, pass through unchanged
    if (inExistingFence) {
      result.push(line);
      continue;
    }

    // Outside any fence — check for markdown lines
    if (isMarkdownLine(line)) {
      if (inAutoFence) flushAutoFence();
      result.push(line);
      continue;
    }

    // Auto-fence logic for naked code
    if (!inAutoFence) {
      if (isCodeStartLine(line)) {
        inAutoFence = true;
        if (/^def\s+|from\s+\w+\s+import|import\s+sys/i.test(line.trim())) codeLang = "python";
        else if (/^<!doctype|<html/i.test(line.trim())) codeLang = "html";
        else if (/^body\s*\{|^\.[\w-]+\s*\{/i.test(line.trim())) codeLang = "css";
        else codeLang = "javascript";
        codeBuffer.push(line);
      } else {
        result.push(line);
      }
    } else {
      if (isCodeBodyLine(line)) {
        codeBuffer.push(line);
      } else {
        flushAutoFence();
        result.push(line);
      }
    }
  }

  // Flush any remaining auto-fence
  if (inAutoFence) flushAutoFence();
  // If we ended inside an unclosed existing fence, that's fine —
  // extractCodePlaceholders will handle it.

  return result.join("\n");
}

/**
 * Extract code blocks (fenced and inline) into placeholders so that
 * markdown/math processing doesn't corrupt code content.
 *
 * Uses line-by-line scanning to properly pair ``` opening and closing fences,
 * avoiding the fragile lazy regex that mismatched fence pairs.
 */
function extractCodePlaceholders(raw, codeStore) {
  const fenced = autoFenceNakedCode(raw || "");
  const lines = String(fenced || "").split("\n");
  const outLines = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i].trim().startsWith("```")) {
      // Found an opening fence — collect everything until closing ```
      const block = [lines[i]];
      i++;
      let closed = false;
      while (i < lines.length) {
        block.push(lines[i]);
        if (lines[i].trim() === "```") {
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) {
        // Unclosed fence (streaming or truncated) — auto-close
        block.push("```");
      }
      const id = `${CODE_PH}${codeStore.length}@@`;
      codeStore.push(block.join("\n"));
      outLines.push(id);
    } else {
      outLines.push(lines[i]);
      i++;
    }
  }

  let s = outLines.join("\n");

  // Inline code `...`
  s = s.replace(/`[^`\n]+`/g, (m) => {
    const id = `${CODE_PH}${codeStore.length}@@`;
    codeStore.push(m);
    return id;
  });

  return s;
}

/**
 * Extract the body of a code block, stripping the opening/closing ``` fences.
 */
function extractCodeBody(codeSrc) {
  if (!codeSrc.startsWith("```")) return codeSrc.slice(1, -1);
  return codeSrc
    .replace(/^```[^\r\n]*\r?\n?/, "")
    .replace(/\r?\n?```\s*$/, "");
}

/**
 * Restore code placeholders back into rendered HTML.
 * Uses direct <pre><code> rendering — does not depend on marked.
 */
function restoreCodePlaceholders(html, codeStore) {
  let out = html;
  for (let i = 0; i < codeStore.length; i++) {
    const ph = `${CODE_PH}${i}@@`;
    const codeSrc = codeStore[i];
    const body = extractCodeBody(codeSrc);
    let rendered;
    if (codeSrc.startsWith("```")) {
      rendered = `<pre><code>${escapeHtml(body)}</code></pre>`;
    } else {
      rendered = `<code>${escapeHtml(body)}</code>`;
    }
    // Placeholders may be wrapped in <p> by marked, or HTML-escaped
    out = out.split(`<p>${ph}</p>`).join(rendered);
    out = out.split(ph).join(rendered);
    out = out.split(escapeHtml(ph)).join(rendered);
  }
  return out;
}


function extractMathPlaceholders(raw, mathStore) {
  let s = String(raw || "");
  const push = (latex, display) => {
    const id = `${MATH_PH}${mathStore.length}@@`;
    mathStore.push({ latex, display });
    return id;
  };
  // Preserve escaped dollars so they don't start/close delimiters.
  const ESC = "@@ESCDOLLAR@@";
  s = s.replace(/\\\$/g, ESC);
  // Display math: $$ ... $$  (non-greedy, dotall)
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, body) => push(body, true));
  // Display math: \[ ... \]
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, body) => push(body, true));
  // Inline math: \( ... \)
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, body) => push(body, false));
  // Inline math: $ ... $ — require non-space adjacency on open/close to avoid
  // matching currency like "$5 and $10". Single char delimiters only.
  s = s.replace(/(?<!\S)\$(?!\s)([^\n$]+?)(?<!\s)\$(?!\w)/g, (_, body) => {
    // body must contain non-whitespace and not be only digits/commas (price heuristic)
    const t = body.trim();
    if (!t) return `$${body}$`;
    // if body looks like a price (digits, commas, dots only), leave it
    if (/^[\d,.]+$/.test(t)) return `$${body}$`;
    return push(body, false);
  });
  // Restore escaped dollars that were not consumed as math
  s = s.split(ESC).join("\\$");
  return s;
}

function renderMathPlaceholders(html, mathStore) {
  if (mathStore.length === 0) return html;
  let out = html;
  for (let i = 0; i < mathStore.length; i++) {
    const ph = `${MATH_PH}${i}@@`;
    const { latex, display } = mathStore[i];
    let rendered;
    if (katex) {
      try {
        rendered = katex.renderToString(latex, { throwOnError: false, displayMode: display, strict: "ignore" });
      } catch {
        rendered = `<span class="katex-error">${escapeHtml(latex)}</span>`;
      }
    } else {
      // Offline fallback: show raw LaTeX escaped so $...$ is visible
      const d = display ? `$$${latex}$$` : `$${latex}$`;
      rendered = `<code>${escapeHtml(d)}</code>`;
    }
    // Placeholders survive marked/sanitize as plain text; replace in HTML.
    // marked wraps standalone placeholders in <p> — handle both forms.
    if (out.includes(`<p>${ph}</p>`)) out = out.split(`<p>${ph}</p>`).join(rendered);
    out = out.split(ph).join(rendered);
    // Also handle placeholder that got HTML-escaped inside a code-like context
    out = out.split(escapeHtml(ph)).join(rendered);
  }
  return out;
}

export function renderMarkdown(raw) {
  // Protect code, then extract math, then markdown, then restore.
  const codeStore = [];
  const mathStore = [];
  let tmp = extractCodePlaceholders(raw || "", codeStore);
  tmp = extractMathPlaceholders(tmp, mathStore);
  if (marked) {
    try {
      let html = sanitizeHtml(marked.parse(tmp));
      // marked may escape our placeholders — restore math first so placeholders
      // inside <p> are found correctly, then code.
      html = renderMathPlaceholders(html, mathStore);
      html = restoreCodePlaceholders(html, codeStore);
      return html;
    } catch { /* fall through */ }
  }
  // Fallback without marked: render code and math placeholders cleanly
  const parts = tmp.split(new RegExp(`(${CODE_PH}\\d+@@|${MATH_PH}\\d+@@)`, "g"));
  const htmlParts = parts.map((part) => {
    const codeMatch = part.match(new RegExp(`^${CODE_PH}(\\d+)@@$`));
    if (codeMatch) {
      const idx = Number(codeMatch[1]);
      const codeSrc = codeStore[idx] || "";
      const body = extractCodeBody(codeSrc);
      return codeSrc.startsWith("```")
        ? `<pre><code>${escapeHtml(body)}</code></pre>`
        : `<code>${escapeHtml(body)}</code>`;
    }
    const mathMatch = part.match(new RegExp(`^${MATH_PH}(\\d+)@@$`));
    if (mathMatch) {
      const idx = Number(mathMatch[1]);
      const { latex, display } = mathStore[idx] || { latex: "", display: false };
      if (katex) {
        try { return katex.renderToString(latex, { throwOnError: false, displayMode: display, strict: "ignore" }); }
        catch { return `<span class="katex-error">${escapeHtml(latex)}</span>`; }
      }
      return `<code>${escapeHtml(display ? `$$${latex}$$` : `$${latex}$`)}</code>`;
    }
    if (!part.trim()) return "";
    const safe = escapeHtml(part);
    const paras = safe.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    if (paras.length === 0) return "";
    return paras.map((p) => `<p>${formatInline(p).replace(/\n/g, "<br>")}</p>`).join("");
  });
  return htmlParts.join("");
}


// Strip anything executable from the model's markdown before inserting it (defence in depth — a
// local model is the only content source, but raw <script>/event handlers/javascript: URLs are out).
// KaTeX output is allowed through: span.katex*, MathML elements, and katex-prefixed classes.
export function sanitizeHtml(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  tpl.content.querySelectorAll("script,style,iframe,object,embed,link,meta,form").forEach((el) => el.remove());
  const KA_TEX_TAGS = new Set(["math","semantics","mrow","mi","mo","mn","msup","msub","msubsup","mfrac","msqrt","mroot","mtext","mtable","mtr","mtd","annotation","annotation-xml"]);
  tpl.content.querySelectorAll("*").forEach((el) => {
    const tag = el.tagName.toLowerCase();
    // Allow MathML tags that KaTeX emits
    if (KA_TEX_TAGS.has(tag)) return;
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name === "class" && /katex/.test(attr.value)) continue;
      if (name === "style" && el.closest(".katex")) continue;
      if (name.startsWith("aria-")) continue;
      if (name === "xmlns" && tag === "math") continue;
      if (name === "encoding" && tag === "annotation") continue;
      if (name.startsWith("on") || ((name === "href" || name === "src") && /^\s*(javascript|data):/i.test(attr.value))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return tpl.innerHTML;
}
