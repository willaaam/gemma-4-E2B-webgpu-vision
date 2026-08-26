// Agentic coding workstation — Explorer + CodeMirror + Harness.
//
// Left: explorer tree (folders/files, zip upload/download, reset)
// Center: CodeMirror tabs + editor + console/preview dock
// Right: agent harness panel with tool-stream, selection context, reasoning.

import { modelService } from "../../src/services/model-service.js";
import { acquireLock, generationStats } from "../../src/services/generation.js";
import { renderMarkdown, escapeHtml } from "../../src/lib/markdown.js";
import { createChatThread } from "../../src/lib/chat-thread.js";
import { loadProject, saveProject, resetProject, CodeProject, normalizePathExport, dirname, basename } from "../../src/services/code-project.js";
import { createEditor } from "./components/editor-cm.js";
import { createExplorer } from "./components/explorer.js";
import { runCodeHarness, buildCodeContext } from "../../src/lib/code-harness.js";
import {
  loadPyodideRuntime, runPython, installPackage, isPyodideLoaded,
  syncFilesToPyFS, installedPackages,
} from "./runners/pyodide-runner.js";
import { WebRunner, composeWebDoc } from "./runners/web-runner.js";
import { chunkText, BM25Index } from "../../src/services/context.js";
import { getContextLimitPreference, selectedContextLimit, onContextLimitChange } from "../../src/services/context-preference.js";

let els = {};
let project = null;
let explorer = null;
let editorCtrl = null;
let activePath = null;
let openTabs = []; // ordered list of paths
let pendingSelection = null; // { path, text } attached to next prompt
let currentSelection = null; // live editor selection {text, path}
let harnessMessages = []; // array {role, content}
let generating = false;
let abortController = null;
let unsubModel = null;
let unsubContext = null;
let runner = null;
let saveDebounce = 0;
let threadView = null;
let previewLogs = [];

export const codeApp = {
  id: "code",
  title: "Code",

  async mount(container) {
    els = {};
    previewLogs = [];
    buildDom(container);
    runner = new WebRunner(els.previewFrame, { onConsole: (level, text) => pushConsole(level, text) });
    unsubModel = modelService.subscribe(() => syncState());
    unsubContext = onContextLimitChange(() => syncState());
    // Load project (with migration)
    project = await loadProject();
    explorer = createExplorer({
      container: els.explorer,
      project,
      onOpenFile: (p) => openFile(p),
      onFilesChanged: async (info) => {
        await saveProject(project);
        explorer.refresh();
        renderTabs();
        if (info?.type === "delete" && info.path === activePath) {
          activePath = openTabs.find(p => project.has(p)) || project.listPaths()[0] || null;
          if (project.has(activePath)) await openFile(activePath);
          else renderTabs();
        }
        if (info?.type === "rename" || info?.type === "move") {
          // update tabs
          for (let i = 0; i < openTabs.length; i++) {
            if (openTabs[i] === info.from) openTabs[i] = info.to;
            else if (openTabs[i].startsWith(info.from + "/")) openTabs[i] = openTabs[i].replace(info.from + "/", info.to + "/");
          }
          if (activePath === info.from) activePath = info.to;
          renderTabs();
        }
        if (info?.type === "zip-import") {
          // auto open first file
        }
        // if web file changed and autoRun enabled, refresh preview
        if (autoRun && shouldAutoPreview()) runPreview();
      },
      onReset: async () => {
        if (!confirm("Reset project to default template? All files will be lost.")) return;
        project = await resetProject();
        openTabs = [];
        activePath = null;
        harnessMessages = [];
        pendingSelection = null;
        currentSelection = null;
        clearAgentThread();
        explorer = createExplorer({
          container: els.explorer,
          project,
          onOpenFile: (p) => openFile(p),
          onFilesChanged: async () => { await saveProject(project); explorer.refresh(); renderTabs(); if (shouldAutoPreview()) runPreview(); },
          onReset: () => {}
        });
        // rewire explorer reference? recreate simpler
        location.reload(); // simplest to rebuild all
      }
    });
    explorer.render();
    // Restore last opened tabs from storage if any?
    // For now open first file
    const paths = project.listPaths();
    if (paths.length) {
      // prefer main.py then index.html
      const preferred = ["main.py", "index.html", "README.md"].find(p => project.has(p)) || paths[0];
      openTabs = [preferred];
      activePath = preferred;
      renderTabs();
      await openFile(preferred);
    } else {
      renderTabs();
    }
    syncState();
    // auto-preview if web file active
    if (shouldAutoPreview()) runPreview();
  },

  unmount() {
    abortController?.abort();
    unsubModel?.(); unsubModel = null;
    unsubContext?.(); unsubContext = null;
    try { editorCtrl?.destroy(); } catch {}
    editorCtrl = null;
    try { runner?.dispose(); } catch {}
    clearTimeout(saveDebounce);
  },

};

