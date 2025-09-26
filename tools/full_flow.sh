#!/usr/bin/env bash
set -euo pipefail

# End-to-end flow helper. Requires a URL argument.
# Usage: tools/full_flow.sh https://example.com [--apply] [--improve-route </path>] [--improve-note "text"]

START_URL=""
APPLY=false
IMPROVE_ROUTE=""
IMPROVE_NOTE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=true
      shift
      ;;
    --improve-route)
      [[ $# -ge 2 ]] || { echo "--improve-route requires a value" >&2; exit 1; }
      IMPROVE_ROUTE="$2"
      shift 2
      ;;
    --improve-note)
      [[ $# -ge 2 ]] || { echo "--improve-note requires a value" >&2; exit 1; }
      IMPROVE_NOTE="$2"
      shift 2
      ;;
    --help)
      echo "Usage: $0 <start-url> [--apply] [--improve-route </path>] [--improve-note \"text\"]" >&2
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      if [[ -z "$START_URL" ]]; then
        START_URL="$1"
        shift
      else
        echo "Unexpected positional argument: $1" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$START_URL" ]]; then
  echo "Usage: $0 <start-url> [--apply] [--improve-route </path>] [--improve-note \"text\"]" >&2
  exit 1
fi

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)

# Helper to send a JSON-RPC request, echo the streamed output, and capture to a temp file.
send_and_capture() {
  local LABEL=$1
  local REQ=$2
  local FILE=$3
  echo "[flow] $LABEL =>"
  tools/rpc.sh "$REQ" | tee "$FILE"
}

extract_field_from_file() {
  local FILE=$1
  local FIELD_PATH=$2
  local LINE
  LINE=$(awk '/"result"/ { last = $0 } END { if (last) print last }' "$FILE")
  if [[ -z "$LINE" ]]; then
    return 1
  fi
  node -e '
const raw = process.argv[1];
const path = (process.argv[2] || "").split(".").filter(Boolean);
const parsed = JSON.parse(raw);
let ref = parsed;
for (const key of path) {
  if (ref && Object.prototype.hasOwnProperty.call(ref, key)) {
    ref = ref[key];
  } else {
    ref = undefined;
    break;
  }
}
if (ref === undefined) {
  process.exit(1);
}
if (typeof ref === "object") {
  console.log(JSON.stringify(ref));
} else {
  console.log(ref);
}
' "$LINE" "$FIELD_PATH"
}

# init
INIT_FILE=$(mktemp)
send_and_capture "init" '{"jsonrpc":"2.0","method":"init","params":{"projectRoot":"."},"id":1}' "$INIT_FILE"
rm -f "$INIT_FILE"

# crawl
CRAWL_REQ=$(cat <<JSON
{"jsonrpc":"2.0","method":"crawl","params":{"startUrl":"$START_URL","sameOrigin":true,"maxPages":25,"maxDepth":3,"useSitemap":true,"obeyRobots":true},"id":2}
JSON
)
CRAWL_FILE=$(mktemp)
send_and_capture "crawl" "$CRAWL_REQ" "$CRAWL_FILE"
SITEMAP_ID=$(extract_field_from_file "$CRAWL_FILE" 'result.siteMapId') || {
  echo "[flow] failed to parse crawl result" >&2
  rm -f "$CRAWL_FILE"
  exit 1
}
rm -f "$CRAWL_FILE"

# analyze
ANALYZE_REQ=$(cat <<JSON
{"jsonrpc":"2.0","method":"analyze","params":{"siteMapId":"$SITEMAP_ID"},"id":3}
JSON
)
ANALYZE_FILE=$(mktemp)
send_and_capture "analyze" "$ANALYZE_REQ" "$ANALYZE_FILE"
ANALYSIS_ID=$(extract_field_from_file "$ANALYZE_FILE" 'result.analysisId') || {
  echo "[flow] failed to parse analyze result" >&2
  rm -f "$ANALYZE_FILE"
  exit 1
}
rm -f "$ANALYZE_FILE"

# scaffold
SCAFFOLD_REQ=$(cat <<JSON
{"jsonrpc":"2.0","method":"scaffold","params":{"analysisId":"$ANALYSIS_ID","appRouter":true},"id":4}
JSON
)
SCAFFOLD_FILE=$(mktemp)
send_and_capture "scaffold" "$SCAFFOLD_REQ" "$SCAFFOLD_FILE"
SCAFFOLD_ID=$(extract_field_from_file "$SCAFFOLD_FILE" 'result.scaffoldId') || {
  echo "[flow] failed to parse scaffold result" >&2
  rm -f "$SCAFFOLD_FILE"
  exit 1
}
rm -f "$SCAFFOLD_FILE"

# generate
GENERATE_REQ=$(cat <<JSON
{"jsonrpc":"2.0","method":"generate","params":{"analysisId":"$ANALYSIS_ID","scaffoldId":"$SCAFFOLD_ID","tailwindMode":"full"},"id":5}
JSON
)
GENERATE_FILE=$(mktemp)
send_and_capture "generate" "$GENERATE_REQ" "$GENERATE_FILE"
GENERATION_ID=$(extract_field_from_file "$GENERATE_FILE" 'result.generationId') || {
  echo "[flow] failed to parse generate result" >&2
  rm -f "$GENERATE_FILE"
  exit 1
}
rm -f "$GENERATE_FILE"

# diff
DIFF_REQ=$(cat <<JSON
{"jsonrpc":"2.0","method":"diff","params":{"generationId":"$GENERATION_ID","baselines":"recrawl","viewport":{"w":1280,"h":800,"deviceScale":1},"threshold":0.01},"id":6}
JSON
)
DIFF_FILE=$(mktemp)
send_and_capture "diff" "$DIFF_REQ" "$DIFF_FILE"
rm -f "$DIFF_FILE"

# audit
AUDIT_REQ=$(cat <<JSON
{"jsonrpc":"2.0","method":"audit","params":{"generationId":"$GENERATION_ID","tsStrict":true,"eslintConfig":"recommended"},"id":7}
JSON
)
AUDIT_FILE=$(mktemp)
send_and_capture "audit" "$AUDIT_REQ" "$AUDIT_FILE"
rm -f "$AUDIT_FILE"

# apply (dry-run by default)
if $APPLY; then
  APPLY_PARAMS='{"generationId":"'$GENERATION_ID'","target":"./","dryRun":false}'
else
  APPLY_PARAMS='{"generationId":"'$GENERATION_ID'","target":"./","dryRun":true}'
fi
APPLY_REQ=$(cat <<JSON
{"jsonrpc":"2.0","method":"apply","params":$APPLY_PARAMS,"id":8}
JSON
)
APPLY_FILE=$(mktemp)
send_and_capture "apply" "$APPLY_REQ" "$APPLY_FILE"
rm -f "$APPLY_FILE"

if [[ -n "$IMPROVE_NOTE" ]]; then
  IMPROVE_ROUTE_VALUE=${IMPROVE_ROUTE:-"/"}
  IMPROVE_REQ=$(python3 - <<'PY' "$GENERATION_ID" "$IMPROVE_ROUTE_VALUE" "$IMPROVE_NOTE"
import json
import sys

generation_id, route, note = sys.argv[1:4]
payload = {
    "jsonrpc": "2.0",
    "method": "improve",
    "params": {
        "generationId": generation_id,
        "route": route,
        "instructions": note,
    },
    "id": 9,
}
print(json.dumps(payload))
PY
)
  IMPROVE_FILE=$(mktemp)
  send_and_capture "improve" "$IMPROVE_REQ" "$IMPROVE_FILE"
  rm -f "$IMPROVE_FILE"
fi

echo "[flow] done. Generation: $GENERATION_ID"
