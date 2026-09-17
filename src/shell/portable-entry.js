// src/shell/portable-entry.js — runtime wiring for the single-file portable build.
//
// Called once at the very start of the bundled bootstrap. In a served build it is a
// no-op. In the portable build it:
//
//   1. Installs the store-backed `fetch`, so the model loaders, Pyodide, micropip,
//      pdf.js and mammoth all read from the picked folder instead of the network.
//   2. Shows an asset gate that asks the user where their assets folder is. This is
//      the whole trick: a `file://` page cannot read its own sibling files, but a
//      *user-picked* file is readable at any byte offset, which is what replaces
//      HTTP Range requests.
//
// We deliberately do not copy the weights into IndexedDB — the engine already caches
// the tensors it decodes, and duplicating 2.4 GB of blobs would be both slow and
// likely to exceed the storage quota on a `file://` origin.

import { assetStore } from "../lib/asset-store.js";
import { installLocalFetch } from "../lib/asset-fetch.js";
import { isPortable, setWeightsSource, weightsSource, WEIGHTS_HF } from "../lib/portable.js";

const OVERLAY_ID = "portable-gate";

const STYLE = `
#${OVERLAY_ID} {
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; align-items: center; justify-content: center;
  background: #020203; color: rgba(255,255,255,.92);
  font: 400 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  padding: 24px; overflow: auto;
}
#${OVERLAY_ID}.dragging { outline: 2px dashed rgba(100,255,160,.6); outline-offset: -12px; }
#${OVERLAY_ID} .pg-card {
  width: min(620px, 100%); background: rgba(255,255,255,.03);
  border: 1px solid rgba(255,255,255,.09); border-radius: 14px; padding: 28px 30px;
}
#${OVERLAY_ID} h1 { font-size: 19px; font-weight: 500; margin: 0 0 6px; }
#${OVERLAY_ID} p { color: rgba(255,255,255,.55); margin: 0 0 18px; font-size: 14px; }
#${OVERLAY_ID} code { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; color: rgba(255,255,255,.75); }
#${OVERLAY_ID} .pg-row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
#${OVERLAY_ID} button {
  font: inherit; font-size: 14px; padding: 9px 16px; border-radius: 9px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.14); background: #fff; color: #000; font-weight: 500;
}
#${OVERLAY_ID} button.pg-ghost { background: transparent; color: rgba(255,255,255,.85); font-weight: 400; }
#${OVERLAY_ID} button:disabled { opacity: .4; cursor: not-allowed; }
#${OVERLAY_ID} .pg-status { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: rgba(255,255,255,.45); min-height: 1.4em; }
#${OVERLAY_ID} .pg-status.ok { color: #64ffa0; }
#${OVERLAY_ID} .pg-status.bad { color: #ff7a6b; }
#${OVERLAY_ID} ul.pg-found { margin: 14px 0 0; padding: 0; list-style: none; font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: rgba(255,255,255,.4); max-height: 130px; overflow: auto; }
#${OVERLAY_ID} .pg-hint { margin-top: 16px; font-size: 12.5px; color: rgba(255,255,255,.38); }
#${OVERLAY_ID} .pg-hint b { color: rgba(255,255,255,.6); font-weight: 500; }
#${OVERLAY_ID} .pg-sep { margin: 18px 0 14px; border-top: 1px solid rgba(255,255,255,.08); }
`;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "style") node.setAttribute("style", value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** A hidden file input; resolves with its FileList once the user chooses. */
function pickFiles({ directory = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    if (directory) input.setAttribute("webkitdirectory", "");
    else input.setAttribute("accept", ".safetensors");
    input.addEventListener("change", () => {
      const files = input.files;
      input.remove();
      resolve(files);
    });
    // If the user cancels, `change` never fires; leaving the element around is
    // harmless and the gate stays usable.
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Try the File System Access directory picker first (nicer: keeps the folder for
 * the session), then fall back to `<input webkitdirectory>`.
 *
 * `showDirectoryPicker` is refused on an opaque `file://` origin in some browsers,
 * hence the fallback — which works everywhere.
 */
async function pickDirectory() {
  if (typeof window.showDirectoryPicker === "function") {
    try {
      const handle = await window.showDirectoryPicker({ id: "gemma4-assets", mode: "read" });
      const files = [];
      const walk = async (dir, prefix) => {
        for await (const [name, entry] of dir.entries()) {
          if (entry.kind === "file") {
            const file = await entry.getFile();
            files.push({ file, path: `${prefix}${name}` });
          } else if (entry.kind === "directory") {
            await walk(entry, `${prefix}${name}/`);
          }
        }
      };
      await walk(handle, "");
      return files;
    } catch (err) {
      if (err?.name === "AbortError") return null;
      console.warn("[portable] showDirectoryPicker unavailable, falling back:", err?.name ?? err);
    }
  }
  const list = await pickFiles({ directory: true });
  if (!list || !list.length) return null;
  // Drop the picked folder's own name: consumers ask for paths relative to it.
  return Array.from(list).map((file) => {
    const parts = String(file.webkitRelativePath || file.name).split("/").filter(Boolean);
    return { file, path: parts.slice(1).join("/") || file.name };
  });
}

function buildGate(onReady) {
  // The gate is shown before (and in place of) the app UI, so its stylesheet has to be
  // attached to the document — the overlay is created detached from the page.
  document.head.appendChild(el("style", { "data-portable": "gate" }, STYLE));
  const status = el("div", { class: "pg-status" }, "No assets loaded yet.");
  const found = el("ul", { class: "pg-found" });

  let settle = null;

  const refresh = () => {
    const model = assetStore.resolveModelFile();
    const chosenHf = weightsSource() === WEIGHTS_HF;
    const list = assetStore.paths().slice(0, 60).map((p) => el("li", {}, p));

    if (model) {
      status.textContent =
        `Ready — model.safetensors (${(model.size / 1073741824).toFixed(2)} GB) + ` +
        `${assetStore.size} files. Fully offline.`;
      status.className = "pg-status ok";
      folderBtn.disabled = true;
      modelBtn.disabled = true;
      hfBtn.disabled = true;
      found.replaceChildren(...list);
      settle?.();
      return;
    }

    if (chosenHf) {
      status.textContent = "Streaming from the Hugging Face Hub — about 2.4 GB on first load.";
      status.className = "pg-status";
      found.replaceChildren(...list);
      settle?.();
      return;
    }

    status.textContent = assetStore.size
      ? `${assetStore.size} files loaded, but no model.safetensors yet.`
      : "No assets loaded yet.";
    status.className = "pg-status";
    found.replaceChildren(...list);
  };

  const ingest = (entries) => {
    if (!entries?.length) return;
    assetStore.addMapped(entries);
    refresh();
  };

  const folderBtn = el("button", {
    onclick: async () => {
      status.textContent = "Waiting for folder selection…";
      status.className = "pg-status";
      const picked = await pickDirectory();
      if (!picked) { status.textContent = "No folder selected."; return; }
      ingest(picked);
    },
  }, "Select assets folder");

  const modelBtn = el("button", {
    class: "pg-ghost",
    onclick: async () => {
      const picked = await pickFiles();
      if (!picked?.length) return;
      assetStore.addMapped(Array.from(picked).map((file) => ({ file, path: file.name })));
      refresh();
    },
  }, "…or just model.safetensors");

  // The escape hatch that makes a small release possible: no 2.4 GB download needed to
  // get started, the app just streams the checkpoint the way a served build does.
  const hfBtn = el("button", {
    class: "pg-ghost",
    onclick: () => {
      setWeightsSource(WEIGHTS_HF);
      refresh();
    },
  }, "Stream from Hugging Face");

  const overlay = el("div", { id: OVERLAY_ID }, [
    el("div", { class: "pg-card" }, [
      el("h1", {}, "Portable build — choose where the model comes from"),
      el("p", {}, [
        "This single-file build can read the model and Python runtime from a folder on disk, or " +
        "stream the model from the Hugging Face Hub. Nothing you type ever leaves your machine.",
      ]),
      el("div", { class: "pg-row" }, [folderBtn, modelBtn]),
      status,
      found,
      el("div", { class: "pg-hint" }, [
        el("b", {}, "Offline: select the "),
        el("code", {}, "assets"),
        el("b", {}, " folder next to this HTML file (or drag it onto this window). It should contain "),
        el("code", {}, "model.safetensors"),
        el("b", {}, " and "),
        el("code", {}, "vendor/pyodide/"),
        el("b", {}, "."),
      ]),
      el("div", { class: "pg-sep" }),
      el("div", { class: "pg-hint" }, [
        el("b", {}, "Online: "),
        "if you only downloaded this HTML file, you can",
      ]),
      el("div", { class: "pg-row", style: "margin-top:10px" }, [hfBtn]),
      el("div", { class: "pg-hint" }, [
        "…and the model (~2.4 GB) streams from the Hub on first load, then caches in this " +
        "browser. Point it at an ",
        el("code", {}, "assets"),
        " folder later for fully offline use.",
      ]),
    ]),
  ]);

  // Drag & drop is often quicker than a folder picker.
  const onDragOver = (event) => {
    event.preventDefault();
    overlay.classList.add("dragging");
  };
  const onDragLeave = () => overlay.classList.remove("dragging");
  const onDrop = async (event) => {
    event.preventDefault();
    overlay.classList.remove("dragging");
    status.textContent = "Reading dropped items…";
    await assetStore.addFromDataTransfer(event.dataTransfer);
    refresh();
  };
  overlay.addEventListener("dragover", onDragOver);
  overlay.addEventListener("dragleave", onDragLeave);
  overlay.addEventListener("drop", onDrop);

  assetStore.onChange(refresh);

  return {
    overlay,
    refresh,
    ready: new Promise((resolve) => {
      settle = resolve;
      // Already satisfied (e.g. a hot reload kept the store populated)?
      if (assetStore.resolveModelFile()) refresh();
    }),
  };
}

/**
 * Wire up portable mode. Resolves once the model file is known to be available.
 * In a served build this returns immediately.
 */
export async function initPortable() {
  if (!isPortable()) return { portable: false };

  // Install before anything can fetch, so Pyodide/micropip/loaders all see it.
  installLocalFetch(assetStore);

  const gate = buildGate();
  document.body.appendChild(gate.overlay);
  document.documentElement.dataset.portable = "1";

  await gate.ready;
  gate.overlay.remove();
  document.documentElement.dataset.portableReady = "1";
  return { portable: true, assets: assetStore.describe() };
}