function buildDom(root) {
  const wrap = document.createElement("div");
  wrap.className = "ws-app code-app ws-code-app";
  wrap.innerHTML = `
    <div class="ws-code-layout">
      <section class="ws-pane ws-pane-left ws-code-explorer-pane">
        <div class="ws-pane-head"><h3>Explorer</h3></div>
        <div class="ws-explorer" data-role="explorer"></div>
      </section>
      <section class="ws-pane ws-code-center">
        <div class="ws-editor-tabs" data-role="tabs"></div>
        <div class="ws-code-editor-wrap" data-role="editorWrap">
          <div class="ws-code-editor-host" data-role="editorHost"></div>
        </div>
        <div class="ws-out" data-role="out">
          <div class="ws-out-head">
            <div class="ws-tabs">
              <button class="ws-tab small active" data-out="console">Output</button>
              <button class="ws-tab small" data-out="preview">Preview</button>
            </div>
            <div class="ws-head-actions">
              <span class="mono ws-file-name" data-role="runStatus"></span>
              <button class="ws-btn ghost small" data-role="runBtn">▶ Run</button>
              <button class="ws-btn ghost tiny" data-role="clearOut">clear</button>
            </div>
          </div>
          <pre class="ws-console mono" data-role="console"></pre>
          <iframe class="ws-preview-frame" data-role="previewFrame" sandbox="allow-scripts allow-modals" hidden></iframe>
        </div>
      </section>
      <section class="ws-pane ws-code-agent ws-pane-right">
        <div class="ws-pane-head">
          <h3>Agent</h3>
          <div class="ws-head-actions">
            <button class="ws-btn ghost small" data-role="newSession">New</button>
            <button class="ws-btn ghost small" data-role="clearAgent">Clear</button>
          </div>
        </div>
        <div class="ws-thread-scroll" data-role="agentScroll"><div class="ws-thread" data-role="agentThread">
          <div class="ws-empty">Ask the agent to build, refactor, or fix.<br><br>Tools: read/write/edit/search/run. Select code in the editor → <b>Add selection</b> to give it extra context.<br><br><span class="mono" style="font-size:11px; color:var(--t4)">Context cap mirrors the top-bar “Context” selector.</span></div>
        </div></div>
        <div class="ws-agent-selection" data-role="selectionBar" hidden>
          <div class="ws-selection-chip mono"><span data-role="selLabel"></span><button class="ws-btn ghost tiny" data-role="attachSel">Add selection</button><button class="ws-btn ghost tiny" data-role="clearSel">×</button></div>
          <pre class="ws-selection-preview mono" data-role="selPreview"></pre>
        </div>
        <div class="ws-agent-context mono" data-role="agentContext" title="Current file-context budget (based on top-bar cap + model limits)"></div>
        <footer class="ws-composer">
          <textarea data-role="agentInput" rows="2" placeholder="Load the model first, then describe a task…"></textarea>
          <button class="ws-btn primary" data-role="sendAgent" disabled>Send</button>
          <button class="ws-btn danger" data-role="stopAgent" hidden>Stop</button>
        </footer>
        <div class="ws-agent-status mono" data-role="agentStatus"></div>
      </section>
    </div>
  `;
  root.replaceChildren(wrap);

  Object.assign(els, {
    root: wrap,
    explorer: wrap.querySelector('[data-role="explorer"]'),
    tabs: wrap.querySelector('[data-role="tabs"]'),
    editorWrap: wrap.querySelector('[data-role="editorWrap"]'),
    editorHost: wrap.querySelector('[data-role="editorHost"]'),
    outTabs: wrap.querySelectorAll("[data-out]"),
    outConsole: wrap.querySelector('[data-role="console"]'),
    previewFrame: wrap.querySelector('[data-role="previewFrame"]'),
    clearOut: wrap.querySelector('[data-role="clearOut"]'),
    runBtn: wrap.querySelector('[data-role="runBtn"]'),
    runStatus: wrap.querySelector('[data-role="runStatus"]'),
    agentScroll: wrap.querySelector('[data-role="agentScroll"]'),
    agentThread: wrap.querySelector('[data-role="agentThread"]'),
    agentInput: wrap.querySelector('[data-role="agentInput"]'),
    sendAgent: wrap.querySelector('[data-role="sendAgent"]'),
    stopAgent: wrap.querySelector('[data-role="stopAgent"]'),
    newSession: wrap.querySelector('[data-role="newSession"]'),
    clearAgent: wrap.querySelector('[data-role="clearAgent"]'),
    selectionBar: wrap.querySelector('[data-role="selectionBar"]'),
    selLabel: wrap.querySelector('[data-role="selLabel"]'),
    selPreview: wrap.querySelector('[data-role="selPreview"]'),
    attachSel: wrap.querySelector('[data-role="attachSel"]'),
    clearSel: wrap.querySelector('[data-role="clearSel"]'),
    agentStatus: wrap.querySelector('[data-role="agentStatus"]'),
    agentContext: wrap.querySelector('[data-role="agentContext"]'),
  });

  threadView = createChatThread({ scrollEl: els.agentScroll, threadEl: els.agentThread, userLabel: "You", assistantLabel: "Agent" });

  // tabs + out
  els.runBtn.addEventListener("click", () => runActive());
  els.clearOut.addEventListener("click", () => { els.outConsole.replaceChildren(); previewLogs = []; });
  els.outTabs.forEach(t => t.addEventListener("click", () => switchOut(t.dataset.out)));

  // agent composers
  els.sendAgent.addEventListener("click", () => sendToAgent());
  els.stopAgent.addEventListener("click", () => abortController?.abort());
  els.agentInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!els.sendAgent.disabled) sendToAgent(); }
  });
  els.agentInput.addEventListener("input", () => { syncState(); autoGrowAgent(); });
  els.clearAgent.addEventListener("click", () => { clearAgentThread(); harnessMessages = []; pendingSelection = null; updatePendingChip(); });
  els.newSession.addEventListener("click", () => { harnessMessages = []; clearAgentThread(); pendingSelection = null; updatePendingChip(); els.agentStatus.textContent = "New session — history cleared."; });
  els.attachSel.addEventListener("click", () => {
    if (currentSelection?.text) {
      pendingSelection = { path: currentSelection.path, text: currentSelection.text };
      updatePendingChip(true);
      els.agentInput.focus();
    }
  });
  els.clearSel.addEventListener("click", () => {
    if (pendingSelection) { pendingSelection = null; updatePendingChip(); }
    else { currentSelection = null; els.selectionBar.hidden = true; }
  });

  // selection bar initially hidden
  updatePendingChip();
  autoGrowAgent();
}

