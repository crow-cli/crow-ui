# Release build embeds frontend inside rust binary
**CRITICAL**: The Rust binary embeds the frontend via `rust_embed` at **compile time**. This means:
1. You MUST rebuild the frontend first (`bun run build`)
2. Then rebuild the Rust binary (`cargo build --release --bin crow-ui-server`)
3. Only the release binary has the updated frontend baked in

```bash
cd crow-ui/frontend && bun run build
cd crow-ui && cargo build --release --bin crow-ui-server
cd crow-ui && ./target/release/crow-ui-server --port 3928
```

**NEVER test with the debug build** — it has stale frontend assets. Always test the release binary.

use playwright tools to test http://localhost:3928

## File Watcher Dynamic Directory Registration

### CRITICAL: New directories must be added to the watcher
`FileWatcher` uses `notify::RecommendedWatcher` with `RecursiveMode::NonRecursive` on each directory individually to stay within OS inotify limits. But `collect_watch_dirs` only walks the tree **once** at watcher startup. When a new directory is created later, it's **not watched**.

**Fix**: `FileWatcher` now exposes a `WatchHandle` (cloneable, thread-safe) with a `watch_dir(&Path)` method. When `WorktreeState` receives a `Created` event for a directory, it calls `watch_handle.watch_dir(&event.path)` to start watching the new directory. This means nested file changes are detected without page refresh.

```rust
// In WorktreeState::handle_watcher_events
FileEventKind::Created => {
    if event.path.is_dir() {
        watch_handle.watch_dir(&event.path);
    }
    // ...emit worktree-file-created event
}
```

### Frontend event handler pattern
The frontend `ExplorerPane` listens for `worktree-file-created` and `worktree-file-deleted` via `ws.onMessage()` (raw WebSocket handler). On receipt:
1. Clear `childCache` for the parent directory
2. Call `loadDir(root)` or `loadChildren(parentPath, true)` to re-read from disk

This keeps the explorer in sync with external filesystem changes.

## FlexLayout React Key Learnings

### CRITICAL: Must import base styles
`flexlayout-react/style/light.css` MUST be imported in index.css. Without it:
- `.flexlayout__tab_moveable` gets `position: static; height: 0px` instead of `position: relative; height: 100%`
- The portal content rendering condition `rect.height > 0` fails silently
- Factory function IS called but content never appears in DOM

### DO NOT override tab positioning
Never add `top: 0 !important; left: 0 !important;` to `.flexlayout__tab`. This forces all tabs to the same position, causing them to overlay each other. FlexLayout sets inline styles for positioning dynamically.

### DO NOT import alpha_dark.css with custom theme
Remove any `import "flexlayout-react/style/alpha_dark.css"` from App.tsx. Use `light.css` in index.css + custom dark overrides.

### CSS override order matters
FlexLayout overrides in index.css must come AFTER the `@import "flexlayout-react/style/light.css"` line.

### Working factory pattern
```tsx
const factory = (node: TabNode) => {
  const component = node.getComponent();
  switch (component) {
    case "editor": return <EditorPane ... />;
    case "terminal": return <TerminalPane ... />;
    default: return <div>Unknown: {component}</div>;
  }
};
<Layout model={model} factory={factory} />
```

### Sandbox for UI prototyping
`murder-ide/sandbox/modern-dark-theme/` - working flexlayout-react + Tailwind dark theme prototype at http://localhost:5173

## TipTap @-Mentions Key Learnings

### CRITICAL: Extension must be stable across renders
Never define TipTap extensions inside the component body. They get recreated every render but `useEditor` doesn't re-register them. **Always wrap in `useMemo(() => ..., [])`.**

### CRITICAL: Use refs for dynamic suggestion items
The `items` function in suggestion config is called at editor init time. If you pass a state array directly, it captures the empty initial value. **Use a module-level ref + getter function:**
```tsx
const itemsRef = { current: [] as PopupItem[] };
// In useEffect: itemsRef.current = computedItems;
// In suggestion config: makeSuggestionConfig(() => itemsRef.current)
```

### CRITICAL: Sync editable state after editor initializes
`useEditor({ editable: !disabled })` sets editable at creation time only. If `disabled` changes before editor is ready, it stays false forever. **Add a useEffect:**
```tsx
useEffect(() => { editor?.setEditable(!disabled); }, [editor, disabled]);
```

### Suggestion config pattern
```tsx
function makeSuggestionConfig(getItems: () => PopupItem[]) {
  return {
    items: ({ query }) => {
      const allItems = getItems(); // reads current ref value
      // ...filter logic
    },
    render: () => { /* tippy popup setup */ }
  };
}
```

## FlexLayout Tab Context Menu (Right-Click Split)

