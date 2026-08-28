// Agentic coding workstation — Explorer + CodeMirror + Harness (v2).
// Pi-lightweight loop + Opencode registry/permissions/attachments/mentions.
// Explorer right-click → Explain/Fix/Add; @-mentions autocomplete; Auto-approve toggle; undo stack.

import { modelService } from "../../src/services/model-service.js";
import { acquireLock } from "../../src/services/generation.js";
import { renderMarkdown, escapeHtml } from "../../src/lib/markdown.js";
import { createChatThread } from "../../src/lib/chat-thread.js";
import { loadProject, saveProject, resetProject, normalizePathExport, dirname, basename } from "../../src/services/code-project.js";
import { createEditor } from "./components/editor-cm.js";
import { createExplorer } from "./components/explorer.js";
import { runHarness } from "../../src/harness/harness.js";
import { getAutoApprove, setAutoApprove, onAutoApproveChange } from "../../src/harness/permissions.js";
import { computeDiffPreview } from "../../src/harness/diff.js";
import {
  loadPyodideRuntime, runPython, installPackage, isPyodideLoaded,
  syncFilesToPyFS, stopPython, queueStdin, clearStdin, installedPackages
} from "./runners/pyodide-runner.js";
import { WebRunner } from "./runners/web-runner.js";
import { chunkText, BM25Index } from "../../src/services/context.js";
import { getContextLimitPreference, setContextLimitPreference, selectedContextLimit, onContextLimitChange } from "../../src/services/context-preference.js";
import { getThinking, setThinking } from "../../src/services/settings.js";
import { cleanProse } from "../../src/harness/parser.js";


let els = {};
let project = null;
let explorer = null;
let editorCtrl = null;
let activePath = null;
let openTabs = [];
// Attachments: array of {path,text} from selections, @-mentions, file Add-to-Agent
let attachments = [];
let currentSelection = null; // live selection {text,path,from,to}
let harnessMessages = [];
let generating = false;
let abortController = null;
let unsubModel = null;
let unsubContext = null;
let runner = null;
let saveDebounce = 0;
let threadView = null;
let pythonLogs = [];
let webLogs = [];
let outCollapsed = false;
let editorSetting = false;
let undoStack = []; // [{before, after, at, call}] history stack per mutation
let mentionState = null; // {query, start, end}
const OUT_HEIGHT_KEY = "ws-code-out-height";
const OUT_COLLAPSED_KEY = "ws-code-out-collapsed";
const CODE_MIN_CONTEXT_TOKENS = 32_768;

function showAppToast(message, type = "info") {
  let host = document.querySelector(".ws-toast-host");
  if (!host) {
    host = document.createElement("div");
    host.className = "ws-toast-host";
    host.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:1002;display:flex;flex-direction:column;gap:8px;pointer-events:none;";
    document.body.appendChild(host);
  }
  const toast = document.createElement("div");
  toast.className = `ws-toast ${type}`;
  toast.textContent = String(message ?? "");
  toast.style.pointerEvents = "auto";
  toast.style.position = "static";
  toast.style.transform = "none";
  toast.style.bottom = "auto";
  toast.style.left = "auto";
  host.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
    toast.style.transition = "all .22s ease";
    setTimeout(() => toast.remove(), 240);
  }, type === "error" ? 3400 : 2600);
}

function ensureOutExpanded() {
  if (!outCollapsed) return;
  try {
    if (els.setOutCollapsed) els.setOutCollapsed(false);
    else if (els.out) {
      els.out.classList.remove("collapsed");
      outCollapsed = false;
      try { localStorage.setItem(OUT_COLLAPSED_KEY, "0"); } catch {}
      if (els.toggleOut) { els.toggleOut.textContent = "▾"; els.toggleOut.title = "Collapse"; }
      if (els.resizer) els.resizer.style.display = "";
    }
  } catch {}
}

export const codeApp = {
  id: "code",
  title: "Code",

  async mount(container) {
    const contextPreference = getContextLimitPreference();
    if (contextPreference === "auto" || Number(contextPreference) < CODE_MIN_CONTEXT_TOKENS) {
      setContextLimitPreference(String(CODE_MIN_CONTEXT_TOKENS));
    }
    if (!getThinking()) setThinking(true);
    els = {};
    pythonLogs = [];
    webLogs = [];
    undoStack = [];
    attachments = [];
    mentionState = null;
    buildDom(container);
    runner = new WebRunner(els.previewFrame, { onConsole: (level, text) => pushConsole(level, text, "web") });
    unsubModel = modelService.subscribe(() => syncState());
    unsubContext = onContextLimitChange(() => syncState());
    // toggle listener
    if (els.autoApproveToggle) {
      els.autoApproveToggle.checked = getAutoApprove();
      els.autoApproveToggle.addEventListener("change", () => setAutoApprove(els.autoApproveToggle.checked));
    }
    // also listen for external toggle changes
    const unsubAuto = onAutoApproveChange((v) => { if (els.autoApproveToggle) els.autoApproveToggle.checked = !!v; updateUndoUI(); });
    // keep for unmount (reuse unsubContext var? store separately)
    els._unsubAuto = unsubAuto;

    project = await loadProject();
    explorer = createExplorer({
      container: els.explorer,
      project,
      onOpenFile: (p) => openFile(p),
      onAskAgent: (path, kind) => handleAskAgentFromExplorer(path, kind),
      onAttachFile: (path) => handleAttachFile(path),
      onFilesChanged: async (info) => {
        await saveProject(project);
        explorer.refresh();
        renderTabs();
        if (info?.type === "delete" && (activePath === info.path || activePath?.startsWith(info.path + "/"))) {
          activePath = openTabs.find(p => project.has(p)) || project.listPaths()[0] || null;
          if (activePath && project.has(activePath)) await openFile(activePath);
          else {
            renderTabs();
            if (!activePath && editorCtrl) {
              try { editorCtrl.setValue("", "untitled.txt"); } catch {}
            }
          }
        }
        if (info?.type === "rename" || info?.type === "move") {
          for (let i = 0; i < openTabs.length; i++) {
            if (openTabs[i] === info.from) openTabs[i] = info.to;
            else if (openTabs[i].startsWith(info.from + "/")) openTabs[i] = openTabs[i].replace(info.from + "/", info.to + "/");
          }
          if (activePath === info.from) {
            activePath = info.to;
            renderTabs();
            await openFile(activePath).catch(()=>{});
          } else if (activePath && activePath.startsWith(info.from + "/")) {
            activePath = activePath.replace(info.from + "/", info.to + "/");
            renderTabs();
          } else {
            renderTabs();
          }
          // also fix attachments
          for (const a of attachments) if (a.path === info.from) a.path = info.to;
          renderAttachments();
        }
        if (info?.type === "zip-import") {
          const first = project.listPaths().find(p => !p.endsWith(".gitkeep")) || project.listPaths()[0];
          if (first) { openTabs = [first]; activePath = first; renderTabs(); await openFile(first); }
          showAppToast(`Imported ${info.count ?? ""} files`, "success");
        }
        if (autoRun && shouldAutoPreview()) runPreview();
        updateUndoUI();
      },
      onReset: async () => {
        try {
          const reset = await resetProject();
          clearTimeout(saveDebounce);
          project.files.clear();
          for (const [path, file] of reset.files) {
            project.files.set(path, { content: file.content, mtime: Date.now() });
          }
          openTabs = [];
          activePath = null;
          harnessMessages = [];
          attachments = [];
          currentSelection = null;
          undoStack = [];
          clearAgentThread();
          renderAttachments();
          updateUndoUI();
          if (editorCtrl) {
            editorSetting = true;
            try { editorCtrl.setValue("", "untitled.txt"); } catch {}
            finally { setTimeout(() => { editorSetting = false; }, 0); }
          }
          explorer.render();
          const paths = project.listPaths();
          const preferred = ["main.py", "index.html", "README.md"].find(p => project.has(p)) || paths[0];
          if (preferred) { openTabs = [preferred]; activePath = preferred; renderTabs(); await openFile(preferred); }
          else renderTabs();
          syncState();
          if (shouldAutoPreview()) runPreview();
          showAppToast("Project reset to default template", "success");
        } catch (e) {
          showAppToast("Reset failed: " + String(e?.message ?? e), "error");
        }
      }
    });
    explorer.render();
    const paths = project.listPaths();
    if (paths.length) {
      const preferred = ["main.py", "index.html", "README.md"].find(p => project.has(p)) || paths[0];
      openTabs = [preferred];
      activePath = preferred;
      renderTabs();
      await openFile(preferred);
    } else {
      renderTabs();
    }
    syncState();
    renderAttachments();
    updateUndoUI();
    if (shouldAutoPreview()) runPreview();
  },

  unmount() {
    abortController?.abort();
    unsubModel?.(); unsubModel = null;
    unsubContext?.(); unsubContext = null;
    try { els._unsubAuto?.(); } catch {}
    try { editorCtrl?.destroy(); } catch {}
    editorCtrl = null;
    try { runner?.dispose(); } catch {}
    clearTimeout(saveDebounce);
    // hide mention pop
    hideMentionPop();
  },

};