function autoGrowAgent() {
  els.agentInput.style.height = "auto";
  els.agentInput.style.height = Math.min(els.agentInput.scrollHeight, 140) + "px";
}

let autoRun = true;

function shouldAutoPreview() {
  if (!activePath) return false;
  return activePath.toLowerCase().endsWith(".html") || activePath.toLowerCase().endsWith(".css") || activePath.toLowerCase().endsWith(".js");
}

function syncState() {
  const ready = modelService.ready;
  const hasActive = !!activePath;
  els.sendAgent.disabled = !ready || generating || !els.agentInput.value.trim();
  els.agentInput.placeholder = !ready ? "Load the model to talk to the agent…" : hasActive ? `Ask about ${activePath}…` : "Describe a task…";
  els.runBtn.disabled = !hasActive || generating;
  if (els.runStatus) els.runStatus.textContent = isPyodideLoaded() ? "Py ready" : "";
  // context meter
  if (els.agentContext) {
    const arch = Number(modelService.capabilities?.architecturalMax) || 131072;
    const eff = Number(modelService.capabilities?.effectiveContextMax) || arch;
    const capPref = getContextLimitPreference();
    const cap = capPref === "auto" ? arch : Math.min(arch, Number(capPref));
    const effCapped = Math.min(eff, cap);
    const stats = project?.getStats();
    const approxTokens = stats ? Math.ceil(stats.totalChars * 0.25) : 0;
    const label = capPref === "auto" ? "Auto" : `${(cap/1024).toFixed(0)}K`;
    els.agentContext.textContent = `Files ~${approxTokens.toLocaleString()} tokens · cap ${label} · effective ${(effCapped/1024).toFixed(0)}K`;
  }
  els.stopAgent.hidden = !generating;
  els.sendAgent.hidden = generating;
  if (!generating) els.agentInput.disabled = !ready;
  else els.agentInput.disabled = true;
}

