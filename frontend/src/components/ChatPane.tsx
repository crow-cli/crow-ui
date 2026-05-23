import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Streamdown } from "streamdown";
import { mermaid } from "@streamdown/mermaid";
import { math } from "@streamdown/math";
import { MarkdownCode } from "./MarkdownCode";
import "katex/dist/katex.min.css";
import type { ContentBlock } from "@agentclientprotocol/sdk";

import {
  type AcpNotification,
  type ConnectionStatus,
  type SessionInfo,
  type AgentConfig,
  type PromptTurnState,
  type QueuedItem,
} from "../lib/acp-store";
import { groupNotifications, mergeToolCalls } from "../lib/acp-utils";
import * as acpStore from "../lib/acp-store";
import { getCachedFile, cacheFile } from "../lib/file-cache";
import { ws } from "../lib/ws-client";
import { fsApi } from "../lib/rpc";
import * as settings from "../lib/settings";
import InlineTerminal from "./InlineTerminal";
import { FileReadView, FileWriteView, FileEditView } from "./FileViews";
import { WebFetchView, WebSearchView } from "./WebViews";
import MessageEditor from "./MessageEditor";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────

type GroupedNotifications = ReturnType<typeof groupNotifications>;
type GroupItem = GroupedNotifications[number][number];

/** Cache for file contents used in diffs — kept for backward compat */

interface ChatPaneProps {
  sessionId?: string;
  agentConfig: AgentConfig;
  workspaceRoot: string | null;
  onClose: () => void;
  onFileChanged?: (path: string, content: string) => void;
}

// ─── ChatPane ────────────────────────────────────────────────────────────────

