#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_COMMAND="$ROOT_DIR/.claude/commands/deploy.md"
MEASUREMENT="$ROOT_DIR/back-end/scripts/measure-seed-memory.sh"
BUDGET="$ROOT_DIR/back-end/src/providers/seedMemoryBudget.ts"
SEED="$ROOT_DIR/back-end/scripts/seed-local.ts"

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

require_text() {
    local file="$1"
    local text="$2"
    local description="$3"
    grep -Fq -- "$text" "$file" || fail "$description"
}

require_text "$DEPLOY_COMMAND" \
    'bash scripts/measure-seed-memory.sh 5 0 0 --enforce-budget' \
    "/deploy must run five cold memory measurements with enforcement"
require_text "$DEPLOY_COMMAND" \
    'run-deploy-stage seed-memory-ratchet' \
    "/deploy must record the seed memory gate"
require_text "$MEASUREMENT" \
    'budget enforcement requires exactly five cold runs' \
    "measurement enforcement must reject a smaller favorable sample"
require_text "$MEASUREMENT" \
    'source Cookie rows' \
    "preflight must probe Cookie (fidelity table), not empty MessageRecord dumps"
require_text "$MEASUREMENT" \
    'Maximum resident set size' \
    "Linux GNU time -v RSS parsing must stay wired alongside BSD time -l"
require_text "$MEASUREMENT" \
    'fidelity="verified"' \
    "measurement must distinguish fidelity-verified runs"
require_text "$MEASUREMENT" \
    'if failed or len(peaks) != requested_runs:' \
    "failed measurements must fail enforcement instead of being excluded"
require_text "$MEASUREMENT" \
    'math.ceil(peaks[-1] * 1.2)' \
    "suggested budget must round 20% headroom up"
require_text "$BUDGET" \
    'SEED_PEAK_RSS_BUDGET_MB = 230' \
    "budget must remain cemented to ceil(191MB * 1.20)"
require_text "$BUDGET" \
    'SEED_RSS_HEADROOM_RATIO = 0.2' \
    "headroom ratio must remain exactly 20%"

for table in LocalStorageOrigin IndexedDBOrigin CacheStorageOrigin; do
    require_text "$SEED" \
        "syncJsonbOriginTable('$table')" \
        "$table must remain on the streaming database boundary"
done

echo "PASS: /deploy enforces five fidelity-verified cold seeds at the measured 230MB ratchet"