// ---- Editor handling ----

async function ensureEditor() {
  if (editorCtrl) return editorCtrl;
  editorCtrl = await createEditor(els.editorHost, {
    value: "",
    path: activePath || "untitled.txt",
    onChange: (text) => {
      if (!activePath) return;
      try { project.set(activePath, text); } catch (e) { console.warn(e); }
      clearTimeout(saveDebounce);
      saveDebounce = setTimeout(() => saveProject(project).catch(()=>{}), 550);
      if (autoRun && shouldAutoPreview()) {
        clearTimeout(editorCtrl._autoRunTimer);
        editorCtrl._autoRunTimer = setTimeout(() => runPreview(), 750);
      }
    },
    onSelection: (sel) => {
      if (sel.empty || !sel.text.trim() || sel.text.length < 3) {
        // hide selection bar if no pending
        if (!pendingSelection) {
          // keep briefly? For now hide if nothing selected
          // don't hide immediately — user may still want to attach previous
          // So only update if pending not set and selection empty → hide
          if (!pendingSelection) els.selectionBar.hidden = true;
        }
        currentSelection = null;
        return;
      }
      // new selection
      const snippet = sel.text.length > 6000 ? sel.text.slice(0, 6000) : sel.text;
      currentSelection = { path: activePath, text: snippet, from: sel.from, to: sel.to };
      // show bar
      els.selLabel.textContent = `${activePath}:${snippet.length} chars`;
      els.selPreview.textContent = snippet.slice(0, 600);
      els.selectionBar.hidden = false;
      // if pending already exists, keep pending style distinct
      updatePendingChip();
    }
  });
  return editorCtrl;
}

function updatePendingChip(flash) {
  if (pendingSelection) {
    els.selectionBar.hidden = false;
    els.selLabel.textContent = `Attached: ${pendingSelection.path} (${pendingSelection.text.length} chars)`;
    els.selPreview.textContent = pendingSelection.text.slice(0, 600);
    els.attachSel.textContent = "Attached ✓";
    els.attachSel.disabled = true;
    els.clearSel.textContent = "Remove";
    els.selectionBar.classList.add("pending");
    if (flash) { els.selectionBar.animate([{outline:"2px solid rgba(100,255,160,0.4)"},{outline:"2px solid transparent"}], {duration:400}); }
  } else if (currentSelection) {
    els.selLabel.textContent = `${currentSelection.path}:${currentSelection.text.length} chars`;
    els.selPreview.textContent = currentSelection.text.slice(0, 600);
    els.attachSel.textContent = "Add selection";
    els.attachSel.disabled = false;
    els.clearSel.textContent = "×";
    els.selectionBar.classList.remove("pending");
    els.attachSel.hidden = false;
  } else {
    els.selectionBar.hidden = true;
    els.attachSel.textContent = "Add selection";
    els.attachSel.disabled = false;
  }
}

