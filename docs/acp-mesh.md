# ACP Mesh: Cross-Agent Orchestration via `relay` Endpoint

> **Status:** Design / Analysis  
> **Goal:** One agent calls another; when the callee finishes, the backend auto-summarizes the callee's work and pings the caller back.  
> **Pattern:** Supervisor (Agent-A) → Worker (Agent-B) → Summary → Callback to Supervisor  

---

## Table of Contents

1. [The Problem](#the-problem)
2. [The Flow (End-to-End)](#the-flow-end-to-end)
3. [Files to Touch](#files-to-touch)
4. [Step-by-Step Implementation Breadcrumbs](#step-by-step-implementation-breadcrumbs)
5. [Key Design Decisions](#key-design-decisions)
6. [Open Questions](#open-questions)

---

## The Problem

Today, when Agent-A calls the `prompt` MCP tool to message Agent-B, the backend (`crow-ui-server`) fire-and-forgets the prompt and immediately returns `202 Accepted`. Agent-A has no idea when Agent-B finishes, and Agent-B's output is never summarized and relayed back.

We need a **new backward-compatible endpoint** — `/api/acp/sessions/{session_id}/relay` — that:

1. Accepts `from_session_id` + `blocks` in the JSON body.
2. Immediately returns `202 Accepted` to the caller (Agent-A).
3. Dispatches the prompt to the callee (Agent-B).
4. **Waits** for Agent-B's turn to end (`stop_reason` from `session/prompt` response).
5. **Re-prompts** Agent-B with a hardcoded compaction/summary prompt (text-only, no tools).
6. **Captures** the text response from Agent-B's `agent_message_chunk` session updates.
7. **Sends** that summary back to Agent-A (`from_session_id`) via the same `session/prompt` pathway.

---

## The Flow (End-to-End)

```
┌─────────┐    prompt(tool)    ┌──────────────┐
│ Agent-A │ ─────────────────► │ crow-cli     │
│ (caller)│   + from_session   │ (tools.py    │
└─────────┘     injected       │  injects it) │
                                └──────┬───────┘
                                       │ MCP call
                                       ▼
                                ┌──────────────┐
                                │ crow-ui-mcp  │
                                │ (main.py)    │
                                └──────┬───────┘
                                       │ POST /api/acp/sessions/{B}/relay
                                       │ Body: { blocks, from_session_id: "A" }
                                       ▼
                                ┌──────────────┐
                                │ crow-ui      │
                                │ (Rust axum)  │
                                └──────┬───────┘
                                       │
       ┌───────────────────────────────┘
       │ 1. Spawn async background task
       │ 2. Return 202 to MCP (→ Agent-A sees "Message sent")
       ▼
┌──────────────┐    session/prompt     ┌─────────┐
│ AcpSession   │ ─────────────────────►│ Agent-B │
│  (for B)     │                       │ (worker)│
└──────────────┘                       └────┬────┘
                                            │
                                            │ ReAct loop, tools, etc.
                                            │
                                            ▼
                                     ┌──────────────┐
                                     │ session/prompt│
                                     │ response      │
                                     │ stop_reason   │
                                     └──────┬───────┘
                                            │
       ┌────────────────────────────────────┘
       │ B's turn ended. Now summarize.
       ▼
┌──────────────┐    session/prompt     ┌─────────┐
│ AcpSession   │ ─────────────────────►│ Agent-B │
│  (for B)     │ "Generate RESTful     │ (idle)  │
│              │  Markdown summary...  │         │
│              │  CALL NO TOOLS"       │         │
└──────────────┘                       └────┬────┘
                                            │
                                            │ LLM generates text only
                                            │ (no tools because prompt says so)
                                            ▼
                                     ┌──────────────┐
                                     │ session/update│
                                     │ agent_message │
                                     │ _chunk (text) │
                                     └──────┬───────┘
                                            │
       ┌────────────────────────────────────┘
       │ Backend captures & aggregates chunks
       ▼
┌─────────────────────────────────────────┐
│ Summary text assembled                  │
│ "## Sub-agent (B) completed task\n\n..."│
└─────────────────────────────────────────┘
       │
       ▼
┌──────────────┐    session/prompt     ┌─────────┐
│ AcpSession   │ ─────────────────────►│ Agent-A │
│  (for A)     │ "Sub-agent B completed│ (super) │
│              │  task. Summary: ..."  │         │
└──────────────┘                       └─────────┘
```

---

## Files to Touch

| # | File | What |
|---|------|------|
| 1 | `crow-cli/crow-ui-mcp/main.py` | Forward `from_session_id` in the HTTP request body |
| 2 | `crow-ui/backend/crates/crow-ui-server/src/ws.rs` | Add `relay` route + handler |
| 3 | `crow-ui/backend/crates/crow-ui-server/src/acp_session.rs` | Add `prompt_and_capture_text()` helper; track parent sessions |
| 4 | `crow-ui/backend/crates/crow-ui-server/src/handlers.rs` | Add `handle_acp_relay` (or extend existing) |
| 5 | *(optional)* `crow-ui/backend/crates/crow-ui-server/src/state.rs` | Add parent→child index if needed |

---

## Step-by-Step Implementation Breadcrumbs

### Step 1: Forward `from_session_id` from MCP → Backend

**File:** `crow-cli/crow-ui-mcp/main.py`

**Current state:**
```python
def prompt(message: str, session_id: str, from_session_id: str = "session-123"):
    ...
    request_body = dict(
        blocks=[
            dict(type="text", text=message)
        ]
    )
```

**Change:** Add `from_session_id` to `request_body` so the backend actually receives it.

```python
def prompt(message: str, session_id: str, from_session_id: str = "session-123"):
    url = f"http://localhost:45489/api/acp/sessions/{session_id}/relay"  # NEW endpoint
    headers = {"Content-Type": "application/json"}
    request_body = dict(
        blocks=[
            dict(type="text", text=message)
        ],
        from_session_id=from_session_id,  # <-- ADD THIS
    )
    ...
```

> **Endpoint routing:** The MCP (`crow-ui-mcp/main.py`) decides which endpoint to hit. If `from_session_id` is present → POST to `/relay`. If absent → POST to `/prompt`. This keeps the Rust handlers focused and avoids awkward fallback logic in Axum.

---

### Step 2: Add the `/relay` Axum Route

**File:** `crow-ui/backend/crates/crow-ui-server/src/ws.rs`

**Current routes (~line 36):**
```rust
let router = Router::new()
    .route("/ws", get(ws_handler))
    .route("/ws/acp", get(acp_ws_handler))
    .route("/api/acp/sessions", post(create_session_handler))
    .route("/api/acp/sessions/:session_id/prompt", post(prompt_session_handler))
    .route("/api/acp/sessions/:session_id/cancel", post(cancel_session_handler))
    .route("/api/acp/sessions/:session_id/queue", get(get_queue_handler).post(queue_action_handler))
    .with_state(app)
    .fallback(get(serve_embedded));
```

**Add:**
```rust
    .route("/api/acp/sessions/:session_id/relay", post(relay_session_handler))
```

---

### Step 3: Write the `relay_session_handler`

**File:** `crow-ui/backend/crates/crow-ui-server/src/ws.rs`

This handler is a hybrid of `prompt_session_handler` + background orchestration.

**Sketch:**
```rust
/// Hardcoded compaction prompt. Instructs the agent to generate a RESTful Markdown
/// summary without calling any tools. We rely on the agent's instruction-following
/// to not emit tool calls; if it does, we ignore them and aggregate text only.
const RELAY_SUMMARY_PROMPT: &str = r#"Please summarize what you just accomplished in this session.

Generate a concise RESTful Markdown summary that includes:
- What task was performed
- What files were read/written/modified
- Key findings or results
- Any errors encountered

DO NOT call any tools. Only return Markdown text."#;

/// HTTP handler: POST /api/acp/sessions/:session_id/relay
/// Async cross-agent orchestration endpoint.
/// Body: { blocks: ContentBlock[], from_session_id: string }
async fn relay_session_handler(
    Path(session_id): Path<String>,
    State(app): State<App>,
    axum::Json(body): axum::Json<Value>,
) -> impl IntoResponse {
    // --- Extract params ---
    let from_session_id = body
        .get("from_session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if from_session_id.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "error": "Missing from_session_id. Use /prompt for regular prompts."
        }))).into_response();
    }

    let blocks: Vec<acp::ContentBlock> = match body.get("blocks") {
        Some(arr) => match serde_json::from_value(arr.clone()) {
            Ok(b) => b,
            Err(e) => {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
                    "error": format!("Invalid blocks: {e}")
                }))).into_response();
            }
        },
        None => vec![],
    };

    let state = app.lock().await;
    let target_session = match state.acp_sessions.get_session(&session_id).await {
        Some(s) => s,
        None => {
            return (StatusCode::NOT_FOUND, Json(serde_json::json!({
                "error": format!("Session not found: {session_id}")
            }))).into_response();
        }
    };

    let caller_session = state.acp_sessions.get_session(from_session_id).await;
    drop(state);

    // --- Fire-and-forget the orchestration ---
    tokio::spawn(async move {
        // 1. Send original prompt to target (Agent-B)
        if let Err(e) = target_session.prompt(blocks).await {
            eprintln!("[relay] target prompt failed for {session_id}: {e}");
            // TODO: optionally notify caller that the relay failed
            return;
        }

        // 2. Target turn ended. Now send summary prompt.
        //    Subscribe BEFORE sending so we don't miss any chunks.
        let mut event_rx = target_session.subscribe();

        let summary_blocks = vec![acp::ContentBlock::Text(acp::TextContent {
            text: RELAY_SUMMARY_PROMPT.to_string(),
        })];

        // We need to run the prompt AND collect chunks concurrently.
        // run_prompt() blocks until the JSON-RPC response arrives.
        // agent_message_chunk notifications arrive on event_rx during that time.
        let summary_prompt_fut = target_session.prompt(summary_blocks);

        // Collect text chunks
        let mut summary_parts = Vec::new();

        // Race: if prompt completes before we drain events, stop collecting.
        // But we need to make sure we get all chunks. Since run_prompt blocks
        // on the JSON-RPC response and chunks are sent BEFORE the response,
        // we can safely collect until prompt completes, then drain for a grace period.
        let prompt_result = loop {
            tokio::select! {
                event = event_rx.recv() => {
                    match event {
                        Ok(SessionEvent::Update { session_id: _, update }) => {
                            if let Some("agent_message_chunk") = update.get("sessionUpdate").and_then(|v| v.as_str()) {
                                if let Some(text) = update.get("content").and_then(|c| c.get("text")).and_then(|t| t.as_str()) {
                                    summary_parts.push(text.to_string());
                                }
                            }
                        }
                        _ => {}
                    }
                }
                result = summary_prompt_fut => {
                    break result;
                }
            }
        };

        if let Err(e) = prompt_result {
            eprintln!("[relay] summary prompt failed for {session_id}: {e}");
            return;
        }

        // Grace-period drain: any final chunks that were in-flight
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(250);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_millis(50), event_rx.recv()).await {
                Ok(Ok(SessionEvent::Update { session_id: _, update })) => {
                    if let Some("agent_message_chunk") = update.get("sessionUpdate").and_then(|v| v.as_str()) {
                        if let Some(text) = update.get("content").and_then(|c| c.get("text")).and_then(|t| t.as_str()) {
                            summary_parts.push(text.to_string());
                        }
                    }
                }
                _ => break,
            }
        }

        let summary_text = summary_parts.join("");

        // 3. Callback to caller (Agent-A)
        if let Some(caller) = caller_session {
            let callback_text = format!(
                "[relay from session_id={}]\n## Sub-agent completed task\n\n{}",
                session_id, summary_text
            );
            let callback_blocks = vec![acp::ContentBlock::Text(acp::TextContent {
                text: callback_text,
            })];
            if let Err(e) = caller.prompt(callback_blocks).await {
                eprintln!("[relay] callback to {from_session_id} failed: {e}");
            }
        } else {
            eprintln!("[relay] caller session {from_session_id} not found; summary dropped.");
        }
    });

    (StatusCode::ACCEPTED, Json(serde_json::json!({
        "status": "relayed",
        "message": "10-4 we are on it!"
    }))).into_response()
}
```

**Key details:**
- If `from_session_id` is missing → fall back to normal `prompt_session_handler`.
- `target_session.prompt()` uses `run_prompt()` under the hood, which waits for the full turn (including all tool calls) to finish.
- We subscribe to events **before** sending the summary prompt so we capture every `agent_message_chunk`.
- We race between `event_rx.recv()` and the prompt future. When the prompt future resolves, we break and do a grace-period drain.
- The summary prompt is hardcoded as a Rust `const` for now.
- We aggregate **only** `agent_message_chunk` text content. If the agent emits tool calls during summary, we ignore them (the prompt says "DO NOT call any tools").
- The callback is just another `session/prompt` on the caller session — reusing the exact same pathway.

---

### Step 4: Verify `AcpSession::prompt` is what we need

**File:** `crow-ui/backend/crates/crow-ui-server/src/acp_session.rs`

**Current `prompt` method (~line 335):**
```rust
pub async fn prompt(&self, blocks: Vec<acp::ContentBlock>) -> Result<()> {
    self.run_prompt(blocks).await.map(|_| ())
}
```

This is perfect. It:
1. Sets `PromptTurnState::Running`
2. Broadcasts `prompt_state → running`
3. Calls `request_no_timeout("session/prompt", ...)`
4. Blocks until the agent returns the `PromptResponse`
5. Broadcasts `prompt_complete` with `stop_reason`

No changes needed here, but we rely on its exact behavior.

---

### Step 5: Consider Queue Integration

The user asked: *"we might just want to fall back on [queue logic]"*

**Analysis:** The existing queue (`queued_items`, `queue_push`, `drain_queue`) is for **user-submitted** prompts that stack up while the agent is busy. Our summary prompt is an **internal/backend-generated** prompt that must run immediately after the worker turn ends. It should **not** go into the user-visible queue because:
- It would show up in the frontend as a queued user message (weird UX).
- The user might delete or reorder it.
- We need it to run deterministically right after the turn ends.

**Verdict:** Don't reuse the user queue. Call `run_prompt` directly in the background task. The target session will be idle at that moment (we just waited for the previous turn to end), so `run_prompt` will execute immediately.

---

### Step 6: Optional — Add Parent Tracking to `AcpSessionManager`

**File:** `crow-ui/backend/crates/crow-ui-server/src/acp_session.rs` (manager)

If we want to know "who called whom" for debugging / UI visualization, add a `parent_session_id` field to `AcpSession`:

```rust
pub struct AcpSession {
    pub session_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub cwd: String,
    pub config_options: Option<Value>,
    pub modes: Option<Value>,
    pub parent_session_id: Option<String>,  // <-- NEW
    // ... rest
}
```

And set it in the relay handler before spawning the background task:
```rust
// (inside relay_session_handler, after getting target_session)
// We can't mutate Arc<AcpSession> easily — would need Mutex or DashMap.
// For MVP, skip persistent parent tracking; it's only needed in-memory for the task.
```

**Verdict for MVP:** Skip persistent parent tracking. The `from_session_id` is only needed ephemerally inside the background task.

---

### Step 7: `crow-cli` Side — Ensure `from_session_id` is Injected

**File:** `crow-cli/crow-cli/src/crow_cli/agent/tools.py`

Already done. `execute_acp_prompt` does:
```rust
args["from_session_id"] = session_id;
```

This arrives at the MCP server (`crow-ui-mcp/main.py`) as a Pydantic-validated argument. We just need to forward it (Step 1).

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **New endpoint `/relay`** instead of overloading `/prompt` | Keeps `/prompt` pure and predictable. `/relay` explicitly signals cross-agent orchestration. |
| **Hardcoded Rust prompt** | MVP. Will be replaced with slash command infrastructure later. |
| **Grace-period drain (250ms)** | Handles the tiny race between last `agent_message_chunk` and `PromptResponse`. |
| **Ignore tool calls during summary** | The prompt says "DO NOT call any tools." If the agent disobeys, we still only aggregate text. The agent will get tool responses from nobody and error out, but that's on the agent. |
| **Fall back to `/prompt` if `from_session_id` absent** | Backward compatibility. Existing clients that don't send `from_session_id` get old behavior. |
| **Callback via `caller.prompt()`** | Uses the exact same ACP pathway — no special-case routing needed. |

---

## Open Questions

1. **What if Agent-B's turn never ends?** (infinite tool loop, hanging terminal)
   - The `target_session.prompt()` in the background task will block forever.
   - **Mitigation:** Rely on the user canceling Agent-B, which will make `prompt()` return an error.

2. **What if the summary prompt itself triggers tool calls?**
   - We ignore them and only aggregate text. But the agent might hang waiting for tool responses.
   - **Mitigation:** The prompt is explicit: "DO NOT call any tools." If the agent still calls tools, that's an agent-level bug. We could enhance the backend to auto-reject tool permission requests during summary mode, but that's v2.

3. **What if Agent-A's session is gone when we try to callback?**
   - `caller_session` will be `None`. We log and drop the summary. No crash.

4. **Should we use `tool_choice="none"`?**
   - **No.** ACP v1 has no `tool_choice` field on `PromptRequest`. That's an OpenAI API concept internal to the agent. We instruct the agent via text only.

5. **Should the callback be a `session/prompt` or a synthetic `session/update`?**
   - **Must be `session/prompt`.** Agent-A is an ACP agent expecting user messages via `session/prompt`. Sending a synthetic `session/update` would bypass its ReAct loop.

---

## Summary Checklist

- [ ] `crow-cli/crow-ui-mcp/main.py` — forward `from_session_id` in request body; call `/relay`
- [ ] `crow-ui/backend/crates/crow-ui-server/src/ws.rs` — add `/relay` route + `relay_session_handler`
- [ ] `crow-ui/backend/crates/crow-ui-server/src/ws.rs` — write `relay_session_handler` with background task
- [ ] Test: Agent-A calls prompt → Agent-B receives it → Agent-B works → Agent-B gets summary prompt → Agent-B returns text → Agent-A receives callback
