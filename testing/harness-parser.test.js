import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  deduplicateCalls,
  extractToolCalls,
  extractGemma4Calls,
  parseGemma4Args,
  extractCodeBlockCalls,
  extractTruncatedFileCall,
  hasAnswer,
  extractAnswer,
  cleanProse,
  hasUnclosedToolFence,
  sanitizeFileContent,
} from "../src/harness/parser.js";
import { createTools } from "../src/harness/tools/registry.js";
import { isLikelyInteractivePython } from "../apps/code/runners/pyodide-runner.js";

const toolFence = (body) => `\`\`\`tool\n${body}\n\`\`\``;

test("extracts nested JSON tool arguments", () => {
  const calls = extractToolCalls(toolFence(JSON.stringify({
    name: "write_file",
    args: { path: "main.py", content: "print(\"ok\")\n" },
  })));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "write_file");
  assert.equal(calls[0].args.content, "print(\"ok\")\n");
});

test("uses the last JSON tool tag and ignores a closing tag inside quoted content", () => {
  const first = JSON.stringify({ name: "read_file", args: { path: "old.py" } });
  const second = JSON.stringify({ name: "write_file", args: {
    path: "README.md",
    content: "before\n</tool> is part of the file\nafter",
  } });
  const calls = extractToolCalls(`<tool>${first}</tool>\n<tool>${second}</tool>`);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "write_file");
  assert.equal(calls[0].args.path, "README.md");
  assert.match(calls[0].args.content, /<\/tool> is part of the file/);
});

test("parses a single-quoted tool envelope without corrupting apostrophes", () => {
  const raw = String.raw`<tool>{'name':'write_file','args':{'path':'README.md','content':'it\'s here </tool>'}}</tool>`;
  const calls = extractToolCalls(raw);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.content, "it's here </tool>");
});

test("keeps inner triple-backtick lines inside a fenced JSON file payload", () => {
  const content = "const markdown = `\n```\ninside\n```\n`;";
  const body = JSON.stringify({ name: "write_file", args: { path: "script.js", content } });
  const calls = extractToolCalls(`\`\`\`json\n${body}\n\`\`\``);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.content, content);
});

test("sanitizes only outer file-content fences", () => {
  assert.equal(sanitizeFileContent("```html\n<div>hi</div>\n```"), "<div>hi</div>");
  assert.equal(sanitizeFileContent("const ready = true;\n```\n"), "const ready = true;");
  assert.equal(sanitizeFileContent("before\n```md\ninside\n```\nafter"), "before\n```md\ninside\n```\nafter");
  assert.equal(sanitizeFileContent("# README\n```js\nconsole.log('ok');\n```"), "# README\n```js\nconsole.log('ok');\n```");
});

test("removes an unmatched trailing block-comment closer from generated source", () => {
  assert.equal(sanitizeFileContent("/* wrapper */\nconst value = 1;\n*/"), "/* wrapper */\nconst value = 1;");
  assert.equal(sanitizeFileContent("const value = 1;\n/* comment\n*/"), "const value = 1;\n/* comment\n*/");
});

test("composeWebDoc renders the requested HTML entry", async () => {
  const { composeWebDoc } = await import("../apps/code/runners/web-runner.js");
  const files = new Map([
    ["index.html", { content: "<html><body><p>index</p></body></html>" }],
    ["about.html", { content: "<html><body><p>about</p></body></html>" }],
  ]);
  const rendered = composeWebDoc(files, "about.html");

  assert.match(rendered, /<p>about<\/p>/);
  assert.doesNotMatch(rendered, /<p>index<\/p>/);
  assert.match(rendered, /type: "ws-probe"/);
});

test("run_web forwards its entry argument", async () => {
  let selectedEntry = "";
  const { createTools } = await import("../src/harness/tools/registry.js");
  const { byName } = createTools({
    project: { listPaths: () => [] },
    executors: {
      runWeb: async (entry) => {
        selectedEntry = entry;
        return { ok: true, log: "preview ready" };
      },
    },
  });

  const result = await byName.get("run_web").execute({ entry: "about.html" });
  assert.equal(result.ok, true);
  assert.equal(selectedEntry, "about.html");
});