async function openFile(path) {
  const p = normalizePathExport(path);
  if (!project.has(p)) {
    // maybe it's a folder — expand
    return;
  }
  activePath = p;
  if (!openTabs.includes(p)) openTabs.push(p);
  renderTabs();
  const ctrl = await ensureEditor();
  const content = project.getContent(p) ?? "";
  // setValue triggers onChange? Our editor's setValue dispatches change, so temporarily detach? We'll save anyway same content
  ctrl.setValue(content, p);
  ctrl.focus();
  syncState();
  explorer.setSelected(p);
  // switch preview/run mode
  if (p.toLowerCase().endsWith(".html")) switchOut("preview");
  else switchOut("console");
}

function renderTabs() {
  if (!els.tabs) return;
  els.tabs.replaceChildren();
  for (const p of [...openTabs]) {
    if (!project.has(p)) {
      openTabs = openTabs.filter(x => x !== p);
      continue;
    }
  }
  for (const p of openTabs) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "ws-tab small" + (p === activePath ? " active" : "");
    tab.title = p;
    const label = document.createElement("span");
    label.textContent = basename(p);
    label.className = "ws-tab-label";
    const close = document.createElement("span");
    close.textContent = "×";
    close.className = "ws-tab-del";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = openTabs.indexOf(p);
      openTabs.splice(idx, 1);
      if (p === activePath) {
        activePath = openTabs[idx] || openTabs[idx-1] || null;
        if (activePath) openFile(activePath);
        else renderTabs();
      } else renderTabs();
    });
    tab.appendChild(label);
    tab.appendChild(close);
    tab.addEventListener("click", () => openFile(p));
    els.tabs.appendChild(tab);
  }
  if (openTabs.length === 0 && activePath) {
    // ensure activePath still shown
  }
}

// ---- Console / Preview ----

function switchOut(which) {
  els.outTabs.forEach(t => t.classList.toggle("active", t.dataset.out === which));
  els.outConsole.hidden = which !== "console";
  els.previewFrame.hidden = which !== "preview";
}

function pushConsole(level, text) {
  const line = document.createElement("div");
  line.className = `ws-console-line ${level}`;
  line.textContent = `[${level}] ${text}`;
  els.outConsole.appendChild(line);
  els.outConsole.scrollTop = els.outConsole.scrollHeight;
  previewLogs.push(`[${level}] ${text}`);
  if (previewLogs.length > 400) previewLogs.shift();
}

async function runActive() {
  if (!activePath) return;
  const low = activePath.toLowerCase();
  if (low.endsWith(".py")) await runPythonFile(activePath);
  else if (low.endsWith(".html") || low.endsWith(".css") || low.endsWith(".js")) runPreview();
  else {
    // generic: if py file exists try python, else preview
    if (low.endsWith(".py")) await runPythonFile(activePath);
    else pushConsole("info", `No runner for ${activePath} — press ▶ Run on a .py or open preview for web files.`);
  }
}

async function runPythonFile(path) {
  const code = project.getContent(path) ?? "";
  els.outConsole.replaceChildren();
  previewLogs = [];
  pushConsole("info", `▶ python ${path}`);
  // Sync entire project to Pyodide FS
  try {
    if (!isPyodideLoaded()) {
      pushConsole("info", "Booting Python...");
      await loadPyodideRuntime({ onStatus: s => pushConsole("info", s) });
    }
    await syncFilesToPyFS(project);
    const res = await runPython(code);
    if (res.stdout) pushConsole("log", res.stdout);
    if (res.result) pushConsole("log", `=> ${res.result}`);
    if (res.stderr) pushConsole("warn", res.stderr);
    if (res.error) pushConsole("error", res.error);
    for (const png of res.plots ?? []) {
      const img = document.createElement("img");
      img.className = "ws-plot";
      img.src = png;
      els.outConsole.appendChild(img);
    }
    if (res.ok) pushConsole("info", "✔ done");
    else pushConsole("error", "✖ failed");
    syncState();
    return res;
  } catch (err) {
    pushConsole("error", String(err?.message ?? err));
    return { ok: false, error: String(err) };
  }
}

