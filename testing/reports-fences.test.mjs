// testing/reports-fences.test.mjs — regression tests for Reports section/chart fences.
//
// THE BUG (reported: "every time there is a bar chart it goes wrong — the ``` are not at
// the end of the section"):
//
// Reports are generated one section per completion, then concatenated. The model
// sometimes wraps a whole section in a ``` fence, so each section was "unwrapped" by
// stripping the first fence and the last fence *independently*:
//
//     .replace(/^```(?:markdown|md)?\r?\n/, "").replace(/```\s*$/, "").trim()
//
// But a section that ends with a ```chart block also ends in ```. That closing fence was
// deleted, so the chart block was never terminated: its JSON ran on past the end of the
// section, and `extractCharts` (which needs a closing fence) either found nothing or
// matched all the way to the *next* fence in the document, swallowing the following
// section into the chart spec.
//
// Usage: node testing/reports-fences.test.mjs

import { stripWrapperFence, extractCharts, parseChartSpec } from "../apps/reports/chart-renderer.js";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const CHART = '{"type":"bar","title":"Revenue by quarter","labels":["Q1","Q2","Q3"],'
  + '"series":[{"label":"2025","data":[12,19,7]}]}';

const sectionEndingInChart = [
  "## Findinger",
  "",
  "Revenue grew through the first half.",
  "",
  "```chart",
  CHART,
  "```",
].join("\n");

const sectionPlain = "## Outlook\n\nWe expect continued growth.";

// --- stripWrapperFence ------------------------------------------------------

check(
  "trailing chart fence is kept",
  stripWrapperFence(sectionEndingInChart).endsWith("```"),
  "the chart's closing fence was removed"
);
check(
  "trailing chart fence is kept (content intact)",
  stripWrapperFence(sectionEndingInChart).includes(CHART)
);

const trailingCodeBlock = "## Example\n\n```python\nprint(1)\n```";
check(
  "trailing plain code fence is kept",
  stripWrapperFence(trailingCodeBlock).endsWith("```"),
  "any trailing fence was stripped, not just a wrapper"
);

const wrapped = "```markdown\n## Findings\n\nRevenue grew.\n```";
const unwrapped = stripWrapperFence(wrapped);
check("genuine wrapper is removed", !unwrapped.startsWith("```") && !unwrapped.endsWith("```"));
check("genuine wrapper keeps its content", unwrapped.includes("Revenue grew."));

const bareWrapped = "```\n## Findings\n\nRevenue grew.\n```";
check("bare ``` wrapper is removed", !stripWrapperFence(bareWrapped).startsWith("```"));

// A wrapper whose *content* ends in a chart: unwrap the outer pair, keep the inner close.
const wrappedWithChart = ["```markdown", "## Findings", "", "```chart", CHART, "```", "```"].join("\n");
const wwc = stripWrapperFence(wrappedWithChart);
check("wrapped+chart: outer wrapper removed", !wwc.startsWith("```"));
check("wrapped+chart: inner chart close kept", wwc.endsWith("```"));

eq("plain section is untouched", stripWrapperFence(sectionPlain), sectionPlain);
eq("empty input", stripWrapperFence(""), "");
eq("single fence line is not treated as a wrapper", stripWrapperFence("```"), "```");

// --- end to end: a report built the way the app builds one ------------------

function buildReport(sections, clean) {
  let md = "# Quarterly report\n_generated on-device_\n";
  for (const s of sections) md += `\n\n${clean(s)}\n`;
  return md;
}

// The reported case: one section that ends with a chart, followed by another section.
{
  const md = buildReport([sectionEndingInChart, sectionPlain], stripWrapperFence);
  const { html, charts } = extractCharts(md);
  eq("single trailing chart: exactly one chart extracted", charts.length, 1);
  check("single trailing chart: its JSON is valid", parseChartSpec(charts[0]?.jsonText ?? "").ok,
    parseChartSpec(charts[0]?.jsonText ?? "").error);
  check("single trailing chart: next section survives", html.includes("We expect continued growth."));
  check("single trailing chart: no stray fence left in the output", !html.includes("```chart"));
}

// Two chart-bearing sections — the case where the old strip swallowed a whole section.
{
  const section2 = ["## Outlook", "", "Expectations:", "", "```chart", CHART, "```"].join("\n");
  const md = buildReport([sectionEndingInChart, section2], stripWrapperFence);
  const { html, charts } = extractCharts(md);
  eq("two chart sections: two charts extracted", charts.length, 2);
  for (const [i, c] of charts.entries()) {
    const parsed = parseChartSpec(c.jsonText);
    check(`two chart sections: chart ${i + 1} JSON is valid`, parsed.ok, parsed.error);
  }
  check("two chart sections: the second heading is not inside a chart spec",
    !charts.some((c) => c.jsonText.includes("## Outlook")));
  check("two chart sections: the second heading survives in the output", html.includes("## Outlook"));
}

// --- why the fix exists: the previous strip corrupts the same input ---------
//
// Kept deliberately: it documents the failure mode, so the naive version does not get
// reintroduced as a "simplification".
{
  const naiveUnwrap = (t) => String(t ?? "")
    .replace(/^```(?:markdown|md)?\r?\n/, "")
    .replace(/```\s*$/, "")
    .trim();

  const one = extractCharts(buildReport([sectionEndingInChart, sectionPlain], naiveUnwrap));
  eq("(old behaviour) a trailing chart was dropped entirely", one.charts.length, 0);
  check("(old behaviour) the raw chart JSON leaked into the report text",
    one.html.includes('"type":"bar"'));

  const two = extractCharts(buildReport([
    sectionEndingInChart,
    ["## Outlook", "", "```chart", CHART, "```"].join("\n"),
  ], naiveUnwrap));
  check("(old behaviour) the next section was swallowed into a chart spec",
    two.charts.some((c) => c.jsonText.includes("## Outlook")));
}

// --- report ------------------------------------------------------------------

console.log(`\nreports-fences: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  x ${f}`);
  process.exit(1);
}
console.log("reports-fences: all green");
