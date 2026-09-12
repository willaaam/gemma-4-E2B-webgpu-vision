import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  formatCompactTools,
  parseAskHuman,
  parsePlan,
  parseReflectionStatus,
  parseToolCall,
  parseToolCallFromThinking,
  sanitizeFileContent,
} from "../src/agent/protocol.js";
import { createTools } from "../src/harness/tools/registry.js";
import { buildActionPrompt, buildPlanningPrompt } from "../src/harness/prompts.js";
import { setTemperaturePreference } from "../src/services/temperature-preference.js";

const engineSource = await readFile(new URL("../gemma-4-e2b.js", import.meta.url), "utf8");
const originalFetch = globalThis.fetch;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
globalThis.fetch = async () => ({ text: async () => engineSource });
URL.createObjectURL = () => `data:text/javascript;base64,${Buffer.from(engineSource).toString("base64")}`;
URL.revokeObjectURL = () => {};
const { runAgent } = await import("../src/agent/controller.js");
const { modelService } = await import("../src/services/model-service.js");
const { streamGeneration } = await import("../src/services/generation.js");
globalThis.fetch = originalFetch;
URL.createObjectURL = originalCreateObjectURL;
URL.revokeObjectURL = originalRevokeObjectURL;

function makeProject(initial = {}) {
  const files = new Map(Object.entries(initial).map(([path, content]) => [path, { content }]));
  return {
    files,
    listFiles: () => [...files.entries()].map(([path, file]) => ({ path, content: file.content })),
    listPaths: () => [...files.keys()].sort(),
    getContent: (path) => files.get(path)?.content ?? null,
    has: (path) => files.has(path),
  };
}

function makeToolResponses(...responses) {
  return async () => responses.shift();
}

function action(name, args = {}) {
  const lines = ["<tool>", `name: ${name}`];
  for (const [key, value] of Object.entries(args)) {
    if (["content", "patch", "code"].includes(key)) lines.push(`${key}:\n${value}`);
    else lines.push(`${key}: ${value}`);
  }
  lines.push("</tool>");
  return lines.join("\n");
}

function status(value, explanation = "Checked the result.") {
  return `<status>${value}</status> ${explanation}`;
}

test("plan parsing accepts explicit answer checklists and ignores thought text", () => {
  assert.deepEqual(parsePlan("I am thinking about the request.\n- [ ] thought invented a task"), []);
  const tasks = parsePlan("Plan:\n- [ ] Create index.html\n- [ ] Run the web preview");
  assert.deepEqual(tasks.map(task => task.title), ["Create index.html", "Run the web preview"]);
  assert.equal(parsePlan("- [ ] Create index.html\n- [ ] Run the web preview").length, 2);
});

test("tool parsing keeps raw multiline content and rejects legacy formats", () => {
  const content = `<div title="a \\\"quote\\\"">\n  <span>raw</span>\n</div>`;
  const call = parseToolCall(action("write_file", { path: "index.html", content }));
  assert.equal(call.name, "write_file");
  assert.equal(call.args.path, "index.html");
  assert.equal(call.args.content, content);
  assert.equal(parseToolCall(`${action("read_file", { path: "src/a.js" })} trailing`).args.path, "src/a.js");
  assert.equal(parseToolCall('call:run_web{entry:<|"|>index.html<|"|>}'), null);
  assert.equal(parseToolCall('<tool>{"name":"read_file","args":{"path":"a.js"}}</tool>'), null);
  assert.equal(parseToolCall("<|channel>thought\n" + action("write_file", { path: "bad", content: "x" })), null);
  assert.equal(parseToolCall("<tool>\nname: read_file\npath: src/a.js").args.path, "src/a.js");
});

test("thinking recovery finds a tool block in the answer or thinking channel", () => {
  const recovered = parseToolCallFromThinking(`Reasoning first.\nAction:\n${action("list_files")}`);
  assert.equal(recovered.name, "list_files");
  // A tool block emitted inside the thinking channel is recovered (last block wins).
  const inThinking = parseToolCallFromThinking(`I will inspect.\n${action("list_files")}`);
  assert.equal(inThinking?.name, "list_files");
  // No tool block anywhere -> nothing to recover.
  assert.equal(parseToolCallFromThinking("Action: I will inspect the files."), null);
  assert.equal(parseToolCallFromThinking("just some reasoning"), null);
});