function runPreview() {
  // Compose from project: uses index.html if active is html, otherwise generic
  try {
    // If active is not html but project has index.html, preview that; else preview active if html
    let htmlFile = activePath && activePath.toLowerCase().endsWith(".html") ? activePath : "index.html";
    if (!project.has(htmlFile)) {
      // find any html
      const anyHtml = project.listPaths().find(p => p.toLowerCase().endsWith(".html"));
      if (anyHtml) htmlFile = anyHtml;
    }
    // Use runner helper that handles flat map
    const map = {};
    for (const [k, v] of project.files) map[k] = v.content;
    // runner will inline style.css/script.js relative to htmlFile? For now assume root index.html
    runner.run(map);
    els.outConsole.replaceChildren();
    previewLogs = [];
    pushConsole("info", `Preview: ${htmlFile}`);
    switchOut("preview");
  } catch (e) { pushConsole("error", String(e)); }
}

// ---- Agent thread helpers ----

function clearAgentThread() {
  els.agentThread.replaceChildren();
  const e = document.createElement("div");
  e.className = "ws-empty";
  e.innerHTML = `Ask the agent to build, refactor, or fix.<br><br>Tools: read/write/edit/search/run.`;
  els.agentThread.appendChild(e);
}

function appendAgent(role, markdown) {
  els.agentThread.querySelector(".ws-empty")?.remove();
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;
  const label = document.createElement("div");
  label.className = "role";
  label.textContent = role === "user" ? "You" : "Agent";
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;
  bubble.innerHTML = role === "assistant" ? renderMarkdown(markdown || "") : escapeHtml(markdown || "");
  msg.append(label, bubble);
  els.agentThread.appendChild(msg);
  els.agentScroll.scrollTop = els.agentScroll.scrollHeight;
  return bubble;
}

function appendToolCard(call, result) {
  const card = document.createElement("div");
  card.className = "ws-tool-card " + (result?.ok ? "ok" : "err");
  const head = document.createElement("div");
  head.className = "ws-tool-head mono";
  head.textContent = `🔧 ${call.name} ${result?.ok ? "✓" : "✗"}`;
  const argsPre = document.createElement("pre");
  argsPre.className = "ws-tool-args mono";
  argsPre.textContent = JSON.stringify(call.args || call.arguments || {}, null, 2).slice(0, 900);
  card.append(head, argsPre);
  if (result) {
    const out = document.createElement("pre");
    out.className = "ws-tool-out mono";
    out.textContent = (result.output || "").slice(0, 1200);
    card.appendChild(out);
  }
  // inserts into last assistant bubble or new?
  els.agentThread.querySelector(".ws-empty")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble assistant";
  bubble.appendChild(card);
  wrap.appendChild(bubble);
  els.agentThread.appendChild(wrap);
  els.agentScroll.scrollTop = els.agentScroll.scrollHeight;
  return card;
}

// ---- Send to harness ----

