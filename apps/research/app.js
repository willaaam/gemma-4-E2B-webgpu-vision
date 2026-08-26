// Research workstation app.
// Three panes: library (left) · chat (center) · context inspector (right).
//
// Context strategy lives in src/services/context.js: stuff whole documents
// while they fit the current device budget, otherwise BM25-retrieve chunks. The
// inspector always shows exactly what the model will see.

import { modelService } from "../../src/services/model-service.js";
import { acquireLock, complete, streamGeneration, generationStats, ContextLimitError } from "../../src/services/generation.js";
import { db, newId } from "../../src/services/db.js";
import { thinkMessages } from "../../src/services/settings.js";
import { createChatThread } from "../../src/lib/chat-thread.js";
import { formatDocumentMarkdown } from "../../src/lib/document-markdown.js";
import { buildContext, renderContextBlocks, estTokens, chunkText, effectiveContextLimit, RESPONSE_TOKEN_RESERVE } from "../../src/services/context.js";
import { getContextLimitPreference, onContextLimitChange, selectedContextLimit } from "../../src/services/context-preference.js";
import { parseFile, isSupported, kindOf, renderPdfPageToDataUrl } from "./parsers.js";

let els = {};
let docs = [];            // parsed documents in memory this session
let selected = new Set(); // doc ids included in context
let messages = [];        // chat turns for this session
let generating = false;
let abortController = null;
let lastContext = null;
let unsubModel = null;
let unsubContext = null;
let threadView = null;
let conversationVersion = 0;
const pendingOcr = new Set();
let ocrQueueRunning = false;

const ACTIONS = [
  { id: "summarize", label: "Summarize", prompt: "Summarize the document(s) above. Cover the main points faithfully and concisely, preserving important numbers and names." },
  { id: "actions", label: "Action items", prompt: "Extract every action item, commitment or deadline mentioned in the document(s). Present as a checklist with owner and due date where stated." },
  { id: "figures", label: "Key figures", prompt: "List the key figures, metrics and dates in the document(s) as a markdown table with columns: Figure | Value | Context." },
  { id: "compare", label: "Compare docs", prompt: "Compare the documents above: what they agree on, where they differ, and anything unique to each. Use a short table plus a verdict paragraph." },
  { id: "study", label: "Study questions", prompt: "Create 8 study questions with answers based strictly on the document(s), mixing recall and understanding." },
];

