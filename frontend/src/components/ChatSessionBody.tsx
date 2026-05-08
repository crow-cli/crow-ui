/** ChatSessionBody — messages + input for a single ACP session. No header, no chrome. */
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Streamdown } from "streamdown";
import { mermaid } from "@streamdown/mermaid";
import { math } from "@streamdown/math";
import { MarkdownCode } from "./MarkdownCode";
import "katex/dist/katex.min.css";
import { cn } from "../lib/utils";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./ui/accordion";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

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

interface ChatSessionBodyProps {
  sessionId: string;
  onFileChanged?: (path: string, content: string) => void;
}

// ─── ChatSessionBody ─────────────────────────────────────────────────────────

export default function ChatSessionBody({
  sessionId,
  onFileChanged,
}: ChatSessionBodyProps) {
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

  // Subscribe to THIS specific session
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

  // Extract content from a tool call
  function extractContentFromTool(tool: any): string | null {
    if (tool.rawOutput) {
      if (typeof tool.rawOutput === "string") return tool.rawOutput;
      if (tool.rawOutput.content) return tool.rawOutput.content;
      if (tool.rawOutput.output) return tool.rawOutput.output;
    }
    if (tool.content) {
      const textBlocks = tool.content
        .filter((c: any) => c.type === "content")
        .map((c: any) => c.content?.text || "")
        .join("\n");
      if (textBlocks) return textBlocks;
    }
    return null;
  }

  // Fetch file contents for tool calls
  useEffect(() => {
    const sessionNotes = notifications.filter(
      (n) => n.type === "session_notification",
    ) as GroupItem[];
    const groups = groupNotifications(sessionNotes);

    const client = acpStore.getClient(sessionId);
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

          if (!["read", "write", "edit"].includes(effectiveKind)) continue;

          const toolCallId = tool.toolCallId;
          if (fetchedFiles.has(toolCallId)) continue;

          const filePath = extractFilePath(tool);
          if (!filePath) continue;

          if (effectiveKind === "edit") {
            const beforeContent = getCachedFile(filePath);
            if (!beforeContent) {
              fetchFile(client, filePath, toolCallId, "read");
              continue;
            }
            client
              .wsInvoke("read_file", { path: filePath })
              .then((result: any) => {
                const afterContent = result.content as string;
                cacheFile(filePath, afterContent);
                setFetchedFiles((prev) => {
                  const next = new Map(prev);
                  next.set(toolCallId, {
                    path: filePath,
                    content: afterContent,
                    beforeContent,
                  });
                  return next;
                });
                if (onFileChanged) onFileChanged(filePath, afterContent);
              })
              .catch(() => {});
          } else if (effectiveKind === "read") {
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
              if (onFileChanged) onFileChanged(filePath, embeddedContent);
            } else {
              fetchFile(client, filePath, toolCallId, kind);
            }
          } else {
            fetchFile(client, filePath, toolCallId, kind);
          }
        }
      } catch {
        // ignore
      }
    }
  }, [notifications, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  function extractFilePath(tool: any): string | null {
    if (tool.content) {
      const diffContent = tool.content.find((c: any) => c.type === "diff");
      if (diffContent?.path) return diffContent.path;
    }

    const title = tool.title || "";
    const pathMatch = title.match(/(\/[\w./~-]+)/);
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
          cacheFile(filePath, content);
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
    try {
      await acpStore.prompt(sessionId, [{ type: "text", text: input.trim() }]);
      setInput("");
    } catch (err) {
      console.error("Prompt failed:", err);
    }
  }, [input, connectionStatus, sessionId]);

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
    [pendingPermission, sessionId],
  );

  const handleRejectPermission = useCallback(() => {
    if (pendingPermission) {
      pendingPermission.reject(new Error("Cancelled"));
      acpStore.getSession(sessionId).pendingPermission = null;
      setPendingPermission(null);
    }
  }, [pendingPermission, sessionId]);

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
    <div className="flex flex-col h-full bg-surface">
      {/* Connection bar */}
      {connectionStatus === "disconnected" && (
        <div className="px-3 py-1.5 bg-muted/30 border-b border-border/50 text-text-secondary text-xs flex items-center gap-2 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground" />
          Not connected — click a tab to start
        </div>
      )}

      {/* Permission bar */}
      {pendingPermission && (
        <div className="px-3 py-2 bg-hover/10 border-b border-border/50 shrink-0">
          <div className="text-xs font-semibold text-accent mb-1">
            Permission Request
          </div>
          {pendingPermission.request.toolCall?.title && (
            <div className="text-[11px] text-text-secondary mb-2">
              {pendingPermission.request.toolCall.title}
            </div>
          )}
          <div className="flex gap-1.5 flex-wrap">
            {pendingPermission.request.options?.map((opt: any) => (
              <Button
                key={opt.optionId}
                size="sm"
                variant={
                  opt.kind?.startsWith("allow") ? "default" : "destructive"
                }
                className="text-[11px] h-7 px-2.5"
                onClick={() =>
                  handleResolvePermission({
                    outcome: { outcome: "selected", optionId: opt.optionId },
                  })
                }
              >
                {opt.name}
              </Button>
            ))}
            <Button
              size="sm"
              variant="outline"
              className="text-[11px] h-7 px-2.5"
              onClick={handleRejectPermission}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="chat-messages flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2 min-h-0">
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
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <div className="px-3 pb-3 pt-2 shrink-0">
        <div className="flex items-end gap-2 bg-muted/30 border border-border/50 rounded-lg p-1.5 focus-within:border-accent/50 focus-within:ring-1 focus-within:ring-primary/20 transition-all">
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isReady
                ? `Ask ${sessionInfo?.agentDisplayName || "agent"}...`
                : statusLabel
            }
            disabled={!isReady}
            className="flex-1 bg-transparent border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 text-sm min-w-0 placeholder:text-text-secondary disabled:opacity-50"
          />
          {isStreaming ? (
            <Button
              size="icon"
              variant="ghost"
              onClick={handleCancel}
              className="flex-shrink-0 w-7 h-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
              title="Stop generation"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </Button>
          ) : (
            <Button
              size="icon"
              variant="ghost"
              onClick={handleSend}
              disabled={!isReady || !input.trim()}
              className="flex-shrink-0 w-7 h-7 disabled:opacity-30 text-text-secondary hover:text-accent hover:bg-hover/10"
              title="Send message"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components (message rendering)                                  */
/* ------------------------------------------------------------------ */

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
      <div className="flex justify-end">
        <Card className="max-w-[70%] px-3 py-2 rounded-xl rounded-br-sm border-accent/30 bg-hover/10">
          <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
            {text}
          </p>
        </Card>
      </div>
    );
  }

  if (stype === "agent_message_chunk") {
    const text = extractGroupText(group);
    if (!text) return null;
    return (
      <div className="max-w-[85%] text-sm leading-relaxed text-text-accent">
        <Streamdown
          plugins={{ mermaid, math }}
          isAnimating={isStreaming}
          components={{ code: MarkdownCode }}
        >
          {text}
        </Streamdown>
      </div>
    );
  }

  if (stype === "agent_thought_chunk") {
    const text = extractGroupText(group);
    if (!text) return null;
    return (
      <details open className="text-xs text-text-secondary opacity-70">
        <summary className="cursor-pointer select-none">Thinking</summary>
        <div className="mt-1 px-2 border-l-2 border-muted-foreground/30 pl-2 whitespace-pre-wrap text-xs">
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
      <div className="flex flex-col gap-1 max-w-[85%]">
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
  const status = tool.status || "in_progress";
  const kind = tool.kind || "";
  const title = tool.title || kind || "Tool call";
  const statusIcon =
    status === "completed" ? "✅" : status === "failed" ? "❌" : "⏳";

  const terminalContent = tool.content?.find((c: any) => c.type === "terminal");
  let terminalId = terminalContent?.terminalId;
  if (!terminalId) {
    terminalId = acpStore.getTerminalId(tool.toolCallId);
  }
  const commandLabel = tool.title || kind;

  const rawOutput = tool.rawOutput;
  const isWebFetch = kind === "fetch" || tool.toolName === "web_fetch";
  const isWebSearch = kind === "search" || tool.toolName === "web_search";

  let fileContent = fetchedFile?.content;
  const beforeContent = fetchedFile?.beforeContent;
  const filePath = fetchedFile?.path || title;

  if (!fileContent && rawOutput) {
    if (typeof rawOutput === "string") fileContent = rawOutput;
    else if (rawOutput.content) fileContent = rawOutput.content;
    else if (rawOutput.output) fileContent = rawOutput.output;
  }

  const fetchUrl = rawOutput?.url || tool.title || "";
  const fetchContent = rawOutput?.content || rawOutput?.markdown || "";

  const searchQuery = rawOutput?.query || tool.title || "";
  const searchResults = rawOutput?.results || rawOutput?.items || [];

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
  const isWrite = inferredKind === "write" || inferredKind === "create";
  const hasDiffContent = tool.content?.some((c: any) => c.type === "diff");
  const isEdit = inferredKind === "edit" || hasDiffContent;

  const statusVariant =
    status === "completed"
      ? "default"
      : status === "failed"
        ? "destructive"
        : "secondary";

  return (
    <Accordion type="single" defaultValue="tool" collapsible>
      <AccordionItem
        value="tool"
        className="border border-border/30 rounded-md overflow-hidden bg-background"
      >
        <AccordionTrigger className="px-3 py-2 text-xs hover:no-underline [&[data-state=open]>svg]:rotate-180">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-sm">{statusIcon}</span>
            <code className="font-mono text-[11px] text-text-accent truncate">
              {title}
            </code>
            <Badge
              variant={statusVariant}
              className="text-[10px] h-4 px-1.5 ml-auto shrink-0"
            >
              {status}
            </Badge>
          </div>
        </AccordionTrigger>
        <AccordionContent className="px-3 pb-3 pt-0 border-t border-border/30">
          {isTerminal && terminalId ? (
            <InlineTerminal
              terminalId={terminalId}
              commandLabel={commandLabel}
              exited={status === "completed" || status === "failed"}
            />
          ) : null}

          {isRead && fileContent && (
            <div>
              <div className="text-text-secondary mb-1 text-[10px] uppercase font-semibold flex items-center gap-1.5">
                <span>📄 Read</span>
                <code className="text-[11px] text-text-accent font-mono">
                  {filePath}
                </code>
              </div>
              <FileReadView content={fileContent} path={filePath} />
            </div>
          )}

          {isWrite && fileContent && (
            <div>
              <div className="text-text-secondary mb-1 text-[10px] uppercase font-semibold flex items-center gap-1.5">
                <span>✏️ Write</span>
                <code className="text-[11px] text-text-accent font-mono">
                  {filePath}
                </code>
              </div>
              <FileWriteView content={fileContent} path={filePath} />
            </div>
          )}

          {isEdit && fileContent && beforeContent && (
            <div>
              <div className="text-text-secondary mb-1 text-[10px] uppercase font-semibold flex items-center gap-1.5">
                <span>🔄 Diff</span>
                <code className="text-[11px] text-text-accent font-mono">
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

          {isWebFetch && fetchUrl && fetchContent && (
            <WebFetchView url={fetchUrl} content={fetchContent} />
          )}

          {isWebSearch &&
            Array.isArray(searchResults) &&
            searchResults.length > 0 && (
              <WebSearchView query={searchQuery} results={searchResults} />
            )}

          {!isTerminal &&
            !isRead &&
            !isWrite &&
            !isEdit &&
            !isWebFetch &&
            !isWebSearch &&
            tool.rawInput &&
            Object.keys(tool.rawInput).length > 0 && (
              <div className="mb-1.5">
                <div className="text-text-secondary mb-0.5 text-[10px] uppercase font-semibold">
                  Parameters
                </div>
                <pre className="m-0 whitespace-pre-wrap break-all text-text-secondary bg-muted/50 px-1.5 rounded text-[11px]">
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
                <div className="text-text-secondary mb-0.5 text-[10px] uppercase font-semibold">
                  Output
                </div>
                <pre className="m-0 whitespace-pre-wrap break-all text-text-secondary bg-muted/50 px-1.5 rounded text-[11px]">
                  {tool.rawOutput.output ??
                    JSON.stringify(tool.rawOutput, null, 2)}
                </pre>
              </div>
            )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
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
    <Card className="max-w-[85%] p-3 gap-2">
      <div className="text-[11px] font-semibold text-text-secondary mb-1">
        Tasks ({deduped.length})
      </div>
      {deduped.map((item: any, i: number) => (
        <div
          key={i}
          className={cn(
            "flex items-center gap-1.5 py-0.5 text-xs",
            item.status === "completed"
              ? "text-text-secondary"
              : "text-text-accent",
          )}
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
    </Card>
  );
}
