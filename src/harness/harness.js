// Agentic harness — Pi-lightweight + Opencode-structured + Gemma 4 Multi-Round Evaluation.
// Streaming, dirty rebuild, loop detection, self-evaluation check rounds,
// history compaction, permission ask, and undo snapshots.

import { complete, streamGeneration } from "../services/generation.js";
import { thinkMessages } from "../services/settings.js";
import { RESPONSE_TOKEN_RESERVE } from "../services/context.js";
import { modelService } from "../services/model-service.js";
import { getContextLimitPreference, selectedContextLimit } from "../services/context-preference.js";
import { extractToolCalls, extractAnswer, hasAnswer, hasUnclosedToolFence, looksLikeFinalAnswer, hashCalls, cleanProse, sanitizeFileContent } from "./parser.js";
import { createTools } from "./tools/registry.js";
import { buildCodeContext, renderCodeContextBlocks } from "./context/bundler.js";
import { compactHistoryIfNeeded, countTokensForMessages } from "./context/compaction.js";
import { buildSystemPrompt } from "./prompts/system.js";
import { permissionFor } from "./permissions.js";

const PROJECT_MUTATING_TOOLS = new Set(["write_file", "append_file", "apply_patch", "delete_file", "mkdir"]);
const MAX_HARNESS_STEPS = 16;
const MAX_HARNESS_INPUT_CHARS = 120_000;
const MAX_HARNESS_NEW_TOKENS = 8192;
const HARNESS_TEMPERATURE = 0.2;
const WEB_FILE_RE = /\.(?:html?|css|js|mjs)$/i;

function isProjectMutation(toolName) {
  return PROJECT_MUTATING_TOOLS.has(toolName);
}

function isWebPath(path) {
  return WEB_FILE_RE.test(String(path || ""));
}

function webVerificationReady(task, project, changedPaths) {
  const request = String(task || "").toLowerCase();
  const changed = [...changedPaths].map(path => String(path).toLowerCase());
  const expectsHtml = /\bhtml?\b/.test(request) || changed.some(path => /\.html?$/.test(path));
  const expectsJs = /\b(?:javascript|js)\b/.test(request);
  const expectsCss = /\bcss\b/.test(request);
  const changedType = (pattern) => changed.some(path => pattern.test(path));
  const hasType = (pattern) => project.listPaths().some(path => pattern.test(String(path)));

  if (expectsHtml && !changedType(/\.html?$/)) return false;
  if (expectsJs && !changedType(/\.(?:js|mjs)$/)) return false;
  if (expectsCss && !changedType(/\.css$/)) return false;
  if (expectsHtml && !hasType(/\.html?$/)) return false;
  return true;
}

function webVerificationPrompt(task, project, changedPaths) {
  if (webVerificationReady(task, project, changedPaths)) {
    const entry = project.listPaths().find(path => /\.html?$/i.test(path)) || "index.html";
    return `<environment>Web files are assembled, but the project has not passed its final preview check. Call \`run_web\` now with the HTML entry \`${entry}\`. Inspect the console and behavioral probe result, repair any runtime, rendering, or interaction failure, and only then give the final answer. Do not emit \`\`\`answer until \`run_web\` succeeds.</environment>`;
  }
  return `<environment>The web project is still being assembled. Do not finalize yet. Continue writing every requested HTML, CSS, and JavaScript file with a tool call. After the requested files are complete, call \`run_web\` and inspect the result before giving the final answer.</environment>`;
}

function interactiveWebTask(task) {
  return /\b(?:app|button|click|control|game|interactive|keyboard|playable|tetris)\b/i.test(String(task || ""));
}

function webProbeFailure(task, result) {
  if (!interactiveWebTask(task)) return "";
  const probe = result?.probe;
  if (!probe) return "behavioral probe did not return a result";
  if (!probe.rendered) return "the preview did not report visible rendered content";
  if (!probe.interactive) return "the preview did not report an observable response to its launch control or keyboard input";
  if (/\btetris\b/i.test(String(task || ""))) {
    const board = probe.state?.board;
    const canvasBoard = probe.state?.canvasCount > 0 && probe.state?.canvasVisible;
    if (!canvasBoard && (!board || board.columns !== 10 || board.rows !== 20 || board.children !== 200)) {
      return "the Tetris preview did not report a 10x20 board with 200 cells or a visible canvas board";
    }
    if (!probe.keyboardChanged) return "the Tetris preview did not report keyboard movement or rotation";
  }
  return "";
}

