import { streamGeneration } from "../services/generation.js";
import { thinkMessages } from "../services/settings.js";
import { modelService } from "../services/model-service.js";
import { selectedContextLimit } from "../services/context-preference.js";
import { createTools } from "../harness/tools/registry.js";
import { isMutating, permissionFor } from "../harness/permissions.js";
import { buildActionPrompt, buildPlanningPrompt, buildReflectionPrompt } from "../harness/prompts.js";
import { parseAskHuman, parsePlan, parseReflectionStatus, parseToolCall, parseToolCallFromThinking } from "./protocol.js";

const MAX_TURNS = 16;
const MAX_PLAN_ATTEMPTS = 2;
const MAX_ACTION_FORMAT_RETRIES = 3;
const MAX_ACTION_SELECTION_RETRIES = 3;
const MAX_NEW_TOKENS = 16192;
const MAX_PROMPT_CHARS = 64768;
const MAX_OBSERVATION_CHARS = 4000;
const MAX_CONTEXT_CHARS = 16192;
const MAX_EXPLICIT_CONTEXT_CHARS = 16192;
const MAX_HISTORY_CHARS = 16192;
const MAX_HUMAN_RESPONSE_CHARS = 4096;

export async function runAgent({
  project,
  task,
  selection,
  attachments = [],
  history = [],
  signal,
  maxSteps = MAX_TURNS,
  maxNewTokens = MAX_NEW_TOKENS,
  onEvent,
  executors,
  onSnapshot,
  autonomous = false,
  generateTurn = streamGeneration,
}) {
  const stepLimit = Math.min(MAX_TURNS, Math.max(1, Math.floor(Number(maxSteps) || MAX_TURNS)));
  const originalTask = String(task || "").trim();
  const arch = Number(modelService.capabilities?.architecturalMax) || 131_072;
  const contextLimit = selectedContextLimit(arch);
  const effectiveLimit = Math.min(
    Number(modelService.capabilities?.effectiveContextMax) || arch,
    contextLimit,
  );
  const { tools, byName } = createTools({ project, executors });
  const steps = [];
  const tasks = [];
  const summaries = [];
  const readFilesMap = new Map();
  let turn = 0;
  let attemptsOnCurrentGoal = 0;

  const emitTasks = () => onEvent?.({
    type: "tasks",
    tasks: tasks.map(item => ({ ...item })),
    step: turn,
  });

  const explicitContext = buildExplicitContext(selection, attachments);
  const imageAttachments = (attachments || []).filter(attachment =>
    attachment?.type === "image" && typeof attachment.url === "string" && attachment.url
  );
  const historyText = boundText((history || []).slice(-4)
    .map(message => `${message.role}: ${String(message.content || "")}`)
    .join("\n"), MAX_HISTORY_CHARS);

  const generatePhase = async ({ phase, prompt, stopSequences, phaseMaxNewTokens = null }) => {
    if (signal?.aborted) return null;
    if (turn >= stepLimit) return null;
    turn += 1;
    onEvent?.({ type: "step", step: turn, of: stepLimit, effectiveLimit, contextLimit, ctxMeta: { mode: "fresh" }, phase });
    const phaseMessages = [
      { role: "system", content: prompt },
      { role: "user", content: phase === "planning"
        ? phaseUserContent("Create the requested checklist.", phase)
        : phase === "action"
          ? phaseUserContent("Perform the current micro-goal with one action or ask for human guidance.", phase)
          : "Return the verification status for the executed action." },
    ];
    const messages = boundMessages(phase === "reflection" ? phaseMessages : thinkMessages(phaseMessages));
    onEvent?.({
      type: "prompt",
      step: turn,
      phase,
      messages: messages.map(message => ({
        role: message.role,
        content: describePromptContent(message.content),
      })),
    });
    const requested = Number(phaseMaxNewTokens ?? maxNewTokens);
    const tokenBudget = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : MAX_NEW_TOKENS;
    let thinkingText = "";
    let answerText = "";
    const result = await generateTurn({
      messages,
      maxNewTokens: tokenBudget,
      contextMax: contextLimit,
      signal,
      stopSequences,
      onToken: ({ thinkingText: thinking, answerText: answer, delta }) => {
        thinkingText = thinking ?? thinkingText;
        answerText = answer ?? answerText;
        onEvent?.({ type: "thinking_delta", thinkingText, answerText, delta, step: turn, phase });
      },
    });
    thinkingText = result?.thinkingText || thinkingText;
    answerText = result?.answerText || answerText;
    // With thought tokens, answerText is authoritative. In tests and older
    // engines without thought channels, reply is the only available channel.
    const hasThoughtChannel = Boolean(modelService.thoughtTokenIds);
    const answer = String(answerText || (!hasThoughtChannel ? result?.reply || "" : "")).trim();
    onEvent?.({ type: "model_raw", step: turn, phase, raw: answer, thinking: thinkingText, answerText: answer });
    return { answer, thinking: thinkingText };
  };

  const phaseUserContent = (text, phase) => {
    if (phase === "reflection" || imageAttachments.length === 0) return text;
    return [
      ...imageAttachments.map(image => ({ type: "image", url: image.url })),
      { type: "text", text },
    ];
  };

  const generatePlanning = () => generatePhase({
    phase: "planning",
    prompt: buildPlanningPrompt({
      objective: originalTask,
      history: historyText,
      explicitContext,
    }),
    stopSequences: [],
  });

  const generateAction = ({ microGoal, lastObservation, lastReflection, humanResponse }) => generatePhase({
    phase: "action",
    prompt: buildActionPrompt({
      objective: originalTask,
      microGoal,
      directorySummary: buildDirectorySummary(project),
      activeFileContext: boundText([
        renderReadFiles(readFilesMap),
        explicitContext ? `\nEXPLICIT USER CONTEXT:\n${explicitContext}` : "",
      ].join("\n"), MAX_CONTEXT_CHARS),
      lastObservation,
      lastReflection,
      humanResponse,
      tools,
    }),
    stopSequences: ["</tool>", "</ask_human>"],
    phaseMaxNewTokens: 8192,
  });

  const generateReflection = ({ microGoal, call, observation }) => generatePhase({
    phase: "reflection",
    prompt: buildReflectionPrompt({
      microGoal,
      toolName: call?.name,
      toolArgs: formatToolArgs(call?.args),
      observation,
    }),
    stopSequences: [],
    phaseMaxNewTokens: 192,
  });

  const autonomousDirective =
    "Continue on your own. Do not ask for help. Finish the current micro-goal with complete, working code — no placeholders or stubs. Verify the result with the appropriate tool before finishing.";

  const awaitHumanResponse = async (type, question, metadata = {}) => {
    onEvent?.({ type, question, step: turn, ...metadata });
    if (autonomous) {
      const answer = boundText(autonomousDirective, MAX_HUMAN_RESPONSE_CHARS);
      onEvent?.({ type: "human_response", question, content: answer, step: turn, ...metadata });
      return answer;
    }
    if (typeof executors?.awaitHumanResponse !== "function") return null;
    const response = await executors.awaitHumanResponse(question, { type, step: turn, ...metadata });
    const content = typeof response === "string" ? response : response?.content;
    if (!String(content || "").trim()) return null;
    const answer = boundText(content, MAX_HUMAN_RESPONSE_CHARS);
    onEvent?.({ type: "human_response", question, content: answer, step: turn, ...metadata });
    return answer;
  };

  try {
    let planResponse = null;
    for (let attempt = 0; attempt < MAX_PLAN_ATTEMPTS && turn < stepLimit; attempt += 1) {
      planResponse = await generatePlanning();
      const parsed = parsePlan(planResponse?.answer);
      if (parsed.length > 0) {
        tasks.push(...parsed.map(item => ({ ...item, done: false, inProgress: false })));
        break;
      }
      onEvent?.({ type: "instruction", step: turn, text: "The checklist was not readable. Return only lines like: - [ ] concrete task", note: "Planning format retry" });
    }

    if (tasks.length === 0) {
      tasks.push({ id: "task_1", title: originalTask || "Complete the requested change", done: false, inProgress: false });
      onEvent?.({ type: "instruction", step: turn, text: "No checklist was returned; the original request is being treated as one task.", note: "Controller fallback" });
    }
    emitTasks();

    const runGoal = async (item) => {
      item.inProgress = true;
      emitTasks();
      attemptsOnCurrentGoal = 0;
      let actionFormatRetries = 0;
      let actionSelectionRetries = 0;
      let lastObservation = "";
      let lastReflection = "";
      let humanResponse = "";

      while (!item.done && turn < stepLimit) {
        const response = await generateAction({
          microGoal: item.title,
          lastObservation,
          lastReflection,
          humanResponse,
        });
        if (!response) break;
        const question = parseAskHuman(response.answer);
        if (question) {
          actionFormatRetries = 0;
          humanResponse = await awaitHumanResponse("human_prompt", question, { task: item.title });
          if (!humanResponse) break;
          lastObservation = `Human response: ${humanResponse}`;
          continue;
        }

        const answerCall = parseToolCall(response.answer);
        const call = answerCall || parseToolCallFromThinking(response.thinking);
        if (!answerCall && call) {
          onEvent?.({ type: "action_recovered", step: turn, channel: "thinking" });
        }
        if (call && isImplementationGoal(item.title) && isDiscoveryTool(call.name) && actionSelectionRetries < MAX_ACTION_SELECTION_RETRIES) {
          actionSelectionRetries += 1;
          lastObservation = `Action rejected: ${call.name} only inspects the project; this micro-goal requires a file change.`;
          lastReflection = "Wrong tool for this goal. Use write_file or apply_patch now; do not list or search first.";
          onEvent?.({
            type: "instruction",
            step: turn,
            text: lastReflection,
            note: `Action selection retry ${actionSelectionRetries}`,
          });
          continue;
        }
        if (call && isVerificationGoal(item.title) && isFileWriteTool(call.name) && actionSelectionRetries < MAX_ACTION_SELECTION_RETRIES) {
          // A verification goal must end with a passing run_web. But if the most
          // recent run_web on this goal FAILED, the preview still needs repair —
          // allow the model to write the fix, then it must re-run the preview.
          // Only reject the write when no preview has been run yet (or the last
          // one passed), forcing the model to verify before it can finish.
          const lastRunWebResult = [...steps].reverse()
            .find(s => s.task === item.title && s.results.some(r => r.name === "run_web"))
            ?.results.find(r => r.name === "run_web");
          const lastRunWebFailed = lastRunWebResult && lastRunWebResult.ok === false;
          if (!lastRunWebFailed) {
            actionSelectionRetries += 1;
            lastObservation = `Action rejected: ${call.name} does not verify the preview; this micro-goal requires running the preview.`;
            lastReflection = "Wrong tool for this goal. Do not write files now; call run_web to run the preview and verify it works.";
            onEvent?.({
              type: "instruction",
              step: turn,
              text: lastReflection,
              note: `Action selection retry ${actionSelectionRetries}`,
            });
            continue;
          }
        }
        actionSelectionRetries = 0;
        if (!call && actionFormatRetries < MAX_ACTION_FORMAT_RETRIES) {
          actionFormatRetries += 1;
          lastObservation = "Action failed: no valid <tool> or <ask_human> block was returned.";
          lastReflection = "Action format error. Emit the required block immediately, with no reasoning or prose before it.";
          onEvent?.({
            type: "instruction",
            step: turn,
            text: lastReflection,
            note: `Action format retry ${actionFormatRetries}`,
          });
          continue;
        }
        actionFormatRetries = 0;
        const actionCall = call || { name: "(invalid action)", args: {} };
        const result = call
          ? await executeTool({ call, byName, tools, project, executors, task: originalTask, assignedTask: item.title, onSnapshot, onEvent, step: turn, onContext: ({ call: accessedCall, result: accessedResult }) => rememberToolContext(readFilesMap, project, accessedCall, accessedResult) })
          : invalidActionResult(onEvent, turn);
        steps.push({ step: turn, task: item.title, calls: call ? [call] : [], results: [result] });
        lastObservation = capObservation(formatObservation(result) + describeProbe(result.probe));

        const reflectionResponse = await generateReflection({ microGoal: item.title, call: actionCall, observation: lastObservation });
        if (!reflectionResponse) break;
        let reflection = parseReflectionStatus(reflectionResponse.answer);
        if (!result.ok && reflection.status === "COMPLETE") {
          reflection = { status: "RETRY", explanation: "The tool reported a failure, so the micro-goal is not complete." };
        }
        lastReflection = boundText(reflection.explanation, 1_800);
        onEvent?.({ type: "reflection", step: turn, task: item.title, ...reflection });

        if (reflection.status === "COMPLETE") {
          item.done = true;
          item.inProgress = false;
          attemptsOnCurrentGoal = 0;
          summaries.push(reflection.explanation === "No detailed explanation provided."
            ? `${call.name} completed successfully.\n${lastObservation}`
            : reflection.explanation);
          emitTasks();
          onEvent?.({ type: "task_done", step: turn, task: item.title, summary: reflection.explanation });
          break;
        }

        attemptsOnCurrentGoal += 1;
        onEvent?.({ type: "instruction", step: turn, text: lastReflection, note: `Reflection retry ${attemptsOnCurrentGoal}` });
        if (attemptsOnCurrentGoal >= 2) {
          const steeringQuestion = `The micro-goal has failed twice. How should I proceed?\n\n${lastReflection}`;
          humanResponse = await awaitHumanResponse("human_steering", steeringQuestion, {
            task: item.title,
            attempts: attemptsOnCurrentGoal,
          });
          if (!humanResponse) break;
          attemptsOnCurrentGoal = 0;
          lastObservation = `Human steering: ${humanResponse}`;
        }
      }

      if (!item.done) {
        item.inProgress = false;
        emitTasks();
        return { stopped: true, error: `Stopped before completing task: ${item.title}` };
      }
      return { stopped: false };
    };

    for (const item of tasks) {
      if (item.done) continue;
      const outcome = await runGoal(item);
      if (outcome.stopped) {
        return {
          ok: false,
          steps,
          answer: summaries.join("\n\n"),
          error: outcome.error,
          allMessages: [],
          truncated: true,
        };
      }
    }

    // The small model's planner often omits a verification step, so the controller
    // enforces it: for an interactive task, if run_web never succeeded, add a
    // final goal that runs and verifies the preview.
    const verificationNeeded = isInteractiveTask(originalTask) && !steps.some(step =>
      step.results.some(result => result.name === "run_web" && result.ok === true),
    );
    if (verificationNeeded && turn < stepLimit) {
      const verifyGoal = {
        id: "task_verify",
        title: "Run the web preview and verify it works",
        done: false,
        inProgress: false,
      };
      tasks.push(verifyGoal);
      onEvent?.({ type: "instruction", step: turn, text: "All code goals are done. Now run the preview and verify it works.", note: "Controller verification" });
      emitTasks();
      const outcome = await runGoal(verifyGoal);
      if (outcome.stopped) {
        return {
          ok: false,
          steps,
          answer: summaries.join("\n\n"),
          error: outcome.error,
          allMessages: [],
          truncated: true,
        };
      }
    }

    const answer = summaries.join("\n\n") || "Requested tasks completed.";
    onEvent?.({ type: "answer", step: turn, answer });
    return { ok: true, steps, answer, allMessages: [], undoStack: [] };
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") {
      return { ok: false, aborted: true, steps, answer: summaries.join("\n\n"), allMessages: [], undoStack: [] };
    }
    throw error;
  }
}

