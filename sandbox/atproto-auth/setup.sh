#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== Crow ATProto Local Auth Setup ==="
echo ""

# Generate JWT secret if not present
if [ ! -f .env ]; then
    JWT_SECRET=$(openssl rand -hex 32)
    ADMIN_PASS="admin"
    
    # Generate a secp256k1 private key for PLC rotation
    # Using openssl to generate a random 32-byte hex string
    PLC_KEY=$(openssl rand -hex 32)
    
    cat > .env <<ENV
PDS_HOSTNAME=localhost
PDS_JWT_SECRET=${JWT_SECRET}
PDS_ADMIN_PASSWORD=${ADMIN_PASS}
PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=${PLC_KEY}
ENV
    echo "Generated .env with random secrets"
    echo "  Admin password: ${ADMIN_PASS}"
else
    echo ".env already exists, skipping generation"
fi

echo ""
echo "Starting PDS..."
docker compose up -d

echo ""
echo "Waiting for PDS to be ready..."
for i in {1..30}; do
    if curl -sf http://localhost:3000/xrpc/_health > /dev/null 2>&1; then
        echo "PDS is ready at http://localhost:3000"
        break
    fi
    sleep 1
done

echo ""
echo "=== Setup complete ==="
echo "PDS URL:     http://localhost:3000"
echo "Admin pass:  $(grep PDS_ADMIN_PASSWORD .env | cut -d= -f2)"
echo ""
echo "Create a test account:"
echo "  curl -X POST http://localhost:3000/xrpc/com.atproto.server.createAccount \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"email\":\"test@example.com\",\"handle\":\"alice.test\",\"password\":\"testpass123!\"}'"