test("extracts canonical Gemma 4 tool call with <|\"|> string delimiters", () => {
  const raw = `<|tool_call|>call:write_file{path:<|"|>tetris.py<|"|>,content:<|"|>import sys, time\\nprint('Tetris')\\n<|"|>}<tool_call|>`;
  const calls = extractToolCalls(raw);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "write_file");
  assert.equal(calls[0].args.path, "tetris.py");
  assert.match(calls[0].args.content, /import sys, time/);
});

test("extracts stripped Gemma 4 tool calls without special token wrappers", () => {
  const raw = `call:write_file{path:<|"|>main.py<|"|>,content:<|"|>print("hello world")<|"|>}`;
  const calls = extractToolCalls(raw);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "write_file");
  assert.equal(calls[0].args.path, "main.py");
  assert.equal(calls[0].args.content, 'print("hello world")');
});

test("extracts direct markdown code block as write_file when model emits code without tool fence", () => {
  const raw = `Here is the Tetris code in Python:\n\`\`\`python\n# tetris.py\nimport sys\nprint("Tetris game running")\n\`\`\``;
  const calls = extractToolCalls(raw, { task: "Write me tetris for console in python" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "write_file");
  assert.equal(calls[0].args.path, "tetris.py");
  assert.match(calls[0].args.content, /import sys/);
  assert.equal(calls[0].fromCodeBlock, true);
});

test("extracts a valid tool call from a mislabeled JSON fence", () => {
  const calls = extractToolCalls(`\`\`\`json\n${JSON.stringify({
    name: "read_file",
    args: { path: "main.py" },
  })}\n\`\`\``);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "read_file");
});

test("deduplicates repeated calls within one model turn", () => {
  const call = { name: "read_file", args: { path: "main.py" } };
  assert.equal(deduplicateCalls([call, call]).length, 1);
});

test("only accepts DONE as a standalone final marker", () => {
  assert.equal(hasAnswer("thinking DONE is not final"), false);
  assert.equal(hasAnswer("DONE"), true);
});

test("does not treat an answer fence inside a file argument as final", () => {
  assert.equal(hasAnswer('{"name":"write_file","args":{"content":"```answer"}}'), false);
});

test("cleanProse strips special control tokens and raw tool calls", () => {
  const raw = `<|channel>thought\nThinking about tetris...\n<channel|><|tool_call|>call:write_file{path:<|"|>tetris.py<|"|>}<tool_call|>Here is the completed game.`;
  const cleaned = cleanProse(raw);
  assert.equal(cleaned, "Here is the completed game.");
});

test("detects a truncated tool fence", () => {
  assert.equal(hasUnclosedToolFence("```tool\n{\"name\":\"read_file\"}"), true);
  assert.equal(hasUnclosedToolFence(toolFence('{"name":"read_file","args":{}}')), false);
});

test("recovers a complete source prefix from a truncated file payload", () => {
  const raw = `\`\`\`json\n{"name":"write_file","args":{"path":"tetris.py","content":"${"print(\\\"ok\\\")\\n".repeat(20)}`;
  const call = extractTruncatedFileCall(raw);

  assert.equal(call.name, "write_file");
  assert.equal(call.partial, true);
  assert.equal(call.args.path, "tetris.py");
  assert.match(call.args.content, /^print\("ok"\)\n/);
  assert.equal(call.args.content.endsWith("\n"), true);
});

test("classifies interactive Python without flagging ordinary loops", () => {
  assert.equal(isLikelyInteractivePython("choice = input('Move: ')"), true);
  assert.equal(isLikelyInteractivePython("while True:\n    break"), true);
  assert.equal(isLikelyInteractivePython("for item in items:\n    print(item)"), false);
});

test("append_file extends a file and ignores a replayed final chunk", async () => {
  const files = new Map([["main.py", { content: "print(" }]]);
  const project = {
    getContent: (path) => files.get(path)?.content ?? null,
  };
  const executors = {
    writeFile: async (path, content) => {
      files.set(path, { content });
      return { ok: true };
    },
  };
  const { byName } = createTools({ project, executors });
  const append = byName.get("append_file");

  const first = await append.execute({ path: "main.py", content: '"ok")' });
  const replay = await append.execute({ path: "main.py", content: '"ok")' });

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(files.get("main.py").content, 'print("ok")');
});

