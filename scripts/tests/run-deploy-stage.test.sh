#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
RUN_ROOT="$TEST_ROOT/default"
cleanup() {
    local result=$?
    touch "$TEST_ROOT/slow-release"
    for pid in "${slow_pid:-}" "${finish_pid:-}"; do
        if [ -n "$pid" ] && jobs -pr | grep -Fxq "$pid"; then
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done
    for pid in "${slow_pid:-}" "${finish_pid:-}"; do
        [ -z "$pid" ] || wait "$pid" 2>/dev/null || true
    done
    if [ "$result" -ne 0 ]; then
        local artifacts="${BLACKBOX_TEST_ARTIFACT_DIR:-$ROOT_DIR/.context/test-runs}"
        local retained="$artifacts/deploy-stage-$(date -u +%Y%m%dT%H%M%SZ)-$$"
        if mkdir -p "$artifacts" && mkdir -m 700 "$retained"; then
            cp -R "$TEST_ROOT/." "$retained/" 2>/dev/null || true
            echo "deploy-stage fixture retained: $retained" >&2
        fi
    fi
    rm -rf "$TEST_ROOT"
    return "$result"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

run_stage() {
    DEPLOY_RUN_ROOT="$RUN_ROOT" bash "$ROOT_DIR/scripts/run-deploy-stage" "$@"
}

# Timed stages stay in one Python supervisor process. Reintroducing the old
# shell -> logger -> three lifecycle-CLI process chain adds almost a second to
# every deploy gate and makes signal ownership ambiguous.
grep -Fq 'exec python3 "$STAGE_RUNNER"' "$ROOT_DIR/scripts/run-deploy-stage" \
    || fail "timed stages are not delegated to the single-process runner"
grep -Fq 'ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"' \
    "$ROOT_DIR/scripts/run-deploy-stage" \
    || fail "stage wrapper pays for git root discovery on every invocation"

# A successful finish closes the run and prevents later stages from corrupting it.
RUN_ROOT="$TEST_ROOT/lifecycle"
run_stage --start --run-id lifecycle >/dev/null
if run_stage --start --run-id replacement >"$TEST_ROOT/replacement.out" 2>&1; then
    fail "replaced an active timing run"
fi
grep -q "deploy timing run already active" "$TEST_ROOT/replacement.out" \
    || fail "missing active-run diagnostic"
run_stage sample -- bash -c 'printf "sample output\n"' >/dev/null
run_stage --finish >/dev/null
[ ! -e "$RUN_ROOT/current" ] || fail "finish left the current-run pointer behind"
if run_stage late -- true >"$TEST_ROOT/late.out" 2>&1; then
    fail "stage appended without an active timing run"
fi
grep -q "no active deploy timing run" "$TEST_ROOT/late.out" \
    || fail "missing inactive-run diagnostic"

# Successful deterministic gates may be reused only for an identical command
# and exact worktree snapshot in the same deploy. Failures are never reusable.
# The snapshot is a whole-worktree fingerprint, so this runs in its own
# committed fixture repository: on a shared checkout another editor can change
# the real tree between the two calls ("deploy inputs changed while cached
# ran") and the reuse miss would be the environment, not the runner.
REUSE_REPO="$TEST_ROOT/reuse-repo"
mkdir -p "$REUSE_REPO/scripts"
cp "$ROOT_DIR/scripts/run-deploy-stage" "$ROOT_DIR/scripts/run_deploy_stage.py" \
    "$ROOT_DIR/scripts/deploy_stage.py" "$ROOT_DIR/scripts/factory_metadata.py" \
    "$ROOT_DIR/scripts/factory_detail.py" "$REUSE_REPO/scripts/"
printf 'fixture\n' > "$REUSE_REPO/README"
printf '.context/\n' > "$REUSE_REPO/.gitignore"
git -C "$REUSE_REPO" init -q
git -C "$REUSE_REPO" add -A
git -C "$REUSE_REPO" -c user.name=t -c user.email=t@t commit -qm fixture
RUN_ROOT="$TEST_ROOT/reuse"
reuse_stage() {
    (cd "$REUSE_REPO" && DEPLOY_RUN_ROOT="$RUN_ROOT" bash scripts/run-deploy-stage "$@")
}
reuse_stage --start --run-id reuse >/dev/null
counter="$TEST_ROOT/reuse-counter"
reuse_stage cached --reuse-passed -- bash -c 'printf "run\n" >> "$1"' _ "$counter" >/dev/null
reuse_stage cached --reuse-passed -- bash -c 'printf "run\n" >> "$1"' _ "$counter" >"$TEST_ROOT/reused.out"
[ "$(wc -l < "$counter" | tr -d ' ')" = 1 ] || fail "identical passed gate executed twice"
grep -q "reused passed deploy stage" "$TEST_ROOT/reused.out" || fail "cache hit was not disclosed"
reuse_stage cached --reuse-passed -- bash -c 'printf "changed-command\n" >> "$1"' _ "$counter" >/dev/null
[ "$(wc -l < "$counter" | tr -d ' ')" = 2 ] || fail "changed command reused stale evidence"
failed_counter="$TEST_ROOT/reuse-failed-counter"
for _ in 1 2; do
    if reuse_stage failed-cache --reuse-passed -- bash -c 'printf "failed\n" >> "$1"; exit 1' _ "$failed_counter" >/dev/null; then
        fail "failing cache fixture reported success"
    fi
done
[ "$(wc -l < "$failed_counter" | tr -d ' ')" = 2 ] || fail "failed gate was reused"

# Lane-scoped reuse (default OFF). A lane in _SCOPED_REUSE_LANES may reuse its
# prior PASSED result for the identical command when every path changed since
# that pass is inert for it: in the lane's declared inert set AND selecting
# none of its tests in the change->test graph (run_all triggers and unmapped
# files always rerun). The hit is labelled "reused-scoped" with provenance.
# This runs in its own committed fixture repository that carries the selector
# and a minimal multi-package tree, so the real checkout never influences it.
SCOPED_REPO="$TEST_ROOT/scoped-repo"
mkdir -p "$SCOPED_REPO/scripts/test-map" "$SCOPED_REPO/back-end/src/tests/blackbox" \
    "$SCOPED_REPO/back-end/src/tests/unit" "$SCOPED_REPO/back-end/prisma" \
    "$SCOPED_REPO/agents/tests/blackbox" "$SCOPED_REPO/agents/tests/unit" "$SCOPED_REPO/docs"
cp "$ROOT_DIR/scripts/run-deploy-stage" "$ROOT_DIR/scripts/run_deploy_stage.py" \
    "$ROOT_DIR/scripts/deploy_stage.py" "$ROOT_DIR/scripts/factory_metadata.py" \
    "$ROOT_DIR/scripts/factory_detail.py" "$ROOT_DIR/scripts/select_affected_tests.py" "$SCOPED_REPO/scripts/"
cp "$ROOT_DIR/scripts/test-map/edges.json" "$SCOPED_REPO/scripts/test-map/"
printf '{"scripts": {"test:structural": "tsx src/tests/structural/none.test.ts"}}\n' > "$SCOPED_REPO/back-end/package.json"
printf 'export {};\n' > "$SCOPED_REPO/back-end/src/bootstrap.ts"
# A backend blackbox that reads a docs page: the graph must veto that page.
printf 'const contract = "docs/contract.md";\nexport { contract };\n' > "$SCOPED_REPO/back-end/src/tests/blackbox/health.blackbox.ts"
printf 'export {};\n' > "$SCOPED_REPO/back-end/src/tests/unit/sample.test.ts"
printf 'model A { id Int @id }\n' > "$SCOPED_REPO/back-end/prisma/schema.prisma"
printf 'x = 1\n' > "$SCOPED_REPO/agents/tests/blackbox/sample.blackbox.py"
printf 'def test_sample():\n    pass\n' > "$SCOPED_REPO/agents/tests/unit/test_sample.py"
printf 'guide v1\n' > "$SCOPED_REPO/docs/guide.md"
printf 'contract v1\n' > "$SCOPED_REPO/docs/contract.md"
printf '.context/\n__pycache__/\n' > "$SCOPED_REPO/.gitignore"
git -C "$SCOPED_REPO" init -q
scoped_commit() {
    git -C "$SCOPED_REPO" add -A
    git -C "$SCOPED_REPO" -c user.name=t -c user.email=t@t commit -qm "$1"
    git -C "$SCOPED_REPO" rev-parse HEAD
}
SCOPED_H1="$(scoped_commit fixture)"
RUN_ROOT="$TEST_ROOT/scoped"
SCOPED_LANES="backend-coverage-blackbox live-probes agents-coverage-blackbox smoke semantic-stack"
scoped_stage() {
    (cd "$SCOPED_REPO" && DEPLOY_RUN_ROOT="$RUN_ROOT" bash scripts/run-deploy-stage "$@")
}
# The lane's real command marker (argv), without which the lane name alone
# must never select its inert set. Carried as $0 of the fixture command.
scoped_marker() {
    case "$1" in
        backend-coverage-blackbox) echo "npm run test:coverage:sharded" ;;
        live-probes) echo "python3 scripts/run_deploy_live_probes.py" ;;
        agents-coverage-blackbox) echo "bash scripts/run-coverage.sh" ;;
        smoke) echo "bash scripts/run-predeploy-local" ;;
        semantic-stack) echo "bash front-end/scripts/run-semantic-tests.sh" ;;
        *) echo "_" ;;
    esac
}
# scoped_run LANE [FLAG...]: the lane's counting command (identical argv on
# every call; it waits while the lane's hang marker file exists and fails
# only while its fail marker file exists, with that file's exit code or 1).
SCOPED_COMMAND='printf "run\n" >> "$1"; while [ -e "$3" ]; do sleep 0.05; done; [ ! -e "$2" ] || { code="$(cat "$2")"; exit "${code:-1}"; }'
scoped_args() {
    printf '%s\n' "$(scoped_marker "$1")" "$TEST_ROOT/scoped-count-$1" "$TEST_ROOT/scoped-fail-$1" "$TEST_ROOT/scoped-hang-$1"
}
scoped_run() {
    local lane="$1"
    shift
    local -a args
    mapfile -t args < <(scoped_args "$lane")
    scoped_stage "$lane" "$@" -- bash -c "$SCOPED_COMMAND" "${args[@]}"
}
scoped_runs() {
    wc -l < "$TEST_ROOT/scoped-count-$1" | tr -d ' '
}
# scoped_row LANE KEY [KEY...]: a field of the lane's latest stage row.
scoped_row() {
    python3 - "$RUN_ROOT/scoped/stages.jsonl" "$@" <<'PYEOF'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
value = [row for row in rows if row.get("stage") == sys.argv[2]][-1]
for key in sys.argv[3:]:
    value = value[int(key)] if isinstance(value, list) else value.get(key)
print(value if isinstance(value, str) else json.dumps(value))
PYEOF
}
scoped_stage --start --run-id scoped >/dev/null
for lane in $SCOPED_LANES; do
    scoped_run "$lane" --lane-scoped-reuse >"$TEST_ROOT/scoped-first-$lane.out" \
        || fail "first $lane run failed"
    [ "$(scoped_runs "$lane")" = 1 ] || fail "$lane did not run at H1"
    grep -q "lane-scoped reuse unavailable for $lane: no prior pass" "$TEST_ROOT/scoped-first-$lane.out" \
        || fail "$lane did not disclose the missing prior pass"
