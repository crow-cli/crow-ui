# crow-ui Living Plan

This is the active development roadmap. Items are ordered by priority. Completed work moves to the bottom "Archive" section.

## Philosophy

- **Backend owns state**: The frontend is a passive viewer. State lives in Rust, persists to SQLite/JSON, and survives refresh.
- **Shadcn UI + Tailwind**: All UI components use shadcn/ui primitives styled with Tailwind CSS variables. No one-off CSS.
- **FlexLayout for everything**: Panes, panels, splits — all FlexLayout. No modals for configuration.
- **Real agents only**: Tests spawn actual `crow-cli acp` processes. No mocks.

---

## 🔥 Current Sprint

### 1. Chat Scroll Control

**Goal**: When the agent is streaming a response, if the user scrolls up to read earlier content, the auto-scroll should pause and let the user stay where they are.

**Current behavior**: Auto-scroll always jumps to bottom on new chunks.

**Desired behavior**:
- If user is at the bottom (within ~50px of scroll end), auto-scroll keeps them at bottom
- If user has scrolled up, auto-scroll pauses
- When user scrolls back to bottom, auto-scroll resumes
- Visual indicator (e.g., "New messages ↓") when content is added while scrolled up

**Implementation**:
- Track scroll position in `ChatPane` messages container
- Compare scrollTop + clientHeight vs scrollHeight
- Only call `scrollIntoView` if user was near bottom
- Add floating "Jump to bottom" button that appears when scrolled up and new content arrives

### 2. Image Rendering in Chat

**Goal**: Render image content blocks inline in chat — both from ACP tool results and pasted/uploaded images.

**Current behavior**: Image content blocks are not handled in `MessageGroup`. ACP tools that return images (screenshots, generated images, etc.) show as broken/empty content.

**Desired behavior**:
- `image` type content blocks from ACP tool results render as `<img>` tags inline
- Support base64 data URLs and remote URLs
- Click to expand/lightbox view
- Max height constraint with click-to-expand

**Implementation**:
- Add `image` case to `MessageGroup` switch in `ChatPane.tsx`
- Create `ImageMessage` component with max-height CSS
- Lightbox on click (shadcn Dialog or custom)

### 3. Copy/Paste Screenshots into MessageEditor

**Goal**: Paste images from clipboard directly into the TipTap editor.

**Current behavior**: Paste probably inserts nothing or plain text.

**Desired behavior**:
- Ctrl+V with image in clipboard inserts image into editor
- Image is uploaded/converted to base64 and stored as `image` content block
- Visual thumbnail shown in editor
- On send, image block is included in the prompt

**Implementation**:
- Add `onPaste` handler to TipTap editor props
- Read clipboard data as `DataTransfer`
- Convert image blob to base64 data URL
- Insert `image` node via TipTap `setImage` command
- On send, extract image blocks alongside text blocks

### 4. Rich Text Editor State → Backend

**Goal**: Move more MessageEditor state to backend.

**Current concerns**:
- `editingDraft` is frontend-only state
- Editor content is lost on refresh
- No way to resume a draft across sessions

**Approach**:
- Store drafts per-chat-tab in backend SQLite
- Auto-save draft every few seconds
- Restore draft when tab reopens
- This is lower priority than the other items

---

## 📋 Backlog

### Bottom Bar Cleanup
- Remove "Minimize all editors", "Minimize all terminals", "Minimize all chats" buttons from status bar
- Remove "Hide Explorer" button
- Minimizing explorer should be done by clicking the Explorer activity tab on the sidebar
- This simplifies the UI and removes assumptions about component-type → tabset mapping

### expandedDirs → Backend Persistence
- `ExplorerPane` `expandedDirs` should load from/save to `get_explorer_state` / `save_explorer_state`
- Currently lost on every refresh

### dirtyFiles → Backend Document State
- Frontend `dirtyFiles: Set<string>` in `App.tsx` should be derived from backend `document_get_info`
- Backend should broadcast `dirty-changed` events

