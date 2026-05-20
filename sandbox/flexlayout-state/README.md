# FlexLayout + Backend State — Sandbox Prototype

A minimal reference implementation demonstrating how to build a FlexLayout-based IDE where **all state lives in a Rust backend** and the **frontend is a dumb view**.

## Architecture

```
┌─────────────────┐      WebSocket      ┌─────────────────────────┐
│   React Frontend│ ◄──────────────────► │  Rust Backend (Axum)    │
│                 │   {layout, docs}     │                         │
│  · FlexLayout   │                      │  · Layout JSON (memory) │
│  · Monaco       │  ── actions ──►      │  · Document store       │
│  · Dumb view    │   open/close/edit    │  · File system access   │
└─────────────────┘                      └─────────────────────────┘
```

### Design Principles

1. **Backend owns everything** — layout model, open documents, dirty state, file tree
2. **Frontend is a view** — renders what the backend sends, captures input, sends actions
3. **Full state sync** — backend broadcasts complete state on every change
4. **Action-based mutations** — frontend sends actions like `open_file`, `edit_file`, `close_tab`

## Running

```bash
# 1. Build frontend
cd frontend
npm install
npm run build
cd ..

# 2. Build & run backend
cargo run --release

# 3. Open http://localhost:7777
```

## State Flow Example: Opening a File

1. User clicks file in Explorer → frontend sends `{type: "open_file", path: "..."}`
2. Backend reads file from disk, adds editor tab to its layout model
3. Backend broadcasts full state `{layout: {...}, documents: {...}}`
4. Frontend receives state, recreates FlexLayout model, renders new editor tab
5. Monaco loads with document content from state

## State Flow Example: Typing in Editor

1. User types in Monaco → frontend updates Monaco locally + sends `{type: "edit_file", path, content}`
2. Backend updates document in its store, marks dirty
3. Backend broadcasts state
4. Frontend receives state, sees document changed but layout same → updates dirty indicator only

## Known Limitations (Prototype)

- **Model recreation on structural changes** — opening/closing tabs recreates the FlexLayout model, which remounts Monaco. In production, we'd diff the layout and apply minimal `Actions.*` instead.
- **Full state broadcast** — every change sends the entire layout + all documents. In production, we'd use deltas or CRDTs.
- **No multi-client sync** — broadcasts go to all clients but there's no session isolation.
- **Terminal is a placeholder** — real xterm.js integration would need a PTY backend.

## Comparison: Main crow-ui vs. This Prototype

| Aspect | crow-ui (current) | Prototype (target) |
|---|---|---|
| Layout state | Frontend `useState` | Backend owns JSON |
| Open files | Frontend `Map` + model | Derived from model only |
| Dirty tracking | Frontend `Set` | Backend document store |
| Tab open/close | `model.doAction` + sync | Send action → backend computes |
| Explorer expanded | Frontend `useState` | Could be backend-owned |
| ACP sessions | Frontend store | Backend store (already done!) |

## What We Learned

- FlexLayout's `Model.fromJson()` is expensive for large layouts (remounts components)
- Monaco needs stable mounting — model diffs are required for production
- `node.getExtraData()` in FlexLayout could hold per-tab backend state without React
- The `ILayoutApi` ref (`layoutRef.current.addTabToActiveTabSet`) is cleaner than `model.doAction`
- A pure "dumb view" is possible but needs efficient sync for canvas-heavy components
