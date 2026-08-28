// File explorer sidebar for the code workstation.
// Renders a collapsible tree from CodeProject.getTree(), supports create/delete/rename/move + zip/reset.
// GUI file operations: right-click context menu + modal dialogs + toast — no prompt/confirm/alert.

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

// ---- Toast ----
function showToast(message, type = "info") {
  let host = document.querySelector(".ws-toast-host");
  if (!host) {
    host = document.createElement("div");
    host.className = "ws-toast-host";
    host.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:1002;display:flex;flex-direction:column;gap:8px;pointer-events:none;";
    document.body.appendChild(host);
  }
  const toast = h("div", `ws-toast ${type}`, message);
  // allow pointer events on toast for dismiss? keep none
  toast.style.pointerEvents = "auto";
  toast.style.position = "static";
  toast.style.transform = "none";
  toast.style.bottom = "auto";
  toast.style.left = "auto";
  host.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
    toast.style.transition = "all .22s ease";
    setTimeout(() => toast.remove(), 240);
  }, type === "error" ? 3400 : 2600);
}

// ---- Modal ----
function showModal({ title, message, placeholder, defaultValue = "", confirmText = "Confirm", danger = false, showInput = true, validate, onConfirm }) {
  return new Promise((resolve) => {
    const backdrop = h("div", "ws-modal-backdrop");
    const modal = h("div", "ws-modal");
    const h3 = h("h3", null, title);
    modal.appendChild(h3);
    if (message) {
      const p = h("p", null, message);
      modal.appendChild(p);
    }
    let input = null;
    let errorEl = null;
    if (showInput) {
      input = h("input");
      input.type = "text";
      input.placeholder = placeholder || "";
      input.value = String(defaultValue ?? "");
      input.autocomplete = "off";
      input.spellcheck = false;
      modal.appendChild(input);
      errorEl = h("div", "ws-modal-error");
      modal.appendChild(errorEl);
      // live validation preview: show full path
      const preview = h("div", "path-preview mono");
      preview.style.display = "none";
      modal.appendChild(preview);
      const updatePreview = () => {
        const v = input.value.trim();
        if (!v) { preview.style.display = "none"; return; }
        try {
          const norm = normalizePathExport(v);
          preview.textContent = norm ? `→ ${norm}` : "→ (invalid)";
          preview.style.display = "block";
        } catch { preview.style.display = "none"; }
      };
      input.addEventListener("input", () => {
        input.classList.remove("invalid");
        errorEl.textContent = "";
        updatePreview();
        if (validate) {
          const err = validate(input.value);
          if (err) { input.classList.add("invalid"); errorEl.textContent = err; }
        }
      });
      setTimeout(updatePreview, 0);
    } else if (message && !showInput) {
      // for confirm dialogs, show path preview if needed via message
    }
    const actions = h("div", "ws-modal-actions");
    const cancelBtn = h("button", "ws-btn ghost small", "Cancel");
    const okBtn = h("button", `ws-btn small ${danger ? "danger" : "primary"}`, confirmText);
    actions.append(cancelBtn, okBtn);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    let closed = false;
    const close = (val) => {
      if (closed) return;
      closed = true;
      backdrop.style.opacity = "0";
      backdrop.style.transition = "opacity .15s ease";
      setTimeout(() => backdrop.remove(), 150);
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
      if (e.key === "Enter" && showInput) { e.preventDefault(); tryConfirm(); }
    };
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(null); });
    cancelBtn.addEventListener("click", () => close(null));
    const tryConfirm = () => {
      const val = showInput ? input.value : true;
      if (showInput && validate) {
        const err = validate(val);
        if (err) { input.classList.add("invalid"); errorEl.textContent = err; input.focus(); return; }
      }
      if (onConfirm) {
        const res = onConfirm(val);
        // support async validator
        if (res instanceof Promise) {
          okBtn.disabled = true;
          okBtn.textContent = "…";
          res.then((ok) => {
            if (ok === false) { okBtn.disabled = false; okBtn.textContent = confirmText; return; }
            close(val);
          }).catch((err) => {
            input.classList.add("invalid");
            errorEl.textContent = String(err?.message ?? err);
            okBtn.disabled = false;
            okBtn.textContent = confirmText;
          });
          return;
        }
        if (res === false) return;
      }
      close(val);
    };
    okBtn.addEventListener("click", tryConfirm);
    setTimeout(() => input ? input.focus() : okBtn.focus(), 50);
    if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); tryConfirm(); }});
  });
}

