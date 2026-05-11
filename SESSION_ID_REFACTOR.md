# Session ID Refactor Walkthrough

## The Bug

The frontend creates **two agent sessions** for every one HTTP API call, because `acp-store.ts` uses fake internal IDs as Map keys while returning real agent session IDs to callers. When the chat tab mounts, it can't find the session under the real ID (it's under a `pending-...` key), so it creates a second agent.

## Current Broken Flow

### 1. HTTP API creates a session (`App.tsx`)
```
Backend sends: acp-command-new-session { requestId }
App.tsx calls: acpStore.createSession(config, cwd)
  → storeKey = `pending-${Date.now()}`        (FAKE ID #1)
  → connects to agent, gets realSessionId      (e.g. "mysterious-cobra")
  → stores session under `pending-...`
  → returns realSessionId to App.tsx
App.tsx creates chat tab: config = { sessionId: "mysterious-cobra" }
App.tsx reports { sessionId: "mysterious-cobra" } back to backend
```

### 2. ChatPane mounts and "restores" (`ChatPane.tsx` lines 80-90)
```
ChatPane receives prop: sessionId = "mysterious-cobra"
useEffect checks: acpStore.getSession("mysterious-cobra")
  → returns EMPTY fallback (session is stored under `pending-...`!)
  → s.agentConfig is null/undefined
  → ChatPane calls: acpStore.createSession(config, cwd, "mysterious-cobra")
    → storeKey = "mysterious-cobra"              (uses preferredSessionId)
    → connects to agent, gets realSessionId2     (e.g. "mysterious-perch")
    → stores session under "mysterious-cobra"
    → returns "mysterious-cobra" (because preferredSessionId was given)
```

**Result:** Two agents spawned. The first (`pending-...` → cobra) is orphaned. The second (`mysterious-cobra` → perch) is what the user interacts with. But the backend thinks "mysterious-cobra" is the session ID, while the actual agent receiving messages is "mysterious-perch".

### 3. ChatTile tabs do the same thing (`ChatTile.tsx`)
```
ChatTile generates tab ID: "chat-tile-123-1712345678-1"
User clicks tab → startSession("chat-tile-123-1712345678-1")
  → calls acpStore.createSession(config, cwd, tabId)
  → storeKey = tabId
  → connects to agent, gets real session ID
  → stores under tabId, not real ID
```

## The Correct Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  acp-store.ts                                               │
│  sessions: Map<realSessionId, SessionState>                 │
│  Key is ALWAYS the agent's real session ID. No exceptions.  │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────┼───────────────────────────────┐
│  ChatPane.tsx               │                               │
│  props.sessionId = real ID ─┘  (passed from tab config)     │
│  subscribes to acpStore by real ID                          │
│  NEVER calls createSession on mount (parent already did)    │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────┼───────────────────────────────┐
│  ChatTile.tsx               │                               │
│  tabs: { tabId, sessionId? }[]                              │
│  tabId = UI-only identifier (e.g. "chat-tile-123-...")      │
│  sessionId = real agent ID (null until connected)           │
│  When user connects: sessionId = await createSession()      │
│  ChatPane inside tab receives sessionId as prop             │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────┼───────────────────────────────┐
│  App.tsx                    │                               │
│  HTTP handler: sessionId = await createSession()            │
│  Creates chat tab: config = { sessionId: realId }           │
│  Reports realId back to backend                             │
└─────────────────────────────────────────────────────────────┘
```

## What To Change

### acp-store.ts

**REMOVE:**
- `preferredSessionId` parameter from `createSession()`
- `storeKey` local variable
- `agentSessionId` field from `SessionState` interface
- The `pending-${Date.now()}` fake ID generation
- The ternary `return preferredSessionId ? storeKey : realSessionId;`

**CHANGE:**
- `createSession(config, cwd)` connects to agent, gets `realSessionId`, stores directly under `realSessionId`, returns `realSessionId`
- All subscriptions, getters, prompts use the real session ID as the key
- `closeSession(sessionId)` closes the session at that exact key

**BEFORE:**
```ts
export async function createSession(config, cwd, preferredSessionId?) {
  const storeKey = preferredSessionId || `pending-${Date.now()}`;
  // ... stores under storeKey
  // ... returns preferredSessionId ? storeKey : realSessionId
}
```

**AFTER:**
```ts
export async function createSession(config, cwd) {
  // Don't store anything yet — wait for real ID
  const client = new AcpClient({...});
  const info = await client.connect();
  const sessionId = info.sessionId;  // REAL ID from agent
  sessions.set(sessionId, { client, status: "ready", sessionInfo: info, ... });
  return sessionId;
}
```

### ChatPane.tsx

**REMOVE:**
- The defensive `useEffect` that calls `createSession` on mount (lines ~80-90)
- ChatPane should ASSUME the session already exists when it mounts
- If it doesn't exist, show "Disconnected" — don't auto-create

**CHANGE:**
- `sessionId` prop IS the real session ID
- Subscribes directly: `acpStore.subscribeToSession(sessionId, ...)`
- If `getSession(sessionId)` returns empty fallback, render "Not connected" UI

**BEFORE:**
```ts
useEffect(() => {
  if (!workspaceRoot || !agentConfig) return;
  const s = acpStore.getSession(sessionId);
  if (!s.agentConfig) {
    acpStore.createSession(agentConfig, workspaceRoot, sessionId).catch(console.error);
  }
}, [sessionId, workspaceRoot, agentConfig]);
```

**AFTER:**
```ts
// REMOVED — parent (App.tsx or ChatTile) is responsible for creating the session
// ChatPane just renders whatever session it's given
```

### ChatTile.tsx

**CHANGE:**
- `ChatTab` interface becomes `{ tabId: string; sessionId: string | null; connected: boolean }`
- `createTab()` generates `tabId`, NOT `sessionId`
- `startSession(tabId)`:
  1. Find the tab by `tabId`
  2. Call `acpStore.createSession(config, cwd)` → gets `realSessionId`
  3. Update tab: `{ ...tab, sessionId: realSessionId, connected: true }`
- Pass `sessionId` (real ID) to `ChatSessionBody`
- `closeSession(tabId)` finds tab, calls `acpStore.closeSession(tab.sessionId!)`, removes tab
- Persistence saves `tabId`s, but on restore you must reconnect to get new `sessionId`s

**BEFORE:**
```ts
export interface ChatTab {
  sessionId: string;   // This was actually being used as a tab ID!
  connected: boolean;
}

