/**
 * Monaco-based file views for tool call accordions in the chat panel.
 *
 * - FileReadView: Read-only Monaco editor with syntax highlighting
 * - FileWriteView: New file view (all green content)
 * - FileEditView: Inline diff view (before vs after)
 */

import { useRef, useEffect, useState } from "react";
import * as monaco from "monaco-editor";

// ─── Shared ─────────────────────────────────────────────────────────────────

function getLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    rs: "rust", ts: "typescript", tsx: "typescriptreact",
    js: "javascript", jsx: "javascriptreact", py: "python",
    go: "go", java: "java", c: "c", cpp: "cpp", cs: "csharp",
    css: "css", html: "html", json: "json", md: "markdown",
    yml: "yaml", yaml: "yaml", toml: "toml", sh: "shell",
    sql: "sql", php: "php", swift: "swift", kt: "kotlin",
    lua: "lua", rb: "ruby", r: "r", dart: "dart",
  };
  return map[ext] || "plaintext";
}

// ─── FileReadView (read-only) ────────────────────────────────────────────────

interface FileReadViewProps {
  content: string;
  path: string;
  maxHeight?: number;
}

export function FileReadView({ content, path, maxHeight = 300 }: FileReadViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const language = getLanguage(path);
    const model = monaco.editor.createModel(content, language);

    const editor = monaco.editor.create(containerRef.current, {
      model,
      readOnly: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      scrollBeyondLastColumn: 0,
      scrollbar: { vertical: "auto", horizontal: "auto" },
      lineNumbers: "on",
      folding: true,
      wordWrap: "on",
      automaticLayout: true,
      fontSize: 11,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      padding: { top: 4, bottom: 4 },
      contextmenu: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      renderLineHighlight: "none",
      selectOnLineNumbers: false,
    });

    editorRef.current = editor;

    return () => {
      editor.dispose();
      model.dispose();
    };
  }, [content, path]);

  return (
    <div
      ref={containerRef}
      className="rounded overflow-hidden border border-[var(--color-border)]"
      style={{
        height: Math.min(content.split("\n").length * 18 + 16, maxHeight),
        minHeight: 60,
      }}
    />
  );
}

// ─── FileWriteView (new file, all green) ─────────────────────────────────────

interface FileWriteViewProps {
  content: string;
  path: string;
  maxHeight?: number;
}

export function FileWriteView({ content, path, maxHeight = 300 }: FileWriteViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const language = getLanguage(path);
    const model = monaco.editor.createModel(content, language);

    const editor = monaco.editor.create(containerRef.current, {
      model,
      readOnly: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      scrollBeyondLastColumn: 0,
      scrollbar: { vertical: "auto", horizontal: "auto" },
      lineNumbers: "off",
      folding: false,
      wordWrap: "on",
      automaticLayout: true,
      fontSize: 11,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      padding: { top: 4, bottom: 4 },
      contextmenu: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      renderLineHighlight: "none",
      selectOnLineNumbers: false,
    });

    // Add green background decorations for all lines
    const lineCount = model.getLineCount();
    model.deltaDecorations([], [
      {
        range: new monaco.Range(1, 1, lineCount, model.getLineMaxColumn(lineCount)),
        options: {
          isWholeLine: true,
          className: "write-view-line",
          linesDecorationsClassName: "write-view-glyph",
        },
      },
    ]);

    editorRef.current = editor;

    // Measure visible content height after render
    const timer = setTimeout(() => {
      const domNode = editor.getDomNode();
      if (!domNode) return;
      const lines = domNode.querySelectorAll('.view-lines .view-line');
      const lineHeight = 18;
      const padding = 20;
      const newHeight = Math.max(lines.length * lineHeight + padding, 60);
      setMeasuredHeight(Math.min(newHeight, maxHeight));
    }, 100);

    return () => {
      clearTimeout(timer);
      editor.dispose();
      model.dispose();
    };
  }, [content, path, maxHeight]);

  const defaultHeight = Math.min(content.split("\n").length * 18 + 16, maxHeight);

  return (
    <div
      ref={containerRef}
      className="rounded overflow-hidden border border-[var(--color-primary)]/25"
      style={{
        height: measuredHeight ?? defaultHeight,
        minHeight: 60,
      }}
    />
  );
}

// ─── FileEditView (inline diff: before vs after) ─────────────────────────────

interface FileEditViewProps {
  beforeContent: string;
  afterContent: string;
  path: string;
  maxHeight?: number;
}

export function FileEditView({ beforeContent, afterContent, path, maxHeight = 400 }: FileEditViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [showFullDiff, setShowFullDiff] = useState(false);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const language = getLanguage(path);
    const originalModel = monaco.editor.createModel(beforeContent, language);
    const modifiedModel = monaco.editor.createModel(afterContent, language);

    const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
      originalEditable: false,
      readOnly: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      scrollbar: { vertical: "auto", horizontal: "auto" },
      lineNumbers: "on",
      folding: true,
      wordWrap: "on",
      automaticLayout: true,
      fontSize: 11,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      padding: { top: 4, bottom: 4 },
      contextmenu: false,
      renderSideBySide: true,
      diffAlgorithm: "legacy",
      hideUnchangedRegions: {
        enabled: !showFullDiff,
        contextLineCount: 3,
        minimumLineCount: 5,
        revealLineCount: 5,
      },
    });

    diffEditor.setModel({
      original: originalModel,
      modified: modifiedModel,
    });

    diffEditorRef.current = diffEditor;

    // Measure visible content height after render
    const timer = setTimeout(() => {
      const modified = diffEditor.getModifiedEditor();
      const domNode = modified.getDomNode();
      if (!domNode) return;
      const lines = domNode.querySelectorAll('.view-lines .view-line');
      const lineHeight = 18;
      const padding = 20;
      const newHeight = Math.max(lines.length * lineHeight + padding, 80);
      setMeasuredHeight(Math.min(newHeight, maxHeight));
    }, 100);

    return () => {
      clearTimeout(timer);
      diffEditor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
  }, [beforeContent, afterContent, path, showFullDiff, maxHeight]);

  const defaultHeight = Math.min(
    Math.max(beforeContent.split("\n").length, afterContent.split("\n").length) * 18 + 16,
    maxHeight,
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-text-secondary font-mono">{path}</span>
        <button
          onClick={() => setShowFullDiff((v) => !v)}
          className="text-[10px] text-text-secondary hover:text-text-primary bg-transparent border border-border rounded px-1.5 py-0.5 cursor-pointer"
        >
          {showFullDiff ? "Collapse" : "Expand"}
        </button>
      </div>
      <div
        ref={containerRef}
        className="rounded overflow-hidden border border-[var(--color-border)]"
        style={{
          height: measuredHeight ?? defaultHeight,
          minHeight: 80,
        }}
      />
    </div>
  );
}

// ─── Inject CSS for write view decorations ───────────────────────────────────

if (typeof document !== "undefined" && !(window as any).__writeViewStyleInjected) {
  const style = document.createElement("style");
  style.textContent = `
    .write-view-line { background: #4ade8015 !important; }
    .write-view-glyph::before {
      content: "+";
      color: #4ade80;
      font-weight: bold;
      font-size: 11px;
      position: absolute;
      left: 2px;
    }
    .monaco-diff-editor .margin {
      background: var(--color-background-dark) !important;
    }
  `;
  document.head.appendChild(style);
  (window as any).__writeViewStyleInjected = true;
}
