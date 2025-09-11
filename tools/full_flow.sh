#!/usr/bin/env bash
set -euo pipefail

# End-to-end flow helper. Requires a URL argument.
# Usage: tools/full_flow.sh https://example.com [--apply]

START_URL=${1:-}
APPLY_FLAG=${2:-}
if [[ -z "$START_URL" ]]; then
  echo "Usage: $0 <start-url> [--apply]" >&2
  exit 1
fi

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)

# Helper to send a single JSON-RPC request via tools/rpc.sh and capture result
send() {
  local REQ=$1
  tools/rpc.sh "$REQ"
}

# init
INIT_RES=$(send '{"jsonrpc":"2.0","method":"init","params":{"projectRoot":"."},"id":1}')
echo "[flow] init => $INIT_RES"

# crawl
CRAWL_REQ=$(cat <<JSON
{"jsonrpc":"2.0","method":"crawl","params":{"startUrl":"$START_URL","sameOrigin":true,"maxPages":25,"maxDepth":3,"useSitemap":true,"obeyRobots":true},"id":2}
JSON
)
CRAWL_RES=$(send "$CRAWL_REQ")
echo "[flow] crawl => $CRAWL_RES"
SITEMAP_ID=$(node -e "const r=JSON.parse(process.argv[1]); console.log((r.result&&r.result.siteMapId)||'');" "$CRAWL_RES")

# analyze
ANALYZE_REQ=$(cat <<JSON
{"jsonrpc":"2.0","method":"analyze","params":{"siteMapId":"$SITEMAP_ID"},"id":3}
JSON
)
ANALYZE_RES=$(send "$ANALYZE_REQ")
echo "[flow] analyze => $ANALYZE_RES"
ANALYSIS_ID=$(node -e "const r=JSON.parse(process.argv[1]); console.log((r.result&&r.result.analysisId)||'');" "$ANALYZE_RES")

# scaffold
SCAFFOLD_REQ=$(cat <<JSON
{"jsonrpc":"2.0","method":"scaffold","params":{"analysisId":"$ANALYSIS_ID","appRouter":true},"id":4}
JSON
)
SCAFFOLD_RES=$(send "$SCAFFOLD_REQ")
echo "[flow] scaffold => $SCAFFOLD_RES"
SCAFFOLD_ID=$(node -e "const r=JSON.parse(process.argv[1]); console.log((r.result&&r.result.scaffoldId)||'');" "$SCAFFOLD_RES")

# generate
GENERATE_REQ=$(cat <<JSON
{"jsonrpc":"2.0","method":"generate","params":{"analysisId":"$ANALYSIS_ID","scaffoldId":"$SCAFFOLD_ID","tailwindMode":"full"},"id":5}
JSON
)
GENERATE_RES=$(send "$GENERATE_REQ")
echo "[flow] generate => $GENERATE_RES"
GENERATION_ID=$(node -e "const r=JSON.parse(process.argv[1]); console.log((r.result&&r.result.generationId)||'');" "$GENERATE_RES")

# diff
DIFF_REQ=$(cat <<JSON
{"jsonrpc":"2.0","method":"diff","params":{"generationId":"$GENERATION_ID","baselines":"recrawl","viewport":{"w":1280,"h":800,"deviceScale":1},"threshold":0.01},"id":6}
JSON
)
DIFF_RES=$(send "$DIFF_REQ")
echo "[flow] diff => $DIFF_RES"

# audit
AUDIT_REQ=$(cat <<JSON
{"jsonrpc":"2.0","method":"audit","params":{"generationId":"$GENERATION_ID","tsStrict":true,"eslintConfig":"recommended"},"id":7}
JSON
)
AUDIT_RES=$(send "$AUDIT_REQ")
echo "[flow] audit => $AUDIT_RES"

# apply (dry-run by default)
if [[ "${APPLY_FLAG:-}" == "--apply" ]]; then
  APPLY_PARAMS='{"generationId":"'$GENERATION_ID'","target":"./","dryRun":false}'
else
  APPLY_PARAMS='{"generationId":"'$GENERATION_ID'","target":"./","dryRun":true}'
fi
APPLY_REQ=$(cat <<JSON
{"jsonrpc":"2.0","method":"apply","params":$APPLY_PARAMS,"id":8}
JSON
)
APPLY_RES=$(send "$APPLY_REQ")
echo "[flow] apply => $APPLY_RES"

echo "[flow] done. Generation: $GENERATION_ID"

