/** Chat tile — tabbed container for ACP chat sessions, lives inside mosaic tiles */
import { useState, useCallback, useEffect, useRef, memo } from "react";
import * as acpStore from "../lib/acp-store";
import type { AgentConfig } from "../lib/acp-client";
import ChatSessionBody from "./ChatSessionBody";
export function registerTile(_id: string, _type: string) {}
export function unregisterTile(_id: string) {}
export function saveChatTileState(..._args: any[]) {}
export function getChatState(_id: string): any { return null; }

export interface ChatTab {
  tabId: string;
  sessionId: string | null;
  connected: boolean;
}

interface ChatTileProps {
  tileId: string;
  workspaceRoot: string | null;
  agentConfig: AgentConfig;
}

// ── Context Menu ──────────────────────────────────────────────────────────────
interface ContextMenuState {
  x: number;
  y: number;
  tileId: string;
  onClose: () => void;
}

const ContextMenu = function ContextMenu({
  x,
  y,
  tileId,
  onClose,
}: ContextMenuState) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  const handleAction = (action: string) => {
    onClose();
    window.dispatchEvent(
      new CustomEvent(action === "close-tile" ? "remove-tile" : "split-tile", {
        detail:
          action === "close-tile"
            ? { tileId }
            : { tileId, direction: action.replace("split-", "") },
      }),
    );
  };

  return (
    <div ref={menuRef} className="context-menu" style={{ left: x, top: y }}>
      <button
        className="context-menu-item"
        onClick={() => handleAction("split-right")}
      >
        <span>Split Right</span>
        <span className="shortcut">⊞→</span>
      </button>
      <button
        className="context-menu-item"
        onClick={() => handleAction("split-left")}
      >
        <span>Split Left</span>
        <span className="shortcut">⊞←</span>
      </button>
      <button
        className="context-menu-item"
        onClick={() => handleAction("split-down")}
      >
        <span>Split Down</span>
        <span className="shortcut">⊞↓</span>
      </button>
      <button
        className="context-menu-item"
        onClick={() => handleAction("split-up")}
      >
        <span>Split Up</span>
        <span className="shortcut">⊞↑</span>
      </button>
      <div className="context-menu-separator" />
      <button
        className="context-menu-item danger"
        onClick={() => handleAction("close-tile")}
      >
        <span>Close Pane</span>
        <span className="shortcut">✕</span>
      </button>
    </div>
  );
};

let chatTabCounter = 0;

