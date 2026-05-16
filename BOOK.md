# crow-ui: The Book

## What Is This?

crow-ui is an IDE built with a **Rust backend** and **React frontend**, designed for AI-assisted development. The backend owns ACP (Agent Client Protocol) sessions, speaks JSON-RPC to agents over stdin/stdout, and acts as a passive server that frontends connect to via WebSocket. The frontend is a passive viewer — it displays session updates but does NOT handle tool requests (the backend does that directly).

## Architecture

### Backend (`crow-ui/backend/`)

| Crate | Purpose |
|-------|---------|
| `crow-ui-server` | Axum HTTP + WebSocket server, owns all ACP sessions, handles filesystem/terminal/document RPC |
| `crow-ui-acp` | Spawns agents via `crow-cli acp`, manages stdin/stdout JSON-RPC, terminal lifecycles |
| `crow-ui-terminal` | xterm.js-compatible PTY management |
| `crow-ui-text` | Rope-based text buffer for document sync |

**Key insight:** The backend holds a `tokio::sync::Mutex<AppState>` across all WebSocket handlers. Never hold this lock during long agent RPCs — that's why prompt/cancel are fire-and-forget (return 202 immediately, spawn background task).

**Session lifecycle:**
1. Frontend POSTs to `/api/acp/sessions` → backend spawns agent process
2. Backend does ACP handshake (`initialize` → `session/new`)
3. Backend broadcasts `session/update` notifications to all connected frontends via WebSocket
4. Frontend is passive: it receives updates and renders them

**Environment passing (Electron):** Electron's GUI process doesn't load shell rc files. We run `bash -i -l -c 'env -0'` before spawning the backend to capture the interactive shell environment (fnm, nvm, uv, etc.). The `-i` flag is critical — it makes bash interactive so `.bashrc` actually loads.

### Frontend (`crow-ui/frontend/`)

| Directory | Purpose |
|-----------|---------|
| `src/components/` | React components: EditorPane (Monaco), ChatPane, TerminalPane, ExplorerPane, etc. |
| `src/lib/` | Client-side libraries: WebSocket client, ACP store, RPC bindings, settings, themes |
| `src/bindings/` | Auto-generated TypeScript types from Rust protocol |

**Key patterns:**
- **FlexLayout** for tab management. Must import `flexlayout-react/style/light.css` in `index.css`.
- **Monaco** editors are created per file, models are synced with backend document API.
- **TipTap** for chat input. Extensions must be stable across renders (`useMemo(() => ..., [])`).
- **Streamdown** for rendering agent markdown with mermaid/math plugins.

## What Works

### ✅ File Explorer
- Tree view with lazy directory loading
- Create/rename/delete files and folders
- Right-click context menu (shadcn)
- Dirty file tracking (dot indicator)

### ✅ Monaco Editor
- Multiple editor tabs
- Language detection from extension
- Word wrap toggle (Alt+Z)
- Custom text wrapping: select text + press `("{[*~_`
- Dirty tracking with debounce (300ms)
- Ctrl+S save, Ctrl+W close tab

### ✅ Terminal
- xterm.js with full PTY
- Multiple terminal tabs
- Gets proper shell environment (.bashrc sourced)

### ✅ Chat / Agent Sessions
- Multiple concurrent chat sessions
- Backend-owned ACP sessions
- Real-time streaming of agent messages
- Tool call display (read/write/edit/fetch/search/terminal)
- Inline terminal output in chat
- File diff views for edit tools
- @-mentions wired to actual workspace files
- Model selector dropdown wired to `session/set_config_option`
- **Queue system:** messages queue while agent is responding
- **Send/Cancel morphing:** send button becomes red stop button during streaming
- **Enter/Ctrl+Enter** to send via custom TipTap extension

### ✅ Command Palette
- Ctrl+Shift+P to open
- Fuzzy search through all commands
- Replaces the dead File/Edit/View menu bar

### ✅ Search Pane
- Tab in the right border (next to Explorer)
- UI for search across files (backend integration TODO)
- Include/exclude pattern filters
- Case sensitive / whole word / regex toggles

### ✅ Settings
- SQLite-backed settings
- Settings pane with raw JSONC editor
- Theme injection (CSS variables)

### ✅ Workspace Restore
- Backend tracks current workspace in memory + SQLite
- Frontend auto-restores on reconnect
- FlexLayout state saved per workspace

