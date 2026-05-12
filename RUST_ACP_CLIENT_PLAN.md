# Plan: Moving the ACP Client from Frontend to Rust Backend

## Executive Summary

Currently, `crow-ui`'s frontend owns the entire ACP (Agent Client Protocol) client — it speaks JSON-RPC over a dedicated `/ws/acp` WebSocket, maintains all session state, and uses the `@agentclientprotocol/sdk` npm package. The Rust backend is merely a dumb pipe that spawns agent subprocesses and relays raw stdio bytes.

**Goal:** Move the ACP client into the Rust backend so the frontend becomes a thin view layer. The backend will own session state, protocol handling, and agent lifecycle. The frontend will send high-level commands (`prompt`, `cancel`) and receive structured state updates.

This mirrors Zed's architecture where `acp_thread` and `agent` crates own the ACP connection and `AcpThread` state machine, while GPUI renders a view over it.

---

## 1. Current Architecture (Problems)

### Frontend (`crow-ui/frontend/src/`)
- **`lib/acp-client.ts`** — Full ACP client using `@agentclientprotocol/sdk`. Creates `ClientSideConnection`, handles initialization, `newSession`, `prompt`, `cancel`, and all JSON-RPC parsing.
- **`lib/acp-store.ts`** — In-memory session state (notifications, connection status, pending permissions, tool call → terminal mappings). Subscribers get deltas.
- **`components/ChatPane.tsx`** — Subscribes to `acp-store`, groups/merges notifications, renders messages/tool calls inline.
- **Two WebSockets** — `/ws` for app control (files, terminals, settings) and `/ws/acp` for raw ACP protocol traffic.
- **`lib/acp-utils.ts`** — Notification grouping and tool-call merging logic (should live in backend).

### Backend (`crow-ui/backend/crates/`)
- **`crow-ui-acp`** — Only spawns/kills agent subprocesses (`AgentManager`) and manages PTY terminals (`AcpTerminalManager`). No ACP protocol knowledge.
- **`crow-ui-server`** — `/ws/acp` is a dumb pipe. HTTP endpoints `/api/acp/sessions/:id/prompt` broadcast to frontend via `acp_cmd_tx` — the frontend still does all the work.

### Why This Is Wrong
1. **State split across the wire** — The backend has `acp_pending` and `acp_cmd_tx` hacks to synchronize with frontend-owned state. This is fragile.
2. **Two WebSockets** — Unnecessary complexity. The ACP pipe is raw stdio bytes; the backend should consume them directly.
3. **Frontend bloat** — The frontend does protocol parsing, tool-call merging, notification grouping, and terminal ID mapping. These are backend concerns.
4. **No multi-client support** — If multiple frontends connect (or we add a CLI), they each need their own ACP session. Backend ownership enables shared sessions.
5. **SDK lock-in** — The frontend depends on `@agentclientprotocol/sdk`. A Rust client removes this dependency entirely.

---

## 2. Target Architecture

### Backend (`crow-ui-acp` crate expansion)

#### New Types (in Rust)

```rust
// crow-ui-acp/src/session.rs
pub struct AcpSession {
    pub session_id: String,
    pub agent_id: String,
    pub agent_config: AgentConfig,
    pub cwd: String,
    pub status: SessionStatus, // disconnected → connecting → ready → generating
    pub entries: Vec<ThreadEntry>, // user_msg, assistant_msg, tool_call, plan
    pub pending_permission: Option<PermissionRequest>,
    pub token_usage: Option<TokenUsage>,
    pub available_commands: Vec<AvailableCommand>,
    pub tool_call_terminal_map: HashMap<String, String>, // toolCallId → terminalId
}

pub enum ThreadEntry {
    UserMessage(UserMessage),
    AssistantMessage(AssistantMessage),
    ToolCall(ToolCall),
    Plan(Vec<PlanEntry>),
}
```

#### New `AcpClient` (in Rust)

Replace the frontend's `@agentclientprotocol/sdk` usage with a native Rust ACP client:

```rust
// crow-ui-acp/src/client.rs
pub struct AcpClient {
    connection: JsonRpcConnection, // speaks ACP protocol directly to agent stdin/stdout
    session: AcpSession,
    event_tx: broadcast::Sender<AcpEvent>,
}

impl AcpClient {
    pub async fn connect(agent_config: &AgentConfig, cwd: &str) -> Result<Self>;
    pub async fn prompt(&mut self, blocks: Vec<ContentBlock>) -> Result<PromptResponse>;
    pub async fn cancel(&mut self) -> Result<()>;
    pub fn subscribe(&self) -> broadcast::Receiver<AcpEvent>;
}
```

The `AcpClient` will:
1. Connect to the agent subprocess via `AgentManager` (already exists).
2. Send JSON-RPC `initialize`, `client/registerCapability`, `sessions/new` directly.
3. Read stdout, parse ND-JSON, and produce structured `AcpEvent`s.
4. Handle `readTextFile`/`writeTextFile` by calling into `crow-ui-workspace`/`crow-ui-text` (document models already exist in `AppState`).
5. Handle `createTerminal`/`terminalOutput` by calling into `AcpTerminalManager` (already exists).

#### `AcpEvent` Broadcast Stream

```rust
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event")]
pub enum AcpEvent {
    StatusChanged { session_id: String, status: SessionStatus },
    EntryAdded { session_id: String, entry: ThreadEntry },
    EntryUpdated { session_id: String, index: usize, entry: ThreadEntry },
    ToolCallMerged { session_id: String, tool_call: ToolCall },
    PermissionRequested { session_id: String, request: PermissionRequest },
    TokenUsageUpdated { session_id: String, usage: TokenUsage },
    SessionClosed { session_id: String },
    Error { session_id: String, message: String },
}
```

#### `AcpSessionManager` (in `AppState`)

```rust
// crow-ui-server/src/state.rs
pub struct AppState {
    // ... existing fields ...
    pub acp_sessions: DashMap<String, AcpSessionHandle>,
    pub acp_events_tx: broadcast::Sender<String>, // JSON-serialized AcpEvent
}

pub struct AcpSessionHandle {
    pub client: Arc<tokio::sync::Mutex<AcpClient>>,
    pub session_id: String,
}
```

### Frontend (`crow-ui/frontend/src/`)

#### What Gets Deleted
- **`lib/acp-client.ts`** — Entire file. ACP protocol handling moves to Rust.
- **`lib/acp-store.ts`** — Entire file. Session state moves to Rust.
- **`lib/acp-utils.ts`** — Notification grouping and tool-call merging move to Rust.
- **`@agentclientprotocol/sdk`** dependency — Remove from `package.json`.
- **`/ws/acp` WebSocket** — Remove. All communication goes over `/ws`.

#### What Stays
- **`components/ChatPane.tsx`** — Still renders chat UI, but subscribes to backend events instead of `acp-store`.
- **`components/MessageEditor.tsx`** — Still handles user input (TipTap, @-mentions, image paste).
- **`lib/ws-client.ts`** — Extended with ACP event handlers.

#### New Frontend Types

```typescript
// Replaces AcpNotification + acp-store state
interface AcpSessionState {
  sessionId: string;
  status: SessionStatus;
  entries: ThreadEntry[]; // serialized from Rust
  pendingPermission: PermissionRequest | null;
  tokenUsage: TokenUsage | null;
  availableCommands: AvailableCommand[];
}

// WebSocket notifications from backend
type AcpEvent =
  | { event: "status_changed"; sessionId: string; status: SessionStatus }
  | { event: "entry_added"; sessionId: string; entry: ThreadEntry }
  | { event: "entry_updated"; sessionId: string; index: number; entry: ThreadEntry }
  | { event: "permission_requested"; sessionId: string; request: PermissionRequest }
  | { event: "session_closed"; sessionId: string };
```

---

## 3. Communication Layer: One WebSocket, Structured Events

### Unified WebSocket (`/ws`)

The existing `/ws` WebSocket already handles request/response + server-push notifications. We extend it with ACP events.

**Backend → Frontend (push):**
```json
{
  "method": "acp-event",
  "params": {
    "event": "entry_added",
    "sessionId": "session-123",
    "entry": { "type": "assistant_message", "chunks": [...] }
  }
}
```

