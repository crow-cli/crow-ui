# Rust ACP Client: Session Orchestrator

## The Real Goal

**Formalize and secure what already works.** Agents already curl `/api/acp/sessions/:id/prompt` to talk to each other. That's a security nightmare (no auth, agents crafting raw HTTP). We want to move that complexity out of agent skills and into:
- **Backend** — owns sessions, routes messages, manages queues, enforces auth
- **MCP** — standardized tool interface so agents don't write curl
- **crow-cli** — agent-side smarts for inter-agent communication patterns

## Current State (Works But Fragile)

- Backend spawns crow-cli via `acp_spawn`, frontend owns ACP handshake
- Agents can already curl `/api/acp/sessions/:id/prompt` — works today
- No queue management — blocking only, race conditions possible
- No auth on endpoints — any process on the host can hit them
- Agents write raw curl in their skills — brittle, hard to change

## Target State

- Backend owns ACP handshake (initialize + newSession)
- Backend broadcasts ACP events to all WebSocket subscribers
- HTTP endpoints require secret key (only agents we initialize get keys)
- MCP tools replace raw curl — agents call `crow_send_to_agent(...)`
- Queue management handles concurrent prompts cleanly
- crow-cli supports compaction/summary output for agent-agent comms

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Rust Backend                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ SessionHost │  │ SessionHost │  │      QueueMgr       │ │
│  │  crow-cli A │  │  crow-cli B │  │  blocking/queued/   │ │
│  │  session-1  │  │  session-2  │  │  end_turn_compact   │ │
│  └──────┬──────┘  └──────┬──────┘  └─────────────────────┘ │
│         │                │                                   │
│  ┌──────┴────────────────┴──────────────────────┐          │
│  │          AcpRouter (broadcasts to all)         │          │
│  │   /ws clients  +  HTTP API  +  MCP tools      │          │
│  └────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────┘
         │                │                │
    Browser Tab 1    Browser Tab 2     Another Agent (curl/MCP)
```

## Backend Responsibilities

1. **Own all ACP sessions** — spawn crow-cli, send `initialize`, create session, handle ND-JSON stream
2. **Execute all tool calls** — `fs.readFile` (from disk, not Monaco), `fs.writeFile`, `terminal.*` (delegates to existing TerminalManager)
3. **Broadcast to all connected clients** — every WebSocket client sees the same ACP events for a session
4. **Queue management** — blocking (cancel current + run now), queued (append), end-turn compaction
5. **Agent-to-agent routing** — HTTP endpoints agents can curl to send prompts to each other
6. **MCP integration** — expose backend sessions as MCP tools so agents can call other agents

## Frontend Responsibilities

1. **Passive renderer** — connect to `/ws`, subscribe to session, render ACP events
2. **Send prompts** — via WebSocket or HTTP POST
3. **Cancel** — via WebSocket or HTTP POST
4. **Session configuration UI** — create/edit agent configs (command, args, env, MCP servers), save to `~/.crow/crow-ui-settings.json`

## Communication

### Unified WebSocket (`/ws`)

Eliminate `/ws/acp`. All traffic goes through `/ws`:
- App control: `document_open`, `terminal_spawn`, `settings-changed`
- ACP control: `acp_session_subscribe`, `acp_session_prompt`, `acp_session_cancel`
- ACP events: `acp_session_notification` (broadcast to all subscribers)

```json
// Frontend → Backend: subscribe to session
{ "id": 1, "method": "acp_session_subscribe", "params": { "sessionId": "sess_abc" } }

// Frontend → Backend: send prompt
{ "id": 2, "method": "acp_session_prompt", "params": { "sessionId": "sess_abc", "blocks": [...] } }

