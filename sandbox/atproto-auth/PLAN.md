# crow-ui + atproto OAuth Integration Analysis

## Current State

- Local PDS running at `http://localhost:3000` with dev mode enabled
- Test account created: `alice.test` / `did:plc:jprfppa74xq647ujdi6v6m5w`
- OAuth metadata endpoints responding correctly

## The Core Question

**What does "Sign in with Bluesky" mean for crow-ui?**

Options:
1. **Authentication only** (authn) — verify identity, get DID, use for user profiles/preferences
2. **Authorization** (authz) — read/write atproto records on behalf of the user
3. **PDS as identity provider** — crow-ui runs its own PDS, users auth against it
4. **Hybrid** — use Bluesky for identity, local PDS for crow-ui-specific data

## OAuth Client Types: Which One Is crow-ui?

| Type | crow-ui form | Client Type | redirect_uri |
|------|-------------|-------------|--------------|
| **Web Service** | crow-ui-server on remote host | Confidential | `https://crow.example.com/callback` |
| **Browser SPA** | crow-ui frontend in browser | Public | `https://crow.example.com/callback` |
| **Desktop App** | Tauri app (production) | Public | Custom URI scheme (`crow://callback`) |
| **Loopback** | Tauri dev / local server | Public | `http://127.0.0.1:PORT/callback` |

**Reality**: crow-ui is *all of these at different times*:
- Development: frontend served by Vite dev server, backend on localhost
- Production (Tauri): embedded frontend + Rust backend, custom URI scheme
- Production (Web): frontend + backend both hosted remotely

This is the main architectural tension.

## Available Libraries

### TypeScript/JavaScript

| Package | Env | Maturity | Notes |
|---------|-----|----------|-------|
| `@atproto/oauth-client-node` | Node.js | Official, mature | Loopback + confidential client support |
| `@atproto/oauth-client-browser` | Browser | Official, mature | No loopback; requires public metadata URL |
| `@atproto/api` | Both | Official, mature | High-level Agent with OAuth session support |

### Rust

| Package | Axum Support | Maturity | Notes |
|---------|-------------|----------|-------|
| `atproto-oauth` | Core only | Community, active | PKCE, DPoP, PAR, JWT — full flow primitives |
| `atproto-oauth-axum` | Yes | Community, active | Handlers for callback, JWKS, metadata |
| `atproto-oauth-aip` | Yes | Community, newer | "Identity Provider" oriented |
| `jacquard-oauth` + `jacquard-axum` | Yes | Community, newer | Higher-level wrapper suite |

**Assessment**: The Rust crates exist but are less mature than the TS SDK. For prototyping, Node.js is faster. For production integration into crow-ui's Rust backend, we'd likely use `atproto-oauth` + `atproto-oauth-axum`.

## Recommended Architecture for Discussion

### Option A: Backend-Confidential Client (Rust `atproto-oauth-axum`)

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Frontend  │────▶│ crow-ui-server   │────▶│  PDS/Bluesky│
│  (Browser/  │ WS  │ (Axum + OAuth)   │ HTTP│  OAuth      │
│   Tauri)    │◄────│                  │◄────│             │
└─────────────┘     └──────────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  SQLite     │
                    │  (sessions) │
                    └─────────────┘
```

**Pros**:
- Server holds refresh tokens securely (not in browser/localStorage)
- Single OAuth client metadata URL (the backend serves it)
- Works identically in dev, web, and Tauri modes
- Can proxy all atproto API calls through backend

**Cons**:
- Requires backend to be reachable from PDS (for client metadata fetch)
- For Tauri: adds network dependency even for "local" app feel
- More complex: backend must manage token refresh

### Option B: Loopback Client (Desktop App Pattern)

```
┌─────────────────────────────────────────┐
│              Tauri App                  │
│  ┌─────────────┐    ┌────────────────┐  │
│  │   Frontend  │───▶│  Rust Backend  │  │
│  │             │ WS │ (or Node sidecar)│ │
│  └─────────────┘    └────────────────┘  │
│                            │             │
│                            ▼             │
│                   Opens system browser   │
│                            │             │
│                            ▼             │
│                   Listens on localhost   │
│                   for OAuth callback     │
│                            │             │
│                            ▼             │
│                   Exchanges code → token │
│                   Stores in OS keychain  │
└─────────────────────────────────────────┘
```

**Pros**:
- No public URL needed (uses `http://127.0.0.1:PORT/callback`)
- No backend network dependency for auth
- Matches the CLI tutorial pattern exactly
- Tokens stay in the app