### pendingPermission Removal
- User explicitly said "permissions are garbage I don't even want them in the code"
- Strip all permission request UI and state from frontend
- Remove `pendingPermission` from backend session state

### Markdown Preview
- Eye icon toggle for markdown files in editor pane
- Render markdown preview side-by-side or in-place
- Reuse mystmd spec rendering code

### MCP Server Configuration UI
- CRUD MCP server configs (command, args, env key:value pairs)
- Each MCP server: id, name, command, args[], env{}, enabled
- Side-by-side key:value inputs for env (like proper UI)
- Agent config pane shows toggles for which MCP servers to enable per-agent
- On session init, enabled MCP servers passed to agent via ACP protocol

### Content Rendering (Images + Markdown + Web)
- **Image content blocks from ACP tools**: Render inline in chat when tools return `image` content blocks (base64 or URLs)
- **Image viewing in editor**: Click an image in any rendered content to view full-size (lightbox). Images in rich text editor render inline as thumbnails.
- **Markdown file preview**: Eye icon toggle for `.md` files in editor pane — render with Streamdown instead of raw text
- **Streamdown link controls**: Strip out all link click controls from Streamdown. We handle controls ourselves.
- **Web view (iframe)**: Simple iframe-based renderer for web content (searxng, fetched webpages). Not a full browser engine — just an iframe FlexLayout pane type.

### Rich Text Editor → Standalone WYSIWYG Component
- **Goal**: The TipTap-based editor becomes a reusable WYSIWYG component that generates markdown (mystmd)
- **Split from chat**: Toggle/button to pop the editor out into its own FlexLayout pane. Same component, different container. Session ID tracked so it knows which chat to send to.
- **Inline images**: Paste or drop images into the editor, render as thumbnails inline
- **Drag-and-drop pane**: Editor can be a standalone FlexLayout tab type (`wysiwyg-editor`) that recycles the same code
- **Not just for chat**: Use it for note-taking, document drafting, anywhere we need rich text input

### Settings UI Pane
- General settings editor (theme, font size, word wrap, etc.)
- Same pattern as Agent Configuration UI: FlexLayout pane, shadcn components

---

## ✅ Archive

### Backend Queue Ownership
- `AcpSession` owns `Vec<QueuedItem>` with full CRUD + reorder
- Three prompt behaviors: `add_to_queue`, `skip_queue_and_run`, `cancel_all_and_run`
- Backend auto-drains queue after prompt completion
- Frontend derives queue from `queue_changed` WS events

### MessageEditor Layout Fix
- Restructured from absolute-positioned bottom bar to flex column
- Scrollable editor content area + fixed bottom bar
- Text no longer overlaps controls

### Agent Config Dropdown
- Chat header shows agent selector when disconnected
- Loads `acp.agents` from settings on mount

### @-Mentions with Filesystem Context
- Typing `@` in MessageEditor shows real workspace files
- Files grouped by parent directory in popup
- Selection inserts mention chip (🔗 filename)
- On send, converts to `resource_link` content block
- Fix: Added missing `char: "@"` to `makeSuggestionConfig`

### Agent Configuration UI Pane
- FlexLayout component type `"agent-config"` registered in factory
- Opened via Command Palette (Ctrl+Shift+P) → "Agent Configuration"
- Left sidebar: agent list with New/Delete buttons
- Right panel: form editor (name, id, command, args[])
- Args: individual input rows with +Add / ✕Remove buttons
- `env` removed entirely — not used, will re-add later for auth
- MCP Servers section with toggle switches (when configured)
- Save Changes button appears on modifications
- Settings persisted to `~/.crow/crow-ui-settings.json`
- Bugs fixed:
  - Delete button nested inside `<button>` — changed to `<div>` + separate `<button>`
  - ID editing broke selection — updated `selectedAgentId` atomically with data change
