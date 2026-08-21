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
    'source Cookie rows (userId=' \
    "preflight must probe Cookie for the seed DEV_USER_ID, not empty MessageRecord dumps"
require_text "$MEASUREMENT" \
    'could not parse OS peak RSS from time output' \
    "missing RSS parse must fail the run instead of reporting 0MB"
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
require_text "$MEASUREMENT" \
    'ROSE_USE_SYSTEM_PG' \
    "measurement must support system Postgres when Docker overlay mounts fail"
require_text "$MEASUREMENT" \
    'victoria_seedmem_src_' \
    "system Postgres path must isolate source databases per measurement PID"
require_text "$MEASUREMENT" \
    'seed-mem-$$' \
    "default OUT_DIR must be PID-scoped so concurrent measurements cannot share summary.txt"
require_text "$MEASUREMENT" \
    'TIME_BIN' \
    "measurement must resolve an external time binary (not the shell builtin)"
require_text "$MEASUREMENT" \
    'docker rm -fv "$CONTAINER"' \
    "cold target cleanup must remove postgres anonymous volumes"
require_text "$MEASUREMENT" \
    'docker rm -fv "$SRC_CONTAINER"' \
    "cold source cleanup must remove its postgres anonymous volume"
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

# ── Source restore must fail closed ──
#
# A restore that did not fully apply leaves an incomplete source database, and
# the measurement silently becomes meaningless. Two real regressions came from
# tolerating too much here: `|| true` swallowed a header-level version refusal
# (surfacing as "no Cookie rows"), and a `grep -c ... || echo 0` produced the
# non-integer "0\n0" so an empty stderr took the tolerant branch. Exercise the
# actual classifier from the script against real pg_restore stderr shapes.
RESTORE_FILTER="$(sed -nE "s/^[[:space:]]*'(warning:\|WARNING:.*Command was:)' \\\\$/\1/p" "$MEASUREMENT" | head -1)"
[ -n "$RESTORE_FILTER" ] || fail "could not extract the benign-noise filter from measure-seed-memory.sh"

classify_restore() {
    local file="$1" unexpected lines
    unexpected="$(grep -vE "$RESTORE_FILTER" "$file" 2>/dev/null || true)"
    lines=$(grep -cvE '^[[:space:]]*$' "$file" 2>/dev/null) || lines=0
    case "$lines" in ''|*[!0-9]*) lines=0 ;; esac
    if [ -n "$unexpected" ] || [ "$lines" -eq 0 ]; then echo FATAL; else echo TOLERATED; fi
}

assert_restore_verdict() {
    local label="$1" want="$2" payload="$3" tmp got
    tmp="$(mktemp)"
    printf '%b' "$payload" > "$tmp"
    got="$(classify_restore "$tmp")"
    rm -f "$tmp"
    [ "$got" = "$want" ] || fail "restore classifier: $label -> $got (expected $want)"
    echo "PASS: restore classifier treats $label as $want"
}

# Silence cannot be classified as benign — nothing explained itself.
assert_restore_verdict "an empty stderr" FATAL ""
assert_restore_verdict "a blank-only stderr" FATAL "\n\n   \n"
# Header refusal: the dump was published by a newer pg_dump than this reader.
assert_restore_verdict "a version refusal" FATAL \
    "pg_restore: error: unsupported version (1.16) in file header\n"
# A restore-time SQL error leaves a partial database.
assert_restore_verdict "a restore-time SQL error" FATAL \
    "pg_restore: error: could not execute query: ERROR:  out of memory\n"
# Absent roles/extensions in a throwaway container are genuinely non-fatal.
assert_restore_verdict "role and extension noise" TOLERATED \
    "pg_restore: warning: errors ignored on restore: 2\npg_restore: error: role \"supabase_admin\" does not exist\npg_restore: error: extension \"pg_trgm\" already exists\npg_restore: while PROCESSING TOC:\npg_restore: from TOC entry 12; 1259 x\n    Command was: CREATE TABLE x;\n"

require_text "$MEASUREMENT" \
    'SRC_READY' \
    "source postgres readiness must be tracked, not assumed after the timeout"
require_text "$MEASUREMENT" \
    'SRC_RESTORE_STATUS' \
    "pg_restore exit status must be preserved, never discarded with || true"

echo "PASS: /deploy enforces five fidelity-verified cold seeds at the measured 230MB ratchet"
