// Code workstation — Explorer + CodeMirror + file-aware chat.
// Chat is read-only Q&A over project files: @-mentions, attachments,
// editor selections and explorer quick actions feed file context into the
// prompt. Suggested code is copied manually via per-snippet Copy buttons.
// Explorer right-click → Explain/Review/Add; @-mentions autocomplete.

import { modelService } from "../../src/services/model-service.js";
import { acquireLock, streamGeneration } from "../../src/services/generation.js";
import { createChatThread } from "../../src/lib/chat-thread.js";
import { loadProject, saveProject, resetProject, normalizePathExport, dirname, basename } from "../../src/services/code-project.js";
import { createEditor } from "./components/editor-cm.js";
import { createExplorer } from "./components/explorer.js";
import {
  loadPyodideRuntime, runPython, isPyodideLoaded,
  syncFilesToPyFS, stopPython, queueStdin, installedPackages
} from "./runners/pyodide-runner.js";
import {
  bundledPackages, installBundledPackage, installPackagePreferred, ensureBundledImports,
  prepareOfflineStack
} from "./runners/python-packages.js";
import { WebRunner } from "./runners/web-runner.js";
import { getContextLimitPreference, setContextLimitPreference, selectedContextLimit, onContextLimitChange } from "../../src/services/context-preference.js";
import { getThinking, setThinking, thinkMessages } from "../../src/services/settings.js";


