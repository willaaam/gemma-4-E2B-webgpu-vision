// Document parsers for the workstation. All parsing happens in-browser.
// PDF via pdf.js (CDN), DOCX via mammoth (CDN), TXT/MD/JSON/CSV natively.
// Scanned PDF pages (no text layer) are flagged so the vision tower can OCR them.

const CDN = {
  pdf: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  pdfWorker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  mammoth: "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js",
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src="${src}"]`);
    if (existing) { existing.addEventListener("load", () => resolve()); existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`))); if (existing.dataset.loaded) resolve(); return; }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.dataset.src = src;
    s.onload = () => { s.dataset.loaded = "1"; resolve(); };
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function getPdfJs() {
  if (!window.pdfjsLib) await loadScript(CDN.pdf);
  const lib = window.pdfjsLib;
  if (!lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
  return lib;
}

export function isSupported(file) {
  const name = file.name.toLowerCase();
  return /\.(txt|md|markdown|json|csv|tsv|log|pdf|docx|html?)$/.test(name) || file.type.startsWith("image/");
}

export function kindOf(file) {
  const name = file.name.toLowerCase();
  if (file.type.startsWith("image/")) return "image";
  if (name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".docx")) return "docx";
  if (name.endsWith(".csv") || name.endsWith(".tsv")) return "csv";
  if (name.endsWith(".json")) return "json";
  return "text";
}

/**
 * Parse an uploaded file into a document record.
 * @returns {Promise<{kind:string, text:string, pages?:Array<{page:number,text:string,scanned?:boolean}>, needsOcr:boolean}>}
 */
export async function parseFile(file, { onProgress } = {}) {
  const kind = kindOf(file);
  if (kind === "pdf") return parsePdf(file, { onProgress });
  if (kind === "docx") return parseDocx(file);
  if (kind === "image") return { kind, text: "", needsOcr: true };
  // plain-text family
  let text = await file.text();
  if (kind === "csv" || kind === "tsv") text = summarizeCsvShape(text) + "\n\n" + text;
  if (kind === "json") text = `The following is JSON data:\n\n${text}`;
  return { kind, text, needsOcr: false };
}

async function parsePdf(file, { onProgress } = {}) {
  const pdfjs = await getPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.(`Extracting page ${i}/${pdf.numPages}`);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // join items, inserting newlines when a big Y-jump suggests a line break
    let lastY = null;
    let text = "";
    for (const item of content.items) {
      const y = item.transform?.[5];
      if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) text += "\n";
      else if (text && !text.endsWith(" ") && !item.str.startsWith(" ")) text += " ";
      text += item.str;
      if (y !== undefined) lastY = y;
    }
    text = text.replace(/[ \t]+\n/g, "\n").trim();
    pages.push({ page: i, text, scanned: text.length < 32 }); // effectively no text layer
  }
  const needsOcr = pages.some((p) => p.scanned);
  const text = pages.map((p) => p.text).join("\n\n");
  return { kind: "pdf", text, pages, needsOcr };
}

async function parseDocx(file) {
  if (!window.mammoth) await loadScript(CDN.mammoth);
  const arrayBuffer = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer });
  return { kind: "docx", text: result.value ?? "", needsOcr: false };
}

// Prepend a tiny structural summary so the model can reason about wide CSVs.
function summarizeCsvShape(text) {
  try {
    const lines = text.trim().split(/\r?\n/);
    const header = lines[0]?.split(/[,;\t]/).map((h) => h.trim()).filter(Boolean) ?? [];
    return `[CSV: ${lines.length - 1} rows × ${header.length} columns. Columns: ${header.join(", ")}]`;
  } catch { return ""; }
}

// Render page images of a PDF range for vision OCR.
export async function renderPdfPageToDataUrl(file, pageNumber, { scale = 2 } = {}) {
  const pdfjs = await getPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL("image/png");
}
