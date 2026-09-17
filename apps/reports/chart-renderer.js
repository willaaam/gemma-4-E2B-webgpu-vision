// Chart renderer for the reports app.
//
// The model emits fenced ```chart blocks containing a JSON spec; this module
// validates the spec and renders it with Chart.js (lazy CDN import). We never
// ask the model to write chart JavaScript — at 2.3B with greedy decode, JSON
// specs are far more reliable than codegen.

let ChartLib = null;
let chartJsPromise = null;

function loadChartJs() {
  if (ChartLib) return Promise.resolve(ChartLib);
  if (!chartJsPromise) {
    chartJsPromise = import("https://esm.sh/chart.js@4.4.3/auto")
      .then((m) => { ChartLib = m.default ?? m.Chart; return ChartLib; })
      .catch((e) => { chartJsPromise = null; throw e; });
  }
  return chartJsPromise;
}

const VALID_TYPES = new Set(["bar", "line", "pie", "doughnut", "radar", "area"]);

// Validate + normalize a chart spec. Returns { ok, spec?, error? }.
export function parseChartSpec(jsonText) {
  let raw;
  try { raw = JSON.parse(jsonText); }
  catch (e) { return { ok: false, error: `Invalid JSON: ${e.message}` }; }

  const type = String(raw.type ?? "bar").toLowerCase();
  if (type === "area") { /* supported as filled line */ }
  else if (!VALID_TYPES.has(type)) return { ok: false, error: `Unknown chart type "${raw.type}" — use one of ${[...VALID_TYPES].join(", ")}.` };

  const labels = Array.isArray(raw.labels) ? raw.labels.map(String) : null;
  if (!labels || labels.length === 0) return { ok: false, error: `"labels" must be a non-empty array.` };

  const seriesRaw = Array.isArray(raw.series) ? raw.series : (Array.isArray(raw.data) ? [{ label: raw.title ?? "Series", data: raw.data }] : null);
  if (!seriesRaw || seriesRaw.length === 0) return { ok: false, error: `"series" must be an array of { label, data } objects.` };

  const series = [];
  for (const s of seriesRaw) {
    const data = Array.isArray(s?.data) ? s.data.map((v) => Number(v)) : null;
    if (!data || data.some((v) => !Number.isFinite(v))) return { ok: false, error: `Every series needs a numeric "data" array matching labels length (${labels.length}).` };
    series.push({ label: String(s.label ?? "Series"), data });
  }

  return {
    ok: true,
    spec: {
      type,
      title: String(raw.title ?? ""),
      labels,
      series,
      yLabel: raw.yLabel ? String(raw.yLabel) : undefined,
    },
  };
}

/**
 * Strip an accidental whole-section wrapper fence, without disturbing fences that belong
 * to blocks inside the section.
 *
 * Reports are generated one section per completion, and the model sometimes wraps the
 * whole answer in ``` … ```. Removing the first and last fence line *independently* is not
 * safe: a section that ends with a ```chart block also ends in ```, so stripping it leaves
 * the chart unterminated. The JSON then runs on past the end of the section — invalid on
 * its own, and worse, it swallows everything up to the next fence in the document, so the
 * following section disappears into the chart spec. Unwrap only when the section is
 * genuinely wrapped: when BOTH the first and last lines are bare fences.
 */
export function stripWrapperFence(text) {
  const body = String(text ?? "").trim();
  const lines = body.split("\n");
  if (lines.length < 2) return body;
  const isBareFence = (line) => /^```(?:markdown|md)?\s*$/.test(line.trim());
  if (!isBareFence(lines[0]) || !isBareFence(lines[lines.length - 1])) return body;
  return lines.slice(1, -1).join("\n").trim();
}

// Find the fenced blocks that are charts.
//
// A block counts as a chart when it says so (```chart) or when its body is a *valid* chart
// spec. The tag cannot be relied on: a 2.3B model on greedy decode routinely writes a bare
// ``` or ```json fence around the very same JSON, and requiring the tag meant a perfectly
// good spec rendered as a code block instead of a chart. Requiring the body to parse keeps
// that permissive for charts without hijacking genuine code blocks.
//
// `chart` keeps its old behaviour (an invalid spec still becomes a chart, so the error card
// with its Fix button appears); anything else must actually validate.
//
// Shared by extraction and replacement so the two can never disagree about which block is
// which — they used to, and the Fix button silently failed to write back.
function chartBlocks(markdown) {
  const text = String(markdown ?? "");
  const re = /```([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  const blocks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const jsonText = m[2].trim();
    const declared = /^chart$/i.test(m[1]);
    const isChart = declared || (/^\s*\{/.test(jsonText) && parseChartSpec(jsonText).ok);
    if (isChart) {
      blocks.push({ start: m.index, end: re.lastIndex, tag: m[1], jsonText });
    }
  }
  return { text, blocks };
}

// Extract chart blocks from markdown and replace them with placeholder divs that
// renderChartsIn can fill. Returns { html, charts: [{id, jsonText}] }.
export function extractCharts(markdown) {
  const { text, blocks } = chartBlocks(markdown);
  const charts = [];
  if (!blocks.length) return { html: text, charts };

  let html = "";
  let cursor = 0;
  for (const block of blocks) {
    const id = `ws-chart-${charts.length}`;
    charts.push({ id, jsonText: block.jsonText });
    html += text.slice(cursor, block.start)
      + `<div class="ws-chart-holder" data-chart-id="${id}"></div>`;
    cursor = block.end;
  }
  return { html: html + text.slice(cursor), charts };
}

// Swap corrected JSON back into the chart blocks, in order, keeping each block's original
// fence tag. Returns the markdown untouched when the counts disagree, so a mismatch can
// never silently mangle the report.
export function replaceChartBodies(markdown, charts) {
  const { text, blocks } = chartBlocks(markdown);
  if (blocks.length !== charts.length) return text;

  let out = "";
  let cursor = 0;
  for (const [i, block] of blocks.entries()) {
    out += text.slice(cursor, block.start)
      + `\`\`\`${block.tag}\n${charts[i].jsonText}\n\`\`\``;
    cursor = block.end;
  }
  return out + text.slice(cursor);
}

