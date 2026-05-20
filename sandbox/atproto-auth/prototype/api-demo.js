import { AtpAgent } from '@atproto/api'

const PDS_URL = 'http://localhost:3000'

async function main() {
  console.log('=== AtProto API Demo ===\n')

  // Create a fresh account (or you can hardcode tokens from a previous run)
  console.log('→ Creating account on local PDS...')
  const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createAccount`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `demo${Date.now()}@example.com`,
      handle: `demo${Date.now()}.test`,
      password: 'testpass123!',
    }),
  })

  if (!res.ok) {
    const err = await res.json()
    console.error('Account creation failed:', err)
    process.exit(1)
  }

  const { handle, did, accessJwt } = await res.json()
  console.log('✓ Account created:', handle)
  console.log('  DID:', did)

  // Use the ATP agent with the access token
  const agent = new AtpAgent({ service: PDS_URL })
  agent.api.setHeader('Authorization', `Bearer ${accessJwt}`)

  // Get the user's profile
  console.log('\n→ Fetching profile...')
  const profile = await agent.api.app.bsky.actor.getProfile({ actor: did })
  console.log('✓ Profile:', JSON.stringify(profile.data, null, 2))

  // Get preferences
  console.log('\n→ Fetching preferences...')
  const prefs = await agent.api.app.bsky.actor.getPreferences()
  console.log('✓ Preferences:', JSON.stringify(prefs.data, null, 2))

  console.log('\n✓ Demo complete!')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
