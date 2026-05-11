crow-cli generated summary of crow-ui-ide-v2

Alright, here's a good summary of what's going on with crow-ui-ide-v2:
High-Level Architecture

It's a web-based IDE (VS Code-like) with a Rust backend + React frontend, communicating over WebSocket RPC.
Backend (Rust — crow-ui-server + workspace crates)

    crow-ui-server — Axum-based WebSocket server on port 3928. Handles IPC between frontend and all backend services.
    crow-ui-acp — Agent Client Protocol integration. Spawns agent subprocesses (like crow-cli acp) and bridges stdio to WebSocket.
    crow-ui-terminal — Manages PTY terminals via portable-pty, broadcasts events to WebSocket clients.
    crow-ui-workspace — File tree, file ops, search, file watching (notify).
    crow-ui-db — SQLite persistence (recent projects, window state, layout, KV storage, history).
    crow-ui-lsp — Language Server Protocol support.
    crow-ui-syntax / crow-ui-textmate — Syntax highlighting via Tree-sitter + TextMate grammars.
    crow-ui-git — Git operations via gix.
    crow-ui-text — Rope-based text buffer.
    crow-ui-settings / crow-ui-theme — IDE settings and theming.

Frontend (React + Vite + TypeScript)

    FlexLayout (flexlayout-react) — Tab/panel layout engine. The whole UI is a 3-panel layout: Explorer (left) → Editor + Terminal (center stack) → Agent Chat (right).
    Monaco Editor — Code editor with a custom "crow-ui-dark" theme. Models are cached in a registry so content survives tab switches.
    xterm.js — Terminal rendering.
    TipTap — Rich text editor for the chat message input (with @-mentions support per AGENTS.md learnings).
    Streamdown — Markdown rendering in chat (code blocks, math, mermaid).
    shadcn/ui + Radix — Context menus, dialogs, etc.
    Tailwind CSS v4 — Dark theme styling.

Agent Integration (ACP)

    The IDE implements the Agent Client Protocol (@agentclientprotocol/sdk). Each chat tab gets its own ACP session — the backend spawns the agent subprocess, and the frontend communicates via WebSocket-relayed JSON-RPC.
    Multi-session support — acp-store.ts manages multiple concurrent agent sessions, each with its own AcpClient, notifications, and permission handling.
    The agent can read/write/edit files, create terminals, and request permissions. File reads go through the Monaco model registry first so the agent sees unsaved changes.

Key Flow

    Server starts → sets up terminal event bridge → serves frontend + WebSocket on one port
    Frontend connects via WS → user opens a directory → file tree loads
    Opening files creates Monaco models, registers with backend
    Chat tabs spawn agent sessions via acp_spawn → ACP handshake → ready for prompts
    Agent tool calls (read/write/edit/execute) render as rich UI components in chat (file diffs, inline terminals, web fetch results)

Agent Config

Currently points to /home/thomas/.local/bin/crow-cli acp — that's the AI agent the IDE talks to.

Pretty solid setup. It's essentially a lightweight VS Code alternative built specifically around AI agent workflows, with FlexLayout for the panel system and ACP for agent integration.



# Backend control of ACP Client

## Create session (blocks up to 30s waiting for frontend to respond)
curl -X POST http://localhost:3928/api/acp/sessions

## Send prompt (fire-and-forget)
curl -X POST http://localhost:3928/api/acp/sessions/<session_id>/prompt \
  -H "Content-Type: application/json" \
  -d '{"blocks": [{"type": "text", "text": "hello"}]}'

## Cancel
curl -X POST http://localhost:3928/api/acp/sessions/<session_id>/cancel


> [!NOTE]
> if `curl -X POST http://localhost:3928/api/acp/sessions` is not returning the session_id, check for instances of chrome running in background and `lsof -i :3928` to see which processes are listening for it
