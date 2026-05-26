/**
 * Multi-session ACP store — backend owns sessions, frontend is a passive viewer.
 *
 * Each session has state and a notification stream populated by backend
 * session/update events over the main WebSocket.
 */

import type { ContentBlock } from "@agentclientprotocol/sdk";
import { ws } from "../lib/ws-client";
import type { AgentConfig, McpServerConfig } from "./acp-client";
import { getSetting } from "./settings";

// ─── Types ─────────────────────────────────────────────────────────────────

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "initializing"
  | "creating_session"
  | "ready";

/** Prompt turn lifecycle — backend is the source of truth. */
export type PromptTurnState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "complete"; stopReason: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export interface AcpNotification {
  id: string;
  type: "session_notification" | "connection_change" | "error";
  data: unknown;
}

export type { AgentConfig };

export interface SessionConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue?: string;
  options?: Array<{ name: string; description?: string; value: string }>;
}

export interface SessionInfo {
  sessionId: string;
  agentId: string;
  agentName: string;
  agentDisplayName: string;
  cwd: string;
  createdAt: string;
  initResponse?: any;
  modes?: any;
  models?: any;
  configOptions?: SessionConfigOption[];
  availableCommands?: any[];
}

// ─── Per-session state ─────────────────────────────────────────────────────

export interface QueuedItem {
  id: string;
  text: string;
  blocks: ContentBlock[];
}

interface SessionState {
  status: ConnectionStatus;
  promptTurnState: PromptTurnState;
  sessionInfo: SessionInfo | null;
  notifications: AcpNotification[];
  pendingPermission: {
    request: any;
    resolve: (r: any) => void;
    reject: (e: Error) => void;
  } | null;
  cwd: string;
  agentConfig: AgentConfig | null;
  queuedItems: QueuedItem[];
}

// ─── Global state ──────────────────────────────────────────────────────────

const sessions = new Map<string, SessionState>();
let defaultSessionId: string | null = null;

type SessionSubscriber = (state: SessionState) => void;
type MetaSubscriber = () => void;

const sessionSubscribers = new Map<string, Set<SessionSubscriber>>();
const metaSubscribers = new Set<MetaSubscriber>();

function notifySession(sessionId: string) {
  const state = sessions.get(sessionId);
  if (!state) return;
  const subs = sessionSubscribers.get(sessionId);
  if (subs) {
    for (const cb of subs) cb(state);
  }
  notifyMeta();
}

function notifyMeta() {
  for (const cb of metaSubscribers) cb();
}

function setSessionState(
  sessionId: string,
  partial: Partial<SessionState>,
): void {
  const state = sessions.get(sessionId);
  if (!state) return;
  Object.assign(state, partial);
  notifySession(sessionId);
}

// ─── Session lifecycle ─────────────────────────────────────────────────────

async function initialize(
  config: AgentConfig,
  cwd: string,
): Promise<string> {
  const sessionId = await createSession(config, cwd);
  defaultSessionId = sessionId;
  return sessionId;
}

export async function createSession(
  config: AgentConfig,
  cwd: string,
): Promise<string> {
  // Load MCP server definitions and filter to enabled ones for this agent
  const allMcpServers = await getSetting<McpServerConfig[]>("acp.mcpServers", []);
  const mcpServers = (allMcpServers || []).filter((mcp) =>
    config.mcpServerIds?.includes(mcp.name)
  );

  const response = await fetch("/api/acp/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: config.name,
      command: config.command,
      args: config.args || [],
      env: config.env || [],
      cwd,
      configFile: config.configFile || null,
      mcpServers,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }

  const result = await response.json();
  const sessionId = result.sessionId as string;

  if (sessions.has(sessionId)) {
    return sessionId;
  }

  const state: SessionState = {
    status: "ready",
    promptTurnState: { status: "idle" },
    sessionInfo: {
      sessionId,
      agentId: result.agentId || "",
      agentName: config.name,
      agentDisplayName: config.name,
      cwd,
      createdAt: new Date().toISOString(),
      configOptions: result.configOptions || undefined,
      modes: result.modes || undefined,
    },
    notifications: [],
    pendingPermission: null,
    cwd,
    agentConfig: config,
    queuedItems: [],
  };
  sessions.set(sessionId, state);

  if (!defaultSessionId) defaultSessionId = sessionId;
  notifyMeta();
  notifySession(sessionId);
  return sessionId;
}