function buildDom(root) {
  const wrap = document.createElement("div");
  wrap.className = "ws-app code-app ws-code-app";
  wrap.innerHTML = `
    <div class="ws-code-layout" data-role="codeLayout">
      <section class="ws-pane ws-pane-left ws-code-explorer-pane">
        <div class="ws-pane-head"><h3>Explorer</h3></div>
        <div class="ws-explorer" data-role="explorer"></div>
      </section>
      <section class="ws-pane ws-code-center">
        <div class="ws-editor-tabs" data-role="tabs"></div>
        <div class="ws-code-editor-wrap" data-role="editorWrap">
          <div class="ws-code-editor-host" data-role="editorHost"></div>
        </div>
        <div class="ws-resizer" data-role="resizer" title="Drag to resize — double-click to toggle"></div>
        <div class="ws-out" data-role="out">
          <div class="ws-out-head">
            <div class="ws-tabs">
              <button class="ws-tab small active" data-out="console">Console</button>
              <button class="ws-tab small" data-out="preview">Preview</button>
            </div>
            <div class="ws-head-actions">
              <span class="mono ws-file-name" data-role="runStatus"></span>
              <button class="ws-btn ghost tiny ws-out-toggle" data-role="toggleOut" title="Collapse/Expand">▾</button>
              <button class="ws-btn ghost small" data-role="pkgBtn" title="Install Python packages from PyPI">📦 Packages</button>
              <button class="ws-btn ghost small" data-role="runBtn">▶ Run</button>
              <button class="ws-btn danger small" data-role="stopPyBtn" hidden>⏹ Stop</button>
              <button class="ws-btn ghost tiny" data-role="clearOut">clear</button>
            </div>
          </div>
          <div class="ws-console-container" data-role="consoleContainer" style="display:flex; flex-direction:column; height:calc(100% - 38px)">
            <pre class="ws-console mono" data-role="console" style="flex:1; margin:0" tabindex="0" title="Click here or the input bar below to send keyboard commands to Python"></pre>
            <div class="ws-console-input-row mono" data-role="consoleInputRow" style="display:flex; align-items:center; gap:6px; padding:4px 8px; border-top:1px solid var(--line-soft); background:rgba(0,0,0,0.15)">

              <label class="mono" style="display:flex; align-items:center; gap:4px; font-size:11px; color:var(--t3); cursor:pointer; user-select:none" title="When enabled, every keypress (WASD, Arrow keys, Space, etc.) is sent directly to Python stdin in real-time">
                <input type="checkbox" data-role="liveKeysToggle" style="margin:0; cursor:pointer;" checked />
                <span>🕹️ Live keys</span>
              </label>
              <input type="text" class="ws-console-input mono" data-role="consoleInput" placeholder="Send input to Python stdin (type here, or use Arrow keys / WASD for game controls)..." style="flex:1; background:transparent; border:none; outline:none; color:var(--t1); font-size:12px;" />
              <button class="ws-btn ghost tiny" data-role="sendConsoleInput">Send</button>
            </div>
          </div>
          <div class="ws-preview-view" data-role="previewView" hidden>
            <iframe class="ws-preview-frame" data-role="previewFrame" sandbox="allow-scripts allow-modals" hidden></iframe>
            <pre class="ws-console ws-preview-console mono" data-role="webConsole" aria-label="Web preview console"></pre>
          </div>
        </div>
      </section>
      <div class="ws-resizer-agent" data-role="agentResizer" title="Drag to resize Agent panel — double-click to reset"></div>
      <section class="ws-pane ws-code-agent ws-pane-right" data-role="agentPane">

        <div class="ws-pane-head">
          <h3>Agent</h3>
          <div class="ws-head-actions" style="gap:6px; flex-wrap:wrap">
            <label class="ws-auto-toggle mono" title="Auto-approve file edits & runs without asking">
              <input type="checkbox" data-role="autoApproveToggle" />
              <span>Auto-approve</span>
            </label>
            <button class="ws-btn ghost small" data-role="undoBtn" title="Undo last file change (history stack)">↩ Undo</button>
            <button class="ws-btn ghost small" data-role="newSession">New</button>
            <button class="ws-btn ghost small" data-role="clearAgent">Clear</button>
          </div>
        </div>
        <div class="ws-task-list mono" data-role="taskList" hidden style="margin:8px 10px 0; padding:8px 10px; border-radius:6px; background:rgba(0,0,0,0.25); border:1px solid var(--line-soft); font-size:11.5px;"></div>
        <div class="ws-thread-scroll" data-role="agentScroll"><div class="ws-thread" data-role="agentThread">
          <div class="ws-empty">Ask the agent to build, refactor, or fix.<br><br>Tools: <span class="mono">read_file · apply_patch · write_file · search · run_python · run_web</span><br><br>
          Tip: Right-click a file → <b>Explain / Fix / Add to Agent</b> or type <span class="mono">@</span> to mention files. Select code → <b>Add selection</b>.<br><br><span class="mono" style="font-size:11px; color:var(--t4)">Auto-approve toggle controls whether edits need confirmation.</span></div>
        </div></div>
        <div class="ws-attachments" data-role="attachmentsBar" hidden>
          <div class="ws-attachments-head mono">Attachments (<span data-role="attachCount">0</span>) <button class="ws-btn ghost tiny" data-role="clearAllAttach">Clear all</button></div>
          <div class="ws-attachments-list" data-role="attachmentsList"></div>
        </div>
        <div class="ws-agent-selection" data-role="selectionBar" hidden>
          <div class="ws-selection-chip mono"><span data-role="selLabel"></span><button class="ws-btn ghost tiny" data-role="attachSel">Add selection</button><button class="ws-btn ghost tiny" data-role="clearSel">×</button></div>
          <pre class="ws-selection-preview mono" data-role="selPreview"></pre>
        </div>
        <div class="ws-permission-card" data-role="permissionCard" hidden>
          <div class="ws-perm-head mono"><span data-role="permTitle">Permission required</span><button class="ws-btn ghost tiny" data-role="permDismiss">×</button></div>
          <div class="ws-perm-body mono" data-role="permBody"></div>
          <pre class="ws-perm-diff mono" data-role="permDiff" hidden></pre>
          <div class="ws-perm-actions">
            <button class="ws-btn small" data-role="permDeny">Deny</button>
            <button class="ws-btn ghost small" data-role="permAllowOnce">Allow</button>
            <button class="ws-btn primary small" data-role="permAllowAlways">Allow & don't ask again</button>
          </div>
        </div>
        <div class="ws-agent-context mono" data-role="agentContext" title="Current file-context budget (based on top-bar cap + model limits)"></div>
        <footer class="ws-composer" style="position:relative">
          <textarea data-role="agentInput" rows="2" placeholder="Load the model first, then describe a task… (use @ to mention files)"></textarea>
          <div class="ws-mention-pop" data-role="mentionPop" hidden></div>
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
    codeLayout: wrap.querySelector('[data-role="codeLayout"]'),
    agentResizer: wrap.querySelector('[data-role="agentResizer"]'),
    agentPane: wrap.querySelector('[data-role="agentPane"]'),
    explorer: wrap.querySelector('[data-role="explorer"]'),
    tabs: wrap.querySelector('[data-role="tabs"]'),
    editorWrap: wrap.querySelector('[data-role="editorWrap"]'),
    editorHost: wrap.querySelector('[data-role="editorHost"]'),
    out: wrap.querySelector('[data-role="out"]'),
    resizer: wrap.querySelector('[data-role="resizer"]'),
    toggleOut: wrap.querySelector('[data-role="toggleOut"]'),
    center: wrap.querySelector('.ws-code-center'),

    outTabs: wrap.querySelectorAll("[data-out]"),
    consoleContainer: wrap.querySelector('[data-role="consoleContainer"]'),
    outConsole: wrap.querySelector('[data-role="console"]'),
    previewView: wrap.querySelector('[data-role="previewView"]'),
    webConsole: wrap.querySelector('[data-role="webConsole"]'),
    consoleInputRow: wrap.querySelector('[data-role="consoleInputRow"]'),
    consoleInput: wrap.querySelector('[data-role="consoleInput"]'),
    liveKeysToggle: wrap.querySelector('[data-role="liveKeysToggle"]'),
    sendConsoleInput: wrap.querySelector('[data-role="sendConsoleInput"]'),
    previewFrame: wrap.querySelector('[data-role="previewFrame"]'),
    clearOut: wrap.querySelector('[data-role="clearOut"]'),
    runBtn: wrap.querySelector('[data-role="runBtn"]'),
    stopPyBtn: wrap.querySelector('[data-role="stopPyBtn"]'),
    pkgBtn: wrap.querySelector('[data-role="pkgBtn"]'),
    runStatus: wrap.querySelector('[data-role="runStatus"]'),
    taskList: wrap.querySelector('[data-role="taskList"]'),
    agentScroll: wrap.querySelector('[data-role="agentScroll"]'),
    agentThread: wrap.querySelector('[data-role="agentThread"]'),
    agentInput: wrap.querySelector('[data-role="agentInput"]'),
    mentionPop: wrap.querySelector('[data-role="mentionPop"]'),
    sendAgent: wrap.querySelector('[data-role="sendAgent"]'),
    stopAgent: wrap.querySelector('[data-role="stopAgent"]'),
    newSession: wrap.querySelector('[data-role="newSession"]'),
    clearAgent: wrap.querySelector('[data-role="clearAgent"]'),
    autoApproveToggle: wrap.querySelector('[data-role="autoApproveToggle"]'),
    undoBtn: wrap.querySelector('[data-role="undoBtn"]'),
    attachmentsBar: wrap.querySelector('[data-role="attachmentsBar"]'),
    attachmentsList: wrap.querySelector('[data-role="attachmentsList"]'),
    attachCount: wrap.querySelector('[data-role="attachCount"]'),
    clearAllAttach: wrap.querySelector('[data-role="clearAllAttach"]'),
    selectionBar: wrap.querySelector('[data-role="selectionBar"]'),
    selLabel: wrap.querySelector('[data-role="selLabel"]'),
    selPreview: wrap.querySelector('[data-role="selPreview"]'),
    attachSel: wrap.querySelector('[data-role="attachSel"]'),
    clearSel: wrap.querySelector('[data-role="clearSel"]'),
    permissionCard: wrap.querySelector('[data-role="permissionCard"]'),
    permTitle: wrap.querySelector('[data-role="permTitle"]'),
    permBody: wrap.querySelector('[data-role="permBody"]'),
    permDiff: wrap.querySelector('[data-role="permDiff"]'),
    permDeny: wrap.querySelector('[data-role="permDeny"]'),
    permAllowOnce: wrap.querySelector('[data-role="permAllowOnce"]'),
    permAllowAlways: wrap.querySelector('[data-role="permAllowAlways"]'),
    permDismiss: wrap.querySelector('[data-role="permDismiss"]'),
    agentStatus: wrap.querySelector('[data-role="agentStatus"]'),
    agentContext: wrap.querySelector('[data-role="agentContext"]'),
  });


  threadView = createChatThread({ scrollEl: els.agentScroll, threadEl: els.agentThread, userLabel: "You", assistantLabel: "Agent" });

  els.agentScroll.addEventListener("scroll", () => {
    const el = els.agentScroll;
    userScrolledUp = (el.scrollHeight - el.scrollTop - el.clientHeight) > 80;
  }, { passive: true });

  // tabs + out
  els.runBtn.addEventListener("click", () => runActive());
  els.stopPyBtn.addEventListener("click", () => {
    stopPython();
    pushConsole("warn", "Execution stopped by user.", "python");
    els.stopPyBtn.hidden = true;
    els.runBtn.hidden = false;
  });
  els.pkgBtn.addEventListener("click", () => openPackageManagerModal());

  const handleConsoleInput = (customVal) => {
    const val = customVal !== undefined ? customVal : els.consoleInput.value;
    if (val === "" && customVal === undefined) return;
    queueStdin(val);
    pushConsole("log", `> ${val}`, "python");
    if (customVal === undefined) els.consoleInput.value = "";
  };

  els.sendConsoleInput?.addEventListener("click", () => handleConsoleInput());

  const dispatchKeyCommand = (key) => {
    const arrowMap = {
      ArrowLeft: "a",
      ArrowRight: "d",
      ArrowUp: "w",
      ArrowDown: "s",
      Space: " ",
      " ": " ",
    };
    const mapped = arrowMap[key] !== undefined ? arrowMap[key] : key;
    queueStdin(mapped);
    pushConsole("info", `[stdin key] ${key}${mapped !== key ? ` (${mapped})` : ""}`, "python");
  };

  const handleKeydownCapture = (e) => {
    if (e.key === "Enter") {
      if (els.consoleInput.value.trim() !== "") {
        e.preventDefault();
        handleConsoleInput();
      }
      return;
    }

    // Always capture arrow keys and space
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(e.key)) {
      e.preventDefault();
      dispatchKeyCommand(e.key);
      return;
    }

    // In Live Keys mode, capture single printable keys (WASD, q, r, numbers, etc.)
    if (els.liveKeysToggle?.checked && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      dispatchKeyCommand(e.key);
      els.consoleInput.value = "";
    }
  };

  els.consoleInput?.addEventListener("keydown", handleKeydownCapture);
  els.outConsole?.addEventListener("keydown", handleKeydownCapture);
  els.outConsole?.addEventListener("click", () => els.consoleInput?.focus());


  els.clearOut.addEventListener("click", () => {
    els.outConsole.replaceChildren();
    if (consoleSource === "web" || currentRunnerMode === "preview") {
      webLogs = [];
      renderWebConsole();
    }
    else pythonLogs = [];
  });
  els.outTabs.forEach(t => t.addEventListener("click", () => switchOut(t.dataset.out)));


  // agent composers
  els.sendAgent.addEventListener("click", () => sendToAgent());
  els.stopAgent.addEventListener("click", () => abortController?.abort());
  els.agentInput.addEventListener("keydown", (e) => {
    if (handleMentionKeydown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!els.sendAgent.disabled) sendToAgent(); }
  });
  els.agentInput.addEventListener("input", () => { syncState(); autoGrowAgent(); handleMentionInput(); });
  els.agentInput.addEventListener("blur", () => setTimeout(hideMentionPop, 150));
  els.agentInput.addEventListener("click", () => handleMentionInput());
  els.clearAgent.addEventListener("click", () => {
    abortController?.abort();
    harnessMessages = [];
    undoStack = [];
    clearAgentThread();
    attachments = [];
    renderAttachments();
    updateUndoUI();
    els.agentStatus.textContent = "Agent history and undo stack cleared.";
  });
  els.newSession.addEventListener("click", () => {
    abortController?.abort();
    harnessMessages = [];
    undoStack = [];
    clearAgentThread();
    attachments = [];
    renderAttachments();
    updateUndoUI();
    els.agentStatus.textContent = "New session — history and undo stack cleared.";
  });
  els.clearAllAttach.addEventListener("click", () => { attachments = []; renderAttachments(); });
  els.undoBtn.addEventListener("click", () => doUndo());
  els.attachSel.addEventListener("click", () => {
    if (currentSelection?.text) {
      addAttachment({ path: currentSelection.path, text: currentSelection.text });
      els.agentInput.focus();
    }
  });
  els.clearSel.addEventListener("click", () => {
    if (attachments.length) { /* handled via pills */ }
    else { currentSelection = null; els.selectionBar.hidden = true; }
    // clear selection preview if no attachments pending
    if (!currentSelection) els.selectionBar.hidden = true;
  });

  // permission card dismiss
  els.permDismiss.addEventListener("click", () => hidePermissionCard("deny"));
  els.permDeny.addEventListener("click", () => hidePermissionCard("deny"));
  els.permAllowOnce.addEventListener("click", () => hidePermissionCard("allow"));
  els.permAllowAlways.addEventListener("click", () => hidePermissionCard("allow_always"));

  // selection bar initially hidden
  renderAttachments();
  autoGrowAgent();

  // ----- bottom bar resizer / collapsible -----
  initOutLayout();
  if (els.resizer) {
    let dragging = false;
    let startY = 0;
    let startH = 0;
    const onMove = (e) => {
      if (!dragging) return;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const dy = startY - clientY;
      const newH = Math.max(80, Math.min(window.innerHeight * 0.7, startH + dy));
      setOutHeight(newH);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      els.resizer.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
    const onDown = (e) => {
      if (outCollapsed) {
        setOutCollapsed(false);
        return;
      }
      e.preventDefault();
      dragging = true;
      startY = e.touches ? e.touches[0].clientY : e.clientY;
      startH = els.out.offsetHeight;
      els.resizer.classList.add("dragging");
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onUp);
    };
    els.resizer.addEventListener("mousedown", onDown);
    els.resizer.addEventListener("touchstart", onDown, { passive: false });
    els.resizer.addEventListener("dblclick", () => setOutCollapsed(!outCollapsed));
  }
  if (els.toggleOut) {
    els.toggleOut.addEventListener("click", () => setOutCollapsed(!outCollapsed));
  }

  // ----- agent column resizer -----
  if (els.agentResizer && els.codeLayout && els.agentPane) {
    const AGENT_WIDTH_KEY = "gemma_agent_col_width";
    try {
      const savedW = Number(localStorage.getItem(AGENT_WIDTH_KEY));
      if (Number.isFinite(savedW) && savedW >= 240 && savedW <= window.innerWidth * 0.75) {
        els.codeLayout.style.setProperty("--agent-width", `${savedW}px`);
      }
    } catch {}

    let draggingAgent = false;
    let startX = 0;
    let startW = 400;

    const onAgentMove = (e) => {
      if (!draggingAgent) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const dx = startX - clientX;
      const newW = Math.max(260, Math.min(window.innerWidth * 0.7, startW + dx));
      els.codeLayout.style.setProperty("--agent-width", `${Math.round(newW)}px`);
    };

    const onAgentUp = () => {
      if (!draggingAgent) return;
      draggingAgent = false;
      els.agentResizer.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onAgentMove);
      window.removeEventListener("mouseup", onAgentUp);
      window.removeEventListener("touchmove", onAgentMove);
      window.removeEventListener("touchend", onAgentUp);
      const curW = parseInt(els.codeLayout.style.getPropertyValue("--agent-width") || "400", 10);
      if (curW) {
        try { localStorage.setItem(AGENT_WIDTH_KEY, String(curW)); } catch {}
      }
      if (editorCtrl) try { editorCtrl.view.requestMeasure(); } catch {}
    };

    const onAgentDown = (e) => {
      e.preventDefault();
      draggingAgent = true;
      startX = e.touches ? e.touches[0].clientX : e.clientX;
      startW = els.agentPane.offsetWidth || 400;
      els.agentResizer.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onAgentMove);
      window.addEventListener("mouseup", onAgentUp);
      window.addEventListener("touchmove", onAgentMove, { passive: false });
      window.addEventListener("touchend", onAgentUp);
    };

    els.agentResizer.addEventListener("mousedown", onAgentDown);
    els.agentResizer.addEventListener("touchstart", onAgentDown, { passive: false });
    els.agentResizer.addEventListener("dblclick", () => {
      els.codeLayout.style.setProperty("--agent-width", "400px");
      try { localStorage.setItem(AGENT_WIDTH_KEY, "400"); } catch {}
      if (editorCtrl) try { editorCtrl.view.requestMeasure(); } catch {}
    });
  }

  function initOutLayout() {
    try {
      const savedH = Number(localStorage.getItem(OUT_HEIGHT_KEY));
      const savedCollapsed = localStorage.getItem(OUT_COLLAPSED_KEY) === "1";
      if (Number.isFinite(savedH) && savedH >= 80 && savedH <= window.innerHeight * 0.75) {
        els.out.style.height = savedH + "px";
      }
      setOutCollapsed(savedCollapsed, true);
    } catch {}
  }
  function setOutHeight(px) {
    if (outCollapsed) setOutCollapsed(false, true);
    els.out.style.height = px + "px";
    try { localStorage.setItem(OUT_HEIGHT_KEY, String(Math.round(px))); } catch {}
    if (editorCtrl) try { editorCtrl.view.requestMeasure(); } catch {}
  }
  function setOutCollapsed(collapsed, silent) {
    outCollapsed = !!collapsed;
    els.out.classList.toggle("collapsed", outCollapsed);
    if (els.toggleOut) els.toggleOut.textContent = outCollapsed ? "▴" : "▾";
    if (els.toggleOut) els.toggleOut.title = outCollapsed ? "Expand" : "Collapse";
    if (els.resizer) els.resizer.style.display = outCollapsed ? "none" : "";
    try { localStorage.setItem(OUT_COLLAPSED_KEY, outCollapsed ? "1" : "0"); } catch {}
    if (!silent && !outCollapsed && editorCtrl) {
      try { editorCtrl.view.requestMeasure(); } catch {}
    }
  }
  // expose for external toggles
  els.setOutHeight = setOutHeight;
  els.setOutCollapsed = setOutCollapsed;
}

function autoGrowAgent() {
  els.agentInput.style.height = "auto";
  els.agentInput.style.height = Math.min(els.agentInput.scrollHeight, 140) + "px";
}

let autoRun = true;

function runnerForPath(path) {
  const low = String(path || "").toLowerCase();
  if (low.endsWith(".py") || low.endsWith(".pyw")) return "python";
  if (low.endsWith(".html") || low.endsWith(".htm") || low.endsWith(".css") || low.endsWith(".js") || low.endsWith(".mjs")) return "web";
  return "none";
}

function shouldAutoPreview() {
  if (!activePath) return false;
  return runnerForPath(activePath) === "web";
}

function syncState() {
  const ready = modelService.ready;
  const hasText = !!els.agentInput.value.trim() || attachments.length > 0;
  els.sendAgent.disabled = !ready || generating || !hasText;
  els.agentInput.placeholder = !ready ? "Load the model to talk to the agent… (use @ to mention files)" : activePath ? `Ask about ${activePath}… (@ to mention)` : "Describe a task… (@ to mention files)";
  // Run button state is managed by refreshBottomBar (file-type derived); just handle generating lock
  if (generating && els.runBtn) els.runBtn.disabled = true;
  else refreshBottomBar();
  if (els.runStatus) els.runStatus.textContent = isPyodideLoaded() ? "Py ready" : "";
  if (els.agentContext) {
    const arch = Number(modelService.capabilities?.architecturalMax) || 131072;
    const eff = Number(modelService.capabilities?.effectiveContextMax) || arch;
    const capPref = getContextLimitPreference();
    const cap = capPref === "auto" ? arch : Math.min(arch, Number(capPref));
    const effCapped = Math.min(eff, cap);
    const stats = project?.getStats();
    const approxTokens = stats ? Math.ceil(stats.totalChars * 0.25) : 0;
    const label = capPref === "auto" ? "Auto" : `${(cap/1024).toFixed(0)}K`;
    els.agentContext.textContent = `Files ~${approxTokens.toLocaleString()} tokens · cap ${label} · effective ${(effCapped/1024).toFixed(0)}K${attachments.length?` · ${attachments.length} attached`: ""} · ${undoStack.length?`${undoStack.length} undo`: "no undo"}`;
  }
  els.stopAgent.hidden = !generating;
  els.sendAgent.hidden = generating;
  if (!generating) els.agentInput.disabled = !ready;
  else els.agentInput.disabled = true;
  updateUndoUI();
}

function updateUndoUI(){
  if (!els.undoBtn) return;
  els.undoBtn.disabled = undoStack.length === 0 || generating;
  els.undoBtn.title = undoStack.length ? `Undo last change (${undoStack.length} in stack)` : "Nothing to undo";
  els.undoBtn.textContent = undoStack.length ? `↩ Undo (${undoStack.length})` : "↩ Undo";
}

// ---- Attachments ----

function addAttachment({path, text}){
  const norm = normalizePathExport(path);
  const content = String(text ?? project.getContent(norm) ?? "");
  if (!norm || !content) { showAppToast(`No content for ${path}`, "error"); return; }
  // dedup
  if (attachments.some(a=>a.path===norm)) { showAppToast(`Already attached: ${norm}`, "info"); return; }
  // cap
  if (attachments.length >= 8) { showAppToast("Max 8 attachments — remove one first", "error"); return; }
  const snippet = content.length>8000 ? content.slice(0,8000) : content;
  attachments.push({path: norm, text: snippet});
  renderAttachments();
  syncState();
  showAppToast(`Attached ${norm}`, "success");
}

function renderAttachments(){
  if (!els.attachmentsBar) return;
  if (attachments.length===0){ els.attachmentsBar.hidden=true; return; }
  els.attachmentsBar.hidden=false;
  els.attachCount.textContent = String(attachments.length);
  els.attachmentsList.replaceChildren();
  for (let i=0;i<attachments.length;i++){
    const a=attachments[i];
    const pill=document.createElement("div");
    pill.className="ws-attach-pill mono";
    const label=document.createElement("span");
    label.textContent=`@${a.path} (${a.text.length} chars)`;
    label.title=a.path;
    const rm=document.createElement("button");
    rm.className="ws-btn ghost tiny";
    rm.textContent="×";
    rm.title="Remove";
    rm.addEventListener("click",()=>{ attachments.splice(i,1); renderAttachments(); syncState(); });
    pill.append(label, rm);
    els.attachmentsList.appendChild(pill);
  }
  // also update selection bar visibility? attachments replace pendingSelection
  if (attachments.length) {
    // hide old selection bar pending state
    els.selectionBar.hidden = true;
  }
}

function handleAttachFile(path){
  // folder? expand to files
  if (!project) return;
  const norm = normalizePathExport(path);
  if (project.has(norm)) {
    addAttachment({path: norm, text: project.getContent(norm) ?? ""});
    return;
  }
  // folder: attach up to 5 files inside
  const files = project.listPaths().filter(p=> p===norm || p.startsWith(norm+"/")).slice(0,5);
  if (files.length===0){ showAppToast(`No files in ${norm}`, "error"); return; }
  for (const f of files) addAttachment({path: f, text: project.getContent(f) ?? ""});
}

// ---- @ mentions ----

function handleMentionInput(){
  const input=els.agentInput;
  if (!input || !project) return;
  const cursor=input.selectionStart ?? input.value.length;
  const before=input.value.slice(0,cursor);
  const atIdx=before.lastIndexOf("@");
  if (atIdx===-1){ hideMentionPop(); mentionState=null; return; }
  const afterAt=before.slice(atIdx+1);
  // stop if space or newline after @ with no query and not at start? allow empty query to show all
  if (/[\s\n]/.test(afterAt.slice(-1)) && afterAt.length>0 && /\s$/.test(before)) { /* but we detect token */ }
  // token is up to cursor, no spaces => active mention
  if (/\s/.test(afterAt)) { hideMentionPop(); mentionState=null; return; }
  // check that @ is at start or preceded by space
  if (atIdx>0 && !/\s/.test(before[atIdx-1])) { hideMentionPop(); mentionState=null; return; }
  const query=afterAt.toLowerCase();
  mentionState={query, start:atIdx, end:cursor};
  showMentionPop(query);
}

function showMentionPop(query){
  if (!project) return;
  const all=project.listPaths().filter(p=>!p.endsWith("/.gitkeep") && p!==".gitkeep");
  const filtered= all.filter(p=> p.toLowerCase().includes(query)).slice(0,8);
  if (filtered.length===0){ hideMentionPop(); return; }
  els.mentionPop.replaceChildren();
  for (const p of filtered){
    const btn=document.createElement("button");
    btn.type="button";
    btn.className="ws-mention-item mono";
    btn.textContent=`@${p}`;
    btn.addEventListener("mousedown",(e)=>{ e.preventDefault(); completeMention(p); });
    els.mentionPop.appendChild(btn);
  }
  els.mentionPop.hidden=false;
}

function hideMentionPop(){
  if (els.mentionPop) els.mentionPop.hidden=true;
}

function completeMention(path){
  if (!mentionState) return;
  const input=els.agentInput;
  const before=input.value.slice(0, mentionState.start);
  const after=input.value.slice(mentionState.end);
  const insert=`@${path} `;
  input.value=before+insert+after;
  const newPos=before.length+insert.length;
  input.setSelectionRange(newPos,newPos);
  hideMentionPop();
  mentionState=null;
  // auto attach
  handleAttachFile(path);
  syncState();
  autoGrowAgent();
  input.focus();
}

function handleMentionKeydown(e){
  if (!els.mentionPop || els.mentionPop.hidden) return false;
  const items=[...els.mentionPop.querySelectorAll(".ws-mention-item")];
  if (!items.length) return false;
  let idx=items.findIndex(el=>el.classList.contains("active"));
  if (e.key==="ArrowDown"){ e.preventDefault(); idx=Math.min(items.length-1, idx+1); items.forEach((el,i)=>el.classList.toggle("active", i===idx)); return true; }
  if (e.key==="ArrowUp"){ e.preventDefault(); idx=Math.max(0, idx-1); if(idx<0) idx=0; items.forEach((el,i)=>el.classList.toggle("active", i===idx)); return true; }
  if (e.key==="Enter" || e.key==="Tab"){
    const active=items.find(el=>el.classList.contains("active")) || items[0];
    if (active){ e.preventDefault(); completeMention(active.textContent.slice(1).trim()); return true; }
  }
  if (e.key==="Escape"){ hideMentionPop(); return true; }
  return false;
}

function resolveMentionsInText(text){
  // find @paths even if not attached yet — auto attach
  const mentions=[...String(text||"").matchAll(/@([^\s`"'@]+\.[A-Za-z0-9]+|[^\s`"'@]+\/[^\s`"'@]+)/g)].map(m=>m[1]);
  const uniq=[...new Set(mentions)].map(p=> normalizePathExport(p)).filter(p=> project?.has(p));
  for(const p of uniq){
    if(!attachments.some(a=>a.path===p)){
      // silently attach (cap 8)
      if(attachments.length<8){
        const content=project.getContent(p) ?? "";
        if(content) attachments.push({path:p, text: content.slice(0,8000)});
      }
    }
  }
}

