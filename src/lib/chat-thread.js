import { renderMarkdown } from "./markdown.js";

export function createChatThread({ scrollEl, threadEl, userLabel = "You", assistantLabel = "Gemma" }) {
  function scrollToEnd() {
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function isNearBottom(threshold = 48) {
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= threshold;
  }

  function append(role, content = "") {
    threadEl.querySelector(".ws-empty, .welcome")?.remove();
    const msg = document.createElement("div");
    msg.className = `msg ${role}`;
    const label = document.createElement("div");
    label.className = "role";
    label.textContent = role === "user" ? userLabel : assistantLabel;
    const bubble = document.createElement("div");
    bubble.className = `bubble ${role}`;
    if (role === "assistant") bubble.innerHTML = renderMarkdown(content || "");
    else bubble.textContent = content || "";
    msg.append(label, bubble);
    threadEl.appendChild(msg);
    scrollToEnd();
    return msg;
  }

  function appendCaret(bubble) {
    const caret = document.createElement("span");
    caret.className = "caret";
    const blocks = bubble.querySelectorAll(":scope > p, :scope > .katex-display, :scope > span.katex-display");
    if (blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      if (last.classList.contains("katex-display")) last.after(caret);
      else last.appendChild(caret);
      return;
    }
    bubble.appendChild(caret);
  }

  function renderAssistant(bubble, { raw = "", thinkingText = "", answerText = "", streaming = false } = {}) {
    const prevOpen = bubble.querySelector(".thinking-block")?.open;
    const thinking = String(thinkingText || "").replace(/^thought\s*/i, "");
    const answer = (thinking || answerText) ? (answerText || "") : (raw || "");
    let html = "";
    if (thinking) {
      const open = prevOpen ?? true;
      html += `<details class="thinking-block"${open ? " open" : ""}><summary>Thinking</summary><div class="thinking-body">${renderMarkdown(thinking)}</div></details>`;
    }
    html += renderMarkdown(answer);
    if (streaming && !answer && !thinking) {
      html += '<span class="thinking"><span></span><span></span><span></span></span>';
    }
    bubble.innerHTML = html;
    if (streaming) appendCaret(bubble);
  }

  return { append, appendUser: (content) => append("user", content), appendAssistant: (content) => append("assistant", content), renderAssistant, scrollToEnd, isNearBottom };
}