const ChatTile = memo(function ChatTile({
  tileId,
  workspaceRoot,
  agentConfig,
}: ChatTileProps) {
  const [tabs, setTabs] = useState<ChatTab[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const workspaceRootRef = useRef(workspaceRoot);
  const agentConfigRef = useRef(agentConfig);

  useEffect(() => {
    workspaceRootRef.current = workspaceRoot;
    agentConfigRef.current = agentConfig;
  }, [workspaceRoot, agentConfig]);

  const sessionPrefix = `chat-${tileId}`;

  // ── Create a new disconnected tab ──────────────────────────────────────
  const createTab = useCallback(() => {
    if (!workspaceRootRef.current) return null;
    chatTabCounter++;
    const tabId = `${sessionPrefix}-${Date.now()}-${chatTabCounter}`;
    return { tabId, sessionId: null, connected: false } as ChatTab;
  }, [sessionPrefix]);

  // ── Restore state from registry on mount ──────────────────────────────
  useEffect(() => {
    registerTile(tileId, "chat");

    // Try to restore from registry (tile registry is populated by MosaicLayout on mount)
    const registryEntry = getChatState(tileId);
    if (registryEntry && registryEntry.tabIds && registryEntry.tabIds.length > 0) {
      // Restore persisted tabs — sessions are transient, start disconnected
      const restoredTabs = registryEntry.tabIds.map(
        (tabId: string) => ({ tabId, sessionId: null, connected: false } as ChatTab),
      );
      setTabs(restoredTabs);
      setActiveIndex(registryEntry.activeIndex ?? -1);
    } else {
      // No persisted state — create first disconnected tab
      const tab = createTab();
      if (tab) {
        setTabs([tab]);
        setActiveIndex(0);
        saveChatTileState(tileId, [tab.tabId], 0);
      }
    }

    return () => {}; // Don't unregister on unmount — registry persists across remounts
  }, [tileId, createTab]);

  // ── Persist tab changes to registry + SQLite ──────────────────────────
  useEffect(() => {
    if (tabs.length > 0) {
      saveChatTileState(
        tileId,
        tabs.map((t) => t.tabId),
        activeIndex,
      );
    }
  }, [tabs, activeIndex, tileId]);

  // ── Start a session (connect client) ──────────────────────────────────
  const startSession = useCallback(async (tabId: string) => {
    if (!workspaceRootRef.current) return;
    const tab = tabs.find((t) => t.tabId === tabId);
    if (!tab || tab.connected) return;
    try {
      const sessionId = await acpStore.createSession(
        agentConfigRef.current,
        workspaceRootRef.current,
      );
      setTabs((prev) =>
        prev.map((t) =>
          t.tabId === tabId ? { ...t, sessionId, connected: true } : t,
        ),
      );
    } catch (err) {
      console.error(`[ChatTile] Failed to start session for ${tabId}:`, err);
    }
  }, [tabs]);

  // ── Close a session ───────────────────────────────────────────────────
  const closeSession = useCallback((tabId: string) => {
    const tab = tabs.find((t) => t.tabId === tabId);
    if (tab?.sessionId) {
      acpStore.closeSession(tab.sessionId);
    }
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.tabId === tabId);
      const next = prev.filter((t) => t.tabId !== tabId);
      if (next.length === 0) {
        window.dispatchEvent(
          new CustomEvent("remove-tile", { detail: { tileId } }),
        );
      }
      setActiveIndex((ai) => {
        if (next.length === 0) return -1;
        if (ai === idx) return Math.max(0, next.length - 1);
        if (ai > idx) return ai - 1;
        return ai;
      });
      return next;
    });
  }, [tileId, tabs]);

  const activeTab = activeIndex >= 0 ? tabs[activeIndex] : null;

  return (
    <div
      className="flex flex-col h-full bg-[var(--color-background-dark)]"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          tileId,
          onClose: () => setContextMenu(null),
        });
      }}
    >
      {/* Tab bar — VS Code style: clean, minimal, no clutter */}
      {tabs.length > 0 && (
        <div className="flex bg-[var(--color-background-dark)] border-b border-[var(--color-border)] overflow-x-auto shrink-0" style={{ height: 35 }}>
          {tabs.map((tab, idx) => {
            const isActive = idx === activeIndex;
            const session = tab.sessionId ? acpStore.getSession(tab.sessionId) : null;
            const label =
              session?.sessionInfo?.initResponse?.agentInfo?.title ||
              session?.agentConfig?.name ||
              "Agent";
            const isConnected = tab.connected && session?.status === "ready";

            return (
              <div
                key={tab.tabId}
                className="group relative flex items-center gap-2 px-3 text-[13px] cursor-pointer select-none min-w-0 transition-colors"
                style={{
                  backgroundColor: isActive ? "var(--color-card)" : "transparent",
                  color: isActive ? "var(--color-foreground)" : "var(--color-foreground-dim)",
                  borderRight: "1px solid var(--color-border)",
                }}
                onClick={() => {
                  setActiveIndex(idx);
                  if (!isConnected) startSession(tab.tabId);
                }}
              >
                {/* Active indicator — thin colored line at top */}
                {isActive && (
                  <div className="absolute top-0 left-0 right-0 h-[1px] bg-[var(--color-primary)]" />
                )}

                {/* Status dot — subtle indicator */}
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  isConnected ? "bg-[var(--color-primary)]" : "bg-[var(--color-foreground-dim)]"
                }`} />

                {/* Agent name */}
                <span className="overflow-hidden text-ellipsis whitespace-nowrap flex-1">
                  {label}
                </span>

                {/* Close button — hover only */}
                <button
                  className="h-5 w-5 p-0 rounded-sm opacity-0 group-hover:opacity-100 text-[var(--color-foreground-dim)] hover:text-[var(--color-foreground)] hover:bg-[var(--color-border)] flex items-center justify-center flex-shrink-0 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSession(tab.tabId);
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="2.5" y1="2.5" x2="8.5" y2="8.5" />
                    <line x1="8.5" y1="2.5" x2="2.5" y2="8.5" />
                  </svg>
                </button>
              </div>
            );
          })}
          {/* New tab button — subtle, VS Code style */}
          <button
            className="flex items-center justify-center text-[var(--color-foreground-dim)] hover:text-[var(--color-foreground)] hover:bg-[var(--color-border)] transition-colors flex-shrink-0"
            style={{ width: 35, height: 35 }}
            onClick={() => {
              const tab = createTab();
              if (tab) {
                setTabs((prev) => [...prev, tab]);
                setActiveIndex(tabs.length);
              }
            }}
            title="New Agent Tab"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
      )}

      {/* Chat body */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        {activeTab?.sessionId ? (
          <div className="absolute inset-0">
            <ChatSessionBody sessionId={activeTab.sessionId} />
          </div>
        ) : activeTab ? (
          <div className="flex flex-col items-center justify-center h-full text-[var(--color-foreground-dim)] text-sm gap-3">
            <span>Disconnected — click tab to connect</span>
            <button
              className="px-3 py-1.5 rounded bg-[var(--color-primary)] text-white text-xs font-medium hover:opacity-90 transition-opacity"
              onClick={() => startSession(activeTab.tabId)}
            >
              Connect to Agent
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-[var(--color-foreground-dim)] text-sm">
            {workspaceRoot
              ? "No agent tab active"
              : "Open a directory to start a chat"}
          </div>
        )}
      </div>
      {contextMenu && <ContextMenu {...contextMenu} />}
    </div>
  );
});

export default ChatTile;
