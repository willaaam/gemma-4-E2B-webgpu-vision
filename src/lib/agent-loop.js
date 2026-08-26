// Hand-rolled agent loop for the coding environment.
//
// The engine renders its chat template with tools:null (no native tool
// calling), so the loop is a strict TEXT PROTOCOL:
//   1. We instruct the model to reply with exactly one fenced code block.
//   2. We extract the block, execute it in the sandbox runtime.
//   3. We append the runtime output as an observation (user role) and let the
//      model revise, up to maxSteps rounds or until it emits a final marker.
//
// Greedy decode makes small, strictly-formatted outputs reliable; large
// freeform ones are not. The protocol leans into that.

import { complete } from "../services/generation.js";
import { thinkMessages } from "../services/settings.js";

// Extract the last fenced code block with the given tag (or any tag if none given).
export function extractCodeBlock(text, tag = null) {
  const src = String(text || "");
  const re = /```([A-Za-z0-9_+-]*)\r?\n([\s\S]*?)```/g;
  let m, last = null;
  while ((m = re.exec(src))) {
    const [, t, body] = m;
    if (!tag || t.toLowerCase() === tag.toLowerCase()) last = { lang: t || tag || "", code: body };
  }
  return last;
}

export function stripCodeFence(text) {
  return String(text || "").replace(/```[A-Za-z0-9_+-]*\r?\n?/g, "").replace(/```/g, "").trim();
}

const PROTOCOL_PREAMBLE = [
  "You are a coding assistant embedded in an execution sandbox.",
  "RULES — follow exactly:",
  "1. Reply with EXACTLY ONE fenced code block and nothing else (no prose before or after).",
  "2. Use the required language tag on the fence.",
  "3. The code must be complete and runnable as-is — no placeholders, no TODOs.",
  "4. Print results with the runtime's output mechanism so they can be observed.",
].join("\n");

/**
 * Run the generate → execute → observe loop.
 *
 * @param {object} opts
 * @param {string} opts.language        "python" | "web"
 * @param {string} opts.task            user's request
 * @param {Array}  opts.history         prior {role, content} turns for this session
 * @param {(code: string) => Promise<{ok: boolean, stdout?: string, stderr?: string, result?: string, error?: string}>} opts.execute
 * @param {number} [opts.maxSteps=3]
 * @param {boolean} [opts.thinking=true]  reasoning mode (<|think|>) — helps the model plan code
 * @param {AbortSignal} [opts.signal]
 * @param {(evt: object) => void} [opts.onEvent]  {type: 'step'|'exec'|'done'|'error', ...}
 */
export async function runAgentLoop({ language, task, history = [], execute, maxSteps = 3, thinking = true, signal, onEvent }) {
  const fenceTag = language === "python" ? "python" : "html";
  const messages = thinkMessages([
    { role: "system", content: `${PROTOCOL_PREAMBLE}\nRequired language: ${fenceTag}` },
    ...history,
    { role: "user", content: task },
  ]);

  let lastCode = "";
  const steps = [];

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) break;
    onEvent?.({ type: "step", step, of: maxSteps });

    const turn = await complete({
      messages,
      owner: `agent:${language}`,
      signal,
      maxNewTokens: 4096,
      skipLock: true, // the caller (app) already holds the global lock
    });
    const answer = turn.answerText || turn.reply || "";
    const block = extractCodeBlock(answer, fenceTag) ?? extractCodeBlock(answer);

    if (!block || !block.code.trim()) {
      // One repair round: feed the format violation back.
      messages.push({ role: "assistant", content: answer });
      messages.push({ role: "user", content: `Your reply did not contain a single fenced ${fenceTag} code block. Reply again with EXACTLY ONE fenced ${fenceTag} block containing the complete code.` });
      onEvent?.({ type: "format-retry", step });
      const retry = await complete({ messages, owner: `agent:${language}`, signal, maxNewTokens: 4096, skipLock: true });
      const retryAnswer = retry.answerText || retry.reply || "";
      const retryBlock = extractCodeBlock(retryAnswer, fenceTag) ?? extractCodeBlock(retryAnswer);
      if (!retryBlock || !retryBlock.code.trim()) {
        onEvent?.({ type: "error", message: "Model could not produce a valid code block." });
        return { ok: false, steps, code: lastCode };
      }
      messages.push({ role: "assistant", content: retryAnswer });
      Object.assign(turn, { answerText: retryAnswer });
      block.code = retryBlock.code;
    } else {
      messages.push({ role: "assistant", content: answer });
    }

    lastCode = block.code;
    onEvent?.({ type: "exec", step, code: block.code });
    const result = await execute(block.code);
    steps.push({ step, code: block.code, result });

    const observation = formatObservation(result);
    onEvent?.({ type: "observation", step, result });

    const looksComplete = result.ok && !result.error && (result.stderr ?? "").trim() === "";
    if (step === maxSteps || looksComplete || signal?.aborted) {
      messages.push({ role: "user", content: observation });
      onEvent?.({ type: "done", steps, code: lastCode });
      return { ok: result.ok, steps, code: lastCode, messages };
    }

    // Ask for a revision based on what happened.
    messages.push({ role: "user", content: `${observation}\n\nIf the output is correct, reply with the same final ${fenceTag} block unchanged. If there was an error or the output is wrong, reply with the corrected COMPLETE ${fenceTag} block.` });
  }

  onEvent?.({ type: "done", steps, code: lastCode });
  return { ok: false, steps, code: lastCode, messages };
}

function formatObservation(result) {
  const parts = ["[runtime output]"];
  if (result.stdout) parts.push(`stdout:\n${truncate(result.stdout, 4000)}`);
  if (result.result) parts.push(`result: ${truncate(String(result.result), 1000)}`);
  if (result.stderr) parts.push(`stderr:\n${truncate(result.stderr, 2000)}`);
  if (result.error) parts.push(`error: ${truncate(String(result.error), 1500)}`);
  if (!result.ok) parts.push("exit: FAILURE");
  else parts.push("exit: success");
  return parts.join("\n");
}

function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more chars)` : s;
}
