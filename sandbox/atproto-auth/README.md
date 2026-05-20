# Crow ATProto Local Auth Sandbox

Local atproto PDS for OAuth development/testing.

## What This Is

A self-contained local PDS (Personal Data Server) running in Docker, configured for **development mode** so it accepts HTTP (not HTTPS). This lets us prototype atproto OAuth flows without dealing with TLS certificates.

## Quick Start

```bash
./setup.sh
```

This generates random secrets, writes `.env`, and starts the PDS on port 3000.

## The `PDS_DEV_MODE` Fix

The PDS container crashes on startup with:

```
Error: Resource URL must use the https scheme
```

The fix is `PDS_DEV_MODE=true` in the compose environment. This is set automatically in `docker-compose.yml`. Without it, the PDS refuses to serve OAuth metadata over HTTP.

## Manual Control

```bash
# Start
 docker compose up -d

# Stop
 docker compose down

# View logs
 docker compose logs -f pds

# Check health
curl http://localhost:3000/xrpc/_health
```

## Creating Test Accounts

The PDS accepts `.test` handles (configured automatically):

```bash
curl -s -X POST http://localhost:3000/xrpc/com.atproto.server.createAccount \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","handle":"alice.test","password":"testpass123!"}'
```

Already created: `alice.test` → `did:plc:jprfppa74xq647ujdi6v6m5w`

## OAuth Discovery Endpoints

| Endpoint | URL |
|----------|-----|
| Health | `http://localhost:3000/xrpc/_health` |
| Server Description | `http://localhost:3000/xrpc/com.atproto.server.describeServer` |
| OAuth Protected Resource | `http://localhost:3000/.well-known/oauth-protected-resource` |
| OAuth Authorization Server | `http://localhost:3000/.well-known/oauth-authorization-server` |

## What We Learned

- **PDS version**: `0.4.219` inside the `ghcr.io/bluesky-social/pds:0.4` image
- **Dev mode**: `PDS_DEV_MODE=true` bypasses HTTPS enforcement for local development
- **Handle domains**: The PDS automatically exposes `.test` as the available domain
- **No invite codes required**: `PDS_INVITE_REQUIRED=false`

## Next Steps for crow-ui Integration

1. **Research OAuth client libraries**: `atproto-oauth` + `atproto-oauth-axum` for Rust, or `@atproto/oauth-client-node` / `@atproto/oauth-client-browser` for JS
2. **Prototype the flow**: Initiate → Browser → Callback → Token exchange
3. **Design the UX**: "Sign in with Bluesky" vs "Use local PDS" vs custom handle entry
4. **Decide on architecture**: Server-side confidential client (web service) vs loopback public client (desktop app)

See `PLAN.md` for the full integration analysis.