### Wrapping tabs in ContextMenu via onRenderTab
Use FlexLayout's `onRenderTab` callback to wrap each tab's content in a shadcn `ContextMenuTrigger`:
```tsx
onRenderTab={(node: TabNode, renderValues: ITabRenderValues) => {
  renderValues.leading = getTabIcon(node.getName());
  const originalContent = renderValues.content;
  renderValues.content = (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex-1 h-full flex items-center min-w-0">
          {originalContent}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>...</ContextMenuContent>
    </ContextMenu>
  );
}}
```

### Splitting tabs — use Actions.addNode on the TabSetNode with DockLocation.RIGHT/LEFT
**CRITICAL**: `Actions.addNode()` always creates a `TabNode`, never a `TabSetNode`. Passing a tabset JSON results in "[Unnamed Tab]".

**Correct approach for splitting**: Pass the TAB JSON (not tabset JSON) to `Actions.addNode()` with the **TabSetNode** as the target and `DockLocation.RIGHT/LEFT`. FlexLayout's `TabSetNode.drop()` auto-wraps the new tab in a TabSetNode:
```tsx
const newTabJson = { type: "tab", id: newTabId, name: tabName, component, config };
// Add to the TABSET (not parent row) with RIGHT/LEFT location
// FlexLayout wraps it in a new TabSetNode and splits the layout
model.doAction(Actions.addNode(newTabJson, tabset.getId(), DockLocation.RIGHT, -1, true));
```

**For chat tabs specifically**: Create a NEW session, don't clone the existing one:
```tsx
if (component === "chat") {
  const sessionId = `session-${Date.now()}`;
  acpStore.createSession(sessionId, agentConfig, workspaceRoot);
  newConfig = { sessionId };
  newName = "Agent Chat"; // fresh name, not cloned
}
```

### Creating a new tabset when none exists
When no target tabset exists (e.g., all chat tabs closed), add the tab to the **RowNode** with `DockLocation.RIGHT`. FlexLayout wraps it in a TabSetNode:
```tsx
// Find the center row (parent of editor-tabset)
const centerRow = editorTabset.getParent();
// Add tab to the ROW with RIGHT location — auto-wraps in TabSetNode
model.doAction(Actions.addTab(tabJson, centerRow.getId(), DockLocation.RIGHT, -1, true));
```

### Closing tabs with cleanup
Always call `Actions.deleteTab(nodeId)` to remove tabs. For custom cleanup (e.g., closing ACP sessions), check the tab type before deleting:
```tsx
if (node.getType() === "tab") {
  const tabNode = node as TabNode;
  if (tabNode.getComponent() === "chat") { /* cleanup */ }
}
model.doAction(Actions.deleteTab(nodeId));
```