export const researchApp = {
  id: "research",
  title: "Research",

  mount(container) {
    els = {};
    this.buildDom(container);
    threadView = createChatThread({ scrollEl: els.threadScroll, threadEl: els.thread });
    unsubModel = modelService.subscribe(() => {
      syncState();
      processOcrQueue();
    });
    unsubContext = onContextLimitChange(() => {
      lastContext = null;
      syncState();
    });
    syncState();
    restoreLibrary().catch(console.error);
  },

  unmount() {
    abortController?.abort();
    unsubModel?.();
    unsubModel = null;
    unsubContext?.();
    unsubContext = null;
  },

  buildDom(root) {
    const wrap = document.createElement("div");
    wrap.className = "ws-app research-app";
    wrap.innerHTML = `
      <div class="ws-tri">
        <section class="ws-pane ws-pane-left">
          <div class="ws-pane-head"><h3>Library</h3>
            <div class="ws-head-actions">
              <button class="ws-btn ghost small" data-act="add">+ Add</button>
              <input type="file" data-role="file" multiple accept=".txt,.md,.markdown,.json,.csv,.tsv,.log,.pdf,.docx,.html,.htm,image/*" hidden>
            </div>
          </div>
          <div class="ws-lib-status mono" data-role="libStatus" hidden></div>
          <div class="ws-lib" data-role="lib"></div>
          <div class="ws-lib-foot mono" data-role="libStats"></div>
        </section>
        <section class="ws-pane ws-pane-mid">
          <div class="ws-thread-scroll" data-role="threadScroll"><div class="ws-thread" data-role="thread">
            <div class="ws-empty">Add documents, then ask anything about them.<br>Answers come only from your files — nothing leaves the device.</div>
          </div></div>
          <div class="ws-actions-row" data-role="actions"></div>
          <footer class="ws-composer">
            <textarea data-role="input" rows="1" placeholder="Load the model to ask about your documents…" disabled></textarea>
            <button class="ws-btn primary" data-role="send" disabled>Ask</button>
            <button class="ws-btn danger" data-role="stop" hidden>Stop</button>
          </footer>
        </section>
        <section class="ws-pane ws-pane-right">
          <div class="ws-pane-head"><h3>Context inspector</h3></div>
          <div class="ws-inspector" data-role="inspector">
            <div class="ws-empty small">Context shown here before each answer.</div>
          </div>
        </section>
      </div>`;
    root.replaceChildren(wrap);

    Object.assign(els, {
      root: wrap,
      lib: wrap.querySelector('[data-role="lib"]'),
      libStats: wrap.querySelector('[data-role="libStats"]'),
      libStatus: wrap.querySelector('[data-role="libStatus"]'),
      fileInput: wrap.querySelector('[data-role="file"]'),
      threadScroll: wrap.querySelector('[data-role="threadScroll"]'),
      thread: wrap.querySelector('[data-role="thread"]'),
      actionsRow: wrap.querySelector('[data-role="actions"]'),
      input: wrap.querySelector('[data-role="input"]'),
      sendBtn: wrap.querySelector('[data-role="send"]'),
      stopBtn: wrap.querySelector('[data-role="stop"]'),
      inspector: wrap.querySelector('[data-role="inspector"]'),
    });
    wrap.querySelector('[data-act="add"]').addEventListener("click", () => els.fileInput.click());
    els.fileInput.addEventListener("change", onFilesPicked);
    els.sendBtn.addEventListener("click", () => ask(els.input.value.trim()));
    els.stopBtn.addEventListener("click", () => abortController?.abort());
    els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!els.sendBtn.disabled) ask(els.input.value.trim()); }
    });
    els.input.addEventListener("input", autoGrow);

    // drag & drop files anywhere onto the library pane
    const dropZone = wrap.querySelector(".ws-pane-left");
    let dragDepth = 0;
    dropZone.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; dropZone.classList.add("dragging"); });
    dropZone.addEventListener("dragover", (e) => e.preventDefault());
    dropZone.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; dropZone.classList.remove("dragging"); } });
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      dropZone.classList.remove("dragging");
      const dropped = [...(e.dataTransfer?.files ?? [])];
      if (dropped.length) ingestFiles(dropped);
    });

    for (const a of ACTIONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ws-chip small";
      btn.textContent = a.label;
      btn.disabled = true;
      btn.dataset.action = a.id;
      btn.addEventListener("click", () => runAction(a));
      els.actionsRow.appendChild(btn);
    }
  },
};

function syncState() {
  const ready = modelService.ready;
  els.input.disabled = !ready || generating;
  els.input.placeholder = ready ? "Ask about your documents…" : "Load the model to ask about your documents…";
  if (!generating) els.sendBtn.disabled = !ready;
  for (const b of els.actionsRow.children) b.disabled = !ready || generating;
  updateLibStats();
}

// Restore previously parsed documents and their local source files so pending OCR
// can continue after a reload.
async function restoreLibrary() {
  try {
    const saved = await db.all("documents");
    for (const d of saved.sort((a, b) => a.addedAt - b.addedAt)) {
      if (docs.some((x) => x.id === d.id)) continue;
      docs.push({
        id: d.id,
        name: d.name,
        kind: d.kind,
        text: d.text ?? "",
        pages: d.pages ?? null,
        needsOcr: !!d.needsOcr,
        size: d.size ?? 0,
        addedAt: d.addedAt ?? Date.now(),
        storageId: d.id,
        _file: d.file instanceof Blob ? new File([d.file], d.name, { type: d.mimeType || d.file.type }) : null,
        chunks: d.text ? chunkText(d.text) : [],
      });
      selected.add(d.id);
      if (d.needsOcr) pendingOcr.add(d.id);
    }
    renderLibrary();
    processOcrQueue();
  } catch (e) { console.error(e); }
}

function updateLibStats() {
  const sel = docs.filter((d) => selected.has(d.id));
  const tokens = sel.reduce((s, d) => s + estTokens(d.text), 0);
  const capabilities = modelService.capabilities;
  const architectural = Number(capabilities?.architecturalMax) || 131_072;
  const effective = capabilities ? effectiveContextLimit(capabilities).toLocaleString() : "detecting";
  const pref = getContextLimitPreference();
  const policy = pref === "auto" ? "Auto" : `${Number(pref / 1024).toLocaleString()}K cap`;
  const budget = lastContext?.budgetTokens ? ` · current document budget ${lastContext.budgetTokens.toLocaleString()}` : "";
  const selection = sel.length
    ? `${sel.length}/${docs.length} selected · ~${tokens.toLocaleString()} estimated document tokens${budget}`
    : `${docs.length} document${docs.length === 1 ? "" : "s"} · none selected`;
  const cap = capabilities ? selectedContextLimit(architectural) : architectural;
  const effectiveCapped = capabilities ? Math.min(Number(effective.replace(/,/g,""))||0, cap) : cap;
  void effectiveCapped;
  els.libStats.textContent = `${selection} · model max ${(architectural / 1024).toLocaleString()}K · runtime max ${effective} · ${policy}`;
}