function handleAskAgentFromExplorer(path, kind){
  const promptMap={
    explain: `Explain what @${path} does. Include key functions and how it interacts with other files.`,
    fix: `Review @${path} for bugs and fix them. Keep style consistent. After fixing, verify with the appropriate runner (run_python for .py, run_web for web files).`,
    explain_folder: `Explain the purpose of the folder @${path} and how its files work together.`
  };
  const text=promptMap[kind] || `Help with @${path}`;
  // attach
  handleAttachFile(path);
  els.agentInput.value=text;
  syncState(); autoGrowAgent();
  els.agentInput.focus();
  // flash
  els.agentInput.animate([{outline:"2px solid rgba(100,255,160,0.4)"},{outline:"2px solid transparent"}], {duration:400});
}

// ---- Editor handling ----

async function ensureEditor() {
  if (editorCtrl) return editorCtrl;
  editorCtrl = await createEditor(els.editorHost, {
    value: "",
    path: activePath || "untitled.txt",
    onChange: (text) => {
      if (editorSetting) return;
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
        if (attachments.length===0) {
          // only hide if no attachments
          if (!currentSelection) els.selectionBar.hidden = true;
        }
        currentSelection = null;
        // keep attachments bar
        return;
      }
      const snippet = sel.text.length > 6000 ? sel.text.slice(0, 6000) : sel.text;
      currentSelection = { path: activePath, text: snippet, from: sel.from, to: sel.to };
      els.selLabel.textContent = `${activePath}:${snippet.length} chars`;
      els.selPreview.textContent = snippet.slice(0, 600);
      els.selectionBar.hidden = false;
    }
  });
  return editorCtrl;
}