test("human and reflection parsers are tolerant and default safely", () => {
  assert.equal(parseAskHuman("<ask_human>Need a choice</ask_human>"), "Need a choice");
  assert.equal(parseAskHuman("<ask_human>Need a choice"), "Need a choice");
  assert.deepEqual(parseReflectionStatus("<status>COMPLETE</status> Checked."), { status: "COMPLETE", explanation: "Checked." });
  assert.equal(parseReflectionStatus("<status>RETRY").status, "RETRY");
  assert.equal(parseReflectionStatus("No status here").status, "RETRY");
  assert.match(parseReflectionStatus("").explanation, /No reflection response/);
});

test("compact tool formatting uses plaintext signatures", () => {
  assert.equal(
    formatCompactTools([{ name: "read_file", args: { path: "string" }, description: "Read" }]),
    "- read_file(path: string): Read",
  );
});

test("coding prompts keep implementation goals atomic and action-oriented", () => {
  const planPrompt = buildPlanningPrompt({ objective: "Write a browser app" });
  assert.match(planPrompt, /coherent deliverable or verification/);
  assert.match(planPrompt, /Plan deliverables, not implementation layers/);
  assert.match(planPrompt, /single-file deliverable/);
  assert.match(planPrompt, /only as many lines as the work requires/);
  assert.match(planPrompt, /final item to run and verify/);

  const actionPrompt = buildActionPrompt({ microGoal: "Create index.html", tools: [] });
  assert.match(actionPrompt, /Reply with ONLY a <tool> block/);
  assert.match(actionPrompt, /never placeholders or stubs/);
  assert.match(actionPrompt, /name: write_file/);
});

test("planning prompts include attached file context", () => {
  const planPrompt = buildPlanningPrompt({
    objective: "Fix the attached page",
    explicitContext: "[attachment: index.html]\n<h1>Existing page</h1>",
  });
  assert.match(planPrompt, /=== USER-PROVIDED FILE CONTEXT ===/);
  assert.match(planPrompt, /\[attachment: index\.html\]/);
  assert.match(planPrompt, /<h1>Existing page<\/h1>/);
});

test("file content sanitization removes only an outer fence", () => {
  assert.equal(sanitizeFileContent("```html\n<div>ok</div>\n```"), "<div>ok</div>");
  assert.equal(sanitizeFileContent("const markdown = `\n```\ninside\n```\n`;"), "const markdown = `\n```\ninside\n```\n`;");
});

