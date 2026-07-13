#!/usr/bin/env bash
# Two workstreams (git worktrees sharing one git common dir, like Conductor
# workspaces) must be able to run cloud benchmarks CONCURRENTLY — and both runs
# must FINISH WITH SUCCESS, each on its own code snapshot.
#
# Scenario 1 drives two real `run-bench-fleet --provision-pool` controllers at
# the same time. Scenario 2 drives two real `run-bench-fleet <bench>` runs all
# the way through the pipeline: clone → ssh staging → detached driver →
# synchronized start barrier → DONE-marker polling → report-card/run.json
# retrieval → PASS aggregation → teardown. Both fleets must exit 0 with 1/1
# passed and each machine must have received ITS workstream's git ref.
#
# The fake flyctl journals every call, keeps shared machine/volume state, and
# EXECUTES ssh payloads in a per-machine sandbox (with /data//tmp rewritten),
# so the real controller logic runs unmodified. Its `machine clone` blocks
# until BOTH controllers' clones are in flight — a serialized (locked) run
# deadlocks the barrier and fails. The fake driver only completes after the
# fleet releases the synchronized start barrier over ssh, so a PASS requires
# the full controller loop, not a canned response. The run path must also stay
# read-only against shared app state: no `secrets set`, no lease tokens.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
PIDS=()
HUB_PIDS=()

cleanup() {
    local pid
    for pid in "${PIDS[@]:-}"; do
        kill "$pid" 2>/dev/null || true
    done
    for pid in "${PIDS[@]:-}"; do
        wait "$pid" 2>/dev/null || true
    done
    rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $1" >&2
    for log in "$TMP_ROOT"/controller-*.log; do
        [ -f "$log" ] || continue
        echo "── $log (tail) ──" >&2
        tail -30 "$log" >&2 || true
    done
    exit 1
}

# ── A scratch repo + two worktrees = two workstreams on one machine ─────────
SANDBOX="$TMP_ROOT/repo"
mkdir -p "$SANDBOX"
cp -R "$ROOT_DIR/scripts" "$SANDBOX/scripts"
cp -R "$ROOT_DIR/agents/benchmarks/fleet_startup_phase.py" "$SANDBOX/scripts/" 2>/dev/null || true
git -C "$SANDBOX" init -q
git -C "$SANDBOX" -c user.email=test@test -c user.name=test add -A
git -C "$SANDBOX" -c user.email=test@test -c user.name=test commit -qm "snapshot" >/dev/null
WS_A="$TMP_ROOT/ws-a"
WS_B="$TMP_ROOT/ws-b"
git -C "$SANDBOX" worktree add -q -b ws-a "$WS_A" >/dev/null
git -C "$SANDBOX" worktree add -q -b ws-b "$WS_B" >/dev/null
# Distinct code snapshots per workstream: the run must carry each worktree's
# own HEAD sha through to its machines.
echo "workstream-a" > "$WS_A/SNAPSHOT.txt"
git -C "$WS_A" -c user.email=test@test -c user.name=test add SNAPSHOT.txt
git -C "$WS_A" -c user.email=test@test -c user.name=test commit -qm "ws-a snapshot" >/dev/null
echo "workstream-b" > "$WS_B/SNAPSHOT.txt"
git -C "$WS_B" -c user.email=test@test -c user.name=test add SNAPSHOT.txt
git -C "$WS_B" -c user.email=test@test -c user.name=test commit -qm "ws-b snapshot" >/dev/null
REF_A="$(git -C "$WS_A" rev-parse HEAD)"
REF_B="$(git -C "$WS_B" rev-parse HEAD)"
# The child controller resolves the API key + GitHub token from local .env files.
for ws in "$WS_A" "$WS_B"; do
    mkdir -p "$ws/back-end" "$ws/agents"
    printf 'BACKEND_API_KEY=test-key\nGITHUB_TOKEN=test-token\n' > "$ws/back-end/.env"
    printf 'BACKEND_API_KEY=test-key\n' > "$ws/agents/.env"
done

# ── Fake flyctl: shared journaled state + a cross-controller clone barrier ──
FAKE_DIR="$TMP_ROOT/fake-fly"
FAKE_BIN="$TMP_ROOT/fake-bin"
mkdir -p "$FAKE_DIR/markers" "$FAKE_BIN"