test("harness salvages a cut-off file, continues it, and verifies the target", async () => {
  const engineSource = await readFile(new URL("../gemma-4-e2b.js", import.meta.url), "utf8");
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  globalThis.fetch = async () => ({ text: async () => engineSource });
  URL.createObjectURL = () => `data:text/javascript;base64,${Buffer.from(engineSource).toString("base64")}`;
  URL.revokeObjectURL = () => {};
  const { runHarness } = await import("../src/harness/harness.js");
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;

  const files = new Map();
  const project = {
    files,
    listFiles: () => [...files.entries()].map(([path, file]) => ({ path, content: file.content })),
    listPaths: () => [...files.keys()],
    getContent: (path) => files.get(path)?.content ?? null,
  };
  const executors = {
    runs: [],
    writeFile: async (path, content) => {
      files.set(path, { content });
      return { ok: true };
    },
    runPython: async (path, options) => {
      executors.runs.push({ path, options });
      return { ok: true, result: "Syntax and smoke test verified." };
    },
  };
  const prefix = 'print("ok")\n'.repeat(12);
  const cutOff = `\`\`\`json\n{"name":"write_file","args":{"path":"tetris.py","content":${JSON.stringify(prefix).slice(0, -1)}`;
  const responses = [
    cutOff,
    'call:append_file{path:<|"|>tetris.py<|"|>,content:<|"|>def main():\\n    pass\\n<|"|>}',
    'call:run_python{path:<|"|>tetris.py<|"|>}',
    "```answer\nCreated and verified tetris.py.\n```",
  ];

  const result = await runHarness({
    project,
    task: "Write me tetris for console in python",
    maxSteps: 5,
    generateTurn: async () => ({ reply: responses.shift() }),
    executors,
  });

  assert.equal(result.ok, true);
  assert.equal(files.has("tetris.py"), true);
  assert.match(files.get("tetris.py").content, /def main\(\):/);
  assert.equal(result.steps.length, 3);
  assert.ok(executors.runs.length > 0);
  assert.ok(executors.runs.every(({ options }) => options.nonInteractive === true));
});

test("harness detects runtime error in web preview and feeds back failure for repair", async () => {
  const { runHarness } = await import("../src/harness/harness.js");

  const files = new Map();
  const project = {
    files,
    listFiles: () => [...files.entries()].map(([path, file]) => ({ path, content: file.content })),
    listPaths: () => [...files.keys()],
    getContent: (path) => files.get(path)?.content ?? null,
  };
  let runWebCalls = 0;
  const executors = {
    writeFile: async (path, content) => {
      files.set(path, { content });
      return { ok: true };
    },
    runWeb: async (entry) => {
      runWebCalls++;
      if (runWebCalls === 1) {
        return { ok: false, error: "[error] Uncaught TypeError: Cannot read properties of null (reading 'addEventListener') (index.html:37)", log: "[error] Uncaught TypeError: Cannot read properties of null (reading 'addEventListener') (index.html:37)" };
      }
      return {
        ok: true,
        log: "[info] App initialized successfully",
        probe: { rendered: true, interactive: true },
      };
    },
  };

  const buggyHtml = '<!doctype html><html><body><script>document.getElementById("btn").addEventListener("click", () => {});</script></body></html>';
  const fixedHtml = '<!doctype html><html><body><button id="btn">Click</button><script>document.getElementById("btn").addEventListener("click", () => {});</script></body></html>';

  const responses = [
    `call:write_file{path:<|"|>index.html<|"|>,content:<|"|>${buggyHtml}<|"|>}`,
    `call:run_web{entry:<|"|>index.html<|"|>}`,
    `call:write_file{path:<|"|>index.html<|"|>,content:<|"|>${fixedHtml}<|"|>}`,
    `call:run_web{entry:<|"|>index.html<|"|>}`,
    "```answer\nFixed null element reference and verified preview.\n```",
  ];

  const result = await runHarness({
    project,
    task: "Build an interactive web button",
    maxSteps: 5,
    generateTurn: async () => ({ reply: responses.shift() }),
    executors,
  });

  assert.equal(result.ok, true);
  assert.equal(files.has("index.html"), true);
  assert.match(files.get("index.html").content, /<button id="btn">/);
  assert.equal(runWebCalls, 2);
});

