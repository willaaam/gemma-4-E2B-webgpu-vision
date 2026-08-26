// Reports & Dashboards app.
//
// Staged generation tuned for greedy decode: every stage produces small,
// strictly-structured output (JSON outline → one section at a time), and
// charts are emitted as ```chart JSON specs rendered by the app — never as
// model-written JavaScript.

import { modelService } from "../../src/services/model-service.js";
import { acquireLock, complete } from "../../src/services/generation.js";
import { db, newId } from "../../src/services/db.js";
import { thinkMessages } from "../../src/services/settings.js";
import { selectedContextLimit } from "../../src/services/context-preference.js";
import { renderMarkdown, escapeHtml } from "../../src/lib/markdown.js";
import { extractCharts, renderChartsIn, parseChartSpec, renderLightPng } from "./chart-renderer.js";

const TEMPLATES = {
  status: {
    label: "Status report",
    hint: "A project/team status report: summary, progress since last period, metrics, risks & blockers, next steps.",
  },
  data: {
    label: "Data summary",
    hint: "A data analysis report: overview of the dataset, key findings with numbers, trends, anomalies, recommendations. Use ```chart blocks for the most important visualizations.",
  },
  comparison: {
    label: "Comparison",
    hint: "An options comparison report: criteria, option-by-option analysis, a comparison table, verdict with trade-offs.",
  },
  notes: {
    label: "Meeting notes",
    hint: "Structured meeting notes: attendees, agenda, discussion points, decisions made, action items with owners.",
  },
  blank: {
    label: "Freeform",
    hint: "A well-structured report on the topic the user describes. Use headings, tables and ```chart blocks where they help.",
  },
};

let els = {};
let currentMarkdown = "";
let currentCharts = [];
let activeReportId = null;
let generating = false;
let abortController = null;
let unsubModel = null;