done

# (1) Docs-only commit: every scoped lane reuses its H1 pass with provenance.
printf 'guide v2\n' > "$SCOPED_REPO/docs/guide.md"
SCOPED_H2="$(scoped_commit docs)"
for lane in $SCOPED_LANES; do
    scoped_run "$lane" --lane-scoped-reuse >"$TEST_ROOT/scoped-docs-$lane.out" || fail "docs-only $lane failed"
    [ "$(scoped_runs "$lane")" = 1 ] || fail "docs-only commit reran $lane"
    grep -q "reused passed deploy stage (lane-scoped): $lane passed_head=${SCOPED_H1:0:12} current_head=${SCOPED_H2:0:12} inert_paths=1" \
        "$TEST_ROOT/scoped-docs-$lane.out" || fail "docs-only reuse of $lane was not disclosed"
    [ "$(scoped_row "$lane" status)" = "reused-scoped" ] || fail "$lane row is not labelled reused-scoped"
    [ "$(scoped_row "$lane" exit_code)" = 0 ] || fail "$lane reused row exit code"
    [ "$(scoped_row "$lane" detail reuse kind)" = "scoped" ] || fail "$lane row lacks reuse kind"
    [ "$(scoped_row "$lane" detail reuse passed_head)" = "$SCOPED_H1" ] || fail "$lane row lacks the passed head"
    [ "$(scoped_row "$lane" detail reuse current_head)" = "$SCOPED_H2" ] || fail "$lane row lacks the current head"
    [ "$(scoped_row "$lane" detail reuse passed_run_id)" = "scoped" ] || fail "$lane row lacks the passed run id"
    SCOPED_FP="$(scoped_row "$lane" detail reuse passed_fingerprint)"
    [ "${#SCOPED_FP}" = 64 ] || fail "$lane row lacks the passed fingerprint"
    [ -f "$RUN_ROOT/scoped/passed-cache/$lane/$SCOPED_FP.json" ] || fail "$lane passed fingerprint is not the recorded pass"
    [ "$(scoped_row "$lane" detail reuse changed 0 path)" = "docs/guide.md" ] || fail "$lane row lacks the judged path"
    [ "$(scoped_row "$lane" detail reuse changed 0 rule)" = "inert:docs/*" ] || fail "$lane row lacks the inert rule"
    scoped_row "$lane" detail reuse changed 0 graph | grep -q '^graph:no ' || fail "$lane row lacks the graph rule"
done
[ "$(scoped_row smoke detail reuse changed 0 graph)" = "graph:no ALL fallback" ] || fail "runtime lane graph rule"
[ "$(scoped_row backend-coverage-blackbox detail reuse changed 0 graph)" = "graph:no backend-blackbox/backend-unit test selected" ] \
    || fail "backend lane graph rule"
# The exact-input cache never learns a scoped hit: the current bytes were not executed.
[ "$(ls "$RUN_ROOT/scoped/passed-cache/smoke/"*.json | wc -l | tr -d ' ')" = 1 ] || fail "scoped hit was cached as an exact pass"

# (5) Flag off: today's behaviour, the lane reruns and records a plain pass.
scoped_run backend-coverage-blackbox --reuse-passed >"$TEST_ROOT/scoped-off.out" || fail "flag-off run failed"
[ "$(scoped_runs backend-coverage-blackbox)" = 2 ] || fail "lane-scoped reuse fired without its flag"
[ "$(scoped_row backend-coverage-blackbox status)" = "passed" ] || fail "flag-off row is not a plain pass"
if grep -q "lane-scoped" "$TEST_ROOT/scoped-off.out"; then
    fail "flag-off run mentioned lane-scoped reuse"
