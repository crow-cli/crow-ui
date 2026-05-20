# OAuth Prototype

Demonstrates atproto OAuth client initialization against the local PDS.

## What Works

- ✅ OAuth client initialization (`NodeOAuthClient`)
- ✅ Pushed Authorization Request (PAR) to local PDS
- ✅ Authorization URL generation
- ✅ Loopback callback server
- ✅ `allowHttp: true` for local development

## What Requires a Browser

- ❌ User login / consent screen (PDS renders React UI)
- ❌ Redirect with authorization code
- ❌ Token exchange

## Running

```bash
npm install
NODE_ENV=development node login.js
```

This will print an authorization URL. Paste it into a browser to complete the flow.

## Authenticated API Demo

Since we already have tokens from `createAccount`, we can make authenticated calls immediately:

```bash
node api-demo.js
```
