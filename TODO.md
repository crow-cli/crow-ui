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
- ✅ Stop button exists (not merged with send yet)
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

---

## 🐛 BUGS — Active

1. **Explorer focus loss on new file**: Creating a new file collapses expanded folders in explorer. Should preserve explorer state and focus editor simultaneously.
2. **No native delete confirmation dialog**: Right-click → Delete uses browser confirm(). Should use OS native dialog (Tauri/electron) or a proper keyboard-navigable modal.
3. **Right-click menus are inconsistent**: Explorer uses custom context menu, editor uses Monaco's, chat has none. Should emulate VSCode/Monaco style everywhere.
4. **Dirty indicator missing in tab bar**: Dirty dot shows in explorer but not in the workspace tab itself.
5. **File opening race condition**: Sometimes requires page refresh to see file content after opening from explorer.
6. **Electron on Linux**: Terminals don't render in UI.
7. **Stale browser processes break ACP**: Old Chrome/Playwright instances poison WebSocket connections. Need `pkill chrome` + `lsof -i :3928` hygiene.

---

## ✨ POLISH — Next Up

### Immediate (High Impact, Low Risk)
- [ ] **Settings UI pane**: Frontend UI to modify `crow-ui-settings.json` without hand-editing JSON
- [ ] **Simple code completion**: Markdown list continuation (typing `- ` then Enter gives next `- `, numbered lists increment)
- [ ] **Image previews**: Read-only image viewer in editor pane (EOG-style or iframe), image hover previews in chat, image rendering in tool responses
- [ ] **Markdown preview pane**: mystmd preview for `.md` files (we have code for this from mystmd.org/sandbox)
- [ ] **Dirty indicator in tabs**: Show dot in FlexLayout tab when file is unsaved

### Chat Polish
- [ ] **@-mentions wired to filesystem**: Currently popup works but isn't connected to actual file paths / ACP content block specs
- [ ] **Send/Stop/Queue button unification**: Single button that morphs between Send (idle+typing) → Stop (responding) → Queue (idle+not typing)
- [ ] **Queued messages UI**: Visual list of pending messages with edit/delete before they fire
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

- `frontend/src/lib/settings.ts` has 329 lines of frontend defaults — most should come from backend only
- `murder-ide-v2/` directory still exists with broken rebrand — `murder-ide-working/` is canonical
- `AGENTS.md` grew too large — keep concise, move detailed patterns to `docs/journal/`