export function closeSession(sessionId: string): void {
  sessions.delete(sessionId);
  sessionSubscribers.delete(sessionId);

  if (defaultSessionId === sessionId) {
    const remaining = Array.from(sessions.keys());
    defaultSessionId =
      remaining.length > 0 ? remaining[remaining.length - 1] : null;
  }
  notifyMeta();
}

function reconnect(config: AgentConfig, cwd: string) {
  if (defaultSessionId) {
    closeSession(defaultSessionId);
  }
  initialize(config, cwd);
}

export function clearNotifications(sessionId?: string) {
  const id = sessionId || defaultSessionId;
  if (id) {
    setSessionState(id, { notifications: [] });
  }
}

// ─── WebSocket event routing ───────────────────────────────────────────────

/** Called by ws-client when it receives an acp-session-event message. */
export function handleSessionEvent(sessionId: string, update: unknown) {
  const state = sessions.get(sessionId);
  if (!state) {
    console.warn(`[acp-store] handleSessionEvent: session ${sessionId} not found, dropping update`);
    return;
  }

  const innerUpdate = update as any;
  const sessionUpdate = innerUpdate?.sessionUpdate;

  // Backend-owned prompt lifecycle — update promptTurnState and do NOT
  // add these synthetic updates to the notification list (they're not chat messages).
  if (sessionUpdate === "prompt_state") {
    const status = innerUpdate?.status;
    if (status === "running") {
      setSessionState(sessionId, { promptTurnState: { status: "running" } });
    } else if (status === "idle") {
      setSessionState(sessionId, { promptTurnState: { status: "idle" } });
    }
    return;
  }

  if (sessionUpdate === "prompt_complete") {
    const stopReason = innerUpdate?.stopReason || "unknown";
    if (stopReason === "cancelled") {
      setSessionState(sessionId, { promptTurnState: { status: "cancelled" } });
    } else if (stopReason === "error") {
      setSessionState(sessionId, {
        promptTurnState: { status: "error", message: innerUpdate?.error || "unknown error" },
      });
    } else {
      setSessionState(sessionId, { promptTurnState: { status: "complete", stopReason } });
    }
    return;
  }

  // Backend-owned queue state — update local copy without adding to notifications.
  if (sessionUpdate === "queue_changed") {
    const items = innerUpdate?.items || [];
    setSessionState(sessionId, { queuedItems: items });
    return;
  }

  // Regular agent notification (chunk, tool call, plan, etc.) — append to list.
  const notification: AcpNotification = {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "session_notification",
    data: { update },
  };
  state.notifications = [...state.notifications, notification];
  notifySession(sessionId);
}

/** Called by ws-client when a session disconnects. */
export function handleSessionDisconnected(sessionId: string) {
  const state = sessions.get(sessionId);
  if (!state) return;
  state.status = "disconnected";
  notifySession(sessionId);
}

// ─── Subscriptions ─────────────────────────────────────────────────────────

export function subscribe(cb: (state: SessionState) => void): () => void {
  return subscribeToSession(defaultSessionId || "", cb);
}

export function subscribeToSession(
  sessionId: string,
  cb: (state: SessionState) => void,
): () => void {
  if (!sessionSubscribers.has(sessionId)) {
    sessionSubscribers.set(sessionId, new Set());
  }
  sessionSubscribers.get(sessionId)!.add(cb);
  const state = sessions.get(sessionId);
  if (state) cb(state);
  return () => {
    const subs = sessionSubscribers.get(sessionId);
    if (subs) subs.delete(cb);
  };
}

