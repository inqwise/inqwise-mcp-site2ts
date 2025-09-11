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

echo "[rpc] Building Node worker…" >&2
pushd "$ROOT_DIR/node/site2ts-worker" >/dev/null
if [[ -f package-lock.json ]]; then npm ci 1>&2; else npm install 1>&2; fi
npm run -s build 1>&2
popd >/dev/null

echo "[rpc] Building Rust server…" >&2
pushd "$ROOT_DIR/rust/site2ts-server" >/dev/null
cargo build -q
popd >/dev/null

BIN="$ROOT_DIR/rust/site2ts-server/target/debug/site2ts-server"
if [[ ! -x "$BIN" ]]; then
  # Fallback for non-cargo default target dir
  BIN="$ROOT_DIR/rust/site2ts-server/target/debug/site2ts-server.exe"
fi

echo "$REQ_JSON" | "$BIN"