export const reportsApp = {
  id: "reports",
  title: "Reports",

  mount(container) {
    els = {};
    this.buildDom(container);
    unsubModel = modelService.subscribe((s) => syncState(s));
    refreshSaved();
    syncState(modelService.state);
  },

  unmount() {
    abortController?.abort();
    unsubModel?.();
    unsubModel = null;
  },

  buildDom(root) {
    const wrap = document.createElement("div");
    wrap.className = "ws-app reports-app";
    wrap.innerHTML = `
      <div class="ws-split">
        <section class="ws-pane ws-pane-left">
          <div class="ws-pane-head">
            <h3>Compose</h3>
            <div class="ws-head-actions">
              <button class="ws-btn ghost small" data-act="saved">Saved ▾</button>
            </div>
          </div>
          <div class="ws-saved-pop" hidden></div>
          <div class="ws-form">
            <label class="ws-label">Template</label>
            <div class="ws-chips" data-role="templates"></div>
            <label class="ws-label" for="repTopic">Topic / instructions</label>
            <textarea id="repTopic" rows="3" placeholder="e.g. Q3 progress on the payments migration — shipped retry queue, latency down 30%, two risks open"></textarea>
            <label class="ws-label" for="repData">Data <span class="ws-opt">(optional — paste CSV/text/JSON)</span></label>
            <textarea id="repData" rows="6" class="mono" placeholder="date,revenue,orders\n2026-07-01,12040,301\n2026-07-02,13110,344\n…"></textarea>
            <div class="ws-row">
              <button class="ws-btn ghost small" data-act="upload">Upload file…</button>
              <input type="file" data-role="file" accept=".csv,.txt,.md,.json,text/*,application/json" hidden>
              <span class="ws-file-name" data-role="fileName"></span>
            </div>
            <button class="ws-btn primary" data-act="generate" disabled>Generate report</button>
            <button class="ws-btn danger" data-act="stop" hidden>Stop</button>
            <div class="ws-log mono" data-role="log"></div>
          </div>
        </section>
        <section class="ws-pane ws-pane-right">
          <div class="ws-pane-head">
            <div class="ws-tabs">
              <button class="ws-tab active" data-tab="preview">Preview</button>
              <button class="ws-tab" data-tab="source">Markdown</button>
            </div>
            <div class="ws-head-actions">
              <button class="ws-btn ghost small" data-act="save" disabled>Save</button>
              <button class="ws-btn ghost small" data-act="export" disabled>Export HTML</button>
            </div>
          </div>
          <div class="ws-preview" data-role="preview">
            <div class="ws-empty">Generated reports appear here.<br>Everything is produced on-device.</div>
          </div>
          <pre class="ws-source mono" data-role="source" hidden></pre>
        </section>
      </div>`;
    root.replaceChildren(wrap);

    Object.assign(els, {
      root: wrap,
      templates: wrap.querySelector('[data-role="templates"]'),
      topic: wrap.querySelector("#repTopic"),
      data: wrap.querySelector("#repData"),
      fileInput: wrap.querySelector('[data-role="file"]'),
      fileName: wrap.querySelector('[data-role="fileName"]'),
      generateBtn: wrap.querySelector('[data-act="generate"]'),
      stopBtn: wrap.querySelector('[data-act="stop"]'),
      log: wrap.querySelector('[data-role="log"]'),
      preview: wrap.querySelector('[data-role="preview"]'),
      source: wrap.querySelector('[data-role="source"]'),
      saveBtn: wrap.querySelector('[data-act="save"]'),
      exportBtn: wrap.querySelector('[data-act="export"]'),
      savedPop: wrap.querySelector(".ws-saved-pop"),
      savedBtn: wrap.querySelector('[data-act="saved"]'),
    });

    let selectedTemplate = "status";
    for (const [key, t] of Object.entries(TEMPLATES)) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ws-chip" + (key === selectedTemplate ? " active" : "");
      chip.textContent = t.label;
      chip.addEventListener("click", () => {
        selectedTemplate = key;
        els.templates.querySelectorAll(".ws-chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
      });
      els.templates.appendChild(chip);
    }
    this.getSelectedTemplate = () => selectedTemplate;

    // re-evaluate Generate availability as the user types
    els.topic.addEventListener("input", () => syncState());

    els.generateBtn.addEventListener("click", generate);
    els.stopBtn.addEventListener("click", () => abortController?.abort());
    els.saveBtn.addEventListener("click", saveReport);
    els.exportBtn.addEventListener("click", exportHtml);
    els.savedBtn.addEventListener("click", toggleSavedPop);
    wrap.querySelector('[data-act="upload"]').addEventListener("click", () => els.fileInput.click());
    els.fileInput.addEventListener("change", onFilePicked);
    els.root.querySelectorAll(".ws-tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
    document.addEventListener("click", this._docClick = (e) => {
      if (!els.savedPop.hidden && !e.target.closest(".ws-saved-pop") && !e.target.closest('[data-act="saved"]')) els.savedPop.hidden = true;
    });
    this._docClickRef = this._docClick;
  },
};

function syncState(s = modelService.state) {
  const ready = !!s.model && !s.loading;
  if (!generating) els.generateBtn.disabled = !ready || !els.topic.value.trim();
}

function log(msg) {
  const line = document.createElement("div");
  line.textContent = msg;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

async function onFilePicked() {
  const file = els.fileInput.files?.[0];
  if (!file) return;
  const text = await file.text();
  els.data.value = text.slice(0, 200_000);
  els.fileName.textContent = `${file.name} (${text.length.toLocaleString()} chars)`;
  els.fileInput.value = "";
}

function switchTab(which) {
  els.root.querySelectorAll(".ws-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === which));
  els.preview.hidden = which !== "preview";
  els.source.hidden = which !== "source";
}

// ---------------- generation pipeline ----------------

async function generate() {
  const topic = els.topic.value.trim();
  if (!topic || !modelService.ready || generating) return;

  generating = true;
  abortController = new AbortController();
  const signal = abortController.signal;
  els.generateBtn.disabled = true;
  els.generateBtn.hidden = true;
  els.stopBtn.hidden = false;
  els.log.replaceChildren();

  const unlock = acquireLock("reports");
  if (!unlock) { log("⚠ Another app is generating — try again shortly."); resetButtons(); return; }

  try {
    const tpl = TEMPLATES[reportsApp.getSelectedTemplate()];
    const dataText = els.data.value.trim();
    const dataBlock = dataText
      ? `\n\nDATA TO ANALYZE (use these numbers; do not invent others):\n${dataText.slice(0, 24_000)}${dataText.length > 24_000 ? "\n…(truncated)" : ""}`
      : "";

    // Stage 1 — outline (strict JSON, tiny output)
    log("Planning outline…");
    const outlinePrompt = [
      "You are a report planner. Reply with ONLY a JSON array — no prose, no code fence.",
      'Format: [{"title":"Section title","purpose":"one sentence"}]',
      `Template guidance: ${tpl.hint}`,
      `Report topic: ${topic}`,
      "Plan 4–7 sections. The first must be an executive summary; the last must be conclusions/recommendations." + (dataBlock ? "" : ""),
    ].join("\n");
    const outlineRes = await completeSimple([{ role: "user", content: outlinePrompt }], signal, 1600);
    let outline = tryParseJsonArray(outlineRes);
    if (!outline) {
      log("Outline wasn't valid JSON — retrying once…");
      const retry = await completeSimple([
        { role: "user", content: outlinePrompt },
        { role: "assistant", content: outlineRes },
        { role: "user", content: "That was not a valid JSON array. Reply again with ONLY the JSON array." },
      ], signal, 1600);
      outline = tryParseJsonArray(retry);
    }
    if (!outline || !outline.length) throw new Error("Could not get a valid outline.");
    log(`Outline: ${outline.length} sections.`);

    // Stage 2 — sections, one bounded completion each
    const title = topic.length > 80 ? `${topic.slice(0, 77)}…` : topic;
    let md = `# ${escapeMd(title)}\n`;
    md += `_Generated on-device · ${new Date().toLocaleDateString()}_\n`;
    for (let i = 0; i < outline.length; i++) {
      if (signal.aborted) break;
      const sec = outline[i];
      log(`Writing ${i + 1}/${outline.length}: ${sec.title}`);
      const secPrompt = [
        `You are writing ONE section of a report titled "${title}".`,
        `Template guidance: ${tpl.hint}`,
        `Full outline:\n${outline.map((s, j) => `${j + 1}. ${s.title}`).join("\n")}`,
        `Write ONLY section ${i + 1}: "${sec.title}" (${sec.purpose ?? ""}).`,
        "Rules: start with '## " + sec.title + "'. Use concise prose, bullet lists and markdown tables where useful.",
        dataText ? 'Reference the provided DATA with real numbers. Where a visualization helps, add a fenced ```chart block containing ONLY JSON: {"type":"bar|line|pie|doughnut","title":"...","labels":["..."],"series":[{"label":"...","data":[numbers]}]}. Labels and data arrays must be the same length.' : "Do not invent statistics — if you lack data, describe qualitatively.",
        "Do not write any other section. No concluding remarks about the report itself.",
      ].join("\n");
      const contextSoFar = i === 0 ? "" : `\n\nSections already written (do not repeat them):\n${outline.slice(0, i).map((s) => `- ${s.title}`).join("\n")}`;
      const res = await completeSimple(
        [{ role: "user", content: secPrompt + (dataBlock ? dataBlock : "") + contextSoFar }],
        signal,
        2400
      );
      md += `\n\n${cleanSection(res)}\n`;
      renderPreview(md); // live update as sections land
    }

    currentMarkdown = md;
    renderPreview(md);
    els.source.textContent = md;
    els.saveBtn.disabled = false;
    els.exportBtn.disabled = false;
    log(signal.aborted ? "Stopped." : "Done.");
  } catch (err) {
    console.error(err);
    log(`⚠ ${err?.message ?? err}`);
  } finally {
    unlock();
    resetButtons();
  }
}

function resetButtons() {
  generating = false;
  abortController = null;
  els.generateBtn.hidden = false;
  els.stopBtn.hidden = true;
  els.generateBtn.disabled = !modelService.ready || !els.topic.value.trim();
}

async function completeSimple(messages, signal, maxNewTokens) {
  const arch = Number(modelService.capabilities?.architecturalMax) || 131072;
  const contextMax = selectedContextLimit(arch);
  const res = await complete({
    messages: thinkMessages(messages),
    owner: "reports",
    signal,
    maxNewTokens,
    contextMax,
    skipLock: true, // generate() already holds the lock
  });
  return (res.answerText || res.reply || "").trim();
}

function tryParseJsonArray(text) {
  const m = String(text ?? "").match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) && arr.every((x) => x && typeof x === "object") ? arr : null;
  } catch { return null; }
}

function cleanSection(text) {
  // strip accidental top-level fences around the whole section
  return String(text ?? "").replace(/^```(?:markdown|md)?\r?\n/, "").replace(/```\s*$/, "").trim();
}

function escapeMd(s) { return String(s ?? "").replace(/#/g, "\\#"); }

// ---------------- preview / persistence / export ----------------

function renderPreview(md) {
  // chart fences → holder divs first, then markdown-render the rest
  const { html, charts } = extractCharts(md);
  currentCharts = charts;
  els.preview.innerHTML = `<article class="ws-report">${renderMarkdown(html)}</article>`;
  renderChartsIn(els.preview, charts, {
    onFix: async (jsonText, error) => {
      if (!modelService.ready || generating) return;
      const unlock = acquireLock("reports-fix");
      if (!unlock) return;
      try {
        const res = await complete({
          messages: [
            { role: "user", content: `This chart JSON has a problem: ${error}\n\n${jsonText}\n\nReply with ONLY the corrected JSON — same format, nothing else.` },
          ],
          owner: "reports-fix",
          maxNewTokens: 600,
        });
        const fixed = (res.answerText || res.reply || "").trim().match(/\{[\s\S]*\}/)?.[0];
        if (fixed && parseChartSpec(fixed).ok) {
          const idx = currentCharts.findIndex((c) => c.jsonText === jsonText);
          if (idx >= 0) {
            currentCharts[idx].jsonText = fixed;
            const rebuilt = currentCharts.map((c) => "```chart\n" + c.jsonText + "\n```").join("\n\n");
            // splice back into markdown by replacing chart blocks in order
            let n = 0;
            currentMarkdown = currentMarkdown.replace(/```chart\r?\n[\s\S]*?```/g, () => "```chart\n" + currentCharts[n++].jsonText + "\n```");
            void rebuilt;
            renderPreview(currentMarkdown);
            els.source.textContent = currentMarkdown;
          }
        }
      } finally { unlock(); }
    },
  });
}

async function refreshSaved() {
  try {
    const all = await db.all("reports");
    els._saved = all.sort((a, b) => b.updatedAt - a.updatedAt);
    renderSavedPop();
  } catch (_) {}
}

function renderSavedPop() {
  const pop = els.savedPop;
  pop.replaceChildren();
  const saved = els._saved ?? [];
  if (!saved.length) {
    const e = document.createElement("div");
    e.className = "ws-empty small";
    e.textContent = "No saved reports yet.";
    pop.appendChild(e);
    return;
  }
  for (const r of saved) {
    const row = document.createElement("div");
    row.className = "ws-hist-row" + (r.id === activeReportId ? " active" : "");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ws-hist-open";
    btn.innerHTML = `<span class="ws-hist-title">${escapeHtml(r.title)}</span><span class="ws-hist-date">${new Date(r.updatedAt).toLocaleDateString()}</span>`;
    btn.addEventListener("click", () => { openReport(r.id); pop.hidden = true; });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ws-hist-del";
    del.textContent = "×";
    del.title = "Delete";
    del.addEventListener("click", async (e) => { e.stopPropagation(); await db.delete("reports", r.id); refreshSaved(); });
    row.append(btn, del);
    pop.appendChild(row);
  }
}

function toggleSavedPop() {
  els.savedPop.hidden = !els.savedPop.hidden;
  if (!els.savedPop.hidden) refreshSaved();
}

async function openReport(id) {
  const r = await db.get("reports", id);
  if (!r) return;
  activeReportId = id;
  currentMarkdown = r.markdown;
  els.topic.value = r.title;
  renderPreview(r.markdown);
  els.source.textContent = r.markdown;
  els.saveBtn.disabled = false;
  els.exportBtn.disabled = false;
}

async function saveReport() {
  if (!currentMarkdown) return;
  const title = els.topic.value.trim().slice(0, 80) || "Untitled report";
  activeReportId = activeReportId ?? newId("rep");
  const existing = await db.get("reports", activeReportId);
  await db.put("reports", {
    id: activeReportId,
    title,
    markdown: currentMarkdown,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  });
  refreshSaved();
}

// Export a fully self-contained HTML file: charts are re-rendered with a
// LIGHT theme and baked in as PNG images, so the file renders offline with
// zero JavaScript dependencies and readable graphs on the white page.
async function exportHtml() {
  if (!currentMarkdown) return;
  const { html } = extractCharts(currentMarkdown);
  const body = renderMarkdown(html);
  // bake charts to light-theme PNGs (fall back to the on-screen canvas if the spec is broken)
  const pngs = new Map();
  for (const c of currentCharts) {
    try {
      const parsed = parseChartSpec(c.jsonText);
      if (parsed.ok) {
        pngs.set(c.id, await renderLightPng(parsed.spec));
        continue;
      }
    } catch (_) {}
    const holder = els.preview.querySelector(`[data-chart-id="${c.id}"]`);
    const canvas = holder?.querySelector("canvas");
    if (canvas) {
      try { pngs.set(c.id, canvas.toDataURL("image/png")); } catch (_) {}
    }
  }
  let out = body;
  for (const [id, dataUrl] of pngs) {
    // holder may render as a bare div or contain the error card — replace greedily
    out = out.replace(new RegExp(`<div class="ws-chart-holder" data-chart-id="${id}">[\\s\\S]*?</div>`, "g"), `<figure class="ws-export-chart"><img src="${dataUrl}" alt="chart"></figure>`);
  }
  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(els.topic.value.trim() || "Report")}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 820px; margin: 40px auto; padding: 0 20px; line-height: 1.65; color: #1a1a1a; }
  h1 { font-size: 2rem; margin-bottom: 0.2em; } h2 { border-bottom: 1px solid #ddd; padding-bottom: .25em; margin-top: 2em; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; } th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
  th { background: #f4f4f4; } code, pre { background: #f4f4f4; border-radius: 4px; font-size: .9em; }
  pre { padding: 12px; overflow-x: auto; } blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1em; color: #555; }
  figure.ws-export-chart { margin: 1.5em 0; } figure.ws-export-chart img { max-width: 100%; height: auto; border: 1px solid #eee; border-radius: 8px; }
  footer { margin-top: 3em; color: #888; font-size: .85em; border-top: 1px solid #eee; padding-top: 1em; }
</style>
</head>
<body>
${out}
<footer>Generated fully on-device with Gemma 4 E2B · WebGPU · no data left your machine</footer>
</body>
</html>`;
  const blob = new Blob([doc], { type: "text/html" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `report-${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
