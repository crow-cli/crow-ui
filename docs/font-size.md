# Font Size Configuration in crow-ui

> Reference architecture doc for the layered settings system, current font-size behavior across the IDE, and proposed changes to make typography fully configurable.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
  - [Backend: `crow-ui-settings`](#backend-crow-ui-settings)
  - [Frontend: `lib/settings.ts`](#frontend-libsettingsts)
  - [Persistence Model](#persistence-model)
  - [Change Propagation](#change-propagation)
- [Current Defaults](#current-defaults)
  - [Editor](#editor)
  - [Terminal](#terminal)
  - [UI / Chrome](#ui--chrome)
- [Where to Change Font Sizes Today](#where-to-change-font-sizes-today)
  - [Option A: User Settings File (`crow-ui-settings.json`)](#option-a-user-settings-file-crow-ui-settingsjson)
  - [Option B: In-App Settings Pane](#option-b-in-app-settings-pane)
  - [Option C: Built-In Defaults](#option-c-built-in-defaults)
- [Current Implementation Gaps](#current-implementation-gaps)
  - [Gap 1: Editor Does Not React to Live Changes](#gap-1-editor-does-not-react-to-live-changes)
  - [Gap 2: Terminal Font Size Ignores Backend Default](#gap-2-terminal-font-size-ignores-backend-default)
  - [Gap 3: UI Chrome Has No Settings Keys](#gap-3-ui-chrome-has-no-settings-keys)
- [Proposed Changes](#proposed-changes)
  - [Patch A: Live Editor Font-Size Updates](#patch-a-live-editor-font-size-updates)
  - [Patch B: Terminal Font Size from Settings](#patch-b-terminal-font-size-from-settings)
  - [Patch C: UI Font-Size Settings](#patch-c-ui-font-size-settings)
- [Appendix: File Reference](#appendix-file-reference)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React/TS)                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │   EditorPane    │  │  TerminalPane   │  │   ExplorerPane  │ │
│  │  (Monaco)       │  │  (xterm.js)     │  │  (React tree)   │ │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘ │
│           │                    │                    │          │
│  ┌────────┴────────────────────┴────────────────────┴────────┐ │
│  │              lib/settings.ts  (cache + RPC)                │ │
│  │   • getSetting(key)      → invoke("get_setting")           │ │
│  │   • updateSetting(key)   → invoke("update_setting")        │ │
│  │   • subscribe(fn)        ← ws "settings-changed"           │ │
│  └─────────────────────────────┬──────────────────────────────┘ │
│                                │ WebSocket                      │
└────────────────────────────────┼────────────────────────────────┘
                                 │
┌────────────────────────────────┼────────────────────────────────┐
│                        BACKEND (Rust/Tokio)                     │
│                                │                                │
│  ┌─────────────────────────────┴──────────────────────────────┐ │
│  │              crow-ui-server  (WebSocket handlers)            │ │
│  │   • handle_get_setting()                                     │ │
│  │   • handle_update_setting()  → persist + broadcast           │ │
│  └─────────────────────────────┬──────────────────────────────┘ │
│                                │                                │
│  ┌─────────────────────────────┴──────────────────────────────┐ │
│  │              crow-ui-settings  (layered store)               │ │
│  │   workspace_layer ──╮                                        │ │
│  │   user_layer ───────┼──► get_raw(key) → resolved Value      │ │
│  │   default_layer ────╯                                        │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                │                                │
│                         ~/.crow/crow-ui-settings.json            │
└─────────────────────────────────────────────────────────────────┘
```

### Backend: `crow-ui-settings`

The settings crate lives at [`backend/crates/crow-ui-settings/`](../backend/crates/crow-ui-settings/).

| Module | File | Responsibility |
|--------|------|----------------|
| `Settings` | [`src/settings.rs`](../backend/crates/crow-ui-settings/src/settings.rs) | Layered store with `get()`, `set()`, `on_change()` |
| `defaults` | [`src/defaults.rs`](../backend/crates/crow-ui-settings/src/defaults.rs) | Built-in defaults (350+ keys, VS Code parity) |
| `schema` | [`src/schema.rs`](../backend/crates/crow-ui-settings/src/schema.rs) | Type validation, min/max bounds, enum checking |
| `jsonc` | [`src/jsonc.rs`](../backend/crates/crow-ui-settings/src/jsonc.rs) | Parse/write JSONC with comments |

Lookup order (highest priority wins):

1. `workspace_layer` — loaded from workspace `.vscode/settings.json` (optional)
2. `user_layer` — loaded from `~/.crow/crow-ui-settings.json`
3. `default_layer` — compiled into the binary via [`builtin_defaults()`](../backend/crates/crow-ui-settings/src/defaults.rs)

The `Settings::lookup()` method tries **flat keys first** (e.g. `"editor.fontSize"`) and falls back to nested traversal:

```rust
// backend/crates/crow-ui-settings/src/settings.rs
fn lookup<'a>(layer: &'a Value, key: &str) -> Option<&'a Value> {
    let obj = layer.as_object()?;
    // 1. Flat lookup: "editor.fontSize" as a top-level key
    if let Some(v) = obj.get(key) {
        return Some(v);
    }
    // 2. Nested traversal: {"editor": {"fontSize": 14}}
    let parts: Vec<&str> = key.split('.').collect();
    // ...
}
```

### Frontend: `lib/settings.ts`

The frontend API is [`frontend/src/lib/settings.ts`](../frontend/src/lib/settings.ts).

```typescript
// One-shot fetch (falls back to default if key missing)
const size = await settings.getSetting<number>("editor.fontSize", 14);

// Persist and broadcast to all clients
await settings.updateSetting("editor.fontSize", 16);

// Reactive subscription (invalidates cache on "settings-changed" WS event)
const unsubscribe = settings.subscribe(() => {
  console.log("Settings changed — new editor.fontSize:",
    settings.getSettings().editor.fontSize);
});
```

The cache is a deep-merged `IdeSettings` object:

```typescript
// frontend/src/lib/settings.ts
export interface IdeSettings {
  editor: EditorSettings;        // fontSize, wordWrap, minimap, ...
  languages: LanguageSettings;   // per-language overrides
  intellisense: IntellisenseSettings;
  terminal: TerminalSettings;    // shell, fontSize
  explorer: ExplorerSettings;    // showHiddenFiles
  folderPicker: FolderPickerSettings;
}
```

### Persistence Model

| Layer | File | Format | Written By |
|-------|------|--------|------------|
| Default | Binary | `serde_json::Value` (flat keys) | [`defaults.rs`](../backend/crates/crow-ui-settings/src/defaults.rs) at compile time |
| User | `~/.crow/crow-ui-settings.json` | JSONC (comments + trailing commas) | [`handle_update_setting()`](../backend/crates/crow-ui-server/src/handlers.rs) at runtime |
| Workspace | `.vscode/settings.json` (conventional) | JSONC | Not yet implemented in `AppState` |

### Change Propagation

When a setting is updated via `updateSetting()`:

1. Backend writes to user layer in memory
2. Backend persists to `~/.crow/crow-ui-settings.json`
3. Backend broadcasts `settings-changed` WebSocket notification
4. All connected frontends invalidate cache and reload

```rust
// backend/crates/crow-ui-server/src/handlers.rs
pub fn handle_update_setting(state: &AppState, req: UpdateSettingRequest)
    -> Result<UpdateSettingResponse, String>
{
    let mut s = state.settings.lock();
    s.set(&req.key, req.value.clone());

    // 1. Persist
    let settings_path = state.config_dir.join("crow-ui-settings.json");
    s.save_user(&settings_path).map_err(|e| ...)?;

    // 2. Broadcast
    let _ = state.settings_events_tx.send(req.key);

    Ok(UpdateSettingResponse { success: true })
}
```

---

## Current Defaults

### Editor

Defined in [`backend/crates/crow-ui-settings/src/defaults.rs`](../backend/crates/crow-ui-settings/src/defaults.rs):

```rust
fn add_editor_defaults(m: &mut Map<String, Value>) {
    ins(m, "editor.fontSize", json!(14));
    ins(m, "editor.fontFamily", json!("Consolas, 'Courier New', monospace"));
    ins(m, "editor.fontWeight", json!("normal"));
    ins(m, "editor.lineHeight", json!(0));
    ins(m, "editor.letterSpacing", json!(0));
    // ...
}
```

Monaco initialization in [`frontend/src/components/EditorPane.tsx`](../frontend/src/components/EditorPane.tsx):

```typescript
monaco.editor.create(containerRef.current, {
  // ...
  fontSize: readOnly ? 12 : 14,   // hardcoded fallback during init
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  // ...
});
```

Then later:

```typescript
settings.getSetting<number>("editor.fontSize", 14).then((size) => {
  if (size !== undefined) {
    editor.updateOptions({ fontSize: size });
  }
});
```

### Terminal

Backend default:

```rust
// backend/crates/crow-ui-settings/src/defaults.rs
ins(m, "terminal.integrated.fontSize", json!(14));
```

Frontend hardcoded override:

```typescript
// frontend/src/lib/settings.ts  (DEFAULT_SETTINGS)
terminal: {
  shell: "",
  fontSize: 13,   // ← overrides the backend default of 14
}
```

And in [`frontend/src/components/TerminalPane.tsx`](../frontend/src/components/TerminalPane.tsx):

```typescript
// xterm.js options
const term = new Terminal({
  fontSize: 13,   // hardcoded
  // ...
});
```

### UI / Chrome

None of the UI chrome (sidebar, tabs, breadcrumbs, buttons) reads from settings. All values are hardcoded inline:

| Component | File | Hardcoded Size |
|-----------|------|----------------|
| Tab bar | [`App.tsx:1481`](../frontend/src/App.tsx) | `fontSize: 11` |
| Explorer tree | [`ExplorerPane.tsx:461`](../frontend/src/components/ExplorerPane.tsx) | `fontSize: 13` |
| Explorer items | [`ExplorerPane.tsx:531`](../frontend/src/components/ExplorerPane.tsx) | `fontSize: 13` |
| File view header | [`FileViews.tsx:57`](../frontend/src/components/FileViews.tsx) | `fontSize: 11` |
| Settings editor | [`SettingsPane.tsx:103`](../frontend/src/components/SettingsPane.tsx) | `fontSize: 13` |
| Inline terminal | [`InlineTerminal.tsx:95`](../frontend/src/components/InlineTerminal.tsx) | `fontSize: 12` |

---

## Where to Change Font Sizes Today

### Option A: User Settings File (`crow-ui-settings.json`)

Edit `~/.crow/crow-ui-settings.json` (JSONC format):

```jsonc
// Crow UI Settings
// JSONC format — comments and trailing commas supported

{
  "editor": {
    "fontSize": 16,
    "fontFamily": "JetBrains Mono, monospace"
  },
  "terminal": {
    "integrated": {
      "fontSize": 15
    }
  }
}
```

On next app start the backend loads this file via [`AppState::with_config_dir()`](../backend/crates/crow-ui-server/src/state.rs):

```rust
let mut settings = Settings::new();
maybe_migrate_settings(&mut settings, &settings_path);
if settings_path.exists() {
    let _ = settings.load_user(&settings_path);
}
```

### Option B: In-App Settings Pane

The Settings panel ([`frontend/src/components/SettingsPane.tsx`](../frontend/src/components/SettingsPane.tsx)) is a Monaco JSONC editor that reads/writes the same `~/.crow/crow-ui-settings.json` file via `fsApi.readFile` / `fsApi.writeFile`.

Steps:
1. Open Settings panel (gear icon or `Ctrl+,` if bound)
2. Edit the JSONC
3. Press **Save** (validates JSON, strips comments, writes to disk, calls `settings.loadSettings()`)

### Option C: Built-In Defaults

Change the compiled-in defaults for all users:

```rust
// backend/crates/crow-ui-settings/src/defaults.rs
fn add_editor_defaults(m: &mut Map<String, Value>) {
    ins(m, "editor.fontSize", json!(16));  // was 14
    // ...
}
```

Then rebuild the backend:

```bash
cd backend
cargo build --release
```

---

## Current Implementation Gaps

### Gap 1: Editor Does Not React to Live Changes

**Problem**: `EditorPane.tsx` fetches `editor.fontSize` **once on mount**. If the user changes the setting while the editor is open, nothing happens until the tab is closed and reopened.

**Evidence**:

```typescript
// frontend/src/components/EditorPane.tsx
useEffect(() => {
  const editor = editorRef.current;
  if (!editor || readOnly) return;

  settings.getSetting<number>("editor.fontSize", 14).then((size) => {
    if (size !== undefined) {
      editor.updateOptions({ fontSize: size });
    }
  });
}, []);   // ← empty deps = run once only
```

The `settings.subscribe()` mechanism exists and works, but `EditorPane` does not use it.

### Gap 2: Terminal Font Size Ignores Backend Default

**Problem**: `TerminalPane.tsx` hardcodes `fontSize: 13` and never reads `terminal.integrated.fontSize` from the backend.

**Evidence**:

```typescript
// frontend/src/components/TerminalPane.tsx
const term = new Terminal({
  fontSize: 13,   // hardcoded
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  // ...
});
```

The `DEFAULT_SETTINGS.terminal.fontSize = 13` in `lib/settings.ts` also diverges from the backend default of `14`.

### Gap 3: UI Chrome Has No Settings Keys

**Problem**: Explorer, tabs, breadcrumbs, and other UI surfaces have no corresponding setting keys. They are all hardcoded CSS-in-JS values.

There are **no keys** like:
- `workbench.tree.fontSize`
- `workbench.tab.fontSize`
- `workbench.sideBar.fontSize`

---

## Proposed Changes

### Patch A: Live Editor Font-Size Updates

Make `EditorPane` subscribe to settings changes and update Monaco options reactively.

**File**: [`frontend/src/components/EditorPane.tsx`](../frontend/src/components/EditorPane.tsx)

Replace the single-fetch effect (around line 237):

```typescript
// BEFORE (one-shot)
useEffect(() => {
  const editor = editorRef.current;
  if (!editor || readOnly) return;

  settings.getSetting<number>("editor.fontSize", 14).then((size) => {
    if (size !== undefined) {
      editor.updateOptions({ fontSize: size });
    }
  });
}, []);
```

With a reactive subscriber:

```typescript
// AFTER (live updates)
useEffect(() => {
  const editor = editorRef.current;
  if (!editor || readOnly) return;

  // Apply initial value from cache (avoids async flash)
  const initial = settings.getSettings().editor.fontSize;
  editor.updateOptions({ fontSize: initial });

  // Subscribe to future changes
  const unsubscribe = settings.subscribe(() => {
    const size = settings.getSettings().editor.fontSize;
    editor.updateOptions({ fontSize: size });
  });

  return unsubscribe;
}, [readOnly]);
```

> Note: `settings.getSettings()` reads from the local cache (synchronous). The cache is populated by `initSettings()` at app startup. If the cache is stale, the next `settings-changed` event will reload it and the subscriber will fire.

### Patch B: Terminal Font Size from Settings

**File**: [`frontend/src/components/TerminalPane.tsx`](../frontend/src/components/TerminalPane.tsx)

Read `terminal.integrated.fontSize` from settings instead of hardcoding.

```typescript
import * as settings from "../lib/settings";

// Inside component init
useEffect(() => {
  const fontSize = settings.getSettings().terminal.fontSize ?? 14;

  const term = new Terminal({
    fontSize,
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    // ...
  });

  // Live update when settings change
  const unsubscribe = settings.subscribe(() => {
    const newSize = settings.getSettings().terminal.fontSize ?? 14;
    term.options.fontSize = newSize;
  });

  return () => {
    unsubscribe();
    term.dispose();
  };
}, []);
```

Also fix the frontend default in [`frontend/src/lib/settings.ts`](../frontend/src/lib/settings.ts) to match the backend:

```typescript
// BEFORE
terminal: {
  shell: "",
  fontSize: 13,   // diverges from backend default of 14
}

// AFTER
terminal: {
  shell: "",
  fontSize: 14,   // matches backend default
}
```

### Patch C: UI Font-Size Settings

Add new backend defaults and wire them into React components.

**Step 1**: Add keys to [`backend/crates/crow-ui-settings/src/defaults.rs`](../backend/crates/crow-ui-settings/src/defaults.rs):

```rust
fn add_workbench_defaults(m: &mut Map<String, Value>) {
    // ... existing workbench defaults ...

    // NEW: UI font size keys
    ins(m, "workbench.tree.fontSize", json!(13));
    ins(m, "workbench.tree.indent", json!(8));
    ins(m, "workbench.tab.fontSize", json!(11));
    ins(m, "workbench.sideBar.fontSize", json!(13));
    ins(m, "workbench.panel.fontSize", json!(13));
    ins(m, "workbench.statusBar.fontSize", json!(12));
}
```

**Step 2**: Extend `IdeSettings` interface in [`frontend/src/lib/settings.ts`](../frontend/src/lib/settings.ts):

```typescript
export interface WorkbenchSettings {
  tree: { fontSize: number };
  tab: { fontSize: number };
  sideBar: { fontSize: number };
  panel: { fontSize: number };
  statusBar: { fontSize: number };
}

export interface IdeSettings {
  editor: EditorSettings;
  languages: LanguageSettings;
  intellisense: IntellisenseSettings;
  terminal: TerminalSettings;
  explorer: ExplorerSettings;
  folderPicker: FolderPickerSettings;
  workbench: WorkbenchSettings;   // NEW
}

const DEFAULT_SETTINGS: IdeSettings = {
  // ... existing ...
  workbench: {
    tree: { fontSize: 13 },
    tab: { fontSize: 11 },
    sideBar: { fontSize: 13 },
    panel: { fontSize: 13 },
    statusBar: { fontSize: 12 },
  },
};
```

**Step 3**: Create a reusable hook in [`frontend/src/lib/settings.ts`](../frontend/src/lib/settings.ts):

```typescript
/**
 * React hook that returns a live workbench font size.
 * Automatically re-renders when the setting changes.
 */
export function useWorkbenchFontSize(key: keyof WorkbenchSettings): number {
  const [size, setSize] = useState(() =>
    (getSettings().workbench[key]?.fontSize ?? 13)
  );

  useEffect(() => {
    const unsubscribe = subscribe(() => {
      setSize(getSettings().workbench[key]?.fontSize ?? 13);
    });
    return unsubscribe;
  }, [key]);

  return size;
}
```

**Step 4**: Consume in components, e.g. [`frontend/src/components/ExplorerPane.tsx`](../frontend/src/components/ExplorerPane.tsx):

```typescript
import { useWorkbenchFontSize } from "../lib/settings";

function ExplorerPane() {
  const treeFontSize = useWorkbenchFontSize("tree");

  return (
    <div style={{ fontSize: treeFontSize }}>
      {/* tree items */}
    </div>
  );
}
```

---

## Appendix: File Reference

| File | Role |
|------|------|
| [`backend/crates/crow-ui-settings/src/settings.rs`](../backend/crates/crow-ui-settings/src/settings.rs) | Layered store implementation (`Settings` struct) |
| [`backend/crates/crow-ui-settings/src/defaults.rs`](../backend/crates/crow-ui-settings/src/defaults.rs) | Built-in defaults (`editor.fontSize = 14`, etc.) |
| [`backend/crates/crow-ui-settings/src/schema.rs`](../backend/crates/crow-ui-settings/src/schema.rs) | Validation schema (`SettingSchema`, `SchemaRegistry`) |
| [`backend/crates/crow-ui-server/src/handlers.rs`](../backend/crates/crow-ui-server/src/handlers.rs) | WS handlers: `handle_get_setting`, `handle_update_setting` |
| [`backend/crates/crow-ui-server/src/state.rs`](../backend/crates/crow-ui-server/src/state.rs) | `AppState` — loads `~/.crow/crow-ui-settings.json` on startup |
| [`frontend/src/lib/settings.ts`](../frontend/src/lib/settings.ts) | Frontend API: `getSetting`, `updateSetting`, `subscribe`, cache |
| [`frontend/src/lib/rpc.ts`](../frontend/src/lib/rpc.ts) | Typed RPC wrappers around WebSocket `invoke()` |
| [`frontend/src/lib/ws-client.ts`](../frontend/src/lib/ws-client.ts) | WebSocket client — dispatches `settings-changed` notifications |
| [`frontend/src/components/EditorPane.tsx`](../frontend/src/components/EditorPane.tsx) | Monaco editor — currently one-shot font-size fetch |
| [`frontend/src/components/TerminalPane.tsx`](../frontend/src/components/TerminalPane.tsx) | xterm.js terminal — hardcoded `fontSize: 13` |
| [`frontend/src/components/SettingsPane.tsx`](../frontend/src/components/SettingsPane.tsx) | JSONC settings editor UI |
| [`frontend/src/App.tsx`](../frontend/src/App.tsx) | Root layout — hardcoded tab bar `fontSize: 11` |
| [`frontend/src/components/ExplorerPane.tsx`](../frontend/src/components/ExplorerPane.tsx) | File explorer — hardcoded `fontSize: 13` |