export default function ChatPane({
  sessionId,
  agentConfig,
  workspaceRoot,
  onClose,
  onFileChanged,
}: ChatPaneProps) {
  const [notifications, setNotifications] = useState<AcpNotification[]>([]);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("disconnected");
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [pendingPermission, setPendingPermission] = useState<{
    request: any;
    resolve: (r: any) => void;
    reject: (e: Error) => void;
  } | null>(null);
  const [fetchedFiles, setFetchedFiles] = useState<
    Map<string, { path: string; content: string; beforeContent?: string }>
  >(new Map());
  const [isConnectingLocal, setIsConnectingLocal] = useState(false);
  const [localSessionId, setLocalSessionId] = useState<string | undefined>(undefined);
  const [queuedItems, setQueuedItems] = useState<QueuedItem[]>([]);
  const [editingDraft, setEditingDraft] = useState<string | undefined>(undefined);
  const [promptTurnState, setPromptTurnState] = useState<PromptTurnState>({ status: "idle" });
  const [availableAgents, setAvailableAgents] = useState<AgentConfig[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const prevNotifLen = useRef(0);
  /** true = user has manually scrolled up, don't auto-scroll */
  const userScrolledUpRef = useRef(false);
  /** true = next scroll event came from our own programmatic scroll, ignore it */
  const isProgrammaticScrollRef = useRef(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const chatFontSize = settings.useWorkbenchFontSize("chat");

  const effectiveSessionId = sessionId || localSessionId;
  const activeSessionId = effectiveSessionId || "disconnected";

  // Load available agents from settings
  useEffect(() => {
    settings.getSetting<AgentConfig[]>("acp.agents", []).then((agents) => {
      if (agents && agents.length > 0) {
        setAvailableAgents(agents);
        setSelectedAgentId(agents[0].id || agents[0].name);
      } else {
        // Fallback to prop-provided agent
        setAvailableAgents([agentConfig]);
        setSelectedAgentId(agentConfig.id || agentConfig.name);
      }
    });
  }, [agentConfig]);

  // Sync from store
  useEffect(() => {
    const s = acpStore.getSession(activeSessionId);
    setNotifications(s.notifications);
    setConnectionStatus(s.status);
    setSessionInfo(s.sessionInfo);
    setPendingPermission(s.pendingPermission);
    setPromptTurnState(s.promptTurnState);
    setQueuedItems(s.queuedItems);

    const unsub = acpStore.subscribeToSession(activeSessionId, () => {
      const s2 = acpStore.getSession(activeSessionId);
      setNotifications(s2.notifications);
      setConnectionStatus(s2.status);
      setSessionInfo(s2.sessionInfo);
      setPendingPermission(s2.pendingPermission);
      setPromptTurnState(s2.promptTurnState);
      setQueuedItems(s2.queuedItems);
    });
    return unsub;
  }, [activeSessionId]);

  // Close session on unmount (tab deleted)
  useEffect(() => {
    return () => {
      if (effectiveSessionId) {
        acpStore.closeSession(effectiveSessionId);
      }
    };
  }, [effectiveSessionId]);

  // Track user scroll — only set scrolled-up flag from actual scroll events
  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) {
      isProgrammaticScrollRef.current = false;
      return;
    }
    const container = messagesContainerRef.current;
    if (!container) return;
    const threshold = 40;
    const atBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <=
      threshold;
    if (!atBottom && !userScrolledUpRef.current) {
      userScrolledUpRef.current = true;
      setShowJumpToBottom(true);
    } else if (atBottom && userScrolledUpRef.current) {
      userScrolledUpRef.current = false;
      setShowJumpToBottom(false);
    }
  }, []);

  // Auto-scroll on new notifications — only if user hasn't scrolled up
  useEffect(() => {
    if (notifications.length > prevNotifLen.current) {
      if (!userScrolledUpRef.current) {
        isProgrammaticScrollRef.current = true;
        messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
      } else {
        setShowJumpToBottom(true);
      }
    }
    prevNotifLen.current = notifications.length;
  }, [notifications.length]);

  // When async content grows (Monaco, xterm, images) and user hasn't scrolled up,
  // scroll to keep the bottom in view. Debounced so parallel Monaco editors
  // (which each measure on their own setTimeout) don't cause scroll jitter.
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const ro = new ResizeObserver(() => {
      if (userScrolledUpRef.current) return;
      if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);
      resizeDebounceRef.current = setTimeout(() => {
        resizeDebounceRef.current = null;
        if (!userScrolledUpRef.current) {
          isProgrammaticScrollRef.current = true;
          messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
        }
      }, 150);
    });

    ro.observe(container);
    return () => {
      ro.disconnect();
      if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);
    };
  }, []);

  const jumpToBottom = useCallback(() => {
    userScrolledUpRef.current = false;
    setShowJumpToBottom(false);
    isProgrammaticScrollRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
  }, []);

  // Extract content from a tool call — checks content blocks, rawOutput, and rawInput
  function extractContentFromTool(tool: any): string | null {
    // Check rawOutput (crow-cli puts file content here for read tool)
    if (tool.rawOutput) {
      if (typeof tool.rawOutput === "string") return tool.rawOutput;
      if (tool.rawOutput.content) return tool.rawOutput.content;
      if (tool.rawOutput.output) return tool.rawOutput.output;
    }
    // Check content blocks
    if (tool.content) {
      const textBlocks = tool.content
        .filter((c: any) => c.type === "content")
        .map((c: any) => c.content?.text || "")
        .join("\n");
      if (textBlocks) return textBlocks;
    }
    return null;
  }

  // Fetch file contents for read tool calls that don't embed content.
  // Write/edit tools send diff content blocks directly in ACP notifications.
  useEffect(() => {
    const sessionNotes = notifications.filter(
      (n) => n.type === "session_notification",
    ) as GroupItem[];
    const groups = groupNotifications(sessionNotes);

    for (const group of groups) {
      const updates = group
        .map((g: any) => g.data?.update)
        .filter(Boolean)
        .filter((u: any) => u.toolCallId);
      if (updates.length === 0) continue;

      try {
        const merged = mergeToolCalls(updates);
        for (const tool of merged) {
          const kind = tool.kind || "";
          const title = tool.title || "";
          const titleLower = title.toLowerCase();
          const effectiveKind =
            kind ||
            (titleLower.startsWith("read:")
              ? "read"
              : titleLower.startsWith("write:") ||
                  titleLower.startsWith("create:")
                ? "write"
                : titleLower.startsWith("edit:")
                  ? "edit"
                  : "");
          const status = tool.status || "";
          if (status !== "completed") continue;

          const toolCallId = tool.toolCallId;
          if (fetchedFiles.has(toolCallId)) continue;

          const filePath = extractFilePath(tool);
          if (!filePath) continue;

          // Only fetch for read tools without embedded content
          if (effectiveKind === "read") {
            const embeddedContent = extractContentFromTool(tool);
            if (embeddedContent) {
              cacheFile(filePath, embeddedContent);
              setFetchedFiles((prev) => {
                const next = new Map(prev);
                next.set(toolCallId, {
                  path: filePath,
                  content: embeddedContent,
                });
                return next;
              });
            } else {
              fsApi.readFile({ path: filePath })
                .then((result: any) => {
                  const content = result.content as string;
                  cacheFile(filePath, content);
                  setFetchedFiles((prev) => {
                    const next = new Map(prev);
                    next.set(toolCallId, { path: filePath, content });
                    return next;
                  });
                })
                .catch(() => {});
            }
          }
          // Write/edit: diff content is in tool.content directly
        }
      } catch {
        // mergeToolCalls failed, ignore
      }
    }
  }, [notifications]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Extract file path from a tool call — checks Diff content blocks first, then title */
  function extractFilePath(tool: any): string | null {
    // Check for Diff content blocks (edit tool sends type: "diff" with path)
    if (tool.content) {
      const diffContent = tool.content.find((c: any) => c.type === "diff");
      if (diffContent?.path) return diffContent.path;
    }

    const title = tool.title || "";
    const pathMatch = title.match(/[:\/]([\/\w.~-]+)/);
    if (pathMatch) return pathMatch[1];

    if (tool.content) {
      const text = tool.content
        .filter((c: any) => c.type === "content")
        .map((c: any) => c.content?.text || "")
        .join("");
      const fileMatch = text.match(/\/[\w./~-]+\.\w+/);
      if (fileMatch) return fileMatch[0];
    }
    return null;
  }



  const handleCancel = useCallback(async () => {
    if (!effectiveSessionId) return;
    try {
      await acpStore.cancel(effectiveSessionId);
    } catch (err) {
      console.error("Cancel failed:", err);
    }
  }, [effectiveSessionId]);

  const handleConnect = useCallback(async () => {
    if (!workspaceRoot) return;
    const agent = availableAgents.find((a) => (a.id || a.name) === selectedAgentId);
    if (!agent) return;
    setIsConnectingLocal(true);
    try {
      const sid = await acpStore.createSession(agent, workspaceRoot);
      setLocalSessionId(sid);
    } catch (err) {
      console.error("Connect failed:", err);
    } finally {
      setIsConnectingLocal(false);
    }
  }, [availableAgents, selectedAgentId, workspaceRoot]);

  const handleResolvePermission = useCallback(
    (response: any) => {
      if (pendingPermission) {
        pendingPermission.resolve(response);
        acpStore.getSession(sessionId || "").pendingPermission = null;
        setPendingPermission(null);
      }
    },
    [pendingPermission, sessionId],
  );

  const handleRejectPermission = useCallback(() => {
    if (pendingPermission) {
      pendingPermission.reject(new Error("Cancelled"));
      acpStore.getSession(sessionId || "").pendingPermission = null;
      setPendingPermission(null);
    }
  }, [pendingPermission, sessionId]);

  const isReady =
    connectionStatus === "ready" || connectionStatus === "connected";

  const isPromptRunning = promptTurnState.status === "running";

  const handleSend = useCallback(
    (blocks: ContentBlock[], _text?: string) => {
      if (!effectiveSessionId || connectionStatus !== "ready") return;
      if (blocks.length === 0) return;
      acpStore.prompt(effectiveSessionId, blocks, "add_to_queue").catch((err) => {
        console.error("Prompt failed:", err);
      });
    },
    [connectionStatus, effectiveSessionId],
  );

  const removeQueuedItem = useCallback(
    (id: string) => {
      if (!effectiveSessionId) return;
      acpStore.queueRemove(effectiveSessionId, id).catch((err) => {
        console.error("Queue remove failed:", err);
      });
    },
    [effectiveSessionId],
  );

  const editQueuedItem = useCallback(
    (id: string) => {
      const item = queuedItems.find((i) => i.id === id);
      if (!item) return;
      setEditingDraft(item.text);
      if (!effectiveSessionId) return;
      acpStore.queueRemove(effectiveSessionId, id).catch((err) => {
        console.error("Queue remove failed:", err);
      });
    },
    [queuedItems, effectiveSessionId],
  );

  const sendQueuedItemNow = useCallback(
    (id: string) => {
      const item = queuedItems.find((i) => i.id === id);
      if (!item || !effectiveSessionId) return;
      // Remove from queue first, then prompt with skip_queue_and_run
      acpStore
        .queueRemove(effectiveSessionId, id)
        .then(() => {
          return acpStore.prompt(
            effectiveSessionId,
            item.blocks,
            "skip_queue_and_run",
          );
        })
        .catch((err) => {
          console.error("Send now failed:", err);
        });
    },
    [queuedItems, effectiveSessionId],
  );



  const statusLabel = !workspaceRoot
    ? "Waiting for workspace..."
    : connectionStatus === "disconnected"
      ? "Disconnected"
      : connectionStatus === "connecting"
        ? "Connecting..."
        : connectionStatus === "initializing"
          ? "Initializing..."
          : connectionStatus === "creating_session"
            ? "Creating session..."
            : "Ready";

  const messageGroups: GroupedNotifications = useMemo(() => {
    const sessionNotes = notifications.filter(
      (n) => n.type === "session_notification",
    ) as GroupItem[];
    return groupNotifications(sessionNotes).filter((group) => {
      const update = (group[0].data as any)?.update;
      const stype = update?.sessionUpdate || update?.type;
      return (
        stype !== "available_commands_update" && stype !== "current_mode_update"
      );
    });
  }, [notifications]);

  return (
    <div
      data-testid="chat-pane"
      className="relative flex flex-col h-full min-w-0 text-text-primary overflow-hidden font-sans"
      style={{
        fontSize: chatFontSize,
        backgroundColor: `color-mix(in srgb, var(--theme-chat-bg) calc(var(--theme-chat-bg-opacity) * 100%), transparent)`,
      }}
    >
      <div className="dot-overlay" />
      <Header
        statusLabel={statusLabel}
        isReady={isReady}
        isConnecting={connectionStatus === "connecting" || isConnectingLocal}
        isStreaming={isPromptRunning}
        agentName={sessionInfo?.agentDisplayName || agentConfig.name || "agent"}
        sessionId={sessionInfo?.sessionId}
        hasSession={!!effectiveSessionId}
        onClose={onClose}
        onConnect={handleConnect}
        availableAgents={availableAgents}
        selectedAgentId={selectedAgentId}
        onSelectAgent={setSelectedAgentId}
      />

      {workspaceRoot && connectionStatus === "disconnected" && !sessionId && (
        <ConnectionBar />
      )}

      {pendingPermission && (
        <PermissionBar
          permission={pendingPermission.request}
          onResolve={handleResolvePermission}
          onReject={handleRejectPermission}
        />
      )}

      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        tabIndex={0}
        data-testid="chat-messages"
        className="chat-messages flex-1 overflow-y-auto py-3 flex flex-col gap-2 min-h-0 relative"
      >
        {messageGroups.length === 0 && (
          <div className="text-center text-text-secondary text-sm mt-10">
            {statusLabel}
          </div>
        )}
        {messageGroups.map((group, idx) => (
          <MessageGroup
            key={group[0].id}
            group={group}
            isStreaming={isPromptRunning}
            isLast={idx === messageGroups.length - 1}
            fetchedFiles={fetchedFiles}
            sessionId={effectiveSessionId}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Jump to bottom button */}
      {showJumpToBottom && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10">
          <Button
            variant="secondary"
            size="sm"
            className="text-[11px] shadow-lg bg-surface border border-border hover:bg-hover"
            onClick={jumpToBottom}
          >
            New messages ↓
          </Button>
        </div>
      )}

      {/* Queue management UI */}
      {queuedItems.length > 0 && (
        <QueueBar
          items={queuedItems}
          onRemove={removeQueuedItem}
          onEdit={editQueuedItem}
          onSendNow={sendQueuedItemNow}
        />
      )}

      {effectiveSessionId ? (
        <MessageEditor
          workspaceRoot={workspaceRoot}
          disabled={!isReady}
          isStreaming={isPromptRunning}
          placeholder={
            isReady
              ? `Ask ${sessionInfo?.agentDisplayName || agentConfig.name || "agent"}...`
              : statusLabel
          }
          queuedCount={queuedItems.length}
          configOptions={sessionInfo?.configOptions}
          draftText={editingDraft}
          onSend={handleSend}
          onCancel={handleCancel}
          onModelChange={(val) => {
            if (!effectiveSessionId) return;
            const modelConfig = sessionInfo?.configOptions?.find(
              (c) => c.category === "model" || c.id === "model",
            );
            if (!modelConfig) return;
            acpStore
              .setSessionConfigOption(effectiveSessionId, modelConfig.id, val)
              .catch((err) => console.error("Failed to change model:", err));
          }}
        />
      ) : (
        <div className="shrink-0 px-3 py-2 border-t text-center text-text-secondary text-xs"
          style={{ borderColor: "var(--theme-border)" }}
        >
          No session connected. Click <strong>Connect</strong> above to start an agent.
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

function extractBlocksText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[Image]" : "[File]"))
    .join("")
    .slice(0, 120);
}

function QueueBar({
  items,
  onRemove,
  onEdit,
  onSendNow,
}: {
  items: QueuedItem[];
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
  onSendNow: (id: string) => void;
}) {
  return (
    <div className="shrink-0 px-3 py-2 border-t border-border bg-surface flex flex-col gap-1.5">
      <div className="text-[11px] text-text-secondary font-medium">
        ⏳ Queued messages ({items.length})
      </div>
      <div className="flex flex-col gap-1">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-2 px-2 py-1 rounded text-[11px] bg-secondary border border-border"
          >
            <span className="flex-1 truncate text-text-secondary">
              {item.text || extractBlocksText(item.blocks) || "(empty)"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px] text-text-secondary hover:text-text-primary"
              onClick={() => onEdit(item.id)}
              title="Edit"
            >
              ✎
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px] text-accent hover:text-accent"
              onClick={() => onSendNow(item.id)}
              title="Send now"
            >
              ▶
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px] text-destructive hover:text-destructive"
              onClick={() => onRemove(item.id)}
              title="Remove"
            >
              ✕
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Header({
  statusLabel,
  isReady,
  isConnecting,
  isStreaming,
  agentName,
  sessionId,
  hasSession,
  onClose,
  onConnect,
  availableAgents,
  selectedAgentId,
  onSelectAgent,
}: {
  statusLabel: string;
  isReady: boolean;
  isConnecting: boolean;
  isStreaming: boolean;
  agentName: string;
  sessionId?: string;
  hasSession: boolean;
  onClose: () => void;
  onConnect: () => void;
  availableAgents: AgentConfig[];
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
}) {
  const statusColor = isStreaming
    ? "var(--theme-warning)"
    : isReady
      ? "var(--theme-success)"
      : isConnecting
        ? "var(--theme-warning)"
        : "var(--theme-destructive)";

  return (
    <div
      className="flex items-center justify-between px-3 py-1.5 border-b backdrop-blur-md shrink-0"
      style={{
        backgroundColor: "var(--theme-chat-header-bg)",
        borderColor: "var(--theme-border)",
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: statusColor }}
        />
        <span className="font-mono truncate">{sessionId || agentName}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {!hasSession && availableAgents.length > 0 && (
          <div className="flex items-center gap-1.5">
            {availableAgents.length > 1 && (
              <select
                value={selectedAgentId}
                onChange={(e) => onSelectAgent(e.target.value)}
                disabled={isConnecting}
                className="text-[11px] px-1.5 py-0.5 rounded border border-border cursor-pointer appearance-none pr-4 text-text-secondary bg-muted"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8'%3E%3Cpath fill='%23999' d='M0 2l4 4 4-4z'/%3E%3C/svg%3E")`,
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "right 4px center",
                }}
              >
                {availableAgents.map((a) => (
                  <option key={a.id || a.name} value={a.id || a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={onConnect}
              disabled={isConnecting}
              className="text-white text-[11px] font-semibold px-2 py-0.5 rounded cursor-pointer disabled:opacity-50"
              style={{ backgroundColor: "var(--theme-accent)" }}
            >
              {isConnecting ? "Connecting…" : "Connect"}
            </button>
          </div>
        )}
        <button
          onClick={onClose}
          className="bg-transparent border-none text-text-secondary hover:text-text-primary text-lg px-1 py-0.5 cursor-pointer"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function ConnectionBar() {
  return (
    <div
      className="px-3 py-1 border-b text-destructive text-xs flex items-center gap-2 shrink-0"
      style={{ backgroundColor: "var(--theme-destructive-10)" }}
    >
      <span>Disconnected</span>
    </div>
  );
}

function PermissionBar({
  permission,
  onResolve,
  onReject,
}: {
  permission: any;
  onResolve: (r: any) => void;
  onReject: () => void;
}) {
  return (
    <div
      className="px-3 py-2 border-b border-border shrink-0"
      style={{ backgroundColor: "var(--theme-warning-10)" }}
    >
      <div
        className="text-xs font-semibold mb-1"
        style={{ color: "var(--theme-warning)" }}
      >
        Permission Request
      </div>
      {permission.toolCall?.title && (
        <div className="text-[11px] text-text-secondary mb-1.5">
          {permission.toolCall.title}
        </div>
      )}
      <div className="flex gap-1.5 flex-wrap">
        {permission.options?.map((opt: any) => (
          <button
            key={opt.optionId}
            onClick={() =>
              onResolve({
                outcome: { outcome: "selected", optionId: opt.optionId },
              })
            }
            className="px-2.5 py-0.5 text-[11px] rounded border border-border cursor-pointer font-medium"
            style={
              opt.kind?.startsWith("allow")
                ? {
                    backgroundColor: "var(--theme-success-15)",
                    color: "var(--theme-success)",
                  }
                : {
                    backgroundColor: "var(--theme-destructive-15)",
                    color: "var(--theme-destructive)",
                  }
            }
          >
            {opt.name}
          </button>
        ))}
        <button
          onClick={onReject}
          className="px-2.5 py-0.5 text-[11px] rounded border border-border bg-transparent text-text-secondary cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function MessageGroup({
  group,
  isStreaming,
  isLast,
  fetchedFiles,
  sessionId,
}: {
  group: GroupItem[];
  isStreaming: boolean;
  isLast: boolean;
  fetchedFiles: Map<
    string,
    { path: string; content: string; beforeContent?: string }
  >;
  sessionId?: string;
}) {
  const update = (group[0].data as any)?.update;
  const stype = update?.sessionUpdate || update?.type;

  if (stype === "user_message_chunk") {
    const text = extractGroupText(group);
    if (!text) return null;
    return <UserMessage text={text} />;
  }

  if (stype === "agent_message_chunk") {
    const text = extractGroupText(group);
    if (!text) return null;
    return <AgentMessage text={text} isStreaming={isStreaming} />;
  }

  if (stype === "agent_thought_chunk") {
    const text = extractGroupText(group);
    if (!text) return null;
    return <ThinkingBlock text={text} />;
  }

  if (stype === "tool_call" || stype === "tool_call_update") {
    return (
      <ToolNotificationsBlock
        group={group}
        isLast={isLast}
        fetchedFiles={fetchedFiles}
        sessionId={sessionId}
      />
    );
  }

  if (stype === "plan") return <PlansBlock group={group} />;

  return null;
}

/* ── Message Components ─────────────────────────────────────────────── */

function Message({ children }: { children: React.ReactNode }) {
  return <div className="px-5 py-1">{children}</div>;
}

function UserMessage({ text }: { text: string }) {
  return (
    <Message>
      <div
        className="inline-block max-w-[85%] rounded-lg px-4 py-2.5 font-mono leading-relaxed text-text-primary"
        style={{
          backgroundColor: "var(--theme-accent-10)",
          border: "1px solid var(--theme-accent-20)",
          boxShadow: "0 0 12px var(--theme-accent-faint)",
        }}
      >
        <Streamdown
          plugins={{ mermaid, math }}
          isAnimating={false}
          components={{ code: MarkdownCode }}
          linkSafety={{ enabled: false }}
        >
          {text}
        </Streamdown>
      </div>
    </Message>
  );
}

function AgentMessage({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) {
  return (
    <Message>
      <div className="leading-relaxed text-text-primary">
        <Streamdown
          plugins={{ mermaid, math }}
          isAnimating={isStreaming}
          components={{ code: MarkdownCode }}
          linkSafety={{ enabled: false }}
        >
          {text}
        </Streamdown>
      </div>
    </Message>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  return (
    <Message>
      <details open className="text-text-secondary opacity-70">
        <summary className="cursor-pointer select-none">Thinking</summary>
        <div className="mt-1 border-l-2 border-text-secondary pl-3 whitespace-pre-wrap">
          {text}
        </div>
      </details>
    </Message>
  );
}

function extractGroupText(group: GroupItem[]): string {
  return group
    .map((g) => {
      const u = (g.data as any)?.update;
      const c = u?.content;
      return typeof c === "string" ? c : (c?.text ?? "");
    })
    .join("");
}

function ToolNotificationsBlock({
  group,
  isLast,
  fetchedFiles,
  sessionId,
}: {
  group: any[];
  isLast: boolean;
  fetchedFiles: Map<
    string,
    { path: string; content: string; beforeContent?: string }
  >;
  sessionId?: string;
}) {
  const updates = group.map((g) => g.data?.update).filter(Boolean);
  const validUpdates = updates.filter((u: any) => u.toolCallId);
  if (validUpdates.length === 0) return null;

  try {
    const toolCalls = mergeToolCalls(validUpdates);
    return (
      <Message>
        <div className="flex flex-col gap-1 max-w-[85%]">
          {toolCalls.map((tc) => (
            <ToolCallAccordion
              key={tc.toolCallId}
              tool={tc}
              isLast={isLast}
              fetchedFile={fetchedFiles.get(tc.toolCallId)}
              sessionId={sessionId}
            />
          ))}
        </div>
      </Message>
    );
  } catch {
    return null;
  }
}

function ToolCallAccordion({
  tool,
  isLast,
  fetchedFile,
  sessionId,
}: {
  tool: any;
  isLast: boolean;
  fetchedFile?: { path: string; content: string; beforeContent?: string };
  sessionId?: string;
}) {
  const [open, setOpen] = useState(true);
  const status = tool.status || "in_progress";
  const kind = tool.kind || "";
  const title = tool.title || kind || "Tool call";
  const icon =
    status === "completed" ? "✅" : status === "failed" ? "❌" : "⏳";
  const borderColor =
    status === "completed"
      ? "var(--theme-success-10)"
      : status === "failed"
        ? "var(--theme-destructive-10)"
        : "var(--theme-warning-10)";

  // Extract terminal info from tool content (ACP spec: content array contains { type: "terminal", terminalId })
  const terminalContent = tool.content?.find((c: any) => c.type === "terminal");
  // Prefer terminalId from content block, fallback to tracked mapping
  let terminalId = terminalContent?.terminalId;
  if (!terminalId) {
    terminalId = acpStore.getTerminalId(tool.toolCallId, sessionId);
  }
  const commandLabel = tool.title || kind;
  const cwd =
    tool.rawInput?.cwd || acpStore.getSession(sessionId || "").cwd || undefined;

  // Extract web fetch info
  const rawOutput = tool.rawOutput;
  const isWebFetch = kind === "fetch" || tool.toolName === "web_fetch";
  const isWebSearch = kind === "search" || tool.toolName === "web_search";

  // Extract diff content directly from ACP notification (write/edit tools)
  const diffContent = tool.content?.find((c: any) => c.type === "diff");
  const oldTextValue = diffContent?.oldText ?? diffContent?.old_text ?? undefined;
  const hasOldTextContent =
    oldTextValue !== undefined && oldTextValue !== null && oldTextValue !== "";
  const diffNewText = diffContent?.newText ?? diffContent?.new_text ?? "";
  const diffPath = diffContent?.path ?? "";

  // Extract file info — prefer diff content (for write/edit), then fetchedFile, then rawOutput
  let fileContent = diffNewText || fetchedFile?.content;
  let beforeContent =
    oldTextValue !== undefined ? oldTextValue : fetchedFile?.beforeContent;
  const filePath = diffPath || fetchedFile?.path || title;

  // For read tool calls, content may be in rawOutput (crow-cli embeds it there)
  if (!fileContent && rawOutput) {
    if (typeof rawOutput === "string") fileContent = rawOutput;
    else if (rawOutput.content) fileContent = rawOutput.content;
    else if (rawOutput.output) fileContent = rawOutput.output;
  }

  // Extract web fetch URL and content
  const fetchUrl = rawOutput?.url || tool.title || "";
  const fetchContent = rawOutput?.content || rawOutput?.markdown || "";

  // Extract web search results
  const searchQuery = rawOutput?.query || tool.title || "";
  const searchResults = rawOutput?.results || rawOutput?.items || [];

  // Determine which view to render — fallback to title prefix if kind is missing
  const titleLower = title.toLowerCase();
  const inferredKind =
    kind ||
    (titleLower.startsWith("read:")
      ? "read"
      : titleLower.startsWith("write:") || titleLower.startsWith("create:")
        ? "write"
        : titleLower.startsWith("edit:")
          ? "edit"
          : titleLower.startsWith("fetch:")
            ? "fetch"
            : titleLower.startsWith("search:")
              ? "search"
              : titleLower.startsWith("run:") ||
                  titleLower.startsWith("exec:") ||
                  titleLower.startsWith("terminal:") ||
                  titleLower.startsWith("command:")
                ? "execute"
                : "");
  const isTerminal =
    (inferredKind === "execute" || kind === "execute") && terminalId;
  const isRead = inferredKind === "read";
  const hasDiffContent = tool.content?.some((c: any) => c.type === "diff");
  const isWrite =
    inferredKind === "write" ||
    inferredKind === "create" ||
    (hasDiffContent && !hasOldTextContent);
  const isEdit =
    (inferredKind === "edit" && hasOldTextContent) ||
    (hasDiffContent && hasOldTextContent);

  return (
    <div
      className="text-xs rounded-md overflow-hidden bg-surface border"
      style={{ borderColor }}
    >
      <div
        onClick={() => setOpen(!open)}
        className="px-2.5 py-1 flex items-center gap-1.5 cursor-pointer select-none"
      >
        <span>{icon}</span>
        <code className="flex-1 text-[11px] font-mono text-text-primary truncate">
          {isTerminal ? cwd || title : title}
        </code>
        <span className="text-[10px] text-text-secondary select-none">
          {open ? "▾" : "▸"}
        </span>
      </div>
      {open && (
        <div className="px-2.5 py-2 border-t border-border text-[11px] animate-in fade-in duration-150">
          {/* Terminal view — show live output as it runs (ACP spec) */}
          {isTerminal && terminalId ? (
            <InlineTerminal
              terminalId={terminalId}
              commandLabel={commandLabel}
              cwd={
                tool.rawInput?.cwd ||
                acpStore.getSession(sessionId || "").cwd ||
                undefined
              }
              exited={status === "completed" || status === "failed"}
              sessionId={sessionId}
            />
          ) : null}

          {/* File read view */}
          {isRead && fileContent && (
            <div>
              <div className="text-text-muted mb-1 text-[10px] uppercase font-semibold flex items-center gap-1.5">
                <span>📄 Read</span>
                <code className="text-[11px] text-text-primary font-mono">
                  {filePath}
                </code>
              </div>
              <FileReadView content={fileContent} path={filePath} />
            </div>
          )}

          {/* File write view */}
          {isWrite && fileContent && (
            <div>
              <div className="text-text-muted mb-1 text-[10px] uppercase font-semibold flex items-center gap-1.5">
                <span>✏️ Write</span>
                <code className="text-[11px] text-text-primary font-mono">
                  {filePath}
                </code>
              </div>
              {beforeContent && beforeContent !== fileContent ? (
                <FileEditView
                  beforeContent={beforeContent}
                  afterContent={fileContent}
                  path={filePath}
                />
              ) : (
                <FileWriteView content={fileContent} path={filePath} />
              )}
            </div>
          )}

          {/* File edit view */}
          {isEdit && fileContent && beforeContent && (
            <div>
              <div className="text-text-muted mb-1 text-[10px] uppercase font-semibold flex items-center gap-1.5">
                <span>🔄 Diff</span>
                <code className="text-[11px] text-text-primary font-mono">
                  {filePath}
                </code>
              </div>
              <FileEditView
                beforeContent={beforeContent}
                afterContent={fileContent}
                path={filePath}
              />
            </div>
          )}

          {/* Web fetch view */}
          {isWebFetch && fetchUrl && fetchContent && (
            <WebFetchView url={fetchUrl} content={fetchContent} />
          )}

          {/* Web search view */}
          {isWebSearch &&
            Array.isArray(searchResults) &&
            searchResults.length > 0 && (
              <WebSearchView query={searchQuery} results={searchResults} />
            )}

          {/* Fallback: show rawInput / rawOutput */}
          {!isTerminal &&
            !isRead &&
            !isWrite &&
            !isEdit &&
            !isWebFetch &&
            !isWebSearch &&
            tool.rawInput &&
            Object.keys(tool.rawInput).length > 0 && (
              <div className="mb-1.5">
                <div className="text-text-muted mb-0.5 text-[10px] uppercase font-semibold">
                  Parameters
                </div>
                <pre className="m-0 whitespace-pre-wrap break-all text-text-secondary bg-surface-elevated p-1.5 rounded text-[11px]">
                  {JSON.stringify(tool.rawInput, null, 2)}
                </pre>
              </div>
            )}
          {!isTerminal &&
            !isRead &&
            !isWrite &&
            !isEdit &&
            !isWebFetch &&
            !isWebSearch &&
            tool.rawOutput && (
              <div>
                <div className="text-text-muted mb-0.5 text-[10px] uppercase font-semibold">
                  Output
                </div>
                <pre className="m-0 whitespace-pre-wrap break-all text-text-secondary bg-surface-elevated p-1.5 rounded text-[11px]">
                  {tool.rawOutput.output ??
                    JSON.stringify(tool.rawOutput, null, 2)}
                </pre>
              </div>
            )}
        </div>
      )}
    </div>
  );
}

function PlansBlock({ group }: { group: any[] }) {
  const plans = group
    .flatMap((g) => (g.data as any)?.update?.entries || [])
    .filter(Boolean);
  const seen = new Set<string>();
  const deduped = plans.filter((p: any) => {
    const key = p.content || p.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (deduped.length === 0) return null;

  return (
    <Message>
      <div className="max-w-[85%] text-xs rounded-md border border-border p-2 bg-surface">
        <div className="text-[11px] font-semibold text-text-secondary mb-1">
          Tasks ({deduped.length})
        </div>
        {deduped.map((item: any, i: number) => (
          <div
            key={i}
            className={`flex items-center gap-1.5 py-0.5 text-xs ${
              item.status === "completed"
                ? "text-text-secondary"
                : "text-text-primary"
            }`}
          >
            <span className="text-[10px]">
              {item.status === "completed"
                ? "✅"
                : item.status === "in_progress"
                  ? "🔄"
                  : "⬜"}
            </span>
            <span
              className={
                item.status === "completed" ? "line-through opacity-50" : ""
              }
            >
              {item.content || item.title || item.description}
            </span>
          </div>
        ))}
      </div>
    </Message>
  );
}
