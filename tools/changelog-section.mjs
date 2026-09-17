// tools/changelog-section.mjs — print the CHANGELOG section for a version.
//
// This project is CHANGELOG-driven (no git tags drive the notes, and the file is the
// source of truth for what changed), so release notes are extracted from it rather than
// generated from commit titles.
//
// Usage:
//   node tools/changelog-section.mjs 3.0.0        # body of the 3.0.0 section
//   node tools/changelog-section.mjs 2.0.0        # works for older versions too
//
// Exits non-zero when the version has no section, so a release fails loudly instead of
// publishing empty notes.

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const version = String(process.argv[2] ?? "").trim().replace(/^v/, "");
if (!version) {
  console.error("usage: node tools/changelog-section.mjs <version>   (e.g. 3.0.0)");
  process.exit(2);
}

const changelog = await readFile(resolve(ROOT, "CHANGELOG.md"), "utf8");
const lines = changelog.split("\n");

// Sections look like: `## [3.0.0] — 2026-09-13` or `## [Unreleased]`.
// Match the exact version, tolerating a leading `v` and surrounding whitespace.
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

const body = lines.slice(start + 1, end).join("\n").trim();
if (!body) {
  console.error(`The CHANGELOG section for ${version} is empty.`);
  process.exit(1);
}

process.stdout.write(body + "\n");
