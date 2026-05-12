import { useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import * as monaco from "monaco-editor";
import * as settings from "../lib/settings";
import { ws } from "../lib/ws-client";
import { documentApi, fsApi } from "../lib/rpc";

interface EditorPaneProps {
  path: string;
  language: string;
  /** When true, forces a Monaco layout() call to repaint the canvas after being hidden. */
  isActive?: boolean;
  readOnly?: boolean;
  height?: number;
  wordWrap?: boolean;
  onCursorChange?: (line: number, col: number) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Expose methods to parent via ref */
export interface EditorPaneHandle {
  /** Get current content directly from the Monaco model — always fresh, no React state lag */
  getContent: () => string;
  /** Get current model's saved state (version, dirty, etc.) */
  getModelInfo: () => { versionId: number };
}

// Monaco theme colors (Monaco API only — not React styles)
const MONACO_THEME_COLORS = {
  bg: "#222244",
  text: "#d4c4ff",
  lineHighlight: "#2d2350",
  selection: "#4ade8033",
};

/** Registry of Monaco models — one per file path. Lives outside React to survive remounts. */
const modelRegistry = new Map<string, monaco.editor.ITextModel>();

/** Track which documents have been registered with the backend (for save) */
const openedDocuments = new Set<string>();

const EditorPane = forwardRef<EditorPaneHandle, EditorPaneProps>(
  function EditorPane(
    {
      path,
      language,
      isActive,
      readOnly,
      height,
      wordWrap,
      onCursorChange,
      onDirtyChange,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const onSaveCallbacks = useRef<(() => void)[]>([]);
    const pathRef = useRef(path);
    const wordWrapRef = useRef(wordWrap);
    const onCursorChangeRef = useRef(onCursorChange);
    const onDirtyChangeRef = useRef(onDirtyChange);
    const suppressDirtyRef = useRef(false);

    useEffect(() => {
      pathRef.current = path;
    }, [path]);
    useEffect(() => {
      wordWrapRef.current = wordWrap;
      editorRef.current?.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
    }, [wordWrap]);

    // ── Visibility Repaint Hook (triggers layout() when tile becomes active) ─
    useEffect(() => {
      if (isActive && editorRef.current) {
        const id = setTimeout(() => {
          editorRef.current?.layout();
        }, 50);
        return () => clearTimeout(id);
      }
    }, [isActive]);
    useEffect(() => {
      onCursorChangeRef.current = onCursorChange;
    }, [onCursorChange]);
    useEffect(() => {
      onDirtyChangeRef.current = onDirtyChange;
    }, [onDirtyChange]);

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
      getContent: () => {
        const model = editorRef.current?.getModel();
        return model ? model.getValue() : "";
      },
      getModelInfo: () => ({
        versionId: editorRef.current?.getModel()?.getVersionId() ?? 0,
      }),
    }));

    // Theme + editor init (once)
    useEffect(() => {
      if (!containerRef.current) return;

      monaco.editor.defineTheme("crow-ui-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [],
        colors: {
          "editor.background": MONACO_THEME_COLORS.bg,
          "editor.foreground": MONACO_THEME_COLORS.text,
          "editor.lineHighlightBackground": MONACO_THEME_COLORS.lineHighlight,
          "editor.selectionBackground": MONACO_THEME_COLORS.selection,
          "editorCursor.foreground": "#4ade80",
          "editorLineNumber.foreground": "#5a4d80",
          "editorLineNumber.activeForeground": "#d4c4ff",
          "editorIndentGuide.background": "#2d2350",
          "editorIndentGuide.activeBackground": "#3a2d60",
          "editorBracketMatch.background": "#4ade8022",
          "editorBracketMatch.border": "#4ade80",
          "editorWidget.background": "#1a1230",
          "editorWidget.border": "#2d2350",
          "input.background": "#2d2350",
          "input.border": "#3a2d60",
          "input.foreground": "#d4c4ff",
          "list.hoverBackground": "#2d2350",
          "list.focusBackground": "#3a2d60",
          "scrollbarSlider.background": "#5a4d8044",
          "scrollbarSlider.hoverBackground": "#5a4d8088",
        },
      });

      const editor = monaco.editor.create(containerRef.current, {
        value: "",
        language,
        theme: "crow-ui-dark",
        automaticLayout: true,
        readOnly: readOnly || false,
        wordWrap: wordWrap ? "on" : "off",
        minimap: { enabled: !readOnly },
        fontSize: readOnly ? 12 : 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        lineNumbers: readOnly ? "off" : "on",
        renderWhitespace: "selection",
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true, indentation: true },
        scrollBeyondLastLine: !readOnly,
        smoothScrolling: false,
        cursorBlinking: readOnly ? "solid" : "smooth",
        cursorSmoothCaretAnimation: "off",
        cursorStyle: readOnly ? "line-thin" : "line",
        cursorWidth: 2,
        links: !readOnly,
        folding: !readOnly,
        foldingStrategy: "indentation",
        stickyScroll: { enabled: false },
        padding: { top: 8, bottom: 8 },
        suggest: {
          showStatusBar: !readOnly,
        },
        quickSuggestions: settings.getIntellisenseOptions(language)
          .noQuickSuggestions
          ? false
          : settings.getIntellisenseOptions(language).enabled
            ? { other: true, comments: false, strings: false }
            : false,
        wordBasedSuggestions: settings.getIntellisenseOptions(language)
          .noQuickSuggestions
          ? "off"
          : (settings.getIntellisenseOptions(language).wordBasedSuggestions as
              | "off"
              | "currentDocument"
              | "matchingDocuments"
              | "allDocuments"),
        // Disable all suggestion triggers for prose languages
        acceptSuggestionOnEnter: settings.getIntellisenseOptions(language)
          .noQuickSuggestions
          ? "off"
          : "on",
        acceptSuggestionOnCommitCharacter:
          !settings.getIntellisenseOptions(language).noQuickSuggestions,
        suggestOnTriggerCharacters:
          settings.getIntellisenseOptions(language)
            .suggestOnTriggerCharacters &&
          !settings.getIntellisenseOptions(language).noQuickSuggestions,
        tabCompletion: settings.getIntellisenseOptions(language)
          .noQuickSuggestions
          ? "off"
          : "on",
        parameterHints: {
          enabled:
            settings.getIntellisenseOptions(language).parameterHintsEnabled,
        },
      });

      editorRef.current = editor;

      // Apply word wrap after a microtask delay (Monaco needs time to initialize internal state)
      Promise.resolve().then(() => {
        editor.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
      });

      // Cursor tracking
      editor.onDidChangeCursorPosition((e) => {
        onCursorChangeRef.current?.(e.position.lineNumber, e.position.column);
      });

      // Register Ctrl+S via Monaco command
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        for (const cb of onSaveCallbacks.current) cb();
      });

      // Also register via direct keydown listener (catches when Monaco doesn't)
      const container = containerRef.current;
      const handleEditorKeydown = (e: KeyboardEvent) => {
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && e.key === "s") {
          e.preventDefault();
          e.stopPropagation();
          for (const cb of onSaveCallbacks.current) cb();
        }
        if (ctrl && e.key === "w") {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent("editor-close-tab", {
              detail: { path: pathRef.current },
            }),
          );
        }
      };
      container?.addEventListener("keydown", handleEditorKeydown, true);

      return () => {
        container?.removeEventListener("keydown", handleEditorKeydown, true);
        editor.dispose();
        // DO NOT dispose models here — they live in the registry for multi-tab/multi-session use.
        // Models are explicitly disposed via disposeModel() when a tab is closed.
      };
    }, []);

    // Fetch editor.fontSize from backend settings and apply it
    useEffect(() => {
      const editor = editorRef.current;
      if (!editor || readOnly) return;

      settings.getSetting<number>("editor.fontSize", 14).then((size) => {
        if (size !== undefined) {
          editor.updateOptions({ fontSize: size });
        }
      });
    }, []);

    // Register onSave callback
    useEffect(() => {
      const cb = () => {
        // Trigger a custom event that App.tsx listens for
        window.dispatchEvent(
          new CustomEvent("editor-save", { detail: { path: pathRef.current } }),
        );
      };
      onSaveCallbacks.current = [cb];
      return () => {
        onSaveCallbacks.current = [];
      };
    }, []);

    // Switch model when path changes
    useEffect(() => {
      const editor = editorRef.current;
      if (!editor) return;

      // Get or create model for this path
      let model = modelRegistry.get(path);
      let needsContentLoad = false;
      if (!model) {
        // Model doesn't exist yet — it will be populated by the parent
        // via setModelContent after this effect runs. Create a placeholder.
        model = monaco.editor.createModel("", language, monaco.Uri.file(path));
        modelRegistry.set(path, model);
        needsContentLoad = true;
      } else if (model.getValueLength() === 0) {
        // Model exists but is empty (restored from session, content never loaded)
        needsContentLoad = true;
      } else {
        // Model exists with content — just update its language if needed
        monaco.editor.setModelLanguage(model, language);
      }

      editor.setModel(model);
      editor.focus();

      // Lazy-load content from backend if this path has no content yet
      // This fixes blank editors when tiles are restored from session state
      if (needsContentLoad) {
        fsApi
          .readFile({ path })
          .then((result) => {
            if (model.getValueLength() === 0 && result.content) {
              suppressDirtyRef.current = true;
              model.setValue(result.content);
              monaco.editor.setModelLanguage(model, language);
              suppressDirtyRef.current = false;
              // Re-layout after content is loaded so Monaco sizes properly
              requestAnimationFrame(() => editor.layout());
            }
          })
          .catch(() => {
            // File may not exist on disk yet — leave as empty
          });
      }

      // Register document with backend for save support (only once per path)
      if (!openedDocuments.has(path)) {
        openedDocuments.add(path);
        const content = model.getValue();
        documentApi.open({ path, content }).catch((e) => {
          console.warn("[EditorPane] document_open failed:", e);
        });
      }

      console.log(
        "[EditorPane] setModel for",
        path,
        "content length:",
        model.getValueLength(),
      );

      // Force layout after setting model
      requestAnimationFrame(() => {
        editor.layout();
      });
      // Extra safety: layout again after a short delay for restored tiles
      setTimeout(() => editor.layout(), 100);

      // Listen for content changes to track dirty state
      const disposable = model.onDidChangeContent(() => {
        if (!suppressDirtyRef.current && !suppressDirtyPaths.has(path)) {
          onDirtyChangeRef.current?.(true);
        }
      });

      return () => disposable.dispose();
    }, [path, language]);

    return (
      <div
        ref={containerRef}
        data-testid="monaco-editor"
        className="absolute inset-0"
        style={height ? { height } : undefined}
      />
    );
  },
);

