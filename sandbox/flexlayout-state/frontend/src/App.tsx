import { useCallback, useEffect, useRef, useState } from "react";
import {
  Layout,
  Model,
  Actions,
  TabNode,
  type IJsonModel,
  type ITabRenderValues,
} from "flexlayout-react";
import * as monaco from "monaco-editor";

// ─── Types ──────────────────────────────────────────────────────────────────

interface Document {
  content: string;
  dirty: boolean;
}

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface ServerState {
  layout: IJsonModel;
  documents: Record<string, Document>;
}

// ─── App ────────────────────────────────────────────────────────────────────

export default function App() {
  const [model, setModel] = useState<Model | null>(null);
  const [documents, setDocuments] = useState<Record<string, Document>>({});
  const [dirEntries, setDirEntries] = useState<Record<string, DirEntry[]>>({});
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const layoutRef = useRef<IJsonModel | null>(null);

  // WebSocket connection
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[ws] connected");
      setConnected(true);
    };
    ws.onclose = () => {
      console.log("[ws] disconnected");
      setConnected(false);
    };
    ws.onerror = (e) => console.error("[ws] error", e);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "state") {
        const newLayout = msg.layout as IJsonModel;
        const newDocs = (msg.documents as Record<string, Document>) || {};

        // Only recreate model if layout structure changed
        const layoutChanged =
          JSON.stringify(newLayout) !== JSON.stringify(layoutRef.current);

        if (layoutChanged) {
          layoutRef.current = newLayout;
          const newModel = Model.fromJson(newLayout);
          setModel(newModel);
        }

        setDocuments(newDocs);
      } else if (msg.type === "dir_entries") {
        setDirEntries((prev) => ({
          ...prev,
          [msg.path]: msg.entries as DirEntry[],
        }));
      }
    };

    return () => ws.close();
  }, []);

  // Request workspace root listing once connected
  useEffect(() => {
    if (connected && wsRef.current) {
      wsRef.current.send(JSON.stringify({ type: "read_dir", path: "." }));
    }
  }, [connected]);

  const sendAction = useCallback((action: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(action));
    }
  }, []);

  // FlexLayout factory
  const factory = useCallback(
    (node: TabNode) => {
      const component = node.getComponent();
      const config = node.getConfig() || {};

      switch (component) {
        case "explorer":
          return (
            <ExplorerPane
              dirEntries={dirEntries}
              onOpenFile={(path) =>
                sendAction({ type: "open_file", path })
              }
              onReadDir={(path) =>
                sendAction({ type: "read_dir", path })
              }
            />
          );
        case "editor": {
          const path = config.path as string;
          const doc = path ? documents[path] : undefined;
          return (
            <EditorPane
              path={path}
              document={doc}
              onEdit={(content) =>
                sendAction({ type: "edit_file", path, content })
              }
              onSave={() => sendAction({ type: "save_file", path })}
            />
          );
        }
        case "terminal":
          return <TerminalPane />;
        case "welcome":
          return <WelcomePane />;
        default:
          return <div>Unknown: {component}</div>;
      }
    },
    [documents, dirEntries, sendAction]
  );

  // Handle tab close — send to backend
  const onAction = useCallback((action: any) => {
    if (action.type === Actions.DELETE_TAB) {
      const tabId = action.data.node;
      sendAction({ type: "close_tab", tab_id: tabId });
    }
    return action;
  }, [sendAction]);

  // Dirty indicator in tab
  const onRenderTab = useCallback(
    (node: TabNode, renderValues: ITabRenderValues) => {
      if (node.getComponent() === "editor") {
        const path = node.getConfig()?.path as string;
        const doc = path ? documents[path] : undefined;
        const isDirty = doc?.dirty;
        renderValues.content = (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {isDirty && (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  backgroundColor: "#f38ba8",
                  display: "inline-block",
                }}
              />
            )}
            {renderValues.content}
          </span>
        );
      }
    },
    [documents]
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
      }}
    >
      {/* Status bar */}
      <div
        style={{
          padding: "4px 12px",
          background: "#181825",
          borderBottom: "1px solid #313244",
          fontSize: 12,
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        <span style={{ color: connected ? "#a6e3a1" : "#f38ba8" }}>●</span>
        <span>{connected ? "Connected" : "Disconnected"}</span>
        <span style={{ marginLeft: "auto", color: "#6c7086" }}>
          Backend owns all state · Frontend is a dumb view
        </span>
      </div>

      {/* FlexLayout */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {model && (
          <Layout
            model={model}
            factory={factory}
            onAction={onAction}
            onRenderTab={onRenderTab}
          />
        )}
      </div>
    </div>
  );
}

// ─── Explorer Pane ──────────────────────────────────────────────────────────

function ExplorerPane({
  dirEntries,
  onOpenFile,
  onReadDir,
}: {
  dirEntries: Record<string, DirEntry[]>;
  onOpenFile: (path: string) => void;
  onReadDir: (path: string) => void;
}) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const rootEntries = dirEntries["."] || [];

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        // Request listing if not cached
        if (!dirEntries[path]) {
          onReadDir(path);
        }
      }
      return next;
    });
  };

  const renderEntries = (entries: DirEntry[], level: number) => {
    return entries.map((entry) => (
      <div key={entry.path}>
        <div
          className={`explorer-item ${entry.is_dir ? "explorer-item--dir" : "explorer-item--file"}`}
          style={{ paddingLeft: 12 + level * 14 }}
          onClick={() => {
            if (entry.is_dir) {
              toggleDir(entry.path);
            } else {
              onOpenFile(entry.path);
            }
          }}
        >
          <span className="explorer-icon">
            {entry.is_dir
              ? expandedDirs.has(entry.path)
                ? "📂"
                : "📁"
              : "📄"}
          </span>
          <span>{entry.name}</span>
        </div>
        {entry.is_dir &&
          expandedDirs.has(entry.path) &&
          dirEntries[entry.path] &&
          renderEntries(dirEntries[entry.path], level + 1)}
      </div>
    ));
  };

  return (
    <div className="explorer-pane">
      <div
        style={{
          padding: "4px 12px",
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          color: "#6c7086",
          marginBottom: 4,
        }}
      >
        Explorer
      </div>
      {renderEntries(rootEntries, 0)}
    </div>
  );
}

