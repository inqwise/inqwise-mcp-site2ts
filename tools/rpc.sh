#!/usr/bin/env bash
set -euo pipefail

# Simple helper to build the worker + server and send one JSON-RPC request.
# Usage examples:
#   tools/rpc.sh '{"jsonrpc":"2.0","method":"init","params":{"projectRoot":"."},"id":1}'
#   tools/rpc.sh '{"jsonrpc":"2.0","method":"crawl","params":{"startUrl":"https://example.com","sameOrigin":true,"maxPages":5},"id":2}'

REQ_JSON=${1:-}
if [[ -z "$REQ_JSON" ]]; then
  echo "Usage: $0 '<json-rpc-request>'" >&2
  exit 1
fi

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)

# Verify worker build artifacts exist instead of rebuilding every run.
WORKER_DIR="$ROOT_DIR/node/site2ts-worker"
WORKER_ENTRY="$WORKER_DIR/dist/index.js"
if [[ ! -f "$WORKER_ENTRY" ]]; then
  echo "Worker build artifact missing: $WORKER_ENTRY" >&2
  echo "Run 'npm install' (if needed) and 'npm run build' inside $WORKER_DIR" >&2
  exit 1
fi

# Verify Rust server binary exists instead of rebuilding every run.
BIN="$ROOT_DIR/rust/site2ts-server/target/debug/site2ts-server"
if [[ ! -x "$BIN" ]]; then
  # Fallback for non-cargo default target dir
  BIN="$ROOT_DIR/rust/site2ts-server/target/debug/site2ts-server.exe"
fi

if [[ ! -x "$BIN" ]]; then
  echo "Rust server binary missing: $BIN" >&2
  echo "Run 'cargo build --manifest-path rust/site2ts-server/Cargo.toml'" >&2
  exit 1
fi

echo "$REQ_JSON" | "$BIN"