**Cons**:
- Browser → app handoff is fiddly (what if user closes browser?)
- Doesn't work for web deployment (no localhost listener)
- Each device needs separate OAuth consent

### Option C: Frontend Browser Client (`@atproto/oauth-client-browser`)

```
┌─────────────┐     ┌─────────────┐
│   Browser   │────▶│    PDS      │
│  (Frontend) │OAuth│  (Bluesky)  │
│             │◄────│             │
└─────────────┘     └─────────────┘
       │
       ▼
  Stores tokens in
  IndexedDB via
  DPoP-bound keys
```

**Pros**:
- Simplest architecture
- Official browser SDK handles everything
- DPoP keys are non-exportable (good security)

**Cons**:
- Tokens live in the browser (IndexedDB)
- Requires publicly accessible `oauth-client-metadata.json`
- Not suitable for Tauri (different storage model)
- crow-ui would need two entirely different auth implementations

## Key Open Questions

### 1. What is the actual user need?

- **Identity**: "I want to prove I'm @alice.bsky.social inside crow-ui"
- **Data sync**: "Save my crow-ui settings/workspaces to my atproto repo"
- **Social**: "Share my crow-ui projects/state on Bluesky"
- **Self-hosting**: "I want to run my own PDS and have crow-ui use it"

### 2. What deployment modes must crow-ui support?

| Mode | OAuth Pattern |
|------|--------------|
| `cargo run` dev | Loopback or confidential |
| `bun run dev` + remote backend | Confidential |
| Tauri desktop app | Loopback or custom URI |
| Hosted web app | Confidential |

Do we support ALL of these, or pick a primary mode?

### 3. Token storage strategy

| Location | Security | Persistence | Cross-device |
|----------|----------|-------------|--------------|
| SQLite (backend) | High | Yes | Yes (if backend shared) |
| OS keychain (Tauri) | Very high | Yes | No |
| IndexedDB (browser) | Medium | Yes | No |
| In-memory only | Low | No | No |

### 4. Do we need to proxy atproto API calls?

If crow-ui wants to read/write atproto records, the frontend could:
- **Direct**: Call PDS directly from browser (CORS? DPoP keys in browser?)
- **Proxied**: All calls go through crow-ui-server (backend manages tokens)

Direct calls are simpler but require the browser to hold and use DPoP-bound tokens. Proxied is more secure but adds latency.

## Recommendation for Next Steps

1. **Prototype Option B (Loopback)** in this sandbox using Node.js
   - Fastest to get working
   - Demonstrates the full flow end-to-end
   - Can test against both local PDS and bsky.social

2. **Evaluate Option A (Backend-Confidential)** with a small Rust spike
   - Add `atproto-oauth-axum` to a minimal Axum server
   - Verify it works with the local PDS
   - Check token refresh behavior

3. **Decide on user stories before integrating**
   - What does being "signed in" actually unlock in crow-ui?
   - Is it just avatar + handle display?
   - Or full atproto data storage?

4. **Consider `crow-cli install` implications**
   - If `crow-cli install desktop` sets up a local PDS, that PDS becomes the identity provider
   - OAuth flow would be against `http://localhost:3000` (the local PDS)
   - This is actually the simplest case: always local, always loopback

## Files in This Sandbox

| File | Purpose |
|------|---------|
| `docker-compose.yml` | PDS container config with `PDS_DEV_MODE=true` |
| `setup.sh` | Generates secrets and starts the PDS |
| `README.md` | Operational docs for the PDS |
| `PLAN.md` | This analysis |
| `prototype/` | Working OAuth client prototype (next step) |
