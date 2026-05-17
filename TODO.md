# CROW-UI MASTER TODO

## ✅ COMPLETED

### Architecture & Backend
- ✅ WebSocket split: `/ws` (app control) and `/ws/acp` (ACP protocol)
- ✅ HTTP API for backend-controlled ACP orchestration
- ✅ Backend WS broadcast + oneshot pattern for sync session creation
- ✅ Settings system: `~/.crow/crow-ui-settings.json`
- ✅ Rebrand: murder-* → crow-ui
- ✅ Electron build + packaging (Linux issues remain)
- ✅ crow-cli agent state persists in `~/.crow/crow.db`

### Chat UI
- ✅ TipTap @-mentions (mechanism works, not wired to filesystem)
- ✅ Streamdown markdown rendering
- ✅ Mermaid diagram rendering with debounce
- ✅ User prompts appear in full-width container
- ✅ Monaco diff for read/edit/write file tools
- ✅ Word wrap enabled by default in Monaco editors
- ✅ InlineTerminal renders xterm.js in chat
- ✅ Chat padding/margins fixed
- ✅ Newline preservation: Shift+Enter inserts hardBreak, Enter sends
- ✅ Taller chat editor: `min-h-[120px] max-h-[320px]`
- ✅ Auto-scroll editor keeps cursor visible when typing multi-line
- ✅ Send/Stop/Queue button morphs correctly (➤ when editor has content during streaming, ⏹ when empty)
- ✅ Queued messages UI with edit (✎), send now (▶), remove (✕)
- ✅ Ultradark background with dot pattern + glass textures

### FlexLayout & Layout
- ✅ Split via context menu on every pane
- ✅ Correct split: creates NEW session for chat tabs
- ✅ Tab context menu via `onRenderTab`

### Terminal
- ✅ xterm.js keyboard input fixed
- ✅ Ctrl+C, Ctrl+V, Ctrl+A work in terminal
- ✅ PTY spawn via backend
- ✅ Shell environment resolution (`~/.bashrc`, PATH, fnm/nvm)

### Session Management
- ✅ ACP session IDs are REAL agent session IDs
- ✅ `POST /api/acp/sessions` returns actual agent session ID

### Workspace & Persistence
- ✅ Workspace auto-restore on page refresh
- ✅ `get_current_workspace` + `get_recent_workspaces`
- ✅ FlexLayout JSON save/restore per workspace

### Dirty Indicators
- ✅ `DirtyIndicator` component using Tailwind theme (bg-primary, rounded-full)
- ✅ Dirty dot in FlexLayout tabs (left of filename, no text shift on save)
- ✅ Dirty files in explorer show purple `text-primary` + dot
- ✅ **Explorer filesystem sync**: File watcher now dynamically adds new directories to watch list. Creating/deleting files and directories outside the app (e.g., via terminal) updates the explorer in real-time without refresh.

---

## 🐛 BUGS — Active

1. **Explorer focus loss on new file**: Creating a new file collapses expanded folders in explorer. Should preserve explorer state and focus editor simultaneously.
2. **No native delete confirmation dialog**: Right-click → Delete uses browser confirm(). Should use OS native dialog (Tauri/electron) or a proper keyboard-navigable modal.
3. **Right-click menus are inconsistent**: Explorer uses custom context menu, editor uses Monaco's, chat has none. Should emulate VSCode/Monaco style everywhere.
4. **File opening race condition**: Sometimes requires page refresh to see file content after opening from explorer.
5. **Electron on Linux**: Terminals don't render in UI.
6. ~~**Stale browser processes break ACP**~~: **FIXED** — ACP client moved entirely to Rust backend. No more browser Playwright/Chrome poisoning WebSocket connections.

---

## 🔧 STATE MANAGEMENT REFACTOR

### Category 1: Frontend owns state and shouldn't — refactor now
These create race conditions, disagreement between frontend/backend, or data loss on refresh.

- [ ] **`queuedItems` → backend ACP session state**
  - Backend `AppState` should own `pending_prompts: Vec<ContentBlock>` per session
  - Frontend sends `queue_prompt`, backend broadcasts `queue_changed`
  - Auto-drain queue when `promptTurnState` transitions `running → idle`
  - Strip `queuedItems` from `ChatPane`, derive from backend session

