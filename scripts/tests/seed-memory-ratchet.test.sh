#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STRUCTURAL_GATES="$ROOT_DIR/scripts/run-deploy-structural-gates.py"
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

# The /deploy path runs this gate through the planner's standard template
# (scripts/deploy_test_plan.py), not an inline script in deploy.md: five cold
# measurements with budget enforcement from back-end/, selected for back-end,
# agents and scripts changes and omitted (with a reason) for unrelated ones.
python3 - "$ROOT_DIR" <<'PY' || fail "/deploy must run five cold memory measurements with enforcement"
import sys
from pathlib import Path

sys.dont_write_bytecode = True
root = Path(sys.argv[1])
sys.path.insert(0, str(root / "scripts"))
import deploy_test_plan as plan

template = plan.standard_template()
gates = [gate for gate in template["gates"] if gate["name"] == "seed-memory-ratchet"]
assert len(gates) == 1, gates
gate = gates[0]
assert gate["command"] == ["bash", "scripts/measure-seed-memory.sh", "5", "0", "0", "--enforce-budget"], gate["command"]
assert gate["cwd"] == "back-end", gate["cwd"]
# The staged runner records its result under this exact gate and check name.
assert gate["checks"] == ["seed-memory-ratchet"], gate["checks"]
assert (root / gate["cwd"] / gate["command"][1]).is_file(), "the gate command must exist relative to its cwd"

result = {"all": False, "reasons": [], "lanes": {lane: [] for lanes in plan.GRAPH_LANES.values() for lane in lanes}}
def selected(changed):
    chosen = plan.select(template, changed, result, None)
    return "seed-memory-ratchet" in {g["name"] for g in chosen["gates"]}, chosen["omitted"]
for changed in (["back-end/src/server.ts"], ["agents/helpers/messages.py"], ["scripts/run.sh"]):
    assert selected(changed)[0], changed
picked, omitted = selected(["docs/api/agents.mdx"])
assert not picked and any(row["gate"] == "seed-memory-ratchet" for row in omitted), omitted
PY
# The suite itself is a registered structural gate (it cannot be dropped silently).
grep -Fq 'Gate("seed-memory-ratchet", ("bash", "scripts/tests/seed-memory-ratchet.test.sh"))' "$STRUCTURAL_GATES" ||
    fail "run-deploy-structural-gates.py must register the seed-memory-ratchet suite"
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
    'Docker Postgres unavailable — falling back to system Postgres' \
    "measurement must fall back to system Postgres when Docker overlay mounts fail"
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
require_text "$MEASUREMENT" \
    'wait_for_seed_memory_host_postgres "$PORT" victoria "$HOST_PROBE_LOG"' \
    "cold target schema push must wait for the published host port"
require_text "$MEASUREMENT" \
    'PGCONNECT_TIMEOUT=2 PGPASSWORD=postgres psql -h localhost' \
    "host readiness must probe the same hostname Prisma uses with bounded connection attempts"
require_text "$MEASUREMENT" \
    'SCHEMA_PUSH_LOG="$OUT_DIR/schema-push-$i.log"' \
    "schema push failures must retain the Prisma diagnostic"
require_text "$BUDGET" \
    'SEED_PEAK_RSS_BUDGET_MB = 228' \
    "budget must remain cemented to ceil(190MB * 1.20)"
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
require_text "$MEASUREMENT" \
    'restore that original mode before measuring' \
    "restore validation must not leave errexit enabled for the measured seed"

# Execute the actual progress statement: unbraced variables adjoining Unicode
# punctuation can be parsed as a different identifier by macOS Bash.
MEASUREMENT="$MEASUREMENT" TEST_SHELL="$BASH" python3 - <<'PY'
import os
from pathlib import Path
import re
import subprocess
import tempfile

source = Path(os.environ["MEASUREMENT"]).read_text()
statements = [
    line.strip()
    for line in source.splitlines()
    if "restoring source into " in line
]
assert len(statements) == 1, statements
cleanup = re.search(r"(?ms)^cleanup\(\) \{.*?^trap cleanup_all EXIT INT TERM$", source)
assert cleanup is not None
for locale in ("C", "en_US.UTF-8", "C.UTF-8"):
    for pipeline_failure in (False, True):
        command = "\n".join([
            'dropdb() { printf "drop %s\\n" "${!#}" >> "$TRACE"; }',
            cleanup.group(),
            'unset SEED_TEST_UNSET; printf "%s\\n" "$SEED_TEST_UNSET" | tee -a "$SUMMARY"'
            if pipeline_failure else statements[0],
            'status=$?; printf "after:%s\\n" "$status" >> "$TRACE"; exit "$status"',
        ])
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / "cleanup.log"
            summary = Path(directory) / "summary.txt"
            script = Path(directory) / "source-progress.sh"
            script.write_text(command + "\n")
            env = dict(os.environ, LC_ALL=locale, LC_CTYPE=locale, LANG=locale,
                       SRC_DB="local_source", TARGET_DB="local_target", USE_SYSTEM_PG="true",
                       SUMMARY=str(summary), TRACE=str(trace))
            result = subprocess.run(
                [os.environ["TEST_SHELL"], "-uo", "pipefail", str(script)],
                env=env, capture_output=True, timeout=5,
            )
            assert (result.returncode != 0) is pipeline_failure, (locale, result.stderr)
            expected = b"" if pipeline_failure else "   restoring source into local_source…\n".encode()
            assert result.stdout == summary.read_bytes() == expected, (locale, result.stdout)
            assert trace.read_text() == (
                f"after:{result.returncode}\ndrop local_target\ndrop local_source\n"
            ), (locale, pipeline_failure, trace.read_text())
print("PASS: source progress is locale-safe and pipeline children cannot retire owner databases")
PY

# The container can report ready before Docker publishes its host port. Exercise
# the exact host readiness helper with mocked psql failures followed by success.
eval "$(sed -n '/^wait_for_seed_memory_host_postgres() {/,/^}/p' "$MEASUREMENT")"
probe_diagnostic="$(mktemp)"
trap 'rm -f "$probe_diagnostic"' EXIT
attempts=0
psql() { attempts=$((attempts + 1)); [ "$attempts" -ge 3 ]; }
sleep() { :; }
wait_for_seed_memory_host_postgres 55175 victoria "$probe_diagnostic" || fail "host readiness must retry a delayed published port"
[ "$attempts" -eq 3 ] || fail "host readiness must wait for the successful published-port probe"
attempts=0
psql() { attempts=$((attempts + 1)); echo 'simulated connection refusal' >&2; return 1; }
if wait_for_seed_memory_host_postgres 55175 victoria "$probe_diagnostic"; then
    fail "host readiness must reject an unreachable published port"
fi
[ "$attempts" -eq 30 ] || fail "host readiness must stop after its bounded retry window"
grep -Fq 'simulated connection refusal' "$probe_diagnostic" || fail "host readiness must retain the last probe diagnostic"

echo "PASS: /deploy enforces five fidelity-verified cold seeds at the measured 228MB ratchet"
