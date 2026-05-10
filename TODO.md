# CROW-UI MASTER TODO

## ✅ COMPLETED

### Architecture & Backend
- ✅ WebSocket split: `/ws` (app control) and `/ws/acp` (ACP protocol)
- ✅ HTTP API for backend-controlled ACP orchestration:
  - `POST /api/acp/sessions` — sync session creation
  - `POST /api/acp/sessions/:id/prompt` — fire-and-forget prompt
  - `POST /api/acp/sessions/:id/cancel` — fire-and-forget cancel
- ✅ Backend WS broadcast + oneshot pattern for sync session creation
- ✅ Settings system: `~/.crow/crow-ui-settings.json` — WORKS, actively used
- ✅ Rebrand: murder-* → crow-ui (crate names, binary, electron, HTML title)
- ✅ Electron build + packaging (has Linux issues, see Known Issues)
- ✅ crow-cli agent state persists in `~/.crow/crow.db` (configurable path)

### Chat UI
- ✅ TipTap @-mentions (stable across renders via useMemo, module-level refs)
- ✅ Streamdown markdown rendering (no message bubbles — margins only)
- ✅ Mermaid diagram rendering with debounce
- ✅ User prompts DO appear in full-width container
- ✅ Monaco diff for read/edit/write file tools with hideUnchangedRegions
- ✅ Word wrap enabled by default in Monaco editors
- ✅ InlineTerminal renders xterm.js in chat for agent terminal tool calls
- ✅ Chat padding/margins fixed — looks professional
- ✅ Stop button exists (needs to merge with send + add queue behavior)
- ✅ Ultradark background fixed — dot pattern + glass textures, looks clean

### FlexLayout & Layout
- ✅ Split right/left/top/down via context menu on every pane
- ✅ Correct split: creates NEW session for chat tabs (not clone)
- ✅ Tab context menu via `onRenderTab` wrapping in shadcn ContextMenuTrigger

### Terminal
- ✅ xterm.js keyboard input fixed (Firefox `user-select: none` resolved)
- ✅ Ctrl+C, Ctrl+V, Ctrl+A work in terminal
- ✅ Terminal flexes with tab size
- ✅ PTY spawn via backend, rendering in frontend
- ✅ Shell environment resolution: `~/.bashrc` PATH/fnm/nvm injected into PTYs, agents, and exec commands

### Session Management
- ✅ ACP session IDs are REAL agent session IDs (not made-up `session-${Date.now()}`)
- ✅ `POST /api/acp/sessions` returns the actual agent session ID
- ✅ `acpStore.createSession()` returns real ID; store key separation for UI components

### Visual Polish
- ✅ Dot pattern / textured background overlay
- ✅ Proper padding throughout chat and explorer
- ✅ shadcn/ui + Tailwind + Radix integration
- ✅ Explorer directory selector UI polished
- ✅ Settings backend reads `crow-ui-settings.json`
- ✅ Professional quality UI — "screams professional"

### Testing
- ✅ Playwright e2e: ACP control flow (create → prompt → agent responds)
- ✅ Playwright e2e: Terminal rendering in chat inline terminal
- ✅ Playwright e2e: WebSocket split validation

### Workspace & Persistence
- ✅ Workspace auto-restore on page refresh
- ✅ `get_current_workspace` + `get_recent_workspaces` working

---

## 🔄 IN PROGRESS / ACTIVE

### Send/Stop/Queue Button Unification
- [ ] Send button + Stop button should be THE SAME button
- [ ] When agent is responding: button shows STOP (click cancels)
- [ ] When agent is idle + user is typing: button shows SEND (click sends)
- [ ] When agent is idle + user is NOT typing: button shows ADD TO QUEUE or disabled
- [ ] Queued messages visible in UI, can edit/delete before they fire

---

## ⏳ PENDING — Prioritized

### Phase 1: Backend State Ownership (ONGOING)
- [ ] Message queue in backend SQLite (not frontend) — queued messages survive refresh
- [ ] `acp-report-turn-complete` from frontend when agent finishes
- [ ] Auto-dequeue and send when turn completes
- [ ] Frontend is dumb view over backend state — migrate piece by piece as we touch features
- [ ] Session state (active, idle, tool-running) tracked in backend

### Phase 2: Dev/Prod Isolation
- [ ] Dev flag so we don't step on production crow-ui-server
- [ ] Dev binary name: `crow-ui-dev-server-<hash>` or similar
- [ ] Dev settings path: `~/.crow/crow-ui-dev-settings.json`
- [ ] Dev DB path: `~/.crow/crow-ui-dev.db`
- [ ] Configurable ports so dev + prod can run simultaneously

### Phase 3: Images & Previews
- [ ] Inline image rendering in chat markdown (agent returns image URLs/base64)
- [ ] Image preview on hover in chat
- [ ] Code preview on hover (mini Monaco popup)
- [ ] File preview panel for images in explorer

### Phase 4: Model Selector
- [ ] ACP exposes available models via protocol
- [ ] Frontend dropdown to select model per session
- [ ] Model info (context window, cost, capabilities) displayed

### Phase 5: Chat UI Polish
- [ ] Message queue UI (visual list of pending messages with edit/delete)
- [ ] Pre-empt buttons: "Send now" (cancels current + sends), "Remove from queue"
- [ ] Larger + resizable TipTap editor inside chat panel
- [ ] Copy assistant response as markdown document
- [ ] Export entire chat as markdown document
- [ ] Session reload via `session/load` with chat re-rendering

### Phase 6: IDE State & Layout Persistence
- [ ] FlexLayout JSON save/restore per workspace
- [ ] Last open directory opens by default on restart
- [ ] Directory selector: scroll to top on new selection
- [ ] File opening from explorer works reliably (no refresh needed)
- [ ] Remove glowing wand hover effect (if still present)

### Phase 7: Monaco Diff
- [ ] Revisit diff collapsing — was broken when we touched it
- [ ] Only show diff chunks (hide unchanged regions)
- [ ] Backend-driven diff state might make this less brittle

### Phase 8: Terminal
- [ ] Map ALL proper keyboard commands to xterm.js (full native terminal emulation)
- [ ] Terminal panel + chat terminal isolation (unique IDs per context)

### Phase 9: MCP Configuration
- [ ] UI section to add MCP server configs
- [ ] Test command button to verify MCP server runs
- [ ] Save MCP configs in `crow-ui-settings.json`

### Phase 10: Logging & Debugging
- [ ] Frontend error logging to backend (structured, not just console)
- [ ] Configurable log levels (behind flag/config)
- [ ] Stop logging every xterm.js keystroke to console

---

## 🐛 KNOWN ISSUES

1. **Electron on Linux**: Terminals don't show up in UI (separate from PATH issue).
2. **File opening from explorer**: Sometimes requires page refresh to see content. Race condition in FlexLayout tab creation vs content loading.
3. **Settings pane UI**: Backend reads config, frontend has no UI to modify settings yet. Must edit JSON by hand.
4. **Monaco diff**: Diff collapsing is fragile. We broke it once and reverted. Needs careful revisit.

---

## 📝 TECH DEBT

- `settings.ts` still exists in frontend with 329 lines — migrate to backend config piece by piece
- Some dead code from mosaic→flexlayout migration
- `murder-ide-v2` directory still exists with broken rebrand attempt — `murder-ide-working` is canonical
- `AGENTS.md` grew too large — keep concise, move detailed docs to `docs/` journal entries

- be super cool