async function executeTool({ call, byName, tools, project, executors, task, assignedTask, onSnapshot, onEvent, step, onContext }) {
  onEvent?.({ type: "tool_call", step, call });
  const permission = permissionFor(call.name);
  if (permission === "ask") {
    const decision = await executors?.requestPermission?.(call);
    if (decision === "deny") {
      const result = { name: call.name, ok: false, output: "Action denied by user." };
      onEvent?.({ type: "tool_result", step, call, result });
      return result;
    }
    if (!decision) {
      const result = { name: call.name, ok: false, output: "Action denied by user." };
      onEvent?.({ type: "tool_result", step, call, result });
      return result;
    }
  }

  const tool = byName.get(call.name);
  if (!tool) return toolFailure(call, "Unknown tool.", onEvent, step);
  if (call.name === "run_web") {
    const requestedEntry = requestedHtmlEntry(`${task}\n${assignedTask}`);
    const entry = String(call.args?.entry || "index.html").trim();
    if (requestedEntry && entry !== requestedEntry) {
      return toolFailure(call, `Preview entry mismatch. The assigned task names ${requestedEntry}; create or verify that entry, not ${entry}.`, onEvent, step);
    }
    if (entry && !project.has(entry)) {
      return toolFailure(call, `Preview entry ${entry} does not exist. Create that file first, then run_web with entry ${entry}.`, onEvent, step);
    }
  }
  let valid = false;
  try { valid = await tool.validate(call.args); } catch (error) {
    return toolFailure(call, `Invalid arguments: ${String(error?.message || error)}`, onEvent, step);
  }
  if (!valid) return toolFailure(call, "Invalid arguments.", onEvent, step);

  const before = isMutating(call.name) ? snapshotProject(project) : null;
  let result;
  try {
    result = await tool.execute(call.args);
    if (!result || typeof result.ok !== "boolean") result = { ok: true, output: String(result?.output ?? result ?? "") };
    result.name = call.name;
    if (result.ok && call.name === "run_web" && isInteractiveTask(task) && result.probe && result.probe.ok !== true) {
      result = {
        ...result,
        ok: false,
        output: `${result.output || ""}\nverification: FAILURE - the preview did not pass the behavioral check. Review the diagnosis, repair the issue, and run the preview again.`,
      };
    }
  } catch (error) {
    result = { name: call.name, ok: false, output: `Error: ${String(error?.message || error)}` };
  }

  result.output = capObservation(result.output);
  if (result.ok && before) onSnapshot?.({ before, call });
  if (result.ok) onContext?.({ call, result });
  onEvent?.({ type: "tool_result", step, call, result });
  return result;
}

