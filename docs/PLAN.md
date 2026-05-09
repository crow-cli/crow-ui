# PLAN.md

The plan for implementing backend-controlled ACP orchestration.


# TASK

Create endpoint which can accept an external connection to invoke `session/prompt` in the frontend on an "active" agent via the frontend's ACP client. Build up from there to full multi-agent orchestration.


# Architecture: Backend-Controlled ACP Orchestration

## Core Insight

Both orchestrator and worker agents run as sessions in the **same frontend ACP client**. The backend is a stateful control plane that routes messages between them. All communication is **async** — no agent blocks waiting for another.

## WebSocket Endpoint Split

- **`/ws`** — App control WebSocket. Settings, files, terminals, worktree, and backend→frontend ACP command broadcasts.
- **`/ws/acp`** — ACP protocol WebSocket. Raw JSON-RPC between agent subprocess and frontend `AcpClient`.

**Critical**: ACP methods (`acp_spawn`, `acp_terminal_output`, etc.) MUST go over `/ws/acp`. The app `/ws` handler rejects unknown ACP methods.

## Message Flow

### Session Creation (synchronous)
```
External caller (MCP tool)
  → POST /api/acp/sessions {cwd}
  → Backend WS broadcast: acp-command-new-session {requestId}
  → Frontend: opens chat tab, spawns AcpClient, does ACP handshake
  → Frontend WS report: acp-report-session-created {requestId, sessionId}
  → Backend: resolves oneshot, returns {sessionId} in HTTP response
```

The caller blocks until the session is fully created and the ACP handshake completes.

### Prompt (fire and forget)
```
External caller
  → POST /api/acp/sessions/:id/prompt {blocks}
  → Backend WS broadcast: acp-command-prompt {sessionId, blocks}
  → Frontend AcpClient: session/prompt to agent
  → Agent starts working
```

Returns 202 immediately. The actual work happens asynchronously.

### Cancel (fire and forget)
```
External caller
  → POST /api/acp/sessions/:id/cancel
  → Backend WS broadcast: acp-command-cancel {sessionId}
  → Frontend AcpClient: session/cancel
```

## Current Status

### ✅ Implemented

**Backend (`backend/crates/crow-ui-server/src/`)**
- `state.rs`: `acp_cmd_tx` broadcast channel + `acp_pending` DashMap for sync session creation
- `ws.rs`: HTTP routes `POST /api/acp/sessions`, `/:id/prompt`, `/:id/cancel`
- `ws.rs`: WS broadcast subscription for `acp_cmd_rx` in `handle_socket`
- `ws.rs`: `acp_report_session_created` handler resolves pending oneshot

**Frontend (`frontend/src/`)**
- `lib/ws-client.ts`: `onAcpCommand(handler)` subscription for `acp-command-*`
- `App.tsx`: `acp-command-new-session` handler creates session + opens chat tab + reports back
- `App.tsx`: `acp-command-prompt` handler calls `acpStore.prompt(sessionId, blocks)`
- `App.tsx`: `acp-command-cancel` handler calls `acpStore.cancel(sessionId)`
- `lib/acp-store.ts`: `getClient(sessionId)` exposes `AcpClient` for imperative calls
- `components/InlineTerminal.tsx`: Routes ACP terminal calls through `acpStore.getClient(sessionId)?.wsInvoke()` over `/ws/acp`

**Tests (`frontend/e2e/`)**
- `acp-control.spec.ts`: Create session via API with real `crow-cli` agent
- `acp-control.spec.ts`: Prompt delivers message to chat UI
- `acp-control.spec.ts`: Full flow — create → prompt → agent responds
- `acp-control.spec.ts`: Terminal tool renders output in chat inline terminal (with screenshots)
- `websocket-split.spec.ts`: Validates `/ws` rejects ACP methods and `/ws/acp` rejects app methods

**Visual Verification**
- Playwright browser tests navigate to frontend, call API, take screenshots
- Terminal output is now correctly rendered in chat inline terminals (fixed WS routing regression)

### ⏳ Pending

**Phase 1: Message Queue + Turn Complete**
- [ ] Frontend reports `acp-report-turn-complete` when agent finishes
- [ ] Backend SQLite queue for pending messages per session
- [ ] Auto-dequeue and send when turn completes

**Phase 2: Telemetry**
- [ ] Backend inspects agent SQLite dbs
- [ ] REST API: `GET /api/sessions/:id/tools`, `/content`, `/reasoning`

**Phase 3: Multi-Agent Orchestration**
- [ ] Orchestrator can spawn worker sessions via tool call
- [ ] Workers report completion back to orchestrator
- [ ] Session lifecycle management (cleanup inactive sessions)

**Phase 4: Chat UI Polish**
- [ ] Stop button replaces send during agent response
- [ ] Message queue UI (pending messages)
- [ ] Model selector
- [ ] Monaco diff with hideUnchangedRegions

## Key Learnings

1. **Synchronous session creation works**: Backend generates `requestId`, broadcasts command, frontend reports back via `acp_report_session_created`, backend resolves oneshot. Timeout after 30s.

2. **WebSocket split is critical**: All ACP protocol traffic (spawn, relay, terminal methods) MUST go over `/ws/acp`. App methods (settings, files) go over `/ws`. Never mix them.

3. **Auto-open chat tabs**: When `acp-command-new-session` arrives, the frontend should both create the ACP session AND open a FlexLayout chat tab. Otherwise notifications go to the store but no UI subscribes.

4. **Real agents only**: `crow-cli acp` processes are the actual ACP agents. Tests must spawn real agents, not echo mocks.

5. **xterm.js timing**: Inline terminal screenshots may need a small delay after scroll to let the canvas render.
