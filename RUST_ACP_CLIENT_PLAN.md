# Rust ACP Client: Session Host + Tool Proxy

## Architecture

**One backend, many frontends.** The Rust server owns exactly one ACP session per agent profile. All frontends (browser tabs, Electron windows, mobile) connect to the same backend and see identical session state. Backend broadcasts raw ACP ND-JSON to all connected WebSocket clients. Frontends parse it with `@agentclientprotocol/sdk` exactly as they do today.

**Backend = session host + tool proxy.** It spawns the agent via `crow-cli`, speaks ACP over stdio, intercepts tool calls, executes fs/terminal/MCP operations, and returns results. Frontends never see raw tool traffic — only the resulting ACP entries.

**Frontends = monitors and keyboards.** They render ACP events, capture user input, and call HTTP endpoints to send prompts or cancel generation. They do not own session state.

## What Moves to Backend

| Concern | Before | After |
|---------|--------|-------|
| Session spawn/load/kill | Frontend SDK | **Backend** |
| `fs.readFile` / `fs.writeFile` | Frontend + backend split | **Backend** (checks `AppState.documents`, falls back to disk) |
| `terminal.create` / `terminal.write` | Frontend + backend split | **Backend** (delegates to existing `AcpTerminalManager`) |
| Prompt queue | None | **Backend** (blocking / queued / discard) |
| Agent profiles | None | **Backend SQLite + Frontend UI** |
| MCP server management | None | **Backend** |
| ACP protocol parsing | Frontend SDK | **Frontend SDK** (unchanged) |
| Chat UI rendering | Frontend | **Frontend** (unchanged) |
| WebSocket | `/ws` + `/ws/acp` | **Unified `/ws`** carrying raw ACP ND-JSON |

## Communication

### WebSocket (`/ws`) — Raw ACP

Backend forwards agent stdout ND-JSON directly to all connected clients. No wrapping, no translation.

```
Agent stdout → Backend → WebSocket → Frontend SDK parses as normal ACP
```

Frontends use `@agentclientprotocol/sdk` to consume the stream exactly as before. The only difference is they connect to `ws://host/ws` instead of spawning their own agent process.

### HTTP — Control Plane

```
POST   /api/acp/sessions              → Create session (body: profile_id, cwd)
POST   /api/acp/sessions/:id/load     → Load existing session via crow-cli
DELETE /api/acp/sessions/:id          → Kill session
POST   /api/acp/sessions/:id/prompt   → Send prompt (blocking | queued)
POST   /api/acp/sessions/:id/cancel   → Cancel current generation
GET    /api/acp/sessions/:id/queue    → Get queue status
GET    /api/agents                    → List agent profiles
POST   /api/agents                    → Create profile
PUT    /api/agents/:id                → Update profile (system prompt, model, tools, MCP)
DELETE /api/agents/:id                → Delete profile
```

## Backend Components

### `AcpSessionHost`

```rust
pub struct AcpSessionHost {
    session_id: String,
    profile_id: String,
    agent: Child,              // crow-cli subprocess
    stdin: ChildStdin,
    stdout: ChildStdout,
    clients: Vec<WebSocketTx>, // all connected frontends
    queue: PromptQueue,
}

impl AcpSessionHost {
    async fn create(profile_id: &str, cwd: &str) -> Result<Self>;
    async fn load(session_id: &str) -> Result<Self>;
    async fn run_loop(&mut self);  // read stdout → handle tools → broadcast to clients
    async fn prompt(&mut self, blocks: Vec<ContentBlock>, mode: PromptMode);
    async fn cancel(&mut self);
}
```

### Tool Handlers

Executed inline when the host intercepts a tool call from agent stdout:

- **`fs.readFile`** — Check `AppState.documents` for unsaved content, else read disk
- **`fs.writeFile`** — Update document model if open, write to disk, record in worktree
- **`terminal.create`** / `terminal.write` / `terminal.read` — Delegate to `AcpTerminalManager`
- **MCP tools** — Forward to registered MCP server, optionally compact result

Results are sent back to agent stdin as ACP tool result messages. Frontends only see the resulting chat entries.

### Prompt Queue

```rust
pub enum PromptMode {
    Blocking,   // Cancel current generation, run this immediately
    Queued,     // Append to queue, run when current completes
}

pub enum QueuePolicy {
    Discard,    // Clear queue before running (blocking only)
    Keep,       // Preserve existing queue
}
```

### Agent Profiles (SQLite)

```sql
CREATE TABLE agent_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    system_prompt TEXT,
    model TEXT,
    temperature REAL,
    created_at INTEGER
);

CREATE TABLE agent_mcp_servers (
    profile_id TEXT,
    name TEXT,
    command TEXT,
    args_json TEXT,
    env_json TEXT,
    enabled INTEGER DEFAULT 1,
    PRIMARY KEY (profile_id, name)
);
```

Backend reads profile on session creation, generates `agent_config.json`, spawns `crow-cli`.

## Frontend Changes

### What Stays
- `@agentclientprotocol/sdk` — parses ACP protocol, manages session state locally for rendering
- `ChatPane.tsx`, `MessageEditor.tsx` — unchanged rendering logic
- All notification grouping, entry merging, tool call display — unchanged

### What Changes
- Remove `/ws/acp` separate WebSocket
- Connect ACP SDK to unified `/ws` endpoint
- Replace `acp-client.ts` session spawn logic with HTTP `POST /api/acp/sessions`
- Replace direct prompt send with HTTP `POST /api/acp/sessions/:id/prompt`
- Add queue mode selector to message input (blocking / queued)
- Add agent configuration UI (system prompt, model, MCP servers)
- Add session sidebar (create, load, switch between sessions)

## Migration Order

1. **Smart proxy loop** — Backend reads agent stdout, handles fs/terminal tool calls, broadcasts raw ACP to WebSocket clients
2. **Session host** — Move session spawn/load from frontend to backend. Frontend calls HTTP to create, then connects WebSocket to receive events
3. **Prompt queue** — Add blocking/queued modes to HTTP prompt endpoint
4. **Agent profiles** — SQLite schema + HTTP CRUD + frontend config UI
5. **MCP integration** — Spawn MCP servers, register tools, pass through calls
6. **Cleanup** — Remove `/ws/acp`, delete frontend session spawn code, remove split tool logic

## Success Criteria

- [ ] Single backend session visible from multiple browser tabs simultaneously
- [ ] Frontend SDK parses ACP unchanged; only connection endpoint changes
- [ ] Backend executes all fs/terminal tool calls; frontend never sees tool traffic
- [ ] Prompt queue works (blocking cancels current, queued appends)
- [ ] Agent profiles configurable with system prompt, model, MCP servers
- [ ] Session load/resume via `crow-cli session/load`
- [ ] Sessions survive backend restart (via load/restore)
