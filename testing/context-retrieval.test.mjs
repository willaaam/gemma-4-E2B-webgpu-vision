// testing/context-retrieval.test.mjs — Node unit tests for BM25 context assembly.
//
// The bug this guards: retrieval used to rank every chunk of every document in
// one global list, so a single long or term-dense document could fill the whole
// budget and the other selected documents contributed nothing — making
// "compare these documents" impossible. Retrieval now runs per document first.
//
// Usage: node testing/context-retrieval.test.mjs

import { BM25Index, buildContext, renderContextBlocks, groupBlocksByDocument, chunkText } from "../src/services/context.js";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Deterministic char-based counter so budgets are easy to reason about (≈4 chars/token).
const tokens = (text) => Math.ceil(String(text ?? "").length / 4);

const A_CHUNKS = [
  "Wombat census methods. The wombat population survey uses burrow counts across eight transects.",
  "Wombat habitat notes. Wombat burrows cluster near creek banks where soil drains well.",
  "Wombat diet summary. Wombat grazing peaks at dusk, mostly native grasses.",
];
const B_CHUNKS = [
  "Penguin colony report. The penguin colony on the southern shore grew by four nests.",
  "Penguin feeding data. Penguin foraging trips last two days on average.",
];
const C_CHUNKS = [
  "Llama herd inventory. The llama herd was counted at 37 adults and 6 juveniles.",
  "Llama veterinary log. Llama vaccinations were completed in early spring.",
];

function makeDoc(id, name, chunks) {
  return { id, name, text: chunks.join("\n\n"), chunks };
}

const docs = [
  makeDoc("a", "Alpha.pdf", A_CHUNKS),
  makeDoc("b", "Bravo.pdf", B_CHUNKS),
  makeDoc("c", "Charlie.pdf", C_CHUNKS),
];

const startOf = (label) => label.split(" · ")[0]; // block labels are "<doc> · part n/m"
const docOrder = (blocks) => [...new Set(blocks.map((b) => startOf(b.label)))];
const blocksOf = (blocks, name) => blocks.filter((b) => startOf(b.label) === name);

// --- stuffing still wins when everything fits ---------------------------------

{
  const ctx = buildContext({ docs, query: "wombat", contextBudget: 1000, tokenCounter: tokens });
  eq("stuff: mode", ctx.mode, "stuff");
  eq("stuff: one block per document", ctx.blocks.length, 3);
  check("stuff: full documents", ctx.blocks.every((b) => b.provenance === "full document"));
  eq("stuff: order follows selection", docOrder(ctx.blocks).join(","), "Alpha.pdf,Bravo.pdf,Charlie.pdf");
  check("stuff: blocks carry document identity",
    ctx.blocks.every((b, i) => b.docId === docs[i].id && b.docName === docs[i].name));
  // Regression guard: a document contributing one block must render exactly as
  // the old flat renderer did. Only multi-chunk documents change shape.
  eq("stuff: prompt keeps the compact one-line form", renderContextBlocks(ctx.blocks),
    docs.map((d, i) => `[Document ${i + 1}: ${d.name} — full document]\n${d.text}`).join("\n\n---\n\n"));
}

// --- multi-document coverage (the regression) ---------------------------------