**Frontend → Backend (RPC):**
```json
{ "id": 1, "method": "acp_prompt", "params": { "sessionId": "session-123", "blocks": [...] } }
{ "id": 2, "method": "acp_cancel", "params": { "sessionId": "session-123" } }
{ "id": 3, "method": "acp_create_session", "params": { "agentConfig": {...}, "cwd": "/project" } }
{ "id": 4, "method": "acp_close_session", "params": { "sessionId": "session-123" } }
{ "id": 5, "method": "acp_resolve_permission", "params": { "sessionId": "session-123", "outcome": {...} } }
```

### Why Not HTTP Polling?

WebSocket push is required for streaming assistant responses. HTTP polling would add latency and complexity for real-time chat. The existing `/ws` infrastructure is already robust.

### Why Not Keep `/ws/acp`?

The `/ws/acp` WebSocket exists because the frontend needed a raw byte stream for the JS ACP SDK. Once the backend owns the protocol, there's no need for a separate raw pipe. All ACP traffic is internal to the Rust process.

---

## 4. Chat State Sharing

### In-Memory + Broadcast (Primary)

Session state lives in `AppState.acp_sessions` (a `DashMap`). When state changes:

1. Rust updates `AcpSession.entries`.
2. Rust serializes the delta as `AcpEvent`.
3. Rust broadcasts to all connected WebSocket clients via `acp_events_tx`.
4. Frontend receives the event and updates React state.

### SQLite Persistence (Future)

For session history across restarts, we can add SQLite tables in `crow-ui-db`:

```sql
CREATE TABLE acp_sessions (
    session_id TEXT PRIMARY KEY,
    agent_name TEXT,
    cwd TEXT,
    created_at INTEGER,
    title TEXT
);

CREATE TABLE acp_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    entry_index INTEGER,
    entry_type TEXT, -- user_message, assistant_message, tool_call, plan
    entry_json TEXT,
    FOREIGN KEY (session_id) REFERENCES acp_sessions(session_id)
);
```

**Phase 1 (this migration):** In-memory only. Sessions are lost on server restart — same as today.
**Phase 2 (future):** Add SQLite persistence and `resume_session` support.

---

## 5. Crate Structure

```
crow-ui-acp/
├── Cargo.toml
└── src/
    ├── lib.rs              // Re-exports
    ├── agent.rs            // AgentManager (spawning/killing) — EXISTING
    ├── terminals.rs        // AcpTerminalManager — EXISTING
    ├── client.rs           // NEW: Rust ACP JSON-RPC client
    ├── session.rs          // NEW: AcpSession, ThreadEntry, ToolCall, etc.
    ├── events.rs           // NEW: AcpEvent broadcast types
    ├── protocol.rs         // NEW: ACP schema types (or use agent_client_protocol crate if available)
    └── handlers.rs         // NEW: readTextFile, writeTextFile, createTerminal implementations
```

### Dependencies

Add to `crow-ui-acp/Cargo.toml`:
```toml
[dependencies]
# Existing
crow-ui-text = { workspace = true }
crow-ui-workspace = { workspace = true }
crow-ui-terminal = { workspace = true }

# New
serde = { workspace = true }
serde_json = { workspace = true }
tokio = { workspace = true }
tracing = "0.1"
dashmap = { workspace = true }
parking_lot = { workspace = true }
crossbeam = { workspace = true }

# For ND-JSON streaming
futures = "0.3"
tokio-util = { version = "0.7", features = ["codec"] }

# If we vendor or generate ACP schema types:
# agent_client_protocol = { path = "../../path/to/rust/sdk" }
```

**Note:** There is currently no published Rust `agent_client_protocol` crate. We have two options:
1. **Vendor the schema:** Hand-write the ACP request/response types in `crow-ui-acp/src/protocol.rs` (approx 500 lines, based on the TS SDK interfaces).
2. **Use Zed's schema module:** Zed's `agent_client_protocol` is internal. We can adapt their `acp_thread/src/acp_thread.rs` types.