reset_fake_state() {
    rm -rf "$FAKE_DIR/markers" "$FAKE_DIR/machines"
    mkdir -p "$FAKE_DIR/markers" "$FAKE_DIR/machines"
    cat > "$FAKE_DIR/state.json" <<'JSON'
{
  "secrets": ["AGENTS_ENV_B64", "BACKEND_ENV_B64", "AGENTS_ENV_SHA256",
              "BACKEND_ENV_SHA256", "CLOUDBENCH_BROWSER_PROVIDER", "GITHUB_TOKEN"],
  "machines": [
    {"id": "aaaa0000000001", "name": "cloudbench-warm", "state": "stopped",
     "region": "iad", "private_ip": "",
     "config": {"mounts": [{"volume": "vol_aaaa0001"}]}}
  ],
  "volumes": [
    {"id": "vol_aaaa0001", "name": "cloudbench_data", "state": "created"}
  ],
  "snapshots": [
    {"id": "snap_0001", "status": "created",
     "created_at": "2026-07-13T00:00:00Z", "size": 1000000}
  ]
}
JSON
}
reset_fake_state

cat > "$FAKE_DIR/flyctl.py" <<'PY'
import fcntl
import json
import os
import re
import subprocess
import sys
import time
import uuid

FAKE_DIR = os.environ["CLOUDBENCH_FAKE_DIR"]
STATE = os.path.join(FAKE_DIR, "state.json")
LOCK = os.path.join(FAKE_DIR, "state.lock")
JOURNAL = os.path.join(FAKE_DIR, "journal.log")
MARKERS = os.path.join(FAKE_DIR, "markers")
MACHINES_DIR = os.path.join(FAKE_DIR, "machines")
BENCH_APP = "navi-whisper-lux-bench"
PROD_APP = "navi-whisper-lux"

args = sys.argv[1:]


def flag_value(name):
    return args[args.index(name) + 1] if name in args else None


def machine_dir(machine_id):
    mdir = os.path.join(MACHINES_DIR, machine_id)
    os.makedirs(os.path.join(mdir, "data"), exist_ok=True)
    os.makedirs(os.path.join(mdir, "tmp"), exist_ok=True)
    os.makedirs(os.path.join(mdir, "home"), exist_ok=True)
    return mdir


def rewrite_paths(mdir, command):
    return (
        command.replace("/tmp/rb.sh", mdir + "/tmp/rb.sh")
        .replace("/tmp/cloudbench-local.patch", mdir + "/tmp/cloudbench-local.patch")
        .replace("/data", mdir + "/data")
    )


class locked_state:
    def __enter__(self):
        self.handle = open(LOCK, "a+")
        fcntl.flock(self.handle, fcntl.LOCK_EX)
        with open(STATE) as fh:
            self.state = json.load(fh)
        return self.state

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            with open(STATE + ".tmp", "w") as fh:
                json.dump(self.state, fh)
            os.replace(STATE + ".tmp", STATE)
        fcntl.flock(self.handle, fcntl.LOCK_UN)
        self.handle.close()
        return False


def find_machine(state, machine_id):
    return next((m for m in state["machines"] if m["id"] == machine_id), None)


def rb_export(rb_text, key):
    match = re.search(rf"^export {key}=(.*)$", rb_text, re.MULTILINE)
    if not match:
        return ""
    value = match.group(1).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return value


