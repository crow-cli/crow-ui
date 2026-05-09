import { useEffect, useState, useCallback, useRef, type ReactNode } from "react";
import {
  Layout,
  Model,
  type IJsonModel,
  TabNode,
  type Node,
  Actions,
  DockLocation,
  type ITabRenderValues,
  type DropInfo,
} from "flexlayout-react";
import {
  Terminal,
  Sparkles,
  FolderOpen,
  FileCode2,
  FileJson,
  Settings,
  Activity,
  SquareSplitVertical,
  X,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel,
} from "./components/ui/context-menu";
import { cn } from "./lib/utils";
import { disposeModel, getModelContent, setModelContent } from "./components/EditorPane";
import EditorPane from "./components/EditorPane";
import ExplorerPane from "./components/ExplorerPane";
import TerminalPane from "./components/TerminalPane";
import ChatPane from "./components/ChatPane";
import RpcLogPanel from "./components/RpcLogPanel";
import SettingsPane from "./components/SettingsPane";
import { FolderPicker } from "./components/FolderPicker";
import BottomBar, { type ActivityId } from "./components/BottomBar";
import { MenuBar, type MenuGroup } from "./components/MenuBar";
import * as settings from "./lib/settings";
import { ws } from "./lib/ws-client";
import { setGlobalOpenFile, setGlobalOpenTerminal, setGlobalOpenChat, globalOpenFile, globalOpenTerminal, globalOpenChat } from "./lib/workspace-context";
import type { AgentConfig } from "./lib/acp-client";
import * as acpStore from "./lib/acp-store";

/** Default fallback if config file fails to load */
const FALLBACK_AGENT_CONFIG: AgentConfig = {
  name: "crow-cli",
  command: "crow-cli",
  args: ["acp"],
  env: [],
};

interface OpenFile {
  path: string;
  language: string;
}

// ── Tab Icons ───────────────────────────────────────────────────────────────
function getTabIcon(name: string): ReactNode {
  if (name === "Explorer")
    return <FolderOpen className="w-3.5 h-3.5 text-violet-500" />;
  if (name === "Agent Chat" || name.startsWith("Chat"))
    return <Sparkles className="w-3.5 h-3.5 text-violet-500" />;
  if (name === "Terminal" || name.startsWith("Terminal"))
    return <Terminal className="w-3.5 h-3.5 text-zinc-400" />;
  if (name === "Settings")
    return <Settings className="w-3.5 h-3.5 text-zinc-400" />;
  if (name === "ACP Log")
    return <Activity className="w-3.5 h-3.5 text-zinc-400" />;
  if (
    name.endsWith(".rs") ||
    name.endsWith(".ts") ||
    name.endsWith(".tsx") ||
    name.endsWith(".js") ||
    name.endsWith(".jsx") ||
    name.endsWith(".py") ||
    name.endsWith(".go")
  )
    return <FileCode2 className="w-3.5 h-3.5 text-violet-500" />;
  if (name.endsWith(".toml") || name.endsWith(".json") || name.endsWith(".yaml") || name.endsWith(".yml"))
    return <FileJson className="w-3.5 h-3.5 text-zinc-500" />;
  return null;
}

// ── Drop Rules ──────────────────────────────────────────────────────────────
const onAllowDrop = (dragNode: Node, dropInfo: DropInfo) => {
  const dropNode = dropInfo.node;
  // Prevent non-border tabs dropping into borders
  if (
    dropNode.getType() === "border" &&
    (dragNode.getParent() == null || dragNode.getParent()!.getType() !== "border")
  )
    return false;
  // Prevent border tabs dropping into main layout
  if (
    dropNode.getType() !== "border" &&
    dragNode.getParent() != null &&
    dragNode.getParent()!.getType() === "border"
  )
    return false;
  return true;
};