function subscribeToMeta(cb: MetaSubscriber): () => void {
  metaSubscribers.add(cb);
  return () => metaSubscribers.delete(cb);
}

// ─── Getters ───────────────────────────────────────────────────────────────

export function getState(): SessionState {
  return getSession(defaultSessionId || "");
}

export function getSession(sessionId: string): SessionState {
  return (
    sessions.get(sessionId) || {
      status: "disconnected",
      promptTurnState: { status: "idle" },
      sessionInfo: null,
      notifications: [],
      pendingPermission: null,
      cwd: "",
      agentConfig: null,
      queuedItems: [],
    }
  );
}

function getDefaultSessionId(): string | null {
  return defaultSessionId;
}

function getSessionIds(): string[] {
  return Array.from(sessions.keys());
}

/** Stub — backend handles ACP client directly. Returns null for backward compat. */
export function getClient(_sessionId?: string): any {
  return null;
}

/** Stub — backend tracks terminal IDs. Returns undefined for backward compat. */
export function getTerminalId(_toolCallId: string, _sessionId?: string): string | undefined {
  return undefined;
}

// ─── Actions ───────────────────────────────────────────────────────────────

export async function prompt(
  sessionId: string,
  blocks: ContentBlock[],
  behavior: "add_to_queue" | "skip_queue_and_run" | "cancel_all_and_run" = "add_to_queue",
) {
  const response = await fetch(
    `/api/acp/sessions/${encodeURIComponent(sessionId)}/prompt`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks, behavior }),
    },
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }
}

export async function cancel(sessionId: string) {
  const response = await fetch(
    `/api/acp/sessions/${encodeURIComponent(sessionId)}/cancel`,
    {
      method: "POST",
    },
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }
}

// ─── Queue management (backend-owned) ──────────────────────────────────────

async function getQueue(sessionId: string): Promise<QueuedItem[]> {
  const response = await fetch(
    `/api/acp/sessions/${encodeURIComponent(sessionId)}/queue`,
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.items || [];
}

async function queueAdd(
  sessionId: string,
  item: { id: string; text: string; blocks: ContentBlock[] },
) {
  const response = await fetch(
    `/api/acp/sessions/${encodeURIComponent(sessionId)}/queue`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", ...item }),
    },
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }
}

export async function queueRemove(sessionId: string, id: string) {
  const response = await fetch(
    `/api/acp/sessions/${encodeURIComponent(sessionId)}/queue`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove", id }),
    },
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }
}

async function queueUpdate(
  sessionId: string,
  id: string,
  text: string,
  blocks: ContentBlock[],
) {
  const response = await fetch(
    `/api/acp/sessions/${encodeURIComponent(sessionId)}/queue`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", id, text, blocks }),
    },
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }
}

async function queueClear(sessionId: string) {
  const response = await fetch(
    `/api/acp/sessions/${encodeURIComponent(sessionId)}/queue`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear" }),
    },
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }
}

async function queueReorder(sessionId: string, ids: string[]) {
  const response = await fetch(
    `/api/acp/sessions/${encodeURIComponent(sessionId)}/queue`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reorder", ids }),
    },
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `HTTP ${response.status}`);
  }
}

export async function setSessionConfigOption(
  sessionId: string,
  configId: string,
  value: string,
): Promise<SessionConfigOption[]> {
  const result = await ws.invoke<{ configOptions: SessionConfigOption[] }>(
    "set_session_config_option",
    { sessionId, configId, value },
  );
  // Update local state with the new config options
  const state = sessions.get(sessionId);
  if (state && state.sessionInfo) {
    state.sessionInfo.configOptions = result.configOptions;
    notifySession(sessionId);
  }
  return result.configOptions;
}
