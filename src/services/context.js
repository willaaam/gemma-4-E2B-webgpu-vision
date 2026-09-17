// Context management for the document workstation.
//
// Architectural and effective limits are deliberately separate. The effective
// value comes from the loaded engine; character estimates are only the early UI
// fallback before a tokenizer is available.
// Strategy: estimate tokens (≈ chars/4); if the selected corpus fits the
// stuffing budget, inline everything; otherwise fall back to BM25 retrieval
// over pre-chunked documents. Retrieval runs per document first, so comparing
// several documents always sees content from each of them. Pure JS, no
// dependencies, no embedding model.

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

  // k = how many hits to return; docId restricts ranking to a single document
  // (per-document retrieval). `id` is the chunk's index, so callers can tell
  // which chunks are already in the context.
  search(query, k = 8, { docId } = {}) {
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
    for (let i = 0; i < N; i++) {
      if (scores[i] <= 0) continue;
      if (docId !== undefined && this.docs[i].meta?.docId !== docId) continue;
      ranked.push({ index: i, score: scores[i] });
    }
    ranked.sort((a, z) => z.score - a.score);
    return ranked.slice(0, k).map(({ index, score }) => ({ ...this.docs[index], score, id: index }));
  }
}

// ---- Context assembly ----
//
// buildContext({ docs, query }) → { mode: "stuff"|"bm25"|"none", blocks, estTokensUsed }
//   docs: [{ id, name, pages?, text, chunks? }] — already parsed documents
//   query: current user question (used only in bm25 mode)
//
// In bm25 mode every selected document contributes at least one block: the
// first pass retrieves the best chunk of each document individually, and only
// then is the remaining budget spent on the globally highest-scoring chunks.
// Blocks stay grouped per document, in selection order, so the inspector reads
// as a comparison. Without the per-document pass a single long or term-dense
// document can fill the whole budget and the others contribute nothing.

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

  // BM25 fallback over chunks, retrieved per document.
  const index = new BM25Index();
  const docChunks = new Map();
  for (const d of active) {
    const chunks = d.chunks?.length ? d.chunks : chunkText(d.text);
    docChunks.set(d.id, chunks);
    chunks.forEach((c, i) => index.add(c, { docId: d.id, docName: d.name, chunk: i + 1, of: chunks.length }));
  }
  const perDoc = new Map(active.map((d) => [d.id, index.search(query, 10, { docId: d.id })]));

  const groups = new Map(active.map((d) => [d.id, []]));
  const usedChunks = new Set();
  let used = 0;

  const addBlock = ({ doc, chunkId = null, label, provenance, text, limit }) => {
    const allowance = Math.min(limit, budget - used);
    const fitted = fitText(text, allowance, countTokens);
    if (!fitted) return false;
    groups.get(doc.id).push({ label, provenance, text: fitted });
    used += countTokens(fitted);
    if (chunkId !== null) usedChunks.add(chunkId);
    return true;
  };

  // Pass 1 — one block per selected document, each capped at an equal share so
  // no single document can starve the others. A document with no keyword match
  // still contributes its opening text, which keeps it comparable.
  const share = Math.max(1, Math.floor(budget / active.length));
  for (const doc of active) {
    const best = perDoc.get(doc.id)[0];
    addBlock(best
      ? {
        doc,
        chunkId: best.id,
        label: `${doc.name} · part ${best.meta.chunk}/${best.meta.of}`,
        provenance: `top match for this document (score ${best.score.toFixed(2)})`,
        text: best.text,
        limit: share,
      }
      : {
        doc,
        label: doc.name,
        provenance: "beginning (no keyword match)",
        text: docChunks.get(doc.id)[0] ?? doc.text.slice(0, 6000),
        limit: share,
      });
  }

  // Pass 2 — spend whatever is left on the best chunks not already included.
  const pool = index.search(query, Math.max(10, active.length * 8));
  for (const hit of pool) {
    if (used >= budget) break;
    if (usedChunks.has(hit.id)) continue;
    const doc = active.find((d) => d.id === hit.meta.docId);
    if (!doc) continue;
    addBlock({
      doc,
      chunkId: hit.id,
      label: `${hit.meta.docName} · part ${hit.meta.chunk}/${hit.meta.of}`,
      provenance: `BM25 match (score ${hit.score.toFixed(2)})`,
      text: hit.text,
      limit: budget,
    });
  }

  return {
    mode: "bm25",
    blocks: active.flatMap((d) => groups.get(d.id) ?? []),
    estTokensUsed: used,
    budgetTokens: budget,
    truncated: usedChunks.size < index.size,
  };
}

// Render context blocks into a prompt-ready string with provenance headers.
export function renderContextBlocks(blocks) {
  return blocks
    .map((b, i) => `[Document ${i + 1}: ${b.label} — ${b.provenance}]\n${b.text}`)
    .join("\n\n---\n\n");
}
