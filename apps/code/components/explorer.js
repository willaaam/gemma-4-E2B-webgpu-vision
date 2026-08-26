// File explorer sidebar for the code workstation.
// Renders a collapsible tree from CodeProject.getTree(), supports create/delete/rename/move + zip/reset.

import { normalizePathExport, isValidPath, dirname, basename } from "../../../src/services/code-project.js";
import { unzipToFiles, downloadZip } from "../../../src/lib/zip-utils.js";

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function iconFor(type, name) {
  if (type === "dir") return "📁";
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".py")) return "🐍";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "🌐";
  if (lower.endsWith(".css")) return "🎨";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".ts")) return "📜";
  if (lower.endsWith(".json")) return "🧾";
  if (lower.endsWith(".md")) return "📝";
  return "📄";
}

export function createExplorer({ container, project, onOpenFile, onFilesChanged, onReset }) {
  let selectedPath = null;
  let expanded = new Set([""]); // root always expanded; store dir paths

  // state for drag
  let draggedPath = null;

  function render() {
    const tree = project.getTree();
    container.replaceChildren();
    // toolbar
    const toolbar = h("div", "ws-explorer-toolbar");
    const leftBtns = h("div", "ws-explorer-btns");
    const newFileBtn = h("button", "ws-btn ghost tiny", "+ File");
    newFileBtn.title = "New file (inside selected folder)";
    const newFolderBtn = h("button", "ws-btn ghost tiny", "+ Folder");
    newFolderBtn.title = "New folder";
    const uploadBtn = h("button", "ws-btn ghost tiny", "⬆ Zip");
    uploadBtn.title = "Upload zip — merges into project";
    const downloadBtn = h("button", "ws-btn ghost tiny", "⬇ Zip");
    downloadBtn.title = "Download project as zip";
    const resetBtn = h("button", "ws-btn ghost tiny ws-btn danger", "Reset");
    resetBtn.title = "Reset project to default template";

    newFileBtn.addEventListener("click", () => promptCreateFile());
    newFolderBtn.addEventListener("click", () => promptCreateFolder());
    uploadBtn.addEventListener("click", () => promptUploadZip());
    downloadBtn.addEventListener("click", () => doDownloadZip(downloadBtn));
    resetBtn.addEventListener("click", () => confirmReset());

    leftBtns.append(newFileBtn, newFolderBtn);
    const rightBtns = h("div", "ws-explorer-btns");
    rightBtns.append(uploadBtn, downloadBtn, resetBtn);
    toolbar.append(leftBtns, rightBtns);
    container.appendChild(toolbar);

    // stats bar
    const stats = project.getStats();
    const info = h("div", "ws-explorer-info mono", `${stats.files} files · ${(stats.totalChars / 1024).toFixed(1)} KB`);

    // hidden file inputs for zip
    const zipInput = h("input", null);
    zipInput.type = "file";
    zipInput.accept = ".zip,application/zip";
    zipInput.hidden = true;
    zipInput.addEventListener("change", async () => {
      const file = zipInput.files?.[0];
      if (!file) return;
      zipInput.value = "";
      await doUploadZip(file);
    });

    container.append(info, zipInput);
    // store for later
    container._zipInput = zipInput;

    const treeRoot = h("div", "ws-explorer-tree");
    // render root children recursively
    for (const child of tree.children) renderNode(child, treeRoot, 0);
    if (tree.children.length === 0) {
      const empty = h("div", "ws-empty small", "No files. Create one or upload a zip.");
      treeRoot.appendChild(empty);
    }
    container.appendChild(treeRoot);
  }

  function renderNode(node, parentEl, depth) {
    const row = h("div", "ws-explorer-row " + (node.path === selectedPath ? "selected" : ""));
    row.draggable = true;
    row.dataset.path = node.path;
    row.style.paddingLeft = `${8 + depth * 14}px`;

    const twist = h("span", "ws-explorer-twist", node.type === "dir" ? (expanded.has(node.path) ? "▾" : "▸") : "·");
    twist.style.visibility = node.type === "dir" ? "visible" : "hidden";
    const icon = h("span", "ws-explorer-icon", iconFor(node.type, node.name));
    const label = h("span", "ws-explorer-label", node.name);
    label.title = node.path;

    row.append(twist, icon, label);

    // context menu button
    const more = h("button", "ws-explorer-more", "⋯");
    more.title = "More actions";
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      showContextMenu(node, more);
    });

    row.appendChild(more);

    // click / double
    row.addEventListener("click", (e) => {
      selectedPath = node.path;
      if (node.type === "dir") {
        if (expanded.has(node.path)) expanded.delete(node.path);
        else expanded.add(node.path);
        render();
      } else {
        // highlight + open
        highlightSelection();
        onOpenFile?.(node.path);
      }
    });
    row.addEventListener("dblclick", () => {
      if (node.type === "file") {
        selectedPath = node.path;
        highlightSelection();
        onOpenFile?.(node.path);
      }
    });

    // drag
    row.addEventListener("dragstart", (e) => {
      draggedPath = node.path;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", node.path);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => { draggedPath = null; row.classList.remove("dragging"); parentEl.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over")); });
    row.addEventListener("dragover", (e) => {
      if (!draggedPath || draggedPath === node.path) return;
      // only allow drop on dirs, or file's parent dir
      const targetIsDir = node.type === "dir";
      const fromDir = dirname(draggedPath);
      const targetDir = targetIsDir ? node.path : dirname(node.path);
      if (draggedPath === targetDir) return;
      // prevent dropping folder into itself
      if (draggedPath && targetIsDir && (node.path === draggedPath || node.path.startsWith(draggedPath + "/"))) return;
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const from = draggedPath;
      if (!from) return;
      const targetIsDir = node.type === "dir";
      let targetDir = targetIsDir ? node.path : dirname(node.path);
      // if dragging file, move inside targetDir; if dragging folder, move inside targetDir
      const base = basename(from);
      const dest = targetDir ? `${targetDir}/${base}` : base;
      if (dest === from) return;
      try {
        const isFile = project.has(from);
        if (isFile) project.rename(from, dest);
        else project.moveFolder(from, dest);
        selectedPath = dest;
        await onFilesChanged?.({ type: "move", from, to: dest });
        render();
      } catch (err) { alert(String(err?.message ?? err)); }
    });

    parentEl.appendChild(row);

    if (node.type === "dir" && expanded.has(node.path) && node.children) {
      for (const child of node.children) renderNode(child, parentEl, depth + 1);
    }
  }

  function highlightSelection() {
    container.querySelectorAll(".ws-explorer-row").forEach(el => el.classList.toggle("selected", el.dataset.path === selectedPath));
  }

  function promptCreateFile() {
    const baseDir = selectedPath && !project.has(selectedPath) ? selectedPath : (selectedPath ? dirname(selectedPath) : "");
    const hint = baseDir ? `${baseDir}/` : "";
    const name = prompt(`New file path (relative to project root)\nExample: ${hint}utils/helpers.py`, hint);
    if (!name) return;
    const full = normalizePathExport(baseDir ? `${baseDir}/${name}` : name);
    if (!full) return;
    if (!isValidPath(full)) { alert("Invalid path"); return; }
    if (project.has(full)) { alert("File already exists"); return; }
    try {
      project.set(full, "");
      selectedPath = full;
      expanded.add(dirname(full));
      onFilesChanged?.({ type: "create", path: full });
      render();
      onOpenFile?.(full);
    } catch (e) { alert(String(e?.message ?? e)); }
  }

  function promptCreateFolder() {
    const baseDir = selectedPath && !project.has(selectedPath) ? selectedPath : (selectedPath ? dirname(selectedPath) : "");
    const hint = baseDir ? `${baseDir}/` : "";
    const name = prompt(`New folder path\nExample: ${hint}components`, hint);
    if (!name) return;
    const full = normalizePathExport(baseDir ? `${baseDir}/${name}` : name);
    if (!full) return;
    // create placeholder file to materialize folder? Instead we just keep expanded set; folders are implicit.
    // We create a .keep empty file then delete it visually? Better: store explicit folder marker via expanded, but we need file to show. Create placeholder.
    // Instead, create folder/.gitkeep
    const keep = `${full}/.gitkeep`;
    if (project.has(keep)) { alert("Already exists"); return; }
    try {
      project.set(keep, "");
      expanded.add(full);
      selectedPath = full;
      onFilesChanged?.({ type: "create", path: keep });
      render();
    } catch (e) { alert(String(e?.message ?? e)); }
  }

  function showContextMenu(node, anchor) {
    // simple prompt-based menu; avoid heavy popover lib
    const actions = node.type === "dir"
      ? ["Rename", "Move", "Delete", "New file here", "New folder here"]
      : ["Rename", "Move", "Delete", "Duplicate"];
    const choice = prompt(`Actions for ${node.path}:\n` + actions.map((a, i) => `${i + 1}. ${a}`).join("\n") + "\n\nEnter number or name: ", "1");
    if (!choice) return;
    const idx = parseInt(choice, 10) - 1;
    const action = Number.isFinite(idx) && actions[idx] ? actions[idx] : choice.trim().toLowerCase();
    if (/rename/.test(action) || choice === "1") doRename(node);
    else if (/move/.test(action) || choice === "2") doMove(node);
    else if (/delete/.test(action) || choice === "3") doDelete(node);
    else if (node.type === "dir" && /new file/.test(action)) promptCreateFile();
    else if (node.type === "dir" && /new folder/.test(action)) promptCreateFolder();
    else if (node.type === "file" && /duplicate/.test(action)) doDuplicate(node);
  }

  function doRename(node) {
    const newName = prompt(`Rename ${node.path} →`, node.path);
    if (!newName || newName === node.path) return;
    const dest = normalizePathExport(newName);
    if (!isValidPath(dest)) { alert("Invalid path"); return; }
    try {
      if (node.type === "file") project.rename(node.path, dest);
      else project.moveFolder(node.path, dest);
      selectedPath = dest;
      onFilesChanged?.({ type: "rename", from: node.path, to: dest });
      render();
      if (node.type === "file") onOpenFile?.(dest);
    } catch (e) { alert(String(e?.message ?? e)); }
  }

  function doMove(node) {
    const destDir = prompt(`Move ${node.path} into folder (empty = root):`, dirname(node.path));
    if (destDir == null) return;
    const base = basename(node.path);
    const dest = destDir.trim() ? normalizePathExport(`${destDir.trim()}/${base}`) : base;
    if (dest === node.path) return;
    if (!isValidPath(dest)) { alert("Invalid destination"); return; }
    try {
      if (node.type === "file") project.rename(node.path, dest);
      else project.moveFolder(node.path, dest);
      selectedPath = dest;
      onFilesChanged?.({ type: "move", from: node.path, to: dest });
      render();
    } catch (e) { alert(String(e?.message ?? e)); }
  }

  function doDelete(node) {
    if (!confirm(`Delete ${node.path} ?\n${node.type === "dir" ? "This will delete all files inside." : ""}`)) return;
    try {
      if (node.type === "file") project.delete(node.path);
      else project.deleteFolder(node.path);
      if (selectedPath === node.path || selectedPath?.startsWith(node.path + "/")) selectedPath = null;
      onFilesChanged?.({ type: "delete", path: node.path });
      render();
    } catch (e) { alert(String(e?.message ?? e)); }
  }

  function doDuplicate(node) {
    if (node.type !== "file") return;
    const dir = dirname(node.path);
    const base = basename(node.path);
    const extIdx = base.lastIndexOf(".");
    const stem = extIdx > 0 ? base.slice(0, extIdx) : base;
    const ext = extIdx > 0 ? base.slice(extIdx) : "";
    let candidate = dir ? `${dir}/${stem}-copy${ext}` : `${stem}-copy${ext}`;
    let n = 2;
    while (project.has(candidate)) candidate = dir ? `${dir}/${stem}-copy${n++}${ext}` : `${stem}-copy${n++}${ext}`;
    try {
      const content = project.getContent(node.path) ?? "";
      project.set(candidate, content);
      selectedPath = candidate;
      expanded.add(dir);
      onFilesChanged?.({ type: "create", path: candidate });
      render();
      onOpenFile?.(candidate);
    } catch (e) { alert(String(e?.message ?? e)); }
  }

  function promptUploadZip() {
    container._zipInput?.click();
  }

  async function doUploadZip(file) {
    const before = project.listPaths().length;
    try {
      const files = await unzipToFiles(file);
      const count = Object.keys(files).length;
      if (count === 0) { alert("Zip contained no importable text files."); return; }
      // Merge: overwrite? Ask
      const existing = project.listPaths();
      const overlap = Object.keys(files).filter(k => existing.includes(k));
      if (overlap.length > 0) {
        const ok = confirm(`${count} files in zip, ${overlap.length} will overwrite existing files.\nProceed?`);
        if (!ok) return;
      }
      for (const [p, content] of Object.entries(files)) {
        try { project.set(p, content); expanded.add(dirname(p)); } catch {}
      }
      // auto-expand top-level dirs from zip
      const topDirs = new Set(Object.keys(files).map(p => p.split("/")[0]).filter(Boolean));
      for (const d of topDirs) expanded.add(d);
      await onFilesChanged?.({ type: "zip-import", count });
      render();
      alert(`Imported ${count} files from zip.`);
    } catch (e) { alert("Failed to unzip: " + String(e?.message ?? e)); }
  }

  async function doDownloadZip(btn) {
    const orig = btn.textContent;
    btn.textContent = "…";
    btn.disabled = true;
    try {
      const filesObj = {};
      for (const [p, data] of project.files) filesObj[p] = data.content;
      const { downloadZip } = await import("../../../src/lib/zip-utils.js");
      await downloadZip(filesObj, "project.zip");
    } catch (e) { alert("Download failed: " + String(e?.message ?? e)); }
    finally { btn.textContent = orig; btn.disabled = false; }
  }

  async function confirmReset() {
    if (!confirm("Reset project? This will delete all files and restore the default template (README, main.py, index.html, style.css, script.js).\nThis cannot be undone.")) return;
    onReset?.();
  }

  // external drag-drop on the whole explorer pane for zip
  container.addEventListener("dragover", (e) => {
    if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); container.classList.add("drag-over"); }
  });
  container.addEventListener("dragleave", () => container.classList.remove("drag-over"));
  container.addEventListener("drop", async (e) => {
    const f = [...e.dataTransfer.files].find(x => x.name.toLowerCase().endsWith(".zip"));
    if (!f) return;
    e.preventDefault();
    container.classList.remove("drag-over");
    await doUploadZip(f);
  });

  return {
    render,
    setSelected(path) { selectedPath = path ? normalizePathExport(path) : null; highlightSelection(); },
    setExpanded(path, on) { if (on) expanded.add(path); else expanded.delete(path); },
    refresh() { render(); },
    getSelected() { return selectedPath; },
  };
}