def run_fake_driver(mdir):
    """Emulate the on-box driver contract: barrier-ready → wait for the fleet's
    ssh release-touch → write report-card.json/run.json → DONE marker. The PASS
    therefore requires the real controller loop to complete every leg."""
    rb_text = open(os.path.join(mdir, "tmp", "rb.sh")).read()
    token = rb_export(rb_text, "CLOUDBENCH_RUN_TOKEN")
    barrier = rb_export(rb_text, "CLOUDBENCH_START_BARRIER")
    ref = rb_export(rb_text, "REF")
    import base64
    tasks_csv = base64.b64decode(rb_export(rb_text, "BENCH_TASKS_B64")).decode()
    bench = tasks_csv.split(",")[0].strip()
    log_path = os.path.join(mdir, "data", "bench.log")

    def log(line):
        with open(log_path, "a") as fh:
            fh.write(line + "\n")

    log(f"[cloudbench] fake driver started (bench={bench} ref={ref})")
    exit_code = 0
    if barrier:
        log(f"synchronized start barrier ready: {barrier}")
        release = os.path.join(mdir, "data", f"cloudbench-start-{barrier}.release")
        deadline = time.time() + 120
        while not os.path.exists(release):
            if time.time() > deadline:
                log("FATAL: synchronized start barrier timed out")
                exit_code = 1
                break
            time.sleep(0.5)
        if exit_code == 0:
            log(f"synchronized start barrier released: {barrier}")
    if exit_code == 0:
        context = os.path.join(mdir, "data", "repo", ".context", "cloudbench")
        os.makedirs(context, exist_ok=True)
        agent_id = "fake-agent-" + os.path.basename(mdir)
        task = {
            "name": bench, "passed": True, "agent_id": agent_id,
            "duration_seconds": 1.0, "cost_cents": 0,
            "world_model_mode": "real", "code_ref": ref,
        }
        with open(os.path.join(context, "report-card.json"), "w") as fh:
            json.dump({
                "run_id": "fake", "elapsed_s": 1.0, "world_model_mode": "real",
                "cost": {"agents_llm_usd": 0, "wmh_grounding_usd": 0,
                         "infra_usd": 0, "total_usd": 0},
                "metadata": {"tokens_in": 0, "tokens_out": 0},
                "per_task": [{"name": bench, "status": "passed",
                              "duration_s": 1.0, "cost_usd": 0,
                              "tokens_in": 0, "tokens_out": 0,
                              "world_model_mode": "real", "agent_url": None}],
            }, fh)
        with open(os.path.join(context, "run.json"), "w") as fh:
            json.dump({
                "summary": {"passed": 1, "failed": 0, "skipped": 0,
                            "pass_rate": 1.0, "total_duration_seconds": 1.0,
                            "total_cost_cents": 0},
                "tasks": [task],
                "code_ref": ref,
            }, fh)
        log("benchmark complete")
    log(f"::CLOUDBENCH-DONE:: token={token} exit={exit_code}")


if args[:1] == ["__fake_driver__"]:
    run_fake_driver(args[1])
    sys.exit(0)

with open(JOURNAL, "a") as journal:
    journal.write(" ".join(args) + "\n")

if "-a" in args and args[args.index("-a") + 1] == PROD_APP:
    print("FATAL: fake flyctl was pointed at the PRODUCTION app", file=sys.stderr)
    sys.exit(2)

if args[:2] == ["secrets", "list"]:
    with locked_state() as state:
        print(json.dumps([{"Name": name} for name in state["secrets"]]))
elif args[:2] == ["secrets", "set"]:
    with locked_state() as state:
        for pair in args[2:]:
            if "=" in pair:
                key = pair.split("=", 1)[0]
                if key not in state["secrets"]:
                    state["secrets"].append(key)
elif args[:2] == ["apps", "list"]:
    print(json.dumps([{"Name": BENCH_APP}]))
elif args[:2] == ["machines", "list"]:
    with locked_state() as state:
        print(json.dumps(state["machines"]))
elif args[:2] == ["volumes", "list"]:
    with locked_state() as state:
        print(json.dumps(state["volumes"]))
elif args[:3] == ["volume", "snapshots", "list"]:
    with locked_state() as state:
        print(json.dumps(state["snapshots"]))
elif args[:2] == ["machine", "clone"]:
    name = flag_value("--name")
    machine_id = uuid.uuid4().hex[:14]
    with locked_state() as state:
        volume_id = "vol_" + uuid.uuid4().hex[:8]
        state["machines"].append({
            "id": machine_id, "name": name, "state": "stopped",
            "region": flag_value("--region") or "iad", "private_ip": "",
            "config": {"mounts": [{"volume": volume_id}]},
        })
        state["volumes"].append(
            {"id": volume_id, "name": "cloudbench_data_fork", "state": "created"})
    machine_dir(machine_id)
    with open(os.path.join(MARKERS, name), "w") as fh:
        fh.write(machine_id)
    # Barrier: only release once BOTH workstreams have a clone in flight. A
    # serialized (locked) second controller never reaches here → timeout → fail.
    barrier_min = int(os.environ.get("CLOUDBENCH_TEST_BARRIER_MIN", "2"))
    deadline = time.time() + float(os.environ.get("CLOUDBENCH_TEST_BARRIER_TIMEOUT", "45"))
    while len(os.listdir(MARKERS)) < barrier_min:
        if time.time() > deadline:
            print("FATAL: clone barrier timed out — controllers did not overlap",
                  file=sys.stderr)
            sys.exit(1)
        time.sleep(0.2)
    print(f"cloned machine {machine_id}")