fi
# DEPLOY_LANE_SCOPED_REUSE is a scheduling knob: setting it must not break the exact-input match.
scoped_run backend-coverage-blackbox --reuse-passed >/dev/null || fail "exact rerun failed"
[ "$(scoped_runs backend-coverage-blackbox)" = 2 ] || fail "exact reuse of the flag-off pass missed"
DEPLOY_LANE_SCOPED_REUSE=0 scoped_run backend-coverage-blackbox --reuse-passed >"$TEST_ROOT/scoped-exact.out" || fail "env exact run failed"
[ "$(scoped_runs backend-coverage-blackbox)" = 2 ] || fail "the scheduling env var changed the exact fingerprint"
grep -q "== reused passed deploy stage: backend-coverage-blackbox" "$TEST_ROOT/scoped-exact.out" || fail "exact reuse must precede the scoped lookup"
# The environment never enables: without the flag a docs-only tree still reruns.
DEPLOY_LANE_SCOPED_REUSE=1 scoped_run live-probes >"$TEST_ROOT/scoped-env-only.out" || fail "env-only run failed"
[ "$(scoped_runs live-probes)" = 2 ] || fail "DEPLOY_LANE_SCOPED_REUSE=1 enabled lane-scoped reuse without the plan flag"
[ "$(scoped_row live-probes status)" = "passed" ] || fail "env-only run row"
# The kill switch disables even with the flag.
DEPLOY_LANE_SCOPED_REUSE=0 scoped_run semantic-stack --lane-scoped-reuse >"$TEST_ROOT/scoped-kill.out" || fail "kill-switch run failed"
[ "$(scoped_runs semantic-stack)" = 2 ] || fail "DEPLOY_LANE_SCOPED_REUSE=0 did not disable lane-scoped reuse"
if grep -q "lane-scoped" "$TEST_ROOT/scoped-kill.out"; then
    fail "kill-switch run consulted lane-scoped reuse"
fi
# A stage named like a scoped lane running another command is never judged by
# that lane's inert set: no reuse and no scoped record for the lane.
scoped_stage smoke --lane-scoped-reuse -- bash -c 'printf "other\n" >> "$1"' _ "$TEST_ROOT/scoped-count-smoke-other" \
    >"$TEST_ROOT/scoped-other.out" || fail "marker-less smoke run failed"
if grep -q "lane-scoped" "$TEST_ROOT/scoped-other.out"; then
    fail "marker-less smoke command was judged by the smoke inert set"
fi
[ "$(ls "$RUN_ROOT/scoped/passed-cache/smoke/scoped/"*.json | wc -l | tr -d ' ')" = 1 ] || fail "marker-less smoke pass recorded a scoped head"

# (2) Agents test-only commit: agents coverage reruns; backend, live probes,
# smoke and semantic are reused-scoped (each from its latest pass).
printf 'x = 2\n' > "$SCOPED_REPO/agents/tests/blackbox/sample.blackbox.py"
SCOPED_H3="$(scoped_commit agents-test)"
for lane in $SCOPED_LANES; do
    scoped_run "$lane" --lane-scoped-reuse >"$TEST_ROOT/scoped-agents-$lane.out" || fail "agents-test $lane failed"
done
[ "$(scoped_runs agents-coverage-blackbox)" = 2 ] || fail "agents test change did not rerun agents coverage"
grep -q "rerun: agents/tests/blackbox/sample.blackbox.py (not in the lane's declared inert set" \
    "$TEST_ROOT/scoped-agents-agents-coverage-blackbox.out" || fail "agents rerun reason not disclosed"
[ "$(scoped_row agents-coverage-blackbox status)" = "passed" ] || fail "agents rerun row status"
[ "$(scoped_row agents-coverage-blackbox detail reuse scoped miss_reason)" = "1 changed path(s) are not provably inert" ] \
    || fail "agents rerun row lacks the scoped miss reason"
[ "$(scoped_row agents-coverage-blackbox detail reuse scoped blocked 0 path)" = "agents/tests/blackbox/sample.blackbox.py" ] \
    || fail "agents rerun row lacks the blocking path"
[ "$(scoped_runs backend-coverage-blackbox)" = 2 ] || fail "agents test change reran backend coverage"
[ "$(scoped_row backend-coverage-blackbox detail reuse passed_head)" = "$SCOPED_H2" ] || fail "backend did not reuse its latest pass"
[ "$(scoped_runs smoke)" = 1 ] || fail "agents test change reran smoke"
for lane in live-probes semantic-stack; do
    [ "$(scoped_runs "$lane")" = 2 ] || fail "agents test change reran $lane"
done
for lane in live-probes smoke semantic-stack; do
    [ "$(scoped_row "$lane" status)" = "reused-scoped" ] || fail "$lane not reused-scoped after agents test change"
    [ "$(scoped_row "$lane" detail reuse current_head)" = "$SCOPED_H3" ] || fail "$lane provenance head"
done

# A docs page a backend blackbox reads: declared inert, but the graph selects
# the test, so the backend lanes rerun while the others stay reused.
printf 'contract v2\n' > "$SCOPED_REPO/docs/contract.md"
scoped_commit contract >/dev/null
for lane in $SCOPED_LANES; do
    scoped_run "$lane" --lane-scoped-reuse >"$TEST_ROOT/scoped-contract-$lane.out" || fail "contract $lane failed"
done
[ "$(scoped_runs backend-coverage-blackbox)" = 3 ] || fail "graph-selected docs page did not rerun backend coverage"
[ "$(scoped_runs live-probes)" = 3 ] || fail "graph-selected docs page did not rerun live probes"
[ "$(scoped_row backend-coverage-blackbox detail reuse scoped blocked 0 rule)" = "inert:docs/*" ] || fail "contract declared rule"
[ "$(scoped_row backend-coverage-blackbox detail reuse scoped blocked 0 graph)" = "graph:selects backend-blackbox: health" ] \
    || fail "contract graph veto not recorded"
[ "$(scoped_runs agents-coverage-blackbox)" = 2 ] || fail "contract page reran agents coverage"
[ "$(scoped_runs smoke)" = 1 ] && [ "$(scoped_runs semantic-stack)" = 2 ] || fail "contract page reran a runtime lane"

# (3) Schema/migration or lockfile change: nothing is reused.
printf 'model A { id Int @id\n  b Int }\n' > "$SCOPED_REPO/back-end/prisma/schema.prisma"
printf '{}\n' > "$SCOPED_REPO/package-lock.json"
scoped_commit schema >/dev/null
for lane in $SCOPED_LANES; do
    scoped_run "$lane" --lane-scoped-reuse >"$TEST_ROOT/scoped-schema-$lane.out" || fail "schema $lane failed"
    [ "$(scoped_row "$lane" status)" = "passed" ] || fail "schema change left $lane reused"
    grep -q "rerun: back-end/prisma/schema.prisma (not in the lane's declared inert set" "$TEST_ROOT/scoped-schema-$lane.out" \
        || fail "schema rerun reason not disclosed for $lane"
done
[ "$(scoped_runs smoke)" = 2 ] || fail "schema change did not rerun smoke"

# (4) An unmapped file inside another package's test tree passes the declared
# set but the graph falls back to ALL: nothing is reused.
printf 'export const helper = 1;\n' > "$SCOPED_REPO/back-end/src/tests/helpers.unmapped.ts"
scoped_commit unmapped >/dev/null
for lane in agents-coverage-blackbox smoke semantic-stack; do
    scoped_run "$lane" --lane-scoped-reuse >"$TEST_ROOT/scoped-unmapped-$lane.out" || fail "unmapped $lane failed"
    [ "$(scoped_row "$lane" status)" = "passed" ] || fail "unmapped file left $lane reused"
    [ "$(scoped_row "$lane" detail reuse scoped blocked 0 rule)" = "inert:back-end/src/tests/*" ] || fail "unmapped declared rule for $lane"
    scoped_row "$lane" detail reuse scoped blocked 0 graph | grep -q '^graph:ALL (unmapped files reach no test: back-end/src/tests/helpers.unmapped.ts' \
        || fail "unmapped graph veto not recorded for $lane"
done
[ "$(scoped_runs smoke)" = 3 ] || fail "unmapped file did not rerun smoke"

