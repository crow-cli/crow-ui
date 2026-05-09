#!/usr/bin/env bash
# Build crow-ui-ide Electron app
# Usage: ./build.sh [--release|--dev] [--dist]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IDE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BINARY="$IDE_DIR/target/release/crow-ui-server"

MODE="${1:---release}"
DIST="${2}"

echo "=== Building crow-ui Electron app ==="

# 1. Build frontend
echo "[1/4] Building frontend (Vite)..."
cd "$IDE_DIR/frontend"
bun run build

# 2. Build Rust backend (only if binary missing or stale)
echo "[2/4] Checking Rust backend..."
cd "$IDE_DIR"
if [ ! -f "$BINARY" ]; then
    echo "  Building Rust backend (first time)..."
    if [ "$MODE" = "--dev" ]; then
        cargo build --package crow-ui-server
    else
        cargo build --release --package crow-ui-server -j $(nproc)
    fi
else
    echo "  Binary exists, skipping rebuild. Run 'cargo build --release' to update."
fi

# 3. Build Electron TypeScript
echo "[3/4] Compiling Electron main process..."
cd "$IDE_DIR/electron"
npm run build:ts

# 4. Package (optional)
if [ "$DIST" = "--dist" ]; then
    echo "[4/4] Packaging with electron-builder..."
    npm run build:dist
else
    echo "[4/4] Skipping packaging (run with --dist to package)"
fi

echo "=== Done ==="
if [ "$DIST" != "--dist" ]; then
    echo "Run with: cd electron && bun start"
fi