function renderLibrary() {
  els.lib.replaceChildren();
  if (!docs.length) {
    const e = document.createElement("div");
    e.className = "ws-empty small";
    e.textContent = "No documents yet. Add PDF, DOCX, TXT, MD, CSV or images.";
    els.lib.appendChild(e);
  }
  for (const d of docs) {
    const card = document.createElement("div");
    card.className = "ws-doc-card" + (selected.has(d.id) ? " selected" : "");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = selected.has(d.id);
    check.addEventListener("change", () => { check.checked ? selected.add(d.id) : selected.delete(d.id); renderLibrary(); });
    const meta = document.createElement("div");
    meta.className = "ws-doc-meta";
    const name = document.createElement("div");
    name.className = "ws-doc-name";
    name.textContent = d.name;
    name.title = d.name;
    const sub = document.createElement("div");
    sub.className = "ws-doc-sub";
    sub.textContent = describeDoc(d);
    meta.append(name, sub);
    const ops = document.createElement("div");
    ops.className = "ws-doc-ops";
    if (d.text && !d.ocrRunning) {
      const exportBtn = document.createElement("button");
      exportBtn.type = "button";
      exportBtn.className = "ws-btn ghost tiny";
      exportBtn.textContent = "MD";
      exportBtn.title = "Export Markdown";
      exportBtn.addEventListener("click", () => exportDocumentMarkdown(d));
      ops.appendChild(exportBtn);
    }
    if (d.needsOcr) {
      const ocr = document.createElement("button");
      ocr.type = "button";
      ocr.className = "ws-btn ghost tiny";
      ocr.textContent = d.ocrRunning ? "OCR…" : "OCR";
      ocr.disabled = d.ocrRunning;
      ocr.title = "Transcribe with the on-device vision model";
      ocr.addEventListener("click", () => ocrDocument(d, ocr));
      ops.appendChild(ocr);
    }
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "ws-hist-del";
    rm.textContent = "×";
    rm.title = "Remove";
    rm.addEventListener("click", async () => {
      selected.delete(d.id);
      docs = docs.filter((x) => x.id !== d.id);
      pendingOcr.delete(d.id);
      resetResearchConversation();
      await db.delete("documents", d.storageId ?? d.id).catch(() => {});
      renderLibrary();
    });
    ops.appendChild(rm);
    card.append(check, meta, ops);
    els.lib.appendChild(card);
  }
  updateLibStats();
}

function describeDoc(d) {
  const kind = d.kind.toUpperCase();
  const pages = d.pages ? ` · ${d.pages.length}p` : "";
  const chars = d.text ? ` · ${d.text.length.toLocaleString()} chars` : " · no text yet";
  if (d.ocrRunning && d.ocrProgress) {
    return `${kind}${pages}${chars} · ${ocrProgressLabel(d)}`;
  }
  const warn = d.needsOcr ? " · scanned — OCR pending" : "";
  return `${kind}${pages}${chars}${warn}`;
}

function setLibStatus(text, { busy = false } = {}) {
  if (!text) { els.libStatus.hidden = true; return; }
  els.libStatus.hidden = false;
  els.libStatus.textContent = text;
  els.libStatus.classList.toggle("busy", busy);
}

async function onFilesPicked() {
  const files = [...(els.fileInput.files ?? [])];
  els.fileInput.value = "";
  await ingestFiles(files);
}