elif args[:2] == ["machine", "status"]:
    with locked_state() as state:
        found = find_machine(state, args[2])
    if found is None:
        sys.exit(1)
    print(f"  State: {found['state']}")
elif args[:2] == ["machine", "start"]:
    with locked_state() as state:
        found = find_machine(state, args[2])
        if found:
            found["state"] = "started"
elif args[:2] == ["machine", "stop"]:
    with locked_state() as state:
        found = find_machine(state, args[2])
        if found:
            found["state"] = "stopped"
elif args[:2] == ["machine", "destroy"]:
    target = args[3] if args[2] == "--force" else args[2]
    with locked_state() as state:
        state["machines"] = [m for m in state["machines"] if m["id"] != target]
elif args[:3] == ["ssh", "sftp", "put"]:
    mdir = machine_dir(flag_value("--machine"))
    # positional tail after dropping flag values: [-a APP, --machine ID, -m MODE]
    positional = []
    skip = False
    for i, a in enumerate(args[3:]):
        if skip:
            skip = False
            continue
        if a in ("-a", "--machine", "-m"):
            skip = True
            continue
        if a.startswith("-"):
            continue
        positional.append(a)
    local, remote = positional[0], positional[1]
    dest = rewrite_paths(mdir, remote)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(local, "rb") as src, open(dest, "wb") as dst:
        dst.write(src.read())
    if flag_value("-m") == "0755":
        os.chmod(dest, 0o755)
elif args[:2] == ["ssh", "console"]:
    machine_id = flag_value("--machine")
    command = flag_value("-C") or ""
    mdir = machine_dir(machine_id)
    with locked_state() as state:
        found = find_machine(state, machine_id)
    if found is None or found["state"] != "started":
        print("machine not reachable", file=sys.stderr)
        sys.exit(1)
    if "setsid bash" in command and "rb.sh" in command:
        # Detached driver launch: run the fake driver contract in the background.
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "__fake_driver__", mdir],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        open(os.path.join(mdir, "driver.started"), "w").close()
    elif "pgrep -f cloudbench-run.sh" in command:
        if os.path.exists(os.path.join(mdir, "driver.started")):
            print("RUNNING")
    elif command.strip().startswith('stale_pat=') or "stale_pat='" in command:
        pass  # stale-driver cleanup: nothing to kill inside the sandbox
    else:
        env = dict(os.environ)
        env["HOME"] = os.path.join(mdir, "home")
        env["GIT_CONFIG_GLOBAL"] = os.path.join(mdir, "home", ".gitconfig")
        result = subprocess.run(
            ["bash", "-c", rewrite_paths(mdir, command)],
            capture_output=True, text=True, env=env,
        )
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        sys.exit(result.returncode)
elif args[:2] == ["tokens", "create"]:
    print(json.dumps({"token": "fake-deploy-token"}))
elif args[:1] == ["proxy"]:
    time.sleep(3600)
else:
    print(f"FATAL: fake flyctl has no handler for: {' '.join(args)}", file=sys.stderr)
    sys.exit(1)
PY

cat > "$FAKE_BIN/flyctl" <<SH
#!/usr/bin/env bash
exec python3 "$FAKE_DIR/flyctl.py" "\$@"
SH
chmod +x "$FAKE_BIN/flyctl"

journal_must_be_read_only() {  # journal_must_be_read_only <phase>
    if grep -qE '^secrets set' "$FAKE_DIR/journal.log"; then
        fail "$1: the benchmark run path must never stage app-level secrets (refresh is an explicit maintenance op)"
    fi
    if grep -qE '^tokens create' "$FAKE_DIR/journal.log"; then
        fail "$1: the benchmark run path must not mint Machines API tokens (sentinel lease is gone from the run path)"
    fi
    grep -qE '^secrets list' "$FAKE_DIR/journal.log" ||
        fail "$1: the run path must verify the shared app environment (read-only secrets list)"
}