// Render all chart placeholders inside a container. Invalid specs show an
// error card with the validation message and a Fix button wired to onFix.
export async function renderChartsIn(container, charts, { onFix } = {}) {
  for (const c of charts) {
    const holder = container.querySelector(`[data-chart-id="${c.id}"]`);
    if (!holder) continue;
    const parsed = parseChartSpec(c.jsonText);
    if (!parsed.ok) {
      holder.innerHTML = "";
      const card = document.createElement("div");
      card.className = "ws-chart-error";
      const msg = document.createElement("p");
      msg.textContent = `⚠ Chart spec problem — ${parsed.error}`;
      const pre = document.createElement("pre");
      pre.textContent = c.jsonText.slice(0, 400);
      const fix = document.createElement("button");
      fix.className = "ws-btn small";
      fix.type = "button";
      fix.textContent = "Ask model to fix";
      fix.addEventListener("click", () => onFix?.(c.jsonText, parsed.error));
      card.append(msg, pre, fix);
      holder.appendChild(card);
      continue;
    }
    try {
      await drawChart(holder, parsed.spec);
    } catch (e) {
      holder.innerHTML = `<div class="ws-chart-error"><p>⚠ Could not render chart: ${String(e?.message ?? e)}</p></div>`;
    }
  }
}

async function drawChart(holder, spec) {
  const Chart = await loadChartJs();
  holder.innerHTML = "";
  const title = document.createElement("div");
  title.className = "ws-chart-title";
  title.textContent = spec.title;
  const canvasHost = document.createElement("div");
  canvasHost.className = "ws-chart-canvas";
  const canvas = document.createElement("canvas");
  canvasHost.appendChild(canvas);
  holder.append(title, canvasHost);

  new Chart(canvas, {
    type: chartTypeFor(spec),
    data: { labels: spec.labels, datasets: datasetsFor(spec, darkPalette) },
    options: chartOptions(spec, darkTheme),
  });
}

// ---- themes -------------------------------------------------------------
// The app UI is dark; exported HTML documents are light. Charts are therefore
// rendered twice: dark in-app, and re-rendered with a light theme when an
// export is baked (see renderLightPng below).

const darkPalette = [
  "rgba(100, 255, 160, 0.75)",
  "rgba(120, 170, 255, 0.75)",
  "rgba(255, 205, 107, 0.75)",
  "rgba(255, 122, 107, 0.75)",
  "rgba(190, 140, 255, 0.75)",
  "rgba(120, 225, 225, 0.75)",
];

const lightPalette = [
  "rgba(26, 148, 86, 0.85)",
  "rgba(37, 99, 235, 0.8)",
  "rgba(217, 119, 6, 0.85)",
  "rgba(220, 38, 38, 0.8)",
  "rgba(124, 58, 237, 0.8)",
  "rgba(13, 148, 136, 0.85)",
];

const darkTheme = {
  tick: "rgba(255,255,255,.45)",
  grid: "rgba(255,255,255,.05)",
  legend: "rgba(255,255,255,.65)",
};

const lightTheme = {
  tick: "rgba(0,0,0,.55)",
  grid: "rgba(0,0,0,.08)",
  legend: "rgba(0,0,0,.7)",
};

function chartTypeFor(spec) {
  return spec.type === "area" ? "line" : spec.type;
}

function datasetsFor(spec, palette) {
  const isPieLike = spec.type === "pie" || spec.type === "doughnut";
  return spec.series.map((s, i) => ({
    label: s.label,
    data: s.data,
    backgroundColor: isPieLike
      ? spec.labels.map((_, j) => palette[j % palette.length])
      : palette[i % palette.length],
    borderColor: isPieLike ? undefined : palette[i % palette.length].replace(/0\.\d+\)/, "1)"),
    borderWidth: isPieLike ? 0 : 2,
    fill: spec.type === "area",
    tension: 0.35,
    pointRadius: spec.labels.length > 40 ? 0 : 3,
  }));
}

function chartOptions(spec, theme) {
  const isPieLike = spec.type === "pie" || spec.type === "doughnut";
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { labels: { color: theme.legend, font: { family: "Geist" } } },
    },
    scales: isPieLike ? {} : {
      x: { ticks: { color: theme.tick, maxRotation: 45, autoSkip: true }, grid: { color: theme.grid } },
      y: { ticks: { color: theme.tick }, grid: { color: theme.grid }, title: spec.yLabel ? { display: true, text: spec.yLabel, color: theme.tick } : undefined },
    },
  };
}

// Render a chart spec onto an offscreen canvas with the LIGHT theme and
// return a PNG data URL — used when baking charts into exported HTML files,
// so graphs stay readable on the white page.
export async function renderLightPng(spec, { width = 800, height = 400 } = {}) {
  const Chart = await loadChartJs();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const chart = new Chart(canvas.getContext("2d"), {
    type: chartTypeFor(spec),
    data: { labels: spec.labels, datasets: datasetsFor(spec, lightPalette) },
    options: {
      ...chartOptions(spec, lightTheme),
      responsive: false,
      animation: false,
    },
  });
  // give Chart.js one frame to lay out (animation is off)
  await new Promise((r) => requestAnimationFrame(() => r()));
  const url = canvas.toDataURL("image/png");
  chart.destroy();
  return url;
}
