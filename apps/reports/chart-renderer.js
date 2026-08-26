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

// Extract ```chart fenced blocks from markdown and replace them with placeholder
// divs that renderChartInto can fill. Returns { html, charts: [{id, jsonText}] }.
export function extractCharts(markdown) {
  const charts = [];
  const html = String(markdown ?? "").replace(/```chart\r?\n([\s\S]*?)```/g, (_, json) => {
    const id = `ws-chart-${charts.length}`;
    charts.push({ id, jsonText: json.trim() });
    return `<div class="ws-chart-holder" data-chart-id="${id}"></div>`;
  });
  return { html, charts };
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