**Recommendation:** Vendor the schema. The ACP spec is stable enough, and this avoids a dependency on Zed's internal crate.

---

## 6. Migration Steps (In Order)

### Step 0: Research & Scaffold (1 day)
- [ ] Read `@agentclientprotocol/sdk` source to extract all request/response types.
- [ ] Create `crow-ui-acp/src/protocol.rs` with vendored ACP schema types.
- [ ] Add `AcpEvent`, `ThreadEntry`, `AcpSession` types in `crow-ui-acp/src/session.rs`.

### Step 1: Rust ACP Client (3–4 days)
- [ ] Implement `JsonRpcConnection` in `crow-ui-acp/src/client.rs`:
  - ND-JSON read/write over `tokio::process::ChildStdin/Stdout`.
  - Request/response correlation (matching `id` fields).
  - Notification dispatch (server-initiated JSON-RPC notifications).
- [ ] Implement ACP handshake:
  - `initialize` → `initialized` → `client/registerCapability` → `sessions/new`.
- [ ] Implement `prompt` and `cancel` methods.
- [ ] Implement `AcpEvent` broadcast via `tokio::sync::broadcast`.

### Step 2: ACP Client Handlers (2 days)
- [ ] `readTextFile` — Check `AppState.documents` first (for unsaved editor content), fall back to `tokio::fs::read_to_string`.
- [ ] `writeTextFile` — Update `AppState.documents` model if open, write to disk, record in `WorktreeState`.
- [ ] `createTerminal`/`terminalOutput`/`waitForTerminalExit`/`killTerminal`/`releaseTerminal` — Delegate to existing `AcpTerminalManager`.
- [ ] `requestPermission` — Buffer the request in `AcpSession.pending_permission`, emit `AcpEvent::PermissionRequested`.

### Step 3: Backend Session Manager (1–2 days)
- [ ] Add `acp_sessions: DashMap<String, AcpSessionHandle>` to `AppState`.
- [ ] Add `acp_events_tx: broadcast::Sender<String>` to `AppState`.
- [ ] Implement WebSocket RPC handlers:
  - `acp_create_session` → spawn agent, create session, return `session_id`.
  - `acp_prompt` → forward to `AcpClient::prompt`.
  - `acp_cancel` → forward to `AcpClient::cancel`.
  - `acp_close_session` → kill agent, remove session.
  - `acp_resolve_permission` → forward to pending permission handler.
- [ ] Subscribe WebSocket clients to `acp_events_tx` broadcast.

### Step 4: Frontend Refactor (3 days)
- [ ] Extend `ws-client.ts` with `onAcpEvent(handler)`.
- [ ] Create new `lib/acp-state.ts` (replaces `acp-store.ts`):
  - Subscribe to backend `acp-event` notifications.
  - Maintain local React-friendly state.
  - Expose `createSession`, `prompt`, `cancel`, `closeSession` as `ws.invoke()` calls.
- [ ] Update `ChatPane.tsx`:
  - Subscribe to `acp-state` instead of `acp-store`.
  - Render `ThreadEntry[]` directly (no more notification grouping/merging in frontend).
- [ ] Delete `acp-client.ts`, `acp-store.ts`, `acp-utils.ts`.
- [ ] Remove `@agentclientprotocol/sdk` from `package.json`.

### Step 5: Remove `/ws/acp` (1 day)
- [ ] Delete `acp_ws_handler` and `handle_acp_socket` from `crow-ui-server/src/ws.rs`.
- [ ] Remove `/ws/acp` route from Axum router.
- [ ] Clean up `acp_cmd_tx`, `acp_pending`, and related HTTP handlers from `AppState` and `handlers.rs`.

### Step 6: Testing & Polish (2–3 days)
- [ ] Verify single-session chat works end-to-end.
- [ ] Verify multi-session chat works (each session has independent `AcpClient`).
- [ ] Verify tool calls (read/write/edit/terminal) render correctly.
- [ ] Verify permission requests popup and resolve.
- [ ] Verify session restoration on page reload (backend keeps sessions alive; frontend re-subscribes).
- [ ] Add Playwright test for the full flow.

