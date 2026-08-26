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
  return text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+?)`/g, "<code>$1</code>");
}

// ---- Math rendering (KaTeX) ----
// Extract LaTeX to placeholders so marked/sanitize don't corrupt it, then
// restore as katex.renderToString HTML. Code fences and inline code are
// protected first so $ inside code is never treated as math.

// Placeholder token must not appear in marked output — use a span-like id that
// marked leaves as literal text inside the HTML.
const MATH_PH = "@@MATH";
const CODE_PH = "@@CODE";

function extractCodePlaceholders(raw, codeStore) {
  let s = String(raw || "");
  // fenced code blocks ```...```
  s = s.replace(/```[\s\S]*?```/g, (m) => {
    const id = `${CODE_PH}${codeStore.length}@@`;
    codeStore.push(m);
    return id;
  });
  // inline code `...`
  s = s.replace(/`[^`]*`/g, (m) => {
    const id = `${CODE_PH}${codeStore.length}@@`;
    codeStore.push(m);
    return id;
  });
  return s;
}

function restoreCodePlaceholders(html, codeStore) {
  let out = html;
  for (let i = 0; i < codeStore.length; i++) {
    const ph = `${CODE_PH}${i}@@`;
    // code placeholders should be replaced with their escaped/marked form
    // — re-parse them through marked inline so they become <code> as usual
    const codeSrc = codeStore[i];
    let rendered;
    if (marked) {
      try { rendered = sanitizeHtml(marked.parse(codeSrc)); }
      catch { rendered = `<code>${escapeHtml(codeSrc.slice(1, -1))}</code>`; }
    } else {
      const inner = codeSrc.startsWith("```") ? codeSrc : codeSrc.slice(1, -1);
      rendered = codeSrc.startsWith("```")
        ? `<pre><code>${escapeHtml(inner.replace(/^```\w*\n?/, "").replace(/```$/, ""))}</code></pre>`
        : `<code>${escapeHtml(inner)}</code>`;
    }
    // placeholders appear as plain text in the HTML (escaped by marked's paragraph wrapping)
    // so replace with case that marked may have wrapped; do simple string replace on the escaped placeholder
    out = out.split(ph).join(rendered);
    // also handle case where the placeholder got wrapped in <p> by marked
    out = out.split(`<p>${ph}</p>`).join(rendered);
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
    if (/^[\d,\.]+$/.test(t)) return `$${body}$`;
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
  // Fallback without marked: re-inject code as escaped, then paragraphs.
  let fallbackRaw = tmp;
  for (let i = 0; i < codeStore.length; i++) fallbackRaw = fallbackRaw.split(`${CODE_PH}${i}@@`).join(codeStore[i]);
  const parts = fallbackRaw.split(new RegExp(`(${MATH_PH}\\d+@@)`, "g"));
  const htmlParts = parts.map((part) => {
    const m = part.match(new RegExp(`^${MATH_PH}(\\d+)@@$`));
    if (m) {
      const idx = Number(m[1]);
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
