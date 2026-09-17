// tools/changelog-section.mjs — build the release-notes body for a version.
//
// This project is CHANGELOG-driven (the file is the source of truth for what changed),
// so release notes are extracted from it rather than generated from commit titles.
//
// Usage:
//   node tools/changelog-section.mjs 3.1.0
//   node tools/changelog-section.mjs 3.1.0 --brief
//   node tools/changelog-section.mjs 3.1.0 --brief --usage docs/RELEASE-HOWTO.md
//
//   --brief           collapse each bullet to its bolded lead and drop sub-bullets, so the
//                     release page stays scannable while the CHANGELOG keeps full detail
//   --usage <path>    prepend that file (e.g. the how-to-use notes) ahead of the changes
//
// Exits non-zero when the version has no section, so a release fails loudly instead of
// publishing empty notes.

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const usageIdx = argv.indexOf("--usage");
const usagePath = usageIdx !== -1 ? argv[usageIdx + 1] : null;
const version = argv.find((a) => !a.startsWith("--") && a !== usagePath)?.trim().replace(/^v/, "");
const BRIEF = flags.has("--brief");

if (!version) {
  console.error("usage: node tools/changelog-section.mjs <version> [--brief] [--usage <file>]");
  process.exit(2);
}
if (usageIdx !== -1 && !usagePath) {
  console.error("--usage requires a file path");
  process.exit(2);
}

/**
 * Compress a section for a release page: keep headings and the first line of each
 * bullet, drop the explanatory continuation lines and any sub-bullets.
 */
function briefify(body) {
  const out = [];
  for (const line of body.split("\n")) {
    if (line.trim() === "") {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (/^#{3,}\s/.test(line)) { out.push(line); continue; }   // sub-headings
    if (/^\s/.test(line)) continue;     // continuation text and nested bullets
    const bold = /^- \*\*(.+?)\*\*/.exec(line);
    if (bold) { out.push(`- **${bold[1]}**`); continue; }
    out.push(line);                                              // plain bullet or prose
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const changelog = await readFile(resolve(ROOT, "CHANGELOG.md"), "utf8");
const lines = changelog.split("\n");

// Sections look like: `## [3.1.0] — 2026-09-17` or `## [Unreleased]`.
const isHeading = (line) => /^##\s+\[/.test(line);
const wanted = new RegExp(`^##\\s+\\[v?${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`);

const start = lines.findIndex((line) => wanted.test(line));
if (start === -1) {
  const known = lines.filter(isHeading).map((l) => l.trim()).join("\n  ");
  console.error(`No CHANGELOG section for ${version}.\n\nSections present:\n  ${known}`);
  process.exit(1);
}

// Body runs until the next `## [` heading (or the end of the file).
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (isHeading(lines[i])) { end = i; break; }
}

const raw = lines.slice(start + 1, end).join("\n").trim();
if (!raw) {
  console.error(`The CHANGELOG section for ${version} is empty.`);
  process.exit(1);
}

const changes = BRIEF ? briefify(raw) : raw;

let body = `## What's new in ${version}\n\n${changes}\n`;

if (usagePath) {
  const usage = (await readFile(resolve(ROOT, usagePath), "utf8")).trim();
  body = `${usage}\n\n---\n\n${body}`;
}

process.stdout.write(body);