run_controller() {  # run_controller <worktree> <conductor_port> <log> <fleet-args...>
    local ws="$1" port="$2" log="$3"
    shift 3
    env PATH="$FAKE_BIN:$PATH" \
        FLY_BENCH_API_TOKEN="fake-token" \
        CONDUCTOR_PORT="$port" \
        CI=1 \
        CLOUDBENCH_FAKE_DIR="$FAKE_DIR" \
        CLOUDBENCH_CLONE_LOOKUP_SECONDS=20 \
        CLOUDBENCH_POLL_INTERVAL=2 \
        CLOUDBENCH_LAUNCH_SETTLE_SECONDS=1 \
        bash "$ws/scripts/run-bench-fleet" "$@" > "$log" 2>&1
}

# The fleet derives its hub port as CONDUCTOR_PORT+5764 and (by design) frees a
# non-hub listener sitting on it. The test must therefore only ever point the
# fleets at ports it PROBED free and then occupied with its own hub stubs —
# never at a well-known port that could carry a real process on a dev machine.
find_free_port() {  # find_free_port <start>
    local start="$1" port
    for port in $(seq "$start" $((start + 500))); do
        if ! lsof -ti :"$port" >/dev/null 2>&1; then
            printf '%s' "$port"
            return 0
        fi
    done
    return 1
}
HUB_PORT_A="$(find_free_port 42000)" || fail "could not find a free test port for workstream A"
HUB_PORT_B="$(find_free_port $((HUB_PORT_A + 1)))" || fail "could not find a free test port for workstream B"
CONDUCTOR_PORT_A=$((HUB_PORT_A - 5764))
CONDUCTOR_PORT_B=$((HUB_PORT_B - 5764))

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 1 — concurrent provisioning: two controllers, isolated pool machines
# ═════════════════════════════════════════════════════════════════════════════
run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-a.log" --provision-pool 1 &
PID_A=$!
PIDS+=("$PID_A")
run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-b.log" --provision-pool 1 &
PID_B=$!
PIDS+=("$PID_B")

status_a=0; wait "$PID_A" || status_a=$?
status_b=0; wait "$PID_B" || status_b=$?
PIDS=()

[ "$status_a" -eq 0 ] || fail "workstream A's provisioning must succeed alongside a concurrent run (exit=$status_a)"
[ "$status_b" -eq 0 ] || fail "workstream B's provisioning must succeed alongside a concurrent run (exit=$status_b)"

pool_a="$(grep -c . "$WS_A/.context/cloudbench-pool.ids" 2>/dev/null || echo 0)"
pool_b="$(grep -c . "$WS_B/.context/cloudbench-pool.ids" 2>/dev/null || echo 0)"
[ "$pool_a" = "1" ] || fail "workstream A must own exactly one pool machine (got $pool_a)"
[ "$pool_b" = "1" ] || fail "workstream B must own exactly one pool machine (got $pool_b)"
id_a="$(head -1 "$WS_A/.context/cloudbench-pool.ids")"
id_b="$(head -1 "$WS_B/.context/cloudbench-pool.ids")"
[ -n "$id_a" ] && [ -n "$id_b" ] && [ "$id_a" != "$id_b" ] ||
    fail "concurrent workstreams must provision distinct machines (a=$id_a b=$id_b)"
journal_must_be_read_only "scenario 1"
echo "PASS: scenario 1 — concurrent provisioning with isolated pool machines"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 2 — concurrent RUNS that must FINISH WITH SUCCESS (1/1 passed each)
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -f "$WS_A/.context/cloudbench-pool.ids" "$WS_B/.context/cloudbench-pool.ids"
: > "$FAKE_DIR/journal.log"

# Pre-serve each workspace's central hub on its DERIVED port (CONDUCTOR_PORT +
# 5764) so the fleet adopts it — and so the test proves two workspaces get
# NON-COLLIDING hub ports.
hub_stub() {  # hub_stub <port>
    python3 - "$1" <<'PY' &
import http.server, sys
class Hub(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"Benchmark runs (test hub stub)"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Hub).serve_forever()
PY
    PIDS+=("$!")
    HUB_PIDS+=("$!")
}
hub_stub "$HUB_PORT_A"
hub_stub "$HUB_PORT_B"
for port in "$HUB_PORT_A" "$HUB_PORT_B"; do
    for _ in $(seq 1 50); do
        curl -fsS "http://127.0.0.1:$port/" 2>/dev/null | grep -q "Benchmark runs" && break
        sleep 0.1
    done
