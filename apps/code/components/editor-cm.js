// CodeMirror 6 editor wrapper for the workstation.
// Lazy-loads Codemirror from esm.sh so the page stays light until Code is visited.
// Provides: createEditor(parent, { value, path, onChange, onSelection }) -> controller

let cmPromise = null;

async function loadCM() {
  if (cmPromise) return cmPromise;
  cmPromise = (async () => {
    try {
      const [
        { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine },
        { EditorState, Compartment },
        { defaultKeymap, history, historyKeymap },
        { indentOnInput, syntaxHighlighting, bracketMatching, foldGutter, foldKeymap },
        { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap },
        { python },
        { javascript },
        { html },
        { css },
        { oneDark }
      ] = await Promise.all([
        import("https://esm.sh/@codemirror/view@6.43.9"),
        import("https://esm.sh/@codemirror/state@6.7.1"),
        import("https://esm.sh/@codemirror/commands@6.11.0"),
        import("https://esm.sh/@codemirror/language@6.12.4"),
        import("https://esm.sh/@codemirror/autocomplete@6.20.3"),
        import("https://esm.sh/@codemirror/lang-python@6.2.1"),
        import("https://esm.sh/@codemirror/lang-javascript@6.2.5"),
        import("https://esm.sh/@codemirror/lang-html@6.4.12"),
        import("https://esm.sh/@codemirror/lang-css@6.3.1"),
        import("https://esm.sh/@codemirror/theme-one-dark@6.1.3"),
      ]);
      return { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine, EditorState, Compartment, defaultKeymap, history, historyKeymap, indentOnInput, syntaxHighlighting, bracketMatching, foldGutter, foldKeymap, autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, python, javascript, html, css, oneDark };
    } catch (e) {
      console.error("[editor-cm] failed to load CodeMirror from esm.sh", e);
      throw e;
    }
  })();
  return cmPromise;
}

function langForPath(path, mods) {
  const lower = String(path || "").toLowerCase();
  if (lower.endsWith(".py") || lower.endsWith(".pyw")) return mods.python();
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs") || lower.endsWith(".ts") || lower.endsWith(".jsx") || lower.endsWith(".tsx")) return mods.javascript();
  if (lower.endsWith(".json")) return mods.javascript();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return mods.html();
  if (lower.endsWith(".css")) return mods.css();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return mods.html(); // fallback
  if (lower.endsWith(".xml") || lower.endsWith(".svg")) return mods.html();
  // default python-ish for unknown text?
  return [];
}

function themeExtension(EditorView) {
  return EditorView.theme({
    "&": { backgroundColor: "rgba(255,255,255,0.015)", color: "var(--t1)", fontSize: "13px" },
    ".cm-content": { fontFamily: "var(--mono)", caretColor: "var(--ok)", padding: "10px 0" },
    ".cm-editor": { backgroundColor: "transparent" },
    ".cm-scroller": { fontFamily: "var(--mono)" },
    ".cm-gutters": { backgroundColor: "rgba(255,255,255,0.02)", color: "var(--t4)", borderRight: "1px solid var(--line-soft)", fontFamily: "var(--mono)", fontSize: "11.5px" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(100,255,160,0.06)" },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.03)" },
    ".cm-selectionBackground, ::selection": { backgroundColor: "rgba(100,255,160,0.18)" },
    ".cm-focused .cm-cursor": { borderLeftColor: "var(--ok)" },
    ".cm-tooltip": { backgroundColor: "#0a0b0e", border: "1px solid var(--line)", color: "var(--t1)" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--panel-hover)", color: "var(--t1)" },
  }, { dark: true });
}

export async function createEditor(container, { value = "", path = "untitled.txt", onChange, onSelection } = {}) {
  const m = await loadCM();
  const languageComp = new m.Compartment();
  const tabSizeComp = new m.Compartment();

  const updateListener = m.EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      const text = update.state.doc.toString();
      onChange?.(text);
    }
    if (update.selectionSet || update.docChanged) {
      const sel = update.state.selection.main;
      if (!sel.empty) {
        const text = update.state.sliceDoc(sel.from, sel.to);
        onSelection?.({ text, from: sel.from, to: sel.to, empty: false });
      } else {
        onSelection?.({ text: "", from: sel.from, to: sel.to, empty: true });
      }
    }
  });

  const state = m.EditorState.create({
    doc: String(value ?? ""),
    extensions: [
      m.lineNumbers(),
      m.highlightActiveLineGutter(),
      m.highlightSpecialChars(),
      m.history(),
      m.drawSelection(),
      m.dropCursor(),
      m.EditorState.allowMultipleSelections.of(true),
      m.indentOnInput(),
      m.bracketMatching(),
      m.closeBrackets(),
      m.autocompletion(),
      m.rectangularSelection(),
      m.crosshairCursor(),
      m.highlightActiveLine(),
      m.foldGutter(),
      m.oneDark,
      tabSizeComp.of(m.EditorState.tabSize.of(2)),
      languageComp.of(langForPath(path, m)),
      m.keymap.of([...m.closeBracketsKeymap, ...m.defaultKeymap, ...m.historyKeymap, ...m.foldKeymap, ...m.completionKeymap]),
      themeExtension(m.EditorView),
      updateListener,
      m.EditorView.lineWrapping,
    ],
  });

  const view = new m.EditorView({ state, parent: container });

  const ctrl = {
    view,
    getValue() { return view.state.doc.toString(); },
    setValue(text, newPath) {
      const t = String(text ?? "");
      // Replace doc without triggering excessive history? Use transaction
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } });
      if (newPath && newPath !== path) this.setLanguage(newPath);
    },
    setLanguage(newPath) {
      path = String(newPath || path);
      view.dispatch({ effects: languageComp.reconfigure(langForPath(path, m)) });
    },
    focus() { view.focus(); },
    getSelection() {
      const sel = view.state.selection.main;
      return { text: sel.empty ? "" : view.state.sliceDoc(sel.from, sel.to), from: sel.from, to: sel.to, empty: sel.empty };
    },
    setSelection(from, to) {
      view.dispatch({ selection: { anchor: from, head: to } });
      view.focus();
    },
    insertAtCursor(snippet) {
      const sel = view.state.selection.main;
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: String(snippet ?? "") }, selection: { anchor: sel.from + String(snippet ?? "").length } });
      view.focus();
    },
    replaceRange(from, to, text) {
      view.dispatch({ changes: { from, to, insert: String(text ?? "") }, selection: { anchor: from + String(text ?? "").length } });
      view.focus();
    },
    destroy() { view.destroy(); },
  };

  // Initial selection callback
  ctrl.getSelection();
  return ctrl;
}
