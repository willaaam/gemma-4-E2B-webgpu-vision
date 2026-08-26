// Chat app — the original on-device chat, moved into the workstation shell.
// Behavior-preserving port of the inline script, now using the shared
// model/generation services plus conversation persistence (IndexedDB).

import { modelService } from "../../src/services/model-service.js";
import { acquireLock, generationStats, streamGeneration } from "../../src/services/generation.js";
import { db, newId } from "../../src/services/db.js";
import { thinkMessages } from "../../src/services/settings.js";
import { getContextLimitPreference, selectedContextLimit } from "../../src/services/context-preference.js";
import { escapeHtml } from "../../src/lib/markdown.js";
import { createChatThread } from "../../src/lib/chat-thread.js";

const $ = (id) => document.getElementById(id);

let els = {};
let messages = [];
let pendingImage = null;
let abortController = null;
let isGeneratingLocal = false;
let renderScheduled = false;
let renderState = null;
let threadView = null;
let followStream = true;

let activeConvId = null;
let unsubscribeModel = null;

export const chatApp = {
  id: "chat",
  title: "Chat",

  mount() {
    els = {
      threadScroll: $("threadScroll"),
      thread: $("thread"),
      input: $("input"),
      sendBtn: $("sendBtn"),
      stopBtn: $("stopBtn"),
      clearBtn: $("clearBtn"),
      attachBtn: $("attachBtn"),
      imageInput: $("imageInput"),
      attachments: $("attachments"),
      hint: $("hint"),
      liveStat: $("liveStat"),
      kernelsBtn: $("kernelsBtn"),
      kernelsOverlay: $("kernelsOverlay"),
      historyBtn: $("historyBtn"),
      historyDrawer: $("historyDrawer"),
      historyList: $("historyList"),
      historyClose: $("historyClose"),
      exportBtn: $("exportBtn"),
    };
    threadView = createChatThread({ scrollEl: els.threadScroll, threadEl: els.thread });
    els.threadScroll.addEventListener("scroll", onThreadScroll, { passive: true });

    // ---- event wiring (same semantics as the original page) ----
    els.sendBtn.addEventListener("click", send);
    els.stopBtn.addEventListener("click", () => abortController?.abort());
    els.clearBtn.addEventListener("click", () => startNewConversation());
    els.attachBtn.addEventListener("click", () => els.imageInput.click());
    els.imageInput.addEventListener("change", onImagePicked);
    els.kernelsBtn.addEventListener("click", openKernels);
    els.kernelsOverlay.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeKernels(); });
    $("kxList").addEventListener("scroll", updateListFade, { passive: true });
    $("kxCopy").addEventListener("click", copyKernel);
    this._escHandler = (e) => { if (e.key === "Escape" && !els.kernelsOverlay.hidden) closeKernels(); };
    document.addEventListener("keydown", this._escHandler);

    els.input.addEventListener("input", () => { autoGrow(); refreshSend(); });
    els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!els.sendBtn.disabled) send(); }
    });
    this._seedHandler = (e) => {
      const seed = e.target.closest(".seed");
      if (!seed || seed.disabled || !modelService.ready || isGeneratingLocal) return;
      els.input.value = seed.textContent;
      send();
    };
    document.addEventListener("click", this._seedHandler);

    // history drawer
    els.historyBtn?.addEventListener("click", () => openHistory());
    els.historyClose?.addEventListener("click", () => closeHistory());
    els.exportBtn?.addEventListener("click", exportMarkdown);
    this._histListClick = (e) => {
      const btn = e.target.closest("[data-conv]");
      if (!btn) return;
      const del = e.target.closest("[data-del]");
      if (del) { deleteConversation(del.getAttribute("data-del")); return; }
      openConversation(btn.getAttribute("data-conv"));
    };
    els.historyList?.addEventListener("click", this._histListClick);

    // reflect global model state onto chat controls
    unsubscribeModel = modelService.subscribe((s) => syncModelState(s));

    // restore last conversation (or start fresh)
    restoreLast().catch(console.error);
  },

  unmount() {
    els.threadScroll?.removeEventListener("scroll", onThreadScroll);
    document.removeEventListener("keydown", this._escHandler);
    document.removeEventListener("click", this._seedHandler);
    unsubscribeModel?.();
    unsubscribeModel = null;
    closeHistory();
  },
};