export default function App() {
  const [connected, setConnected] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<Map<string, OpenFile>>(new Map());
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeActivity, setActiveActivity] = useState<ActivityId>("explorer");
  const [explorerVisible, setExplorerVisible] = useState(true);
  const [_menuOpen, setMenuOpen] = useState<string | null>(null);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);
  const [wordWrap, setWordWrap] = useState(
    settings.getSettings().editor.wordWrap === "on"
  );
  const [agentConfig, setAgentConfig] = useState<AgentConfig>(FALLBACK_AGENT_CONFIG);

  // FlexLayout model ref
  const layoutModelRef = useRef<Model | null>(null);
  const [modelJson, setModelJson] = useState<IJsonModel | null>(null);

  // Panel visibility for BottomBar toggles
  const [minimizedTabsets, setMinimizedTabsets] = useState<Set<string>>(new Set());

  // Find all tabsets that contain tabs of a given component type
  const findTabsetsByComponent = useCallback((component: string): string[] => {
    const model = layoutModelRef.current;
    if (!model) return [];
    const ids: string[] = [];
    model.visitNodes((node) => {
      if (node.getType() === "tabset") {
        const children = node.getChildren();
        if (children.some((c) => c.getType() === "tab" && (c as TabNode).getComponent() === component)) {
          ids.push(node.getId());
        }
      }
      return true;
    });
    return ids;
  }, []);

  // Count tabs of a given component type in minimized tabsets
  const countMinimizedTabs = useCallback((component: string): number => {
    const model = layoutModelRef.current;
    if (!model) return 0;
    let count = 0;
    minimizedTabsets.forEach((tabsetId) => {
      const node = model.getNodeById(tabsetId);
      if (node && node.getType() === "tabset") {
        const children = node.getChildren();
        children.forEach((child) => {
          if (child.getType() === "tab" && (child as TabNode).getComponent() === component) {
            count++;
          }
        });
      }
    });
    return count;
  }, [minimizedTabsets]);

  // Toggle minimize/restore for tabsets by component type
  const toggleMinimize = useCallback((component: string) => {
    const model = layoutModelRef.current;
    if (!model) return;
    const tabsetIds = findTabsetsByComponent(component);
    if (tabsetIds.length === 0) return;

    setMinimizedTabsets((prev) => {
      const next = new Set(prev);
      const allMinimized = tabsetIds.every((id) => next.has(id));

      if (allMinimized) {
        // Restore: remove size constraint
        tabsetIds.forEach((id) => {
          next.delete(id);
          model.doAction(Actions.updateNodeAttributes(id, { maxHeight: 99999 }));
        });
      } else {
        // Minimize: clamp to tiny height
        tabsetIds.forEach((id) => {
          next.add(id);
          model.doAction(Actions.updateNodeAttributes(id, { maxHeight: 1 }));
        });
      }
      return next;
    });
  }, [findTabsetsByComponent]);

  // Toggle explorer border visibility
  const toggleExplorer = useCallback(() => {
    const model = layoutModelRef.current;
    if (!model) return;
    const border = model.getBorderSet().getBorderMap().get(DockLocation.RIGHT);
    if (!border) return;
    const next = !(border.getAttr("show") as boolean);
    model.doAction(Actions.updateNodeAttributes(border.getId(), { show: next } as any));
    setExplorerVisible(next);
  }, []);

  // Load agent config from JSON file
  useEffect(() => {
    fetch("/agent-config.json")
      .then(r => r.json())
      .then(setAgentConfig)
      .catch(() => {});
  }, []);

  // Note: settings are loaded after WebSocket connects (see below)

  const activeFileRef = useRef(activeFile);
  const dirtyFilesRef = useRef(dirtyFiles);
  const openFilesRef = useRef(openFiles);
  const workspaceRootRef = useRef(workspaceRoot);
  const savingRef = useRef(saving);
  const agentConfigRef = useRef(agentConfig);

  useEffect(() => {
    agentConfigRef.current = agentConfig;
  }, [agentConfig]);

  useEffect(() => {
    activeFileRef.current = activeFile;
  }, [activeFile]);
  useEffect(() => {
    dirtyFilesRef.current = dirtyFiles;
  }, [dirtyFiles]);
  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);
  useEffect(() => {
    workspaceRootRef.current = workspaceRoot;
  }, [workspaceRoot]);
  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  // Connect WebSocket on mount
  useEffect(() => {
    ws.connect()
      .then(() => setConnected(true))
      .catch(console.error);
    return () => ws.disconnect();
  }, []);

  // Subscribe to backend ACP control commands
  useEffect(() => {
    return ws.onAcpCommand((method, params) => {
      if (method === "acp-command-new-session") {
        const requestId = params.requestId as string;
        const sessionId = `session-${Date.now()}`;
        // Use current workspace and agent config
        if (workspaceRoot && agentConfigRef.current) {
          acpStore.createSession(sessionId, agentConfigRef.current, workspaceRoot);

          // Open a chat tab for this session
          const model = layoutModelRef.current;
          if (model) {
            const chatId = `chat-${Date.now()}`;
            let targetNode = model.getNodeById("chat-tabset");
            if (!targetNode) {
              model.visitNodes((node) => {
                if (node.getType() === "tabset") {
                  const children = node.getChildren();
                  if (children.some((c) => c.getType() === "tab" && (c as TabNode).getComponent() === "chat")) {
                    targetNode = node;
                    return false;
                  }
                }
                return true;
              });
            }
            if (targetNode) {
              model.doAction(
                Actions.addTab(
                  { type: "tab", name: "Agent Chat", component: "chat", config: { sessionId }, id: chatId },
                  targetNode.getId(),
                  DockLocation.CENTER,
                  -1,
                  true,
                ),
              );
            } else {
              const editorTabset = model.getNodeById("editor-tabset");
              if (editorTabset) {
                const centerRow = editorTabset.getParent();
                if (centerRow && centerRow.getType() === "row") {
                  model.doAction(
                    Actions.addNode(
                      { type: "tab", name: "Agent Chat", component: "chat", config: { sessionId }, id: chatId },
                      centerRow.getId(),
                      DockLocation.RIGHT,
                      -1,
                      true,
                    ),
                  );
                }
              }
            }
          }

          // Report back to backend when session is ready
          const checkReady = setInterval(() => {
            const client = acpStore.getClient(sessionId);
            if (client?.activeSessionId) {
              clearInterval(checkReady);
              ws.invoke("acp_report_session_created", {
                requestId,
                result: { sessionId },
              }).catch(console.error);
            }
          }, 100);
          // Timeout after 25s
          setTimeout(() => clearInterval(checkReady), 25000);
        }
      } else if (method === "acp-command-prompt") {
        const sessionId = params.sessionId as string;
        const blocks = params.blocks as any[];
        acpStore.prompt(sessionId, blocks).catch(console.error);
      } else if (method === "acp-command-cancel") {
        const sessionId = params.sessionId as string;
        acpStore.cancel(sessionId).catch(console.error);
      }
    });
  }, [workspaceRoot]);

  // Load settings after connection
  useEffect(() => {
    if (!connected) return;
    settings.initSettings().then(() => {
      setWordWrap(settings.getSettings().editor.wordWrap === "on");
    });
    return settings.subscribe(() => {
      setWordWrap(settings.getSettings().editor.wordWrap === "on");
    });
  }, [connected]);

  // Track whether we've auto-restored workspace this session
  const restoredRef = useRef(false);

  // Initialize FlexLayout model
  useEffect(() => {
    if (!connected) return;
    const initialModel: IJsonModel = {
      global: {
        tabEnableClose: true,
        tabEnableRename: false,
        tabSetEnableMaximize: false,
        tabSetEnableSingleTabStretch: false,
      },
      borders: [
        {
          type: "border",
          location: "right",
          size: 240,
          selected: 0,
          children: [
            {
              type: "tab",
              id: "explorer-tab",
              name: "Explorer",
              component: "explorer",
            },
          ],
        },
      ],
      layout: {
        type: "row",
        weight: 100,
        children: [
          // Center stack: Editor (top) + Terminal (bottom)
          {
            type: "row",
            weight: 100,
            children: [
              {
                type: "tabset",
                id: "editor-tabset",
                weight: 70,
                selected: 0,
                children: [
                  {
                    type: "tab",
                    name: "Welcome",
                    component: "welcome",
                  },
                ],
              },
              {
                type: "tabset",
                id: "terminal-tabset",
                weight: 30,
                selected: 0,
                children: [
                  {
                    type: "tab",
                    name: "Terminal",
                    component: "terminal",
                    config: { terminalId: "default" },
                  },
                ],
              },
            ],
          },
          // Chat panel (right)
          {
            type: "tabset",
            id: "chat-tabset",
            weight: 25,
            selected: 0,
            children: [
              {
                type: "tab",
                name: "Agent Chat",
                component: "chat",
                config: { sessionId: "chat-initial" },
              },
            ],
          },
        ],
      },
    };
    const model = Model.fromJson(initialModel);
    model.setOnAllowDrop(onAllowDrop);
    layoutModelRef.current = model;
    setModelJson(initialModel);
  }, [connected]);

  // Auto-restore workspace on page refresh / reconnect
  useEffect(() => {
    if (!connected || !modelJson || restoredRef.current) return;
    restoredRef.current = true;

    (async () => {
      try {
        // First check if server already has a workspace open
        const current = await ws.invoke<{ workspace?: string | null }>("get_current_workspace", {});
        let path = current.workspace;

        // If server has no workspace (e.g. restarted), fall back to most recent from DB
        if (!path) {
          const recent = await ws.invoke<Array<{ path: string; last_opened: string }>>("get_recent_workspaces", { limit: 1 });
          if (recent && recent.length > 0) {
            path = recent[0].path;
          }
        }

        if (path) {
          await handleOpenFolder(path);
        }
      } catch {
        // Silently fail — user can manually open a workspace
      }
    })();
  }, [connected, modelJson]);

  // Set up global open functions for non-React code
  useEffect(() => {
    if (!connected) return;

    setGlobalOpenFile(async (path: string) => {
      const language = getLanguage(path);
      setModelJson((prev) => {
        if (!prev || !layoutModelRef.current) return prev;
        const model = layoutModelRef.current;
        const node = model.getNodeById(`file-${path}`);
        if (node) {
          model.doAction(Actions.selectTab(node.getId()));
          return prev;
        }
        model.doAction(
          Actions.addTab(
            {
              type: "tab",
              name: path.split("/").pop() || path,
              component: "editor",
              config: { path, language },
              id: `file-${path}`,
            },
            "editor-tabset",
            DockLocation.CENTER,
            -1,
          ),
        );
        return prev;
      });
      setActiveFile(path);
    });

    setGlobalOpenTerminal(() => {
      if (!layoutModelRef.current) return;
      const model = layoutModelRef.current;
      const termId = `term-${Date.now()}`;

      // Find target tabset — existing terminal-tabset, any tabset with a terminal, or create new
      let targetId = "terminal-tabset";
      let targetNode = model.getNodeById(targetId);

      if (!targetNode) {
        model.visitNodes((node) => {
          if (node.getType() === "tabset") {
            const children = node.getChildren();
            if (children.some((c) => c.getType() === "tab" && (c as TabNode).getComponent() === "terminal")) {
              targetNode = node;
              return false;
            }
          }
          return true;
        });
      }

      if (targetNode) {
        model.doAction(
          Actions.addTab(
            {
              type: "tab",
              name: `Terminal ${termId.slice(-4)}`,
              component: "terminal",
              config: { terminalId: termId },
              id: termId,
            },
            targetNode.getId(),
            DockLocation.CENTER,
            -1,
            true,
          ),
        );
      } else {
        // No terminal tabset exists — create one to the right of editor row
        const editorTabset = model.getNodeById("editor-tabset");
        if (editorTabset) {
          const centerRow = editorTabset.getParent();
          if (centerRow && centerRow.getType() === "row") {
            model.doAction(
              Actions.addNode(
                {
                  type: "tab",
                  name: `Terminal ${termId.slice(-4)}`,
                  component: "terminal",
                  config: { terminalId: termId },
                  id: termId,
                },
                centerRow.getId(),
                DockLocation.RIGHT,
                -1,
                true,
              ),
            );
          }
        }
      }
    });

    setGlobalOpenChat(() => {
      if (!layoutModelRef.current) return;
      const model = layoutModelRef.current;
      const chatId = `chat-${Date.now()}`;
      const sessionId = `session-${Date.now()}`;
      if (workspaceRootRef.current) {
        acpStore.createSession(sessionId, agentConfigRef.current, workspaceRootRef.current);
      }

      // Find an existing chat tabset, or create one in the right place
      let targetId = "chat-tabset";
      let targetNode = model.getNodeById(targetId);

      if (!targetNode) {
        // Search for any tabset containing a chat tab
        model.visitNodes((node) => {
          if (node.getType() === "tabset") {
            const children = node.getChildren();
            if (children.some((c) => c.getType() === "tab" && (c as TabNode).getComponent() === "chat")) {
              targetNode = node;
              return false; // stop visiting
            }
          }
          return true;
        });
      }

      if (targetNode) {
        // Add to existing chat tabset
        model.doAction(
          Actions.addTab(
            {
              type: "tab",
              name: "Agent Chat",
              component: "chat",
              config: { sessionId },
              id: chatId,
            },
            targetNode.getId(),
            DockLocation.CENTER,
            -1,
            true,
          ),
        );
      } else {
        // No chat tabset exists — create one by adding a new tab to the right of the editor row
        // Find the main center row (parent of editor-tabset)
        const editorTabset = model.getNodeById("editor-tabset");
        if (editorTabset) {
          const centerRow = editorTabset.getParent();
          if (centerRow && centerRow.getType() === "row") {
            // Pass just the tab JSON — FlexLayout's RowNode.drop() will wrap it
            // in a new TabSetNode when docking to a non-CENTER location
            model.doAction(
              Actions.addNode(
                {
                  type: "tab",
                  name: "Agent Chat",
                  component: "chat",
                  config: { sessionId },
                  id: chatId,
                },
                centerRow.getId(),
                DockLocation.RIGHT,
                -1,
                true,
              ),
            );
          }
        }
      }
    });
  }, [connected, workspaceRoot]);

  // Save file
  const saveFile = useCallback(
    async (path: string) => {
      if (savingRef.current) return;
      setSaving(true);
      try {
        const content = getModelContent(path) ?? "";
        await ws.invoke("document_set_content", { path, content });
        await ws.invoke("document_save", { path });
        setDirtyFiles((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      } catch (e: any) {
        console.error("Save failed:", e);
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  // Close tab
  const closeTab = useCallback((path: string) => {
    disposeModel(path);
    ws.invoke("document_close", { path }).catch(console.error);
    setOpenFiles((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
    setDirtyFiles((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    const remaining = Array.from(openFilesRef.current.keys()).filter(
      (p) => p !== path,
    );
    if (activeFileRef.current === path) {
      setActiveFile(
        remaining.length > 0 ? remaining[remaining.length - 1] : null,
      );
    }
  }, []);

  // Global keyboard shortcuts (non-editor — editor handles its own via Monaco)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key === "o" && !e.shiftKey && !isInput) {
        e.preventDefault();
        e.stopPropagation();
        setShowFolderPicker(true);
        return;
      }
      if (ctrl && e.key === "s") {
        // Always save active file, regardless of what has focus
        // Let it fall through to Monaco if we don't have activeFile tracked
        const af = activeFileRef.current;
        if (af) {
          e.preventDefault();
          e.stopPropagation();
          saveFile(af);
          return;
        }
      }
      if (ctrl && e.key === "b" && !isInput) {
        e.preventDefault();
        e.stopPropagation();
        toggleExplorer();
        return;
      }
      if (ctrl && e.key === "`" && !isInput) {
        e.preventDefault();
        e.stopPropagation();
        toggleMinimize("terminal");
        return;
      }
      if (ctrl && e.key === "l" && !isInput) {
        e.preventDefault();
        e.stopPropagation();
        toggleMinimize("chat");
        return;
      }
      if (e.altKey && e.key === "z") {
        e.preventDefault();
        e.stopPropagation();
        setWordWrap((v) => {
          settings.updateLocalSetting("editor", "wordWrap", !v ? "on" : "off");
          return !v;
        });
        return;
      }
      if (ctrl && e.shiftKey && e.key === "R" && !isInput) {
        e.preventDefault();
        e.stopPropagation();
        setActiveActivity("rpc");
        return;
      }
      if (e.key === "Escape") {
        setMenuOpen(null);
        setShowFolderPicker(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  // Listen for Monaco Ctrl+S custom event (save)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.path) saveFile(detail.path);
    };
    window.addEventListener("editor-save", handler);
    return () => window.removeEventListener("editor-save", handler);
  }, [saveFile]);

  // Listen for Monaco Ctrl+W custom event (close tab)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.path) closeTab(detail.path);
    };
    window.addEventListener("editor-close-tab", handler);
    return () => window.removeEventListener("editor-close-tab", handler);
  }, [closeTab]);

  // Debounced layout save — write flexlayout JSON to backend SQLite
  const layoutSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveLayout = useCallback((modelJson: IJsonModel) => {
    const wsRoot = workspaceRootRef.current;
    if (!wsRoot) return;
    if (layoutSaveTimer.current) clearTimeout(layoutSaveTimer.current);
    layoutSaveTimer.current = setTimeout(() => {
      ws.invoke("save_workspace_layout", {
        workspace: wsRoot,
        layout: JSON.stringify(modelJson),
      }).catch(() => {});
    }, 500);
  }, []);

  const handleOpenFolder = async (path: string) => {
    setShowFolderPicker(false);
    try {
      await ws.invoke<{ root: string }>("workspace_open", { path });
      setWorkspaceRoot(path);
      // Track in recently opened
      await settings.addRecentlyOpened(path);
      setActiveActivity("explorer");

      // Try to load saved layout for this workspace
      const saved = await ws.invoke<{ layout?: string }>("get_workspace_layout", {
        workspace: path,
      }).catch(() => ({ layout: undefined }));

      if (saved.layout) {
        try {
          const parsed: IJsonModel = JSON.parse(saved.layout);
          const model = Model.fromJson(parsed);
          model.setOnAllowDrop(onAllowDrop);
          layoutModelRef.current = model;
          setModelJson(parsed);
        } catch {
          // Invalid saved layout, keep default
        }
      }
    } catch (e: any) {
      console.error("Failed to open:", e);
    }
  };

  const handleFileClick = async (path: string, isDir: boolean) => {
    if (isDir) return;
    await globalOpenFile(path);
  };

  const handleCursorChange = useCallback((line: number, col: number) => {
    setCursorLine(line);
    setCursorCol(col);
  }, []);

  const handleDirtyChange = useCallback((dirty: boolean) => {
    const af = activeFileRef.current;
    if (!af) return;
    if (dirty) setDirtyFiles((prev) => new Set(prev).add(af));
  }, []);

  const handleMenuAction = useCallback(
    (action: string) => {
      switch (action) {
        case "open_folder":
          setShowFolderPicker(true);
          break;
        case "save": {
          const af = activeFileRef.current;
          if (af) saveFile(af);
          break;
        }
        case "save_all": {
          for (const path of dirtyFilesRef.current) saveFile(path);
          break;
        }
        case "close_editor": {
          const af = activeFileRef.current;
          if (af) closeTab(af);
          break;
        }
        case "toggle_sidebar":
          toggleExplorer();
          break;
        case "toggle_terminal":
          toggleMinimize("terminal");
          break;
        case "toggle_chat":
          toggleMinimize("chat");
          break;
        case "word_wrap":
          setWordWrap((v) => {
            settings.updateLocalSetting("editor", "wordWrap", !v ? "on" : "off");
            return !v;
          });
          break;
        case "explorer":
          setActiveActivity("explorer");
          toggleExplorer();
          break;
        case "search":
          setActiveActivity("search");
          break;
        case "source_control":
          setActiveActivity("git");
          break;
        case "terminal":
          globalOpenTerminal();
          break;
        case "new_terminal":
          globalOpenTerminal();
          break;
        case "extensions":
          setActiveActivity("extensions");
          break;
        case "chat":
          globalOpenChat();
          break;
        case "rpc_log": {
          setActiveActivity("rpc");
          const model = layoutModelRef.current;
          if (model) {
            const node = model.getNodeById("rpc-tab");
            if (node) {
              model.doAction(Actions.selectTab("rpc-tab"));
            } else {
              model.doAction(
                Actions.addTab(
                  {
                    type: "tab",
                    id: "rpc-tab",
                    name: "ACP Log",
                    component: "rpc",
                  },
                  "editor-tabset",
                  DockLocation.CENTER,
                  -1,
                ),
              );
            }
          }
          break;
        }
        case "settings": {
          setActiveActivity("settings");
          const model = layoutModelRef.current;
          if (model) {
            const node = model.getNodeById("settings-tab");
            if (node) {
              model.doAction(Actions.selectTab("settings-tab"));
            } else {
              model.doAction(
                Actions.addTab(
                  {
                    type: "tab",
                    id: "settings-tab",
                    name: "Settings",
                    component: "settings",
                  },
                  "editor-tabset",
                  DockLocation.CENTER,
                  -1,
                ),
              );
            }
          }
          break;
        }
      }
    },
    [saveFile, closeTab],
  );

  const currentFile = activeFile ? openFiles.get(activeFile) : null;

  const menuItems: MenuGroup[] = [
    {
      label: "File",
      items: [
        { label: "Open Directory…", action: "open_folder", shortcut: "Ctrl+O" },
        { separator: true },
        {
          label: "Save",
          action: "save",
          shortcut: "Ctrl+S",
          enabled: activeFile !== null,
        },
        {
          label: "Save All",
          action: "save_all",
          shortcut: "Ctrl+Shift+S",
          enabled: dirtyFiles.size > 0,
        },
        { separator: true },
        {
          label: "Close Editor",
          action: "close_editor",
          shortcut: "Ctrl+W",
          enabled: activeFile !== null,
        },
      ],
    },
    {
      label: "Edit",
      items: [
        { label: "Undo", action: "undo", shortcut: "Ctrl+Z" },
        { label: "Redo", action: "redo", shortcut: "Ctrl+Shift+Z" },
        { separator: true },
        { label: "Cut", action: "cut", shortcut: "Ctrl+X" },
        { label: "Copy", action: "copy", shortcut: "Ctrl+C" },
        { label: "Paste", action: "paste", shortcut: "Ctrl+V" },
      ],
    },
    {
      label: "View",
      items: [
        { label: "Agent Chat", action: "chat", shortcut: "Ctrl+L" },
        { label: "Explorer", action: "explorer", shortcut: "Ctrl+Shift+E" },
        { label: "Search", action: "search", shortcut: "Ctrl+Shift+F" },
        {
          label: "Source Control",
          action: "source_control",
          shortcut: "Ctrl+Shift+G",
        },
        { label: "Terminal", action: "terminal", shortcut: "Ctrl+`" },
        { label: "Extensions", action: "extensions", shortcut: "Ctrl+Shift+X" },
        { label: "ACP Log", action: "rpc_log", shortcut: "Ctrl+Shift+R" },
        { separator: true },
        {
          label: "Toggle Sidebar",
          action: "toggle_sidebar",
          shortcut: "Ctrl+B",
        },
        {
          label: "Toggle Terminal",
          action: "toggle_terminal",
          shortcut: "Ctrl+`",
        },
        { separator: true },
        {
          label: wordWrap ? "Disable Word Wrap" : "Enable Word Wrap",
          action: "word_wrap",
          shortcut: "Alt+Z",
        },
      ],
    },
    {
      label: "Go",
      items: [
        { label: "Back", action: "back", shortcut: "Alt+Left" },
        { label: "Forward", action: "forward", shortcut: "Alt+Right" },
        { separator: true },
        { label: "Go to File…", action: "go_to_file", shortcut: "Ctrl+P" },
        { label: "Go to Line…", action: "go_to_line", shortcut: "Ctrl+G" },
      ],
    },
    {
      label: "Run",
      items: [
        { label: "Start Debugging", action: "start_debug", shortcut: "F5" },
        {
          label: "Run Without Debugging",
          action: "run_no_debug",
          shortcut: "Ctrl+F5",
        },
        { label: "Stop", action: "stop_debug", shortcut: "Shift+F5" },
      ],
    },
    {
      label: "Terminal",
      items: [
        {
          label: "New Terminal",
          action: "new_terminal",
          shortcut: "Ctrl+Shift+`",
        },
        {
          label: "Split Terminal",
          action: "split_terminal",
          shortcut: "Ctrl+Shift+5",
        },
      ],
    },
    {
      label: "Help",
      items: [
        { label: "Welcome", action: "welcome" },
        { label: "Documentation", action: "docs" },
        {
          label: "Keyboard Shortcuts",
          action: "shortcuts",
          shortcut: "Ctrl+K Ctrl+S",
        },
      ],
    },
  ];

  // Split tab — creates a new tabset next to the current one
  // Uses Actions.addNode with DockLocation.RIGHT/LEFT which auto-wraps in a new TabSetNode
  const splitTab = useCallback(
    (direction: "right" | "left" | "down" | "up", nodeId: string) => {
      const model = layoutModelRef.current;
      if (!model) return;
      const tabNode = model.getNodeById(nodeId);
      if (!tabNode || tabNode.getType() !== "tab") return;

      const tab = tabNode as TabNode;
      const tabset = tab.getParent();
      if (!tabset || tabset.getType() !== "tabset") return;

      const component = tab.getComponent();
      const tabName = tab.getName() || "Untitled";

      // Generate unique IDs
      const newTabId = `split-tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      // For chat tabs: create a NEW session, don't clone the existing one
      let newConfig: any = {};
      let newName = tabName;
      if (component === "chat") {
        const sessionId = `session-${Date.now()}`;
        if (workspaceRootRef.current) {
          acpStore.createSession(sessionId, agentConfigRef.current, workspaceRootRef.current);
        }
        newConfig = { sessionId };
        newName = "Agent Chat";
      } else {
        // For other tabs, clone the config
        newConfig = { ...(tab.getConfig() || {}) };
      }

      const newTabJson: any = {
        type: "tab",
        id: newTabId,
        name: newName,
        component,
        config: Object.keys(newConfig).length > 0 ? newConfig : undefined,
      };

      // Map direction to DockLocation — RIGHT/LEFT on a TabSetNode
      // will create a new TabSetNode split in that direction
      const dockLocation = direction === "right" || direction === "down"
        ? DockLocation.RIGHT
        : DockLocation.LEFT;

      // Add to the tabset (not the parent row). FlexLayout's drop() logic
      // for non-CENTER locations on a TabSetNode creates a new RowNode wrapper
      // and splits the layout properly.
      model.doAction(Actions.addNode(newTabJson, tabset.getId(), dockLocation, -1, true));
    },
    [workspaceRoot],
  );

  const closeTabNode = useCallback(
    (nodeId: string) => {
      const model = layoutModelRef.current;
      if (!model) return;
      const node = model.getNodeById(nodeId);
      if (!node) return;
      // For chat tabs, close the session too
      if (node.getType() === "tab") {
        const tabNode = node as TabNode;
        if (tabNode.getComponent() === "chat") {
          const config = tabNode.getConfig() || {};
          const sessionId = config.sessionId;
          if (sessionId) acpStore.closeSession(sessionId);
        }
      }
      model.doAction(Actions.deleteTab(nodeId));
    },
    [],
  );

  // ── FlexLayout factory ──────────────────────────────────────────────────

  const layoutFactory = (node: TabNode) => {
    const component = node.getComponent();

    switch (component) {
      case "editor": {
        const config = node.getConfig();
        const path = config?.path || "";
        const language = config?.language || "plaintext";
        return (
          <EditorPane
            key={path}
            path={path}
            language={language}
            isActive={node.isSelected()}
            wordWrap={wordWrap}
            onCursorChange={handleCursorChange}
            onDirtyChange={handleDirtyChange}
          />
        );
      }
      case "terminal": {
        const config = node.getConfig();
        const termId = config?.terminalId || "default";
        return (
          <TerminalPane
            key={termId}
            workspaceRoot={workspaceRoot || ""}
            terminalId={termId}
          />
        );
      }
      case "chat": {
        const config = node.getConfig() || {};
        const sessionId = config.sessionId || "chat-default";
        return (
          <ChatPane
            sessionId={sessionId}
            agentConfig={agentConfig}
            workspaceRoot={workspaceRoot}
            onClose={() => {
              acpStore.closeSession(sessionId);
              if (layoutModelRef.current) {
                layoutModelRef.current.doAction(
                  Actions.deleteTab(node.getId()),
                );
              }
            }}
            onFileChanged={(path, content) => {
              if (path && content) {
                try {
                  setModelContent(path, content, getLanguage(path));
                } catch {}
              }
            }}
          />
        );
      }
      case "explorer": {
        if (!workspaceRoot) {
          return (
            <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
              <div className="text-text-secondary mb-2">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-40">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <button
                className="flex items-center gap-2 px-4 py-2 bg-hover hover:bg-hover/80 border border-border rounded-md cursor-pointer font-medium text-[13px] text-text-primary transition-colors"
                onClick={() => setShowFolderPicker(true)}
              >
                Open Directory
              </button>
            </div>
          );
        }
        return <ExplorerPane root={workspaceRoot} onFileClick={handleFileClick} />;
      }
      case "welcome": {
        return (
          <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
            <div className="text-text-secondary mb-2">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-40">
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                <polyline points="13 2 13 9 20 9" />
              </svg>
            </div>
            <div className="text-text-secondary text-sm">No file open</div>
            <button
              className="flex items-center gap-2 px-4 py-2 bg-hover hover:bg-hover/80 border border-border rounded-md cursor-pointer font-medium text-[13px] text-text-primary transition-colors"
              onClick={() => setShowFolderPicker(true)}
            >
              Open Directory
            </button>
            <div className="text-[11px] text-text-secondary">
              or press <kbd className="px-1.5 py-0.5 bg-muted border border-border rounded text-[10px] font-mono">Ctrl+O</kbd>
            </div>
          </div>
        );
      }
      case "rpc":
        return <RpcLogPanel />;
      case "settings":
        return <SettingsPane />;
      default:
        return <div>Unknown component: {component}</div>;
    }
  };

  return (
    <div className="flex flex-col h-screen bg-transparent text-text-primary text-[13px] overflow-hidden font-sans relative antialiased selection:bg-violet-500/30 selection:text-white">
      <MenuBar
        items={menuItems}
        onAction={handleMenuAction}
        onOpenChange={setMenuOpen}
      />

      <div className="flex-1 overflow-hidden p-2 z-10 relative">
        {modelJson && layoutModelRef.current && (
          <Layout
            model={layoutModelRef.current}
            factory={layoutFactory}
            onModelChange={() => {
              const json = layoutModelRef.current?.toJson();
              if (json) saveLayout(json);
            }}
            onRenderTab={(node: TabNode, renderValues: ITabRenderValues) => {
              renderValues.leading = getTabIcon(node.getName());
              // Wrap tab content in a context menu trigger for right-click split
              const originalContent = renderValues.content;
              const nodeId = node.getId();
              renderValues.content = (
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <div
                      className="flex-1 h-full flex items-center min-w-0"
                      onContextMenu={(e) => e.stopPropagation()}
                    >
                      {originalContent}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuLabel className="text-[11px] text-text-secondary px-2 py-1">
                      Split Pane
                    </ContextMenuLabel>
                    <ContextMenuItem
                      onClick={() => splitTab("right", nodeId)}
                      className="gap-2"
                    >
                      <SquareSplitVertical className="w-3.5 h-3.5 rotate-90" />
                      Split Right
                    </ContextMenuItem>
                    <ContextMenuItem
                      onClick={() => splitTab("left", nodeId)}
                      className="gap-2"
                    >
                      <SquareSplitVertical className="w-3.5 h-3.5 -rotate-90" />
                      Split Left
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      onClick={() => closeTabNode(nodeId)}
                      className="gap-2 text-red-400 focus:text-red-400 focus:bg-red-500/10"
                    >
                      <X className="w-3.5 h-3.5" />
                      Close
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            }}
          />
        )}
      </div>

      <BottomBar
        active={activeActivity}
        onActivate={(id) => {
          if (id === "explorer") {
            toggleExplorer();
          }
          setActiveActivity(id);
        }}
        connected={connected}
        saving={saving}
        dirty={currentFile ? dirtyFiles.has(currentFile.path) : false}
        language={currentFile?.language || "plaintext"}
        line={cursorLine}
        col={cursorCol}
        encoding="UTF-8"
        lineEnding="LF"
        wordWrap={wordWrap}
        workspaceName={workspaceRoot?.split("/").pop() || ""}
        onToggleEditors={() => toggleMinimize("editor")}
        onToggleTerminals={() => toggleMinimize("terminal")}
        onToggleChats={() => toggleMinimize("chat")}
        editorsMinimized={findTabsetsByComponent("editor").every((id) => minimizedTabsets.has(id)) && findTabsetsByComponent("editor").length > 0}
        terminalsMinimized={findTabsetsByComponent("terminal").every((id) => minimizedTabsets.has(id)) && findTabsetsByComponent("terminal").length > 0}
        chatsMinimized={findTabsetsByComponent("chat").every((id) => minimizedTabsets.has(id)) && findTabsetsByComponent("chat").length > 0}
        explorerVisible={explorerVisible}
        editorTileCount={countMinimizedTabs("editor")}
        terminalTileCount={countMinimizedTabs("terminal")}
        chatTileCount={countMinimizedTabs("chat")}
      />

      <FolderPicker
        open={showFolderPicker}
        initialPath="/home/thomas"
        onSelect={handleOpenFolder}
        onClose={() => setShowFolderPicker(false)}
      />
    </div>
  );
}


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

const kbdStyle: React.CSSProperties = {
  padding: "2px 6px",
  background: "var(--color-surface-elevated)",
  border: "1px solid var(--color-border)",
  borderRadius: 3,
  fontSize: 11,
  fontFamily: "monospace",
  color: "var(--color-success)",
};
