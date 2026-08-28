// Minimal diff & patch apply util for the harness.
// Opencode-inspired but dependency-free. Computes a simple line-based preview diff
// and applies unified-hunk patches without requiring exact line numbers.

/**
 * Compute a line diff preview between old and new strings.
 * Returns { added, removed, preview: string }
 */
export function computeDiffPreview(oldText, newText, maxLines = 80) {
  const a = String(oldText || "").split("\n");
  const b = String(newText || "").split("\n");
  // naive LCS for preview: just show hunk around first change
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const removed = a.slice(start, endA + 1);
  const added = b.slice(start, endB + 1);
  const ctx = 2;
  const pre = a.slice(Math.max(0, start - ctx), start);
  const post = a.slice(endA + 1, Math.min(a.length, endA + 1 + ctx));
  const lines = [];
  for (const l of pre) lines.push(`  ${l}`);
  for (const l of removed) lines.push(`- ${l}`);
  for (const l of added) lines.push(`+ ${l}`);
  for (const l of post) lines.push(`  ${l}`);
  const preview = lines.slice(0, maxLines).join("\n") + (lines.length > maxLines ? `\n… (${lines.length - maxLines} more lines)` : "");
  return { added: added.length, removed: removed.length, preview, startLine: start + 1 };
}

/**
 * Apply a unified patch string to original content.
 * Format supports:
 *   @@ ... @@
 *   -removed line
 *   +added line
 *    context line (optional, not strictly required)
 *   We do NOT require line numbers to be correct — we search for the old hunk
 *   as a contiguous block (ignoring "@@" header) and replace it.
 *
 * If patch contains no "@@" and no +/- markers (i.e., a full file replacement
 * sneaked in), treat as error so caller can fallback to write_file.
 */
export function applyUnifiedPatch(original, patchText) {
  const src = String(original ?? "");
  const patch = String(patchText ?? "");
  if (!patch.trim()) throw new Error("patch is empty");

  // If patch looks like a full file (no diff markers), reject to avoid corruption
  const hasDiffMarkers = /^@@/m.test(patch) || /^[ +-]/.test(patch.split("\n").find(l => l.trim()) || "");
  // More robust: check any line starts with -/+ and at least one hunk header or +/- pairs
  const lines = patch.split("\n");
  const hunks = parseHunks(lines);
  if (hunks.length === 0) {
    // fallback: if patch contains at least one line starting with - or +, we can try old/new block extraction
    // otherwise error
    throw new Error("patch contains no hunks (expected @@ header or -/+ lines)");
  }

  let result = src;
  // Apply hunks in reverse order to keep offsets stable when we search
  // But since we search by content, order doesn't matter much — apply sequentially replacing first occurrence
  for (const h of hunks) {
    const oldBlock = h.oldLines.join("\n");
    const newBlock = h.newLines.join("\n");
    if (oldBlock.length === 0) {
      // Insertion only: try to find context anchor
      if (h.ctxBefore) {
        const anchor = h.ctxBefore[h.ctxBefore.length - 1];
        if (anchor && result.includes(anchor)) {
          const idx = result.indexOf(anchor) + anchor.length;
          // insert after anchor line
          // handle newline
          const before = result.slice(0, idx);
          const after = result.slice(idx);
          // avoid duplicating newline
          const insertion = (before.endsWith("\n") ? "" : "\n") + newBlock;
          result = before + insertion + after;
          continue;
        }
      }
      // append at end if no anchor
      result = result + (result.endsWith("\n") ? "" : "\n") + newBlock;
      continue;
    }
    if (!result.includes(oldBlock)) {
      // Try trimmed match (ignore trailing whitespace diffs)
      const normOld = oldBlock.trim();
      const idx = result.indexOf(normOld);
      if (idx !== -1) {
        result = result.slice(0, idx) + newBlock + result.slice(idx + normOld.length);
        continue;
      }
      throw new Error(`hunk not found in file — copy exact whitespace for:\n${oldBlock.slice(0, 300)}`);
    }
    // replace first occurrence only (unlike String.replaceAll)
    const idx = result.indexOf(oldBlock);
    result = result.slice(0, idx) + newBlock + result.slice(idx + oldBlock.length);
  }
  return result;
}

function parseHunks(lines) {
  const hunks = [];
  let cur = null;
  const flush = () => { if (cur && (cur.oldLines.length || cur.newLines.length)) hunks.push(cur); cur = null; };
  for (const raw of lines) {
    const line = raw; // preserve content without trimming beyond marker
    if (line.startsWith("@@")) {
      flush();
      cur = { header: line, oldLines: [], newLines: [], ctxBefore: [], ctxAfter: [] };
      continue;
    }
    if (!cur) cur = { header: "", oldLines: [], newLines: [], ctxBefore: [], ctxAfter: [] };
    if (line.startsWith("-")) cur.oldLines.push(line.slice(1));
    else if (line.startsWith("+")) cur.newLines.push(line.slice(1));
    else if (line.startsWith(" ")) {
      const txt = line.slice(1);
      // context belongs to both; we track for anchor logic
      if (cur.oldLines.length === 0 && cur.newLines.length === 0) cur.ctxBefore.push(txt);
      else { cur.oldLines.push(txt); cur.newLines.push(txt); }
    } else if (line === "" || line === "\\") {
      // empty / no newline marker — ignore
      continue;
    } else {
      // line without marker: treat as context if we are in a hunk with content, else ignore
      if (cur.oldLines.length || cur.newLines.length) {
        cur.oldLines.push(line);
        cur.newLines.push(line);
      }
    }
  }
  flush();
  return hunks;
}