// Ingest a batch of File objects (from the picker or drag & drop), with
// per-file progress feedback and duplicate detection.
async function ingestFiles(files) {
  const supported = files.filter(isSupported);
  const rejected = files.length - supported.length;
  if (!supported.length) {
    setLibStatus(rejected ? `No readable files in that selection (${rejected} skipped).` : "");
    return;
  }
  wrapAddButton(true);
  let added = 0, skipped = 0, failed = 0;
  for (const file of supported) {
    // duplicate guard: same name + size already in the library
    const duplicate = docs.find((d) => d.name === file.name && d.size === file.size);
    if (duplicate && !(duplicate.needsOcr && !duplicate._file)) {
      skipped++;
      setLibStatus(`${file.name} is already in the library — skipped.`);
      continue;
    }
    if (duplicate) {
      pendingOcr.delete(duplicate.id);
      selected.delete(duplicate.id);
      docs = docs.filter((d) => d.id !== duplicate.id);
      await db.delete("documents", duplicate.storageId ?? duplicate.id).catch(() => {});
      resetResearchConversation();
    }
    setLibStatus(`Parsing ${file.name}…`, { busy: true });
    try {
      const parsed = await parseFile(file, {
        onProgress: (msg) => setLibStatus(`${file.name} · ${msg}`, { busy: true }),
      });
      const id = newId("doc");
      const doc = {
        id,
        name: file.name,
        kind: parsed.kind,
        text: parsed.text,
        pages: parsed.pages ?? null,
        needsOcr: parsed.needsOcr,
        size: file.size,
        addedAt: Date.now(),
        _file: file, // kept for OCR page rendering this session
      };
      doc.chunks = doc.text ? chunkText(doc.text) : [];
      docs.push(doc);
      selected.add(id);
      added++;
      renderLibrary();
      // Persist the source file as well as parsed text so scanned files can be
      // OCR'd automatically after a reload.
      await db.put("documents", {
        id, name: doc.name, kind: doc.kind, text: doc.text,
        pages: doc.pages, needsOcr: doc.needsOcr, size: doc.size, addedAt: doc.addedAt,
        file: doc._file, mimeType: file.type,
      }).catch(() => {});
      if (doc.needsOcr) {
        pendingOcr.add(doc.id);
        processOcrQueue();
      }
    } catch (err) {
      console.error(err);
      failed++;
      setLibStatus(`✖ ${file.name}: ${String(err?.message ?? err).slice(0, 140)}`);
    }
  }
  wrapAddButton(false);
  const parts = [];
  if (added) parts.push(`${added} added`);
  if (skipped) parts.push(`${skipped} duplicate${skipped === 1 ? "" : "s"} skipped`);
  if (failed) parts.push(`${failed} failed`);
  if (rejected) parts.push(`${rejected} unsupported`);
  setLibStatus(parts.length ? `Done — ${parts.join(", ")}.` : "");
  renderLibrary();
  setTimeout(() => { if (!els.libStatus.classList.contains("busy")) setLibStatus(""); }, 6000);
}

function wrapAddButton(disabled) {
  const btn = els.root.querySelector('[data-act="add"]');
  if (btn) btn.disabled = disabled;
}

// ---------------- vision OCR ----------------