# (6) Failed-head veto: a pass, then a docs-only commit whose flag-off run
# FAILED, then another docs-only commit with the flag: the failure is newer
# evidence about an inert-equivalent tree, so the lane reruns; once that rerun
# passes, the next docs-only commit reuses again.
# The unmapped-file scenario above left a real smoke pass on the current head.
SCOPED_HV1="$(git -C "$SCOPED_REPO" rev-parse HEAD)"
[ "$(scoped_row smoke status)" = "passed" ] || fail "veto baseline status"
printf 'guide v4\n' > "$SCOPED_REPO/docs/guide.md"
SCOPED_HV2="$(scoped_commit docs-v4)"
touch "$TEST_ROOT/scoped-fail-smoke"
if scoped_run smoke >"$TEST_ROOT/scoped-veto-fail.out"; then
    fail "fail-marked smoke run reported success"
fi
rm -f "$TEST_ROOT/scoped-fail-smoke"
[ "$(ls "$RUN_ROOT/scoped/passed-cache/smoke/scoped-failed/"*.json | wc -l | tr -d ' ')" = 1 ] || fail "failed head was not recorded"
printf 'guide v5\n' > "$SCOPED_REPO/docs/guide.md"
SCOPED_HV3="$(scoped_commit docs-v5)"
runs_before="$(scoped_runs smoke)"
scoped_run smoke --lane-scoped-reuse >"$TEST_ROOT/scoped-veto.out" || fail "vetoed smoke run failed"
[ "$(scoped_runs smoke)" = "$((runs_before + 1))" ] || fail "a failed inert-equivalent head did not veto the scoped reuse"
grep -q "lane-scoped reuse unavailable for smoke: a failed run on ${SCOPED_HV2:0:12} differs from the current tree only by inert paths" \
    "$TEST_ROOT/scoped-veto.out" || fail "veto reason not disclosed"
[ "$(scoped_row smoke status)" = "passed" ] || fail "vetoed run row status"
[ "$(scoped_row smoke detail reuse scoped vetoed_by_failed_head failed_head)" = "$SCOPED_HV2" ] || fail "veto provenance head"
[ "$(scoped_row smoke detail reuse scoped passed_head)" = "$SCOPED_HV1" ] || fail "veto provenance candidate"
printf 'guide v6\n' > "$SCOPED_REPO/docs/guide.md"
scoped_commit docs-v6 >/dev/null
scoped_run smoke --lane-scoped-reuse >"$TEST_ROOT/scoped-after-veto.out" || fail "post-veto run failed"
[ "$(scoped_runs smoke)" = "$((runs_before + 1))" ] || fail "the pass after the failure did not supersede it"
[ "$(scoped_row smoke detail reuse passed_head)" = "$SCOPED_HV3" ] || fail "post-veto reuse candidate"

# (7) Interrupted lane: a forwarded SIGTERM (the pipeline superseding its run,
# an operator's Ctrl-C) says nothing about the head, so the runner records no
# failed head and the next docs-only commit still reuses the real pass. The
# job is the identical invocation, exec'd so the signal reaches the runner.
printf 'guide v7\n' > "$SCOPED_REPO/docs/guide.md"
scoped_commit docs-v7 >/dev/null
scoped_failed_count() { ls "$RUN_ROOT/scoped/passed-cache/smoke/scoped-failed/"*.json | wc -l | tr -d ' '; }
failed_before="$(scoped_failed_count)"
runs_before="$(scoped_runs smoke)"
touch "$TEST_ROOT/scoped-hang-smoke"
mapfile -t smoke_args < <(scoped_args smoke)
(cd "$SCOPED_REPO" && exec env DEPLOY_RUN_ROOT="$RUN_ROOT" bash scripts/run-deploy-stage smoke -- \
    bash -c "$SCOPED_COMMAND" "${smoke_args[@]}") >"$TEST_ROOT/scoped-interrupt.out" 2>&1 &
interrupt_pid=$!
for _ in $(seq 1 1200); do
    [ "$(scoped_runs smoke)" = "$((runs_before + 1))" ] && break
    sleep 0.05
done
[ "$(scoped_runs smoke)" = "$((runs_before + 1))" ] || fail "interrupted smoke run did not start"
kill -TERM "$interrupt_pid"
set +e
wait "$interrupt_pid"
interrupt_exit=$?
set -e
rm -f "$TEST_ROOT/scoped-hang-smoke"
[ "$interrupt_exit" -eq 143 ] || fail "interrupted smoke exit was $interrupt_exit, expected 143"
grep -q "deploy stage smoke was interrupted by signal 15; its exit is not recorded as a failed head" \
    "$TEST_ROOT/scoped-interrupt.out" || fail "interruption was not disclosed"
[ "$(scoped_failed_count)" = "$failed_before" ] || fail "an interrupted lane recorded a failed head"
printf 'guide v8\n' > "$SCOPED_REPO/docs/guide.md"
scoped_commit docs-v8 >/dev/null
scoped_run smoke --lane-scoped-reuse >"$TEST_ROOT/scoped-after-interrupt.out" || fail "post-interrupt run failed"
[ "$(scoped_runs smoke)" = "$((runs_before + 1))" ] || fail "an interrupted lane vetoed the scoped reuse"
[ "$(scoped_row smoke status)" = "reused-scoped" ] || fail "post-interrupt row status"
[ "$(scoped_row smoke detail reuse passed_head)" = "$SCOPED_HV3" ] || fail "post-interrupt reuse candidate"

# (8) The exit code alone never implies an interruption: a lane that exits 143
# by itself (no forwarded signal) is a real failure, recorded and vetoing.
printf 'guide v9\n' > "$SCOPED_REPO/docs/guide.md"
SCOPED_HV9="$(scoped_commit docs-v9)"
printf '143\n' > "$TEST_ROOT/scoped-fail-smoke"
set +e
scoped_run smoke >"$TEST_ROOT/scoped-exit143.out" 2>&1
exit143=$?
set -e
rm -f "$TEST_ROOT/scoped-fail-smoke"
[ "$exit143" -eq 143 ] || fail "self-exiting smoke exit was $exit143, expected 143"
if grep -q "was interrupted" "$TEST_ROOT/scoped-exit143.out"; then
    fail "an exit 143 without a signal was reported as an interruption"
fi
[ "$(scoped_failed_count)" = "$((failed_before + 1))" ] || fail "an exit 143 without a signal was not recorded as a failed head"
printf 'guide v10\n' > "$SCOPED_REPO/docs/guide.md"
scoped_commit docs-v10 >/dev/null
runs_before="$(scoped_runs smoke)"
scoped_run smoke --lane-scoped-reuse >"$TEST_ROOT/scoped-after-exit143.out" || fail "post-exit-143 run failed"
[ "$(scoped_runs smoke)" = "$((runs_before + 1))" ] || fail "an exit-143 failure did not veto the scoped reuse"
grep -q "lane-scoped reuse unavailable for smoke: a failed run on ${SCOPED_HV9:0:12} differs from the current tree only by inert paths" \
    "$TEST_ROOT/scoped-after-exit143.out" || fail "exit-143 veto reason not disclosed"

# The dry-run preview reports the same decisions for a commit range.
(cd "$SCOPED_REPO" && python3 scripts/run_deploy_stage.py --preview-lane-scoped-reuse "$SCOPED_H1..$SCOPED_H2") >"$TEST_ROOT/scoped-preview.out" \
    || fail "preview failed"
grep -q "5/5 lane(s) would be reused-scoped" "$TEST_ROOT/scoped-preview.out" || fail "docs-only preview"
(cd "$SCOPED_REPO" && python3 scripts/run_deploy_stage.py --preview-lane-scoped-reuse "$SCOPED_H2..$SCOPED_H3") >"$TEST_ROOT/scoped-preview3.out" \
    || fail "preview 3 failed"
