# PLAN.md

The plan for implementing the task


# TASK

Create endpoint which can accept an external connection to a endpoing which will invoke session/prompt in the frontend on an "active" (the window is open/new_session has been called) agent via the frontend's ACP client. We start here. Then work our way up.


# PLAN
-

Architecture: Backend-Controlled ACP Orchestration

## Core Insight

Both orchestrator and worker agents run as sessions in the **same frontend ACP client**. The backend is a stateful control plane that routes messages between them. All communication is **async** — no agent blocks waiting for another.

## Message Flow

### Session Creation (synchronous)
```
External caller (MCP tool)
  → POST /api/acp/sessions {agentConfig, cwd}
  → Backend WS broadcast: acp-command-new-session
  → Frontend: creates new window/tab, spawns AcpClient, does ACP handshake
  → Frontend WS report: acp-report-session-created {sessionId}
  → Backend: returns {sessionId} in HTTP response
```

The caller blocks until the session is fully created and the ACP handshake completes.

### Orchestrator → Worker (fire and forget)
```
Orchestrator agent (session A)
  → MCP tool call (non-blocking)
  → Backend HTTP API: POST /api/acp/sessions/:worker_id/prompt
  → Backend WS broadcast: acp-command-prompt
  → Frontend AcpClient: session/prompt to worker (session B)
  → Worker agent starts working
```

Orchestrator's react loop continues immediately. It does NOT wait.

### Worker → Orchestrator (done signal)
```
Worker agent finishes
  → end_turn + compact summary in output
  → Frontend WS report: acp-report-turn-complete
  → Backend: enqueue summary for orchestrator
  → Backend WS broadcast: acp-command-prompt
  → Frontend AcpClient: session/prompt to orchestrator (session A)
  → Orchestrator sees: "Worker B completed: <summary>"
```

## Why This Works

1. **No blocking MCP**: The orchestrator's `session/prompt` returns immediately. The actual work happens asynchronously.
2. **No callback complexity**: The "return path" is just another `session/prompt` in reverse.
3. **Backend owns queues**: If orchestrator isn't ready, messages queue in backend SQLite.
4. **Telemetry for free**: Backend logs every tool call, content block, and reasoning step from both agents via its own SQLite inspection layer.

## Backend Components Needed

### 1. HTTP Control API (ACP-mirror routes)
```
POST /api/acp/sessions                   → create new session (sync, blocks until handshake)
POST /api/acp/sessions/:id/prompt        → send prompt (async, fire-and-forget)
POST /api/acp/sessions/:id/cancel        → cancel turn (async)
POST /api/acp/sessions/:id/load          → load previous session (sync)
GET  /api/acp/sessions/:id               → get session state
GET  /api/acp/sessions                   → list active sessions
```

### 2. WS Command Broadcast Channel
**Commands (backend → frontend):**
- `acp-command-new-session` → frontend creates window + AcpClient + ACP handshake
- `acp-command-prompt` → frontend executes `session/prompt`
- `acp-command-cancel` → frontend executes `session/cancel`

**Reports (frontend → backend):**
- `acp-report-session-created` → frontend reports sessionId after handshake
- `acp-report-turn-complete` → frontend reports end_turn with summary

### 3. Per-Session Message Queue (SQLite)
```sql
CREATE TABLE session_queue (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  direction TEXT NOT NULL, -- 'in' (to agent) or 'out' (from agent)
  payload JSON NOT NULL,
  status TEXT NOT NULL, -- 'pending', 'sent', 'completed'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 4. Telemetry Service
Backend inspects agent SQLite dbs and exposes:
```
GET /api/sessions/:id/tools      → tool calls made
GET /api/sessions/:id/content    → content blocks emitted
GET /api/sessions/:id/reasoning  → reasoning traces
```

## Frontend Changes Needed

1. **Subscribe to `acp-command-*` notifications** on `/ws`
2. **Execute commands** via existing AcpClient
3. **Report `end_turn`** back to backend via `acp-report-turn-complete`
4. **Queue UI**: Show pending messages per session

## Implementation Order

### Phase 1: Backend HTTP API + WS Commands
- [ ] Add `acp_cmd_tx` broadcast channel to AppState
- [ ] Add `POST /api/acp/sessions` (sync — waits for frontend handshake)
- [ ] Add `POST /api/acp/sessions/:id/prompt` (async)
- [ ] Add `POST /api/acp/sessions/:id/cancel` (async)
- [ ] Add WS notification handlers for `acp-command-new-session`, `acp-command-prompt`, `acp-command-cancel`
- [ ] Add WS report handlers for `acp-report-session-created`, `acp-report-turn-complete`
- [ ] Frontend subscribes and executes commands

### Phase 2: Message Queue
- [ ] SQLite schema for session_queue
- [ ] Enqueue on HTTP POST, dequeue on `end_turn` report
- [ ] Auto-send queued messages when turn completes

### Phase 3: Telemetry
- [ ] SQLite inspection layer for agent dbs
- [ ] REST API for tools/content/reasoning
- [ ] Frontend telemetry panel

### Phase 4: Chat UI Polish
- [ ] Stop button replaces send during agent response
- [ ] Message queue UI (pending messages)
- [ ] Model selector
- [ ] Monaco diff with hideUnchangedRegions

## Notes

- The orchestrator and worker are **peers**. Either can prompt the other.
- The backend is **dumb about ACP protocol**. It forwards bytes and tracks state.
- All "intelligence" lives in the agents. The backend is a router + queue + telemetry.