function snapshotProject(project) {
  const out = {};
  for (const [k, v] of project.files) out[k] = v.content;
  return out;
}

export async function runHarness({
  project,
  task,
  selection,
  attachments = [],
  history = [],
  signal,
  maxSteps = MAX_HARNESS_STEPS,
  maxNewTokens = null,
  onEvent,
  executors,
  onSnapshot,
  generateTurn = streamGeneration,
}) {
  const arch = Number(modelService.capabilities?.architecturalMax) || 131072;
  const effectiveRaw = Number(modelService.capabilities?.effectiveContextMax) || arch;
  const contextLimit = selectedContextLimit(arch);
  const effectiveLimit = Math.min(effectiveRaw, contextLimit);
  const stepLimit = Math.min(MAX_HARNESS_STEPS, Math.max(1, Math.floor(Number(maxSteps) || MAX_HARNESS_STEPS)));

  const mergedAttachments = [...(attachments || [])];

  let messages = [...history];
  const { tools, byName, toolSpecPrompt } = createTools({ project, executors });

  const undoStack = [];
  let dirty = true;
  let lastFileHash = hashProject(project);
  let systemPrompt = "";
  let ctxMeta = { mode: "none", estTokensUsed: 0, budgetTokens: 0 };

  async function rebuildSystem() {
    const queryExtra = [...mergedAttachments.map(a => a.text.slice(0, 300)), selection?.text?.slice(0, 300) || ""].filter(Boolean).join(" ");
    const promptArgs = {
      toolSpecPrompt,
      selection, attachments: mergedAttachments,
      arch, effectiveLimit, contextLimit
    };
    const basePrompt = buildSystemPrompt({
      ...promptArgs,
      fileBlocks: "(no files in project)",
      fileModeNote: "Project empty",
      fileTokens: 0,
      fileBudget: 0,
    });
    const baseTokens = await countTokensForMessages(thinkMessages([
      { role: "system", content: basePrompt },
      ...messages,
      { role: "user", content: task },
    ]));
    let fileBudget = Math.max(0, effectiveLimit - baseTokens - RESPONSE_TOKEN_RESERVE - 800);
    let ctx = null;
    let promptTokens = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      ctx = buildCodeContext({ project, query: task + " " + queryExtra.slice(0, 600), budget: fileBudget });
      const filesBlock = ctx.blocks.length ? renderCodeContextBlocks(ctx.blocks) : "(no files in project)";
      const modeNote = ctx.mode === "bm25" ? "Some files retrieved via keyword search (budget exceeded)" : ctx.mode === "stuff" ? "All files included" : "Project empty";
      systemPrompt = buildSystemPrompt({
        ...promptArgs,
        fileBlocks: filesBlock,
        fileModeNote: modeNote,
        fileTokens: ctx.estTokensUsed,
        fileBudget: ctx.budgetTokens,
      });
      promptTokens = await countTokensForMessages(thinkMessages([
        { role: "system", content: systemPrompt },
        ...messages,
        { role: "user", content: task },
      ]));
      const excess = promptTokens + RESPONSE_TOKEN_RESERVE - effectiveLimit;
      if (excess <= 0 || fileBudget <= 0) break;
      const nextBudget = Math.max(0, fileBudget - excess);
      if (nextBudget >= fileBudget) break;
      fileBudget = nextBudget;
    }
    ctxMeta = ctx || { mode: "none", estTokensUsed: 0, budgetTokens: fileBudget };
    dirty = false;
    lastFileHash = hashProject(project);
    return systemPrompt;
  }

  await rebuildSystem();

  // Pre-compaction
  const compactPre = await compactHistoryIfNeeded({ messages: [...messages, { role: "user", content: task }], systemPrompt, effectiveLimit, signal });
  if (compactPre.compacted) {
    const head = compactPre.messages.slice(0, -1);
    messages = head;
    onEvent?.({ type: "compact", note: "History summarized to fit context window." });
    await rebuildSystem();
  }

  let allMessagesForModel = [{ role: "system", content: systemPrompt }, ...messages, { role: "user", content: task }];
  const steps = [];
  let finalAnswer = "";
  let toolsExecutedCount = 0;
  let successfulMutationCount = 0;
  let partialMutationPending = null;
  let verificationPending = null;
  let lastObservation = "";
  let formatRetryCount = 0;
  let contextRetryCount = 0;
  let noProgressTurns = 0;
  let canonicalTasks = [];
  const webMutationPaths = new Set();
  const repeatedCallCounts = new Map();
  const taskRequiresAction = /\b(add|apply|build|change|create|delete|fix|implement|make|modify|refactor|remove|rewrite|update|write)\b/i.test(task);

  for (let step = 1; step <= stepLimit; step++) {
    if (signal?.aborted) break;

    // Check if project files changed
    const curHash = hashProject(project);
    if (curHash !== lastFileHash) dirty = true;
    if (dirty) {
      await rebuildSystem();
      allMessagesForModel[0] = { role: "system", content: systemPrompt };
    }

    onEvent?.({ type: "step", step, of: stepLimit, effectiveLimit, contextLimit, ctxMeta });

    // Mid-loop compaction check
    const unboundedGenerationMessages = thinkMessages(allMessagesForModel);
    let generationMessages = boundModelInput(unboundedGenerationMessages);
    if (generationMessages !== unboundedGenerationMessages) {
      onEvent?.({ type: "context_truncated", step, maxChars: MAX_HARNESS_INPUT_CHARS });
    }
    let countNow = await countTokensForMessages(generationMessages);
    if (countNow + RESPONSE_TOKEN_RESERVE + 1 > effectiveLimit) {
      const withoutSystem = allMessagesForModel.slice(1);
      const compacted = await compactHistoryIfNeeded({ messages: withoutSystem, systemPrompt, effectiveLimit, signal });
      if (compacted.compacted) {
        allMessagesForModel = [{ role: "system", content: systemPrompt }, ...compacted.messages];
        const unboundedCompactedMessages = thinkMessages(allMessagesForModel);
        generationMessages = boundModelInput(unboundedCompactedMessages);
        countNow = await countTokensForMessages(generationMessages);
        if (generationMessages !== unboundedCompactedMessages) {
          onEvent?.({ type: "context_truncated", step, maxChars: MAX_HARNESS_INPUT_CHARS });
        }
        onEvent?.({ type: "compact", note: "Mid-loop context compaction." });
      }
    }

    // Generate LLM turn with full available token capacity
    let thinkingText = "";
    let answerText = "";
    let fullReply = "";
    try {
      const requestedTokens = Number(maxNewTokens);
      const configuredTokens = Number.isFinite(requestedTokens) && requestedTokens > 0
        ? Math.floor(requestedTokens)
        : MAX_HARNESS_NEW_TOKENS;
      const availableTokens = Math.max(1, effectiveLimit - countNow - RESPONSE_TOKEN_RESERVE - 1);
      const tokenBudget = Math.min(MAX_HARNESS_NEW_TOKENS, configuredTokens, availableTokens);
      const res = await generateTurn({
        messages: generationMessages,
        maxNewTokens: tokenBudget,
        contextMax: contextLimit,
        temperature: HARNESS_TEMPERATURE,
        signal,

        onToken: ({ thinkingText: tt, answerText: at, delta }) => {
          if (tt !== undefined) thinkingText = tt;
          if (at !== undefined) answerText = at;
          onEvent?.({ type: "thinking_delta", thinkingText: tt, answerText: at, delta, step });
        }
      });
      thinkingText = res.thinkingText || "";
      answerText = res.answerText || "";
      fullReply = res.reply || answerText || "";
      contextRetryCount = 0;
      onEvent?.({ type: "model_raw", step, raw: fullReply, thinking: thinkingText, answerText });
    } catch (err) {
      if (err?.code === "context_limit" || err?.name === "ContextLimitError") {
        const withoutSystem = allMessagesForModel.slice(1);
        const compacted = await compactHistoryIfNeeded({ messages: withoutSystem, systemPrompt, effectiveLimit: Math.floor(effectiveLimit * 0.85), signal });
        if (compacted.compacted && contextRetryCount < 1) {
          allMessagesForModel = [{ role: "system", content: systemPrompt }, ...compacted.messages];
          onEvent?.({ type: "compact", note: "Recovered from context limit." });
          contextRetryCount++;
          continue;
        }
        const message = "Context limit reached. Please simplify the request or reset conversation.";
        onEvent?.({ type: "loop_break", step, note: message });
        return { ok: false, steps, answer: finalAnswer, error: message, allMessages: allMessagesForModel, truncated: true, undoStack };
      }
      throw err;
    }

    const hasThoughtChannel = Boolean(modelService.thoughtTokenIds);
    const rawForParse = String(answerText || (!hasThoughtChannel ? fullReply : "")).trim();

    // Extract and track task list (Pi pattern)
    const detectedTasks = extractTaskList(thinkingText + "\n" + rawForParse);
    if (detectedTasks.length > 0) {
      canonicalTasks = mergeTasks(canonicalTasks, detectedTasks);
      onEvent?.({ type: "tasks", tasks: canonicalTasks, step });
    }

    const pendingTasks = canonicalTasks.filter(t => !t.done);
    const allApprovedTasksDone = canonicalTasks.length > 0 && canonicalTasks.every(t => t.done);

    // Check for explicit answer fence
    if (hasAnswer(rawForParse)) {
      if (verificationPending === "web" && executors?.runWeb && step < stepLimit) {
        const prompt = webVerificationPrompt(task, project, webMutationPaths);
        allMessagesForModel.push({ role: "assistant", content: rawForParse });
        allMessagesForModel.push({ role: "user", content: prompt });
        onEvent?.({ type: "instruction", step, text: prompt, note: webVerificationReady(task, project, webMutationPaths) ? "Final web preview required." : "Waiting for requested web files before preview." });
        continue;
      }
      // Task enforcement: if tasks are still pending, prompt the model to check if it's ready to check them off
      if (canonicalTasks.length > 0 && pendingTasks.length > 0 && step < stepLimit) {
        const prompt = `<environment>Task Checklist Check:
The following task(s) in your approved plan are still unchecked:
${pendingTasks.map(t => `- [ ] ${t.title}`).join("\n")}

Please evaluate:
1. If these tasks are already implemented and verified, show your updated Plan with \`- [x]\` for each completed item, and provide your final summary inside \`\`\`answer.
2. If any task is still incomplete or needs fixes, proceed to implement the code now using \`call:write_file\` or \`call:apply_patch\`.</environment>`;
        allMessagesForModel.push({ role: "assistant", content: rawForParse });
        allMessagesForModel.push({ role: "user", content: prompt });
        onEvent?.({ type: "instruction", step, text: prompt, note: `Task enforcement: ${pendingTasks.length} task(s) unchecked. Prompted model to verify/check off.` });
        continue;
      }

      if (!taskRequiresAction || (successfulMutationCount > 0 && !partialMutationPending && !verificationPending) || (allApprovedTasksDone && !verificationPending)) {
        finalAnswer = extractAnswer(rawForParse);
        allMessagesForModel.push({ role: "assistant", content: rawForParse });
        onEvent?.({ type: "answer", step, answer: finalAnswer });
        return { ok: true, steps, answer: finalAnswer, allMessages: allMessagesForModel, undoStack };
      }
    }

    // Extract tool calls (Gemma 4 canonical, <tool> JSON, fenced JSON, naked JSON, code blocks, truncated)
    const extractedCalls = extractToolCalls(rawForParse, { task, project });
    // Post-parse sanitization: strip outer fences from file content args before execution
    for (const c of extractedCalls) {
      if (c.args) {
        if (c.args.content != null) c.args.content = sanitizeFileContent(String(c.args.content));
        if (c.args.code != null) c.args.code = sanitizeFileContent(String(c.args.code));
        if (c.args.patch != null) c.args.patch = sanitizeFileContent(String(c.args.patch));
        if (c.args.diff != null) c.args.diff = sanitizeFileContent(String(c.args.diff));
      }
    }
    const calls = extractedCalls.slice(0, 1);

    // If no tool call found
    if (calls.length === 0) {
      if (verificationPending === "web" && executors?.runWeb && step < stepLimit) {
        const prompt = webVerificationPrompt(task, project, webMutationPaths);
        allMessagesForModel.push({ role: "assistant", content: rawForParse });
        allMessagesForModel.push({ role: "user", content: prompt });
        onEvent?.({ type: "instruction", step, text: prompt, note: "Web preview required before completion." });
        continue;
      }
      // Aimed Green-Light Check: when all approved tasks are complete, ask model for explicit final sign-off
      if (allApprovedTasksDone && step < stepLimit && successfulMutationCount > 0 && !verificationPending && !hasAnswer(rawForParse)) {
        const greenLightPrompt = `<environment>Task Verification & Green-Light Check:
All tasks in your approved plan are complete and verified:
${canonicalTasks.map((t, i) => `- [x] ${i + 1}. ${t.title}`).join("\n")}

Current Workspace State:
- Files: ${project.listPaths().join(", ")}
- Latest Runtime Verification: Success (verified without errors).

Do you give the FINAL GREEN LIGHT that the project is completely implemented, verified, and ready?
- If YES: Explain your verification and wrap your final response inside \`\`\`answer.
- If NO / ISSUES REMAIN: Specify what is missing or broken and execute the fix now using a tool call.</environment>`;
        allMessagesForModel.push({ role: "assistant", content: rawForParse });
        allMessagesForModel.push({ role: "user", content: greenLightPrompt });
        onEvent?.({ type: "instruction", step, text: greenLightPrompt, note: "Aimed Green-Light self-evaluation question sent to agent." });
        continue;
      }

      // If model generated a plan in step 1, register and prompt for step 1 execution
      if (canonicalTasks.length > 0 && step === 1 && successfulMutationCount === 0) {
        const firstTask = canonicalTasks.find(t => !t.done) || canonicalTasks[0];
        const nextPrompt = `<environment>Plan registered (${canonicalTasks.length} tasks).
Active Task: ${firstTask.title}
Please proceed to implement this task using \`call:write_file{path:<|"|>...<|"|>,content:<|"|>...<|"|>}\` or \`<tool>{"name":"write_file","args":{"path":"...","content":"..."}}</tool>\`. Do not wrap code inside markdown fences.</environment>`;
        allMessagesForModel.push({ role: "assistant", content: rawForParse });
        allMessagesForModel.push({ role: "user", content: nextPrompt });
        onEvent?.({ type: "instruction", step, text: nextPrompt, note: `Plan registered: proceeding with ${firstTask.title}` });
        continue;
      }


      // If code was already written & verified
      if (successfulMutationCount > 0 && !partialMutationPending && !verificationPending) {
        if (canonicalTasks.length > 0 && pendingTasks.length > 0 && step < stepLimit) {
          const prompt = `<environment>Task Checklist Check:
The following task(s) in your approved plan are still unchecked:
${pendingTasks.map(t => `- [ ] ${t.title}`).join("\n")}

Please evaluate:
1. If these tasks are complete and verified, show your updated Plan with \`- [x]\` and conclude in \`\`\`answer.
2. If any task remains, implement it using \`call:write_file\` or \`call:apply_patch\`.</environment>`;
          allMessagesForModel.push({ role: "assistant", content: rawForParse });
          allMessagesForModel.push({ role: "user", content: prompt });
          onEvent?.({ type: "instruction", step, text: prompt, note: `Task enforcement: prompting model to evaluate ${pendingTasks.length} unchecked task(s).` });
          continue;
        }

        finalAnswer = cleanProse(rawForParse) || "Task completed successfully.";
        allMessagesForModel.push({ role: "assistant", content: rawForParse });
        onEvent?.({ type: "answer", step, answer: finalAnswer });
        return { ok: true, steps, answer: finalAnswer, allMessages: allMessagesForModel, undoStack };
      }


      // If action is required but no mutations occurred yet and step is past 1
      if (taskRequiresAction && step >= 2 && successfulMutationCount === 0 && !looksLikeFinalAnswer(rawForParse)) {
        const reprompt = `<environment>Please implement the requested file or changes using \`call:write_file{path:<|"|>filename<|"|>,content:<|"|>...<|"|>}\` or \`<tool>{"name":"write_file","args":{"path":"filename","content":"..."}}</tool>\`. Do not wrap code inside markdown fences.</environment>`;
        allMessagesForModel.push({ role: "assistant", content: rawForParse });
        allMessagesForModel.push({ role: "user", content: reprompt });
        onEvent?.({ type: "instruction", step, text: reprompt, note: "Prompted model for file creation." });
        continue;
      }

      formatRetryCount++;
      if (formatRetryCount >= 3) {
        if (successfulMutationCount > 0 && !partialMutationPending && !verificationPending) {
          finalAnswer = cleanProse(rawForParse) || "Task completed.";
          allMessagesForModel.push({ role: "assistant", content: rawForParse });
          onEvent?.({ type: "answer", step, answer: finalAnswer });
          return { ok: true, steps, answer: finalAnswer, allMessages: allMessagesForModel, undoStack };
        }
        const message = verificationPending
          ? `Runtime verification failed for ${verificationPending === true ? "the changed files" : verificationPending}.`
          : "No code or action was emitted by the model.";
        allMessagesForModel.push({ role: "assistant", content: rawForParse });
        onEvent?.({ type: "loop_break", step, note: message });
        return { ok: false, steps, answer: finalAnswer, error: message, allMessages: allMessagesForModel, truncated: true, undoStack };
      }

      const nudge = `<environment>Please write the code file now using \`call:write_file{path:<|"|>filename<|"|>,content:<|"|>...<|"|>}\` or \`<tool>{"name":"write_file","args":{"path":"filename","content":"..."}}</tool>\`. Do not wrap code inside markdown fences.</environment>`;
      allMessagesForModel.push({ role: "assistant", content: rawForParse });
      allMessagesForModel.push({ role: "user", content: nudge });
      onEvent?.({ type: "nudge", step, note: "Prompted model for file creation." });
      continue;
    }

    formatRetryCount = 0;

    // Check repeated calls against identical project state
    const h = hashCalls(calls);
    const progressKey = `${hashProject(project)}::${h}`;
    const repeatedCount = repeatedCallCounts.get(progressKey) || 0;
    repeatedCallCounts.set(progressKey, repeatedCount + 1);
    if (repeatedCount >= 3) {
      const msg = `Repeated tool call without project change.`;
      allMessagesForModel.push({ role: "assistant", content: rawForParse });
      onEvent?.({ type: "loop_break", step, note: msg });
      return { ok: false, steps, answer: finalAnswer, error: msg, allMessages: allMessagesForModel, truncated: true, undoStack };
    }


    const assistantTurn = calls.some(call => call.partial)
      ? `[Harness recovered a truncated ${calls[0].name} prefix for ${calls[0].args.path}]`
      : rawForParse;
    allMessagesForModel.push({ role: "assistant", content: assistantTurn });
    const results = [];
    let hadMutationThisTurn = false;
    let mutationSucceededThisTurn = false;
    let verificationResult = null;

    for (const rawCall of calls) {
      const call = rawCall;
      onEvent?.({ type: "tool_call", step, call });

      const perm = permissionFor(call.name);
      if (perm === "ask" && executors?.requestPermission) {
        const decision = await executors.requestPermission(call);
        if (decision === "deny") {
          const res = { name: call.name, ok: false, output: "Action denied by user." };
          results.push(res);
          onEvent?.({ type: "tool_result", step, call, result: res });
          continue;
        }
      }

      const tool = byName.get(call.name);
      if (!tool) {
        const res = { name: call.name, ok: false, output: `Error: Unknown tool "${call.name}". Available: ${tools.map(t=>t.name).join(", ")}` };
        results.push(res);
        onEvent?.({ type: "tool_result", step, call, result: res });
        continue;
      }

      let validArgs = true;
      let validationError = "";
      try {
        validArgs = await tool.validate(call.args);
      } catch (error) {
        validArgs = false;
        validationError = String(error?.message ?? error);
      }
      if (!validArgs) {
        const res = {
          name: call.name,
          ok: false,
          output: `Error: Invalid arguments${validationError ? ` (${validationError})` : ""}.`,
        };
        results.push(res);
        toolsExecutedCount++;
        onEvent?.({ type: "tool_result", step, call, result: res });
        continue;
      }

      // Snapshot before mutation
      let preSnap = null;
      const projectMutation = isProjectMutation(call.name);
      if (projectMutation) {
        preSnap = snapshotProject(project);
        hadMutationThisTurn = true;
      }

      let res;
      try {
        res = await tool.execute(call.args);
        if (!res || typeof res.ok !== "boolean") res = { name: call.name, ok: true, output: String(res?.output ?? res ?? "") };
        else res.name = call.name;
        if (res.ok && call.name === "run_web") {
          const probeFailure = webProbeFailure(task, res);
          if (probeFailure) {
            res = { ...res, ok: false, output: `${res.output || ""}\nverification: FAILURE - ${probeFailure}` };
          }
        }
        if (res.ok && call.partial) {
          partialMutationPending = { path: call.args.path, name: call.name };
        } else if (res.ok && partialMutationPending?.path === call.args.path) {
          partialMutationPending = null;
        }
        if (res.ok && (call.name === "run_python" || call.name === "run_web") && verificationPending) {
          const verifiedPath = call.args.path || call.args.entry;
            if (call.name === "run_web" && verificationPending === "web") {
              verificationPending = null;
            } else if (verificationPending === true || (verifiedPath && String(verifiedPath) === String(verificationPending))) {
            verificationPending = null;
          }
        }
      } catch (e) {
        res = { name: call.name, ok: false, output: `Error: ${String(e?.message ?? e)}` };
      }

      if (res.ok && projectMutation) {
        mutationSucceededThisTurn = true;
        successfulMutationCount++;
        dirty = true;
        undoStack.push(preSnap);
        onSnapshot?.(preSnap);
        if (isWebPath(call.args.path)) {
          webMutationPaths.add(String(call.args.path));
          verificationPending = "web";
        } else {
          verificationPending = call.args.path || true;
        }

        // Auto-mark completed task in approved plan when file specifically matches
        if (canonicalTasks.length > 0) {
          const filePath = String(call.args.path || "").toLowerCase();
          const targetTask = canonicalTasks.find(t => !t.done && (
            (filePath && t.title.toLowerCase().includes(filePath)) ||
            (filePath.endsWith(".html") && (t.title.toLowerCase().includes(".html") || t.title.toLowerCase().includes(" html"))) ||
            (filePath.endsWith(".css") && (t.title.toLowerCase().includes(".css") || t.title.toLowerCase().includes(" css"))) ||
            (filePath.endsWith(".js") && (t.title.toLowerCase().includes(".js") || t.title.toLowerCase().includes(" js")))
          ));

          if (targetTask) {
            targetTask.done = true;
            targetTask.inProgress = false;
            onEvent?.({ type: "tasks", tasks: canonicalTasks, step });
          }
        }
      }


      results.push(res);
      toolsExecutedCount++;
      onEvent?.({ type: "tool_result", step, call, result: res });
    }


    const webMutationThisTurn = mutationSucceededThisTurn && calls.some(call => isWebPath(call.args?.path));

    // Web files are often written in separate turns. Verifying after the first
    // file runs the remaining old files and produces a misleading failure.
    if (hadMutationThisTurn && mutationSucceededThisTurn && calls[0]?.args?.path && !webMutationThisTurn) {
      const changedPath = calls[0].args.path;
      const verifyRes = await verifyChangedFile(changedPath, executors);
      if (verifyRes) {
        verificationResult = verifyRes.result;
        verificationPending = verifyRes.result.ok ? null : changedPath;
        results.push(verifyRes.result);
        onEvent?.({ type: "tool_result", step, call: { name: verifyRes.name, args: verifyRes.args }, result: verifyRes.result });
      }
    }

    // Format tool results for Gemma
    const toolResultBlocks = results.map(r => `<tool_result name="${r.name}" ok="${r.ok}">${r.output}</tool_result>`).join("\n");
    lastObservation = toolResultBlocks;
    allMessagesForModel.push({ role: "user", content: toolResultBlocks });

    steps.push({ step, calls, results });

    if (mutationSucceededThisTurn && !verificationResult && !webMutationThisTurn) {
      verificationPending = null;
    }
  }


  return { ok: false, steps, answer: finalAnswer, allMessages: allMessagesForModel, truncated: true, undoStack };
}

