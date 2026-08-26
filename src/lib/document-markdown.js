export function formatDocumentMarkdown(doc) {
  if (!doc?.text) return "";
  const sourceName = String(doc.name || "document");
  const title = sourceName.replace(/\.[^.]+$/, "") || sourceName;
  const lines = [`# ${title}`, "", `- Source file: ${sourceName}`, `- Type: ${String(doc.kind || "document").toUpperCase()}`];
  if (doc.pages?.length) lines.push(`- Pages: ${doc.pages.length}`);
  const ocrPages = doc.pages?.filter((page) => page.ocr).length ?? (doc.kind === "image" ? 1 : 0);
  if (ocrPages) lines.push(`- OCR pages: ${ocrPages}`);
  lines.push("", "---", "");

  if (doc.pages?.length) {
    for (const page of doc.pages) {
      lines.push(`## Page ${page.page}${page.ocr ? " (OCR)" : ""}`, "", page.text || "_[No extracted text]_", "");
    }
  } else if (doc.kind === "image") {
    lines.push("## OCR transcription", "", doc.text, "");
  } else {
    lines.push(doc.text, "");
  }
  return lines.join("\n");
}