function showConfirmModal({ title, message, confirmText = "Delete", danger = true }) {
  return showModal({ title, message, showInput: false, confirmText, danger });
}

// ---- Context Menu ----
let activeMenu = null;
function closeActiveMenu() {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onEsc);
  window.removeEventListener("scroll", closeActiveMenu, true);
  window.removeEventListener("resize", closeActiveMenu);
}
function onDocClick(e) {
  if (activeMenu && !activeMenu.contains(e.target)) closeActiveMenu();
}
function onEsc(e) { if (e.key === "Escape") closeActiveMenu(); }

function showContextMenu(x, y, items) {
  closeActiveMenu();
  const menu = h("div", "ws-context-menu");
  items.forEach((it) => {
    if (it.sep) { menu.appendChild(h("div", "sep")); return; }
    if (it.hint) { menu.appendChild(h("div", "hint", it.hint)); return; }
    const btn = h("button", it.danger ? "danger" : "", "");
    const icon = h("span", null, it.icon || "");
    icon.style.width = "14px"; icon.style.textAlign = "center"; icon.style.flex = "none";
    const label = h("span", null, it.label);
    btn.append(icon, label);
    if (it.disabled) { btn.disabled = true; btn.style.opacity = ".45"; }
    else btn.addEventListener("click", () => { closeActiveMenu(); it.action?.(); });
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  activeMenu = menu;
  // position, keep in viewport
  const pad = 8;
  const rect = menu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width + pad > window.innerWidth) left = window.innerWidth - rect.width - pad;
  if (top + rect.height + pad > window.innerHeight) top = window.innerHeight - rect.height - pad;
  if (left < pad) left = pad;
  if (top < pad) top = pad;
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  // defer doc click handler to avoid immediate close
  setTimeout(() => {
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onEsc);
    window.addEventListener("scroll", closeActiveMenu, true);
    window.addEventListener("resize", closeActiveMenu);
  }, 0);
}