function boundModelInput(messages, limit = MAX_HARNESS_INPUT_CHARS) {
  const source = Array.isArray(messages) ? messages : [];
  const totalChars = source.reduce((total, message) => total + (typeof message?.content === "string" ? message.content.length : 0), 0);
  if (totalChars <= limit) return source;

  const firstConversationIndex = source.findIndex(message => message?.role !== "system");
  const prefixEnd = firstConversationIndex < 0 ? source.length : firstConversationIndex;
  const prefix = source.slice(0, prefixEnd);
  const prefixChars = prefix.reduce((total, message) => total + (typeof message?.content === "string" ? message.content.length : 0), 0);
  const prefixBudget = Math.min(prefixChars, Math.floor(limit * 0.7));
  const boundedPrefix = [];
  let remainingPrefix = prefixBudget;
  for (const message of prefix) {
    if (typeof message.content !== "string" || message.content.length <= remainingPrefix) {
      boundedPrefix.push(message);
      if (typeof message.content === "string") remainingPrefix -= message.content.length;
      continue;
    }
    boundedPrefix.push({ ...message, content: truncateMessage(message.content, remainingPrefix, false) });
    remainingPrefix = 0;
    break;
  }

  let remaining = limit - boundedPrefix.reduce((total, message) => total + (typeof message?.content === "string" ? message.content.length : 0), 0);
  const tail = [];
  for (let index = source.length - 1; index >= prefixEnd && remaining > 0; index--) {
    const message = source[index];
    if (typeof message.content !== "string" || message.content.length <= remaining) {
      tail.push(message);
      if (typeof message.content === "string") remaining -= message.content.length;
      continue;
    }
    tail.push({ ...message, content: truncateMessage(message.content, remaining, message.role !== "user") });
    remaining = 0;
  }

  return [...boundedPrefix, ...tail.reverse()];
}