function syncModelState(s) {
  const ready = !!s.model && !s.loading;
  if (!navigator.gpu && s.status !== "ready") {
    els.input.disabled = true;
    return;
  }
  els.input.disabled = !ready || isGeneratingLocal;
  els.input.placeholder = ready ? "Ask anything…" : "Load the model to start chatting...";
  els.clearBtn.disabled = !ready || isGeneratingLocal;
  els.attachBtn.disabled = !ready;
  els.kernelsBtn.hidden = !ready;
  setSeedButtonsEnabled(ready);
  refreshSend();
}

// ---------------- sending / streaming ----------------

async function send() {
  const text = els.input.value.trim();
  if ((!text && !pendingImage) || !modelService.ready || isGeneratingLocal) return;

  removeWelcome();
  els.input.value = "";
  autoGrow(); refreshSend();

  let userContent;
  if (pendingImage) {
    // multimodal message: image first, then text (Gemma 4 best practice)
    userContent = [{ type: "image", url: pendingImage.url }, { type: "text", text: text || "What is in this image? Describe it in detail." }];
    const img = document.createElement("img");
    img.className = "attached-inline";
    img.src = pendingImage.url;
    img.alt = "attached image";
    const bubble = appendUserMessage("");
    bubble.querySelector(".bubble").appendChild(img);
    if (text) { const t = document.createElement("div"); t.textContent = text; bubble.querySelector(".bubble").appendChild(t); }
    pendingImage = null;
    renderAttachments();
  } else {
    userContent = text;
    appendUserMessage(text);
  }
  messages.push({ role: "user", content: userContent });

  const assistant = appendAssistantMessage();
  const bubble = assistant.querySelector(".bubble");
  bubble.innerHTML = '<span class="thinking"><span></span><span></span><span></span></span>';
  followStream = true;
  scrollDown();

  setGenerating(true);
  abortController = new AbortController();

  let reply = "";
  let thinkingText = "";
  let answerText = "";
  let startedAt = 0, firstTokenAt = 0, endedAt = 0, generatedTokens = 0;

  const unlock = acquireLock("chat");
  if (!unlock) {
    bubble.textContent = "Another app is generating right now — try again when it finishes.";
    setGenerating(false);
    return;
  }

  try {
    // Thinking mode (global toggle): prepend the <|think|> system token so the
    // model reasons step-by-step before answering. Kept out of `messages`.
    const promptMessages = thinkMessages(messages);
    startedAt = performance.now();
    const arch = Number(modelService.capabilities?.architecturalMax) || 131072;
    const contextMax = selectedContextLimit(arch);
    const res = await streamGeneration({
      messages: promptMessages,
      maxNewTokens: 4096,
      contextMax,
      signal: abortController.signal,
      onToken: ({ full, thinkingText: nextThinking, answerText: nextAnswer, startedAt: started, firstTokenAt: first, now, generatedTokens: count }) => {
        startedAt = started;
        firstTokenAt = first;
        generatedTokens = count;
        reply = full;
        thinkingText = nextThinking;
        answerText = nextAnswer;
        scheduleAssistantRender(bubble, reply, thinkingText, answerText);
        updateLiveStat({ startedAt, firstTokenAt, now, generatedTokens });
      },
    });
    reply = res.reply;
    thinkingText = res.thinkingText;
    answerText = res.answerText;
    ({ startedAt, firstTokenAt, endedAt, generatedTokens } = res.stats);
  } catch (error) {
    console.error(error);
    if (!reply) reply = error?.code === "context_limit" || error?.code === "context_capacity"
      ? `⚠ ${String(error.message)}`
      : `_Stopped: ${String(error?.message ?? error)}_`;
  } finally {
    endedAt = performance.now();
    unlock();
    renderState = null; // cancel any pending coalesced render; show the final reply now
    renderAssistant(bubble, reply, false, thinkingText, answerText);
    appendMeta(assistant, { startedAt, firstTokenAt, endedAt, generatedTokens });
    scrollDown();
    // Store only the final answer — never feed the model's own thoughts back
    // into the next turn's context (Gemma 4 best practice).
    messages.push({ role: "assistant", content: answerText || reply });
    setGenerating(false);
    els.liveStat.textContent = "";
    abortController = null;
    els.input.focus();
    await persistConversation();
  }
}