- [ ] **`dirtyFiles: Set<string>` → backend document state**
  - Backend `documents: DashMap<String, TextModel>` already knows dirty state
  - Frontend should not maintain parallel `Set<string>`
  - Backend broadcasts `dirty-changed { path, dirty }` via WebSocket
  - Frontend just renders what backend says

- [ ] **`acp-store.ts` fake notifications**
  - `prompt()` injects `user_message_chunk` before backend confirms receipt
  - If POST fails, user sees a ghost message forever
  - Backend should assign notification ID and confirm receipt before frontend displays

- [ ] **`pendingPermission` resolution**
  - Frontend stores permission request promise, resolves locally
  - Backend sends the request but frontend invents resolution state
  - Permission resolution should round-trip through backend

### Category 2: User preferences → move into `crow-ui-settings.json`
Frontend currently defines these locally; they should be backend settings the frontend queries.

- [ ] **`wordWrap`** — editor setting
- [ ] **`showHiddenFiles`** — explorer display preference
- [ ] **`explorerBg` / `explorerOpacity`** — theme/customization
- [ ] **`activeActivity`** — which sidebar panel was open last
- [ ] **`agentConfig`** — configured agent for workspace (user choice, but should persist in settings)
- [ ] Kill `frontend/src/lib/settings.ts` defaults — all settings should come from backend only

### Category 3: Frontend legitimately owns
Interactive UI state where the backend doesn't need to know intermediate states.

- ✅ `modelJson` — FlexLayout drag/drop is interactive, backend only sees final snapshot
- ✅ `commandPaletteOpen` — ephemeral overlay
- ✅ `contextMenu` — click-to-open/close
- ✅ `editingPath` / `creatingParentPath` — inline rename/create form state
- ✅ `hasEditorContent` — derived from TipTap editor
- ✅ `selectedModel` — local mirror of backend session config (syncs bidirectionally)

---

## ✨ POLISH — Next Up

### Immediate (High Impact, Low Risk)
- [ ] **Settings UI pane**: Frontend UI to modify `crow-ui-settings.json` without hand-editing JSON
- [ ] **Simple code completion**: Markdown list continuation (typing `- ` then Enter gives next `- `, numbered lists increment)
- [ ] **Image previews**: Read-only image viewer in editor pane (EOG-style or iframe), image hover previews in chat, image rendering in tool responses
- [ ] **Markdown preview pane**: mystmd preview for `.md` files (we have code for this from mystmd.org/sandbox)

### Chat Polish
- [ ] **@-mentions wired to filesystem**: Currently popup works but isn't connected to actual file paths / ACP content block specs
- [ ] **Per-session agent config**: Settings pane per chat session for MCP servers, model selection, agent config
- [ ] **Session callback tracking**: Add requestId/correlation ID to prompt/cancel so responses route to correct UI session

### Editor Polish
- [ ] **Native context menus everywhere**: Override browser right-click, use VSCode-style menus (Monaco's context menu as reference)
- [ ] **Monaco diff collapsing**: Revisit hiding unchanged regions (we broke this once, needs careful redo)
- [ ] **Code preview on hover**: Mini Monaco popup for symbol/file references

---

## 🔧 DEV INFRASTRUCTURE (Table for Later)

### Logging
- [ ] Document `RUST_LOG=info|debug|trace` for backend logging (already works, just needs docs)
- [ ] Frontend debug logs routed to backend via WebSocket endpoint
- [ ] Stop logging every xterm.js keystroke to console

### Dev/Prod Isolation
- [ ] `--config-dir` arg for alternate settings path
- [ ] `--port` arg (exists but not documented)
- [ ] Dev settings path: `~/.crow/crow-ui-dev-settings.json`
- [ ] Dev DB path: `~/.crow/crow-ui-dev.db`
- [ ] Configurable binary name or dev suffix

### Testing
- [ ] Playwright regression test for `POST /api/acp/sessions` endpoint
- [ ] Test that verifies no stale Chrome processes before running

---

## 📝 TECH DEBT

- `murder-ide-v2/` directory still exists with broken rebrand — `murder-ide-working/` is canonical
- `AGENTS.md` grew too large — keep concise, move detailed patterns to `docs/journal/`
- Timer on long running bash commands
- Cancel/kill terminal button on long running bash commands