async function openFile(path) {
  const p = normalizePathExport(path);
  if (!project.has(p) || p.endsWith("/.gitkeep") || p === ".gitkeep") {
    if (p.endsWith("/.gitkeep") || p === ".gitkeep") showAppToast("Hidden placeholder — open the folder instead", "info");
    return;
  }
  activePath = p;
  if (!openTabs.includes(p)) openTabs.push(p);
  renderTabs();
  const ctrl = await ensureEditor();
  const content = project.getContent(p) ?? "";
  editorSetting = true;
  try { ctrl.setValue(content, p); } finally { setTimeout(() => { editorSetting = false; }, 0); }
  ctrl.focus();
  syncState();
  explorer.setSelected(p);
  const mode = runnerForPath(p);
  if (mode === "web") switchOut("preview", "web");
  else if (mode === "python") switchOut("console", "python");
  else refreshBottomBar();
}

function renderTabs() {
  if (!els.tabs) return;
  openTabs = openTabs.filter(p => project.has(p) && !p.endsWith("/.gitkeep") && p !== ".gitkeep");
  if (activePath && project.has(activePath) && !activePath.endsWith(".gitkeep") && !openTabs.includes(activePath)) {
    openTabs.push(activePath);
  }
  els.tabs.replaceChildren();
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
}

