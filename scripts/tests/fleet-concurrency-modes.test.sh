#!/usr/bin/env bash
# Structural contract for fleet DEMO concurrency e2e (no Fly).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

SCRIPT="$ROOT/scripts/run-fleet-concurrency-modes"
PLAN="$ROOT/docs/plans/active/fleet-demo-concurrency-e2e.md"
DEPLOY="$ROOT/.claude/commands/deploy.md"
TASKS="$ROOT/agents/benchmarks/tasks.json"

[ -f "$SCRIPT" ] || fail "missing $SCRIPT"
[ -f "$PLAN" ] || fail "missing $PLAN"
[ -f "$DEPLOY" ] || fail "missing $DEPLOY"

grep -Fq 'campaign_cap=1' "$SCRIPT" || fail "script must define sequential=campaign_cap=1"
grep -Fq 'campaign_cap' "$SCRIPT" || fail "script must mention campaign_cap"
grep -Fq 'run-bench-fleet' "$SCRIPT" || fail "script must invoke run-bench-fleet"
grep -Fq 'skip-autoscaler' "$SCRIPT" || fail "DEMO concurrency must pass --skip-autoscaler"
CLOUD="$ROOT/scripts/run-bench-cloud"
FLEET="$ROOT/scripts/run-bench-fleet"
grep -Fq 'CLOUDBENCH_CONTROLLER_LOCK_NAME' "$SCRIPT" \
  || fail "lane mode must set distinct CLOUDBENCH_CONTROLLER_LOCK_NAME per concurrent fleet"
grep -Fq 'cloudbench-controller-lane-' "$SCRIPT" \
  || fail "lane mode must use cloudbench-controller-lane-<task>.lock basename"
grep -Fq 'CLOUDBENCH_CONTROLLER_LOCK_NAME' "$FLEET" \
  || fail "run-bench-fleet must honor CLOUDBENCH_CONTROLLER_LOCK_NAME for concurrent lane fleets"
grep -Fq 'cloudbench_skip_held_driver_teardown_race' "$CLOUD" \
  || fail "run-bench-cloud must share held-driver teardown skip for DEMO/infra"
grep -Fq 'CLOUDBENCH_SKIP_AUTOSCALER' "$CLOUD" \
  || fail "run-bench-cloud must honor CLOUDBENCH_SKIP_AUTOSCALER for DONE+cleanup"
grep -Fq 'guest cleanup skipped for DEMO skip-autoscaler' "$CLOUD" \
  || fail "DEMO skip-autoscaler must skip guest cleanup handshake"
grep -Fq 'CLOUDBENCH_SKIP_AUTOSCALER="${SKIP_AUTOSCALER:-0}"' "$FLEET" \
  || fail "run-bench-fleet must plumb SKIP_AUTOSCALER into run-bench-cloud children"
grep -Fq 'demo-fleet-alpha' "$SCRIPT" || fail "script must use demo-fleet-alpha"
if grep -Fq 'test-mass-agent-run-0' "$SCRIPT"; then
  fail "script must not use mass-agent DEMO"
fi
grep -Fq 'dry-contract' "$SCRIPT" || fail "script must support dry-contract"

grep -Fq '1285' "$PLAN" || fail "plan must coordinate with PR 1285"
grep -Fq 'demo-fleet-alpha' "$PLAN" || fail "plan must name small DEMO tasks"
grep -Fq 'alongside' "$PLAN" || fail "plan must say gate runs alongside smokes"

# Soft until command-wiring PR lands Step 6d; script contracts above always bind.
if grep -Fq 'Step 6d' "$DEPLOY"; then
  grep -Fq 'run-fleet-concurrency-modes' "$DEPLOY" || fail "deploy.md must wire the concurrency e2e gate"
  grep -Fq 'run-fleet-infra-canary' "$DEPLOY" || fail "deploy.md Step 6d must run the infra canary"
  grep -Fq 'descend-command.test.sh' "$DEPLOY" || fail "deploy.md Step 6d must cement /descend concurrency docs"
  grep -Fq 'local_lock_busy' "$DEPLOY" || fail "deploy.md Step 6d must fail closed on lane lock serialization"
  grep -Fq '$0' "$DEPLOY" || fail "deploy.md Step 6d must keep DEMO concurrency at \$0 cache cost"
else
  echo "SKIP: deploy.md Step 6d not wired in this tree — runtime preflight + concurrency script contracts cover the gate"
fi

python3 - "$TASKS" <<'PY' || fail "catalog DEMO fleet tasks invalid"
import json, sys
from pathlib import Path
wanted = ["demo-fleet-alpha", "demo-fleet-beta", "demo-fleet-gamma"]
tasks = json.loads(Path(sys.argv[1]).read_text())
by = {t["name"]: t for t in tasks}
for name in wanted:
    t = by[name]
    tags = t.get("tags") or []
    assert "DEMO" in tags, name
    assert "smoke" not in tags, name
    assert "fleet-concurrency" in tags, name
    assert t.get("demo_cache") == "on", name
    assert int(t.get("min_agent_count") or 0) < 50, name
    assert t.get("enforce_declared_evaluators") is True, name
    assert t.get("is_chat_mode") is False, f"{name} must be agent mode (COMPLETED)"
    assert t.get("start_phase") == "execute", f"{name} must start in execute"
    assert "attempt_completion" in (t.get("expected_tools") or []), name
print("catalog ok")
PY

OUT_FILE="$ROOT/.context/fleet-concurrency-dry-contract.out"
mkdir -p "$ROOT/.context"
bash "$SCRIPT" --dry-contract >"$OUT_FILE"
grep -Fq 'sequential' "$OUT_FILE" || fail "dry-contract must mention sequential"
grep -Fq 'lane' "$OUT_FILE" || fail "dry-contract must mention lane"
grep -Fq 'parallel' "$OUT_FILE" || fail "dry-contract must mention parallel"
grep -Fq 'dry-contract OK' "$OUT_FILE" || fail "dry-contract must exit cleanly"
grep -Fq 'demo-fleet-alpha' "$OUT_FILE" || fail "dry-contract must list DEMO tasks"

if bash "$SCRIPT" --dry-contract --cap 99 >"$OUT_FILE" 2>&1; then
  fail "cap>task-count must fail"
else
  pass "cap overflow rejected"
fi

# Validate before shift so a trailing --mode/--cap reports exit 2 (not set -e 1).
rc=0
bash "$SCRIPT" --mode >/tmp/fleet-concurrency-mode-missing.out 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "trailing --mode must exit 2 (got $rc)"
grep -Eqi 'unknown --mode' /tmp/fleet-concurrency-mode-missing.out \
  || fail "trailing --mode must report unknown mode"

rc=0
bash "$SCRIPT" --cap >/tmp/fleet-concurrency-cap-missing.out 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "trailing --cap must exit 2 (got $rc)"
grep -Eqi 'positive integer' /tmp/fleet-concurrency-cap-missing.out \
  || fail "trailing --cap must report positive-integer requirement"

pass "fleet DEMO concurrency e2e contracts"