// ─── Editor Pane (Monaco) ───────────────────────────────────────────────────

function EditorPane({
  path,
  document,
  onEdit,
  onSave,
}: {
  path: string;
  document?: Document;
  onEdit: (content: string) => void;
  onSave: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const lastContentRef = useRef<string>("");
  const ignoreChangeRef = useRef(false);

  // Create / dispose Monaco editor
  useEffect(() => {
    if (!containerRef.current) return;

    monaco.editor.defineTheme("sandbox-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#1e1e2e",
        "editor.lineHighlightBackground": "#31324433",
        "editorLineNumber.foreground": "#6c7086",
        "editorLineNumber.activeForeground": "#cdd6f4",
        "editor.selectionBackground": "#585b7080",
        "editor.inactiveSelectionBackground": "#45475a80",
      },
    });

    const editor = monaco.editor.create(containerRef.current, {
      value: document?.content ?? "",
      language: getLanguage(path),
      theme: "sandbox-dark",
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      padding: { top: 12 },
      lineNumbers: "on",
      renderLineHighlight: "line",
      tabSize: 2,
      insertSpaces: true,
    });

    editorRef.current = editor;
    lastContentRef.current = document?.content ?? "";

    // Listen for changes
    const disposable = editor.onDidChangeModelContent(() => {
      if (ignoreChangeRef.current) return;
      const content = editor.getValue();
      lastContentRef.current = content;
      onEdit(content);
    });

    // Ctrl+S to save
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        onSave();
      }
    );

    return () => {
      disposable.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, [path]); // Recreate editor when path changes

  // Sync external document changes into Monaco (without triggering onEdit)
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !document) return;

    const currentValue = editor.getValue();
    if (currentValue !== document.content) {
      // Only update if content actually differs
      ignoreChangeRef.current = true;
      editor.setValue(document.content);
      ignoreChangeRef.current = false;
      lastContentRef.current = document.content;
    }
  }, [document?.content]);

  if (!document) {
    return (
      <div className="editor-pane--empty">Loading {path.split("/").pop()}…</div>
    );
  }

  return <div ref={containerRef} className="editor-pane" />;
}

function getLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    rs: "rust",
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    go: "go",
    json: "json",
    md: "markdown",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    css: "css",
    html: "html",
    sh: "shell",
  };
  return map[ext] || "plaintext";
}

// ─── Welcome Pane ───────────────────────────────────────────────────────────

function WelcomePane() {
  return (
    <div className="welcome-pane">
      <h1>FlexLayout + Backend State</h1>
      <p>
        This is a prototype where <strong>all state lives in the Rust backend</strong>.
      </p>
      <p>
        The frontend is a dumb view. Open files from the Explorer to see it in
        action.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          marginTop: 16,
          fontSize: 12,
          maxWidth: 400,
        }}
      >
        <div
          style={{
            background: "#181825",
            padding: 12,
            borderRadius: 6,
            border: "1px solid #313244",
          }}
        >
          <div style={{ color: "#89b4fa", fontWeight: 600, marginBottom: 4 }}>
            Backend Owns
          </div>
          <div style={{ color: "#6c7086", lineHeight: 1.6 }}>
            Layout model
            <br />
            Open documents
            <br />
            Dirty state
            <br />
            File tree
          </div>
        </div>
        <div
          style={{
            background: "#181825",
            padding: 12,
            borderRadius: 6,
            border: "1px solid #313244",
          }}
        >
          <div style={{ color: "#a6e3a1", fontWeight: 600, marginBottom: 4 }}>
            Frontend Does
          </div>
          <div style={{ color: "#6c7086", lineHeight: 1.6 }}>
            Render view
            <br />
            Capture input
            <br />
            Send actions
            <br />
            Receive state
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Terminal Pane ──────────────────────────────────────────────────────────

function TerminalPane() {
  return (
    <div className="terminal-pane">
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>⌨️</div>
        <div>Terminal placeholder</div>
        <div style={{ fontSize: 11, marginTop: 4, color: "#45475a" }}>
          (xterm.js would go here)
        </div>
      </div>
    </div>
  );
}