// ---- Console / Preview ----

let currentRunnerMode = "console"; // "console" | "preview"
let consoleSource = "python"; // "python" | "web"

function refreshBottomBar() {
  const runner = runnerForPath(activePath);
  const isPython = runner === "python";
  const isWeb = runner === "web";

  if (els.runBtn) {
    if (isPython) {
      els.runBtn.textContent = "▶ Run Python";
      els.runBtn.title = "Run active Python script in Pyodide";
      els.runBtn.disabled = generating ? true : false;
    } else if (isWeb) {
      els.runBtn.textContent = "🔄 Refresh Preview";
      els.runBtn.title = "Render and refresh HTML preview";
      els.runBtn.disabled = generating ? true : false;
    } else {
      els.runBtn.textContent = "▶ Run";
      els.runBtn.title = activePath ? "No runner for this file type" : "Open a file to run";
      els.runBtn.disabled = true;
    }
  }

  if (els.pkgBtn) els.pkgBtn.hidden = !isPython;

  // Stdin input bar is visible whenever active file is Python (not tied to tab)
  if (els.consoleInputRow) {
    els.consoleInputRow.hidden = !isPython;
  }

  if (els.runStatus) {
    if (isPython) els.runStatus.textContent = "Python";
    else if (isWeb) els.runStatus.textContent = "Web";
    else els.runStatus.textContent = "";
  }
}

function switchOut(which, source = null) {
  const previousMode = currentRunnerMode;
  currentRunnerMode = which;
  if (source) consoleSource = source;
  else if (which === "preview") consoleSource = "web";
  else if (previousMode === "preview") consoleSource = "web";
  else if (runnerForPath(activePath) !== "none") consoleSource = runnerForPath(activePath);
  ensureOutExpanded();
  els.outTabs.forEach(t => t.classList.toggle("active", t.dataset.out === which));
  const isConsole = which === "console";
  if (els.consoleContainer) els.consoleContainer.hidden = !isConsole;
  if (els.previewView) els.previewView.hidden = isConsole;
  if (els.previewFrame) els.previewFrame.hidden = isConsole;
  // Restore the correct buffer for the visible pane
  if (els.outConsole) {
    els.outConsole.replaceChildren();
    const consoleLogs = consoleSource === "web" ? webLogs : pythonLogs;
    const logs = isConsole ? consoleLogs : webLogs;
    for (const entry of logs) {
      const line = document.createElement("div");
      line.className = `ws-console-line ${entry.level}`;
      line.textContent = `[${entry.level}] ${entry.text}`;
      els.outConsole.appendChild(line);
    }
    try { els.outConsole.scrollTop = els.outConsole.scrollHeight; } catch {}
  }
  renderWebConsole();
  refreshBottomBar();
}

function renderWebConsole() {
  if (!els.webConsole) return;
  els.webConsole.replaceChildren();
  for (const entry of webLogs) {
    const line = document.createElement("div");
    line.className = `ws-console-line ${entry.level}`;
    line.textContent = `[${entry.level}] ${entry.text}`;
    els.webConsole.appendChild(line);
  }
  try { els.webConsole.scrollTop = els.webConsole.scrollHeight; } catch {}
}