done

run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-run-a.log" bench-alpha --no-autoscale --timeout 240 &
PID_A=$!
PIDS+=("$PID_A")
run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-run-b.log" bench-beta --no-autoscale --timeout 240 &
PID_B=$!
PIDS+=("$PID_B")

status_a=0; wait "$PID_A" || status_a=$?
status_b=0; wait "$PID_B" || status_b=$?
# The controllers are reaped. Keep only the live hub processes in the EXIT
# cleanup list so a rapidly reused controller PID can never be signaled.
PIDS=("${HUB_PIDS[@]}")

[ "$status_a" -eq 0 ] || fail "workstream A's benchmark run must FINISH WITH SUCCESS alongside a concurrent run (exit=$status_a)"
[ "$status_b" -eq 0 ] || fail "workstream B's benchmark run must FINISH WITH SUCCESS alongside a concurrent run (exit=$status_b)"
grep -qF "1/1 passed" "$TMP_ROOT/controller-run-a.log" ||
    fail "workstream A's fleet summary must report 1/1 passed"
grep -qF "1/1 passed" "$TMP_ROOT/controller-run-b.log" ||
    fail "workstream B's fleet summary must report 1/1 passed"

# Each workstream's run record must exist, be PASSED, and carry ITS OWN ref —
# proof that per-workstream code snapshots thread through to the machines.
check_run_record() {  # check_run_record <ws> <bench> <expected_ref>
    local ws="$1" bench="$2" expected_ref="$3" record
    record="$(find "$ws/.context/fleet/runs" -path "*/$bench/cloudbench-run.json" -type f -print 2>/dev/null | head -1)"
    [ -n "$record" ] || fail "$bench: run record was not retrieved"
    RECORD="$record" BENCH="$bench" EXPECTED_REF="$expected_ref" python3 - <<'PY'
import json, os, sys
record = json.load(open(os.environ["RECORD"]))
task = (record.get("tasks") or [{}])[0]
if task.get("name") != os.environ["BENCH"]:
    sys.exit(f"run record task name mismatch: {task.get('name')!r}")
if not task.get("passed"):
    sys.exit("run record task did not pass")
if record.get("code_ref") != os.environ["EXPECTED_REF"]:
    sys.exit(
        f"run executed the wrong code snapshot: {record.get('code_ref')!r} "
        f"!= {os.environ['EXPECTED_REF']!r}"
    )
PY
}
check_run_record "$WS_A" bench-alpha "$REF_A" || fail "workstream A's run record is wrong"
check_run_record "$WS_B" bench-beta "$REF_B" || fail "workstream B's run record is wrong"

# Per-workspace hubs must not collide: each fleet adopted its own derived port.
grep -qF "already open on :$HUB_PORT_A" "$TMP_ROOT/controller-run-a.log" ||
    fail "workstream A must use its CONDUCTOR_PORT-derived hub port ($HUB_PORT_A)"
grep -qF "already open on :$HUB_PORT_B" "$TMP_ROOT/controller-run-b.log" ||
    fail "workstream B must use its CONDUCTOR_PORT-derived hub port ($HUB_PORT_B)"

# Teardown isolation: each fleet reaped ONLY its own clone — the shared warm
# source is all that survives.
remaining="$(python3 -c '
import json, sys
machines = json.load(open(sys.argv[1]))["machines"]
print(" ".join(sorted(m["name"] for m in machines)))
' "$FAKE_DIR/state.json")"
[ "$remaining" = "cloudbench-warm" ] ||
    fail "concurrent fleets must tear down exactly their own machines (left: $remaining)"

journal_must_be_read_only "scenario 2"
[ ! -e "$SANDBOX/.git/cloudbench-app-env.lock" ] ||
    fail "no shared app-environment lock file may survive a concurrent run"

echo "PASS: scenario 2 — two concurrent workstream runs FINISHED WITH SUCCESS on distinct code snapshots"
echo "PASS: two workstreams ran cloud benchmarks concurrently, isolated end to end"
