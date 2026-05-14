/**
 * Multi-session ACP store — backend owns sessions, frontend is a passive viewer.
 *
 * Each session has state and a notification stream populated by backend
 * session/update events over the main WebSocket.
 */

import type { ContentBlock } from "@agentclientprotocol/sdk";

// ─── Types ─────────────────────────────────────────────────────────────────

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "initializing"
  | "creating_session"
  | "ready";

export interface AcpNotification {
  id: string;
  type: "session_notification" | "connection_change" | "error";
  data: unknown;
}

export interface AgentConfig {
  name: string;
  command: string;
  args?: string[];
  env?: string[];
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
  availableCommands?: any[];
}

// ─── Per-session state ─────────────────────────────────────────────────────

interface SessionState {
  status: ConnectionStatus;
  sessionInfo: SessionInfo | null;
  notifications: AcpNotification[];
  pendingPermission: {
    request: any;
    resolve: (r: any) => void;
    reject: (e: Error) => void;
  } | null;
  cwd: string;
  agentConfig: AgentConfig | null;
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

export async function initialize(
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
  const response = await fetch("/api/acp/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: config.name,
      command: config.command,
      args: config.args || [],
      env: config.env || [],
      cwd,
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
    sessionInfo: {
      sessionId,
      agentId: result.agentId || "",
      agentName: config.name,
      agentDisplayName: config.name,
      cwd,
      createdAt: new Date().toISOString(),
    },
    notifications: [],
    pendingPermission: null,
    cwd,
    agentConfig: config,
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

export function reconnect(config: AgentConfig, cwd: string) {
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

export function subscribeToMeta(cb: MetaSubscriber): () => void {
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
      sessionInfo: null,
      notifications: [],
      pendingPermission: null,
      cwd: "",
      agentConfig: null,
    }
  );
}

export function getDefaultSessionId(): string | null {
  return defaultSessionId;
}

export function getSessionIds(): string[] {
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

export async function prompt(sessionId: string, blocks: ContentBlock[]) {
  // Add user message to local notifications FIRST so it appears before agent response
  const userText = blocks
    .map((b) =>
      b.type === "text" ? b.text : b.type === "image" ? "[Image]" : "[File]",
    )
    .join("");
  if (userText) {
    const state = sessions.get(sessionId);
    if (state) {
      const notification: AcpNotification = {
        id: `user-msg-${Date.now()}`,
        type: "session_notification",
        data: {
          update: {
            sessionUpdate: "user_message_chunk",
            content: { text: userText },
          },
        },
      };
      state.notifications = [...state.notifications, notification];
      notifySession(sessionId);
    }
  }

  const response = await fetch(
    `/api/acp/sessions/${encodeURIComponent(sessionId)}/prompt`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks }),
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