function pushConsole(level, text, source) {
  const src = source || (runnerForPath(activePath) === "web" ? "web" : "python");
  const entry = { level, text };
  if (src === "web") {
    webLogs.push(entry);
    if (webLogs.length > 400) webLogs.shift();
    renderWebConsole();
  } else {
    pythonLogs.push(entry);
    if (pythonLogs.length > 400) pythonLogs.shift();
  }
  // Only render to DOM if the relevant pane is visible
  const isConsoleVisible = currentRunnerMode === "console";
  // Always render python to console pane when console is visible; web logs render when preview visible
  // For simplicity, render to outConsole only when console pane is active
  if (!els.outConsole) return;
  if (src === "python" && (!isConsoleVisible || consoleSource !== "python")) return;
  if (src === "web" && (isConsoleVisible ? consoleSource !== "web" : true)) return;
  if (outCollapsed) ensureOutExpanded();
  const line = document.createElement("div");
  line.className = `ws-console-line ${level}`;
  line.textContent = `[${level}] ${text}`;
  els.outConsole.appendChild(line);
  try { els.outConsole.scrollTop = els.outConsole.scrollHeight; } catch {}
}

async function runActive() {
  if (!activePath) {
    pushConsole("info", "No active file selected — open a file first.", "python");
    return;
  }
  const runner = runnerForPath(activePath);
  if (runner === "python") {
    switchOut("console", "python");
    await runPythonFile(activePath);
  } else if (runner === "web") {
    switchOut("preview", "web");
    runPreview();
  } else {
    pushConsole("info", `No runner for ${activePath} — open a .py or web file.`, "python");
  }
}


async function runPythonFile(path) {
  ensureOutExpanded();
  switchOut("console", "python");
  const code = project.getContent(path) ?? "";
  els.outConsole.replaceChildren();
  pythonLogs = [];
  pushConsole("info", `▶ python ${path}`, "python");

  if (els.stopPyBtn) els.stopPyBtn.hidden = false;
  if (els.runBtn) els.runBtn.hidden = true;

  try {
    if (!isPyodideLoaded()) {
      pushConsole("info", "Booting Python runtime...", "python");
      await loadPyodideRuntime({ onStatus: s => pushConsole("info", s, "python") });
    }
    await syncFilesToPyFS(project);
    const res = await runPython(code, {
      onStdout: (s) => pushConsole("log", s, "python"),
      onStderr: (s) => pushConsole("warn", s, "python"),
    });
    if (res.result) pushConsole("log", `=> ${res.result}`, "python");
    if (res.error) pushConsole("error", res.error, "python");
    for (const png of res.plots ?? []) {
      const img = document.createElement("img");
      img.className = "ws-plot";
      img.src = png;
      els.outConsole.appendChild(img);
    }
    if (res.ok) pushConsole("info", "✔ finished", "python");
    else pushConsole("error", "✖ failed or interrupted", "python");
    syncState();
    return res;
  } catch (err) {
    pushConsole("error", String(err?.message ?? err), "python");
    return { ok: false, error: String(err) };
  } finally {
    if (els.stopPyBtn) els.stopPyBtn.hidden = true;
    if (els.runBtn) els.runBtn.hidden = false;
  }
}

function runPreview(entry = null) {
  ensureOutExpanded();
  try {
    let htmlFile = entry && /\.html?$/i.test(entry)
      ? entry
      : activePath && /\.html?$/i.test(activePath) ? activePath : "index.html";
    if (!project.has(htmlFile)) {
      const anyHtml = project.listPaths().find(p => /\.html?$/i.test(p));
      if (anyHtml) htmlFile = anyHtml;
    }
    const map = {};
    for (const [k, v] of project.files) map[k] = v.content;
    if (!htmlFile || !project.has(htmlFile)) {
      const message = "No HTML file found to preview — create index.html";
      pushConsole("warn", message, "web");
      return { ok: false, error: message };
    }
    webLogs = [];
    const ready = runner.run(map, { entry: htmlFile });
    pushConsole("info", `Preview: ${htmlFile}`, "web");
    switchOut("preview", "web");
    return { ok: true, entry: htmlFile, ready };
  } catch (e) {
    const message = String(e?.message ?? e);
    pushConsole("error", message, "web");
    return { ok: false, error: message };
  }
}


async function openPackageManagerModal() {
  const modal = document.createElement("div");
  modal.className = "ws-modal-backdrop";
  modal.innerHTML = `
    <div class="ws-modal" style="max-width:460px">
      <h3>Python Packages</h3>
      <p style="font-size:13px; color:var(--t3); margin:0 0 12px">Install pure-Python packages from PyPI or bundled scientific packages (pandas, numpy, matplotlib, sympy, rich, etc.)</p>
      <div style="display:flex; gap:6px; margin-bottom:12px">
        <input type="text" class="ws-pkg-input mono" placeholder="Package name, e.g. pandas or sympy" style="flex:1; padding:7px 10px; border-radius:6px; background:var(--panel-hover); border:1px solid var(--line); color:var(--t1)" />
        <button class="ws-btn primary small ws-pkg-install">Install</button>
      </div>
      <div class="ws-pkg-status mono" style="font-size:12px; margin-bottom:10px; min-height:1.2em; color:var(--ok)"></div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px">
        <span style="font-size:11.5px; color:var(--t4)">Loaded packages:</span>
        <button class="ws-btn ghost tiny ws-pkg-refresh" title="Refresh loaded package list" style="padding:2px 6px">↻ Refresh</button>
      </div>
      <div class="ws-pkg-list mono" style="font-size:11px; max-height:110px; overflow-y:auto; color:var(--t3); background:rgba(0,0,0,0.2); padding:6px; border-radius:4px">
      </div>
      <div class="ws-modal-actions" style="margin-top:14px; justify-content:flex-end">
        <button class="ws-btn ghost small ws-pkg-close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const input = modal.querySelector(".ws-pkg-input");
  const installBtn = modal.querySelector(".ws-pkg-install");
  const statusEl = modal.querySelector(".ws-pkg-status");
  const listEl = modal.querySelector(".ws-pkg-list");
  const refreshBtn = modal.querySelector(".ws-pkg-refresh");
  const closeBtn = modal.querySelector(".ws-pkg-close");
  input.focus();

  const refreshLoadedPackages = () => {
    const list = installedPackages();
    if (list.length) {
      listEl.textContent = list.join(", ");
    } else {
      listEl.textContent = "(none loaded yet — boots on first run)";
    }
  };

  refreshLoadedPackages();
  refreshBtn.addEventListener("click", refreshLoadedPackages);

  const doInstall = async () => {
    const pkg = input.value.trim();
    if (!pkg) return;
    installBtn.disabled = true;
    installBtn.textContent = "Installing…";
    statusEl.textContent = `Installing ${pkg}…`;
    statusEl.style.color = "var(--t3)";
    try {
      const res = await installPackage(pkg, { onStatus: s => { statusEl.textContent = s; } });
      if (res.ok) {
        statusEl.textContent = `✔ ${pkg} installed successfully!`;
        statusEl.style.color = "var(--ok)";
        input.value = "";
        pushConsole("info", `✔ Package ${pkg} installed`, "python");
        refreshLoadedPackages();
      } else {
        statusEl.textContent = `✖ ${res.error || "Installation failed"}`;
        statusEl.style.color = "var(--danger)";
      }
    } catch (e) {
      statusEl.textContent = `✖ ${String(e?.message || e)}`;
      statusEl.style.color = "var(--danger)";
    } finally {
      installBtn.disabled = false;
      installBtn.textContent = "Install";
      refreshLoadedPackages();
    }
  };

  installBtn.addEventListener("click", doInstall);
  input.addEventListener("keydown", e => { if (e.key === "Enter") doInstall(); });
  const close = () => modal.remove();
  closeBtn.addEventListener("click", close);
  modal.addEventListener("click", e => { if (e.target === modal) close(); });
}



// ---- Agent thread helpers ----

let userScrolledUp = false;

function autoScrollAgent(force = false) {
  const el = els.agentScroll;
  if (!el) return;
  if (force) {
    userScrolledUp = false;
    el.scrollTop = el.scrollHeight;
    return;
  }
  if (!userScrolledUp) {
    el.scrollTop = el.scrollHeight;
  }
}


function renderTaskList(tasks) {
  if (!els.taskList || !tasks || tasks.length === 0) return;
  els.taskList.hidden = false;
  const doneCount = tasks.filter(t => t.done).length;
  els.taskList.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; font-weight:600; color:var(--t2);">
      <span>📋 Plan (${doneCount}/${tasks.length})</span>
      <button class="ws-btn ghost tiny" style="padding:1px 5px; font-size:10px;" onclick="this.closest('.ws-task-list').hidden=true">×</button>
    </div>
    <div style="display:flex; flex-direction:column; gap:3px;">
      ${tasks.map(t => `<div style="display:flex; gap:6px; align-items:baseline; color:${t.done ? 'var(--ok)' : t.inProgress ? 'var(--accent)' : 'var(--t3)'}"><span>${t.done ? '✔' : t.inProgress ? '⏳' : '○'}</span><span style="${t.done ? 'text-decoration:line-through; opacity:0.8;' : ''}">${escapeHtml(t.title)}</span></div>`).join("")}
    </div>
  `;
}