async function ocrDocument(doc, btn) {
  if (!modelService.ready) { setLibStatus("Load the model first — OCR uses the vision tower."); return false; }
  if (!doc._file) {
    setLibStatus(`${doc.name} needs to be re-uploaded before it can be OCR'd.`);
    return false;
  }
  if (doc.ocrRunning) return false;
  const unlock = acquireLock("research-ocr");
  if (!unlock) return false;
  doc.ocrRunning = true;
  const startedAt = performance.now();
  renderLibrary();
  if (btn) {
    btn.disabled = true;
    btn.textContent = "OCR…";
  }
  setLibStatus(`Reading ${doc.name} with the vision tower…`, { busy: true });
  let succeeded = false;
  let progressTimer = null;
  try {
    let texts = [];
    if (doc.kind === "image") {
      updateOcrProgress(doc, 1, 1, startedAt, 1);
      const url = await readAsDataUrl(doc._file);
      texts = [await visionTranscribe(url)];
    } else if (doc.kind === "pdf") {
      const scannedPages = (doc.pages ?? []).filter((p) => p.scanned).map((p) => p.page);
      const targets = scannedPages.length ? scannedPages : Array.from({ length: Math.min(doc._pageCount ?? 5, 5) }, (_, i) => i + 1);
      const pagesToOcr = targets;
      updateOcrProgress(doc, 1, doc.pages?.length || pagesToOcr.length, startedAt, pagesToOcr[0], pagesToOcr.length, 1);
      progressTimer = setInterval(() => {
        if (!doc.ocrProgress) return;
        const elapsed = performance.now() - startedAt;
        const completed = Math.max(0, doc.ocrProgress.targetCurrent - 1);
        const average = completed > 0 ? elapsed / completed : 0;
        doc.ocrProgress.etaMs = average > 0 ? average * (doc.ocrProgress.targetTotal - completed) : null;
        renderLibrary();
        setLibStatus(formatOcrProgress(doc), { busy: true });
      }, 1000);
      for (let index = 0; index < pagesToOcr.length; index++) {
        const p = pagesToOcr[index];
        updateOcrProgress(doc, p, doc.pages?.length || pagesToOcr.length, startedAt, p, pagesToOcr.length, index + 1);
        const url = await renderPdfPageToDataUrl(doc._file, p);
        const transcription = await visionTranscribe(url);
        texts.push(transcription);
        const page = doc.pages?.find((entry) => entry.page === p);
        if (page && transcription) {
          page.text = transcription;
          page.ocr = true;
        }
      }
    }
    const joined = texts.filter(Boolean).join("\n\n");
    if (joined) {
      doc.text = doc.kind === "pdf" && doc.pages?.length
        ? doc.pages.map((page) => page.text).filter(Boolean).join("\n\n")
        : doc.text ? `${doc.text}\n\n${joined}` : joined;
      doc.chunks = chunkText(doc.text);
      doc.needsOcr = false;
      await db.put("documents", {
        id: doc.id, name: doc.name, kind: doc.kind, text: doc.text,
        pages: doc.pages, needsOcr: false, size: doc.size, addedAt: doc.addedAt,
        file: doc._file, mimeType: doc._file.type,
      }).catch(() => {});
      succeeded = true;
      setLibStatus(`${doc.name} OCR complete.`);
    } else {
      setLibStatus(`OCR returned no text for ${doc.name}.`, { busy: false });
    }
  } catch (err) {
    console.error(err);
    setLibStatus(`✖ OCR failed for ${doc.name}: ${String(err?.message ?? err).slice(0, 120)}`);
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    doc.ocrRunning = false;
    doc.ocrProgress = null;
    unlock();
    renderLibrary();
  }
  return succeeded;
}

function formatRemaining(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "estimating time";
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return `~${seconds}s remaining`;
  const minutes = Math.floor(seconds / 60);
  return `~${minutes}m ${seconds % 60}s remaining`;
}

function formatOcrProgress(doc) {
  return `${doc.name} · ${ocrProgressLabel(doc)}`;
}

function ocrProgressLabel(doc) {
  const { current, total, targetCurrent, targetTotal, etaMs } = doc.ocrProgress;
  const targetLabel = targetTotal !== total ? ` · ${targetCurrent}/${targetTotal} scanned` : "";
  return `OCR page ${current}/${total}${targetLabel} · ${formatRemaining(etaMs)}`;
}

function updateOcrProgress(doc, current, total, startedAt, page, targetTotal = total, targetCurrent = current) {
  const completed = Math.max(0, targetCurrent - 1);
  const elapsed = performance.now() - startedAt;
  const average = completed > 0 ? elapsed / completed : 0;
  doc.ocrProgress = {
    current,
    total,
    page,
    targetCurrent,
    targetTotal,
    startedAt,
    etaMs: average > 0 ? average * (targetTotal - completed) : null,
  };
  renderLibrary();
  setLibStatus(formatOcrProgress(doc), { busy: true });
}