function toolFailure(call, output, onEvent, step) {
  const result = { name: call.name, ok: false, output };
  onEvent?.({ type: "tool_result", step, call, result });
  return result;
}

function invalidActionResult(onEvent, step) {
  const call = { name: "(invalid action)", args: {} };
  const result = { name: call.name, ok: false, output: "No valid <tool> or <ask_human> block was returned." };
  onEvent?.({ type: "action_error", step, result });
  return result;
}

function snapshotProject(project) {
  const before = {};
  for (const [path, file] of project.files) before[path] = file.content;
  return before;
}

function formatObservation(result) {
  return `${result.ok ? "Tool succeeded" : "Tool failed"}: ${result.output || "(no output)"}`;
}

function describeProbe(probe) {
  if (!probe || probe.ok) return "";
  const state = probe.state || {};
  const notes = [];
  if (probe.error) notes.push(`Probe error: ${probe.error}`);
    if (!probe.rendered) {
    notes.push("The preview did not render visible content. Ensure the entry file exists and produces visible output.");
  }
  if (state.visibleElements === 0) {
    notes.push("No visible elements detected. Ensure the page renders content.");
  }
  if (notes.length === 0) {
    notes.push("The preview rendered but did not pass the behavioral check. Review console output for errors.");
  }
  return `\nDIAGNOSIS:\n- ${notes.join("\n- ")}`;
}