**Total estimated time:** 2–3 weeks for one engineer.

---

## 7. What Stays in Frontend vs. What Moves to Backend

| Concern | Currently | After Migration |
|---------|-----------|-----------------|
| **ACP JSON-RPC protocol** | Frontend (`@agentclientprotocol/sdk`) | **Backend** (Rust `AcpClient`) |
| **Session state (messages, tool calls)** | Frontend (`acp-store.ts`) | **Backend** (`AcpSession.entries`) |
| **Notification grouping** | Frontend (`acp-utils.ts`) | **Backend** (merged before broadcast) |
| **Tool-call merging** | Frontend (`acp-utils.ts`) | **Backend** (merged in `AcpSession`) |
| **Terminal ID mapping** | Frontend (`acp-client.ts`) | **Backend** (`AcpSession.tool_call_terminal_map`) |
| **Permission requests** | Frontend (callback in `acp-client.ts`) | **Backend** (buffered, broadcast to frontend) |
| **Agent subprocess lifecycle** | Backend (`AgentManager`) | **Backend** (unchanged) |
| **PTY terminal management** | Backend (`AcpTerminalManager`) | **Backend** (unchanged) |
| **File read/write for agent** | Split (frontend checks Monaco, backend falls back) | **Backend** (unified via `AppState.documents`) |
| **Chat UI rendering** | Frontend (`ChatPane.tsx`) | **Frontend** (unchanged, thinner) |
| **Message editor (TipTap)** | Frontend (`MessageEditor.tsx`) | **Frontend** (unchanged) |
| **User input handling** | Frontend (`ChatPane.tsx`) | **Frontend** (calls `ws.invoke("acp_prompt", ...)`) |
| **WebSocket connection** | Two sockets (`/ws`, `/ws/acp`) | **One socket** (`/ws`) |

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **ACP schema drift** — The JS SDK is the source of truth. | Vendor the schema and add a CI check that diffs against the latest `@agentclientprotocol/sdk` types. |
| **Streaming performance** — Rust → WebSocket → React must feel instant. | Use `tokio::sync::broadcast` with large capacity (1024). Batch rapid `EntryUpdated` events in the backend if needed. |
| **Monaco model sync** — Agent reads must see unsaved editor content. | Backend `readTextFile` checks `AppState.documents` first (already implemented in `handlers.rs`). |
| **Multi-tab support** — If user opens multiple browser tabs, they should see the same sessions. | `AcpSessionManager` is global in `AppState`. All tabs subscribe to the same `acp_events_tx` broadcast. |
| **Build complexity** — Removing the JS SDK may break Electron builds. | The SDK is only used in `acp-client.ts`. Removing it reduces bundle size. No Tauri/Electron native deps affected. |

---

## 9. Reference: Zed's Architecture

Zed's `acp_thread` crate (`/home/thomas/src/crow-ai/murder-sidex/zed/crates/acp_thread/`) is the model:

- **`connection.rs`** — `AgentConnection` trait. Implementations speak to Claude Code, Gemini CLI, etc.
- **`acp_thread.rs`** — `AcpThread` state machine. Owns `entries: Vec<AgentThreadEntry>`, handles `SessionUpdate` streaming, tool-call authorization, token usage, checkpointing.
- **Events** — `AcpThreadEvent` is emitted via GPUI's `EventEmitter`. UI components subscribe and re-render.
- **No frontend protocol code** — The frontend (GPUI) never sees raw ACP JSON-RPC. It only sees structured events and calls high-level methods like `thread.send(...)`.

We should copy this separation of concerns exactly:
- Rust = state machine + protocol engine.
- Frontend = view + user input capture.

---

## 10. Success Criteria

1. `@agentclientprotocol/sdk` is removed from `package.json`.
2. `/ws/acp` WebSocket is removed; only `/ws` remains.
3. `acp-client.ts`, `acp-store.ts`, `acp-utils.ts` are deleted.
4. Multiple chat sessions work simultaneously in the backend.
5. Page reload preserves active sessions (backend keeps them alive).
6. Tool calls (read, write, edit, terminal, web fetch) render identically to before.
7. All existing Playwright tests pass.