function exportDocumentMarkdown(doc) {
  if (!doc?.text) {
    setLibStatus(`${doc?.name ?? "Document"} has no extracted text to export.`);
    return;
  }
  const baseName = (doc.name.replace(/\.[^.]+$/, "") || "document").replace(/[^a-z0-9._-]+/gi, "-");
  const blob = new Blob([formatDocumentMarkdown(doc)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${baseName}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setLibStatus(`Exported ${doc.name} as Markdown.`);
}

async function processOcrQueue() {
  if (ocrQueueRunning || !modelService.ready) return;
  const id = pendingOcr.values().next().value;
  if (!id) return;
  const doc = docs.find((d) => d.id === id);
  pendingOcr.delete(id);
  if (!doc || !doc.needsOcr) return processOcrQueue();
  ocrQueueRunning = true;
  const succeeded = await ocrDocument(doc);
  ocrQueueRunning = false;
  if (!succeeded && doc.needsOcr && doc._file) pendingOcr.add(doc.id);
  if (succeeded || !doc._file) processOcrQueue();
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function visionTranscribe(dataUrl) {
  const res = await complete({
    messages: [{ role: "user", content: [{ type: "image", url: dataUrl }, { type: "text", text: "Transcribe all text on this image/page exactly as written. Output only the transcription." }] }],
    owner: "research-ocr",
    maxNewTokens: 2048,
    skipLock: true, // ocrDocument already holds the lock
  });
  return (res.answerText || res.reply || "").trim();
}

// ---------------- chat ----------------

function appendMsg(role, contentMarkdown) {
  return threadView.append(role, contentMarkdown).querySelector(".bubble");
}

function scrollThread() { threadView.scrollToEnd(); }
function autoGrow() { els.input.style.height = "auto"; els.input.style.height = `${Math.min(els.input.scrollHeight, 140)}px`; }

function selectedDocs() { return docs.filter((d) => selected.has(d.id) && d.text && !d.needsOcr); }

function resetResearchConversation() {
  conversationVersion++;
  abortController?.abort();
  messages = [];
  lastContext = null;
  generating = false;
  abortController = null;
  els.thread.replaceChildren(createResearchEmpty());
  els.inspector.replaceChildren(createInspectorEmpty());
  els.sendBtn.hidden = false;
  els.stopBtn.hidden = true;
  syncState();
}

function createResearchEmpty() {
  const empty = document.createElement("div");
  empty.className = "ws-empty";
  empty.innerHTML = "Add documents, then ask anything about them.<br>Answers come only from your files — nothing leaves the device.";
  return empty;
}

function createInspectorEmpty() {
  const empty = document.createElement("div");
  empty.className = "ws-empty small";
  empty.textContent = "Context shown here before each answer.";
  return empty;
}

async function runAction(action) {
  if (action.id === "compare" && selectedDocs().length < 2) {
    alert("Select at least two documents to compare.");
    return;
  }
  await ask(action.prompt, { isAction: true });
}

const RESEARCH_INSTRUCTIONS = [
  "You answer questions using ONLY the provided documents.",
  "Cite sources inline like [DocName p.X] when the document has pages, or [DocName] otherwise.",
  "If the answer is not contained in the documents, say exactly that — do not guess.",
].join("\n");

function researchSystemPrompt(renderedContext) {
  return [
    RESEARCH_INSTRUCTIONS,
    "",
    "=== DOCUMENTS START ===",
    renderedContext,
    "=== DOCUMENTS END ===",
  ].join("\n");
}

async function exactPromptTokens(messagesToCount) {
  const model = modelService.model;
  if (!model?.countPromptTokens) return 0;
  return Math.max(0, Math.floor(Number(await model.countPromptTokens(messagesToCount)) || 0));
}

function completeHistoryTurns(prior) {
  const turns = [];
  for (let i = 0; i + 1 < prior.length; i += 2) {
    if (prior[i]?.role === "user" && prior[i + 1]?.role === "assistant") turns.push([prior[i], prior[i + 1]]);
  }
  return turns;
}

async function retainNewestHistory(prior, question, effectiveLimit) {
  const turns = completeHistoryTurns(prior);
  const retained = [];
  const minimumDocumentTokens = 256;
  for (let i = turns.length - 1; i >= 0; i--) {
    const candidate = [...turns[i], ...retained];
    const promptTokens = await exactPromptTokens(
      thinkMessages([{ role: "system", content: researchSystemPrompt("") }, ...candidate, { role: "user", content: question }])
    );
    if (promptTokens + RESPONSE_TOKEN_RESERVE + 1 + minimumDocumentTokens > effectiveLimit) break;
    retained.splice(0, retained.length, ...candidate);
  }
  return retained;
}

async function prepareResearchContext(selDocs, question, prior) {
  let capabilities = modelService.capabilities ?? modelService.refreshCapabilities();
  const architectural = Number(capabilities?.architecturalMax) || 131_072;
  const contextLimit = selectedContextLimit(architectural);
  const history = await retainNewestHistory(prior, question, contextLimit);
  const promptWithoutDocuments = await exactPromptTokens(
    thinkMessages([
      { role: "system", content: researchSystemPrompt("") },
      ...history,
      { role: "user", content: question },
    ])
  );
  const model = modelService.model;
  const tokenCounter = typeof model?.countTextTokens === "function"
    ? (text) => model.countTextTokens(text) + 12
    : estTokens;
  const full = buildContext({ docs: selDocs, query: question, contextBudget: Number.MAX_SAFE_INTEGER, tokenCounter });
  const fullPromptTokens = await exactPromptTokens(
    thinkMessages([
      { role: "system", content: researchSystemPrompt(renderContextBlocks(full.blocks)) },
      ...history,
      { role: "user", content: question },
    ])
  );
  const requestedCapacity = Math.min(contextLimit, fullPromptTokens + RESPONSE_TOKEN_RESERVE + 1);
  let allocationError = null;
  const currentEffective = Math.min(effectiveContextLimit(capabilities), contextLimit);
  if (requestedCapacity > currentEffective && model?.ensureContextCapacity) {
    try {
      await model.ensureContextCapacity(requestedCapacity);
    } catch (error) {
      allocationError = error;
    }
    capabilities = modelService.refreshCapabilities?.() ?? capabilities;
  }
  const effective = Math.min(effectiveContextLimit(capabilities), contextLimit);
  const budgetTokens = effective - promptWithoutDocuments - RESPONSE_TOKEN_RESERVE - 1;
  const ctx = buildContext({ docs: selDocs, query: question, contextBudget: budgetTokens, tokenCounter });
  return {
    ctx: { ...ctx, budgetTokens: Math.max(0, budgetTokens), promptWithoutDocuments, effectiveContextMax: effective, architecturalMax: architectural, contextLimit, requestedCapacity, allocationError: allocationError?.message ?? null },
    history,
    historyTrimmed: history.length < prior.length,
  };
}

async function ask(text, { isAction = false } = {}) {
  if (!text || !modelService.ready || generating) return;
  const selDocs = selectedDocs();
  if (!selDocs.length) {
    const pending = docs.some((d) => selected.has(d.id) && d.needsOcr);
    alert(pending
      ? "OCR is still pending for a selected document. Wait for it to finish or re-upload the file to start OCR."
      : "Select at least one document with extracted text first.");
    return;
  }
  const turnVersion = conversationVersion;

  // Fit history first, then give the remaining exact prompt budget to documents.
  let plan;
  try {
    plan = await prepareResearchContext(selDocs, text, messages);
  } catch (error) {
    console.error(error);
    setLibStatus(`⚠ ${String(error?.message ?? error)}`);
    return;
  }
  const { ctx, history, historyTrimmed } = plan;
  if (!ctx.blocks.length) {
    const message = "The current question and minimum document context do not fit this device's effective context limit.";
    lastContext = { ...ctx, error: message };
    renderInspector(lastContext);
    setLibStatus(message);
    return;
  }
  lastContext = { ...ctx, historyTrimmed, historyTurns: history.length / 2, query: text };
  renderInspector(lastContext);

  if (!isAction) { els.input.value = ""; autoGrow(); }
  messages = history;
  appendMsg("user", text);
  messages.push({ role: "user", content: text });

  const bubble = appendMsg("assistant", "");
  bubble.innerHTML = '<span class="thinking"><span></span><span></span><span></span></span>';

  generating = true;
  abortController = new AbortController();
  els.sendBtn.hidden = true;
  els.stopBtn.hidden = false;
  syncState();

  const unlock = acquireLock("research");
  if (!unlock) {
    bubble.textContent = "Another app is generating right now.";
    generating = false; els.sendBtn.hidden = false; els.stopBtn.hidden = true;
    return;
  }

  const systemPrompt = researchSystemPrompt(renderContextBlocks(ctx.blocks));

  // Live phase indicator: elapsed seconds tick even between tokens.
  const startedAt = performance.now();
  const ticker = setInterval(() => {
    const secs = ((performance.now() - startedAt) / 1000).toFixed(0);
    const phase = bubble.dataset.phase === "answering" ? "Answering" : "Using document context";
    let stat = bubble.querySelector(".ws-gen-stat");
    if (!stat) {
      stat = document.createElement("div");
      stat.className = "ws-gen-stat mono";
      bubble.appendChild(stat);
    }
    stat.textContent = `${phase} · ${secs}s`;
  }, 500);

  // rAF-coalesced live rendering of the split stream (thinking vs answer).
  let pending = null;
  const renderLive = (thinkingText, answerText) => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = null;
      renderDocsAssistant(bubble, thinkingText, answerText, true);
      scrollThread();
    });
  };

  let reply = "";
  let finalThinkingText = "";
  let finalAnswerText = "";
  let finalStats = null;
  try {
    const res = await streamGeneration({
      messages: thinkMessages([{ role: "system", content: systemPrompt }, ...messages]),
      maxNewTokens: 3000,
      contextMax: ctx.contextLimit,
      signal: abortController.signal,
      onToken: ({ thinkingText, answerText }) => {
        finalThinkingText = thinkingText;
        finalAnswerText = answerText;
        bubble.dataset.phase = answerText ? "answering" : "thinking";
        renderLive(thinkingText, answerText);
      },
    });
    finalThinkingText = res.thinkingText;
    finalAnswerText = res.answerText;
    reply = res.answerText || res.reply || "";
    finalStats = res.stats;
  } catch (err) {
    console.error(err);
    if (!reply) reply = err instanceof ContextLimitError || err?.code === "context_capacity"
      ? `⚠ ${String(err.message)}`
      : `_Stopped: ${String(err?.message ?? err)}_`;
  } finally {
    clearInterval(ticker);
    unlock();
    if (pending) { cancelAnimationFrame(pending); pending = null; }
    if (turnVersion === conversationVersion) {
      renderDocsAssistant(bubble, finalThinkingText, finalAnswerText, false, reply);
      scrollThread();
      // timing meta line, same shape as chat
      if (finalStats && finalStats.generatedTokens > 0) {
        const s = generationStats(finalStats);
        const meta = document.createElement("div");
        meta.className = "meta";
        const parts = [`${finalStats.generatedTokens} tok`, `TTFT ${s.ttftMs.toFixed(0)} ms`];
        if (s.decodeTokensPerSecond > 0) parts.push(`${s.decodeTokensPerSecond.toFixed(1)} tok/s`);
        meta.textContent = parts.join("  ·  ");
        bubble.parentElement.appendChild(meta);
      }
      messages.push({ role: "assistant", content: reply });
      generating = false;
      abortController = null;
      delete bubble.dataset.phase;
      els.sendBtn.hidden = false;
      els.stopBtn.hidden = true;
      syncState();
    }
  }
}