function formatToolArgs(args = {}) {
  return Object.entries(args).map(([key, value]) => {
    const text = String(value ?? "");
    return ["content", "patch", "code"].includes(key)
      ? `${key}:\n${text}`
      : `${key}: ${text}`;
  }).join("\n") || "(none)";
}

function isInteractiveTask(task) {
  return /\b(?:app|button|click|control|interactive|keyboard|counter)\b/i.test(String(task || ""));
}

function isImplementationGoal(goal) {
  return /\b(?:add|build|change|code|create|edit|fix|implement|modify|style|update|write)\b/i.test(String(goal || ""));
}

function isDiscoveryTool(name) {
  return name === "list_files" || name === "search";
}

function isFileWriteTool(name) {
  return name === "write_file" || name === "append_file" || name === "apply_patch";
}

function isVerificationGoal(goal) {
  return /\b(?:run|verify|preview|test|check)\b/i.test(String(goal || "")) &&
    !/\b(?:write|create|implement|add|build|edit|fix|modify|update|style|code|make|work)\b/i.test(String(goal || ""));
}

function requestedHtmlEntry(task) {
  return String(task || "").match(/\b([A-Za-z0-9_./-]+\.html?)\b/i)?.[1] || "";
}

function capObservation(value) {
  const text = String(value || "");
  return text.length <= MAX_OBSERVATION_CHARS ? text : `${text.slice(0, MAX_OBSERVATION_CHARS)}\n[tool output truncated]`;
}