grep -q "agents-coverage-blackbox: RERUN (1 path(s) not provably inert)" "$TEST_ROOT/scoped-preview3.out" || fail "agents preview"
grep -q "4/5 lane(s) would be reused-scoped" "$TEST_ROOT/scoped-preview3.out" || fail "agents-test preview"
scoped_stage --finish >"$TEST_ROOT/scoped-finish.out" || fail "scoped finish failed"
grep -q "^smoke  *reused-scoped " "$TEST_ROOT/scoped-finish.out" || fail "summary does not show the reused-scoped label"
scoped_stage --history >"$TEST_ROOT/scoped-history.out" || fail "scoped history failed"
grep -q "Reused lane-scoped passes (inert changes only, not executed on these bytes): .*smoke=" "$TEST_ROOT/scoped-history.out" \
    || fail "history does not count lane-scoped reuse separately"
# Back to the exact-input fixture run for the scenarios below.
RUN_ROOT="$TEST_ROOT/reuse"
# Every pass is cached, so a standalone run (no --reuse-passed: a first manual
# gate, or an inner stage a lane launches) is reusable by a later
# --reuse-passed run of the identical command; only the lookup is opt-in.
standalone_counter="$TEST_ROOT/reuse-standalone-counter"
reuse_stage standalone -- bash -c 'printf "run\n" >> "$1"' _ "$standalone_counter" >"$TEST_ROOT/standalone-first.out"
grep -q "reused passed deploy stage" "$TEST_ROOT/standalone-first.out" && fail "a run without --reuse-passed must never reuse"
reuse_stage standalone --reuse-passed -- bash -c 'printf "run\n" >> "$1"' _ "$standalone_counter" >"$TEST_ROOT/standalone.out"
[ "$(wc -l < "$standalone_counter" | tr -d ' ')" = 1 ] || fail "a pass recorded without --reuse-passed was not reusable"
grep -q "reused passed deploy stage: standalone (exact worktree + command)" "$TEST_ROOT/standalone.out" \
    || fail "standalone reuse was not disclosed with its scope"
# Every executed stage row carries the host evidence the pipeline schedule is
# decided from: the largest child RSS (RUSAGE_CHILDREN after the wait) and the
# whole-box MemAvailable floor during the stage. #1639's rows showed
# semantic-stack at 1652.8 MB child RSS / ~4.65 GB whole-box footprint beside a
# 6.5 GB coverage-phase floor, which is why it stays after the coverage phase.
python3 - "$RUN_ROOT/reuse/stages.jsonl" <<'PY' || fail "executed stage rows must record child peak RSS and the MemAvailable floor"
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
ran = [row for row in rows if row.get("stage") == "standalone" and row.get("status") == "passed"]
assert ran, "no executed passed row for stage standalone"
host = (ran[0].get("detail") or {}).get("host") or {}
assert float(host.get("child_peak_rss_mb") or 0) > 0, host
assert float(host.get("mem_available_min_mb") or 0) > 0 and float(host.get("mem_total_mb") or 0) > 0, host
PY
# Process identity is not a deploy input: systemd stamps a fresh
# INVOCATION_ID/JOURNAL_STREAM/SYSTEMD_EXEC_PID on every transient unit and the
# terminal its own geometry, and run_deploy_pipeline.py stamps every lane attempt
# with a fresh DEPLOY_PIPELINE_LANE_TOKEN, so a lane relaunched as a new unit must
# still match its own pass, while a changed gate input such as
# DEPLOY_GATE_OVERRIDES must not.
identity_counter="$TEST_ROOT/reuse-identity-counter"
INVOCATION_ID=0123abcd JOURNAL_STREAM=8:1 SYSTEMD_EXEC_PID=11 COLUMNS=80 LISTEN_PID=11 \
    DEPLOY_PIPELINE_LANE_TOKEN=identity.1.0123abcd \
    reuse_stage identity --reuse-passed -- bash -c 'printf "run\n" >> "$1"' _ "$identity_counter" >/dev/null
INVOCATION_ID=4567ef01 JOURNAL_STREAM=8:2 SYSTEMD_EXEC_PID=22 COLUMNS=120 LISTEN_PID=22 \
    DEPLOY_PIPELINE_LANE_TOKEN=identity.2.4567ef01 \
    reuse_stage identity --reuse-passed -- bash -c 'printf "run\n" >> "$1"' _ "$identity_counter" >"$TEST_ROOT/identity.out"
[ "$(wc -l < "$identity_counter" | tr -d ' ')" = 1 ] \
    || fail "a new systemd unit identity defeated reuse of an identical pass"
grep -q "reused passed deploy stage" "$TEST_ROOT/identity.out" \
    || fail "identity-only relaunch was not disclosed as reuse"
DEPLOY_GATE_OVERRIDES=fixture:changed \
    reuse_stage identity --reuse-passed -- bash -c 'printf "run\n" >> "$1"' _ "$identity_counter" >/dev/null
[ "$(wc -l < "$identity_counter" | tr -d ' ')" = 2 ] || fail "a changed gate input reused stale evidence"
reuse_stage --finish >/dev/null

# A failed finalize must remain non-zero even though summary rendering succeeds,
# and the pointer stays available so the operator can repair/retry the run.
RUN_ROOT="$TEST_ROOT/finalize"
run_stage --start --run-id finalize-failure >/dev/null
printf '{not-json\n' > "$RUN_ROOT/finalize-failure/metadata.json"
if run_stage --finish >"$TEST_ROOT/finalize.out" 2>&1; then
    fail "finalize failure was masked by summary"
fi
[ "$(sed -n '1p' "$RUN_ROOT/current")" = "finalize-failure" ] \
    || fail "failed finalize discarded the active-run pointer"

# A timing append failure is visible but never changes a successful gate result.
RUN_ROOT="$TEST_ROOT/append"
run_stage --start --run-id append-warning >/dev/null
mkdir "$RUN_ROOT/append-warning/stages.jsonl"
run_stage append-warning -- true >"$TEST_ROOT/append.out" 2>&1 \
    || fail "append failure replaced the gate's successful result"
grep -q "warning: could not append deploy stage record" "$TEST_ROOT/append.out" \
    || fail "append failure was silent"
[ -z "$(find "$RUN_ROOT/append-warning/admissions" -name '*.json' -print)" ] \
    || fail "append failure leaked a stage admission"

# Follow-up z (2026-10-30): inside a deploy (ROSE_DEPLOY_WORKTREE=1, or the
# explicit PREDEPLOY_PARK_LEDGERS=1) the smoke launcher parks the benchmark
# ledger rows its run records under .context instead of appending them to the
# tracked agents/benchmarks/history/ files, so neither its own --reuse-passed
# fingerprint nor the whole-worktree lanes that start after it change while it
# runs. Outside a deploy the tracked ledgers still receive the rows directly.
# The fixture is a minimal repository root: the real launcher plus the real
# ledger writers (copied bytes) and a fake run-bench that records one task
# through those writers, exactly as run_benchmark.py does after a task.
PARK_FIXTURE="$TEST_ROOT/park-root"
mkdir -p "$PARK_FIXTURE/scripts" "$PARK_FIXTURE/agents/benchmarks/history" "$PARK_FIXTURE/.context"
cp "$ROOT_DIR/scripts/run-predeploy-local" "$PARK_FIXTURE/scripts/run-predeploy-local"
cp "$ROOT_DIR/scripts/run_logged_command.py" "$PARK_FIXTURE/scripts/run_logged_command.py"
for module in __init__ select_predeploy_benches predeploy_metrics timeout_history span_history; do
    cp "$ROOT_DIR/agents/benchmarks/$module.py" "$PARK_FIXTURE/agents/benchmarks/$module.py"
done
cat >"$PARK_FIXTURE/agents/benchmarks/tasks.json" <<'JSON'
[{"name": "park-fixture-smoke", "tags": ["smoke"], "status": "ready", "runner": "agent",
  "bench": "pipeline-e2e", "group": "pre-deploy", "timeout_seconds": 60}]
JSON
printf '{"task": "park-fixture-smoke", "passed": true, "status": "COMPLETED", "duration_seconds": 10.0, "timestamp": "2026-10-29T00:00:00+00:00", "agent_id": "seed"}\n' \
    >"$PARK_FIXTURE/agents/benchmarks/history/task_attempts.jsonl"