## What's a Hack But Necessary

### Monaco Text Wrapping
Monaco's `autoSurround` requires double-pressing wrapping characters. We use a capture-phase `keydown` listener on the editor container that intercepts wrapping chars before Monaco sees them, then uses `editor.executeEdits()` to replace the selection. This is the only reliable way to get single-press text wrapping.

### TipTap Enter Key
Never use `editorProps.handleKeyDown` for send-on-enter — `useEditor` memoizes `editorProps` and the callback captures stale closures. Instead, create a custom TipTap extension with `addKeyboardShortcuts()` and a `useRef` for the callback.

### Streaming Detection
ACP has no explicit "done" notification. We detect streaming by looking for `agent_message_chunk`, `agent_thought_chunk`, and `tool_call_update` with `status === "in_progress"`. The definitive end signal is `prompt_complete` which the backend synthesizes after `session.prompt()` returns.

**Safety timeout:** If `promptPending` stays true for >60s without `prompt_complete`, the frontend force-resets. This handles WebSocket disconnect races where the completion notification is lost.

### Queue Auto-Send
When `prompt_complete` arrives, the effect checks `queuedBlocksRef.current[0]` (using a ref to avoid stale closures) and calls `doSendPromptRef.current?.(next)`. This is necessary because React state in effects gets captured in closures.

### Electron Shell Environment
Electron's GUI process doesn't load `.bashrc`. We run `bash -i -l -c 'env -0'` and parse null-delimited env vars. The `-i` flag is critical — `.bashrc` guards on `$-` (interactive flag), not `$PS1`.

### FlexLayout Tab Splitting
`Actions.addNode()` always creates a `TabNode`, never a `TabSetNode`. To split a tab, pass the tab JSON (not tabset JSON) to `Actions.addNode()` with the **TabSetNode** as target and `DockLocation.RIGHT/LEFT`. FlexLayout auto-wraps the new tab in a TabSetNode.

## Known Issues / TODO

1. **Search backend integration** — UI exists but needs real `ripgrep`/`fd` backend
2. **Git status in explorer** — not implemented
3. **Dirty indicator in FlexLayout tabs** — `onRenderTab` doesn't show dot yet
4. **Per-session agent config** — all sessions share the same agent config
5. **Dual-agent "John Madden" mode** — vision: two agents, one works, one commentates
6. **Jinja system prompt editor** — special editor for crow-cli system prompts
7. **Multi-device session viewing** — backend owns sessions, need UI to view same session from multiple frontends
8. **Bottom bar redesign** — user wants to kill many bottom bar items, use collapsible side pane more

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+Shift+P | Command Palette |
| Ctrl+O | Open Directory |
| Ctrl+S | Save File |
| Ctrl+Shift+S | Save All |
| Ctrl+W | Close Editor |
| Ctrl+B | Toggle Sidebar |
| Ctrl+` | Toggle Terminal |
| Ctrl+L | Toggle Chat / Open Agent Chat |
| Alt+Z | Toggle Word Wrap |
| Ctrl+Shift+E | Show Explorer |
| Ctrl+Shift+F | Show Search |
| Ctrl+Shift+G | Show Source Control |
| Ctrl+Shift+X | Show Extensions |
| Ctrl+Shift+R | Show ACP Log |
| Ctrl+Shift+` | New Terminal |
| Enter / Ctrl+Enter | Send message in chat |

## Development

### Build frontend
```bash
cd crow-ui/frontend && bun run build
```

### Build backend (release)
```bash
cd crow-ui && cargo build --release --package murder-server --bin murder-server
```

### Run server
```bash
cd crow-ui && ./target/release/murder-server
```

### Electron dev
```bash
cd crow-ui/electron && npm run dev
```

**Critical:** Frontend assets are embedded via `rust-embed`. Must rebuild BOTH frontend and backend after frontend changes.

## ACP Protocol Notes

- JSON-RPC 2.0 over stdin/stdout
- Backend handles `fs/readTextFile`, `fs/writeTextFile`, `terminal/create`, etc.
- Auto-grants permissions with `allow-once`
- `session/prompt` blocks until agent finishes turn → backend spawns it in `tokio::spawn`
- `session/cancel` sends JSON-RPC notification to agent
- `session/set_config_option` changes model/config and returns full `configOptions` array