export default EditorPane;

/** Utility: get content from model registry by path */
export function getModelContent(path: string): string | null {
  const model = modelRegistry.get(path);
  return model ? model.getValue() : null;
}

/** Utility: set content for a path's model (called by App.tsx after loading a file) */
export function setModelContent(
  path: string,
  content: string,
  language: string,
): void {
  // Register document with backend for save support (only once per path)
  if (!openedDocuments.has(path)) {
    openedDocuments.add(path);
    documentApi.open({ path, content }).catch((e) => {
      console.warn("[setModelContent] document_open failed:", e);
    });
  }

  let model = modelRegistry.get(path);
  if (!model) {
    // Model hasn't been created by the EditorPane effect yet — create it now
    model = monaco.editor.createModel(content, language, monaco.Uri.file(path));
    modelRegistry.set(path, model);
  } else {
    monaco.editor.setModelLanguage(model, language);
    // Only update if content actually changed to avoid cursor reset and
    // spurious dirty-state changes from worktree events after save.
    if (model.getValue() !== content) {
      suppressDirtyForPath(path);
      // Preserve cursor position so worktree updates don't jump the cursor
      const editors = monaco.editor.getEditors();
      const editor = editors.find((e) => e.getModel() === model);
      const savedPos = editor?.getPosition();
      model.setValue(content);
      if (editor && savedPos) {
        editor.setPosition(savedPos);
      }
    }
  }
}

/** Track which paths should suppress dirty changes on next content update */
const suppressDirtyPaths = new Set<string>();

function suppressDirtyForPath(path: string): void {
  suppressDirtyPaths.add(path);
  setTimeout(() => suppressDirtyPaths.delete(path), 100);
}

/** Utility: mark a model as clean (saved) */
export function markModelClean(_path: string): void {
  // Monaco doesn't have a built-in "clean/dirty" flag.
  // Dirty state is tracked in React state in App.tsx.
  // This is a no-op placeholder for API compatibility.
}

/** Utility: dispose a model when closing a tab */
export function disposeModel(path: string): void {
  const model = modelRegistry.get(path);
  if (model) {
    model.dispose();
    modelRegistry.delete(path);
  }
}