function setGenerating(on) {
  isGeneratingLocal = on;
  els.input.disabled = on || !modelService.ready;
  els.clearBtn.disabled = on || !modelService.ready;
  els.sendBtn.style.display = on ? "none" : "";
  els.stopBtn.style.display = on ? "grid" : "none";
  els.hint.textContent = on ? "Generating on-device…" : "Runs fully on-device — nothing leaves your machine";
  refreshSend();
}

function updateLiveStat({ startedAt, firstTokenAt, now, generatedTokens }) {
  if (generatedTokens <= 1) { els.liveStat.textContent = `TTFT ${(firstTokenAt - startedAt).toFixed(0)} ms`; return; }
  const decodeSeconds = Math.max((now - firstTokenAt) / 1000, 1e-9);
  const tps = (generatedTokens - 1) / decodeSeconds;
  els.liveStat.textContent = `${tps.toFixed(0)} tok/s`;
}

// ---------------- conversation persistence ----------------

async function restoreLast() {
  try {
    const all = await db.all("conversations");
    const chats = all.filter((c) => c.appId === "chat").sort((a, b) => b.updatedAt - a.updatedAt);
    renderHistoryList(chats);
    if (chats[0]?.messages?.length) await openConversation(chats[0].id);
  } catch (e) { console.error("restoreLast failed", e); }
}

async function openConversation(id) {
  try {
    const conv = await db.get("conversations", id);
    if (!conv || conv.appId !== "chat") return;
    activeConvId = conv.id;
    messages = conv.messages ?? [];
    pendingImage = null;
    renderAttachments();
    rerenderThread();
    closeHistory();
  } catch (e) { console.error(e); }
}