printf '{"task": "park-fixture-smoke", "duration_seconds": 10.0, "cost_cents": 0.0, "timestamp": "2026-10-29T00:00:00+00:00", "agent_id": "seed"}\n' \
    >"$PARK_FIXTURE/agents/benchmarks/history/task_durations.jsonl"
printf '{"agent_id": "seed", "benchmark": "park-fixture-smoke", "duration_ms": 1.0, "span_key": "k", "timestamp": "2026-10-29T00:00:00+00:00"}\n' \
    >"$PARK_FIXTURE/agents/benchmarks/history/span_durations.jsonl"
cat >"$PARK_FIXTURE/scripts/run-bench" <<'FAKE'
#!/usr/bin/env bash
# Fake run-bench --local <task> --max-concurrency N: record the task through the
# real ledger writers, exactly as run_benchmark.py does after a task.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
printf '%s\n' "${BENCHMARK_HISTORY_PARK_DIR:-<unset>}" >"$ROOT/.context/run-bench-park-env"
cd "$ROOT/agents"
python3 - "$2" <<'PY'
import sys
from benchmarks.span_history import record_span_observations
from benchmarks.timeout_history import record_attempt, record_pass
task = sys.argv[1]
stamp = "2026-10-30T00:00:00+00:00"
record_attempt(task_name=task, passed=True, status="COMPLETED", duration_seconds=12.0, cost_cents=1.5,
               agent_id="fake-agent", timestamp=stamp, run_id="fake-run")
record_pass(task_name=task, duration_seconds=12.0, cost_cents=1.5, agent_id="fake-agent", timestamp=stamp)
written = record_span_observations([{"agent_id": "fake-agent", "benchmark": task, "duration_ms": 5.0,
                                     "span_key": "k", "span_name": "n", "status": "ok", "timestamp": stamp}])
assert written == 1, written
PY
FAKE
chmod +x "$PARK_FIXTURE/scripts/run-bench" "$PARK_FIXTURE/scripts/run-predeploy-local"
git -C "$PARK_FIXTURE" init -q
git -C "$PARK_FIXTURE" -c user.email=t@example.com -c user.name=t add -A
git -C "$PARK_FIXTURE" -c user.email=t@example.com -c user.name=t commit -qm fixture
cp "$PARK_FIXTURE/agents/benchmarks/history/task_attempts.jsonl" "$TEST_ROOT/park-attempts.before"
cp "$PARK_FIXTURE/agents/benchmarks/history/task_durations.jsonl" "$TEST_ROOT/park-durations.before"
cp "$PARK_FIXTURE/agents/benchmarks/history/span_durations.jsonl" "$TEST_ROOT/park-spans.before"
park_smoke() {
    (
        cd "$PARK_FIXTURE"
        env -u BENCHMARK_HISTORY_PARK_DIR -u ROSE_DEPLOY_WORKTREE -u PREDEPLOY_PARK_LEDGERS "$@" \
            PREDEPLOY_ATTEMPTS_FILE="$PARK_FIXTURE/agents/benchmarks/history/task_attempts.jsonl" \
            bash scripts/run-predeploy-local
    )
}
park_smoke ROSE_DEPLOY_WORKTREE=1 PREDEPLOY_RUN_ID=parked >"$TEST_ROOT/park-deploy.out" 2>&1 \
    || fail "deploy smoke with parked ledgers failed: $(cat "$TEST_ROOT/park-deploy.out")"
PARK_DIR="$PARK_FIXTURE/.context/deploy-ledger-park"
[ "$(cat "$PARK_FIXTURE/.context/run-bench-park-env")" = "$PARK_DIR" ] \
    || fail "run-bench did not receive the park directory: $(cat "$PARK_FIXTURE/.context/run-bench-park-env")"
grep -q "deploy-ledger-park" "$TEST_ROOT/park-deploy.out" || fail "the launcher must announce where the rows are parked"
cmp -s "$PARK_FIXTURE/agents/benchmarks/history/task_attempts.jsonl" "$TEST_ROOT/park-attempts.before" \
    || fail "deploy smoke appended to the tracked attempts ledger"
cmp -s "$PARK_FIXTURE/agents/benchmarks/history/task_durations.jsonl" "$TEST_ROOT/park-durations.before" \
    || fail "deploy smoke appended to the tracked durations ledger"
cmp -s "$PARK_FIXTURE/agents/benchmarks/history/span_durations.jsonl" "$TEST_ROOT/park-spans.before" \
    || fail "deploy smoke appended to the tracked span ledger"
[ -z "$(git -C "$PARK_FIXTURE" status --porcelain -- agents/benchmarks/history)" ] \
    || fail "deploy smoke left the tracked ledgers dirty: $(git -C "$PARK_FIXTURE" status --porcelain)"
grep -q '"task": "park-fixture-smoke".*"run_id": "fake-run"' "$PARK_DIR/task_attempts.jsonl" \
    || fail "parked attempts row missing"
grep -q '"task": "park-fixture-smoke"' "$PARK_DIR/task_durations.jsonl" || fail "parked durations row missing"
grep -q '"benchmark": "park-fixture-smoke"' "$PARK_DIR/span_durations.jsonl" || fail "parked span row missing"
[ "$(wc -l <"$PARK_DIR/task_attempts.jsonl")" -eq 1 ] || fail "exactly one parked attempt row expected"
# The explicit flag parks outside an isolated deploy worktree too.
rm -rf "$PARK_DIR"
park_smoke PREDEPLOY_PARK_LEDGERS=1 PREDEPLOY_RUN_ID=parked-flag >"$TEST_ROOT/park-flag.out" 2>&1 \
    || fail "flagged smoke with parked ledgers failed: $(cat "$TEST_ROOT/park-flag.out")"
[ "$(wc -l <"$PARK_DIR/task_attempts.jsonl")" -eq 1 ] || fail "PREDEPLOY_PARK_LEDGERS=1 must park the rows"
cmp -s "$PARK_FIXTURE/agents/benchmarks/history/task_attempts.jsonl" "$TEST_ROOT/park-attempts.before" \
    || fail "flagged smoke appended to the tracked attempts ledger"
# An explicit BENCHMARK_HISTORY_PARK_DIR is honoured as-is, and the printed
# publish command names that directory: the default replay would miss it and
# report success while this run's rows stay parked.
CUSTOM_PARK="$TEST_ROOT/custom-park"
park_smoke BENCHMARK_HISTORY_PARK_DIR="$CUSTOM_PARK" PREDEPLOY_RUN_ID=parked-custom >"$TEST_ROOT/park-custom.out" 2>&1 \
    || fail "smoke with an explicit park directory failed: $(cat "$TEST_ROOT/park-custom.out")"
[ "$(wc -l <"$CUSTOM_PARK/task_attempts.jsonl")" -eq 1 ] || fail "an explicit BENCHMARK_HISTORY_PARK_DIR must receive the rows"
[ "$(wc -l <"$PARK_DIR/task_attempts.jsonl")" -eq 1 ] || fail "an explicit park directory must leave the default park untouched"
grep -qF -- "python3 scripts/benchmark-history-latest-only.py --base origin/main --apply-parked \"$CUSTOM_PARK\" --write" \
    "$TEST_ROOT/park-custom.out" \
    || fail "the printed publish command must name the configured park directory: $(grep -F 'publish them with' "$TEST_ROOT/park-custom.out")"
grep -qF -- "--apply-parked \"$PARK_DIR\" --write" "$TEST_ROOT/park-flag.out" \
    || fail "the printed publish command must name the default park directory: $(grep -F 'publish them with' "$TEST_ROOT/park-flag.out")"
# Outside a deploy the rows still reach the tracked ledgers directly.
park_smoke PREDEPLOY_RUN_ID=unparked >"$TEST_ROOT/park-plain.out" 2>&1 \
    || fail "plain smoke failed: $(cat "$TEST_ROOT/park-plain.out")"
