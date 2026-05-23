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
- ✅ **Chat scroll control v2**: `userScrolledUpRef` + `isProgrammaticScrollRef` — only user-initiated scrolls trigger "New messages", programmatic scrolls ignored, debounced ResizeObserver for parallel Monaco growth
- ✅ **ThinkingBlock font size**: removed hardcoded `text-xs`, inherits chat font size

### Font Size System (NEW — May 23)
- ✅ Backend defaults: `workbench.tree.fontSize`, `workbench.tab.fontSize`, `workbench.sideBar.fontSize`, `workbench.panel.fontSize`, `workbench.statusBar.fontSize`, `workbench.chat.fontSize`
- ✅ Frontend `WorkbenchSettings` type + `useWorkbenchFontSize()` hook
- ✅ `bumpFontSizes(delta)` — bumps all font size keys at once, clamped [8, 32]
- ✅ Command palette: "Increase Font Size" / "Decrease Font Size"
- ✅ Wired surfaces: EditorPane, FileViews (read/write/diff), TerminalPane, InlineTerminal, SettingsPane, ExplorerPane, ChatPane, flexlayout tabs (CSS variable `--workbench-tab-font-size`)
- ✅ Terminal font size live updates via `fitAddon.fit()` after `options.fontSize` change

### FlexLayout & Layout
- ✅ Split via context menu on every pane
- ✅ Correct split: creates NEW session for chat tabs
- ✅ Tab context menu via `onRenderTab`

### Terminal
- ✅ xterm.js keyboard input fixed
- ✅ Ctrl+C, Ctrl+V, Ctrl+A work in terminal
- ✅ PTY spawn via backend
- ✅ Shell environment resolution (`~/.bashrc`, PATH, fnm/nvm)
- ✅ **Live font size updates** via settings subscription + `fitAddon.fit()`

### Session Management
- ✅ ACP session IDs are REAL agent session IDs
- ✅ `POST /api/acp/sessions` returns actual agent session ID
- ✅ Queue backend-owned with HTTP API and WS events
- ✅ **Cross-agent communication proven** — agent-to-agent messaging via ACP prompt endpoint works (curl tennis between sessions)

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

## 🔥 CURRENT SPRINT

### Chat (Next Priority)
- [ ] **Markdown list support in TipTap** — `- ` and `1. ` auto-continue on newlines, rendered in user prompt bubbles
- [ ] **Image sending from TipTap** — clipboard paste → image node displays correctly, but sending breaks; needs unit/integration testing before e2e
- [ ] **Image rendering from MCP tools** — MCP tools that return images should display inline in chat (currently not implemented)
- [ ] **Markdown preview pane** — Eye icon toggle for markdown files, mystmd rendering; desperately needed
- [ ] **Draft persistence** — Auto-save TipTap draft to backend per chat tab
- [ ] **Drag and drop** — Drag files into chat, drag tabs between panes

### Web Tools
- [ ] **Jazz up WebSearch/WebFetch** — Better UI for search results and fetched content

### TipTap / MessageEditor
- [ ] **@-context improvements** — Zed-style @ context menu with file content preview, not just filename insertion
- [ ] **Rich text → backend state** — Serialize TipTap JSON to backend for persistence

### Agent Factory / Orchestration
- [ ] **Backend orchestration layer** — Mesh delegation so agents can coordinate without human as HTTP postman
- [ ] **Jupyter-like notebook interface** — Python cells for agent configuration and execution inside crow-ui
- [ ] **MCP debugging interface** — Visual tool inspector for MCP tools (latency, errors, schema)
- [ ] **Long-running agent orchestrator** — New system prompts, configurable agents/tools/prompts through UI

---

## 📋 BACKLOG

### UI Polish
- [ ] **Bottom bar cleanup**: Remove minimize-all buttons, use sidebar tabs for minimizing
- [ ] **Settings UI pane**: General settings editor in FlexLayout panel

### Explorer
- [ ] **expandedDirs persistence**: Load/save from backend SQLite

### State Refactor
- [ ] **dirtyFiles → backend**: Derive from document state, not Monaco callbacks
- [ ] **pendingPermission removal**: Strip all permission code

### Packaging
- [ ] **Electron Linux build issues** — AppImage/flatpak packaging

---

*See PLAN.md for detailed design and ordering.*