function clearAgentThread() {
  els.agentThread.replaceChildren();
  if (els.taskList) {
    els.taskList.hidden = true;
    els.taskList.replaceChildren();
  }
  const e = document.createElement("div");
  e.className = "ws-empty";
  e.innerHTML = `Ask the agent to build, refactor, or fix.<br><br>Tools: <span class="mono">read_file · apply_patch · write_file · search · run</span>. Right-click a file → <b>Explain/Fix/Add</b> or type <span class="mono">@</span>.`;
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
  autoScrollAgent(role === "user");
  return bubble;
}

function appendInstructionCard(text, note, step) {
  els.agentThread.querySelector(".ws-empty")?.remove();
  const msg = document.createElement("div");
  msg.className = "msg environment";
  const label = document.createElement("div");
  label.className = "role";
  label.textContent = "Environment 🌐";
  const bubble = document.createElement("div");
  bubble.className = "bubble environment";
  bubble.innerHTML = `
    <details class="ws-instruction-details" open>
      <summary class="mono">⚙️ <b>Feedback / Instruction to Agent</b>${note ? ` <span style="color:var(--t4); font-size:10.5px">(${escapeHtml(note)})</span>` : ""}</summary>
      <div class="ws-instruction-body mono">${escapeHtml(text)}</div>
    </details>
  `;
  msg.append(label, bubble);
  els.agentThread.appendChild(msg);
  autoScrollAgent(false);
}

function appendToolCard(call, result) {
  const card = document.createElement("div");
  card.className = "ws-tool-card " + (result?.ok ? "ok" : "err");

  const pathLabel = call.args?.path || call.args?.filename || "";
  const head = document.createElement("div");
  head.className = "ws-tool-head mono";
  head.innerHTML = `<span>🔧 <b>${escapeHtml(call.name)}</b>${pathLabel ? ` <span style="color:var(--t1)">(${escapeHtml(pathLabel)})</span>` : ""}</span><span style="color:${result?.ok ? "var(--ok)" : "var(--danger)"}; font-weight:600">${result?.ok ? "✓ Success" : "✗ Error"}</span>`;

  card.appendChild(head);

  // If content or patch exists, show a collapsible preview
  const payload = call.args?.content ?? call.args?.patch ?? call.args?.code;
  if (payload != null && String(payload).length > 0) {
    const diff = document.createElement("details");
    diff.className = "ws-tool-diff";
    diff.innerHTML = `<summary class="mono">View payload (${String(payload).length} chars)</summary><pre class="mono"><code>${escapeHtml(String(payload))}</code></pre>`;
    card.appendChild(diff);
  } else if (call.args && Object.keys(call.args).length > 0) {
    const argsPre = document.createElement("pre");
    argsPre.className = "ws-tool-args mono";
    argsPre.textContent = JSON.stringify(call.args, null, 2);
    card.appendChild(argsPre);
  }

  if (result) {
    const out = document.createElement("pre");
    out.className = "ws-tool-out mono";
    out.textContent = result.output || (result.ok ? "Done" : "Failed");
    card.appendChild(out);
  }

  els.agentThread.querySelector(".ws-empty")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble assistant";
  bubble.appendChild(card);
  wrap.appendChild(bubble);
  els.agentThread.appendChild(wrap);
  autoScrollAgent(false);
  return card;
}



// ---- Permission UI ----

let _permResolver = null;

function showPermissionCard(call){
  // compute diff if patch/write
  let diffText = "";
  try {
    if (call.name==="apply_patch"){
      const cur = project.getContent(call.args.path) ?? "";
      diffText = call.args.patch || "";
    } else if (call.name==="write_file"){
      const cur = project.getContent(call.args.path);
      const next = String(call.args.content ?? "");
      if (cur != null) {
        const d = computeDiffPreview(cur, next);
        diffText = d.preview;
      } else {
        diffText = `New file ${call.args.path} (${next.length} chars)\n${next}`;
      }
    }
  } catch {}
  els.permTitle.textContent = `Allow ${call.name}?`;
  els.permBody.textContent = `${call.name}(${JSON.stringify(call.args)})`;
  if (diffText){
    els.permDiff.textContent = diffText;
    els.permDiff.hidden=false;

  } else els.permDiff.hidden=true;
  els.permissionCard.hidden=false;
  els.permissionCard.scrollIntoView({block:"nearest"});
  return new Promise(resolve=>{
    _permResolver = resolve;
  });
}

function hidePermissionCard(decision){
  els.permissionCard.hidden=true;
  if (_permResolver){ const r=_permResolver; _permResolver=null; r(decision); }
}

// ---- Undo ----

async function doUndo(){
  if (undoStack.length===0) return;
  const last = undoStack.pop();
  try {
    // restore before snapshot
    if (last.before){
      // clear then restore
      project.files.clear();
      for (const [k,v] of Object.entries(last.before)){
        project.files.set(k, {content: String(v), mtime: Date.now()});
      }
    }
    await saveProject(project);
    explorer.refresh();
    renderTabs();
    if (activePath && !project.has(activePath)){
      activePath = project.listPaths()[0] || null;
      if (activePath) await openFile(activePath);
      else if (editorCtrl) try{ editorCtrl.setValue("", "untitled.txt"); }catch{}
    } else if (activePath && editorCtrl){
      const disk = project.getContent(activePath) ?? "";
      if (editorCtrl.getValue() !== disk){
        editorSetting=true;
        try{ editorCtrl.setValue(disk, activePath); } finally { setTimeout(()=>editorSetting=false,0); }
      }
    }
    showAppToast(`Undid ${last.call?.name || "change"}`, "success");
    appendAgent("assistant", `_Undid \`${last.call?.name}\` on \`${last.call?.args?.path || ""}\` — restored previous version._`);
    updateUndoUI();
  } catch(e){ showAppToast("Undo failed: "+String(e), "error"); }
}

// ---- Send to harness ----

