// apps/reports/outline.js — pull the report outline out of a model reply.
//
// Kept as a pure, dependency-free module so it can be tested in Node: this is the stage
// that gates the entire Reports app, and it used to fail intermittently in a way that was
// invisible to the unit tests because the logic lived inside a DOM-bound app module.
//
// WHY THIS IS NOT JUST JSON.parse
//
// The planner prompt includes a format example:
//
//     Format: [{"title":"Section title","purpose":"one sentence"}]
//
// With thinking enabled, the model echoes that example inside its reasoning — and the
// example is *itself* valid JSON. A greedy `match(/\[[\s\S]*\]/)` starts at that first
// bracket and runs to the last one in the whole reply, so the extracted span mixes the
// example, prose and the real answer and fails to parse. The app then spent its single
// retry the same way and gave up with "Could not get a valid outline."
//
// So: try a fenced block first, then every bracket span from the RIGHT, and accept only a
// genuine outline (an array of objects that each carry a string `title`). The real answer
// always comes after the reasoning, so searching from the right finds it before the echoed
// example; requiring at least two entries rejects that one-item example outright.

/**
 * @param {string} text  raw model output (post-think answer, or anything, really)
 * @returns {Array<{title: string, purpose?: string}> | null}
 */
export function parseOutline(text) {
  const source = String(text ?? "");

  const isOutline = (value) =>
    Array.isArray(value)
    && value.length >= 2
    && value.every((item) => item && typeof item === "object" && typeof item.title === "string");

  const accept = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      return isOutline(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  // The model often wraps it in a fence even when told not to.
  const fenced = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/i.exec(source);
  if (fenced) {
    const parsed = accept(fenced[1].trim());
    if (parsed) return parsed;
  }

  const starts = [];
  for (let i = source.indexOf("["); i !== -1; i = source.indexOf("[", i + 1)) starts.push(i);
  const ends = [];
  for (let i = source.indexOf("]"); i !== -1; i = source.indexOf("]", i + 1)) ends.push(i);

  for (let a = starts.length - 1; a >= 0; a--) {
    for (let b = ends.length - 1; b >= 0; b--) {
      if (ends[b] <= starts[a]) break;
      const parsed = accept(source.slice(starts[a], ends[b] + 1));
      if (parsed) return parsed;
    }
  }

  return null;
}
