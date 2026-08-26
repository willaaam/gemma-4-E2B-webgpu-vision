// Context management for the document workstation.
//
// Architectural and effective limits are deliberately separate. The effective
// value comes from the loaded engine; character estimates are only the early UI
// fallback before a tokenizer is available.
// Strategy: estimate tokens (≈ chars/4); if the selected corpus fits the
// stuffing budget, inline everything; otherwise fall back to BM25 retrieval
// over pre-chunked documents. Pure JS, no dependencies, no embedding model.

export const TOKENS_PER_CHAR = 0.25; // ≈ 4 chars per token for English prose

// The prompt wrapper is roughly 1.4K tokens and Research allows up to 3K output.
// The default document budget is conservative; the active budget is reduced by
// the exact prompt size and the effective cache capacity reported by the model.
export const ARCHITECTURAL_CONTEXT_TOKENS = 131_072;
export const MODEL_CONTEXT_TOKENS = ARCHITECTURAL_CONTEXT_TOKENS;
export const STUFF_TOKEN_BUDGET = 3_500;
export const RESPONSE_TOKEN_RESERVE = 3_000;

export function estTokens(text) {
  return Math.ceil((text || "").length * TOKENS_PER_CHAR);
}

export function effectiveContextLimit(capabilities) {
  const value = Number(capabilities?.effectiveContextMax);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : MODEL_CONTEXT_TOKENS;
}

function boundedTokenCounter(tokenCounter) {
  return typeof tokenCounter === "function"
    ? (text) => Math.max(0, Math.ceil(Number(tokenCounter(text)) || 0))
    : estTokens;
}

function fitText(text, budget, tokenCounter) {
  if (budget <= 0 || !text) return "";
  if (tokenCounter(text) <= budget) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (tokenCounter(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd();
}

// ---- Chunking ----

export function chunkText(text, { size = 1200, overlap = 150 } = {}) {
  const clean = String(text || "").replace(/\r\n/g, "\n");
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      // prefer breaking at a paragraph/sentence boundary within the last 40%
      const windowStart = start + Math.floor(size * 0.6);
      const cut = Math.max(
        clean.lastIndexOf("\n\n", end),
        clean.lastIndexOf(". ", end),
        clean.lastIndexOf("\n", end)
      );
      if (cut >= windowStart) end = cut + 1;
    }
    const body = clean.slice(start, end).trim();
    if (body) chunks.push(body);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

// ---- BM25 ----

const STOPWORDS = new Set(("a,an,and,are,as,at,be,but,by,for,if,in,into,is,it,no,not,of,on,or,such,that,the,their,then,there,these,they,this,to,was,will,with,what,when,where,who,whom,which,why,how,do,does,did,can,could,should,would,may,might,must,shall,about,after,all,also,any,because,before,between,both,during,each,few,from,further,had,has,have,he,her,his,i,its,itself,just,me,more,most,my,nor,now,only,other,our,ours,same,she,so,some,than,too,up,us,very,you,your").split(","));

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

export class BM25Index {
  constructor() {
    this.docs = [];       // { text, meta }
    this.tf = [];         // term freq maps
    this.docLen = [];
    this.df = new Map();  // doc frequency per term
    this.avgLen = 0;
  }

  add(text, meta = {}) {
    const i = this.docs.length;
    const terms = tokenize(text);
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.push({ text, meta });
    this.tf.push(tf);
    this.docLen.push(terms.length);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.docLen.reduce((a, b) => a + b, 0) / this.docs.length;
    return i;
  }

  get size() { return this.docs.length; }

  search(query, k = 8) {
    if (this.docs.length === 0) return [];
    const N = this.docs.length;
    const k1 = 1.5, b = 0.75;
    const qTerms = tokenize(query);
    const scores = new Float64Array(N);
    for (const qt of qTerms) {
      const df = this.df.get(qt) ?? 0;
      if (!df) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < N; i++) {
        const f = this.tf[i].get(qt) ?? 0;
        if (!f) continue;
        const denom = f + k1 * (1 - b + b * (this.docLen[i] / (this.avgLen || 1)));
        scores[i] += idf * ((f * (k1 + 1)) / denom);
      }
    }
    const ranked = [];
    for (let i = 0; i < N; i++) if (scores[i] > 0) ranked.push({ index: i, score: scores[i] });
    ranked.sort((a, z) => z.score - a.score);
    return ranked.slice(0, k).map(({ index, score }) => ({ ...this.docs[index], score }));
  }
}

// ---- Context assembly ----
//
// buildContext({ docs, query }) → { mode: "stuff"|"bm25"|"none", blocks, estTokensUsed }
//   docs: [{ id, name, pages?, text, chunks? }] — already parsed documents
//   query: current user question (used only in bm25 mode)

export function buildContext({
  docs,
  query = "",
  stuffBudget = STUFF_TOKEN_BUDGET,
  contextBudget = stuffBudget,
  tokenCounter,
} = {}) {
  const active = (docs ?? []).filter((d) => d && d.text);
  if (active.length === 0) return { mode: "none", blocks: [], estTokensUsed: 0 };
  const countTokens = boundedTokenCounter(tokenCounter);
  const budget = Math.max(0, Math.floor(Number(contextBudget) || 0));

  // Try stuffing first: everything, each capped individually so one huge doc
  // can't starve the rest (cap per doc keeps order stable and predictable).
  const totalTokens = active.reduce((sum, d) => sum + countTokens(d.text), 0);
  if (totalTokens <= budget) {
    const blocks = active.map((d) => ({
      label: d.name,
      provenance: "full document",
      text: d.text,
    }));
    return { mode: "stuff", blocks, estTokensUsed: totalTokens };
  }

  // BM25 fallback over chunks.
  const index = new BM25Index();
  for (const d of active) {
    const chunks = d.chunks?.length ? d.chunks : chunkText(d.text);
    chunks.forEach((c, i) => index.add(c, { docId: d.id, docName: d.name, chunk: i + 1, of: chunks.length }));
  }
  const hits = index.search(query, 10);
  if (hits.length === 0) {
    // Query matched nothing — degrade gracefully to the head of each document.
    const blocks = [];
    let used = 0;
    for (const d of active.slice(0, 4)) {
      const text = fitText(d.text.slice(0, 6000), budget - used, countTokens);
      if (!text) continue;
      blocks.push({ label: d.name, provenance: "beginning (no keyword match)", text });
      used += countTokens(text);
      if (used >= budget) break;
    }
    return { mode: "bm25", blocks, estTokensUsed: used, budgetTokens: budget, truncated: used < active.reduce((s, d) => s + countTokens(d.text), 0) };
  }
  const blocks = [];
  let used = 0;
  for (const h of hits) {
    const text = fitText(h.text, budget - used, countTokens);
    if (!text) break;
    blocks.push({
      label: `${h.meta.docName} · part ${h.meta.chunk}/${h.meta.of}`,
      provenance: `BM25 match (score ${h.score.toFixed(2)})`,
      text,
    });
    used += countTokens(text);
    if (used >= budget) break;
  }
  return { mode: "bm25", blocks, estTokensUsed: used, budgetTokens: budget, truncated: blocks.length < hits.length || used >= budget };
}

// Render context blocks into a prompt-ready string with provenance headers.
export function renderContextBlocks(blocks) {
  return blocks
    .map((b, i) => `[Document ${i + 1}: ${b.label} — ${b.provenance}]\n${b.text}`)
    .join("\n\n---\n\n");
}