test("harness keeps failed verification pending before accepting a final answer", async () => {
  const { runHarness } = await import("../src/harness/harness.js");

  const files = new Map();
  const project = {
    files,
    listFiles: () => [...files.entries()].map(([path, file]) => ({ path, content: file.content })),
    listPaths: () => [...files.keys()],
    getContent: (path) => files.get(path)?.content ?? null,
  };
  let runWebCalls = 0;
  const executors = {
    writeFile: async (path, content) => {
      files.set(path, { content });
      return { ok: true };
    },
    runWeb: async () => {
      runWebCalls++;
      return { ok: false, error: "preview failed", log: "[error] preview failed" };
    },
  };

  const responses = [
    `call:write_file{path:<|"|>index.html<|"|>,content:<|"|><!doctype html><html><body><script>throw new Error('broken')</script></body></html><|"|>}`,
    "```answer\nThe page is complete.\n```",
    "The page is complete.",
    "```answer\nThe page is complete.\n```",
  ];

  const result = await runHarness({
    project,
    task: "Build an interactive web page",
    maxSteps: 4,
    generateTurn: async () => ({ reply: responses.shift() }),
    executors,
  });

  assert.equal(result.ok, false);
  assert.equal(runWebCalls, 0);
  assert.equal(result.steps.length, 1);
});

test("harness feeds a non-interactive web probe back for repair", async () => {
  const { runHarness } = await import("../src/harness/harness.js");

  const files = new Map();
  const project = {
    files,
    listFiles: () => [...files.entries()].map(([path, file]) => ({ path, content: file.content })),
    listPaths: () => [...files.keys()],
    getContent: (path) => files.get(path)?.content ?? null,
  };
  let runWebCalls = 0;
  const executors = {
    writeFile: async (path, content) => {
      files.set(path, { content });
      return { ok: true };
    },
    runWeb: async () => {
      runWebCalls++;
      return {
        ok: true,
        log: "[info] Preview: index.html",
        probe: { rendered: true, interactive: runWebCalls > 1 },
      };
    },
  };
  const responses = [
    `call:write_file{path:<|"|>index.html<|"|>,content:<|"|><!doctype html><html><body><button>Start</button></body></html><|"|>}`,
    "call:run_web{entry:<|\"|>index.html<|\"|>}",
    `call:write_file{path:<|"|>index.html<|"|>,content:<|"|><!doctype html><html><body><button id="start">Start</button><output>running</output></body></html><|"|>}`,
    "call:run_web{entry:<|\"|>index.html<|\"|>}",
    "```answer\nBuilt and behaviorally verified the interactive page.\n```",
  ];

  const result = await runHarness({
    project,
    task: "Build an interactive web game",
    maxSteps: 6,
    generateTurn: async () => ({ reply: responses.shift() }),
    executors,
  });

  assert.equal(result.ok, true);
  assert.equal(runWebCalls, 2);
  assert.match(files.get("index.html").content, /running/);
});

test("harness rejects a Tetris launch-only probe without a real board or keyboard response", async () => {
  const { runHarness } = await import("../src/harness/harness.js");

  const files = new Map();
  const project = {
    files,
    listFiles: () => [...files.entries()].map(([path, file]) => ({ path, content: file.content })),
    listPaths: () => [...files.keys()],
    getContent: (path) => files.get(path)?.content ?? null,
  };
  const executors = {
    writeFile: async (path, content) => {
      files.set(path, { content });
      return { ok: true };
    },
    runWeb: async () => ({
      ok: true,
      log: "[info] Preview: index.html",
      probe: {
        rendered: true,
        interactive: true,
        launchChanged: true,
        keyboardChanged: false,
        state: {
          board: { columns: 0, rows: 0, children: 200 },
        },
      },
    }),
  };

  const responses = [
    `call:write_file{path:<|"|>index.html<|"|>,content:<|"|><!doctype html><html><body><div id="game-board"></div><button>Start Game</button></body></html><|"|>}`,
    "call:run_web{entry:<|\"|>index.html<|\"|>}",
    "```answer\nThe Tetris game is complete.\n```",
  ];

  const result = await runHarness({
    project,
    task: "Write tetris in html and js",
    maxSteps: 3,
    generateTurn: async () => ({ reply: responses.shift() }),
    executors,
  });

  assert.equal(result.ok, false);
  assert.equal(result.steps[1].results[0].ok, false);
  assert.match(result.steps[1].results[0].output, /10x20 board with 200 cells/);
});

