import { complete } from "../../services/generation.js";
import { thinkMessages } from "../../services/settings.js";
import { RESPONSE_TOKEN_RESERVE } from "../../services/context.js";
import { modelService } from "../../services/model-service.js";

async function countTokensForMessages(messages) {
  const model = modelService.model;
  if (model?.countPromptTokens) {
    try { return Math.max(0, Math.floor(Number(await model.countPromptTokens(messages)) || 0)); } catch {}
  }
  let chars = 0;
  for (const m of messages) {
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    chars += c.length;
  }
  return Math.ceil(chars * 0.25);
}

async function summarizeHistory(messagesToSummarize, signal) {
  const prompt = `Summarize this coding session history concisely for a code agent. Preserve:
- file paths that were read/written/patched and their intent
- tool results and any errors/stack traces (keep salient lines)
- user requests
Keep under 800 tokens. Output plain markdown, no code fences.`;
  const body = messagesToSummarize.map(m => `${m.role.toUpperCase()}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content).slice(0, 6000)}`).join("\n\n---\n\n").slice(0, 24000);
  try {
    const res = await complete({
      messages: thinkMessages([{ role: "user", content: `${prompt}\n\nHISTORY:\n${body}` }]),
      owner: "code-summarize",
      maxNewTokens: 800,
      signal,
      skipLock: true,
    });
    const text = (res.answerText || res.reply || "").trim();
    if (text) return text;
  } catch {}
  return messagesToSummarize.slice(-2).map(m => `${m.role}: ${(String(m.content).slice(0, 400))}`).join("\n");
}

export async function compactHistoryIfNeeded({ messages, systemPrompt, effectiveLimit, signal }) {
  const base = [{ role: "system", content: systemPrompt }];
  let withSystem = [...base, ...messages];
  let tokens = await countTokensForMessages(thinkMessages(withSystem));
  if (tokens + 512 <= effectiveLimit) return { messages, compacted: false };
  const keepTail = Math.min(8, messages.length);
  const head = messages.slice(0, Math.max(0, messages.length - keepTail));
  if (head.length === 0) {
    return { messages: messages.slice(-keepTail), compacted: true, note: "history truncated (even tail exceeds limit)" };
  }
  const summary = await summarizeHistory(head, signal);
  const compacted = [
    { role: "user", content: `[Conversation summary of first ${head.length} messages — older context compressed]\n${summary}` },
    { role: "assistant", content: "Acknowledged. Continuing with summarized history." },
    ...messages.slice(-keepTail),
  ];
  return { messages: compacted, compacted: true };
}

export { countTokensForMessages };