async function sendToAgent() {
  const text = els.agentInput.value.trim();
  if (!text || !modelService.ready || generating) return;
  const taskWithSelection = pendingSelection
    ? `${text}\n\n[User selected code from ${pendingSelection.path}:]\n\`\`\`\n${pendingSelection.text.slice(0, 6000)}\n\`\`\``
    : text;
  els.agentInput.value = "";
  autoGrowAgent();
  syncState();

  appendAgent("user", text + (pendingSelection ? `\n\n> Attached selection from \`${pendingSelection.path}\`` : ""));
  // keep copy for history
  const userMsg = { role: "user", content: taskWithSelection };
  harnessMessages.push(userMsg);
  const thisSelection = pendingSelection;
  pendingSelection = null;
  updatePendingChip();

  generating = true;
  abortController = new AbortController();
  els.agentStatus.textContent = "Agent thinking…";
  syncState();

  const unlock = acquireLock("code");
  if (!unlock) {
    appendAgent("assistant", "_Another app is generating — try again shortly._");
    generating = false; syncState(); abortController = null; return;
  }

  // Build executors that mutate project
  const executors = {
    writeFile: async (path, content) => {
      const p = normalizePathExport(path);
      project.set(p, content);
      await saveProject(project);
      explorer.refresh();
      renderTabs();
      if (p === activePath && editorCtrl) {
        const cur = editorCtrl.getValue();
        if (cur !== content) editorCtrl.setValue(content, p);
      } else if (!openTabs.includes(p) && project.has(p)) {
        // auto-add tab hint? not auto-open
      }
      return { ok: true };
    },
    deleteFile: async (path) => {
      const p = normalizePathExport(path);
      if (!project.has(p)) throw new Error("Not found");
      project.delete(p);
      await saveProject(project);
      explorer.refresh();
      openTabs = openTabs.filter(x => x !== p);
      if (activePath === p) activePath = openTabs[0] || project.listPaths()[0] || null;
      renderTabs();
      if (activePath) await openFile(activePath);
      return { ok: true };
    },
    mkdir: async (path) => {
      const p = normalizePathExport(path);
      project.set(`${p}/.gitkeep`, "");
      await saveProject(project);
      explorer.refresh();
      return { ok: true };
    },
    search: async (query, k = 8) => {
      // BM25 over code files
      const idx = new BM25Index();
      const files = project.listFiles();
      for (const f of files) {
        const chunks = chunkText(f.content, { size: 800, overlap: 100 });
        chunks.forEach((c, i) => idx.add(c, { docName: f.path, chunk: i + 1, of: chunks.length }));
      }
      const hits = idx.search(query, k);
      if (hits.length === 0) return "(no matches)";
      return hits.map(h => `File: ${h.meta.docName} · chunk ${h.meta.chunk}/${h.meta.of} (score ${h.score.toFixed(2)})\n${h.text.slice(0, 900)}`).join("\n\n---\n\n");
    },
    runPython: async (arg, opts) => {
      let code = "";
      let path = "";
      if (opts?.code) { code = opts.code; path = opts.path || ""; }
      else if (typeof arg === "string" && project.has(arg)) { path = arg; code = project.getContent(arg) ?? ""; }
      else if (typeof arg === "string" && arg.includes("\n")) { code = arg; }
      else if (typeof arg === "string") { path = arg; code = project.getContent(arg) ?? arg; }

      // Ensure project files are synced
      if (!isPyodideLoaded()) {
        await loadPyodideRuntime({ onStatus: s => { els.agentStatus.textContent = s; } });
      }
      await syncFilesToPyFS(project);
      const res = await runPython(code);
      // mirror to console dock
      els.outConsole.replaceChildren();
      if (res.stdout) pushConsole("log", res.stdout);
      if (res.stderr) pushConsole("warn", res.stderr);
      if (res.error) pushConsole("error", res.error);
      for (const png of res.plots ?? []) {
        const img = document.createElement("img"); img.className = "ws-plot"; img.src = png; els.outConsole.appendChild(img);
      }
      switchOut("console");
      return res;
    },
    runWeb: async (entry) => {
      const e = entry || "index.html";
      // Use project map
      const map = {}; for (const [k, v] of project.files) map[k] = v.content;
      // If entry specified, make sure it exists
      let htmlPath = e;
      if (!project.has(htmlPath)) {
        const anyHtml = project.listPaths().find(p => p.toLowerCase().endsWith(".html"));
        htmlPath = anyHtml || htmlPath;
      }
      runPreview();
      await new Promise(r => setTimeout(r, 900));
      const logs = previewLogs.join("\n").slice(0, 4000) || "(no console output yet)";
      return { ok: true, log: logs };
    },
    installPackage: async (name) => {
      if (!isPyodideLoaded()) await loadPyodideRuntime({ onStatus: s => els.agentStatus.textContent = s });
      try {
        await installPackage(name, { onStatus: s => pushConsole("info", s) });
        pushConsole("log", `✔ ${name} installed`);
        return { ok: true, output: `${name} installed` };
      } catch (e) { pushConsole("error", String(e)); return { ok: false, error: String(e) }; }
    },
  };

  try {
    const result = await runCodeHarness({
      project,
      task: taskWithSelection,
      selection: thisSelection,
      history: harnessMessages.slice(0, -1), // all before this turn
      signal: abortController.signal,
      maxSteps: 14,
      executors,
      onEvent: (evt) => {
        if (evt.type === "step") {
          els.agentStatus.textContent = `Step ${evt.step}/${evt.of} · cap ${(evt.contextLimit/1024).toFixed(0)}K · thinking…`;
        } else if (evt.type === "tool_call") {
          // show tool call card
          const c = document.createElement("div");
          c.className = "ws-tool-pending mono";
          c.textContent = `→ ${evt.call.name} ${JSON.stringify(evt.call.args || {}).slice(0, 120)}`;
          const bubble = appendAgent("assistant", c.textContent);
          // replace with proper? For now keep simple
          els.agentStatus.textContent = `Running ${evt.call.name}…`;
        } else if (evt.type === "tool_result") {
          // find last pending and upgrade
          appendToolCard(evt.call, evt.result);
        } else if (evt.type === "model_raw") {
          // Could render thinking stream — for now show thinking block if present
          if (evt.thinking) {
            // create collapsible thinking
            const t = document.createElement("details");
            t.className = "thinking-block";
            t.open = true;
            t.innerHTML = `<summary>Thinking</summary><div class="thinking-body">${renderMarkdown(evt.thinking.slice(0, 2000))}</div>`;
            const msg = document.createElement("div");
            msg.className = "msg assistant";
            const b = document.createElement("div"); b.className = "bubble assistant"; b.appendChild(t);
            msg.appendChild(b); els.agentThread.appendChild(msg);
          }
        } else if (evt.type === "answer") {
          appendAgent("assistant", evt.answer);
        } else if (evt.type === "compact") {
          appendAgent("assistant", `_Context compaction: ${evt.note}_`);
        } else if (evt.type === "observation") {
          // already handled via tool_result
        }
        els.agentScroll.scrollTop = els.agentScroll.scrollHeight;
      },
    });

    if (result.ok) {
      els.agentStatus.textContent = "Done.";
      if (result.answer) {
        // already appended via event, ensure final message stored
      }
      harnessMessages.push({ role: "assistant", content: result.answer || "(completed)" });
    } else if (!abortController.signal.aborted) {
      els.agentStatus.textContent = "Finished with max steps.";
      appendAgent("assistant", result.answer || "_Reached max steps without final answer._");
      if (result.answer) harnessMessages.push({ role: "assistant", content: result.answer });
    } else {
      els.agentStatus.textContent = "Stopped.";
    }
    await saveProject(project);
    explorer.refresh();
    renderTabs();
    // check if active file content changed on disk -> refresh editor if needed
    if (activePath && project.has(activePath)) {
      const disk = project.getContent(activePath) ?? "";
      if (editorCtrl && editorCtrl.getValue() !== disk) {
        // leave as is? For now prompt
        // Just show status
        els.agentStatus.textContent += " · File changed on disk — reload if needed.";
      }
    }
  } catch (err) {
    console.error(err);
    appendAgent("assistant", `⚠ ${escapeHtml(String(err?.message ?? err))}`);
    els.agentStatus.textContent = "Error.";
  } finally {
    unlock();
    generating = false;
    abortController = null;
    syncState();
    // persist harness history? Keep in memory; could also persist to IndexedDB
  }
}
