import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { AtpAgent } from '@atproto/api'
import http from 'http'
import open from 'open'
import { URL } from 'url'

// Test account we created on the local PDS
const TEST_HANDLE = 'alice.test'
const TEST_DID = 'did:plc:jprfppa74xq647ujdi6v6m5w'
const TEST_PDS = 'http://localhost:3000'

// In-memory stores for the prototype
const stateStore = new Map()
const sessionStore = new Map()

async function main() {
  console.log('=== AtProto OAuth Prototype ===\n')

  // Create OAuth client configured for loopback (local development)
  const client = new NodeOAuthClient({
    allowHttp: true, // Allow HTTP for local PDS development
    clientMetadata: {
      client_id: 'http://localhost',
      client_name: 'Crow UI OAuth Prototype',
      client_uri: 'http://localhost',
      redirect_uris: ['http://127.0.0.1:3001'],
      scope: 'atproto',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'native',
      token_endpoint_auth_method: 'none',
    },
    stateStore: {
      set: (key, value) => { stateStore.set(key, value); return Promise.resolve() },
      get: (key) => Promise.resolve(stateStore.get(key)),
      del: (key) => { stateStore.delete(key); return Promise.resolve() },
    },
    sessionStore: {
      set: (sub, value) => { sessionStore.set(sub, value); return Promise.resolve() },
      get: (sub) => Promise.resolve(sessionStore.get(sub)),
      del: (sub) => { sessionStore.delete(sub); return Promise.resolve() },
    },
  })

  // Try to use existing session first
  const existingSession = await client.restore(TEST_DID).catch(() => null)
  if (existingSession) {
    console.log('✓ Restored existing session for', TEST_DID)
    await fetchProfile(existingSession)
    return
  }

  // Start temporary callback server
  const callbackServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)

    if (url.pathname === '/' || url.pathname === '/callback') {
      console.log('\n→ Received OAuth callback')

      try {
        const params = new URLSearchParams(url.search)
        const result = await client.callback(params)
        console.log('✓ OAuth callback processed')
        console.log('  DID:', result.sub)

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`
          <html>
            <body style="font-family: sans-serif; text-align: center; padding: 50px;">
              <h1>✓ Authentication Successful</h1>
              <p>You can close this window and return to the terminal.</p>
              <p><code>${result.sub}</code></p>
            </body>
          </html>
        `)

        // Fetch profile with the new session
        const session = await client.restore(result.sub)
        await fetchProfile(session)

        // Shut down server
        setTimeout(() => callbackServer.close(), 500)
      } catch (err) {
        console.error('✗ Callback error:', err.message)
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(`<h1>Error</h1><pre>${err.message}</pre>`)
        callbackServer.close()
      }
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  })

  await new Promise((resolve) => callbackServer.listen(3001, resolve))
  console.log('→ Callback server listening on http://127.0.0.1:3001/callback')

  // Initiate OAuth flow
  console.log('\n→ Initiating OAuth authorization for', TEST_HANDLE)
  try {
    const url = await client.authorize(TEST_DID, {
      scope: 'atproto',
    })
    console.log('→ Authorization URL generated')
    console.log('  ', url.toString())
    console.log('→ Opening browser...')
    await open(url.toString()).catch(() => {
      console.log('  (browser open failed — paste URL manually)')
    })
  } catch (err) {
    console.error('✗ Authorization failed:', err.message)
    console.error(err)
    callbackServer.close()
    process.exit(1)
  }
}

async function fetchProfile(session) {
  console.log('\n→ Fetching profile...')

  // The session object from oauth-client-node has fetch() bindings for DPoP
  const agent = new AtpAgent({ service: TEST_PDS })

  // We need to configure the agent to use the OAuth session
  // In the real SDK, you'd pass the session directly
  // For this prototype, we'll show what the session contains
  console.log('  Session keys:', Object.keys(session).join(', '))

  if (session.did) {
    console.log('  DID:', session.did)
  }
  if (session.tokens) {
    console.log('  Access token present:', !!session.tokens.accessToken)
    console.log('  Refresh token present:', !!session.tokens.refreshToken)
  }

  console.log('\n✓ OAuth flow complete!')
  console.log('\nSession stored in memory. Run again to see restore behavior.')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
