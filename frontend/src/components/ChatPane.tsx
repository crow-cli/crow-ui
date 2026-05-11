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
} from "../lib/acp-client";
import { groupNotifications, mergeToolCalls } from "../lib/acp-utils";
import * as acpStore from "../lib/acp-store";
import { getCachedFile, cacheFile } from "../lib/file-cache";
import { ws } from "../lib/ws-client";
import InlineTerminal from "./InlineTerminal";
import { FileReadView, FileWriteView, FileEditView } from "./FileViews";
import { WebFetchView, WebSearchView } from "./WebViews";
import MessageEditor from "./MessageEditor";

// ─── Types ──────────────────────────────────────────────────────────────────

type GroupedNotifications = ReturnType<typeof groupNotifications>;
type GroupItem = GroupedNotifications[number][number];

/** Cache for file contents used in diffs — kept for backward compat */

interface ChatPaneProps {
  sessionId: string;
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

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevNotifLen = useRef(0);

  // Sync from store
  useEffect(() => {
    const s = acpStore.getSession(sessionId);
    setNotifications(s.notifications);
    setConnectionStatus(s.status);
    setSessionInfo(s.sessionInfo);
    setPendingPermission(s.pendingPermission);

    const unsub = acpStore.subscribeToSession(sessionId, () => {
      const s2 = acpStore.getSession(sessionId);
      setNotifications(s2.notifications);
      setConnectionStatus(s2.status);
      setSessionInfo(s2.sessionInfo);
      setPendingPermission(s2.pendingPermission);
    });
    return unsub;
  }, [sessionId]);

  // ChatPane assumes the session already exists. Parent (App/ChatTile) must
  // create it before mounting or pass a sessionId that is already connected.

  // Close session on unmount (tab deleted)
  useEffect(() => {
    return () => {
      acpStore.closeSession(sessionId);
    };
  }, [sessionId]);