test("harness clamps generation turns and model input controls", async () => {
  const { runHarness } = await import("../src/harness/harness.js");
  const project = {
    files: new Map(),
    listFiles: () => [],
    listPaths: () => [],
    getContent: () => null,
  };
  const requests = [];

  const result = await runHarness({
    project,
    task: "Build a project",
    maxSteps: 20,
    generateTurn: async (options) => {
      requests.push(options);
      return { reply: "Still working on the implementation." };
    },
    executors: {},
  });

  assert.equal(result.ok, false);
  assert.equal(requests.length, 16);
  assert.ok(requests.every(request => request.temperature === 0.2));
  assert.ok(requests.every(request => request.maxNewTokens <= 8192));
  assert.ok(requests.every(request => request.messages.reduce(
    (total, message) => total + String(message.content ?? "").length,
    0,
  ) <= 120000));
});

test("harness enforces unchecked tasks and prompts model to evaluate and check off", async () => {
  const { runHarness } = await import("../src/harness/harness.js");

  const files = new Map();
  const project = {
    files,
    listFiles: () => [...files.entries()].map(([path, file]) => ({ path, content: file.content })),
    listPaths: () => [...files.keys()],
    getContent: (path) => files.get(path)?.content ?? null,
  };
  const executors = {
    writeFile: async (path, content) => {
      files.set(path, { content });
      return { ok: true };
    },
    runPython: async () => ({ ok: true, result: "Game loop verified." }),
  };

  const responses = [
    // Turn 1: Model outputs 2 tasks and writes file for task 1
    `Plan:\n- [x] 1. Create game board\n- [ ] 2. Implement score tracking\n\ncall:write_file{path:<|"|>game.py<|"|>,content:<|"|># game\\nboard = []<|"|>}`,
    // Turn 2: Model prematurely tries to conclude with ```answer while task 2 is still unchecked
    "```answer\nGame board is created.\n```",
    // Turn 3: Harness nudged with task enforcement; model implements task 2 and marks all tasks checked
    `Plan:\n- [x] 1. Create game board\n- [x] 2. Implement score tracking\n\ncall:write_file{path:<|"|>game.py<|"|>,content:<|"|># game\\nboard = []\\nscore = 0<|"|>}`,
    // Turn 4: Final answer with all tasks checked
    "```answer\nAll tasks verified and completed.\n```",
  ];

  const result = await runHarness({
    project,
    task: "Build game with board and score tracking",
    maxSteps: 6,
    generateTurn: async () => ({ reply: responses.shift() }),
    executors,
  });

  assert.equal(result.ok, true);
  assert.equal(files.has("game.py"), true);
  assert.match(files.get("game.py").content, /score = 0/);
});

test("parseGemma4Args parses HTML content containing unescaped double quotes and meta viewport", async () => {
  const { parseGemma4Args } = await import("../src/harness/parser.js");

  const raw = `path: "index.html", content: "<!doctype html>\n<html lang="en">\n<head>\n    <meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n    <title>Tetris Game</title>\n</head>\n<body>\n    <div id="game-board"></div>\n</body>\n</html>"`;
  const args = parseGemma4Args(raw);

  assert.equal(args.path, "index.html");
  assert.match(args.content, /<!doctype html>/);
  assert.match(args.content, /meta name="viewport" content="width=device-width, initial-scale=1.0"/);
  assert.match(args.content, /<\/html>/);
});