async function persistConversation() {
  try {
    if (messages.length === 0) return;
    const firstUser = messages.find((m) => m.role === "user");
    const title = titleFromContent(firstUser?.content) || "Chat";
    if (!activeConvId) activeConvId = newId("conv");
    const existing = await db.get("conversations", activeConvId);
    const now = Date.now();
    await db.put("conversations", {
      id: activeConvId,
      appId: "chat",
      title,
      messages,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    refreshHistoryList();
  } catch (e) { console.error("persist failed", e); }
}

function titleFromContent(content) {
  const text = typeof content === "string" ? content : (Array.isArray(content) ? (content.find((p) => p.type === "text")?.text ?? "") : "");
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > 64 ? `${t.slice(0, 61)}…` : t;
}

async function startNewConversation() {
  messages = [];
  pendingImage = null;
  activeConvId = null;
  renderAttachments();
  modelService.model?.reset();
  els.thread.replaceChildren(createWelcome());
  els.clearBtn.disabled = !modelService.ready;
  setSeedButtonsEnabled(modelService.ready);
  refreshHistoryList();
  els.input.focus();
}

async function deleteConversation(id) {
  await db.delete("conversations", id);
  if (id === activeConvId) await startNewConversation();
  refreshHistoryList();
}

async function refreshHistoryList() {
  try {
    const all = await db.all("conversations");
    renderHistoryList(all.filter((c) => c.appId === "chat").sort((a, b) => b.updatedAt - a.updatedAt));
  } catch (_) {}
}

function renderHistoryList(chats) {
  if (!els.historyList) return;
  els.historyList.replaceChildren();
  if (!chats.length) {
    const empty = document.createElement("div");
    empty.className = "ws-empty";
    empty.textContent = "No saved conversations yet.";
    els.historyList.appendChild(empty);
    return;
  }
  for (const c of chats) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ws-hist-row" + (c.id === activeConvId ? " active" : "");
    row.setAttribute("data-conv", c.id);
    const title = document.createElement("span");
    title.className = "ws-hist-title";
    title.textContent = c.title || "Untitled";
    const date = document.createElement("span");
    date.className = "ws-hist-date";
    date.textContent = new Date(c.updatedAt).toLocaleDateString();
    const del = document.createElement("span");
    del.className = "ws-hist-del";
    del.textContent = "×";
    del.title = "Delete";
    del.setAttribute("data-del", c.id);
    row.append(title, date, del);
    els.historyList.appendChild(row);
  }
}

function openHistory() { els.historyDrawer.hidden = false; refreshHistoryList(); }
function closeHistory() { if (els.historyDrawer) els.historyDrawer.hidden = true; }

function exportMarkdown() {
  if (messages.length === 0) return;
  const lines = ["# Gemma 4 chat export", ""];
  for (const m of messages) {
    const who = m.role === "user" ? "**You**" : "**Gemma**";
    const text = typeof m.content === "string"
      ? m.content
      : (m.content ?? []).map((p) => p.type === "text" ? p.text : "![image](attached-image)").join("\n");
    lines.push(`### ${who}`, "", text, "");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `gemma4-chat-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------- thread rendering ----------------

function rerenderThread() {
  els.thread.replaceChildren();
  if (messages.length === 0) { els.thread.appendChild(createWelcome()); return; }
  for (const m of messages) {
    if (m.role === "user") {
      const msg = appendUserMessage("");
      const bubble = msg.querySelector(".bubble");
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === "image") {
            const img = document.createElement("img");
            img.className = "attached-inline";
            img.src = part.url;
            img.alt = "attached image";
            bubble.appendChild(img);
          } else if (part.text) {
            const t = document.createElement("div");
            t.textContent = part.text;
            bubble.appendChild(t);
          }
        }
      } else {
        bubble.textContent = m.content;
      }
    } else {
      const msg = appendAssistantMessage();
      renderAssistant(msg.querySelector(".bubble"), m.content, false, "", m.content);
    }
  }
  scrollDown();
}

function onImagePicked() {
  const file = els.imageInput.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingImage = { url: String(reader.result), name: file.name };
    renderAttachments();
    refreshSend();
  };
  reader.readAsDataURL(file);
  els.imageInput.value = "";
}

function renderAttachments() {
  els.attachments.replaceChildren();
  if (!pendingImage) { els.attachments.hidden = true; return; }
  els.attachments.hidden = false;
  const chip = document.createElement("div");
  chip.className = "attachment";
  const img = document.createElement("img");
  img.src = pendingImage.url;
  img.alt = "";
  const name = document.createElement("span");
  name.textContent = pendingImage.name || "image";
  const rm = document.createElement("button");
  rm.type = "button";
  rm.textContent = "×";
  rm.title = "Remove image";
  rm.addEventListener("click", () => { pendingImage = null; renderAttachments(); refreshSend(); });
  chip.append(img, name, rm);
  els.attachments.appendChild(chip);
}

function appendUserMessage(text) { return threadView.appendUser(text); }
function appendAssistantMessage() { return threadView.appendAssistant(); }

function appendMeta(msg, timing) {
  if (timing.generatedTokens <= 0) return;
  const stats = generationStats(timing);
  const meta = document.createElement("div");
  meta.className = "meta";
  const parts = [`${timing.generatedTokens} tok`, `TTFT ${stats.ttftMs.toFixed(0)} ms`];
  if (stats.decodeTokensPerSecond > 0) parts.push(`${stats.decodeTokensPerSecond.toFixed(1)} tok/s`);
  meta.textContent = parts.join("  ·  ");
  msg.appendChild(meta);
}

// Coalesce streamed renders to one per animation frame — marked re-parses the full reply each
// call, so parsing per token would tax decode; rAF caps it to the display rate.
function scheduleAssistantRender(bubble, raw, thinkingText, answerText) {
  renderState = { bubble, raw, thinkingText, answerText };
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (!renderState) return;
    renderAssistant(renderState.bubble, renderState.raw, true, renderState.thinkingText, renderState.answerText);
    if (followStream) scrollDown();
  });
}

function renderAssistant(bubble, raw, withCaret, thinkingText, answerText) {
  threadView.renderAssistant(bubble, {
    raw,
    thinkingText,
    answerText,
    streaming: withCaret,
  });
}

function removeWelcome() { $("welcome")?.remove(); }

function createWelcome() {
  const welcome = document.createElement("div");
  welcome.className = "welcome";
  welcome.id = "welcome";
  welcome.innerHTML = `
    <h2>What's on your <span class="thin">mind today?</span></h2>
    <p>Model runs entirely on your device.</p>
    <div class="seeds">
      <button class="seed" type="button">How does WebGPU differ from WebGL?</button>
      <button class="seed" type="button">Write a haiku about on-device AI</button>
      <button class="seed" type="button">What is quantization-aware training?</button>
    </div>`;
  return welcome;
}

function setSeedButtonsEnabled(enabled) {
  document.querySelectorAll(".seed").forEach((s) => { s.disabled = !enabled; });
}
function refreshSend() { els.sendBtn.disabled = isGeneratingLocal || !modelService.ready || (els.input.value.trim() === "" && !pendingImage); }
function autoGrow() { els.input.style.height = "auto"; els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`; }
function onThreadScroll() {
  if (isGeneratingLocal) followStream = threadView.isNearBottom();
}
function scrollDown() {
  if (!isGeneratingLocal || followStream) threadView.scrollToEnd();
}

// ---- Kernels viewer: the real rendered WGSL the model compiled on this GPU ----
function openKernels() {
  const model = modelService.model;
  if (!model) return;
  const kernels = model.runtime.getRenderedShaders?.() ?? [];
  const list = $("kxList");
  list.replaceChildren();
  $("kxSub").textContent = kernels.length
    ? `${kernels.length} WGSL compute shaders · text kernels by Fable 5 · vision tower by DeepSeek V4 Flash · running on your GPU`
    : "No kernels compiled yet — send a message first.";
  kernels.forEach((k, i) => {
    const item = document.createElement("button");
    item.className = "kx-item";
    item.type = "button";
    item.textContent = k.name;
    item.addEventListener("click", () => selectKernel(kernels, i));
    list.appendChild(item);
  });
  [...list.children].forEach((el) => el.classList.remove("active"));
  $("kxSource").hidden = true;
  $("kxIntro").hidden = false;
  $("kxCopy").dataset.src = "";
  els.kernelsOverlay.hidden = false;
  document.body.classList.add("kx-locked");
  list.scrollTop = 0;
  requestAnimationFrame(updateListFade);
}

function updateListFade() {
  const list = $("kxList");
  const atEnd = list.scrollHeight <= list.clientHeight + 4
    || list.scrollTop >= list.scrollHeight - list.clientHeight - 4;
  list.parentElement.classList.toggle("at-end", atEnd);
}

function selectKernel(kernels, i) {
  const k = kernels[i];
  if (!k) return;
  $("kxIntro").hidden = true;
  $("kxSource").hidden = false;
  [...$("kxList").children].forEach((el, j) => el.classList.toggle("active", j === i));
  $("kxName").textContent = k.name;
  $("kxLines").textContent = `${k.source.split("\n").length} lines`;
  $("kxCode").innerHTML = highlightWgsl(k.source);
  $("kxCode").parentElement.scrollTop = 0;
  $("kxCopy").dataset.src = k.source;
}

function closeKernels() {
  els.kernelsOverlay.hidden = true;
  document.body.classList.remove("kx-locked");
}

async function copyKernel() {
  const src = $("kxCopy").dataset.src;
  if (!src) return;
  try {
    await navigator.clipboard.writeText(src);
    const btn = $("kxCopy");
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy"; }, 1200);
  } catch { /* clipboard blocked — ignore */ }
}

const WGSL_KEYWORDS = new Set(["fn","let","var","const","const_assert","struct","if","else","for","loop","return","break","continue","switch","case","default","while","override","enable","requires","discard","alias","true","false","workgroup","storage","uniform","function","private","read","write","read_write","bitcast"]);
const WGSL_TYPES = new Set(["u32","i32","f32","f16","bool","vec2","vec3","vec4","mat2x2","mat3x3","mat4x4","mat2x3","mat3x2","mat2x4","mat4x2","mat3x4","mat4x3","array","atomic","ptr","sampler"]);
const WGSL_TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(@[A-Za-z_]\w*)|([A-Za-z_]\w*)|(\d[\w.]*)|(\s+)|([\s\S])/g;

function highlightWgsl(src) {
  let out = "";
  WGSL_TOKEN.lastIndex = 0;
  let m;
  while ((m = WGSL_TOKEN.exec(src))) {
    const [tok, comment, attr, ident, num, ws] = m;
    if (comment) out += `<span class="k-cm">${escapeHtml(comment)}</span>`;
    else if (attr) out += `<span class="k-at">${escapeHtml(attr)}</span>`;
    else if (ident) {
      const cls = WGSL_KEYWORDS.has(ident) ? "k-kw" : WGSL_TYPES.has(ident) ? "k-ty" : null;
      out += cls ? `<span class="${cls}">${ident}</span>` : escapeHtml(ident);
    }
    else if (num) out += `<span class="k-nu">${escapeHtml(num)}</span>`;
    else if (ws) out += ws;
    else out += escapeHtml(tok);
  }
  return out;
}
