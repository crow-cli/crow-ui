/**
 * Multi-session ACP store — supports multiple concurrent agent sessions.
 *
 * Each session has its own AcpClient, state, and notification stream.
 * Backwards compatible: default session helpers still work.
 */

import {
  AcpClient,
  type AcpNotification,
  type AgentConfig,
  type ConnectionStatus,
  type SessionInfo,
} from "./acp-client";

// ─── Per-session state ───────────────────────────────────────────────────────

interface SessionState {
  client: AcpClient | null;
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

// ─── Global state ────────────────────────────────────────────────────────────

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

// ─── Session lifecycle ───────────────────────────────────────────────────────

/** Initialize the default session (backwards compat). */
export function initialize(config: AgentConfig, cwd: string): string {
  const sessionId = `session-${Date.now()}`;
  createSession(sessionId, config, cwd);
  defaultSessionId = sessionId;
  return sessionId;
}

export function createSession(
  sessionId: string,
  config: AgentConfig,
  cwd: string,
): void {
  if (sessions.has(sessionId)) return;

  const state: SessionState = {
    client: null,
    status: "disconnected",
    sessionInfo: null,
    notifications: [],
    pendingPermission: null,
    cwd,
    agentConfig: config,
  };
  sessions.set(sessionId, state);

  if (!defaultSessionId) defaultSessionId = sessionId;
  notifyMeta();

  const client = new AcpClient({
    agentConfig: config,
    cwd,
    onNotification: (n) => {
      const s = sessions.get(sessionId);
      if (s) {
        // MUST create new array reference for React to detect the change
        s.notifications = [...s.notifications, n];
        notifySession(sessionId);
      }
    },
    onStatusChange: (s2) => {
      setSessionState(sessionId, { status: s2 });
    },
    onPermissionRequest: (req, resolve, reject) => {
      setSessionState(sessionId, {
        pendingPermission: { request: req, resolve, reject },
      });
    },
  });

  state.client = client;

  client
    .connect()
    .then((info) => {
      setSessionState(sessionId, { sessionInfo: info, status: "ready" });
    })
    .catch((err) => {
      console.error(`[acp-store] Session ${sessionId} connect failed:`, err);
      setSessionState(sessionId, { status: "disconnected" });
    });
}

export function closeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session?.client) {
    session.client.disconnect().catch(() => {});
  }
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

// ─── Subscriptions ───────────────────────────────────────────────────────────

/** Backwards compat — subscribes to the default session. */
export function subscribe(
  cb: (state: SessionState) => void,
): () => void {
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
  // Call immediately with current state
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

// ─── Getters ─────────────────────────────────────────────────────────────────

export function getState(): SessionState {
  return getSession(defaultSessionId || "");
}

export function getSession(sessionId: string): SessionState {
  return (
    sessions.get(sessionId) || {
      client: null,
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

// Expose client for imperative calls (prompt, cancel, etc.)
export function getClient(sessionId?: string): AcpClient | null {
  const id = sessionId ?? defaultSessionId;
  if (!id) return null;
  return sessions.get(id)?.client ?? null;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export async function prompt(sessionId: string, text: string) {
  const client = getClient(sessionId);
  if (!client) throw new Error("No client for session");
  return client.prompt(text);
}

export async function cancel(sessionId: string) {
  const client = getClient(sessionId);
  if (!client) return;
  return client.cancel();
}

// Expose terminal ID mapping for inline terminal rendering
export function getTerminalId(toolCallId: string): string | undefined {
  const id = defaultSessionId;
  if (!id) return undefined;
  const client = getClient(id);
  return client?.getTerminalId(toolCallId);
}
