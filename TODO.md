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
- ✅ Backend queue ownership: `QueuedItem`, `PromptBehavior`, auto-drain
- ✅ Agent config dropdown: loads from settings, persists to `crow-ui-settings.json`
- ✅ Agent Configuration UI Pane: FlexLayout panel for CRUD agent configs + MCP association
- ✅ @-Mentions with filesystem context: `@` shows real workspace files, inserts resource link mentions

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
- ✅ MessageEditor layout fix: flex column, no text overlap with bottom bar

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
- ✅ Queue backend-owned with HTTP API and WS events

### Workspace & Persistence
- ✅ Workspace auto-restore on page refresh
- ✅ `get_current_workspace` + `get_recent_workspaces`
- ✅ FlexLayout JSON save/restore per workspace

---

## 🔧 STATE MANAGEMENT REFACTOR

### Category 1: Frontend owns state and shouldn't — refactor now

- ✅ **`queuedItems` → backend ACP session state**
- [ ] **`dirtyFiles: Set<string>` → backend document state**
- [ ] **`expandedDirs` → backend explorer state**
- [ ] **`pendingPermission` removal** — strip all permission UI and state

### Category 2: User preferences → move into `crow-ui-settings.json`

- [ ] **`wordWrap`** — editor setting
- [ ] **`showHiddenFiles`** — explorer display preference
- [ ] **`explorerBg` / `explorerOpacity`** — theme/customization
- [ ] **`activeActivity`** — which sidebar panel was open last
- [ ] **`agentConfig`** — configured agent for workspace
- [ ] Kill `frontend/src/lib/settings.ts` defaults — all settings should come from backend only

### Category 3: Frontend legitimately owns

- ✅ `modelJson` — FlexLayout drag/drop is interactive
- ✅ `commandPaletteOpen` — ephemeral overlay
- ✅ `contextMenu` — click-to-open/close
- ✅ `editingPath` / `creatingParentPath` — inline rename/create form state
- ✅ `hasEditorContent` — derived from TipTap editor
- ✅ `selectedModel` — local mirror of backend session config

---

## 🔥 CURRENT SPRINT (see PLAN.md)

1. **Chat Scroll Control** — User can scroll up while agent streams without being pulled down
2. **Image Rendering in Chat** — Inline image display for image content blocks
3. **Copy/Paste Screenshots into MessageEditor** — Clipboard image → TipTap image node
4. **Rich Text Editor State → Backend** — Draft persistence per chat tab

---

## 📋 BACKLOG

### UI Polish
- [ ] **Bottom bar cleanup**: Remove minimize-all buttons, use sidebar tabs for minimizing
- [ ] **Markdown preview**: Eye icon toggle for markdown files, mystmd rendering
- [ ] **Settings UI pane**: General settings editor in FlexLayout panel

### Chat
- [ ] **Scroll control during streaming**: Pause auto-scroll when user scrolls up
- [ ] **Image rendering**: Inline images from tool responses
- [ ] **Copy/paste images**: Clipboard → TipTap editor
- [ ] **Draft persistence**: Auto-save drafts to backend

### Explorer
- [ ] **expandedDirs persistence**: Load/save from backend SQLite

### State Refactor
- [ ] **dirtyFiles → backend**: Derive from document state, not Monaco callbacks
- [ ] **pendingPermission removal**: Strip all permission code

---

*See PLAN.md for detailed design and ordering.*