const createTab = () => {
  const sessionId = `${sessionPrefix}-${Date.now()}-${counter}`;
  return { sessionId, connected: false };
};

const startSession = async (sessionId: string) => {
  await acpStore.createSession(config, cwd, sessionId);
};
```

**AFTER:**
```ts
export interface ChatTab {
  tabId: string;        // UI-only identifier
  sessionId: string | null;  // Real agent session ID (null = not connected)
  connected: boolean;
}

const createTab = () => {
  const tabId = `${sessionPrefix}-${Date.now()}-${counter}`;
  return { tabId, sessionId: null, connected: false };
};

const startSession = async (tabId: string) => {
  const sessionId = await acpStore.createSession(config, cwd);
  setTabs(prev => prev.map(t => t.tabId === tabId ? { ...t, sessionId, connected: true } : t));
};
```

### App.tsx

**NO CHANGES NEEDED** to the HTTP handler flow itself — it already works correctly:
1. Receives `acp-command-new-session`
2. Calls `acpStore.createSession()` → gets real ID
3. Creates chat tab with `config: { sessionId: realId }`
4. Reports real ID back

**BUT:** The initial model has a dummy chat tab:
```ts
{
  type: "tab",
  name: "Agent Chat",
  component: "chat",
  config: { sessionId: "chat-initial" },  // ← This is a fake ID!
}
```

This should either:
- Be removed (no chat tab in initial model)
- Or be a placeholder that shows "Click to connect" and only calls `createSession` when clicked

**ALSO:** `setGlobalOpenChat` (line ~578) calls `acpStore.createSession()` directly and then creates a tab. This is fine — the session IS created before the tab, and the real session ID goes into the tab config.

## Backend (ws.rs)

**NO CHANGES NEEDED.** The backend already:
1. Sends `acp-command-new-session` with `requestId`
2. Waits for frontend to report `sessionId`
3. Returns that `sessionId` in HTTP response
4. Routes `/api/acp/sessions/:session_id/prompt` using that exact ID

The backend trusts the frontend to return the real session ID. After this refactor, the frontend actually will.

## Migration Path

1. **acp-store.ts** — Make `createSession` return real ID, remove `preferredSessionId`
2. **App.tsx** — Remove the initial dummy `chat-initial` tab from default model
3. **ChatPane.tsx** — Remove the auto-create `useEffect` on mount
4. **ChatTile.tsx** — Add `tabId` vs `sessionId` distinction
5. Test: `curl -X POST http://localhost:3928/api/acp/sessions` should return one real ID, and only ONE agent process should spawn.