[ "$(cat "$PARK_FIXTURE/.context/run-bench-park-env")" = "<unset>" ] || fail "a plain smoke run must not park its rows"
[ "$(wc -l <"$PARK_FIXTURE/agents/benchmarks/history/task_attempts.jsonl")" -eq 2 ] \
    || fail "a plain smoke run must append its attempt row to the tracked ledger"
[ "$(wc -l <"$PARK_FIXTURE/agents/benchmarks/history/task_durations.jsonl")" -eq 2 ] \
    || fail "a plain smoke run must append its duration row to the tracked ledger"
[ "$(wc -l <"$PARK_FIXTURE/agents/benchmarks/history/span_durations.jsonl")" -eq 2 ] \
    || fail "a plain smoke run must append its span row to the tracked ledger"
[ "$(wc -l <"$PARK_DIR/task_attempts.jsonl")" -eq 1 ] || fail "a plain smoke run must leave the park untouched"
echo "pre-deploy smoke parks its ledger rows inside a deploy: ok"

# Environment-controlled IDs may not escape their artifact roots.
RUN_ROOT="$TEST_ROOT/invalid"
for invalid_id in . .. ../escape bad/id; do
    if run_stage --start --run-id "$invalid_id" >"$TEST_ROOT/invalid.out" 2>&1; then
        fail "accepted invalid deploy run id: $invalid_id"
    fi
done
for invalid_id in . .. ../escape bad/id; do
    if PREDEPLOY_RUN_ID="$invalid_id" bash "$ROOT_DIR/scripts/run-predeploy-local" \
        >"$TEST_ROOT/predeploy-invalid.out" 2>&1; then
        fail "accepted invalid pre-deploy run id: $invalid_id"
    fi
    grep -q "invalid pre-deploy run id" "$TEST_ROOT/predeploy-invalid.out" \
        || fail "missing pre-deploy invalid-id diagnostic"
done

# Signals must reach the supervised command promptly, preserve shell exit codes,
# and release their lifecycle admission.
RUN_ROOT="$TEST_ROOT/signal"
run_stage --start --run-id signal >/dev/null
set +e
DEPLOY_RUN_ROOT="$RUN_ROOT" bash "$ROOT_DIR/scripts/run-deploy-stage" \
    signal -- bash -c 'sleep 30' >"$TEST_ROOT/signal.out" 2>&1 &
wrapper_pid=$!
sleep 0.1
kill -TERM "$wrapper_pid"
wait "$wrapper_pid"
signal_exit=$?
set -e
[ "$signal_exit" -eq 143 ] || fail "signal exit was $signal_exit, expected 143"
run_stage --finish >/dev/null

# Initialization errors must fail the command without publishing the broken run.
RUN_ROOT="$TEST_ROOT/init"
mkdir -p "$RUN_ROOT/init-failure/metadata.json"
if run_stage --start --run-id init-failure >"$TEST_ROOT/init.out" 2>&1; then
    fail "initialization failure reported success"
fi
grep -q "failed to initialize deploy timing run" "$TEST_ROOT/init.out" \
    || fail "missing initialization-failure diagnostic"
[ ! -e "$RUN_ROOT/current" ] || fail "failed initialization published a current run"

# Finish closes admission before waiting, so a late stage is rejected while an
# already-admitted stage completes and records its result.
RUN_ROOT="$TEST_ROOT/concurrent"
run_stage --start --run-id concurrent >/dev/null
run_stage slow -- bash -c 'while [ ! -e "$1" ]; do sleep 0.05; done' _ "$TEST_ROOT/slow-release" >"$TEST_ROOT/slow.out" 2>&1 &
slow_pid=$!
for _ in $(seq 1 1200); do
    find "$RUN_ROOT/concurrent/admissions" -name '*.json' -print -quit 2>/dev/null | grep -q . && break
    sleep 0.05
done
find "$RUN_ROOT/concurrent/admissions" -name '*.json' -print -quit 2>/dev/null | grep -q . \
    || fail "slow stage did not publish its admission"
run_stage --finish >"$TEST_ROOT/concurrent-finish.out" 2>&1 &
finish_pid=$!
# Under a loaded /deploy host the finish supervisor can take seconds just to
# start Python and persist "finishing", or it can pass through that state so
# quickly a poll only sees "completed". Either way admission is closed. Wait on
# the event itself: stop as soon as either status is written or the finish
# process exits (it cannot exit cleanly without writing one), instead of a fixed
# wall-clock window. The iteration cap only prevents a hung test.
for _ in $(seq 1 1200); do
    grep -Eq '"status": "(finishing|completed)"' "$RUN_ROOT/concurrent/metadata.json" && break
    kill -0 "$finish_pid" 2>/dev/null || break
    sleep 0.05
done
grep -Eq '"status": "(finishing|completed)"' "$RUN_ROOT/concurrent/metadata.json" \
    || fail "finish did not close stage admission"
if run_stage late -- true >"$TEST_ROOT/concurrent-late.out" 2>&1; then
    fail "admitted a stage after finish began"
fi
touch "$TEST_ROOT/slow-release"
wait "$slow_pid" || fail "admitted stage failed during finish"
slow_pid=""
wait "$finish_pid" || fail "finish failed while waiting for an admitted stage"
finish_pid=""
[ ! -e "$RUN_ROOT/current" ] || fail "concurrent finish left the pointer behind"
grep -q '"stage":"slow"' "$RUN_ROOT/concurrent/stages.jsonl" \
    || fail "finish raced the admitted stage append"
python3 - "$RUN_ROOT/concurrent" <<'PY'
import json
import sys
from pathlib import Path

run_dir = Path(sys.argv[1])
metadata = json.loads((run_dir / "metadata.json").read_text())
stage = json.loads((run_dir / "stages.jsonl").read_text().splitlines()[0])
if metadata["finished_epoch"] < stage["finished_epoch"]:
    raise SystemExit("finish timestamp predates an admitted stage")
PY

# Lane-scoped reuse: a scoped lane (front-end, mac-app) survives a fix outside
# its inputs, including the commit of that fix, but every shared input (root
# manifest, shared contract, scripts, the benchmark catalog front-end reads,
# an unmapped new top-level path) invalidates it. Whole-worktree lanes still
# rerun on any change. Runs against a fixture repository so the real checkout
# is never edited.
LANE_REPO="$TEST_ROOT/lane-repo"
mkdir -p "$LANE_REPO/scripts" "$LANE_REPO/back-end/src" "$LANE_REPO/front-end/src" \
    "$LANE_REPO/agents/benchmarks/history" "$LANE_REPO/agents/tools" "$LANE_REPO/shared/contract" \
    "$LANE_REPO/mac-app/main" "$LANE_REPO/docs"
cp "$ROOT_DIR/scripts/run-deploy-stage" "$ROOT_DIR/scripts/run_deploy_stage.py" \
    "$ROOT_DIR/scripts/deploy_stage.py" "$ROOT_DIR/scripts/factory_metadata.py" \
    "$ROOT_DIR/scripts/factory_detail.py" "$LANE_REPO/scripts/"
for file in package.json back-end/src/server.ts front-end/src/app.ts agents/benchmarks/tasks.json \
    agents/benchmarks/history/task_attempts.jsonl \
    agents/tools/base.py shared/contract/fixtures.json mac-app/main/index.ts docs/guide.txt scripts/helper.sh; do
    printf 'original %s\n' "$file" > "$LANE_REPO/$file"