test("write_file reconstructs fragmented key-value arguments from unescaped HTML quotes", async () => {
  const { createTools } = await import("../src/harness/tools/registry.js");

  let writtenContent = "";
  const executors = {
    writeFile: async (path, content) => {
      writtenContent = content;
      return { ok: true };
    }
  };
  const { byName } = createTools({ project: { listPaths: () => [] }, executors });
  const writeFileTool = byName.get("write_file");

  const fragmentedArgs = {
    path: "index.html",
    content: "<!doctype html>\n<html lang=\"en\">\n<head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width",
    "initial-scale": "=1.0\">\n    <title>Tetris Game</title>\n    <link rel=\"stylesheet\" href=\"style.css\">\n</head>\n<body>\n    <div class=\"game-container\">\n        <h1>Tetris</h1>\n        <div id=\"game-board\"></div>\n        <div id=\"score-board\">Score: 0</div>\n        <button id=\"start-button\">Start Game</button>\n    </div>\n    <script src=\"script.js\"></script>\n</body>\n</html>"
  };

  const result = await writeFileTool.execute(fragmentedArgs);
  assert.equal(result.ok, true);
  assert.match(writtenContent, /<!doctype html>/);
  assert.match(writtenContent, /width=device-width, initial-scale=1.0/);
  assert.match(writtenContent, /<button id="start-button">Start Game<\/button>/);
  assert.match(writtenContent, /<\/html>/);
});

test("extractGemma4Calls parses malformed and unclosed CSS tool call", async () => {
  const { extractGemma4Calls } = await import("../src/harness/parser.js");

  const raw = `call:write_file{path:style.css", sans-serif=";
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 100vh;
  margin: 0;
  background: #1a1a2e;
  color: #e8ecf4;"`;

  const calls = extractGemma4Calls(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "write_file");
  assert.equal(calls[0].args.path, "style.css");
  assert.match(calls[0].args.content, /display:\s*flex/);
  assert.match(calls[0].args.content, /background:\s*#1a1a2e/);
});

test("inferFilePath extracts explicit filenames from comments, headings, or tags", async () => {
  const { inferFilePath, extractToolCalls } = await import("../src/harness/parser.js");

  const jsCode = "// script.js\nconst board = [];\nfunction initGame() { console.log('started'); }\ninitGame();";
  const inferredJs = inferFilePath(jsCode, { lang: "js", task: "Write me tetris in html, css, and js" });
  assert.equal(inferredJs, "script.js");

  const cssCode = "/* style.css */\nbody { margin: 0; background: #000; color: #fff; }";
  const inferredCss = inferFilePath(cssCode, { lang: "css", task: "Write me tetris in html, css, and js" });
  assert.equal(inferredCss, "style.css");

  const extracted = extractToolCalls(`### Step 3: \`script.js\`\n\`\`\`javascript\n${jsCode}\n\`\`\``, { task: "Build tetris game" });
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].args.path, "script.js");
});

test("extractGemma4Calls handles equal sign arguments and braces", async () => {
  const { extractGemma4Calls } = await import("../src/harness/parser.js");

  const raw = `call:write_file{path="main.py", content="print('hello')"}`;
  const calls = extractGemma4Calls(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "write_file");
  assert.equal(calls[0].args.path, "main.py");
  assert.equal(calls[0].args.content, "print('hello')");
});