export function createExplorer({ container, project, onOpenFile, onFilesChanged, onReset, onAskAgent, onAttachFile }) {
  let selectedPath = null;
  let expanded = new Set([""]); // root always expanded; store dir paths
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

    newFileBtn.addEventListener("click", () => handleCreateFile());
    newFolderBtn.addEventListener("click", () => handleCreateFolder());
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
    container._zipInput = zipInput;

    const treeRoot = h("div", "ws-explorer-tree");
    // empty state with drop hint
    // filter .gitkeep placeholders from display but keep folders that only contain them
    const visibleChildren = tree.children.filter(c => c.name !== ".gitkeep");
    for (const child of visibleChildren) renderNode(child, treeRoot, 0);
    if (visibleChildren.length === 0) {
      const empty = h("div", "ws-empty small");
      empty.innerHTML = `No files yet.<br>Use <b>+ File</b> / <b>+ Folder</b> or drop a .zip.`;
      treeRoot.appendChild(empty);
    }
    container.appendChild(treeRoot);

    // background context menu (right-click on empty pane)
    treeRoot.addEventListener("contextmenu", (e) => {
      if (e.target.closest(".ws-explorer-row")) return;
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: "New File", icon: "📄", action: () => handleCreateFile("") },
        { label: "New Folder", icon: "📁", action: () => handleCreateFolder("") },
        { sep: true },
        { label: "Upload Zip", icon: "⬆", action: () => promptUploadZip() },
        { label: "Download Zip", icon: "⬇", action: () => doDownloadZip(downloadBtn) },
      ]);
    });
  }

  function renderNode(node, parentEl, depth) {
    if (node.name === ".gitkeep") return;
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
      openContextMenu(node, e.clientX, e.clientY, e);
      // fallback position near button if no coords
      if (!e.clientX) {
        const r = more.getBoundingClientRect();
        openContextMenu(node, r.left, r.bottom + 4);
      }
    });

    row.appendChild(more);

    // click to select / expand / open
    row.addEventListener("click", (e) => {
      selectedPath = node.path;
      if (node.type === "dir") {
        if (expanded.has(node.path)) expanded.delete(node.path);
        else expanded.add(node.path);
        render();
      } else {
        highlightSelection();
        onOpenFile?.(node.path);
      }
    });

    // right-click context menu
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectedPath = node.path;
      highlightSelection();
      openContextMenu(node, e.clientX, e.clientY, e);
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
      const targetIsDir = node.type === "dir";
      const fromDir = dirname(draggedPath);
      const targetDir = targetIsDir ? node.path : dirname(node.path);
      if (draggedPath === targetDir) return;
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
        showToast(`Moved to ${dest}`, "success");
      } catch (err) { showToast(String(err?.message ?? err), "error"); }
    });

    parentEl.appendChild(row);

    if (node.type === "dir" && expanded.has(node.path) && node.children) {
      for (const child of node.children) renderNode(child, parentEl, depth + 1);
    }
  }

  function highlightSelection() {
    container.querySelectorAll(".ws-explorer-row").forEach(el => el.classList.toggle("selected", el.dataset.path === selectedPath));
  }

  function baseDirForSelected() {
    if (!selectedPath) return "";
    if (!project.has(selectedPath)) return selectedPath;
    return dirname(selectedPath);
  }

  async function handleCreateFile(baseDir = baseDirForSelected()) {
    const hint = baseDir ? `${baseDir}/` : "";
    const res = await showModal({
      title: "New File",
      message: baseDir ? `Create inside \`${baseDir}\`` : "Create at project root",
      placeholder: `${hint}utils/helpers.py`,
      defaultValue: hint,
      confirmText: "Create",
      validate: (v) => {
        const full = normalizePathExport(baseDir ? `${baseDir}/${v}` : v);
        // allow empty? require non-empty
        if (!v.trim()) return "Enter a file name";
        if (!full) return "Invalid path";
        if (!isValidPath(full)) return "Invalid characters or path";
        if (project.has(full)) return "File already exists";
        return "";
      },
      onConfirm: (v) => {
        const full = normalizePathExport(baseDir ? `${baseDir}/${v}` : v);
        try {
          project.set(full, "");
          selectedPath = full;
          expanded.add(dirname(full));
          onFilesChanged?.({ type: "create", path: full });
          render();
          onOpenFile?.(full);
          showToast(`Created ${full}`, "success");
        } catch (e) { showToast(String(e?.message ?? e), "error"); return false; }
      },
    });
    void res;
  }

  async function handleCreateFolder(baseDir = baseDirForSelected()) {
    const hint = baseDir ? `${baseDir}/` : "";
    const res = await showModal({
      title: "New Folder",
      message: baseDir ? `Inside \`${baseDir}\`` : "At project root",
      placeholder: `${hint}components`,
      defaultValue: hint,
      confirmText: "Create",
      validate: (v) => {
        const full = normalizePathExport(baseDir ? `${baseDir}/${v}` : v);
        if (!v.trim()) return "Enter a folder name";
        if (!full) return "Invalid path";
        const keep = `${full}/.gitkeep`;
        if (project.has(keep)) return "Folder already exists (or contains files)";
        // check if any file already has this prefix
        const hasChild = project.listPaths().some(p => p === full || p.startsWith(full + "/"));
        if (hasChild) return "Folder already exists";
        // validate as path
        try { normalizePathExport(full); } catch { return "Invalid path"; }
        if (!isValidPath(full + "/dummy")) return "Invalid folder name";
        return "";
      },
      onConfirm: (v) => {
        const full = normalizePathExport(baseDir ? `${baseDir}/${v}` : v);
        const keep = `${full}/.gitkeep`;
        try {
          project.set(keep, "");
          expanded.add(full);
          if (baseDir) expanded.add(baseDir);
          selectedPath = full;
          onFilesChanged?.({ type: "create", path: keep });
          render();
          showToast(`Folder ${full} created`, "success");
        } catch (e) { showToast(String(e?.message ?? e), "error"); return false; }
      },
    });
    void res;
  }

  function openContextMenu(node, x, y) {
    const isDir = node.type === "dir";
    const items = [];
    // Agentic actions (top, like Opencode/Codex)
    if (!isDir) {
      items.push(
        { label: "Explain this file", icon: "💡", action: () => onAskAgent?.(node.path, "explain") },
        { label: "Fix this file", icon: "🛠", action: () => onAskAgent?.(node.path, "fix") },
        { label: "Add to Agent (@)", icon: "＋", action: () => onAttachFile?.(node.path) },
        { sep: true },
      );
    } else {
      items.push(
        { label: "Ask Agent about folder", icon: "💬", action: () => onAskAgent?.(node.path, "explain_folder") },
        { label: "Add folder to Agent", icon: "＋", action: () => onAttachFile?.(node.path) },
        { sep: true },
      );
    }
    if (isDir) {
      items.push(
        { label: "New File Here", icon: "📄", action: () => handleCreateFile(node.path) },
        { label: "New Folder Here", icon: "📁", action: () => handleCreateFolder(node.path) },
        { sep: true },
      );
    }
    items.push(
      { label: "Rename", icon: "✎", action: () => handleRename(node) },
      { label: "Move", icon: "↗", action: () => handleMove(node) },
    );
    if (!isDir) items.push({ label: "Duplicate", icon: "⧉", action: () => handleDuplicate(node) });
    items.push({ sep: true });
    items.push({ label: isDir ? "Delete Folder" : "Delete File", icon: "🗑", danger: true, action: () => handleDelete(node) });
    // add hint with path
    const hint = node.path.length > 32 ? node.path.slice(0, 30) + "…" : node.path;
    showContextMenu(x, y, [{ hint }, { sep: true }, ...items]);
  }

  async function handleRename(node) {
    const res = await showModal({
      title: node.type === "dir" ? "Rename Folder" : "Rename File",
      message: `Renaming \`${node.path}\``,
      placeholder: node.path,
      defaultValue: node.path,
      confirmText: "Rename",
      validate: (v) => {
        const dest = normalizePathExport(v);
        if (!dest) return "Enter a path";
        if (dest === node.path) return "";
        if (!isValidPath(dest)) return "Invalid path";
        if (project.has(dest)) return "Destination already exists";
        // for files, check extension change warning? allow
        return "";
      },
      onConfirm: (v) => {
        const dest = normalizePathExport(v);
        if (dest === node.path) return;
        try {
          if (node.type === "file") project.rename(node.path, dest);
          else project.moveFolder(node.path, dest);
          selectedPath = dest;
          onFilesChanged?.({ type: "rename", from: node.path, to: dest });
          render();
          if (node.type === "file") onOpenFile?.(dest);
          showToast(`Renamed to ${dest}`, "success");
        } catch (e) { showToast(String(e?.message ?? e), "error"); return false; }
      },
    });
    void res;
  }

  async function handleMove(node) {
    const curDir = dirname(node.path);
    const res = await showModal({
      title: "Move",
      message: `Move \`${node.path}\` to folder (empty = root)`,
      placeholder: curDir || "(root)",
      defaultValue: curDir,
      confirmText: "Move",
      validate: (v) => {
        const destDir = v.trim();
        const base = basename(node.path);
        const dest = destDir ? normalizePathExport(`${destDir}/${base}`) : base;
        if (dest === node.path) return "Already there";
        if (!isValidPath(dest)) return "Invalid destination";
        if (project.has(dest)) return "Destination already exists";
        if (node.type === "dir" && (dest === node.path || dest.startsWith(node.path + "/"))) return "Cannot move folder into itself";
        return "";
      },
      onConfirm: (v) => {
        const destDir = v.trim();
        const base = basename(node.path);
        const dest = destDir ? normalizePathExport(`${destDir}/${base}`) : base;
        try {
          if (node.type === "file") project.rename(node.path, dest);
          else project.moveFolder(node.path, dest);
          selectedPath = dest;
          onFilesChanged?.({ type: "move", from: node.path, to: dest });
          render();
          showToast(`Moved to ${dest}`, "success");
        } catch (e) { showToast(String(e?.message ?? e), "error"); return false; }
      },
    });
    void res;
  }

  async function handleDelete(node) {
    const isDir = node.type === "dir";
    const count = isDir ? project.listPaths().filter(p => p === node.path || p.startsWith(node.path + "/")).length : 1;
    const res = await showConfirmModal({
      title: isDir ? "Delete Folder" : "Delete File",
      message: isDir
        ? `Delete folder \`${node.path}\` and its ${count} file${count===1?"":"s"}? This cannot be undone.`
        : `Delete file \`${node.path}\`? This cannot be undone.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!res) return;
    try {
      if (!isDir) project.delete(node.path);
      else project.deleteFolder(node.path);
      if (selectedPath === node.path || selectedPath?.startsWith(node.path + "/")) selectedPath = null;
      await onFilesChanged?.({ type: "delete", path: node.path });
      render();
      showToast(isDir ? `Deleted folder ${node.path}` : `Deleted ${node.path}`, "success");
    } catch (e) { showToast(String(e?.message ?? e), "error"); }
  }

  async function handleDuplicate(node) {
    if (node.type !== "file") return;
    const dir = dirname(node.path);
    const base = basename(node.path);
    const extIdx = base.lastIndexOf(".");
    const stem = extIdx > 0 ? base.slice(0, extIdx) : base;
    const ext = extIdx > 0 ? base.slice(extIdx) : "";
    let candidate = dir ? `${dir}/${stem}-copy${ext}` : `${stem}-copy${ext}`;
    let n = 2;
    while (project.has(candidate)) candidate = dir ? `${dir}/${stem}-copy${n++}${ext}` : `${stem}-copy${n++}${ext}`;
    // allow user to pick name via modal instead of auto
    const res = await showModal({
      title: "Duplicate File",
      message: `Duplicate \`${node.path}\` as`,
      placeholder: candidate,
      defaultValue: candidate,
      confirmText: "Duplicate",
      validate: (v) => {
        const dest = normalizePathExport(v);
        if (!dest) return "Enter a path";
        if (!isValidPath(dest)) return "Invalid path";
        if (project.has(dest)) return "Already exists";
        return "";
      },
      onConfirm: (v) => {
        const dest = normalizePathExport(v);
        try {
          const content = project.getContent(node.path) ?? "";
          project.set(dest, content);
          selectedPath = dest;
          expanded.add(dirname(dest));
          onFilesChanged?.({ type: "create", path: dest });
          render();
          onOpenFile?.(dest);
          showToast(`Duplicated to ${dest}`, "success");
        } catch (e) { showToast(String(e?.message ?? e), "error"); return false; }
      },
    });
    void res;
  }

  function promptUploadZip() {
    const input = container._zipInput;
    if (input) input.click();
    else {
      const tmp = h("input");
      tmp.type = "file";
      tmp.accept = ".zip,application/zip";
      tmp.hidden = true;
      tmp.addEventListener("change", async () => {
        const f = tmp.files?.[0];
        if (f) await doUploadZip(f);
        tmp.remove();
      });
      document.body.appendChild(tmp);
      tmp.click();
    }
  }

  async function doUploadZip(file) {
    // show progress toast
    showToast(`Unzipping ${file.name}…`, "info");
    try {
      const files = await unzipToFiles(file);
      const count = Object.keys(files).length;
      if (count === 0) { showToast("Zip contained no importable text files.", "error"); return; }
      const existing = project.listPaths();
      const overlap = Object.keys(files).filter(k => existing.includes(k));
      if (overlap.length > 0) {
        const ok = await showConfirmModal({
          title: "Overwrite Files?",
          message: `${count} files in zip, ${overlap.length} will overwrite existing files:\n${overlap.slice(0,6).join(", ")}${overlap.length>6?"…":""}\n\nProceed?`,
          confirmText: "Import",
          danger: false,
        });
        if (!ok) { showToast("Import cancelled", "info"); return; }
      }
      for (const [p, content] of Object.entries(files)) {
        try { project.set(p, content); expanded.add(dirname(p)); } catch {}
      }
      const topDirs = new Set(Object.keys(files).map(p => p.split("/")[0]).filter(Boolean));
      for (const d of topDirs) expanded.add(d);
      await onFilesChanged?.({ type: "zip-import", count });
      render();
      showToast(`Imported ${count} files from zip.`, "success");
    } catch (e) { showToast("Failed to unzip: " + String(e?.message ?? e), "error"); }
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
      showToast("Downloaded project.zip", "success");
    } catch (e) { showToast("Download failed: " + String(e?.message ?? e), "error"); }
    finally { btn.textContent = orig; btn.disabled = false; }
  }

  async function confirmReset() {
    const ok = await showConfirmModal({
      title: "Reset Project",
      message: "Reset project? This will delete all files and restore the default template (README, main.py, index.html, style.css, script.js). This cannot be undone.",
      confirmText: "Reset",
      danger: true,
    });
    if (!ok) return;
    onReset?.();
  }

  // external drag-drop on whole explorer pane for zip
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
  // also allow right-click on container background to create file/folder at root
  container.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".ws-explorer-row")) return; // handled per row
    // if clicking on toolbar or info, ignore? but allow empty area
    if (!e.target.closest(".ws-explorer-tree")) return;
    e.preventDefault();
  });

  return {
    render,
    setSelected(path) { selectedPath = path ? normalizePathExport(path) : null; highlightSelection(); },
    setExpanded(path, on) { if (on) expanded.add(path); else expanded.delete(path); },
    refresh() { render(); },
    getSelected() { return selectedPath; },
  };
}
