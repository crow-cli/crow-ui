/** WorkspacePane — A tabbed workspace containing editors + terminal */
import { useState, useCallback, useEffect, useRef } from "react";
import EditorPane, { setModelContent } from "./EditorPane";
import TerminalPane from "./TerminalPane";
import { ws } from "../lib/ws-client";
import { FileIcon } from "../lib/file-icons";

function getLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    rs: "rust",
    ts: "typescript",
    tsx: "typescriptreact",
    js: "javascript",
    jsx: "javascriptreact",
    py: "python",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    html: "html",
    json: "json",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    sh: "shell",
  };
  return map[ext] || "plaintext";
}

export interface TabItem {
  id: string;
  type: "file" | "terminal";
  path?: string;
  title: string;
  language?: string;
  dirty?: boolean;
}

export interface WorkspacePaneHandle {
  openFile: (path: string) => Promise<string | null>;
  openTerminal: () => string;
}

interface WorkspacePaneProps {
  id: string;
  workspaceRoot: string | null;
  onActivate?: (handle: WorkspacePaneHandle) => void;
}

export default function WorkspacePane({
  id,
  workspaceRoot,
  onActivate,
}: WorkspacePaneProps) {
  const [tabs, setTabs] = useState<TabItem[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const paneRef = useRef<WorkspacePaneHandle | null>(null);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isEditorActive = activeTab?.type === "file";
  const isTerminalActive = activeTab?.type === "terminal";
  const activeFilePath =
    activeTab?.type === "file" ? (activeTab.path ?? null) : null;
  const activeFileLanguage =
    activeTab?.type === "file"
      ? (activeTab.language ?? "plaintext")
      : "plaintext";

  useEffect(() => {
    let terminalCounter = 0;
    const handle: WorkspacePaneHandle = {
      openFile: async (path: string) => {
        const existing = tabs.find((t) => t.type === "file" && t.path === path);
        if (existing) {
          setActiveTabId(existing.id);
          return existing.id;
        }
        try {
          const result = await ws.invoke<{ content: string }>("read_file", {
            path,
          });
          const language = getLanguage(path);
          setModelContent(path, result.content, language);
          const tabId = `file-${path}-${Date.now()}`;
          const newTab: TabItem = {
            id: tabId,
            type: "file",
            path,
            title: path.split("/").pop() || path,
            language,
          };
          setTabs((prev) => [...prev, newTab]);
          setActiveTabId(tabId);
          return tabId;
        } catch (e) {
          console.error("Failed to open file:", e);
          return null;
        }
      },
      openTerminal: () => {
        terminalCounter++;
        const tabId = `terminal-${Date.now()}-${terminalCounter}`;
        const tabNum = tabs.filter((t) => t.type === "terminal").length + 1;
        const newTab: TabItem = {
          id: tabId,
          type: "terminal",
          title: `Terminal ${tabNum}`,
        };
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(tabId);
        return tabId;
      },
    };
    paneRef.current = handle;
    onActivate?.(handle);
  }, []);

  const openFile = useCallback(
    async (path: string) => paneRef.current?.openFile(path) ?? null,
    [],
  );
  const openTerminal = useCallback(
    () => paneRef.current?.openTerminal() ?? "",
    [],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== tabId);
        if (activeTabId === tabId)
          setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
        return next;
      });
    },
    [activeTabId],
  );

  // Pick a file to keep the EditorPane mounted even when terminal is active
  const mountedFilePath =
    activeFilePath ?? tabs.find((t) => t.type === "file")?.path ?? null;
  const mountedFileLanguage =
    activeFileLanguage !== "plaintext"
      ? activeFileLanguage
      : (tabs.find((t) => t.type === "file")?.language ?? "plaintext");

  return (
    <div className="flex flex-col h-full bg-[var(--color-background-dark)]">
      {/* ── Tab Bar ──────────────────────────────────────────────────── */}
      {tabs.length > 0 && (
        <div className="flex bg-[var(--color-background)] border-b border-[var(--color-border)] overflow-x-auto shrink-0 h-[35px]">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className={`flex items-center gap-1.5 px-3 text-[13px] cursor-pointer select-none border-r border-[var(--color-border)] min-w-0 relative transition-colors ${
                  isActive
                    ? "bg-[var(--color-card)] text-[var(--color-foreground)]"
                    : "bg-transparent text-[var(--color-foreground-dim)] hover:bg-[var(--color-border)]"
                }`}
                onClick={() => setActiveTabId(tab.id)}
              >
                {isActive && (
                  <div className="absolute top-0 left-0 right-0 h-[1px] bg-[var(--color-primary)]" />
                )}
                {tab.type === "file" ? (
                  <FileIcon name={tab.title} size={12} />
                ) : (
                  <span className="text-xs">⌨️</span>
                )}
                <span className="overflow-hidden text-ellipsis whitespace-nowrap max-w-[150px]">
                  {tab.title}
                </span>
                {tab.dirty && (
                  <span className="text-[8px] leading-none text-[var(--color-primary)]">
                    ●
                  </span>
                )}
                <button
                  className="ml-auto h-5 w-5 p-0 rounded-sm text-[var(--color-active)] hover:text-[var(--color-destructive)] hover:bg-[var(--color-border)] flex items-center justify-center"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Stacking Container ───────────────────────────────────────── */}
      {/* Editor always at z-1, terminal at z-10 when active (covers it). */}
      {/* Nothing is ever hidden with opacity/display — z-index layering. */}
      <div className="relative flex-1 min-h-0 min-w-0 overflow-hidden">
        {tabs.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 opacity-50">
            <div className="text-4xl">◆</div>
            <div className="text-lg font-light">No files open</div>
            <div className="text-xs">Use Ctrl+P to open a file</div>
          </div>
        )}

        {/* Editor — always mounted at z-1 */}
        {mountedFilePath && (
          <div className="absolute inset-0 z-[1]">
            <EditorPane path={mountedFilePath} language={mountedFileLanguage} isActive={isEditorActive} />
          </div>
        )}

        {/* Terminals — z-10 when active (covers editor), z-0 when not */}
        {tabs
          .filter((t) => t.type === "terminal")
          .map((termTab) => {
            const isActive = termTab.id === activeTabId;
            return (
              <div
                key={termTab.id}
                className={`absolute inset-0 bg-[var(--color-background-deeper)] ${isActive ? "z-[10]" : "z-0"}`}
              >
                {workspaceRoot ? (
                  <TerminalPane workspaceRoot={workspaceRoot} terminalId={termTab.id} />
                ) : (
                  <div className="flex items-center justify-center h-full opacity-50">
                    Open a directory to use the terminal
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