test("controller executes queued goals with action then reflection phases", async () => {
  const project = makeProject();
  const writes = [];
  const snapshots = [];
  const prompts = [];
  const promptEvents = [];
  const responses = [
    { answerText: "Plan:\n- [ ] Create first.txt\n- [ ] Create second.txt" },
    { answerText: action("write_file", { path: "first.txt", content: "first" }) },
    { answerText: status("COMPLETE", "Created first.txt.") },
    { answerText: action("write_file", { path: "second.txt", content: "second" }) },
    { answerText: status("COMPLETE", "Created second.txt.") },
  ];
  const result = await runAgent({
    project,
    task: "Create both files and verify the requested change.",
    maxSteps: 8,
    executors: {
      writeFile: async (path, content) => {
        writes.push(path);
        project.files.set(path, { content });
        return { ok: true };
      },
      requestPermission: async () => "allow",
    },
    onSnapshot: snapshot => snapshots.push(snapshot),
    onEvent: event => {
      if (event.type === "prompt") promptEvents.push(event);
    },
    generateTurn: async ({ messages, stopSequences }) => {
      prompts.push({ text: messages.map(message => String(message.content || "")).join("\n"), stopSequences });
      return responses.shift();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(writes, ["first.txt", "second.txt"]);
  assert.equal(snapshots.length, 2);
  assert.equal(project.getContent("second.txt"), "second");
  assert.match(prompts[1].text, /Create both files and verify the requested change\./);
  assert.match(prompts[1].text, /=== CURRENT MICRO-GOAL ===\nCreate first\.txt/);
  assert.match(prompts[3].text, /=== CURRENT MICRO-GOAL ===\nCreate second\.txt/);
  assert.deepEqual(prompts[1].stopSequences, ["</tool>", "</ask_human>"]);
  assert.deepEqual(prompts[2].stopSequences, []);
  assert.equal(promptEvents.length, 5);
  assert.equal(promptEvents[0].phase, "planning");
  assert.equal(promptEvents[1].phase, "action");
  assert.equal(promptEvents[2].phase, "reflection");
});

test("controller sends attached files to the planning phase", async () => {
  const project = makeProject({ "index.html": "<main>Attached source</main>" });
  const prompts = [];
  const responses = [
    { answerText: "Plan:\n- [ ] Inspect the attached page" },
    { answerText: action("list_files") },
    { answerText: status("COMPLETE", "The project was inspected.") },
  ];
  const result = await runAgent({
    project,
    task: "Fix the attached page.\n\n[Attached files: @index.html]",
    attachments: [{ path: "index.html", text: project.getContent("index.html") }],
    maxSteps: 4,
    executors: { requestPermission: async () => "allow" },
    generateTurn: async ({ messages }) => {
      prompts.push(messages.map(message => String(message.content || "")).join("\n"));
      return responses.shift();
    },
  });

  assert.equal(result.ok, true);
  assert.match(prompts[0], /=== USER-PROVIDED FILE CONTEXT ===/);
  assert.match(prompts[0], /\[attachment: index\.html\]/);
  assert.match(prompts[0], /<main>Attached source<\/main>/);
});

test("controller sends image attachments to planning and action phases", async () => {
  const project = makeProject();
  const imageUrl = "data:image/png;base64,attached";
  const prompts = [];
  const responses = [
    { answerText: "Plan:\n- [ ] Inspect the attached image" },
    { answerText: action("list_files") },
    { answerText: status("COMPLETE", "The project was inspected.") },
  ];
  const result = await runAgent({
    project,
    task: "Inspect the attached image.",
    attachments: [{ type: "image", url: imageUrl, name: "pasted.png" }],
    maxSteps: 4,
    executors: { requestPermission: async () => "allow" },
    generateTurn: async ({ messages }) => {
      prompts.push(messages);
      return responses.shift();
    },
  });

  assert.equal(result.ok, true);
  for (const phaseIndex of [0, 1]) {
    const content = prompts[phaseIndex].find(message => message.role === "user").content;
    assert.deepEqual(content[0], { type: "image", url: imageUrl });
  }
  assert.equal(prompts[2].find(message => message.role === "user").content, "Return the verification status for the executed action.");
});

test("agent generation inherits the shared temperature preference", async () => {
  const project = makeProject();
  const temperatures = [];
  const responses = [
    { answerText: "Plan:\n- [ ] Inspect the project" },
    { answerText: action("list_files") },
    { answerText: status("COMPLETE", "The project was inspected.") },
  ];
  setTemperaturePreference(1.3);
  const result = await runAgent({
    project,
    task: "Inspect the project.",
    maxSteps: 4,
    executors: { requestPermission: async () => "allow" },
    generateTurn: async (options) => {
      temperatures.push(options.temperature);
      return responses.shift();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(temperatures, [undefined, undefined, undefined]);
  setTemperaturePreference(0.7);
});

test("thought-only tool text does not mutate the project", async () => {
  const project = makeProject({ "ok.txt": "ok" });
  const responses = [
    { answerText: "Plan:\n- [ ] Inspect the project", thinkingText: "" },
    { answerText: "not an action", thinkingText: action("write_file", { path: "bad.txt", content: "must not write" }) },
    { answerText: status("RETRY", "The action was not readable.") },
    { answerText: action("list_files") },
    { answerText: status("COMPLETE", "The project was inspected.") },
  ];
  const result = await runAgent({
    project,
    task: "Inspect the project.",
    maxSteps: 6,
    executors: { requestPermission: async () => "allow" },
    generateTurn: makeToolResponses(...responses),
  });

  assert.equal(result.ok, true);
  assert.equal(project.has("bad.txt"), false);
});

test("malformed action output gets a bounded format retry before reflection", async () => {
  const project = makeProject({ "ok.txt": "ok" });
  const events = [];
  const responses = [
    { answerText: "Plan:\n- [ ] Inspect the project" },
    { answerText: "I will inspect the project by reading its files first." },
    { answerText: action("list_files") },
    { answerText: status("COMPLETE", "The project was inspected.") },
  ];
  const result = await runAgent({
    project,
    task: "Inspect the project.",
    maxSteps: 6,
    executors: {
      requestPermission: async () => "allow",
    },
    onEvent: event => events.push(event),
    generateTurn: makeToolResponses(...responses),
  });

  assert.equal(result.ok, true);
  assert.equal(events.filter(event => event.type === "reflection").length, 1);
  assert.equal(events.some(event => event.note === "Action format retry 1"), true);
});

test("discovery tools are locally rejected for implementation goals", async () => {
  const project = makeProject();
  const events = [];
  const responses = [
    { answerText: "Plan:\n- [ ] Create index.html" },
    { answerText: action("list_files") },
    { answerText: action("write_file", { path: "index.html", content: "<main></main>" }) },
    { answerText: status("COMPLETE", "The HTML structure was created.") },
  ];
  const result = await runAgent({
    project,
    task: "Create a web page.",
    maxSteps: 6,
    executors: {
      writeFile: async (path, content) => {
        project.files.set(path, { content });
        return { ok: true };
      },
      requestPermission: async () => "allow",
    },
    onEvent: event => events.push(event),
    generateTurn: makeToolResponses(...responses),
  });

  assert.equal(result.ok, true);
  assert.equal(project.getContent("index.html"), "<main></main>");
  assert.ok(events.some(event => event.note === "Action selection retry 1"));
});

test("explicit tool block at the end of thinking can recover an action", async () => {
  const project = makeProject({ "ok.txt": "ok" });
  const events = [];
  const responses = [
    { answerText: "Plan:\n- [ ] Inspect the project" },
    { answerText: "", thinkingText: `I will inspect the project.\nAction:\n${action("list_files")}` },
    { answerText: status("COMPLETE", "The project was inspected.") },
  ];
  const result = await runAgent({
    project,
    task: "Inspect the project.",
    maxSteps: 5,
    executors: { requestPermission: async () => "allow" },
    onEvent: event => events.push(event),
    generateTurn: makeToolResponses(...responses),
  });

  assert.equal(result.ok, true);
  assert.equal(events.some(event => event.type === "action_recovered" && event.channel === "thinking"), true);
});

test("web verification failure keeps the assigned task open", async () => {
  const project = makeProject({ "index.html": "<button id=go>Go</button>" });
  let previewCalls = 0;
  const responses = [
    { answerText: "Plan:\n- [ ] Make the interactive button work and verify it" },
    { answerText: action("run_web", { entry: "index.html" }) },
    { answerText: status("RETRY", "The preview did not report a working interaction.") },
    { answerText: action("write_file", { path: "index.html", content: "<button id=go>Go</button><script>go.onclick=()=>go.textContent='Done'</script>" }) },
    { answerText: status("RETRY", "The file changed but the interaction still needs verification.") },
    { answerText: action("run_web", { entry: "index.html" }) },
    { answerText: status("COMPLETE", "Interactive button verified.") },
  ];
  const result = await runAgent({
    project,
    task: "Make the interactive button work and verify it.",
    maxSteps: 8,
    executors: {
      writeFile: async (path, content) => {
        project.files.set(path, { content });
        return { ok: true };
      },
      runWeb: async () => { previewCalls += 1; const passed = previewCalls > 1; return { ok: true, log: "preview", probe: { ok: passed, rendered: passed } }; },
      requestPermission: async () => "allow",
      awaitHumanResponse: async () => "Run the preview again after the repair.",
    },
    generateTurn: makeToolResponses(...responses),
  });

  assert.equal(result.ok, true);
  assert.equal(previewCalls, 2);
  assert.match(project.getContent("index.html"), /onclick/);
});

test("preview cannot silently verify a different or missing HTML entry", async () => {
  const project = makeProject({ "index.html": "<p>home</p>" });
  let previewCalls = 0;
  const responses = [
    { answerText: "Plan:\n- [ ] Create counter.html and verify counter.html" },
    { answerText: action("run_web", { entry: "counter.html" }) },
    { answerText: status("RETRY", "The requested preview entry is missing.") },
    { answerText: action("list_files") },
  ];
  const result = await runAgent({
    project,
    task: "Create counter.html and verify counter.html.",
    maxSteps: 4,
    executors: {
      runWeb: async () => { previewCalls += 1; return { ok: true, probe: { ok: true, rendered: true } }; },
      requestPermission: async () => "allow",
    },
    generateTurn: makeToolResponses(...responses),
  });

  assert.equal(result.ok, false);
  assert.equal(previewCalls, 0);
});

test("controller forces a verification goal when an interactive task never ran the preview", async () => {
  const project = makeProject({ "index.html": "<button id=go>Go</button>" });
  let previewCalls = 0;
  const responses = [
    { answerText: "Plan:\n- [ ] Write the app code" },
    { answerText: action("write_file", { path: "index.html", content: "<button id=go>Go</button><script>go.onclick=()=>go.textContent='Done'</script>" }) },
    { answerText: status("COMPLETE", "The app code was written.") },
    // Forced verification goal:
    { answerText: action("run_web", { entry: "index.html" }) },
    { answerText: status("COMPLETE", "The app works.") },
  ];
  const result = await runAgent({
    project,
    task: "Make the interactive button work and verify it.",
    maxSteps: 8,
    executors: {
      writeFile: async (path, content) => { project.files.set(path, { content }); return { ok: true }; },
      runWeb: async () => { previewCalls += 1; return { ok: true, probe: { ok: true, rendered: true } }; },
      requestPermission: async () => "allow",
    },
    generateTurn: makeToolResponses(...responses),
  });

  assert.equal(result.ok, true);
  assert.equal(previewCalls, 1);
});

test("ask-human pauses the goal and feeds the answer into the next action", async () => {
  const project = makeProject({ "index.html": "ready" });
  const prompts = [];
  const events = [];
  const responses = [
    { answerText: "Plan:\n- [ ] Inspect the selected entry" },
    { answerText: "<ask_human>Which entry should I inspect?</ask_human>" },
    { answerText: action("read_file", { path: "index.html" }) },
    { answerText: status("COMPLETE", "The selected entry was inspected.") },
  ];
  const result = await runAgent({
    project,
    task: "Inspect the selected entry.",
    maxSteps: 6,
    executors: {
      requestPermission: async () => "allow",
      awaitHumanResponse: async () => "Use index.html.",
    },
    onEvent: event => events.push(event),
    generateTurn: async ({ messages }) => {
      prompts.push(messages.map(message => String(message.content || "")).join("\n"));
      return responses.shift();
    },
  });

  assert.equal(result.ok, true);
  assert.ok(events.some(event => event.type === "human_prompt"));
  assert.ok(events.some(event => event.type === "human_response" && event.content === "Use index.html."));
  assert.match(prompts[2], /HUMAN RESPONSE ===\nUse index\.html\./);
});

test("autonomous mode auto-responds to ask_human without calling the human executor", async () => {
  const project = makeProject({ "index.html": "ready" });
  const events = [];
  let humanExecutorCalls = 0;
  const responses = [
    { answerText: "Plan:\n- [ ] Inspect the selected entry" },
    { answerText: "<ask_human>Which entry should I inspect?</ask_human>" },
    { answerText: action("read_file", { path: "index.html" }) },
    { answerText: status("COMPLETE", "The selected entry was inspected.") },
  ];
  const result = await runAgent({
    project,
    task: "Inspect the selected entry.",
    maxSteps: 6,
    autonomous: true,
    executors: {
      requestPermission: async () => "allow",
      awaitHumanResponse: async () => { humanExecutorCalls += 1; return "SHOULD NOT BE USED"; },
    },
    onEvent: event => events.push(event),
    generateTurn: makeToolResponses(...responses),
  });

  assert.equal(result.ok, true);
  assert.equal(humanExecutorCalls, 0);
  assert.ok(events.some(event => event.type === "human_prompt"));
  const autoResponse = events.find(event => event.type === "human_response");
  assert.ok(autoResponse);
  assert.match(autoResponse.content, /Continue on your own/i);
});

test("two reflection failures trigger human steering and reset the retry counter", async () => {
  const project = makeProject();
  const events = [];
  const responses = [
    { answerText: "Plan:\n- [ ] Complete the request" },
    { answerText: action("list_files") },
    { answerText: status("RETRY", "The first verification failed.") },
    { answerText: action("list_files") },
    { answerText: status("RETRY", "The second verification failed.") },
    { answerText: action("list_files") },
    { answerText: status("COMPLETE", "The request is complete.") },
  ];
  const result = await runAgent({
    project,
    task: "Complete the request.",
    maxSteps: 8,
    executors: {
      requestPermission: async () => "allow",
      awaitHumanResponse: async () => "Use a no-op inspection.",
    },
    onEvent: event => events.push(event),
    generateTurn: makeToolResponses(...responses),
  });

  assert.equal(result.ok, true);
  assert.equal(events.filter(event => event.type === "human_steering").length, 1);
  assert.ok(events.some(event => event.type === "human_response" && event.content === "Use a no-op inspection."));
});

test("read-file context is explicit and prompts stay below the character cap", async () => {
  const secret = "DO_NOT_DUMP_" + "x".repeat(2_000);
  const project = makeProject({ "secret.js": secret });
  const prompts = [];
  const responses = [
    { answerText: "Plan:\n- [ ] Inspect the project" },
    { answerText: action("list_files") },
    { answerText: status("RETRY", "The file contents have not been inspected yet.") },
    { answerText: action("read_file", { path: "secret.js" }) },
    { answerText: status("RETRY", "The file was read; continue the inspection.") },
    { answerText: action("list_files") },
    { answerText: status("COMPLETE", "The project inspection is complete.") },
  ];
  const result = await runAgent({
    project,
    task: "Inspect the project.",
    maxSteps: 8,
    executors: {
      requestPermission: async () => "allow",
      awaitHumanResponse: async () => "Continue the inspection.",
    },
    generateTurn: async ({ messages }) => {
      const text = messages.map(message => String(message.content || "")).join("\n");
      prompts.push(text);
      return responses.shift();
    },
  });

  assert.equal(result.ok, true);
  assert.ok(prompts.every(prompt => prompt.length < 28_000));
  assert.equal(prompts[1].includes(secret), false);
  assert.equal(prompts[5].includes(secret), true);
});

test("stream generation trims a textual stop and forwards the stop list", async () => {
  const state = modelService.state;
  const previous = { model: state.model, capabilities: state.capabilities, thoughtTokenIds: state.thoughtTokenIds };
  let options = null;
  state.model = {
    countPromptTokens: async () => 1,
    getContextCapabilities: () => ({ architecturalMax: 128, effectiveContextMax: 128 }),
    generate: async function* (_messages, receivedOptions) {
      options = receivedOptions;
      yield { text: "<tool>\nname: read_file\n", delta: "<tool>\nname: read_file\n", token: 1 };
      yield { text: "<tool>\nname: read_file\npath: a.js\n</tool>ignored", delta: "path: a.js\n</tool>ignored", token: 2 };
    },
  };
  state.capabilities = { architecturalMax: 128, effectiveContextMax: 128 };
  state.thoughtTokenIds = null;
  try {
    const result = await streamGeneration({
      messages: [{ role: "user", content: "test" }],
      maxNewTokens: 16,
      contextMax: 128,
      stopSequences: ["</tool>"],
    });
    assert.deepEqual(options.stopSequences, ["</tool>"]);
    assert.equal(result.reply, "<tool>\nname: read_file\npath: a.js\n</tool>");
  } finally {
    state.model = previous.model;
    state.capabilities = previous.capabilities;
    state.thoughtTokenIds = previous.thoughtTokenIds;
  }
});

test("tool registry remains an execution adapter for the fresh controller", async () => {
  const files = new Map();
  const { byName, toolSpecPrompt } = createTools({
    project: {
      listPaths: () => [],
      getContent: path => files.get(path)?.content ?? null,
    },
    executors: {
      writeFile: async (path, content) => {
        files.set(path, { content });
        return { ok: true };
      },
    },
  });
  const result = await byName.get("write_file").execute({ path: "main.py", content: "print('ok')" });
  assert.equal(result.ok, true);
  assert.equal(files.get("main.py").content, "print('ok')");
  assert.match(toolSpecPrompt, /- write_file\(path: string, content: string\)/);
});