done
printf '.context/\n' > "$LANE_REPO/.gitignore"
git -C "$LANE_REPO" init -q
git -C "$LANE_REPO" add -A
git -C "$LANE_REPO" -c user.name=t -c user.email=t@t commit -qm fixture
lane_counter="$TEST_ROOT/lane-counter"
# The ledger-free lanes drop the append-only ledgers from their fingerprint
# only when their argv is the lane's real command, so the fixture lanes carry
# that command's marker as a trailing argument (lint-affected over the deploy
# lint list, tsc, the back-end structural suite). lane_stage_generic runs the
# same stage name with an arbitrary command and must keep the exact-worktree
# fingerprint.
lane_marker() {
    case "$1" in
        eslint) printf 'scripts/lint-affected.mjs' ;;
        typescript) printf 'tsc' ;;
        backend-structural) printf 'test:structural' ;;
        *) printf 'generic' ;;
    esac
}
lane_stage() {
    (cd "$LANE_REPO" && DEPLOY_RUN_ROOT="$LANE_REPO/.context/deploy-runs" \
        bash scripts/run-deploy-stage "$1" --reuse-passed -- \
        bash -c 'printf "%s\n" "$1" >> "$2"' _ "$1" "$lane_counter" "$(lane_marker "$1")" >/dev/null)
}
lane_stage_generic() {
    (cd "$LANE_REPO" && DEPLOY_RUN_ROOT="$LANE_REPO/.context/deploy-runs" \
        bash scripts/run-deploy-stage "$1" --reuse-passed -- \
        bash -c 'printf "%s-generic\n" "$1" >> "$2"' _ "$1" "$lane_counter" >/dev/null)
}
lane_runs() { grep -cx "$1" "$lane_counter" 2>/dev/null || true; }
expect_lane() {
    local stage="$1" expected="$2" why="$3"
    lane_stage "$stage"
    [ "$(lane_runs "$stage")" = "$expected" ] \
        || fail "$stage ran $(lane_runs "$stage") times after $why, expected $expected"
}
(cd "$LANE_REPO" && DEPLOY_RUN_ROOT="$LANE_REPO/.context/deploy-runs" \
    bash scripts/run-deploy-stage --start --run-id lanes >/dev/null)
for stage in frontend-coverage-blackbox mac-static typescript; do expect_lane "$stage" 1 "first run"; done
for stage in frontend-coverage-blackbox mac-static typescript; do expect_lane "$stage" 1 "no change"; done
# Back-end-only fix, uncommitted and then committed: only whole-worktree lanes rerun.
printf 'fix\n' >> "$LANE_REPO/back-end/src/server.ts"
expect_lane frontend-coverage-blackbox 1 "an uncommitted back-end fix"
expect_lane mac-static 1 "an uncommitted back-end fix"
expect_lane typescript 2 "an uncommitted back-end fix"
git -C "$LANE_REPO" -c user.name=t -c user.email=t@t commit -qam "back-end fix"
expect_lane frontend-coverage-blackbox 1 "committing the back-end fix"
expect_lane typescript 3 "committing the back-end fix"
printf 'agent fix\n' >> "$LANE_REPO/agents/tools/base.py"
expect_lane frontend-coverage-blackbox 1 "an agents-only fix"
expect_lane mac-static 1 "an agents-only fix"
printf 'docs\n' >> "$LANE_REPO/docs/guide.txt"
expect_lane frontend-coverage-blackbox 1 "a docs-only edit"
# Every shared or unmapped input invalidates the scoped lanes.
fe=1; mac=1
for shared_edit in package.json shared/contract/fixtures.json scripts/helper.sh \
    unmapped-top-level.json; do
    printf 'shared edit\n' >> "$LANE_REPO/$shared_edit"
    fe=$((fe + 1)); mac=$((mac + 1))
    expect_lane frontend-coverage-blackbox "$fe" "editing $shared_edit"
    expect_lane mac-static "$mac" "editing $shared_edit"
done
printf 'catalog edit\n' >> "$LANE_REPO/agents/benchmarks/tasks.json"
expect_lane frontend-coverage-blackbox $((fe + 1)) "editing the benchmark catalog"
expect_lane mac-static "$mac" "editing the benchmark catalog"
printf 'ui edit\n' >> "$LANE_REPO/front-end/src/app.ts"
expect_lane frontend-coverage-blackbox $((fe + 2)) "a front-end edit"
expect_lane mac-static $((mac + 1)) "a front-end edit (mac-app consumes front-end)"
rm "$LANE_REPO/front-end/src/app.ts"
expect_lane frontend-coverage-blackbox $((fe + 3)) "deleting a front-end file"
chmod +x "$LANE_REPO/shared/contract/fixtures.json"
expect_lane frontend-coverage-blackbox $((fe + 4)) "a mode-only change"
# A staged rename out of lane scope removes an in-scope file: git's default
# rename detection lists only the destination, so the source must still be
# seen as deleted (--no-renames) or a stale pass stays reusable.
printf 'moved\n' > "$LANE_REPO/front-end/src/moved.ts"
git -C "$LANE_REPO" add -A
git -C "$LANE_REPO" -c user.name=t -c user.email=t@t commit -qm "add moved.ts"
expect_lane frontend-coverage-blackbox $((fe + 5)) "adding a front-end file"
expect_lane frontend-coverage-blackbox $((fe + 5)) "no change after the add"
git -C "$LANE_REPO" mv front-end/src/moved.ts docs/moved.ts
expect_lane frontend-coverage-blackbox $((fe + 6)) "a staged rename of a front-end file out of scope"

# Append-only benchmark ledgers (agents/benchmarks/history/*, written by the
# smoke lane and local benchmark runs while the other gates run) invalidate
# only the lanes that read them: backend-coverage-blackbox
# (domains/benchmarks/config.ts reads task_attempts.jsonl) and the scripts/
# tests gates rerun, while eslint, typescript and backend-structural keep
# their pass. A tracked ledger row, an untracked ledger file and an ignored
# .context write are all exercised; a real source edit still invalidates.
for stage in eslint typescript backend-structural backend-coverage-blackbox deploy-command-structural; do
    lane_stage "$stage"
done
ts=$(lane_runs typescript); bs=$(lane_runs backend-structural); cov=$(lane_runs backend-coverage-blackbox)
dcs=$(lane_runs deploy-command-structural)
lane_stage_generic eslint
generic_before=$(lane_runs eslint-generic)
printf '{"task":"x","status":"passed"}\n' >> "$LANE_REPO/agents/benchmarks/history/task_attempts.jsonl"
expect_lane eslint 1 "a dirty tracked ledger row"
lane_stage_generic eslint
[ "$(lane_runs eslint-generic)" = $((generic_before + 1)) ] \
    || fail "a generic command under the eslint lane name kept its pass across a ledger row (expected an exact-worktree re-run)"
expect_lane typescript "$ts" "a dirty tracked ledger row"
expect_lane backend-structural "$bs" "a dirty tracked ledger row"
expect_lane backend-coverage-blackbox $((cov + 1)) "a dirty tracked ledger row (the backend reads task_attempts.jsonl)"
expect_lane deploy-command-structural $((dcs + 1)) "a dirty tracked ledger row (scripts/tests read the ledgers)"
printf '{"task":"y"}\n' > "$LANE_REPO/agents/benchmarks/history/span_durations.jsonl"
expect_lane eslint 1 "an untracked ledger file"
expect_lane typescript "$ts" "an untracked ledger file"
expect_lane backend-coverage-blackbox $((cov + 2)) "an untracked ledger file"
mkdir -p "$LANE_REPO/.context/deploy-durations"
printf '{}\n' > "$LANE_REPO/.context/deploy-durations/pipeline-lanes.json"
expect_lane eslint 1 "an ignored .context write"
expect_lane backend-coverage-blackbox $((cov + 2)) "an ignored .context write"
printf 'fix\n' >> "$LANE_REPO/back-end/src/server.ts"
expect_lane eslint 2 "a back-end edit"
expect_lane typescript $((ts + 1)) "a back-end edit"
expect_lane backend-structural $((bs + 1)) "a back-end edit"
git -C "$LANE_REPO" -c user.name=t -c user.email=t@t commit -qam "back-end edit"
expect_lane eslint 3 "committing the back-end edit (ledger-free lanes still hash HEAD)"

echo "run-deploy-stage regression tests passed"
