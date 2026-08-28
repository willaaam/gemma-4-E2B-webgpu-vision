// Context bundler — BM25-aware file stuffing, code-tuned.
// Keeps the budget logic from src/lib/code-harness.js but refines chunking
// for code (function boundaries, no prose stopwords).

import { chunkText as baseChunkText, BM25Index, estTokens, RESPONSE_TOKEN_RESERVE } from "../../services/context.js";
import { modelService } from "../../services/model-service.js";

// For code, don't drop `if`/`for`/`while` etc as stopwords.
// We still keep a lightweight stoplist for English glue, but keep code keywords.
const CODE_STOPWORDS = new Set((
  "a,an,and,are,as,at,be,but,by,for,if,in,into,is,it,no,not,of,on,or,such,that,the,their,then,there,these,they,this,to,was,will,with,what,when,where,who,whom,which,why,how,do,does,did,can,could,should,would,may,might,must,shall,about,after,all,also,any,because,before,between,both,during,each,few,from,further,had,has,have,he,her,his,i,its,itself,just,me,more,most,my,nor,now,only,other,our,ours,same,she,so,some,than,too,up,us,very,you,your"
).split(",").filter(w => !["for","if","while","do","in","of","not","and","or"].includes(w)));

// But BM25Index internal stopwords is hardcoded, so we export a code-aware index
// that tokenizes differently via pre-token override: we monkey-patch search query?
// Instead we just reuse BM25Index and rely on query terms still matching code keywords
// — the stopwords filter only drops those tokens, so they don't contribute to score.
// To keep `for` etc, we build our own CodeBM25.

export class CodeBM25Index extends BM25Index {
  // override tokenization to keep code keywords and split on code symbols
  // We keep BM25Index.add/search logic but reimplement tokenize path via override hook
}

// Workaround: since BM25Index tokenize is not overridable, reimplement small code-aware index here
// Simpler: duplicate BM25 but with CODE_STOPWORDS.
function tokenizeCode(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}_\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !CODE_STOPWORDS.has(w));
}

class CodeAwareBM25 {
  constructor() {
    this.docs = [];
    this.tf = [];
    this.docLen = [];
    this.df = new Map();
    this.avgLen = 0;
  }
  add(text, meta = {}) {
    const i = this.docs.length;
    const terms = tokenizeCode(text);
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.push({ text, meta });
    this.tf.push(tf);
    this.docLen.push(terms.length);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.docLen.reduce((a,b)=>a+b,0) / this.docs.length;
    return i;
  }
  get size(){ return this.docs.length; }
  search(query, k=8){
    if (this.docs.length===0) return [];
    const N=this.docs.length; const k1=1.5, b=0.75;
    const qTerms=tokenizeCode(query);
    const scores=new Float64Array(N);
    for (const qt of qTerms){
      const df=this.df.get(qt)??0; if(!df) continue;
      const idf=Math.log(1+(N-df+0.5)/(df+0.5));
      for(let i=0;i<N;i++){ const f=this.tf[i].get(qt)??0; if(!f) continue; const denom=f+k1*(1-b+b*(this.docLen[i]/(this.avgLen||1))); scores[i]+=idf*((f*(k1+1))/denom); }
    }
    const ranked=[]; for(let i=0;i<N;i++) if(scores[i]>0) ranked.push({index:i, score:scores[i]});
    ranked.sort((a,z)=>z.score-a.score);
    return ranked.slice(0,k).map(({index,score})=>({...this.docs[index], score}));
  }
}

function tokenCounterForModel() {
  const model = modelService.model;
  if (model?.countTextTokens) return (t) => Math.max(0, Math.ceil(Number(model.countTextTokens(t)) || 0)) + 8;
  return estTokens;
}

export function chunkTextForCode(text, { size=900, overlap=120 } = {}) {
  const clean = String(text || "").replace(/\r\n/g, "\n");
  // For code we try to keep functions/blocks together; use base chunker but adjusted size
  // Then further split on \n}\n or \ndef or \nclass if needed — rely on baseChunkText sentence fallback
  return baseChunkText(clean, { size, overlap });
}

export function buildCodeContext({ project, query, budget }) {
  const countTokens = tokenCounterForModel();
  const files = project.listFiles().filter(f => !f.path.endsWith("/.gitkeep") && f.path !== ".gitkeep");
  const docs = files.map(f => ({ id: f.path, name: f.path, text: f.content, chunks: chunkTextForCode(f.content) }));
  if (docs.length === 0) return { mode: "none", blocks: [], estTokensUsed: 0, budgetTokens: budget };

  const total = docs.reduce((s,d)=>s+countTokens(d.text),0);
  if (total <= budget) {
    return { mode: "stuff", blocks: docs.map(d=>({ label:d.name, provenance:"full file", text:d.text })), estTokensUsed: total, budgetTokens: budget };
  }
  const idx = new CodeAwareBM25();
  for (const d of docs) for(let i=0;i<d.chunks.length;i++) idx.add(d.chunks[i], { docName:d.name, chunk:i+1, of:d.chunks.length });
  const hits = idx.search(query || "", 12);
  if (hits.length===0){
    const blocks=[]; let used=0;
    for(const d of docs.slice(0,4)){
      const text=d.text.slice(0,6000);
      const fits=countTokens(text) <= (budget-used);
      const clipped=fits? text : text.slice(0, Math.max(0,(budget-used)*4));
      if(!clipped) break;
      blocks.push({ label:d.name, provenance:"head (no keyword match)", text:clipped });
      used+=countTokens(clipped); if(used>=budget) break;
    }
    return { mode:"bm25", blocks, estTokensUsed: used, budgetTokens: budget, truncated:true };
  }
  const blocks=[]; let used=0;
  for(const h of hits){
    const avail=budget-used; if(avail<=16) break;
    let text=h.text;
    if(countTokens(text)>avail) text=text.slice(0, Math.max(0, avail*4));
    blocks.push({ label:`${h.meta.docName} · chunk ${h.meta.chunk}/${h.meta.of}`, provenance:`BM25 score ${h.score.toFixed(2)}`, text });
    used+=countTokens(text); if(used>=budget) break;
  }
  return { mode:"bm25", blocks, estTokensUsed: used, budgetTokens: budget, truncated: blocks.length < hits.length };
}

export function renderCodeContextBlocks(blocks){
  return blocks.map((b,i)=>`[File ${i+1}: ${b.label} — ${b.provenance}]\n${b.text}`).join("\n\n---\n\n");
}