### Splitting tabs programmatically — DO NOT use Actions.addNode with tabset JSON
**CRITICAL BUG**: `Actions.addNode()` (which calls `Actions.addTab()`) always creates a `TabNode`, even when passed a tabset JSON. The tab's `name` attribute defaults to `"[Unnamed Tab]"` because it reads from the top-level JSON where `name` doesn't exist (it's nested in `children[0].name`).

**Correct approach**: Export the model to JSON, insert the new tabset directly into the JSON tree, then reload:
```tsx
const splitTab = useCallback((direction: "right" | "left", nodeId: string) => {
  const model = layoutModelRef.current;
  if (!model) return;
  const tabNode = model.getNodeById(nodeId);
  if (!tabNode) return;
  const tabset = tabNode.getParent();
  const grandparent = tabset.getParent();
  if (!grandparent) return;

  const newTabsetId = `split-ts-${Date.now()}`;
  const newTabId = `split-tab-${Date.now()}`;
  const tabJson = (tabNode as any).toJson();
  const newTabJson = { ...tabJson, id: newTabId, name: tabNode.getName() };
  const newTabsetJson = { type: "tabset", id: newTabsetId, weight: 50, children: [newTabJson] };

  // Modify JSON directly and reload model
  const currentJson = model.toJson();
  // ...insert newTabsetJson into currentJson.layout at the correct position...
  const newModel = Model.fromJson(currentJson);
  newModel.setOnAllowDrop(onAllowDrop);
  layoutModelRef.current = newModel;
  setModelJson(currentJson);
}, []);
```

### Closing tabs with cleanup
Always call `Actions.deleteTab(nodeId)` to remove tabs. For custom cleanup (e.g., closing ACP sessions), check the tab type before deleting:
```tsx
if (node.getType() === "tab") {
  const tabNode = node as TabNode;
  if (tabNode.getComponent() === "chat") { /* cleanup */ }
}
model.doAction(Actions.deleteTab(nodeId));
```

## Workspace Restore on Refresh

### Backend-first approach
The frontend queries the backend for workspace state on load, rather than keeping it in frontend state alone:
1. `get_current_workspace` — returns in-memory workspace (survives page reload, not server restart)
2. `get_recent_workspaces` — returns SQLite-persisted list (survives server restart)

### Frontend auto-restore pattern
```tsx
const restoredRef = useRef(false);

useEffect(() => {
  if (!connected || !modelJson || restoredRef.current) return;
  restoredRef.current = true;

  (async () => {
    // Try in-memory first (page reload, same server session)
    const current = await ws.invoke<{ workspace?: string | null }>(
      "get_current_workspace", {}
    );
    let path = current.workspace;

    // Fall back to SQLite (server restarted)
    if (!path) {
      const recent = await ws.invoke<Array<{ path: string }>>(
        "get_recent_workspaces", { limit: 1 }
      );
      if (recent && recent.length > 0) path = recent[0].path;
    }

    if (path) await handleOpenFolder(path);
  })();
}, [connected, modelJson]);
```

### Critical: response format mismatch
`get_recent_workspaces` returns a **raw JSON array**, not `{ entries: [...] }`. The frontend must handle the array directly:
```tsx
// WRONG — backend returns array, not object
const recent = await ws.invoke<{ entries?: Array<...> }>(...);
if (recent.entries && recent.entries.length > 0) { ... }

// CORRECT
const recent = await ws.invoke<Array<{ path: string }>>(...);
if (recent && recent.length > 0) { ... }
```

## TipTap Editor Newline Handling

### Shift+Enter inserts hardBreak, Enter sends
The TipTap editor uses a custom `SendOnEnter` extension:
- **Enter**: sends the message
- **Shift+Enter**: inserts a `hardBreak` node (single `\n`)
- **Double Shift+Enter**: creates paragraph break (double `\n`)

### Extracting content blocks with newlines
The `extractContentBlocks` function handles:
- `paragraph` nodes: text content joined with `\n\n` between paragraphs
- `hardBreak` nodes: single `\n`
- `mention` nodes: resource links
- `image` nodes: base64 images

```tsx
function extractContentBlocks(doc: unknown): ContentBlock[] {
  // ...process paragraphs with \n\n between them
  // ...process hardBreak as single \n
  // Merge adjacent text blocks
}
```

### Auto-scroll to keep cursor visible
When typing multi-line text, auto-scroll keeps the cursor in view:
```tsx
useEffect(() => {
  if (!editor || !editorRef.current) return;
  const container = editorRef.current;
  const handleUpdate = () => {
    const { state } = editor;
    const endPos = state.doc.content.size;
    const selEnd = state.selection.to;
    if (selEnd < endPos - 2) return; // only scroll if cursor near end
    requestAnimationFrame(() => {
      const coords = editor.view.coordsAtPos(selEnd);
      const containerRect = container.getBoundingClientRect();
      if (coords.bottom > containerRect.bottom - 8) {
        container.scrollTop = container.scrollHeight;
      }
    });
  };
  editor.on("update", handleUpdate);
  return () => { editor.off("update", handleUpdate); };
}, [editor]);
```

## Chat Queue Button Fix

### Problem: Send button becomes Stop button during streaming
When `isStreaming` is true, the send button (➤) becomes a stop button (⏹). This prevents users from queuing messages while the agent is responding.

### Solution: Dual-mode button based on editor content
When streaming:
- If editor is **empty**: show ⏹ stop button (calls `onCancel`)
- If editor has **content**: show ➤ send button (calls `handleSendClick`, which queues the message)

```tsx
// Track editor content in real-time
const [hasEditorContent, setHasEditorContent] = useState(false);
useEffect(() => {
  if (!editor) return;
  const checkContent = () => {
    const json = editor.getJSON();
    const blocks = extractContentBlocks(json);
    const has = blocks.some((b) => {
      if (b.type === "text") return (b.text || "").trim().length > 0;
      return true;
    });
    setHasEditorContent(has);
  };
  checkContent();
  editor.on("update", checkContent);
  return () => { editor.off("update", checkContent); };
}, [editor]);

// Button renders based on both streaming state AND editor content
<Button
  variant={isStreaming && !hasEditorContent ? "destructive" : "default"}
  onClick={isStreaming && !hasEditorContent ? handleCancelClick : handleSendClick}
>
  {isStreaming && !hasEditorContent ? "⏹" : "➤"}
</Button>
```

### Testing the queue feature
To test queuing, you must send a second message **while the agent is still responding** to the first. The agent responds quickly, so use rapid successive sends:
```ts
await page.keyboard.type('First message');
await page.keyboard.press('Enter');
await page.waitForTimeout(50); // minimal delay
await page.keyboard.type('Second message');
await page.keyboard.press('Enter');
```

## Backend-Owned Queue State

### Architecture
The queue is owned by the backend `AcpSession`, not frontend React state.
- `AcpSession` holds `queued_items: Arc<Mutex<Vec<QueuedItem>>>`
- Three prompt behaviors: `AddToQueue`, `SkipQueueAndRun`, `CancelAllAndRun`
- Backend auto-drains queue after each prompt completion (`drain_queue()` loops until empty)

### HTTP API
- `POST /api/acp/sessions/:id/prompt` — accepts `behavior` field (default: `add_to_queue`)
- `GET /api/acp/sessions/:id/queue` — returns `{ items: QueuedItem[] }`
- `POST /api/acp/sessions/:id/queue` — body `{ action: "add|remove|update|clear|reorder", ... }`

### WebSocket events
- Backend broadcasts `sessionUpdate: "queue_changed"` with full `items` array on every mutation
- Frontend `acp-store.ts` handles `queue_changed` and updates `sessionState.queuedItems`
- Backend broadcasts `sessionUpdate: "user_message_chunk"` when a prompt is actually dispatched (from `run_prompt`), so the frontend no longer invents user messages

### Frontend pattern
```tsx
// ChatPane derives queue from store subscription — NO local useState
const [queuedItems, setQueuedItems] = useState<QueuedItem[]>([]);
useEffect(() => {
  const s = acpStore.getSession(activeSessionId);
  setQueuedItems(s.queuedItems);
  const unsub = acpStore.subscribeToSession(activeSessionId, () => {
    setQueuedItems(acpStore.getSession(activeSessionId).queuedItems);
  });
  return unsub;
}, [activeSessionId]);

// Send always uses add_to_queue — backend decides idle vs running
const handleSend = useCallback((blocks: ContentBlock[]) => {
  acpStore.prompt(effectiveSessionId, blocks, "add_to_queue");
}, [effectiveSessionId]);

// QueueBar actions call backend endpoints
const removeQueuedItem = useCallback((id: string) => {
  acpStore.queueRemove(effectiveSessionId, id);
}, [effectiveSessionId]);
```

### Key rule
NEVER maintain a parallel `queuedItems` in component state. The backend is the source of truth; the frontend is a passive viewer.

## Playwright Visual Testing Harness

### Setup
```bash
cd crow-ui/frontend
bun add -D @playwright/test
npx playwright install chromium
```

### Test pattern — inject synthetic content, screenshot, verify
```ts
test("markdown renders with cyberpunk styling", async ({ page }) => {
  await page.goto(BASE_URL);
  await page.waitForTimeout(2500); // wait for auto-restore

  const messages = page.locator('[data-testid="chat-messages"]');
  await messages.evaluate((el) => {
    el.innerHTML = `...synthetic markdown...`;
  });
  await page.waitForTimeout(500);

  await messages.screenshot({ path: "e2e/screenshots/chat-markdown.png" });
});
```

### Running tests
```bash
# Server must be running first
cd crow-ui/frontend && npx playwright test
```

### Key testing principles
1. Always add `data-testid` attributes to components under test
2. Inject synthetic content for visual regression (don't depend on ACP agent)
3. Screenshots go to `e2e/screenshots/` for manual review
4. Tests run in parallel by default; use `--workers=1` if order matters

## Agent Configuration UI Pane

### CRITICAL: Never nest interactive elements inside `<button>`
A delete button (✕) inside a `<button>` row doesn't work because clicking any child of a `<button>` triggers the parent's `onClick`. The inner element's `stopPropagation()` doesn't prevent this.

**Fix**: Use `<div>` with `cursor-pointer` for the row, and a separate `<button>` for the delete action:
```tsx
<div className="group flex items-center cursor-pointer" onClick={() => select(id)}>
  <span className="flex-1">{name}</span>
  <button
    className="opacity-0 group-hover:opacity-100"
    onClick={(e) => { e.stopPropagation(); deleteAgent(id); }}
  >
    ✕
  </button>
</div>
```

### CRITICAL: Update selection key when editing the ID field
When an item's ID is both its display key AND its selection key, changing the ID breaks the selection linkage.

**Fix**: Update `selectedAgentId` atomically with the data change:
```tsx
onChange={(e) => {
  const newId = e.target.value;
  setAgents((prev) =>
    prev.map((a) => (a.id === selectedAgentId ? { ...a, id: newId } : a))
  );
  setSelectedAgentId(newId);
  setHasChanges(true);
}}
```

### Settings change broadcast gap
When `AgentConfigPane` saves to settings via `settings.updateSetting()`, other components (like `ChatPane`) don't auto-reload. They read settings once on mount.

**Workaround**: Page refresh picks up new settings. For live sync, add a settings-change event bus or have components subscribe to settings updates.