function truncateMessage(content, limit, fromEnd) {
  if (limit <= 0) return "";
  if (content.length <= limit) return content;
  const marker = "\n[context truncated]";
  if (limit <= marker.length) return marker.slice(0, limit);
  const contentLimit = limit - marker.length;
  return fromEnd ? `${marker}${content.slice(-contentLimit)}` : `${content.slice(0, contentLimit)}${marker}`;
}

function verificationToolFor(path, executors) {
  const value = String(path || "");
  if (/\.(?:py|pyw)$/i.test(value) && executors?.runPython) return "run_python";
  if (/\.(?:html?|css|js|mjs|jsx|tsx?)$/i.test(value) && executors?.runWeb) return "run_web";
  return null;
}

async function verifyChangedFile(path, executors) {
  const value = String(path || "");
  const tool = verificationToolFor(value, executors);
  if (!tool) return null;
  try {
    if (tool === "run_python") {
      const result = await executors.runPython(value, { path: value, code: null, nonInteractive: true });
      const ok = Boolean(result?.ok && !result?.error);
      return {
        name: tool,
        args: { path: value },
        result: { name: tool, ok, output: formatVerificationOutput({ ...result, ok }) },
      };
    }
    const entry = value.toLowerCase().endsWith(".html") || value.toLowerCase().endsWith(".htm") ? value : "index.html";
    const result = await executors.runWeb(entry);
    const hasErr = !result?.ok || Boolean(result?.error) || (result?.log && /\[error\]|uncaught\s+\w*error/i.test(result.log));
    const ok = !hasErr;
    return {
      name: tool,
      args: { entry },
      result: { name: tool, ok, output: formatVerificationOutput({ ...result, ok }) },
    };
  } catch (error) {
    return { name: tool, args: { path: value }, result: { name: tool, ok: false, output: `Verification error: ${String(error?.message ?? error)}` } };
  }
}