// Render an assistant bubble with a collapsible Thinking block + answer body.
// While streaming (withCaret), the thinking block stays open until the answer
// starts, then collapses so the answer gets the attention.
function renderDocsAssistant(bubble, thinkingText, answerText, withCaret, raw = "") {
  threadView.renderAssistant(bubble, {
    raw,
    thinkingText,
    answerText,
    streaming: withCaret,
  });
}

function renderInspector(ctx) {
  els.inspector.replaceChildren();
  const head = document.createElement("div");
  head.className = "ws-insp-head";
  const modeLabel = ctx.mode === "stuff" ? "Full-text stuffing" : ctx.mode === "bm25" ? "BM25 retrieval" : "No documents";
  const capabilities = modelService.capabilities;
  const architectural = Number(ctx.architecturalMax ?? capabilities?.architecturalMax) || 131_072;
  const effective = Number(ctx.effectiveContextMax ?? capabilities?.effectiveContextMax) || architectural;
  const budget = Number(ctx.budgetTokens) || 0;
  const policy = Number(ctx.contextLimit) < architectural ? ` · cap ${Number(ctx.contextLimit).toLocaleString()}` : "";
  head.innerHTML = `<span class="ws-badge">${modeLabel}</span> ${ctx.estTokensUsed.toLocaleString()} document tokens · budget ${budget.toLocaleString()} · runtime max ${effective.toLocaleString()}${policy} · model max ${(architectural / 1024).toLocaleString()}K`;
  els.inspector.appendChild(head);
  if (ctx.historyTrimmed || ctx.error || ctx.allocationError) {
    const note = document.createElement("div");
    note.className = "ws-insp-prov";
    note.textContent = ctx.error || ctx.allocationError || `Older conversation turns were removed; kept ${ctx.historyTurns ?? 0} complete turn${ctx.historyTurns === 1 ? "" : "s"}.`;
    els.inspector.appendChild(note);
  }
  ctx.blocks.forEach((b, i) => {
    const item = document.createElement("details");
    item.className = "ws-insp-block";
    const summary = document.createElement("summary");
    summary.textContent = `${i + 1}. ${b.label}`;
    const prov = document.createElement("div");
    prov.className = "ws-insp-prov";
    prov.textContent = b.provenance;
    const pre = document.createElement("pre");
    pre.className = "mono";
    pre.textContent = b.text.length > 1200 ? `${b.text.slice(0, 1200)}\n… (${b.text.length.toLocaleString()} chars total)` : b.text;
    item.append(summary, prov, pre);
    els.inspector.appendChild(item);
  });
}
