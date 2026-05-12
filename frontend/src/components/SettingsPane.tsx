/** Settings UI Panel — JSONC editor + visual controls */
import { useEffect, useState, useCallback, useRef } from "react";
import * as monaco from "monaco-editor";
import * as settings from "../lib/settings";
import { ws } from "../lib/ws-client";
import { fsApi, settingsApi } from "../lib/rpc";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

// Monaco editor theme colors (must be JS objects for monaco.editor.defineTheme)
const MONACO_THEME_COLORS = {
  bg: "#14101f",
  bgSecondary: "#1a1230",
  text: "#d4c4ff",
  textMuted: "#8b7bb5",
  textDim: "#5a4d80",
  hover: "#2d2350",
  accent: "#4ade80",
  accentBg: "#4ade8022",
};

function getDefaultJson(): string {
  const s = settings.getSettings();
  const defaultJson = JSON.stringify(
    {
      editor: s.editor,
      languages: s.languages,
      intellisense: s.intellisense,
      terminal: s.terminal,
    },
    null,
    2,
  );
  return `// Murder IDE Settings\n// JSONC format — comments and trailing commas supported\n\n${defaultJson}\n`;
}

export default function SettingsPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load settings file content
  const loadSettingsFile = useCallback(async () => {
    setLoading(true);

    // Resolve config path ourselves (don't depend on module state)
    let path = settings.getConfigPath();
    if (!path) {
      try {
        const pathResult = await settingsApi.getConfigPath();
        path = pathResult.path;
      } catch {
        setLoading(false);
        setJsonText(getDefaultJson());
        setConfigPath("unknown");
        return;
      }
    }
    setConfigPath(path);

    try {
      const result = await fsApi.readFile({
        path,
      });
      if (result.content && result.content.trim()) {
        setJsonText(result.content);
      } else {
        // File doesn't exist or is empty — show defaults
        setJsonText(getDefaultJson());
      }
      setError(null);
    } catch {
      // File doesn't exist — show defaults
      setJsonText(getDefaultJson());
      setError(null);
    }
    setLoading(false);
  }, []);

  // Init Monaco for settings editor
  useEffect(() => {
    if (!containerRef.current || !jsonText) return;

    if (editorRef.current) {
      editorRef.current.dispose();
      editorRef.current = null;
    }

    monaco.editor.defineTheme("settings-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": MONACO_THEME_COLORS.bgSecondary,
        "editor.foreground": MONACO_THEME_COLORS.text,
        "editor.lineHighlightBackground": MONACO_THEME_COLORS.hover,
        "editor.selectionBackground": MONACO_THEME_COLORS.accentBg,
        "editorCursor.foreground": MONACO_THEME_COLORS.accent,
        "editorLineNumber.foreground": MONACO_THEME_COLORS.textDim,
        "editorLineNumber.activeForeground": MONACO_THEME_COLORS.text,
      },
    });

    const editor = monaco.editor.create(containerRef.current, {
      value: jsonText,
      language: "jsonc",
      theme: "settings-dark",
      automaticLayout: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      lineNumbers: "on",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      suggest: { showStatusBar: false },
      quickSuggestions: false,
      parameterHints: { enabled: false },
      wordWrap: "on",
      padding: { top: 8, bottom: 8 },
      renderWhitespace: "selection",
    });

    editorRef.current = editor;

    editor.onDidChangeModelContent(() => {
      setHasUnsaved(true);
      setSaved(false);
    });

    return () => {
      editor.dispose();
      editorRef.current = null;
    };
  }, [jsonText]);

  // Load on mount
  useEffect(() => {
    loadSettingsFile();
  }, [loadSettingsFile]);

  const handleSave = async () => {
    if (!editorRef.current) return;
    const content = editorRef.current.getValue();
    const path = configPath ?? settings.getConfigPath();
    if (!path) return;

    // Validate JSON (strip comments first)
    try {
      const stripped = content
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,\s*([}\]])/g, "$1");
      JSON.parse(stripped);
    } catch (e: any) {
      setError(`Invalid JSON: ${e.message}`);
      return;
    }

    try {
      await fsApi.writeFile({ path, content });
      await settings.loadSettings();
      setHasUnsaved(false);
      setSaved(true);
      setError(null);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setError(`Failed to save: ${e.message || e}`);
    }
  };

  const handleReset = async () => {
    await settings.resetSettings();
    loadSettingsFile();
    setError(null);
  };

  return (
    <div className="flex-1 flex flex-col bg-[var(--color-background-dark)] h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--color-border)] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-[var(--color-foreground)]">
            Settings
          </span>
          <span className="text-[11px] text-[var(--color-foreground-muted)]">
            {loading ? "loading..." : (configPath ?? "no config path")}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {saved && (
            <span className="text-[11px] text-[var(--color-primary)]">✓ Saved</span>
          )}
          {hasUnsaved && (
            <span className="text-[11px] text-[var(--color-foreground-muted)]">
              ● Unsaved
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            className="h-6 text-xs border-[var(--color-border)] text-[var(--color-foreground-muted)] hover:bg-[var(--color-hover)] hover:text-[var(--color-foreground)]"
          >
            Reset
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleSave}
            disabled={!hasUnsaved}
            className={cn(
              "h-6 text-xs",
              !hasUnsaved && "opacity-50 pointer-events-none"
            )}
          >
            Save
          </Button>
        </div>
      </div>

      {/* Error bar */}
      {error && (
        <div className="px-3 py-1 bg-[var(--color-red)]/10 border-b border-[var(--color-border)] text-[12px] text-[var(--color-red)] shrink-0">
          {error}
        </div>
      )}

      {/* Editor or loading state */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-[var(--color-foreground-muted)]">
          Loading settings...
        </div>
      ) : (
        <div ref={containerRef} className="flex-1 overflow-hidden" />
      )}

      {/* Footer hint */}
      <div className="px-3 py-1 border-t border-[var(--color-border)] text-[11px] text-[var(--color-foreground-dim)] shrink-0">
        JSONC format supported • Comments and trailing commas • Ctrl+S to save
      </div>
    </div>
  );
}