function formatVerificationOutput(result) {
  if (!result) return "No verification output.";
  const parts = [];
  if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  if (result.result) parts.push(`result: ${result.result}`);
  if (result.error) parts.push(`error:\n${result.error}`);
  if (result.log) parts.push(`console:\n${result.log}`);

  const hasRuntimeError = !result.ok || Boolean(result.error) || (result.log && /\[error\]|uncaught\s+\w*error/i.test(result.log));
  if (hasRuntimeError) {
    parts.push("verification: FAILURE — runtime/syntax error detected. Please evaluate the error output and repair the file.");
  } else {
    parts.push("verification: execution completed. Please evaluate the output above to confirm expected behavior.");
  }
  return parts.join("\n");
}


function hashProject(project) {
  try {
    let hash = 2166136261;
    for (const [path, file] of [...project.files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const value = `${path}\0${file.content ?? ""}\0`;
      for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    }
    return (hash >>> 0).toString(16);
  } catch { return String(Date.now()); }
}

export function extractTaskList(text) {
  const tasks = [];
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*-\s*\[([ x/])\]\s*(.+)$/i);
    if (m) {
      tasks.push({
        done: m[1].toLowerCase() === "x",
        inProgress: m[1] === "/",
        title: m[2].trim(),
      });
    }
  }
  return tasks;
}

export function mergeTasks(existing = [], detected = []) {
  if (!detected || detected.length === 0) return existing || [];
  if (!existing || existing.length === 0) return detected;

  const merged = existing.map(e => ({ ...e }));
  for (const dt of detected) {
    // 1. Try matching by numerical step index (e.g. "1. ..." or "2. ...")
    const numMatch = dt.title.match(/^(\d+)[\.\)]/);
    if (numMatch) {
      const idx = parseInt(numMatch[1], 10) - 1;
      if (idx >= 0 && idx < merged.length) {
        if (dt.done) merged[idx].done = true;
        if (dt.inProgress) merged[idx].inProgress = true;
        continue;
      }
    }

    // 2. Try matching by title similarity / file reference
    const dtClean = dt.title.replace(/^\d+[\.\)]\s*/, "").trim().toLowerCase();
    const match = merged.find(et => {
      const etClean = et.title.replace(/^\d+[\.\)]\s*/, "").trim().toLowerCase();
      return etClean === dtClean || etClean.includes(dtClean) || dtClean.includes(etClean);
    });
    if (match) {
      if (dt.done) match.done = true;
      if (dt.inProgress) match.inProgress = true;
    }
  }
  return merged;
}

export const runCodeHarness = runHarness;