test("toolSpecPrompt generates canonical Gemma 4 declaration syntax", async () => {
  const { createTools, toolSpecPrompt } = await import("../src/harness/tools/registry.js");
  const { tools } = createTools({ project: { listPaths: () => [] } });
  const prompt = toolSpecPrompt(tools);
  assert.match(prompt, /declaration:write_file\{description:/);
  assert.match(prompt, /declaration:read_file\{description:/);
  assert.match(prompt, /declaration:run_web\{description:/);
  assert.match(prompt, /parameters:\{properties:/);
  assert.match(prompt, /required:\[<\|"\|>path<\|"\|>/);
});

test("parseGemma4Args preserves complex JS DOM manipulation and template literals without corruption", async () => {
  const { parseGemma4Args } = await import("../src/harness/parser.js");

  const jsCode = `let board = Array(20).fill(0).map(() => Array(10).fill(0));
function initializeBoard() {
  const boardElement = document.getElementById('game-board');
  for (let r = 0; r < 20; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = document.createElement('div');
      cell.classList.add('cell');
      cell.id = \`cell-\${r}-\${c}\`;
      boardElement.appendChild(cell);
    }
  }
}`;

  const raw = `path: "script.js", content: "${jsCode.replace(/\n/g, "\\n").replace(/"/g, '\\"')}"`;
  const parsed = parseGemma4Args(raw);
  assert.equal(parsed.path, "script.js");
  assert.equal(parsed.content, jsCode);
  assert.equal(parsed.content.includes("[object Object]"), false, "Must not contain [object Object]");
  assert.equal(parsed.content.includes("-$="), false, "Must not contain fragmented keys");
});

test("restoreCodePlaceholders strips malformed fence headers cleanly", async () => {
  const { renderMarkdown } = await import("../src/lib/markdown.js");

  const malformed = "```python-${c}');\nboardElement.appendChild(cell);\n```";
  const rendered = renderMarkdown(malformed);
  assert.match(rendered, /<pre><code>boardElement\.appendChild\(cell\);\n?<\/code><\/pre>/);
  assert.equal(rendered.includes("python-${c}"), false);
});

test("renderMarkdown renders Plan titles, task checklists, and sub-bullets without empty code boxes", async () => {
  const { renderMarkdown } = await import("../src/lib/markdown.js");

  const text = `Turn 1: Plan

**Plan:**

- [ ] 1. Analyze the existing files (\`index.html\`, \`style.css\`, \`script.js\`) to understand the current structure.
- [ ] 2. Implement the core game logic in \`script.js\`:
    o Define the game board state (20x10 grid).
    o Define the Tetromino shapes and their rotations.
- [ ] 3. Update \`index.html\` to ensure game board and score elements are referenced.

\`\`\`javascript
{
  "Plan": ["task 1", "task 2"]
}
\`\`\``;

  const html = renderMarkdown(text);
  assert.match(html, /<strong>Plan:<\/strong>/, "Plan title must be rendered as bold text, not a pre/code box");
  assert.match(html, /<pre><code>[\s\S]*(?:&quot;|")Plan(?:&quot;|"):/, "JSON block must be in pre/code box");
  assert.equal(html.includes("<pre><code>**Plan:**"), false, "Must not put bold headers inside code boxes");
});

test("renderMarkdown renders model-fenced CSS code block correctly (no empty boxes or plain text)", async () => {
  const { renderMarkdown } = await import("../src/lib/markdown.js");

  const modelOutput = `Let's start with the plan.

\`\`\`css
.game-container {
  display: flex;
  flex-direction: column;
  align-items: center;
}

h1 {
  color: #4ade80;
}

#game-board {
  width: 200px;
  height: 400px;
  border: 3px solid #4ade80;
}
\`\`\``;

  const html = renderMarkdown(modelOutput);
  assert.match(html, /<pre><code>[\s\S]*display:\s*flex[\s\S]*<\/code><\/pre>/, "CSS must render inside a code block");
  assert.match(html, /<pre><code>[\s\S]*#game-board[\s\S]*<\/code><\/pre>/, "CSS selectors must be in the code block");
  const withoutCode = html.replace(/<pre><code>[\s\S]*?<\/code><\/pre>/g, "");
  assert.equal(withoutCode.includes("display: flex"), false, "CSS must not leak as plain text");
  assert.equal(withoutCode.includes(".game-container"), false, "CSS selectors must not leak as plain text");
});

test("autoFenceNakedCode does not create nested fences inside model-opened fences", async () => {
  const { autoFenceNakedCode } = await import("../src/lib/markdown.js");

  const input = `Some prose.

\`\`\`css
.game-container {
  display: flex;
}
\`\`\``;

  const result = autoFenceNakedCode(input);
  const fenceCount = (result.match(/```/g) || []).length;
  assert.equal(fenceCount, 2, `Expected 2 fence markers, got ${fenceCount}. Output:\n${result}`);
});

test("renderMarkdown renders unclosed CSS fence from streaming without plain text leakage", async () => {
  const { renderMarkdown } = await import("../src/lib/markdown.js");

  const streaming = `I will write the CSS.

\`\`\`css
.board {
  display: grid;
  grid-template-columns: repeat(10, 1fr);
}
.cell {
  width: 100%;
  height: 100%;`;

  const html = renderMarkdown(streaming);
  assert.match(html, /<pre><code>[\s\S]*display:\s*grid[\s\S]*<\/code><\/pre>/, "Unclosed CSS must still render in code block");
  const withoutCode = html.replace(/<pre><code>[\s\S]*?<\/code><\/pre>/g, "");
  assert.equal(withoutCode.includes("display: grid"), false, "CSS must not leak as plain text from unclosed fence");
});