  // Auto-scroll on new notifications
  useEffect(() => {
    if (notifications.length > prevNotifLen.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevNotifLen.current = notifications.length;
  }, [notifications.length]);

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
              ws.invoke("read_file", { path: filePath })
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



  const handleSend = useCallback(
    async (blocks: ContentBlock[]) => {
      if (connectionStatus !== "ready") return;
      if (blocks.length === 0) return;
      try {
        await acpStore.prompt(sessionId, blocks);
      } catch (err) {
        console.error("Prompt failed:", err);
      }
    },
    [connectionStatus, sessionId],
  );

  const handleCancel = useCallback(async () => {
    try {
      await acpStore.cancel(sessionId);
    } catch (err) {
      console.error("Cancel failed:", err);
    }
  }, [sessionId]);

  const handleResolvePermission = useCallback(
    (response: any) => {
      if (pendingPermission) {
        pendingPermission.resolve(response);
        acpStore.getSession(sessionId).pendingPermission = null;
        setPendingPermission(null);
      }
    },
    [pendingPermission],
  );

  const handleRejectPermission = useCallback(() => {
    if (pendingPermission) {
      pendingPermission.reject(new Error("Cancelled"));
      acpStore.getSession(sessionId).pendingPermission = null;
      setPendingPermission(null);
    }
  }, [pendingPermission, sessionId]);

  const isReady = connectionStatus === "ready";
  const isStreaming =
    isReady &&
    notifications.some(
      (n) =>
        n.type === "session_notification" &&
        (n.data as any)?.update?.sessionUpdate === "agent_message_chunk",
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
      className="relative flex flex-col h-full min-w-0 text-text-primary text-[13px] overflow-hidden font-sans bg-transparent"
    >
      <div className="dot-overlay" />
      <Header
        statusLabel={statusLabel}
        isReady={isReady}
        isConnecting={connectionStatus === "connecting"}
        isStreaming={isStreaming}
        agentName={sessionInfo?.agentDisplayName || "agent"}
        onClose={onClose}
        onCancel={handleCancel}
      />

      {workspaceRoot && connectionStatus === "disconnected" && (
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
        data-testid="chat-messages"
        className="chat-messages flex-1 overflow-y-auto py-3 flex flex-col gap-2 min-h-0"
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
            isStreaming={isStreaming}
            isLast={idx === messageGroups.length - 1}
            fetchedFiles={fetchedFiles}
            sessionId={sessionId}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <MessageEditor
        workspaceRoot={workspaceRoot}
        disabled={!isReady}
        placeholder={
          isReady
            ? `Ask ${sessionInfo?.agentDisplayName || "agent"}...`
            : statusLabel
        }
        onSend={handleSend}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components (unchanged)                                          */
/* ------------------------------------------------------------------ */

function Header({
  statusLabel,
  isReady,
  isConnecting,
  isStreaming,
  agentName,
  onCancel,
  onClose,
}: {
  statusLabel: string;
  isReady: boolean;
  isConnecting: boolean;
  isStreaming: boolean;
  agentName: string;
  onCancel: () => void;
  onClose: () => void;
}) {
  const statusColor = isStreaming
    ? "bg-yellow-400"
    : isReady
      ? "bg-green-400"
      : isConnecting
        ? "bg-yellow-400"
        : "bg-red-400";

  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5 bg-zinc-950/40 backdrop-blur-md shrink-0">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${statusColor}`} />
        <span className="text-[13px] font-semibold">{agentName}</span>
        <span className="text-[11px] text-text-secondary">{statusLabel}</span>
      </div>
      <div className="flex items-center gap-2">
        {isStreaming && (
          <button
            onClick={onCancel}
            className="bg-destructive text-white text-[11px] font-semibold px-2 py-0.5 rounded cursor-pointer"
          >
            ⏹ Stop
          </button>
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
    <div className="px-3 py-1 bg-red-500/10 border-b border-border text-destructive text-xs flex items-center gap-2 shrink-0">
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
    <div className="px-3 py-2 bg-yellow-500/10 border-b border-border shrink-0">
      <div className="text-xs font-semibold text-yellow-400 mb-1">
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
            className={`px-2.5 py-0.5 text-[11px] rounded border border-border cursor-pointer font-medium ${
              opt.kind?.startsWith("allow")
                ? "bg-green-400/15 text-green-400"
                : "bg-red-400/15 text-red-400"
            }`}
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
  sessionId: string;
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
      <div className="inline-block max-w-[85%] rounded-lg border border-violet-500/20 bg-violet-500/10 px-4 py-2.5 font-mono text-[13px] leading-relaxed text-text-primary shadow-[0_0_12px_rgba(139,92,246,0.08)]">
        <Streamdown
          plugins={{ mermaid, math }}
          isAnimating={false}
          components={{ code: MarkdownCode }}
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
      <div className="text-[13px] leading-relaxed text-text-primary">
        <Streamdown
          plugins={{ mermaid, math }}
          isAnimating={isStreaming}
          components={{ code: MarkdownCode }}
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
      <details open className="text-xs text-text-secondary opacity-70">
        <summary className="cursor-pointer select-none">Thinking</summary>
        <div className="mt-1 border-l-2 border-text-secondary pl-3 whitespace-pre-wrap text-xs">
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
  sessionId: string;
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
  sessionId: string;
}) {
  const [open, setOpen] = useState(true);
  const status = tool.status || "in_progress";
  const kind = tool.kind || "";
  const title = tool.title || kind || "Tool call";
  const icon =
    status === "completed" ? "✅" : status === "failed" ? "❌" : "⏳";
  const borderColorClass =
    status === "completed"
      ? "border-green-400/20"
      : status === "failed"
        ? "border-red-400/20"
        : "border-yellow-400/20";

  // Extract terminal info from tool content (ACP spec: content array contains { type: "terminal", terminalId })
  const terminalContent = tool.content?.find((c: any) => c.type === "terminal");
  // Prefer terminalId from content block, fallback to tracked mapping
  let terminalId = terminalContent?.terminalId;
  if (!terminalId) {
    terminalId = acpStore.getTerminalId(tool.toolCallId, sessionId);
  }
  const commandLabel = tool.title || kind;
  const cwd =
    tool.rawInput?.cwd || acpStore.getSession(sessionId).cwd || undefined;

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
      className={`text-xs rounded-md overflow-hidden bg-surface border ${borderColorClass}`}
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
        <div className="px-2.5 py-2 border-t border-border text-[11px]">
          {/* Terminal view — show live output as it runs (ACP spec) */}
          {isTerminal && terminalId ? (
            <InlineTerminal
              terminalId={terminalId}
              commandLabel={commandLabel}
              cwd={
                tool.rawInput?.cwd ||
                acpStore.getSession(sessionId).cwd ||
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