async function sendToAgent() {
  const rawText = els.agentInput.value.trim();
  if ((!rawText && attachments.length===0) || !modelService.ready || generating) return;
  // resolve @ mentions (also pushes attachments)
  resolveMentionsInText(rawText);
  // build task string plus attachments inline if any
  let taskWithAttachments = rawText;
  // if attachments exist, they will be passed as separate param to harness; but also
  // mention in text for visibility
  const attachNote = attachments.length ? `\n\n[Attached files: ${attachments.map(a=>`@${a.path}`).join(", ")}]` : "";
  if (attachNote) taskWithAttachments = (taskWithAttachments || "(no prompt — use attached context)") + attachNote;

  els.agentInput.value = "";
  hideMentionPop();
  autoGrowAgent();
  syncState();

  const displayText = rawText + (attachments.length? `\n\n> Attached: ${attachments.map(a=>`\`${a.path}\``).join(", ")}` : "");
  appendAgent("user", displayText || "(attached files)");

  const userMsg = { role: "user", content: taskWithAttachments };
  harnessMessages.push(userMsg);
  const thisAttachments = [...attachments];
  // keep attachments? Per request: attachments should stay until explicitly cleared or sent?
  // We'll clear after send but keep pills until next send? Clear now like pendingSelection old:
  // allow multi-turn with same attachments if user didn't clear? Let's clear for single-turn clarity:
  attachments = [];
  renderAttachments();
  // keep legacy single selection if exists for harness param
  const thisSelection = currentSelection;

  generating = true;
  abortController = new AbortController();
  els.agentStatus.textContent = "Agent thinking…";
  syncState();

  // streaming bubble for thinking
  let streamingBubble = null;
  let streamingDetails = null;

  const unlock = acquireLock("code");
  if (!unlock) {
    appendAgent("assistant", "_Another app is generating — try again shortly._");
    generating = false; syncState(); abortController = null; return;
  }

  // snapshot project before harness starts (for undo stack entry zero)
  const preRunSnap = {};
  for (const [k,v] of project.files) preRunSnap[k]=v.content;

  const executors = {
    writeFile: async (path, content) => {
      const p = normalizePathExport(path);
      project.set(p, content);
      await saveProject(project);
      explorer.refresh();
      renderTabs();
      if (p === activePath && editorCtrl) {
        const cur = editorCtrl.getValue();
        if (cur !== content) { editorSetting=true; try{ editorCtrl.setValue(content, p);} finally{ setTimeout(()=>editorSetting=false,0);} }
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

      if (!isPyodideLoaded()) {
        await loadPyodideRuntime({ onStatus: s => { els.agentStatus.textContent = s; } });
      }
      await syncFilesToPyFS(project);
      pythonLogs = [];
      const res = await runPython(code, {
        path: path || opts?.path || "",
        nonInteractive: Boolean(opts?.nonInteractive),
      });
      els.outConsole.replaceChildren();
      if (res.stdout) pushConsole("log", res.stdout, "python");
      if (res.stderr) pushConsole("warn", res.stderr, "python");
      if (res.error) pushConsole("error", res.error, "python");
      for (const png of res.plots ?? []) {
        const img = document.createElement("img"); img.className = "ws-plot"; img.src = png; els.outConsole.appendChild(img);
      }
      switchOut("console", "python");
      return res;
    },
    runWeb: async (entry) => {
      const e = entry || "index.html";
      let htmlPath = e;
      if (!project.has(htmlPath)) {
        const anyHtml = project.listPaths().find(p => /\.html?$/i.test(p));
        htmlPath = anyHtml || htmlPath;
      }
      const preview = runPreview(htmlPath);
      if (!preview?.ok) return preview || { ok: false, error: "Preview failed" };
      const previewResult = await preview.ready;
      const errorLines = webLogs
        .filter(entry => entry.level === "error" || /\[error\]|uncaught\s+\w*error/i.test(entry.text))
        .map(entry => `[${entry.level}] ${entry.text}`);
      const logs = webLogs.map(entry => `[${entry.level}] ${entry.text}`).join("\n").slice(0, 4000) || "(no console output yet)";
      if (errorLines.length > 0) {
        return { ok: false, error: errorLines.join("\n"), log: logs };
      }
      return { ok: true, log: logs, probe: previewResult?.probe ?? null };
    },
    installPackage: async (name) => {
      if (!isPyodideLoaded()) await loadPyodideRuntime({ onStatus: s => els.agentStatus.textContent = s });
      try {
        await installPackage(name, { onStatus: s => pushConsole("info", s, "python") });
        pushConsole("log", `✔ ${name} installed`, "python");
        return { ok: true, output: `${name} installed` };
      } catch (e) { pushConsole("error", String(e), "python"); return { ok: false, error: String(e) }; }
    },
    requestPermission: async (call) => {
      // if auto-approve toggled, this won't be called (permissionFor returns auto)
      // else show card
      const decision = await showPermissionCard(call);
      return decision; // allow, allow_always, deny
    },
  };

  let streamingThinkingEl = null;

  try {
    const result = await runHarness({
      project,
      task: taskWithAttachments,
      selection: thisSelection,
      attachments: thisAttachments,
      history: harnessMessages.slice(0, -1),
      signal: abortController.signal,
      maxSteps: 16,
      executors,
      onSnapshot: (snap) => {
        // push to undoStack (history stack)
        undoStack.push(snap);
        if (undoStack.length > 30) undoStack.shift();
        updateUndoUI();
      },
      onEvent: (evt) => {
        if (evt.type === "step") {
          els.agentStatus.textContent = `Step ${evt.step}/${evt.of} · cap ${(evt.contextLimit/1024).toFixed(0)}K · ${evt.ctxMeta?.mode || ""} · thinking…`;
        } else if (evt.type === "tasks") {
          renderTaskList(evt.tasks);
        } else if (evt.type === "instruction") {
          if (streamingThinkingEl) {
            const carets = streamingThinkingEl.querySelectorAll(".caret");
            carets.forEach(c => c.remove());
            streamingThinkingEl = null;
          }
          appendInstructionCard(evt.text, evt.note, evt.step);
        } else if (evt.type === "thinking_delta") {
          if (!streamingThinkingEl && (evt.thinkingText || evt.answerText)) {
            const msg = document.createElement("div");
            msg.className = "msg assistant";
            const label = document.createElement("div"); label.className="role"; label.textContent="Agent";
            const b = document.createElement("div"); b.className="bubble assistant";
            b.innerHTML = '<span class="thinking"><span></span><span></span><span></span></span>';
            msg.append(label, b);
            els.agentThread.querySelector(".ws-empty")?.remove();
            els.agentThread.appendChild(msg);
            autoScrollAgent(false);
            streamingThinkingEl = b;
          }
          if (streamingThinkingEl) {
            const thinking = cleanProse(String(evt.thinkingText || ""));
            const rawAnswer = String(evt.answerText || "");
            const answer = cleanProse(rawAnswer);
            let html = "";
            if (thinking) html += `<details class="thinking-block" open><summary>Thinking</summary><div class="thinking-body">${renderMarkdown(thinking)}</div></details>`;
            if (answer) html += renderMarkdown(answer);
            if (!thinking && !answer) html = '<span class="thinking"><span></span><span></span><span></span></span>';
            streamingThinkingEl.innerHTML = html + '<span class="caret"></span>';
            autoScrollAgent(false);
          }
        } else if (evt.type === "tool_call") {
          if (streamingThinkingEl) {
            const carets = streamingThinkingEl.querySelectorAll(".caret");
            carets.forEach(c => c.remove());
            if (streamingThinkingEl.textContent.trim().length < 10) {
              streamingThinkingEl.closest(".msg")?.remove();
            }
          }
          streamingThinkingEl = null;
          els.agentStatus.textContent = `Running ${evt.call.name}…`;
        } else if (evt.type === "tool_result") {
          if (streamingThinkingEl) {
            const carets = streamingThinkingEl.querySelectorAll(".caret");
            carets.forEach(c => c.remove());
          }
          streamingThinkingEl = null;
          appendToolCard(evt.call, evt.result);
        } else if (evt.type === "model_raw") {
          if (evt.thinking && !streamingThinkingEl) {
            const t = document.createElement("details");
            t.className = "thinking-block";
            t.open = true;
            t.innerHTML = `<summary>Thinking</summary><div class="thinking-body">${renderMarkdown(cleanProse(evt.thinking))}</div>`;
            const msg = document.createElement("div");
            msg.className = "msg assistant";
            const b = document.createElement("div"); b.className = "bubble assistant"; b.appendChild(t);
            msg.appendChild(b); els.agentThread.appendChild(msg);
          }
          if (streamingThinkingEl) {
            const carets = streamingThinkingEl.querySelectorAll(".caret");
            carets.forEach(c => c.remove());
          }
          streamingThinkingEl = null;
        } else if (evt.type === "answer") {
          const cleanAns = cleanProse(evt.answer);
          if (streamingThinkingEl) {
            const carets = streamingThinkingEl.querySelectorAll(".caret");
            carets.forEach(c => c.remove());
            if (cleanAns) {
              streamingThinkingEl.innerHTML = renderMarkdown(cleanAns);
            } else if (streamingThinkingEl.textContent.trim().length < 10) {
              streamingThinkingEl.closest(".msg")?.remove();
            }
            streamingThinkingEl = null;
          } else if (cleanAns) {
            appendAgent("assistant", cleanAns);
          }
        } else if (evt.type === "compact") {
          appendAgent("assistant", `_Context compaction: ${evt.note}_`);
        } else if (evt.type === "loop_break") {
          appendAgent("assistant", `_Loop guard: ${evt.note}_`);
        } else if (evt.type === "nudge") {
          if (evt.text) appendInstructionCard(evt.text, evt.note, evt.step);
        }
        autoScrollAgent(false);
      },



    });

    if (result.ok) {
      els.agentStatus.textContent = "Done.";
      harnessMessages.push({ role: "assistant", content: result.answer || "(completed)" });
    } else if (result.aborted || abortController?.signal?.aborted) {
      els.agentStatus.textContent = "Stopped.";
      if (streamingThinkingEl) {
        const carets = streamingThinkingEl.querySelectorAll(".caret");
        carets.forEach(c => c.remove());
        if (streamingThinkingEl.textContent.trim().length < 10) {
          streamingThinkingEl.closest(".msg")?.remove();
        }
        streamingThinkingEl = null;
      }
    } else {
      els.agentStatus.textContent = result.error ? "Stopped." : "Finished (max steps).";
      if (result.answer) {
        appendAgent("assistant", result.answer);
        harnessMessages.push({ role: "assistant", content: result.answer });
      } else if (!result.error) {
        appendAgent("assistant", "_Reached max steps without final answer. Try a more specific prompt or increase steps._");
      }
    }
    await saveProject(project);
    explorer.refresh();
    renderTabs();
    if (activePath && project.has(activePath)) {
      const disk = project.getContent(activePath) ?? "";
      if (editorCtrl && editorCtrl.getValue() !== disk) {
        els.agentStatus.textContent += " · File changed — reload if needed.";
      }
    }
    updateUndoUI();
  } catch (err) {
    const isAborted = abortController?.signal?.aborted || err?.name === "AbortError" || String(err?.message || "").includes("aborted");
    if (!isAborted) {
      console.error(err);
      appendAgent("assistant", `⚠ ${escapeHtml(String(err?.message ?? err))}`);
      els.agentStatus.textContent = "Error.";
    } else {
      els.agentStatus.textContent = "Stopped.";
      if (streamingThinkingEl) {
        const carets = streamingThinkingEl.querySelectorAll(".caret");
        carets.forEach(c => c.remove());
        if (streamingThinkingEl.textContent.trim().length < 10) {
          streamingThinkingEl.closest(".msg")?.remove();
        }
        streamingThinkingEl = null;
      }
    }
  } finally {
    unlock();
    generating = false;
    abortController = null;
    hidePermissionCard("deny"); // close if open
    streamingThinkingEl = null;
    syncState();
  }

}