{
  // Only Alpha matches "wombat"; Bravo and Charlie must still be represented —
  // this is the regression: a global top-k returned Alpha-only context.
  const ctx = buildContext({ docs, query: "wombat", contextBudget: 60, tokenCounter: tokens });
  eq("coverage: mode", ctx.mode, "bm25");
  check("coverage: every selected document contributes at least one block",
    ["Alpha.pdf", "Bravo.pdf", "Charlie.pdf"].every((n) => blocksOf(ctx.blocks, n).length >= 1),
    `blocks: ${ctx.blocks.map((b) => b.label).join(" | ")}`);
  eq("coverage: grouped in selection order", docOrder(ctx.blocks).join(","), "Alpha.pdf,Bravo.pdf,Charlie.pdf");
  check("coverage: budget respected", ctx.estTokensUsed <= 60, `used ${ctx.estTokensUsed}`);
  check("coverage: matching doc reports a per-document top match",
    blocksOf(ctx.blocks, "Alpha.pdf")[0].provenance.startsWith("top match for this document"),
    blocksOf(ctx.blocks, "Alpha.pdf")[0].provenance);
  check("coverage: non-matching docs open with their own text",
    blocksOf(ctx.blocks, "Bravo.pdf")[0].provenance === "beginning (no keyword match)"
    && blocksOf(ctx.blocks, "Bravo.pdf")[0].text.startsWith("Penguin colony report")
    && blocksOf(ctx.blocks, "Charlie.pdf")[0].text.startsWith("Llama herd inventory"),
    `${blocksOf(ctx.blocks, "Bravo.pdf")[0].text.slice(0, 24)} / ${blocksOf(ctx.blocks, "Charlie.pdf")[0].text.slice(0, 24)}`);
  check("coverage: the fallback chunk is the document's first chunk",
    blocksOf(ctx.blocks, "Bravo.pdf")[0].provenance.includes("beginning")
    && !blocksOf(ctx.blocks, "Bravo.pdf")[0].text.includes("foraging"));
  check("coverage: blocks carry document identity", ctx.blocks.every((b) => b.docId && b.docName));
}

// --- grouping: inspector view and prompt ---------------------------------------

{
  const ctx = buildContext({ docs, query: "wombat", contextBudget: 100, tokenCounter: tokens });
  const groups = groupBlocksByDocument(ctx.blocks);
  eq("groups: one per document", groups.length, 3);
  eq("groups: order follows selection", groups.map((g) => g.docName).join(","), "Alpha.pdf,Bravo.pdf,Charlie.pdf");
  eq("groups: chunks stay together", groups.map((g) => g.blocks.length).join(","), "3,1,1");
  check("groups: every block belongs to its own document",
    groups.every((g) => g.blocks.every((b) => b.docId === g.docId && b.docName === g.docName)));
  check("groups: unknown document falls back to the label",
    groupBlocksByDocument([{ label: "Solo.pdf", provenance: "p", text: "t" }])[0].docName === "Solo.pdf");

  // The complaint this fixes: a 10-document comparison used to list ~30 chunk
  // entries, each repeating the document name.
  const prompt = renderContextBlocks(ctx.blocks);
  eq("prompt: each document name appears exactly once",
    ["Alpha.pdf", "Bravo.pdf", "Charlie.pdf"].map((n) => prompt.split(n).length - 1).join(","), "1,1,1");
  check("prompt: the document header counts its chunks",
    prompt.includes("[Document 1: Alpha.pdf — 3 chunks]"), prompt.slice(0, 90));
  check("prompt: chunks are numbered against their document",
    /\[Chunk \d+\/3 — top match for this document \(score [\d.]+\)\]/.test(prompt)
    && /\[Chunk \d+\/3 — BM25 match \(score [\d.]+\)\]/.test(prompt),
    prompt.slice(0, 200));
  check("prompt: documents are still separated by the usual rule",
    prompt.includes("\n\n---\n\n[Document 2: Bravo.pdf"));
  check("prompt: a single-block document keeps the compact header",
    prompt.includes("[Document 2: Bravo.pdf — beginning (no keyword match)]"), prompt.slice(-200));
  check("prompt: no document name is repeated inside its own chunk headers",
    !prompt.includes("[Chunk 1/3 — ") || !prompt.includes("Alpha.pdf — BM25"));
}

// --- leftover budget goes to the best remaining chunks -------------------------

{
  // 100 tokens < the ~142 the three documents need, so this is bm25 mode while
  // still leaving room for Alpha's other chunks after the coverage pass.
  const ctx = buildContext({ docs, query: "wombat", contextBudget: 100, tokenCounter: tokens });
  const alpha = blocksOf(ctx.blocks, "Alpha.pdf");
  check("fill: leftover budget adds extra chunks of the matching document", alpha.length >= 2, `got ${alpha.length}`);
  check("fill: blocks stay grouped per document",
    docOrder(ctx.blocks).join(",") === "Alpha.pdf,Bravo.pdf,Charlie.pdf");
  check("fill: budget respected", ctx.estTokensUsed <= 100, `used ${ctx.estTokensUsed}`);
  check("fill: extra chunks are labelled as BM25 matches",
    alpha.slice(1).every((b) => b.provenance.startsWith("BM25 match")));
  check("fill: every chunk of the matching document is used", alpha.length === A_CHUNKS.length, `got ${alpha.length}`);
}

