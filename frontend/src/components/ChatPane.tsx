import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { math } from "@streamdown/math";
import "katex/dist/katex.min.css";

import {
  type AcpNotification,
  type ConnectionStatus,
  type SessionInfo,
} from "../lib/acp-client";
import { groupNotifications, mergeToolCalls } from "../lib/acp-utils";
import * as acpStore from "../lib/acp-store";
import { getCachedFile, cacheFile } from "../lib/file-cache";
import InlineTerminal from "./InlineTerminal";
import { FileReadView, FileWriteView, FileEditView } from "./FileViews";
import { WebFetchView, WebSearchView } from "./WebViews";

// ─── Types ──────────────────────────────────────────────────────────────────

type GroupedNotifications = ReturnType<typeof groupNotifications>;
type GroupItem = GroupedNotifications[number][number];

/** Cache for file contents used in diffs — kept for backward compat */

interface ChatPaneProps {
  onClose: () => void;
  onFileChanged?: (path: string, content: string) => void;
}

// ─── ChatPane ────────────────────────────────────────────────────────────────

export default function ChatPane({ onClose, onFileChanged }: ChatPaneProps) {
  const [input, setInput] = useState("");
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
  const inputRef = useRef<HTMLInputElement>(null);
  const prevNotifLen = useRef(0);

  // Sync from store
  useEffect(() => {
    const s = acpStore.getState();
    setNotifications(s.notifications);
    setConnectionStatus(s.status);
    setSessionInfo(s.sessionInfo);
    setPendingPermission(s.pendingPermission);

    const unsub = acpStore.subscribe(() => {
      const s2 = acpStore.getState();
      setNotifications(s2.notifications);
      setConnectionStatus(s2.status);
      setSessionInfo(s2.sessionInfo);
      setPendingPermission(s2.pendingPermission);
    });
    return unsub;
  }, []);

  // Auto-scroll on new notifications
  useEffect(() => {
    if (notifications.length > prevNotifLen.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevNotifLen.current = notifications.length;
  }, [notifications.length]);

  useEffect(() => {
    if (connectionStatus === "ready")
      setTimeout(() => inputRef.current?.focus(), 50);
  }, [connectionStatus]);

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

  // Fetch file contents for tool calls. Uses the frontend file cache for
  // "before" content on edits — the cache is populated by the ACP client's
  // readTextFile and writeTextFile handlers (which see full file content).
  useEffect(() => {
    const sessionNotes = notifications.filter(
      (n) => n.type === "session_notification",
    ) as GroupItem[];
    const groups = groupNotifications(sessionNotes);

    const client = acpStore.getClient(acpStore.getDefaultSessionId() ?? "");
    if (!client) return;

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
          // Infer kind from title prefix if not set
          const effectiveKind = kind ||
            (titleLower.startsWith("read:") ? "read" :
             titleLower.startsWith("write:") || titleLower.startsWith("create:") ? "write" :
             titleLower.startsWith("edit:") ? "edit" :
             "");
          const status = tool.status || "";
          if (status !== "completed") continue;
          if (!["read", "write", "edit"].includes(effectiveKind)) continue;

          const toolCallId = tool.toolCallId;
          if (fetchedFiles.has(toolCallId)) continue;

          const filePath = extractFilePath(tool);
          if (!filePath) continue;

          if (effectiveKind === "edit") {
            // For edits: use cached "before" content (from prior read/write),
            // then read current "after" from disk.
            const beforeContent = getCachedFile(filePath);
            if (!beforeContent) {
              // Never read this file before — can't render a proper diff.
              // Just fetch current content and show as read-only.
              fetchFile(client, filePath, toolCallId, "read");
              continue;
            }
            client.wsInvoke("read_file", { path: filePath })
              .then((result: any) => {
                const afterContent = result.content as string;
                cacheFile(filePath, afterContent); // update cache with post-edit content
                setFetchedFiles((prev) => {
                  const next = new Map(prev);
                  next.set(toolCallId, { path: filePath, content: afterContent, beforeContent });
                  return next;
                });
                if (onFileChanged) onFileChanged(filePath, afterContent);
              })
              .catch(() => {});
          } else if (effectiveKind === "read") {
            // Read tool: content may already be embedded in the tool call
            // (crow-cli returns file content directly). Extract it if present.
            const embeddedContent = extractContentFromTool(tool);
            if (embeddedContent) {
              cacheFile(filePath, embeddedContent);
              setFetchedFiles((prev) => {
                const next = new Map(prev);
                next.set(toolCallId, { path: filePath, content: embeddedContent });
                return next;
              });
              if (onFileChanged) onFileChanged(filePath, embeddedContent);
            } else {
              // Fallback: fetch from disk
              fetchFile(client, filePath, toolCallId, kind);
            }
          } else {
            // Write: fetch content from disk and cache it.
            fetchFile(client, filePath, toolCallId, kind);
          }
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

  const fetchFile = useCallback(
    (
      client: any,
      filePath: string,
      toolCallId: string,
      kind: string,
      beforeContent?: string,
    ) => {
      client
        .wsInvoke("read_file", { path: filePath })
        .then((result: any) => {
          const content = result.content as string;
          cacheFile(filePath, content); // populate cache for future diffs
          setFetchedFiles((prev) => {
            const next = new Map(prev);
            next.set(toolCallId, { path: filePath, content, beforeContent });
            return next;
          });
          if (onFileChanged) onFileChanged(filePath, content);
        })
        .catch(() => {});
    },
    [onFileChanged],
  );

  const handleSend = useCallback(async () => {
    if (!input.trim() || connectionStatus !== "ready") return;
    const client = acpStore.getClient(acpStore.getDefaultSessionId() ?? "");
    if (!client) return;
    const text = input.trim();
    setInput("");
    try {
      await client.prompt(text);
    } catch (err) {
      console.error("Prompt failed:", err);
    }
  }, [input, connectionStatus]);

  const handleCancel = useCallback(async () => {
    const client = acpStore.getClient(acpStore.getDefaultSessionId() ?? "");
    if (!client) return;
    try {
      await client.cancel();
    } catch (err) {
      console.error("Cancel failed:", err);
    }
  }, []);

  const handleResolvePermission = useCallback(
    (response: any) => {
      if (pendingPermission) {
        pendingPermission.resolve(response);
        acpStore.getState().pendingPermission = null;
        setPendingPermission(null);
      }
    },
    [pendingPermission],
  );

  const handleRejectPermission = useCallback(() => {
    if (pendingPermission) {
      pendingPermission.reject(new Error("Cancelled"));
      acpStore.getState().pendingPermission = null;
      setPendingPermission(null);
    }
  }, [pendingPermission]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isReady = connectionStatus === "ready";
  const isStreaming =
    isReady &&
    notifications.some(
      (n) =>
        n.type === "session_notification" &&
        (n.data as any)?.update?.sessionUpdate === "agent_message_chunk",
    );

  const statusLabel =
    connectionStatus === "disconnected"
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
    <div style={styles.root}>
      <Header
        statusLabel={statusLabel}
        isReady={isReady}
        isConnecting={connectionStatus === "connecting"}
        isStreaming={isStreaming}
        agentName={sessionInfo?.agentDisplayName || "agent"}
        onClose={onClose}
        onCancel={handleCancel}
      />

      {connectionStatus === "disconnected" && <ConnectionBar />}

      {pendingPermission && (
        <PermissionBar
          permission={pendingPermission.request}
          onResolve={handleResolvePermission}
          onReject={handleRejectPermission}
        />
      )}

      <div className="chat-messages" style={styles.messages}>
        {messageGroups.length === 0 && (
          <div style={styles.emptyState}>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              {statusLabel}
            </div>
          </div>
        )}
        {messageGroups.map((group, idx) => (
          <MessageGroup
            key={group[0].id}
            group={group}
            isStreaming={isStreaming}
            isLast={idx === messageGroups.length - 1}
            fetchedFiles={fetchedFiles}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <InputBar
        input={input}
        setInput={setInput}
        onSend={handleSend}
        onKeyDown={handleKeyDown}
        disabled={!isReady}
        placeholder={
          isReady
            ? `Ask ${sessionInfo?.agentDisplayName || "agent"}...`
            : statusLabel
        }
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
  return (
    <div style={styles.header}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: isStreaming
              ? "var(--yellow)"
              : isReady
                ? "var(--green)"
                : isConnecting
                  ? "var(--yellow)"
                  : "var(--red)",
          }}
        />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{agentName}</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {statusLabel}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {isStreaming && (
          <button onClick={onCancel} style={styles.stopBtn}>
            ⏹ Stop
          </button>
        )}
        <button onClick={onClose} style={styles.closeBtn}>
          ✕
        </button>
      </div>
    </div>
  );
}

function ConnectionBar() {
  return (
    <div style={styles.connectionBar}>
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
    <div style={styles.permissionBar}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--yellow)",
          marginBottom: 4,
        }}
      >
        Permission Request
      </div>
      {permission.toolCall?.title && (
        <div
          style={{
            fontSize: 11,
            color: "var(--text-secondary)",
            marginBottom: 6,
          }}
        >
          {permission.toolCall.title}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {permission.options?.map((opt: any) => (
          <button
            key={opt.optionId}
            onClick={() =>
              onResolve({
                outcome: { outcome: "selected", optionId: opt.optionId },
              })
            }
            style={{
              padding: "2px 10px",
              fontSize: 11,
              borderRadius: 3,
              border: "1px solid var(--border)",
              background: opt.kind?.startsWith("allow")
                ? "rgba(166,227,161,0.15)"
                : "rgba(243,139,168,0.15)",
              color: opt.kind?.startsWith("allow")
                ? "var(--green)"
                : "var(--red)",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            {opt.name}
          </button>
        ))}
        <button
          onClick={onReject}
          style={{
            padding: "2px 10px",
            fontSize: 11,
            borderRadius: 3,
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--text-muted)",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function InputBar({
  input,
  setInput,
  onSend,
  onKeyDown,
  disabled,
  placeholder,
}: {
  input: string;
  setInput: (s: string) => void;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  disabled: boolean;
  placeholder: string;
}) {
  return (
    <div style={styles.inputBar}>
      <input
        ref={(el) => {
          if (el && !disabled) el.focus();
        }}
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        style={styles.input}
      />
      <button
        onClick={onSend}
        disabled={disabled || !input.trim()}
        style={{
          padding: "6px 16px",
          background:
            !disabled && input.trim() ? "var(--accent)" : "var(--bg-tertiary)",
          color:
            !disabled && input.trim()
              ? "var(--bg-hover)"
              : "var(--text-muted)",
          border: "none",
          borderRadius: 4,
          cursor: !disabled && input.trim() ? "pointer" : "default",
          fontWeight: 600,
          fontSize: 13,
        }}
      >
        Send
      </button>
    </div>
  );
}

function MessageGroup({
  group,
  isStreaming,
  isLast,
  fetchedFiles,
}: {
  group: GroupItem[];
  isStreaming: boolean;
  isLast: boolean;
  fetchedFiles: Map<
    string,
    { path: string; content: string; beforeContent?: string }
  >;
}) {
  const update = (group[0].data as any)?.update;
  const stype = update?.sessionUpdate || update?.type;

  if (stype === "user_message_chunk") {
    const text = extractGroupText(group);
    if (!text) return null;
    return (
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div
          style={{
            maxWidth: "70%",
            padding: "8px 12px",
            background: "var(--accent-bg)",
            borderRadius: "12px 12px 2px 12px",
            fontSize: 13,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "var(--text-accent)",
          }}
        >
          {text}
        </div>
      </div>
    );
  }

  if (stype === "agent_message_chunk") {
    const text = extractGroupText(group);
    if (!text) return null;
    return (
      <div
        style={{
          maxWidth: "85%",
          fontSize: 13,
          lineHeight: 1.6,
          color: "var(--text-accent)",
        }}
      >
        <Streamdown plugins={{ code, mermaid, math }} isAnimating={isStreaming}>
          {text}
        </Streamdown>
      </div>
    );
  }

  if (stype === "agent_thought_chunk") {
    const text = extractGroupText(group);
    if (!text) return null;
    return (
      <details
        open
        style={{ fontSize: 12, color: "var(--text-muted)", opacity: 0.7 }}
      >
        <summary
          style={{ cursor: "pointer", fontStyle: "italic", userSelect: "none" }}
        >
          💭 Thinking…
        </summary>
        <div
          style={{
            marginTop: 4,
            padding: "4px 8px",
            borderLeft: "2px solid var(--text-muted)",
            paddingLeft: 8,
            whiteSpace: "pre-wrap",
            fontSize: 12,
          }}
        >
          {text}
        </div>
      </details>
    );
  }

  if (stype === "tool_call" || stype === "tool_call_update") {
    return (
      <ToolNotificationsBlock
        group={group}
        isLast={isLast}
        fetchedFiles={fetchedFiles}
      />
    );
  }

  if (stype === "plan") return <PlansBlock group={group} />;

  return null;
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
}: {
  group: any[];
  isLast: boolean;
  fetchedFiles: Map<
    string,
    { path: string; content: string; beforeContent?: string }
  >;
}) {
  const updates = group.map((g) => g.data?.update).filter(Boolean);
  const validUpdates = updates.filter((u: any) => u.toolCallId);
  if (validUpdates.length === 0) return null;

  try {
    const toolCalls = mergeToolCalls(validUpdates);
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          maxWidth: "85%",
        }}
      >
        {toolCalls.map((tc) => (
          <ToolCallAccordion
            key={tc.toolCallId}
            tool={tc}
            isLast={isLast}
            fetchedFile={fetchedFiles.get(tc.toolCallId)}
          />
        ))}
      </div>
    );
  } catch {
    return null;
  }
}

function ToolCallAccordion({
  tool,
  isLast,
  fetchedFile,
}: {
  tool: any;
  isLast: boolean;
  fetchedFile?: { path: string; content: string; beforeContent?: string };
}) {
  const [open, setOpen] = useState(true);
  const status = tool.status || "in_progress";
  const kind = tool.kind || "";
  const title = tool.title || kind || "Tool call";
  const icon =
    status === "completed" ? "✅" : status === "failed" ? "❌" : "⏳";
  const borderColor =
    status === "completed"
      ? "var(--green)"
      : status === "failed"
        ? "var(--red)"
        : "var(--yellow)";

  // Extract terminal info from tool content (ACP spec: content array contains { type: "terminal", terminalId })
  const terminalContent = tool.content?.find((c: any) => c.type === "terminal");
  // Prefer terminalId from content block, fallback to tracked mapping
  let terminalId = terminalContent?.terminalId;
  if (!terminalId) {
    terminalId = acpStore.getTerminalId(tool.toolCallId);
  }
  const commandLabel = tool.title || kind;

  // Extract web fetch info
  const rawOutput = tool.rawOutput;
  const isWebFetch = kind === "fetch" || tool.toolName === "web_fetch";
  const isWebSearch = kind === "search" || tool.toolName === "web_search";

  // Extract file info — prefer fetchedFile (from async fetch), fall back to rawOutput
  let fileContent = fetchedFile?.content;
  const beforeContent = fetchedFile?.beforeContent;
  const filePath = fetchedFile?.path || title;

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
  const inferredKind = kind ||
    (titleLower.startsWith("read:") ? "read" :
     titleLower.startsWith("write:") || titleLower.startsWith("create:") ? "write" :
     titleLower.startsWith("edit:") ? "edit" :
     titleLower.startsWith("fetch:") ? "fetch" :
     titleLower.startsWith("search:") ? "search" :
     titleLower.startsWith("run:") || titleLower.startsWith("exec:") || titleLower.startsWith("terminal:") || titleLower.startsWith("command:") ? "execute" :
     "");
  const isTerminal = (inferredKind === "execute" || kind === "execute") && terminalId;
  const isRead = inferredKind === "read";
  const isWrite = inferredKind === "write" || inferredKind === "create";
  // Edit: either kind === "edit" OR has a Diff content block
  const hasDiffContent = tool.content?.some((c: any) => c.type === "diff");
  const isEdit = inferredKind === "edit" || hasDiffContent;

  return (
    <div
      style={{
        fontSize: 12,
        borderRadius: 6,
        border: `1px solid ${borderColor}33`,
        overflow: "hidden",
        background: "var(--bg-secondary)",
      }}
    >
      <div
        onClick={() => setOpen(!open)}
        style={{
          padding: "4px 10px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span>{icon}</span>
        <code
          style={{
            flex: 1,
            fontSize: 11,
            fontFamily: "var(--mono)",
            color: "var(--text-accent)",
          }}
        >
          {title}
        </code>
        <span
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            userSelect: "none",
          }}
        >
          {open ? "▾" : "▸"}
        </span>
      </div>
      {open && (
        <div
          style={{
            padding: "8px 10px",
            borderTop: "1px solid var(--border)",
            fontSize: 11,
          }}
        >
          {/* Terminal view — show live output as it runs (ACP spec) */}
          {isTerminal && terminalId ? (
            <InlineTerminal
              terminalId={terminalId}
              commandLabel={commandLabel}
              exited={status === "completed" || status === "failed"}
            />
          ) : null}

          {/* File read view */}
          {isRead && fileContent && (
            <div>
              <div style={viewHeaderStyle}>
                <span>📄 Read</span>
                <code style={filePathStyle}>{filePath}</code>
              </div>
              <FileReadView content={fileContent} path={filePath} />
            </div>
          )}

          {/* File write view */}
          {isWrite && fileContent && (
            <div>
              <div style={viewHeaderStyle}>
                <span>✏️ Write</span>
                <code style={filePathStyle}>{filePath}</code>
              </div>
              <FileWriteView content={fileContent} path={filePath} />
            </div>
          )}

          {/* File edit view */}
          {isEdit && fileContent && beforeContent && (
            <div>
              <div style={viewHeaderStyle}>
                <span>🔄 Diff</span>
                <code style={filePathStyle}>{filePath}</code>
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
          {isWebSearch && Array.isArray(searchResults) && searchResults.length > 0 && (
            <WebSearchView query={searchQuery} results={searchResults} />
          )}

          {/* Fallback: show rawInput / rawOutput */}
          {!isTerminal && !isRead && !isWrite && !isEdit && !isWebFetch && !isWebSearch &&
            tool.rawInput &&
            Object.keys(tool.rawInput).length > 0 && (
              <div style={{ marginBottom: 6 }}>
                <div style={outputLabelStyle}>Parameters</div>
                <pre style={preStyle}>
                  {JSON.stringify(tool.rawInput, null, 2)}
                </pre>
              </div>
            )}
          {!isTerminal && !isRead && !isWrite && !isEdit && !isWebFetch && !isWebSearch &&
            tool.rawOutput && (
              <div>
                <div style={outputLabelStyle}>Output</div>
                <pre style={preStyle}>
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
    <div
      style={{
        maxWidth: "85%",
        fontSize: 12,
        borderRadius: 6,
        border: "1px solid var(--border)",
        padding: 8,
        background: "var(--bg-secondary)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-muted)",
          marginBottom: 4,
        }}
      >
        Tasks ({deduped.length})
      </div>
      {deduped.map((item: any, i: number) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 4px",
            color:
              item.status === "completed"
                ? "var(--text-muted)"
                : "var(--text-accent)",
          }}
        >
          <span style={{ fontSize: 10 }}>
            {item.status === "completed"
              ? "✅"
              : item.status === "in_progress"
                ? "🔄"
                : "⬜"}
          </span>
          <span
            style={
              item.status === "completed"
                ? { textDecoration: "line-through", opacity: 0.5 }
                : {}
            }
          >
            {item.content || item.title || item.description}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Inline view styles ──────────────────────────────────────────────────────

const viewHeaderStyle: React.CSSProperties = {
  color: "var(--text-muted)",
  marginBottom: 4,
  fontSize: 10,
  textTransform: "uppercase",
  fontWeight: 600,
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const filePathStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-accent)",
  fontFamily: "var(--mono)",
};

const outputLabelStyle: React.CSSProperties = {
  color: "var(--text-muted)",
  marginBottom: 2,
  fontSize: 10,
  textTransform: "uppercase",
  fontWeight: 600,
};

const preStyle: React.CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  color: "var(--text-secondary)",
  background: "var(--bg-tertiary)",
  padding: 6,
  borderRadius: 4,
  fontSize: 11,
};

// ─── Colors + styles ─────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  root: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    background: "var(--color-background)",
    color: "var(--color-text-primary)",
    fontFamily:
      "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: 13,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 12px",
    borderBottom: "1px solid var(--color-border)",
    background: "var(--color-surface)",
    flexShrink: 0,
  },
  stopBtn: {
    background: "var(--color-destructive)",
    color: "white",
    border: "none",
    borderRadius: 4,
    padding: "2px 8px",
    fontSize: 11,
    cursor: "pointer",
    fontWeight: 600,
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: "var(--color-text-secondary)",
    cursor: "pointer",
    fontSize: 16,
    padding: "2px 4px",
  },
  connectionBar: {
    padding: "4px 12px",
    background: "rgba(248, 113, 113, 0.1)",
    borderBottom: "1px solid var(--color-border)",
    fontSize: 12,
    color: "var(--color-destructive)",
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  permissionBar: {
    padding: "8px 12px",
    background: "rgba(250, 204, 21, 0.1)",
    borderBottom: "1px solid var(--color-border)",
    flexShrink: 0,
  },
  messages: {
    flex: 1,
    overflowY: "auto",
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  emptyState: {
    textAlign: "center",
    color: "var(--color-text-secondary)",
    fontSize: 13,
    marginTop: 40,
  },
  inputBar: {
    padding: "8px 12px",
    borderTop: "1px solid var(--color-border)",
    display: "flex",
    gap: 8,
    flexShrink: 0,
  },
  input: {
    flex: 1,
    padding: "6px 10px",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 6,
    color: "var(--color-text-primary)",
    fontSize: 13,
    outline: "none",
  },
};

if (typeof document !== "undefined") {
  const root = document.documentElement;
  root.style.setProperty(
    "--mono",
    "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  );
}