let els = {};
let project = null;
let explorer = null;
let editorCtrl = null;
let activePath = null;
let openTabs = [];
// Attachments: array of {path,text} from selections, @-mentions, file Add-to-Chat
let attachments = [];
let pendingImage = null;
let pendingImageRead = 0;
let currentSelection = null; // live selection {text,path,from,to}
let generating = false;
let abortController = null;
let unsubModel = null;
let unsubContext = null;
let runner = null;
let saveDebounce = 0;
// Single console buffer shared by the Python runtime and the web preview.
// Entries are {level, text, source} — source is "python" | "web".
let consoleLogs = [];
let outCollapsed = false;
let editorSetting = false;
let mentionState = null; // {query, start, end}
let chatHistory = [];
let chatThreadView = null;
// HTML file currently rendered in the preview pane (null until first run).
let previewEntry = null;
const OUT_HEIGHT_KEY = "ws-code-out-height";
const OUT_COLLAPSED_KEY = "ws-code-out-collapsed";
// Set while a Python run is in flight. If it is still present on the next load,
// the previous run never returned — i.e. it froze the tab and had to be killed.
const RUN_PENDING_KEY = "ws-code-run-pending";
const CODE_MIN_CONTEXT_TOKENS = 32_768;
// Max chars per attached file sent to the model (head-truncated with notice).
const MAX_ATTACH_CHARS = 12_000;
const MAX_ATTACHMENTS = 8;

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
    consoleLogs = [];
    previewEntry = null;
    chatHistory = [];
    attachments = [];
    pendingImage = null;
    pendingImageRead = 0;
    mentionState = null;
    buildDom(container);
    runner = new WebRunner(els.previewFrame, { onConsole: (level, text) => pushConsole(level, text, "web") });
    unsubModel = modelService.subscribe(() => syncState());
    unsubContext = onContextLimitChange(() => syncState());

    project = await loadProject();
    explorer = createExplorer({
      container: els.explorer,
      project,
      onOpenFile: (p) => openFile(p),
      onAskChat: (path, kind) => handleAskChatFromExplorer(path, kind),
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
        if (autoRun) autoRefreshPreview();
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
          chatHistory = [];
          attachments = [];
          clearPendingImage();
          currentSelection = null;
          clearChatThread();
          renderAttachments();
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
          if (autoRun) autoRefreshPreview();
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
    if (autoRun) autoRefreshPreview();

    // If a previous Python run never returned, the tab was frozen and reloaded.
    // Say so, instead of leaving the user wondering why the app "just broke".
    try {
      const pending = localStorage.getItem(RUN_PENDING_KEY);
      if (pending) {
        localStorage.removeItem(RUN_PENDING_KEY);
        const mins = Math.max(1, Math.round((Date.now() - Number(pending)) / 60000));
        pushConsole("warn", `A previous Python run did not finish (~${mins} min ago). An endless loop blocks the browser main thread, so the tab had to be reloaded.`, "python");
        showAppToast("Previous Python run didn't finish — an endless loop freezes the tab", "error");
      }
    } catch {}
  },

  unmount() {
    abortController?.abort();
    unsubModel?.(); unsubModel = null;
    unsubContext?.(); unsubContext = null;
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
            <pre class="ws-console mono" data-role="console" style="flex:1; margin:0" tabindex="0" title="Click here or the input bar below to send input to Python"></pre>
            <div class="ws-console-input-row mono" data-role="consoleInputRow" style="display:flex; align-items:center; gap:6px; padding:4px 8px; border-top:1px solid var(--line-soft); background:rgba(0,0,0,0.15)">

              <label class="mono" style="display:flex; align-items:center; gap:4px; font-size:11px; color:var(--t3); cursor:pointer; user-select:none" title="When enabled, printable keypresses are sent directly to Python stdin in real-time">
                <input type="checkbox" data-role="liveKeysToggle" style="margin:0; cursor:pointer;" checked />
                <span>Live input</span>
              </label>
              <input type="text" class="ws-console-input mono" data-role="consoleInput" placeholder="Send input to Python stdin..." style="flex:1; background:transparent; border:none; outline:none; color:var(--t1); font-size:12px;" />
              <button class="ws-btn ghost tiny" data-role="sendConsoleInput">Send</button>
            </div>
          </div>
          <div class="ws-preview-view" data-role="previewView" hidden>
            <iframe class="ws-preview-frame" data-role="previewFrame" sandbox="allow-scripts allow-modals" hidden></iframe>
          </div>
        </div>
      </section>
      <div class="ws-resizer-agent" data-role="chatResizer" title="Drag to resize Chat panel — double-click to reset"></div>
      <section class="ws-pane ws-code-agent ws-pane-right" data-role="chatPane">

        <div class="ws-pane-head">
          <h3 style="font-size:12px; font-weight:600; color:var(--t2);">Chat with files</h3>
          <div style="display:flex; gap:6px; align-items:center;">
            <button class="ws-btn ghost tiny" data-role="newChat" title="Start a new chat (clears history and attachments)">New</button>
            <button class="ws-btn ghost tiny ws-chat-clear" data-role="clearChat" aria-label="Clear chat" title="Clear chat">× Clear</button>
          </div>
        </div>
        <div class="ws-right-panel" data-role="chatPanel">
        <div class="ws-thread-scroll" data-role="chatScroll"><div class="ws-thread" data-role="chatThread">
          <div class="ws-empty">Ask about your project files.<br><br>
          Tip: Right-click a file → <b>Explain / Review / Add to Chat</b>, type <span class="mono">@</span> to mention files, or select code → <b>Add selection</b>.<br><br>
          <span class="mono" style="font-size:11px; color:var(--t4)">Chat is read-only — it never edits files. Copy a suggested snippet and paste it into the editor yourself.</span></div>
        </div></div>
        <div class="ws-attachments" data-role="attachmentsBar" hidden>
          <div class="ws-attachments-head mono">Attachments (<span data-role="attachCount">0</span>) <button class="ws-btn ghost tiny" data-role="clearAllAttach">Clear all</button></div>
          <div class="ws-attachments-list" data-role="attachmentsList"></div>
        </div>
        <div class="ws-agent-selection" data-role="selectionBar" hidden>
          <div class="ws-selection-chip mono"><span data-role="selLabel"></span><button class="ws-btn ghost tiny" data-role="attachSel">Add selection</button><button class="ws-btn ghost tiny" data-role="clearSel">×</button></div>
          <pre class="ws-selection-preview mono" data-role="selPreview"></pre>
        </div>
        <div class="ws-agent-context mono" data-role="chatContext" title="Attached file context (based on top-bar cap + model limits)"></div>
        <div class="ws-image-attachment" data-role="chatImageAttachment" hidden></div>
        <footer class="ws-composer" style="position:relative">
          <textarea data-role="chatInput" rows="2" placeholder="Load the model first, then ask about your files… (use @ to mention files; paste an image)"></textarea>
          <div class="ws-mention-pop" data-role="mentionPop" hidden></div>
          <button class="ws-btn primary small" data-role="sendChat" disabled>Send</button>
          <button class="ws-btn danger small" data-role="stopChat" hidden>Stop</button>
        </footer>
        <div class="ws-agent-status mono" data-role="chatStatus"></div>
        </div>
      </section>
    </div>
  `;
  root.replaceChildren(wrap);

  Object.assign(els, {
    root: wrap,
    codeLayout: wrap.querySelector('[data-role="codeLayout"]'),
    chatResizer: wrap.querySelector('[data-role="chatResizer"]'),
    chatPane: wrap.querySelector('[data-role="chatPane"]'),
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
    mentionPop: wrap.querySelector('[data-role="mentionPop"]'),
    newChat: wrap.querySelector('[data-role="newChat"]'),
    chatPanel: wrap.querySelector('[data-role="chatPanel"]'),
    chatScroll: wrap.querySelector('[data-role="chatScroll"]'),
    chatThread: wrap.querySelector('[data-role="chatThread"]'),
    chatInput: wrap.querySelector('[data-role="chatInput"]'),
    sendChat: wrap.querySelector('[data-role="sendChat"]'),
    stopChat: wrap.querySelector('[data-role="stopChat"]'),
    clearChat: wrap.querySelector('[data-role="clearChat"]'),
    chatStatus: wrap.querySelector('[data-role="chatStatus"]'),
    attachmentsBar: wrap.querySelector('[data-role="attachmentsBar"]'),
    attachmentsList: wrap.querySelector('[data-role="attachmentsList"]'),
    attachCount: wrap.querySelector('[data-role="attachCount"]'),
    clearAllAttach: wrap.querySelector('[data-role="clearAllAttach"]'),
    selectionBar: wrap.querySelector('[data-role="selectionBar"]'),
    selLabel: wrap.querySelector('[data-role="selLabel"]'),
    selPreview: wrap.querySelector('[data-role="selPreview"]'),
    attachSel: wrap.querySelector('[data-role="attachSel"]'),
    clearSel: wrap.querySelector('[data-role="clearSel"]'),
    chatContext: wrap.querySelector('[data-role="chatContext"]'),
    chatImageAttachment: wrap.querySelector('[data-role="chatImageAttachment"]'),
  });


  chatThreadView = createChatThread({ scrollEl: els.chatScroll, threadEl: els.chatThread, userLabel: "You", assistantLabel: "Gemma" });
  decorateChatThreadCopy();

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
    queueStdin(key);
    pushConsole("info", `[stdin key] ${key}`, "python");
  };

  const handleKeydownCapture = (e) => {
    if (e.key === "Enter") {
      if (els.consoleInput.value.trim() !== "") {
        e.preventDefault();
        handleConsoleInput();
      }
      return;
    }

    // In live input mode, capture single printable keys.
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
    consoleLogs = [];
    els.outConsole.replaceChildren();
  });
  els.outTabs.forEach(t => t.addEventListener("click", () => switchOut(t.dataset.out)));


  // chat composer
  els.sendChat.addEventListener("click", () => sendToChat());
  els.stopChat.addEventListener("click", () => abortController?.abort());
  els.clearChat.addEventListener("click", () => {
    abortController?.abort();
    clearChatThread();
    els.chatStatus.textContent = "Chat history cleared.";
    els.sendChat.disabled = !modelService.ready;
  });
  els.newChat?.addEventListener("click", () => {
    abortController?.abort();
    clearChatThread();
    attachments = [];
    clearPendingImage();
    renderAttachments();
    els.chatInput.value = "";
    hideMentionPop();
    autoGrowChat();
    els.chatStatus.textContent = "New chat — history and attachments cleared.";
    syncState();
  });
  els.chatInput.addEventListener("keydown", (e) => {
    if (handleMentionKeydown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!els.sendChat.disabled) sendToChat(); }
  });
  els.chatInput.addEventListener("input", () => { syncState(); autoGrowChat(); handleMentionInput(); });
  els.chatInput.addEventListener("paste", handleImagePaste);
  els.chatInput.addEventListener("blur", () => setTimeout(hideMentionPop, 150));
  els.chatInput.addEventListener("click", () => handleMentionInput());
  els.clearAllAttach.addEventListener("click", () => { attachments = []; clearPendingImage(); renderAttachments(); syncState(); });
  els.attachSel.addEventListener("click", () => {
    if (currentSelection?.text) {
      addAttachment({ path: currentSelection.path, text: currentSelection.text });
      els.chatInput.focus();
    }
  });
  els.clearSel.addEventListener("click", () => {
    if (attachments.length) { /* handled via pills */ }
    else { currentSelection = null; els.selectionBar.hidden = true; }
    // clear selection preview if no attachments pending
    if (!currentSelection) els.selectionBar.hidden = true;
  });

  // selection bar initially hidden
  renderAttachments();
  renderPendingImage();
  autoGrowChat();

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

  // ----- chat column resizer -----
  if (els.chatResizer && els.codeLayout && els.chatPane) {
    const CHAT_WIDTH_KEY = "gemma_chat_col_width";
    try {
      const savedW = Number(localStorage.getItem(CHAT_WIDTH_KEY));
      if (Number.isFinite(savedW) && savedW >= 240 && savedW <= window.innerWidth * 0.75) {
        els.codeLayout.style.setProperty("--agent-width", `${savedW}px`);
      }
    } catch {}

    let draggingChat = false;
    let startX = 0;
    let startW = 400;

    const onChatMove = (e) => {
      if (!draggingChat) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const dx = startX - clientX;
      const newW = Math.max(260, Math.min(window.innerWidth * 0.7, startW + dx));
      els.codeLayout.style.setProperty("--agent-width", `${Math.round(newW)}px`);
    };

    const onChatUp = () => {
      if (!draggingChat) return;
      draggingChat = false;
      els.chatResizer.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onChatMove);
      window.removeEventListener("mouseup", onChatUp);
      window.removeEventListener("touchmove", onChatMove);
      window.removeEventListener("touchend", onChatUp);
      const curW = parseInt(els.codeLayout.style.getPropertyValue("--agent-width") || "400", 10);
      if (curW) {
        try { localStorage.setItem(CHAT_WIDTH_KEY, String(curW)); } catch {}
      }
      if (editorCtrl) try { editorCtrl.view.requestMeasure(); } catch {}
    };

    const onChatDown = (e) => {
      e.preventDefault();
      draggingChat = true;
      startX = e.touches ? e.touches[0].clientX : e.clientX;
      startW = els.chatPane.offsetWidth || 400;
      els.chatResizer.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onChatMove);
      window.addEventListener("mouseup", onChatUp);
      window.addEventListener("touchmove", onChatMove, { passive: false });
      window.addEventListener("touchend", onChatUp);
    };

    els.chatResizer.addEventListener("mousedown", onChatDown);
    els.chatResizer.addEventListener("touchstart", onChatDown, { passive: false });
    els.chatResizer.addEventListener("dblclick", () => {
      els.codeLayout.style.setProperty("--agent-width", "400px");
      try { localStorage.setItem(CHAT_WIDTH_KEY, "400"); } catch {}
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

function autoGrowChat() {
  if (!els.chatInput) return;
  els.chatInput.style.height = "auto";
  els.chatInput.style.height = Math.min(els.chatInput.scrollHeight, 140) + "px";
}

let autoRun = true;

// Which runtime a file belongs to. Only files that are directly runnable get a
// runner: Python scripts run in Pyodide, HTML documents render in the preview.
// Everything else (CSS, JS, Markdown, …) is edited, not "run".
function runnerForPath(path) {
  const low = String(path || "").toLowerCase();
  if (low.endsWith(".py") || low.endsWith(".pyw")) return "python";
  if (low.endsWith(".html") || low.endsWith(".htm")) return "web";
  return "none";
}

// True when `path` is referenced (src/href) by the HTML currently in the preview
// pane. Lets a stylesheet/script update the page it belongs to without ever
// switching the preview to a different entry file.
function isDependencyOfEntry(path) {
  if (!previewEntry || !path || !project?.has(previewEntry)) return false;
  const html = project.getContent(previewEntry) ?? "";
  const want = basename(path).toLowerCase();
  const refRe = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const m of html.matchAll(refRe)) {
    const ref = String(m[1] || "").split(/[?#]/)[0];
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(ref) || /^[a-z][a-z0-9+.-]*:/i.test(ref)) continue;
    if (basename(ref.replace(/^\.\//, "")).toLowerCase() === want) return true;
  }
  return false;
}

// Refresh after an edit. Re-renders the active HTML file, or — when the edited
// file is an asset of the page already on screen — re-renders that same page.
// Never silently previews an unrelated entry file.
function autoRefreshPreview() {
  if (!activePath) return false;
  if (runnerForPath(activePath) === "web") {
    runPreview(activePath);
    return true;
  }
  if (previewEntry && project?.has(previewEntry) && isDependencyOfEntry(activePath)) {
    runPreview(previewEntry);
    return true;
  }
  return false;
}

function syncState() {
  const ready = modelService.ready;
  if (!els.chatInput || !els.sendChat) return;
  const hasText = !!els.chatInput.value.trim() || !!pendingImage || attachments.length > 0;
  els.sendChat.disabled = !ready || generating || !hasText;
  els.chatInput.placeholder = !ready
    ? "Load the model to start chatting… (use @ to mention files; paste an image)"
    : activePath
      ? `Ask about ${activePath}… (@ to mention; paste an image)`
      : "Ask about your files… (@ to mention files; paste an image)";
  // Run button state is managed by refreshBottomBar (file-type derived); just handle generating lock
  if (generating && els.runBtn) els.runBtn.disabled = true;
  else refreshBottomBar();
  if (els.chatContext) {
    const arch = Number(modelService.capabilities?.architecturalMax) || 131072;
    const eff = Number(modelService.capabilities?.effectiveContextMax) || arch;
    const capPref = getContextLimitPreference();
    const cap = capPref === "auto" ? arch : Math.min(arch, Number(capPref));
    const effCapped = Math.min(eff, cap);
    const stats = project?.getStats();
    const approxTokens = stats ? Math.ceil(stats.totalChars * 0.25) : 0;
    const label = capPref === "auto" ? "Auto" : `${(cap/1024).toFixed(0)}K`;
    els.chatContext.textContent = `Files ~${approxTokens.toLocaleString()} tokens · cap ${label} · effective ${(effCapped/1024).toFixed(0)}K${attachments.length ? ` · ${attachments.length} attached` : ""}`;
  }
  els.stopChat.hidden = !generating;
  els.sendChat.hidden = generating;
  els.chatInput.disabled = !ready || generating;
}

function handleImagePaste(event) {
  const items = [...(event.clipboardData?.items || [])];
  const imageItem = items.find(item => item.kind === "file" && item.type?.startsWith("image/"));
  const imageFile = imageItem?.getAsFile?.() || [...(event.clipboardData?.files || [])]
    .find(file => file.type?.startsWith("image/"));
  if (!imageFile) return;
  event.preventDefault();
  stagePendingImage(imageFile);
}

function stagePendingImage(file) {
  if (!file?.type?.startsWith("image/")) return;
  const readId = ++pendingImageRead;
  const reader = new FileReader();
  reader.onload = () => {
    if (readId !== pendingImageRead) return;
    pendingImage = { url: String(reader.result), name: file.name || "pasted image" };
    renderPendingImage();
    syncState();
    showAppToast("Image attached", "success");
  };
  reader.onerror = () => {
    if (readId === pendingImageRead) showAppToast("Could not read pasted image", "error");
  };
  reader.readAsDataURL(file);
}

function clearPendingImage() {
  pendingImageRead += 1;
  pendingImage = null;
  renderPendingImage();
  syncState();
}

function renderPendingImage() {
  const host = els.chatImageAttachment;
  if (!host) return;
  host.replaceChildren();
  host.hidden = !pendingImage;
  if (!pendingImage) return;
  const chip = document.createElement("div");
  chip.className = "ws-image-chip";
  const img = document.createElement("img");
  img.src = pendingImage.url;
  img.alt = "";
  const name = document.createElement("span");
  name.textContent = pendingImage.name || "pasted image";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ws-btn ghost tiny";
  remove.textContent = "×";
  remove.title = "Remove image";
  remove.addEventListener("click", clearPendingImage);
  chip.append(img, name, remove);
  host.appendChild(chip);
}

// ---- Attachments ----

function addAttachment({path, text}){
  const norm = normalizePathExport(path);
  const content = String(text ?? project.getContent(norm) ?? "");
  if (!norm || !content) { showAppToast(`No content for ${path}`, "error"); return; }
  // dedup
  if (attachments.some(a=>a.path===norm)) { showAppToast(`Already attached: ${norm}`, "info"); return; }
  // cap
  if (attachments.length >= MAX_ATTACHMENTS) { showAppToast(`Max ${MAX_ATTACHMENTS} attachments — remove one first`, "error"); return; }
  attachments.push({path: norm, text: content});
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
  const input = els.chatInput;
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
  const input = els.chatInput;
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
  autoGrowChat();
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
      // silently attach (cap MAX_ATTACHMENTS)
      if(attachments.length<MAX_ATTACHMENTS){
        const content=project.getContent(p) ?? "";
        if(content) attachments.push({path:p, text: content});
      }
    }
  }
}

function handleAskChatFromExplorer(path, kind){
  const promptMap={
    explain: `Explain what @${path} does. Include key functions and how it interacts with other files.`,
    fix: `Review @${path} for bugs and suggest specific fixes with corrected code snippets. I will apply the changes myself.`,
    explain_folder: `Explain the purpose of the folder @${path} and how its files work together.`
  };
  const text=promptMap[kind] || `Help with @${path}`;
  // attach
  handleAttachFile(path);
  els.chatInput.value=text;
  syncState(); autoGrowChat();
  els.chatInput.focus();
  // flash
  els.chatInput.animate([{outline:"2px solid rgba(100,255,160,0.4)"},{outline:"2px solid transparent"}], {duration:400});
}

// ---- Editor handling ----

async function ensureEditor() {
  if (editorCtrl) return editorCtrl;
  const opts = {
    value: "",
    path: activePath || "untitled.txt",
    onChange: (text) => {
      if (editorSetting) return;
      if (!activePath) return;
      try { project.set(activePath, text); } catch (e) { console.warn(e); }
      clearTimeout(saveDebounce);
      saveDebounce = setTimeout(() => saveProject(project).catch(()=>{}), 550);
      if (autoRun) {
        clearTimeout(editorCtrl._autoRunTimer);
        editorCtrl._autoRunTimer = setTimeout(() => autoRefreshPreview(), 750);
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
  };
  try {
    editorCtrl = await createEditor(els.editorHost, opts);
  } catch (err) {
    console.warn("[code] CodeMirror failed — using plain-text fallback editor", err);
    showAppToast("Syntax editor failed to load — using plain text mode", "error");
    editorCtrl = createFallbackEditor(els.editorHost, opts);
  }
  return editorCtrl;
}

// Plain-textarea stand-in with the same controller surface as the CodeMirror
// wrapper. Keeps editing, selection-attach, and runners working when the
// CodeMirror CDN fails (e.g. duplicate @codemirror/state instances).
function createFallbackEditor(container, { value = "", onChange, onSelection } = {}) {
  container.replaceChildren();
  const ta = document.createElement("textarea");
  ta.className = "ws-fallback-editor mono";
  ta.value = String(value ?? "");
  ta.spellcheck = false;
  ta.setAttribute("aria-label", "File editor (plain text fallback)");
  ta.style.cssText = "width:100%;height:100%;min-height:200px;resize:none;background:rgba(255,255,255,.015);border:0;outline:none;color:var(--t1);font-size:13px;line-height:1.6;padding:10px 12px;";
  container.appendChild(ta);
  const emitSelection = () => {
    const s = ta.selectionStart ?? 0, e = ta.selectionEnd ?? 0;
    if (e > s) onSelection?.({ text: ta.value.slice(s, e), from: s, to: e, empty: false });
    else onSelection?.({ text: "", from: s, to: e, empty: true });
  };
  let selTimer = 0;
  ta.addEventListener("input", () => {
    onChange?.(ta.value);
    clearTimeout(selTimer);
    selTimer = setTimeout(emitSelection, 300);
  });
  ta.addEventListener("select", emitSelection);
  ta.addEventListener("keyup", emitSelection);
  return {
    view: { requestMeasure() {} },
    getValue() { return ta.value; },
    setValue(text) {
      const t = String(text ?? "");
      if (ta.value !== t) ta.value = t;
    },
    setLanguage() {},
    focus() { try { ta.focus(); } catch {} },
    getSelection() {
      const s = ta.selectionStart ?? 0, e = ta.selectionEnd ?? 0;
      return { text: e > s ? ta.value.slice(s, e) : "", from: s, to: e, empty: e <= s };
    },
    setSelection(from, to) { try { ta.setSelectionRange(from, to); ta.focus(); } catch {} },
    insertAtCursor(snippet) {
      const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
      const next = ta.value.slice(0, s) + String(snippet ?? "") + ta.value.slice(e);
      ta.value = next;
      try { ta.setSelectionRange(s + String(snippet ?? "").length, s + String(snippet ?? "").length); } catch {}
      onChange?.(ta.value);
      ta.focus();
    },
    replaceRange(from, to, text) {
      ta.value = ta.value.slice(0, from) + String(text ?? "") + ta.value.slice(to);
      onChange?.(ta.value);
    },
    destroy() { clearTimeout(selTimer); ta.remove(); },
  };
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
  // An editor failure (e.g. a syntax-highlighter crash) must never stop the
  // file from opening or the bottom pane from switching to the right runner.
  const ctrl = await ensureEditor();
  const content = project.getContent(p) ?? "";
  editorSetting = true;
  try {
    ctrl.setValue(content, p);
  } catch (err) {
    console.warn("[code] editor update failed for", p, err);
  } finally {
    setTimeout(() => { editorSetting = false; }, 0);
  }
  try { ctrl.focus(); } catch {}
  syncState();
  explorer.setSelected(p);
  const mode = runnerForPath(p);
  if (mode === "web") switchOut("preview");
  else if (mode === "python") switchOut("console");
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

const MAX_CONSOLE_LINES = 600;

function refreshBottomBar() {
  const runner = runnerForPath(activePath);
  const isPython = runner === "python";
  const isWeb = runner === "web";

  if (els.runBtn) {
    if (isPython) {
      els.runBtn.textContent = "▶ Run Python";
      els.runBtn.title = "Run the active Python file in Pyodide";
      els.runBtn.disabled = generating ? true : false;
    } else if (isWeb) {
      els.runBtn.textContent = "🔄 Refresh Preview";
      els.runBtn.title = `Render ${basename(activePath)} in the sandboxed preview`;
      els.runBtn.disabled = generating ? true : false;
    } else {
      els.runBtn.textContent = "▶ Run";
      els.runBtn.title = activePath
        ? `${basename(activePath)} has no runner — open a .py or .html file`
        : "Open a file to run";
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
    else els.runStatus.textContent = "No runner";
  }
}

function switchOut(which) {
  currentRunnerMode = which;
  ensureOutExpanded();
  els.outTabs.forEach(t => t.classList.toggle("active", t.dataset.out === which));
  const isConsole = which === "console";
  if (els.consoleContainer) els.consoleContainer.hidden = !isConsole;
  if (els.previewView) els.previewView.hidden = isConsole;
  if (els.previewFrame) els.previewFrame.hidden = isConsole;
  if (isConsole) renderConsole();
  refreshBottomBar();
}

// The Console tab is the single home for runtime output — Python stdout/stderr
// and web preview console.* both land here.
function renderConsole() {
  if (!els.outConsole) return;
  els.outConsole.replaceChildren();
  for (const entry of consoleLogs) els.outConsole.appendChild(consoleLine(entry));
  try { els.outConsole.scrollTop = els.outConsole.scrollHeight; } catch {}
}

function consoleLine(entry) {
  const line = document.createElement("div");
  line.className = `ws-console-line ${entry.level} ws-console-${entry.source}`;
  line.textContent = `[${entry.level}] ${entry.text}`;
  return line;
}

function pushConsole(level, text, source) {
  const src = source || (runnerForPath(activePath) === "web" ? "web" : "python");
  const entry = { level, text, source: src };
  consoleLogs.push(entry);
  if (consoleLogs.length > MAX_CONSOLE_LINES) consoleLogs.splice(0, consoleLogs.length - MAX_CONSOLE_LINES);
  // Web logs must never steal focus from what the user is doing; they simply
  // accumulate in the Console tab.
  if (!els.outConsole || currentRunnerMode !== "console") return;
  if (outCollapsed) ensureOutExpanded();
  els.outConsole.appendChild(consoleLine(entry));
  try { els.outConsole.scrollTop = els.outConsole.scrollHeight; } catch {}
}

async function runActive() {
  if (!activePath) {
    pushConsole("info", "No active file selected — open a file first.", "python");
    return;
  }
  const runner = runnerForPath(activePath);
  if (runner === "python") {
    switchOut("console");
    await runPythonFile(activePath);
  } else if (runner === "web") {
    runPreview(activePath);
  } else {
    pushConsole("info", `No runner for ${activePath} — open a .py or .html file.`, "python");
  }
}


async function runPythonFile(path) {
  ensureOutExpanded();
  switchOut("console");
  const code = project.getContent(path) ?? "";
  els.outConsole.replaceChildren();
  consoleLogs = [];
  pushConsole("info", `▶ python ${path}`, "python");

  // Pyodide executes on the browser main thread, so an endless loop blocks
  // rendering *and* the Stop button — the tab can only be recovered by closing
  // it. Warn before that happens rather than after.
  if (/^\s*while\s+True\s*:/m.test(code) && !/\bbreak\b/.test(code)) {
    pushConsole("warn", "This script has an unbounded `while True:` loop with no `break`. Python runs on the main thread, so an endless run will freeze this tab and need a reload — use a counter or `break` to bound it.", "python");
    showAppToast("Warning: unbounded `while True:` loop — an endless run will freeze the tab", "error");
  }
  try { localStorage.setItem(RUN_PENDING_KEY, String(Date.now())); } catch {}

  if (els.stopPyBtn) els.stopPyBtn.hidden = false;
  if (els.runBtn) els.runBtn.hidden = true;

  try {
    if (!isPyodideLoaded()) {
      pushConsole("info", "Booting Python runtime...", "python");
      await loadPyodideRuntime({ onStatus: s => pushConsole("info", s, "python") });
    }
    // Packages vendored under vendor/python-packages install from disk, so a
    // script that imports e.g. rich/networkx runs even with no network.
    try {
      const bundled = await ensureBundledImports(code, { onStatus: s => pushConsole("info", s, "python") });
      if (bundled.length) pushConsole("info", `Offline bundle: ${bundled.join(", ")}`, "python");
    } catch (err) {
      console.warn("[code] offline bundle check failed", err);
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
    // The run returned, so the tab is healthy again.
    try { localStorage.removeItem(RUN_PENDING_KEY); } catch {}
  }
}

// Render one HTML file in the sandboxed preview. The entry is always explicit:
// the given path, or the active file when it is HTML. There is no fallback to a
// guessed "index.html" — a non-HTML active file simply has nothing to preview.
function runPreview(entry = null) {
  ensureOutExpanded();
  try {
    const requested = entry ?? (runnerForPath(activePath) === "web" ? activePath : null);
    const htmlFile = requested && project.has(requested) ? requested : null;
    if (!htmlFile) {
      const message = activePath
        ? `Nothing to preview — ${activePath} is not an HTML file`
        : "Nothing to preview — open an HTML file first";
      pushConsole("warn", message, "web");
      return { ok: false, error: message };
    }
    previewEntry = htmlFile;
    const ready = runner.run(project, { entry: htmlFile });
    pushConsole("info", `▶ preview ${htmlFile}`, "web");
    switchOut("preview");
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
    <div class="ws-modal" style="max-width:560px">
      <h3>Python Packages</h3>
      <p style="font-size:13px; color:var(--t3); margin:0 0 12px">Bundled packages install from disk and work with no network connection. Anything else is fetched from PyPI (or loaded from the Pyodide distribution when available).</p>
      <div style="display:flex; gap:6px; margin-bottom:12px">
        <input type="text" class="ws-pkg-input mono" placeholder="Package name, e.g. requests or sympy" style="flex:1; padding:7px 10px; border-radius:6px; background:var(--panel-hover); border:1px solid var(--line); color:var(--t1)" />
        <button class="ws-btn primary small ws-pkg-install">Install</button>
      </div>
      <div class="ws-pkg-status mono" style="font-size:12px; margin-bottom:10px; min-height:1.2em; color:var(--ok)"></div>

      <div style="display:flex; justify-content:space-between; align-items:center; margin:0 0 6px; gap:8px">
        <span style="font-size:11.5px; color:var(--t4)">Bundled for offline use <span class="ws-pkg-count mono"></span></span>
        <span style="display:flex; align-items:center; gap:8px">
          <button class="ws-btn ghost tiny ws-pkg-prepare" title="Load the Pyodide scientific stack (numpy, pandas, matplotlib, scipy, scikit-learn, sympy) so data-science packages work offline afterwards">⬇ Cache scientific stack</button>
          <span class="mono ws-pkg-offline" style="font-size:10.5px; color:var(--t4)"></span>
        </span>
      </div>
      <div class="ws-pkg-bundled" style="font-size:12px; max-height:220px; overflow-y:auto; border:1px solid var(--line-soft); border-radius:6px; background:rgba(0,0,0,0.18)">
        <div class="ws-pkg-empty mono" style="padding:10px; font-size:11px; color:var(--t3)">Loading offline bundle…</div>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; margin:12px 0 6px">
        <span style="font-size:11.5px; color:var(--t4)">Loaded packages:</span>
        <button class="ws-btn ghost tiny ws-pkg-refresh" title="Refresh loaded package list" style="padding:2px 6px">↻ Refresh</button>
      </div>
      <div class="ws-pkg-list mono" style="font-size:11px; max-height:80px; overflow-y:auto; color:var(--t3); background:rgba(0,0,0,0.2); padding:6px; border-radius:4px">
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
  const bundledEl = modal.querySelector(".ws-pkg-bundled");
  const bundledCountEl = modal.querySelector(".ws-pkg-count");
  const offlineEl = modal.querySelector(".ws-pkg-offline");
  const prepareBtn = modal.querySelector(".ws-pkg-prepare");
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

  const setBusy = (busy, label) => {
    installBtn.disabled = busy;
    installBtn.textContent = busy ? "Installing…" : "Install";
    if (label) { statusEl.textContent = label; statusEl.style.color = "var(--t3)"; }
  };

  const runInstall = async (pkg, { bundled } = {}) => {
    setBusy(true, `Installing ${pkg}…`);
    try {
      const res = bundled
        ? await installBundledPackage(pkg, { onStatus: s => { statusEl.textContent = s; } })
        : await installPackagePreferred(pkg, { onStatus: s => { statusEl.textContent = s; } });
      if (res.ok) {
        statusEl.textContent = bundled
          ? `✔ ${pkg} installed from the offline bundle`
          : `✔ ${pkg} installed successfully`;
        statusEl.style.color = "var(--ok)";
        if (res.missingDeps?.length) {
          statusEl.textContent += ` — warning: could not load ${res.missingDeps.join(", ")}`;
          statusEl.style.color = "var(--warn)";
        }
        pushConsole("info", `✔ Package ${pkg} installed${bundled ? " (offline bundle)" : ""}`, "python");
        if (res.loadedDeps?.length) {
          pushConsole("info", `Pyodide stack: ${res.loadedDeps.join(", ")}`, "python");
        }
        refreshLoadedPackages();
        renderBundled();
      } else {
        statusEl.textContent = `✖ ${res.error || "Installation failed"}`;
        statusEl.style.color = "var(--danger)";
      }
      return res;
    } catch (e) {
      statusEl.textContent = `✖ ${String(e?.message || e)}`;
      statusEl.style.color = "var(--danger)";
      return { ok: false, error: String(e) };
    } finally {
      installBtn.disabled = false;
      installBtn.textContent = "Install";
    }
  };

  const doInstall = async () => {
    const pkg = input.value.trim();
    if (!pkg) return;
    const res = await runInstall(pkg);
    if (res?.ok) input.value = "";
  };

  // ---- Bundled (offline) package list ----
  let loaded = new Set();
  const renderBundled = async () => {
    const { packages, unavailable, generatedAt } = await bundledPackages();
    loaded = new Set(installedPackages().map(n => String(n).toLowerCase().replace(/[-_.]+/g, "-")));
    bundledEl.replaceChildren();
    if (!packages.length) {
      const empty = document.createElement("div");
      empty.className = "ws-pkg-empty mono";
      empty.style.cssText = "padding:10px; font-size:11px; color:var(--t3)";
      empty.textContent = "No offline bundle found — run `node tools/vendor-python-packages.mjs`.";
      bundledEl.appendChild(empty);
      bundledCountEl.textContent = "";
      offlineEl.textContent = "";
      return;
    }
    const total = packages.reduce((n, p) => n + (p.size || 0), 0);
    bundledCountEl.textContent = `(${packages.length})`;
    offlineEl.textContent = `~${(total / 1048576).toFixed(1)} MB on disk${generatedAt ? ` · ${generatedAt.slice(0, 10)}` : ""}`;

    for (const p of packages) {
      const key = String(p.key || p.name).toLowerCase().replace(/[-_.]+/g, "-");
      const row = document.createElement("div");
      row.style.cssText = "display:flex; align-items:center; gap:8px; padding:7px 10px; border-bottom:1px solid var(--line-soft)";
      const left = document.createElement("div");
      left.style.cssText = "flex:1; min-width:0";
      const title = document.createElement("div");
      title.className = "mono";
      title.style.cssText = "font-size:12px; color:var(--t1)";
      title.textContent = `${p.name} ${p.version}`;
      const desc = document.createElement("div");
      desc.style.cssText = "font-size:11px; color:var(--t3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap";
      const ext = p.externalRequires ?? [];
      desc.textContent = (p.description || "") + (ext.length ? ` · needs Pyodide stack: ${ext.join(", ")}` : "");
      desc.title = (p.description || "") + (ext.length ? `\nRequires from the Pyodide distribution: ${ext.join(", ")}` : "\nFully self-contained in the offline bundle");
      left.append(title, desc);
      const btn = document.createElement("button");
      btn.className = "ws-btn ghost tiny";
      const isLoaded = loaded.has(key);
      btn.textContent = isLoaded ? "✔ loaded" : "Install";
      btn.disabled = isLoaded;
      btn.title = `Install ${p.name} offline from vendor/python-packages`;
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const res = await runInstall(p.name, { bundled: true });
        if (!res?.ok) btn.disabled = false;
      });
      row.append(left, btn);
      bundledEl.appendChild(row);
    }

    const missing = Object.entries(unavailable ?? {});
    if (missing.length) {
      const note = document.createElement("div");
      note.className = "mono";
      note.style.cssText = "padding:8px 10px; font-size:10.5px; color:var(--t4); line-height:1.5";
      note.textContent = `Not bundled (no pure-Python wheel): ${missing.map(([n]) => n).join(", ")} — these still install from PyPI when online.`;
      bundledEl.appendChild(note);
    }
  };

  renderBundled();
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    statusEl.textContent = "You are offline — bundled packages install from disk.";
    statusEl.style.color = "var(--warn)";
  }

  // Pre-load the scientific stack so it lands in the service-worker cache and
  // data-science packages keep working offline on later visits.
  prepareBtn?.addEventListener("click", async () => {
    prepareBtn.disabled = true;
    prepareBtn.textContent = "Caching…";
    try {
      const res = await prepareOfflineStack({ onStatus: s => { statusEl.textContent = s; statusEl.style.color = "var(--t3)"; } });
      const okMsg = `✔ Cached ${res.loaded.length} package${res.loaded.length === 1 ? "" : "s"} for offline use`;
      statusEl.textContent = res.failed.length ? `${okMsg} — unavailable: ${res.failed.join(", ")}` : okMsg;
      statusEl.style.color = res.failed.length ? "var(--warn)" : "var(--ok)";
      pushConsole("info", `✔ Offline stack ready: ${res.loaded.join(", ") || "(none)"}`, "python");
      refreshLoadedPackages();
      renderBundled();
    } catch (e) {
      statusEl.textContent = `✖ ${String(e?.message || e)}`;
      statusEl.style.color = "var(--danger)";
    } finally {
      prepareBtn.disabled = false;
      prepareBtn.textContent = "⬇ Cache scientific stack";
    }
  });

  installBtn.addEventListener("click", doInstall);
  input.addEventListener("keydown", e => { if (e.key === "Enter") doInstall(); });
  const close = () => modal.remove();
  closeBtn.addEventListener("click", close);
  modal.addEventListener("click", e => { if (e.target === modal) close(); });
}



// ---- Chat thread helpers (file-aware, read-only) ----

function clearChatThread() {
  chatHistory = [];
  if (!els.chatThread) return;
  els.chatThread.replaceChildren();
  const e = document.createElement("div");
  e.className = "ws-empty";
  e.innerHTML = `Ask about your project files.<br><br>
  Tip: Right-click a file → <b>Explain / Review / Add to Chat</b>, type <span class="mono">@</span> to mention files, or select code → <b>Add selection</b>.<br><br>
  <span class="mono" style="font-size:11px; color:var(--t4)">Chat is read-only — it never edits files. Copy a suggested snippet and paste it into the editor yourself.</span>`;
  els.chatThread.appendChild(e);
}

function appendImageToBubble(bubble, image) {
  if (!bubble || !image?.url) return;
  const img = document.createElement("img");
  img.className = "attached-inline";
  img.src = image.url;
  img.alt = "attached image";
  bubble.appendChild(img);
}

// Add a Copy button to every rendered code block so suggested snippets are
// easy to apply manually. Delegated on the thread: one listener, works for
// streamed updates too.
function decorateChatThreadCopy() {
  if (!els.chatThread || els.chatThread._copyWired) return;
  els.chatThread._copyWired = true;
  els.chatThread.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-copy-code]");
    if (!btn || !els.chatThread.contains(btn)) return;
    const pre = btn.closest("pre");
    const code = pre?.querySelector("code")?.innerText ?? pre?.innerText ?? "";
    if (!code) { showAppToast("Nothing to copy", "error"); return; }
    try {
      await navigator.clipboard.writeText(code);
      showAppToast("Copied snippet — paste it into the editor", "success");
    } catch {
      // Clipboard API unavailable (permissions / insecure context): select instead.
      try {
        const range = document.createRange();
        range.selectNodeContents(pre.querySelector("code") || pre);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        showAppToast("Snippet selected — press Ctrl+C to copy", "info");
      } catch {
        showAppToast("Copy failed — select the code manually", "error");
      }
    }
  });
  // Tag code blocks after each render pass.
  const tagBlocks = () => {
    for (const pre of els.chatThread.querySelectorAll("pre")) {
      if (pre._copyTagged) continue;
      pre._copyTagged = true;
      pre.style.position = pre.style.position || "relative";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ws-btn ghost tiny";
      btn.setAttribute("data-copy-code", "");
      btn.textContent = "⧉ Copy";
      btn.title = "Copy this snippet";
      btn.style.cssText = "position:absolute;top:6px;right:6px;opacity:.75;background:rgba(0,0,0,.45);";
      btn.addEventListener("mouseenter", () => { btn.style.opacity = "1"; });
      btn.addEventListener("mouseleave", () => { btn.style.opacity = ".75"; });
      pre.appendChild(btn);
    }
  };
  new MutationObserver(tagBlocks).observe(els.chatThread, { childList: true, subtree: true });
  tagBlocks();
}

// Build the file-context block for the chat prompt. Head-truncates oversize
// files with a visible notice so the small model stays reliable.
function buildFileContextBlock() {
  const parts = [];
  for (const a of attachments) {
    const full = String(a.text ?? "");
    const truncated = full.length > MAX_ATTACH_CHARS;
    const body = truncated ? full.slice(0, MAX_ATTACH_CHARS) : full;
    parts.push(`--- File: ${a.path} (${full.length} chars${truncated ? `, truncated to ${MAX_ATTACH_CHARS}` : ""}) ---\n${body}${truncated ? `\n… [truncated — ${full.length - MAX_ATTACH_CHARS} more chars omitted]` : ""}`);
  }
  if (currentSelection?.text) {
    const sel = String(currentSelection.text);
    const truncated = sel.length > MAX_ATTACH_CHARS;
    parts.push(`--- Current editor selection: ${currentSelection.path || activePath || "unknown"} (${sel.length} chars${truncated ? ", truncated" : ""}) ---\n${truncated ? sel.slice(0, MAX_ATTACH_CHARS) : sel}`);
  }
  return parts.join("\n\n");
}

// ---- File-aware chat (read-only) ----

async function sendToChat() {
  const rawText = els.chatInput.value.trim();
  if ((!rawText && attachments.length === 0 && !pendingImage) || !modelService.ready || generating) return;
  // Resolve @-mentions into attachments first.
  resolveMentionsInText(rawText);
  const fileBlock = buildFileContextBlock();
  const question = rawText || "(no question — review the attached files and summarize what they do)";

  els.chatInput.value = "";
  hideMentionPop();
  autoGrowChat();

  // User-visible echo with attachment list.
  const displayText = question
    + (attachments.length ? `\n\n> Attached: ${attachments.map(a => `\`${a.path}\``).join(", ")}` : "")
    + (currentSelection?.text ? `\n\n> Selection: \`${currentSelection.path || activePath || "editor"}\` (${String(currentSelection.text).length} chars)` : "");
  const image = pendingImage;
  let userContent;
  if (image) {
    const promptText = `${question}${fileBlock ? `\n\n${fileBlock}` : ""}`;
    userContent = [
      { type: "image", url: image.url },
      { type: "text", text: promptText },
    ];
    const userMessage = chatThreadView.appendUser("");
    const userBubble = userMessage.querySelector(".bubble");
    appendImageToBubble(userBubble, image);
    const textNode = document.createElement("div");
    textNode.textContent = displayText || "(attached image)";
    userBubble.appendChild(textNode);
    clearPendingImage();
  } else {
    const promptText = fileBlock
      ? `You are a read-only code assistant. Answer questions about the project files below. Never claim to edit files — instead give short explanations plus complete corrected code snippets the user can copy and paste manually.\n\n${fileBlock}\n\n=== QUESTION ===\n${question}`
      : question;
    userContent = promptText;
    chatThreadView.appendUser(displayText);
  }
  chatHistory.push({ role: "user", content: userContent });
  // Attachments persist across turns until cleared so follow-up questions
  // ("now fix the loop") keep working without re-attaching.
  renderAttachments();
  const assistant = chatThreadView.appendAssistant("");
  const bubble = assistant.querySelector(".bubble");

  generating = true;
  abortController = new AbortController();
  els.chatStatus.textContent = "Gemma thinking…";
  syncState();

  const unlock = acquireLock("code-chat");
  if (!unlock) {
    bubble.textContent = "Another app is generating — try again shortly.";
    generating = false;
    abortController = null;
    syncState();
    return;
  }

  let reply = "";
  let thinkingText = "";
  let answerText = "";
  try {
    const arch = Number(modelService.capabilities?.architecturalMax) || 131072;
    const contextMax = selectedContextLimit(arch);
    const result = await streamGeneration({
      messages: thinkMessages(chatHistory),
      maxNewTokens: null,
      contextMax,
      signal: abortController.signal,
      onToken: ({ full, thinkingText: nextThinking, answerText: nextAnswer }) => {
        reply = full;
        thinkingText = nextThinking;
        answerText = nextAnswer;
        chatThreadView.renderAssistant(bubble, { raw: reply, thinkingText, answerText, streaming: true });
      },
    });
    reply = result.reply;
    thinkingText = result.thinkingText;
    answerText = result.answerText;
  } catch (error) {
    if (!abortController?.signal?.aborted) {
      reply = `⚠ ${String(error?.message ?? error)}`;
    }
  } finally {
    chatThreadView.renderAssistant(bubble, { raw: reply, thinkingText, answerText });
    if (reply || answerText) chatHistory.push({ role: "assistant", content: answerText || reply });
    unlock();
    generating = false;
    abortController = null;
    els.chatStatus.textContent = "";
    syncState();
  }
}