// --- no keyword match anywhere -------------------------------------------------

{
  const ctx = buildContext({ docs, query: "zebra", contextBudget: 60, tokenCounter: tokens });
  eq("no match: mode", ctx.mode, "bm25");
  eq("no match: still one block per document", ctx.blocks.length, 3);
  check("no match: every block is an opening fallback",
    ctx.blocks.every((b) => b.provenance === "beginning (no keyword match)"));
  check("no match: budget respected", ctx.estTokensUsed <= 60, `used ${ctx.estTokensUsed}`);
}

// --- single document and tiny budgets ------------------------------------------

{
  const ctx = buildContext({ docs: [docs[0]], query: "wombat", contextBudget: 30, tokenCounter: tokens });
  check("single doc: contributes at least one block", ctx.blocks.length >= 1, `got ${ctx.blocks.length}`);
  check("single doc: every block belongs to it", blocksOf(ctx.blocks, "Alpha.pdf").length === ctx.blocks.length);
  check("single doc: budget respected", ctx.estTokensUsed <= 30, `used ${ctx.estTokensUsed}`);
}

{
  // Degenerate case: less budget than documents. The budget must still hold.
  const ctx = buildContext({ docs, query: "wombat", contextBudget: 2, tokenCounter: tokens });
  check("tiny budget: never exceeds the budget", ctx.estTokensUsed <= 2, `used ${ctx.estTokensUsed}`);
  check("tiny budget: covers as many documents as it can", ctx.blocks.length === 2, `got ${ctx.blocks.length}`);
}

{
  const ctx = buildContext({ docs, query: "wombat", contextBudget: 0, tokenCounter: tokens });
  eq("zero budget: no blocks", ctx.blocks.length, 0);
  eq("zero budget: nothing spent", ctx.estTokensUsed, 0);
}

// --- empty / absent input ------------------------------------------------------

eq("no docs: mode none", buildContext({ docs: [], query: "x" }).mode, "none");
eq("no docs: no blocks", buildContext({ docs: [], query: "x" }).blocks.length, 0);
eq("empty text is skipped", buildContext({ docs: [{ id: "z", name: "Z", text: "" }], query: "x" }).mode, "none");

// --- BM25Index.search ----------------------------------------------------------

{
  const index = new BM25Index();
  A_CHUNKS.forEach((c, i) => index.add(c, { docId: "a", docName: "Alpha.pdf", chunk: i + 1, of: A_CHUNKS.length }));
  B_CHUNKS.forEach((c, i) => index.add(c, { docId: "b", docName: "Bravo.pdf", chunk: i + 1, of: B_CHUNKS.length }));
  eq("index: size counts chunks", index.size, 5);

  const global = index.search("wombat penguin", 10);
  check("index: global search spans documents", new Set(global.map((h) => h.meta.docId)).size === 2);
  check("index: hits carry a stable chunk id", global.every((h) => Number.isInteger(h.id)));

  const onlyB = index.search("penguin", 10, { docId: "b" });
  check("index: docId filter restricts the ranking", onlyB.length === 2 && onlyB.every((h) => h.meta.docId === "b"));
  eq("index: unknown docId yields nothing", index.search("penguin", 10, { docId: "nope" }).length, 0);
  eq("index: unrelated query yields nothing", index.search("zebra", 10).length, 0);
}

// --- chunking + rendering still work -------------------------------------------

{
  const chunks = chunkText("a".repeat(3000), { size: 1200, overlap: 150 });
  check("chunkText: splits long text", chunks.length >= 3, `got ${chunks.length}`);
  eq("chunkText: empty input", chunkText("").length, 0);

  const rendered = renderContextBlocks([
    { label: "Alpha.pdf · part 1/3", provenance: "top match for this document (score 1.23)", text: "Body." },
  ]);
  check("renderContextBlocks: keeps the provenance header",
    rendered.startsWith("[Document 1: Alpha.pdf · part 1/3 — top match for this document (score 1.23)]"), rendered);
}

console.log(`\ncontext-retrieval: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("context-retrieval: all green");