// Backend → Frontend: ACP event broadcast
{ "method": "acp_session_notification", "params": { "sessionId": "sess_abc", "notification": {...} } }
```

### HTTP API (for agents curling each other)

```
POST /api/acp/sessions              → Create session (body: config_name, cwd)
GET  /api/acp/sessions              → List active sessions
GET  /api/acp/sessions/:id          → Get session info
POST /api/acp/sessions/:id/prompt   → Send prompt (mode: blocking | queued)
POST /api/acp/sessions/:id/cancel   → Cancel current generation
DELETE /api/acp/sessions/:id        → Kill session
```

### Prompt Modes

```rust
pub enum PromptMode {
    Blocking,   // Cancel current turn, run this immediately
    Queued,     // Append to queue, run when current completes
}
```

When an agent curls `/api/acp/sessions/:id/prompt` with `mode=queued`, the backend appends it. When the current turn reaches `end_turn`, the next prompt in queue is sent automatically.

## Agent-to-Agent Communication

The key insight: agents communicate via **compaction-like summaries**. When agent A wants to send work to agent B:

1. Agent A reaches end_turn with a summary
2. Backend detects this is a "routing" message (configurable heuristic)
3. Backend sends the summary as a prompt to agent B's session
4. Agent B processes, reaches end_turn, sends summary back
5. Backend routes back to agent A

This is RESTful markdown document exchange — each agent's end_turn output is a document that gets routed.

### MCP Tool Exposure

Backend exposes MCP tools so agents can discover and call each other:

```json
{
  "name": "crow_send_to_agent",
  "description": "Send a prompt to another agent session",
  "inputSchema": {
    "sessionId": "string",
    "prompt": "string",
    "mode": "blocking | queued"
  }
}
```

The calling agent doesn't need to know callback URLs or session IDs. The backend handles all routing.

## Session Lifecycle

1. **Create**: Backend spawns crow-cli with config, sends `initialize`, creates session
2. **Subscribe**: Any client (browser, curl, MCP) subscribes via WebSocket or HTTP
3. **Prompt**: Any client sends prompt → backend forwards to crow-cli stdin
4. **Events**: Backend parses ND-JSON stdout → broadcasts to all subscribers
5. **Tool calls**: Backend intercepts tool calls → executes → sends result back to crow-cli
6. **Queue**: If multiple prompts arrive, backend queues them according to mode
7. **Kill**: Backend sends kill signal, cleans up process

## Configuration

Agent configurations stored in `~/.crow/crow-ui-settings.json` under `agentServers`:

```json
{
  "agentServers": {
    "crow-cli": {
      "command": "crow-cli",
      "args": ["acp"],
      "env": [],
      "mcpServers": ["filesystem", "terminal"]
    },
    "crow-cli-debug": {
      "command": "uv",
      "args": ["run", "crow-cli", "acp", "--debug"],
      "env": [],
      "mcpServers": []
    }
  }
}
```

## Frontend Changes

### What stays
- ChatPane rendering logic (unchanged — still parses ACP events)
- MessageEditor (unchanged)
- Streamdown markdown rendering (unchanged)

### What changes
- Remove `acp-client.ts` spawn/init logic
- Remove `/ws/acp` connection
- `acp-store.ts` becomes thin wrapper around WebSocket calls
- Add agent configuration UI component
- Add session list/switcher UI

### New component: AgentConfigPane

FlexLayout tab component for creating/editing agent configurations:
- Name, command, args, env
- MCP server selection
- Test button (spawns agent, runs initialize, shows handshake)
- Save to settings.json

## Migration Order

1. **Backend owns ACP handshake** — Move `initialize` + `newSession` from frontend `AcpClient` into `AcpSessionHost`. Backend spawns crow-cli, sends handshake, stores session ID.
2. **Unified WebSocket** — Eliminate `/ws/acp`. All traffic on `/ws`: app control messages + `acp_session_subscribe/prompt/cancel` + broadcast notifications.
3. **Passive frontend** — Frontend removes spawn/init logic. Connects to `/ws`, subscribes to session, renders events. Still sends prompt/cancel via WebSocket.
4. **Queue management** — Add blocking vs queued prompt modes. Blocking = cancel current + run now. Queued = append, run on end_turn.
5. **Auth on HTTP endpoints** — Add secret key header. Keys generated by backend, injected into agent env vars. Only initialized agents can call endpoints.
6. **MCP tools** — Replace agent curl skills with MCP tools. `crow_send_to_agent(session_id, prompt, mode)` becomes a tool the agent can call.
7. **crow-cli inter-agent features** — Add compaction/summary output format. Configurable end_turn behavior for routing messages.
8. **End-turn routing** — Backend detects routing messages (heuristic or explicit header), auto-forwards to target session via queue.
9. **Agent config UI** — Add AgentConfigPane for creating/editing agent configs, saved to `~/.crow/crow-ui-settings.json`.

## Crow-CLI Features Needed

- `session/save` and `session/load` support (already in ACP spec)
- Compaction/summary output format for agent-agent communication
- Configurable end_turn behavior (return summary, wait for external prompt)
- Environment variable for backend secret key (`CROW_BACKEND_KEY`)

## Success Criteria

- [ ] Backend sends ACP initialize + newSession without frontend involvement
- [ ] Multiple browser tabs see identical session state via `/ws`
- [ ] Session survives page reload (reconnect via session/list or session/load)
- [ ] `curl -H "X-Agent-Key: secret" /api/acp/sessions/:id/prompt` works
- [ ] Queue works: blocking cancels current, queued appends and runs on end_turn
- [ ] Frontend renders same ACP events as before (no visual change)
- [ ] Agent configs editable in UI, saved to settings.json
- [ ] One agent can prompt another via MCP tool (not raw curl)
- [ ] End-turn routing works between two agent sessions
