#!/usr/bin/env bash
set -euo pipefail

# Simple helper to build the worker + server and send one JSON-RPC request.
# Options:
#   --timeout <seconds>   Override the command timeout (default 180, 0 disables)
#   --capture <path>      Tee full JSON output to <path>
#   --no-summary          Suppress the post-run summary line
# Usage examples:
#   tools/rpc.sh '{"jsonrpc":"2.0","method":"init","params":{"projectRoot":"."},"id":1}'
#   tools/rpc.sh --timeout 300 --capture .site2ts/logs/init.jsonl '{"jsonrpc":"2.0","method":"crawl","params":{"startUrl":"https://example.com"},"id":2}'

TIMEOUT_DEFAULT=${RPC_TIMEOUT_SEC:-180}
TIMEOUT_SEC=$TIMEOUT_DEFAULT
CAPTURE_PATH=""
PRINT_SUMMARY=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout)
      [[ $# -ge 2 ]] || { echo "--timeout requires a value" >&2; exit 1; }
      TIMEOUT_SEC="$2"
      shift 2
      ;;
    --timeout=*)
      TIMEOUT_SEC="${1#*=}"
      shift
      ;;
    --no-timeout)
      TIMEOUT_SEC=""
      shift
      ;;
    --capture)
      [[ $# -ge 2 ]] || { echo "--capture requires a path" >&2; exit 1; }
      CAPTURE_PATH="$2"
      shift 2
      ;;
    --capture=*)
      CAPTURE_PATH="${1#*=}"
      shift
      ;;
    --no-summary)
      PRINT_SUMMARY=0
      shift
      ;;
    --help)
      echo "Usage: $0 [--timeout <seconds>|--no-timeout] [--capture <path>] [--no-summary] '<json-rpc-request>'" >&2
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

REQ_JSON=${1:-}
if [[ -z "$REQ_JSON" ]]; then
  echo "Usage: $0 [options] '<json-rpc-request>'" >&2
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

OUT_FILE="$CAPTURE_PATH"
if [[ -z "$OUT_FILE" ]]; then
  OUT_FILE=$(mktemp)
fi

run_rpc() {
  if [[ -n "${TIMEOUT_SEC}" && "${TIMEOUT_SEC}" != "0" ]]; then
    if command -v timeout >/dev/null 2>&1; then
      timeout "${TIMEOUT_SEC}"s "$BIN"
      return $?
    else
      echo "[rpc] warning: 'timeout' command not found; running without timeout" >&2
    fi
  fi
  "$BIN"
}

set +e
echo "$REQ_JSON" | run_rpc | tee "$OUT_FILE"
PIPE_EXIT=(${PIPESTATUS[@]})
STATUS=${PIPE_EXIT[1]:-0}
set -e

if [[ $STATUS -ne 0 ]]; then
  [[ -z "$CAPTURE_PATH" ]] && rm -f "$OUT_FILE"
  exit $STATUS
fi

if [[ $PRINT_SUMMARY -eq 1 ]]; then
  node - "$OUT_FILE" <<'NODE'
const fs = require('fs');
const path = process.argv[2];
try {
  const content = fs.readFileSync(path, 'utf8');
  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    try {
      const msg = JSON.parse(line);
      if (!msg || typeof msg !== 'object' || !('result' in msg)) continue;
      const result = msg.result;
      const summary = Object.entries(result).map(([key, value]) => {
        if (typeof value === 'string') return `${key}=${value}`;
        if (Array.isArray(value)) return `${key}[${value.length}]`;
        if (value && typeof value === 'object') return `${key} keys=${Object.keys(value).length}`;
        return `${key}=${value}`;
      });
      console.log(`[rpc] summary => ${summary.join(', ')}`);
      process.exit(0);
    } catch (err) {
      continue;
    }
  }
} catch (err) {
  console.error(`[rpc] failed to read output: ${err.message}`);
}
NODE
fi

if [[ -z "$CAPTURE_PATH" ]]; then
  rm -f "$OUT_FILE"
else
  echo "[rpc] full output captured at $OUT_FILE"
fi