function buildDirectorySummary(project) {
  const paths = (project.listPaths?.() || [])
    .filter(path => !path.endsWith("/.gitkeep") && path !== ".gitkeep");
  return boundText(paths.length ? paths.join("\n") : "(empty project)", 6_000);
}

function buildExplicitContext(selection, attachments) {
  const blocks = [];
  if (selection?.text) blocks.push(`[selection: ${selection.path || "current"}]\n${selection.text}`);
  for (const attachment of attachments || []) {
    if (attachment?.text) blocks.push(`[attachment: ${attachment.path || "file"}]\n${attachment.text}`);
  }
  return boundText(blocks.join("\n\n"), MAX_EXPLICIT_CONTEXT_CHARS);
}

function renderReadFiles(readFilesMap) {
  const blocks = [];
  let used = 0;
  for (const [path, content] of readFilesMap) {
    const block = `[${path}]\n${content}`;
    const room = MAX_CONTEXT_CHARS - used;
    if (room <= 0) break;
    const clipped = boundText(block, room);
    blocks.push(clipped);
    used += clipped.length + 2;
  }
  return blocks.length ? blocks.join("\n\n") : "(no files have been read yet; use list_files, read_file, or search)";
}

function rememberToolContext(readFilesMap, project, call, result) {
  if (!result?.ok || !call) return;
  // read_file / apply_patch expose existing content; write_file / append_file
  // expose the content the model just produced. Keeping the model's own code in
  // context is what lets it repair a file it wrote instead of rewriting it blind.
  if (["read_file", "apply_patch", "write_file", "append_file"].includes(call.name)) {
    const path = String(call.args?.path || "").trim();
    const content = path && project.getContent?.(path);
    if (content != null) readFilesMap.set(path, boundText(content, MAX_CONTEXT_CHARS));
  } else if (call.name === "search") {
    readFilesMap.set(`search: ${String(call.args?.query || "")}`, boundText(result.output, 5_000));
  }
}

function boundText(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 24))}\n[context truncated]`;
}

function describePromptContent(content) {
  if (!Array.isArray(content)) return String(content || "");
  return content.map(item => {
    if (item?.type === "image" || item?.type === "image_url") return "[attached image]";
    if (item?.type === "text") return String(item.text || "");
    return String(item || "");
  }).join("\n");
}

function boundMessages(messages) {
  let remaining = MAX_PROMPT_CHARS;
  return messages.map(message => {
    if (Array.isArray(message.content)) {
      const content = [];
      for (const item of message.content) {
        if (item?.type === "image" || item?.type === "image_url") {
          content.push(item);
          continue;
        }
        if (item?.type === "text") {
          const text = String(item.text || "");
          const clipped = text.slice(0, remaining);
          remaining = Math.max(0, remaining - clipped.length);
          content.push({ ...item, text: clipped });
          continue;
        }
        content.push(item);
      }
      return { ...message, content };
    }
    const content = String(message.content || "");
    if (content.length <= remaining) {
      remaining -= content.length;
      return { ...message, content };
    }
    const clipped = content.slice(0, remaining);
    remaining = 0;
    return { ...message, content: clipped };
  });
}

export const runCodeAgent = runAgent;
