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
# Scenario 3 replays the 54-machine production capacity shape and proves stopped
# inventory cannot block seven active primaries. Scenario 4 proves the same
# guard still rejects a real active burst and treats unknown states fail-closed.
# Scenario 5 SIGKILLs a controller after Fly has accepted its clone, removes the
# workspace-local run ledger, and proves a successor controller reaps the idle
# orphan from durable ownership. Scenario 6 proves recovery refuses to reap or
# provision when the same positively owned stale machine still has a runner.
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
# Keep the synthetic worktrees dependency-fingerprintable. Pool compatibility is
# now a fail-closed production contract, so an intentionally minimal fake repo
# still needs real (minimal) manifests rather than relying on an absent proof.
mkdir -p "$SANDBOX/back-end" "$SANDBOX/front-end" "$SANDBOX/agents/benchmarks"
cp "$ROOT_DIR/agents/benchmarks/hub_upload.py" "$SANDBOX/agents/benchmarks/hub_upload.py"
printf '{}\n' > "$SANDBOX/package.json"
printf '{}\n' > "$SANDBOX/back-end/package.json"
printf '{}\n' > "$SANDBOX/front-end/package.json"
printf '{}\n' > "$SANDBOX/back-end/package-lock.json"
: > "$SANDBOX/agents/requirements.txt"
git -C "$SANDBOX" init -q
git -C "$SANDBOX" -c user.email=test@test -c user.name=test add -A
git -C "$SANDBOX" -c user.email=test@test -c user.name=test commit -qm "snapshot" >/dev/null
# The fake provider exposes snap_0001 as the warm snapshot. Tie the manifest
# proof to that exact ID, mirroring --refresh-deps without a live donor image.
(
    source "$SANDBOX/scripts/lib/cloudbench-env.sh"
    node_fp="$(cloudbench_node_dependency_fingerprint "$SANDBOX")"
    py_fp="$(cloudbench_manifest_fingerprint "$SANDBOX" "${CLOUDBENCH_PYTHON_MANIFESTS[@]}")"
    printf '%s %s 0 snap_0001\n' "$node_fp" "$py_fp" > "$SANDBOX/.git/cloudbench-warm-deps.fp"
)
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
POOL_A="$SANDBOX/.git/cloudbench-pools/ws-a.ids"
POOL_B="$SANDBOX/.git/cloudbench-pools/ws-b.ids"
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
import shlex
import shutil
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
    data-plane release POST → write report-card.json/run.json → DONE marker. The PASS
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
        card = {
            "run_id": "fake", "elapsed_s": 1.0, "world_model_mode": "real",
            "cost": {"agents_llm_usd": 0, "wmh_grounding_usd": 0,
                     "infra_usd": 0, "total_usd": 0},
            "metadata": {"tokens_in": 0, "tokens_out": 0},
            "per_task": [{"name": bench, "status": "passed",
                          "duration_s": 1.0, "cost_usd": 0,
                          "tokens_in": 0, "tokens_out": 0,
                          "world_model_mode": "real", "agent_url": None}],
        }
        run = {
            "summary": {"total": 1, "passed": 1, "failed": 0, "skipped": 0,
                        "pass_rate": 1.0, "total_duration_seconds": 1.0,
                        "total_cost_cents": 0},
            "tasks": [task],
            "code_ref": ref,
        }
        with open(os.path.join(context, "report-card.json"), "w") as fh:
            json.dump(card, fh)
        with open(os.path.join(context, "run.json"), "w") as fh:
            json.dump(run, fh)
        log(f"::CLOUDBENCH-REPORT-CARD-BEGIN:: token={token}")
        log(json.dumps(card, separators=(",", ":")))
        log(f"::CLOUDBENCH-REPORT-CARD-END:: token={token}")
        log(f"::CLOUDBENCH-RESULT-BEGIN:: token={token}")
        log(json.dumps(run, separators=(",", ":")))
        log(f"::CLOUDBENCH-RESULT-END:: token={token}")
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
    # Fault injection for the pre-allocation durability boundary: registry init
    # has completed, but persisting the target name must now fail.
    ownership_root = os.environ.get("CLOUDBENCH_FAKE_BREAK_REGISTRY_ROOT")
    if ownership_root:
        marker = os.path.join(FAKE_DIR, "broke-registry-name-write")
        if not os.path.exists(marker) and os.path.isdir(ownership_root):
            for entry in os.listdir(ownership_root):
                if entry.startswith("."):
                    continue
                clones = os.path.join(ownership_root, entry, "clones")
                if os.path.isdir(clones):
                    shutil.rmtree(clones)
                    with open(clones, "w") as fh:
                        fh.write("injected write failure\n")
                    with open(marker, "w") as fh:
                        fh.write(entry)
                    break
    with locked_state() as state:
        print(json.dumps(state["volumes"]))
elif args[:3] == ["volume", "snapshots", "list"]:
    with locked_state() as state:
        print(json.dumps(state["snapshots"]))
elif args[:2] == ["machine", "clone"]:
    name = flag_value("--name")
    # Fault injection (RCA #6): make the FIRST clone attempt fail AMBIGUOUSLY —
    # non-zero exit, NO Machine allocated, and an error that is NOT a recognized
    # "definitively unallocated" string — so the controller's provision loop must
    # reconcile the already-reserved name AUTHORITATIVELY (resolve -> absent ->
    # release) rather than leaving a name-only orphan that later aborts teardown
    # and leaks its id'd siblings. Later attempts proceed normally.
    if os.environ.get("CLOUDBENCH_FAKE_CLONE_FAIL_ONCE") == "1":
        fail_once_marker = os.path.join(FAKE_DIR, "clone-failed-once")
        if not os.path.exists(fail_once_marker):
            with open(fail_once_marker, "w") as fh:
                fh.write(name or "")
            print("Error: an unexpected error occurred (request timed out)",
                  file=sys.stderr)
            sys.exit(1)
    machine_id = uuid.uuid4().hex[:14]
    vm_size = flag_value("--vm-size") or "shared-cpu-4x"
    vm_memory = int(flag_value("--vm-memory") or "8192")
    cpu_match = re.search(r"(\d+)x$", vm_size)
    vm_cpus = int(cpu_match.group(1)) if cpu_match else 1
    cpu_kind = "performance" if vm_size.startswith("performance-") else "shared"
    with locked_state() as state:
        volume_id = "vol_" + uuid.uuid4().hex[:8]
        state["machines"].append({
            "id": machine_id, "name": name, "state": "stopped",
            "region": flag_value("--region") or "iad", "private_ip": "",
            "config": {"mounts": [{"volume": volume_id}],
                       "guest": {"cpu_kind": cpu_kind, "cpus": vm_cpus,
                                 "memory_mb": vm_memory}},
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
    # Break the transfer destination only after Fly has allocated the clone.
    # The controller must retain fleet ownership and reap instead of handing
    # an unrecorded machine to the stopped pool.
    pool_ledger = os.environ.get("CLOUDBENCH_FAKE_BREAK_POOL_LEDGER")
    if pool_ledger:
        if os.path.isdir(pool_ledger):
            shutil.rmtree(pool_ledger)
        elif os.path.lexists(pool_ledger):
            os.unlink(pool_ledger)
        os.mkdir(pool_ledger)
    print(f"cloned machine {machine_id}")
elif args[:2] == ["machine", "status"]:
    with locked_state() as state:
        found = find_machine(state, args[2])
    if found is None:
        sys.exit(1)
    print(f"  State: {found['state']}")
elif args[:2] == ["machine", "update"]:
    machine_id = args[2]
    boot_env = {}
    for index, value in enumerate(args):
        if value == "--env" and index + 1 < len(args) and "=" in args[index + 1]:
            key, env_value = args[index + 1].split("=", 1)
            boot_env[key] = env_value
    with locked_state() as state:
        found = find_machine(state, machine_id)
        if found is None:
            sys.exit(1)
        found["boot_env"] = boot_env
        found["state"] = "stopped"
        if flag_value("--vm-size"):
            vm_size = flag_value("--vm-size")
            cpu_match = re.search(r"(\d+)x$", vm_size)
            found.setdefault("config", {}).setdefault("guest", {})["cpus"] = (
                int(cpu_match.group(1)) if cpu_match else 1
            )
            found["config"]["guest"]["cpu_kind"] = (
                "performance" if vm_size.startswith("performance-") else "shared"
            )
        if flag_value("--vm-memory"):
            found.setdefault("config", {}).setdefault("guest", {})["memory_mb"] = int(
                flag_value("--vm-memory")
            )
    mdir = machine_dir(machine_id)
    rb_path = os.path.join(mdir, "tmp", "rb.sh")
    os.makedirs(os.path.dirname(rb_path), exist_ok=True)
    with open(rb_path, "w") as fh:
        for key, value in boot_env.items():
            fh.write(f"export {key}={shlex.quote(value)}\n")
elif args[:2] == ["machine", "start"]:
    machine_id = args[2]
    with locked_state() as state:
        found = find_machine(state, machine_id)
        if found:
            found["state"] = "started"
            boot_env = found.get("boot_env") or {}
        else:
            boot_env = {}
    mdir = machine_dir(machine_id)
    if boot_env and not os.path.exists(os.path.join(mdir, "driver.started")):
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "__fake_driver__", mdir],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        open(os.path.join(mdir, "driver.started"), "w").close()
elif args[:2] == ["machine", "stop"]:
    with locked_state() as state:
        found = find_machine(state, args[2])
        if found and not found.get("ignore_stop"):
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
    if "CLOUDBENCH_OWNER_PROBE" in command:
        if found.get("probe_error"):
            print("ownership probe failed", file=sys.stderr)
            sys.exit(1)
        print(f"CLOUDBENCH_RUNNER_COUNT={found.get('runner_count', 0)}")
    elif "setsid bash" in command and "rb.sh" in command:
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
    import http.server
    local_port = int(args[1].split(":", 1)[0])
    remote_host = args[2]
    machine_id = remote_host.split(".vm.", 1)[0]
    mdir = machine_dir(machine_id)

    class ProxyHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/driver-health":
                code = 204 if os.path.exists(os.path.join(mdir, "driver.started")) else 410
                self.send_response(code)
                self.end_headers()
                return
            if self.path != "/bench.log":
                self.send_error(404)
                return
            path = os.path.join(mdir, "data", "bench.log")
            try:
                body = open(path, "rb").read()
            except OSError:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.path != "/release":
                self.send_error(404)
                return
            rb_path = os.path.join(mdir, "tmp", "rb.sh")
            barrier = rb_export(open(rb_path).read(), "CLOUDBENCH_START_BARRIER")
            open(os.path.join(mdir, "data", f"cloudbench-start-{barrier}.release"), "w").close()
            self.send_response(204)
            self.end_headers()

        def log_message(self, *unused):
            pass

    http.server.ThreadingHTTPServer(("127.0.0.1", local_port), ProxyHandler).serve_forever()
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
        BENCHMARK_HUB_UPLOAD_URL="http://127.0.0.1:$((port + 5764))" \
        BENCHMARK_HUB_API_KEY="test-key" \
        CI=1 \
        CLOUDBENCH_FAKE_DIR="$FAKE_DIR" \
        CLOUDBENCH_FAKE_BREAK_REGISTRY_ROOT="${CLOUDBENCH_FAKE_BREAK_REGISTRY_ROOT:-}" \
        CLOUDBENCH_FAKE_BREAK_POOL_LEDGER="${CLOUDBENCH_FAKE_BREAK_POOL_LEDGER:-}" \
        CLOUDBENCH_CLONE_LOOKUP_SECONDS="${CLOUDBENCH_CLONE_LOOKUP_SECONDS:-20}" \
        CLOUDBENCH_POOL_STOP_ATTEMPTS="${CLOUDBENCH_POOL_STOP_ATTEMPTS:-3}" \
        CLOUDBENCH_POOL_STOP_REQUEST_TIMEOUT="${CLOUDBENCH_POOL_STOP_REQUEST_TIMEOUT:-3}" \
        CLOUDBENCH_PROXY_POST_PROBE_SETTLE_SECONDS=0.1 \
        CLOUDBENCH_POLL_INTERVAL=2 \
        CLOUDBENCH_LAUNCH_SETTLE_SECONDS=1 \
        bash "$ws/scripts/run-bench-fleet" "$@" > "$log" 2>&1
}

write_dead_registry() {  # write_dead_registry <label> <policy> <host> <name> [id] [role]
    local label="$1" policy="$2" host="$3" name="$4" id="${5:-}" role="${6:-primary}"
    local registry="$SANDBOX/.git/cloudbench-fleet-ownership/$label"
    mkdir -p "$registry/clones"
    cat > "$registry/meta" <<EOF
version=1
app=navi-whisper-lux-bench
host=$host
pid=999999
pid_start=Mon Jan  1 00:00:00 2001
run_id=$label
cleanup_policy=$policy
EOF
    {
        printf 'name=%s\n' "$name"
        [ -n "$id" ] && printf 'id=%s\n' "$id"
        printf 'role=%s\n' "$role"
    } > "$registry/clones/$name"
}

add_fake_machine() {  # add_fake_machine <id> <name> <state> <runner-count> [probe-error] [ignore-stop]
    FAKE_STATE="$FAKE_DIR/state.json" MACHINE_ID="$1" MACHINE_NAME="$2" \
        MACHINE_STATE="$3" RUNNER_COUNT="$4" PROBE_ERROR="${5:-0}" IGNORE_STOP="${6:-0}" python3 - <<'PY'
import json
import os

path = os.environ["FAKE_STATE"]
with open(path) as fh:
    state = json.load(fh)
state["machines"].append({
    "id": os.environ["MACHINE_ID"],
    "name": os.environ["MACHINE_NAME"],
    "state": os.environ["MACHINE_STATE"],
    "runner_count": int(os.environ["RUNNER_COUNT"]),
    "probe_error": os.environ["PROBE_ERROR"] == "1",
    "ignore_stop": os.environ["IGNORE_STOP"] == "1",
    "region": "iad",
    "private_ip": "fdaa::dead",
    "config": {"mounts": []},
})
with open(path, "w") as fh:
    json.dump(state, fh)
PY
}

fake_machine_exists() {  # fake_machine_exists <id>
    FAKE_STATE="$FAKE_DIR/state.json" MACHINE_ID="$1" python3 - <<'PY'
import json
import os

with open(os.environ["FAKE_STATE"]) as fh:
    machines = json.load(fh)["machines"]
raise SystemExit(0 if any(machine["id"] == os.environ["MACHINE_ID"] for machine in machines) else 1)
PY
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

pool_a="$(grep -c . "$POOL_A" 2>/dev/null || echo 0)"
pool_b="$(grep -c . "$POOL_B" 2>/dev/null || echo 0)"
[ "$pool_a" = "1" ] || fail "workstream A must own exactly one pool machine (got $pool_a)"
[ "$pool_b" = "1" ] || fail "workstream B must own exactly one pool machine (got $pool_b)"
id_a="$(head -1 "$POOL_A")"
id_b="$(head -1 "$POOL_B")"
[ -n "$id_a" ] && [ -n "$id_b" ] && [ "$id_a" != "$id_b" ] ||
    fail "concurrent workstreams must provision distinct machines (a=$id_a b=$id_b)"
journal_must_be_read_only "scenario 1"
echo "PASS: scenario 1 — concurrent provisioning with isolated pool machines"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 2 — concurrent RUNS that must FINISH WITH SUCCESS (1/1 passed each)
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -f "$POOL_A" "$POOL_B"
: > "$FAKE_DIR/journal.log"

# Pre-serve each workspace's central hub on its DERIVED port (CONDUCTOR_PORT +
# 5764) so the fleet adopts it — and so the test proves two workspaces get
# NON-COLLIDING hub ports.
hub_stub() {  # hub_stub <port> <runs-root>
    python3 - "$1" "$2" <<'PY' &
import http.server, json, pathlib, sys
from urllib.parse import urlparse

runs_root = pathlib.Path(sys.argv[2])
registered = {}

class Hub(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/benchmarks/runs/"):
            run_id = path.rsplit("/", 1)[-1]
            if run_id not in registered:
                self.send_error(404)
                return
            body = json.dumps({"run": registered[run_id]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        run_ids = " ".join(
            path.name for path in runs_root.iterdir()
            if path.is_dir() and not path.name.startswith("_")
        ) if runs_root.is_dir() else ""
        body = f"Benchmark runs (test hub stub) {run_ids}".encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if urlparse(self.path).path != "/api/benchmarks/runs":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        run_id = payload.get("run_id")
        if not run_id:
            self.send_error(400)
            return
        registered[run_id] = payload
        body = json.dumps({"run": payload}).encode()
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
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
hub_stub "$HUB_PORT_A" "$WS_A/.context/fleet/runs"
hub_stub "$HUB_PORT_B" "$WS_B/.context/fleet/runs"
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

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 3 — stopped inventory cannot consume the active-compute ceiling
#
# Replay the production failure shape exactly: 54 app machines (23 started,
# 31 stopped) followed by one seven-benchmark smoke fleet. Stopped warm/pool
# inventory costs no compute and must not make the active burst look like 61.
# The real controller must admit the seven primaries, complete them, and reap
# exactly those seven without mutating any pre-existing machine.
# ════════════════════════════════════════════════════════════════════════════
reset_fake_state
: > "$FAKE_DIR/journal.log"
FAKE_STATE="$FAKE_DIR/state.json" python3 - <<'PY'
import json
import os

path = os.environ["FAKE_STATE"]
with open(path) as fh:
    state = json.load(fh)

for index in range(23):
    state["machines"].append({
        "id": f"active{index:08d}",
        "name": f"existing-active-{index}",
        "state": "started",
        "region": "iad",
        "private_ip": f"fdaa::{index + 1}",
        "config": {"mounts": []},
    })
for index in range(30):
    state["machines"].append({
        "id": f"stopped{index:07d}",
        "name": f"existing-stopped-{index}",
        "state": "stopped",
        "region": "iad",
        "private_ip": "",
        "config": {"mounts": []},
    })

with open(path, "w") as fh:
    json.dump(state, fh)
PY

capacity_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-capacity.log" \
    capacity-a capacity-b capacity-c capacity-d capacity-e capacity-f capacity-g \
    --no-autoscale --timeout 240 || capacity_status=$?
[ "$capacity_status" -eq 0 ] ||
    fail "stopped inventory must not block a seven-benchmark active fleet (exit=$capacity_status)"
grep -qF "7/7 passed" "$TMP_ROOT/controller-capacity.log" ||
    fail "capacity replay fleet summary must report 7/7 passed"
JOURNAL="$FAKE_DIR/journal.log" python3 - <<'PY' ||
import os

calls = open(os.environ["JOURNAL"]).read().splitlines()
updates = [index for index, call in enumerate(calls) if call.startswith("machine update ")]
starts = [index for index, call in enumerate(calls) if call.startswith("machine start ")]
if len(updates) < 7 or len(starts) < 7:
    raise SystemExit(f"expected seven update/start calls, got updates={len(updates)} starts={len(starts)}")
if max(updates[:7]) >= min(starts[:7]):
    raise SystemExit("a fleet machine started before every boot config update completed")
if any("--skip-start" not in calls[index] for index in updates[:7]):
    raise SystemExit("boot config updates must explicitly keep every machine stopped")
PY
    fail "capacity replay must configure the entire stopped fleet before any machine starts"

capacity_counts="$(FAKE_STATE="$FAKE_DIR/state.json" python3 - <<'PY'
import json
import os
from collections import Counter

with open(os.environ["FAKE_STATE"]) as fh:
    machines = json.load(fh)["machines"]
counts = Counter(machine["state"] for machine in machines)
print(f"{len(machines)} {counts['started']} {counts['stopped']}")
PY
)"
[ "$capacity_counts" = "54 23 31" ] ||
    fail "capacity replay must reap only its seven machines (got: $capacity_counts)"
echo "PASS: scenario 3 — stopped inventory does not consume active-compute capacity"

# ════════════════════════════════════════════════════════════════════════════
# Scenario 4 — true active SHARED-CPU pressure and unknown states remain fail-closed
#
# #815 replaced the flat machine-count cap with an ELASTIC shared-CPU-unit governor
# (ceiling = governor − headroom = 160 − 20 = 140 units). Only RUNNING machines
# with a shared-CPU guest consume the governor; stopped machines and the separate
# performance reservation do not. A machine in an unknown/transitioning (non-
# stopped) state still counts as running, so it stays capacity-consuming. Stack 69
# running shared-cpu-2x machines (138 shared units — one in a provider-unknown
# state) so a 2-primary run (4 units) projects to 142 > 140 and MUST be rejected
# before any clone. (Machines WITHOUT a shared guest draw the separate perf
# reservation and would never trip this governor — the old count-based setup.)
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
: > "$FAKE_DIR/journal.log"
FAKE_STATE="$FAKE_DIR/state.json" python3 - <<'PY'
import json
import os

path = os.environ["FAKE_STATE"]
with open(path) as fh:
    state = json.load(fh)
for index in range(68):
    state["machines"].append({
        "id": f"busy{index:09d}",
        "name": f"existing-busy-{index}",
        "state": "started",
        "region": "iad",
        "private_ip": f"fdaa::{index + 1}",
        "config": {"mounts": [], "guest": {"cpu_kind": "shared", "cpus": 2}},
    })
# A provider-unknown (non-stopped) state must STILL count as a running shared unit.
state["machines"].append({
    "id": "unknown0000000",
    "name": "existing-unknown",
    "state": "provider-new-state",
    "region": "iad",
    "private_ip": "fdaa::ffff",
    "config": {"mounts": [], "guest": {"cpu_kind": "shared", "cpus": 2}},
})
with open(path, "w") as fh:
    json.dump(state, fh)
PY

capacity_status=0
CLOUDBENCH_SHARED_CPU_GOVERNOR=160 CLOUDBENCH_SHARED_CPU_HEADROOM=20 \
CLOUDBENCH_FLEET_PRIMARY_VM_SIZE=shared-cpu-2x \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-active-capacity.log" \
    capacity-h capacity-i --no-autoscale --timeout 240 || capacity_status=$?
[ "$capacity_status" -eq 1 ] ||
    fail "true active shared-CPU pressure must remain blocked (exit=$capacity_status)"
grep -qF "Shared-CPU capacity governor reached: 138 active shared units" \
    "$TMP_ROOT/controller-active-capacity.log" ||
    fail "unknown/transitioning shared-CPU machines must remain capacity-consuming (expected 138 active units)"
grep -qF "this run's 2 primaries (4 units) = 142" "$TMP_ROOT/controller-active-capacity.log" ||
    fail "active capacity rejection must report the projected shared-unit total"
grep -qF "ceiling 140 (governor 160" "$TMP_ROOT/controller-active-capacity.log" ||
    fail "active capacity rejection must report the governor ceiling"
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then
    fail "an over-capacity active burst must be rejected before cloning"
fi
echo "PASS: scenario 4 — active shared-CPU pressure and unknown states remain fail-closed"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 5 — SIGKILL recovery survives deletion of the workspace-local ledger
#
# Clone acceptance is the irreversible boundary: Fly has allocated a billable
# machine, but the controller can still die before its EXIT trap. Reproduce that
# exact window by holding fake flyctl after allocation, SIGKILLing the whole
# controller tree, and deleting .context/fleet. A successor worktree must recover
# from ownership stored outside that disposable workspace, prove no runner is
# active, and destroy the orphan through the controller's ordinary reap path.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$WS_A/.context/fleet" "$WS_B/.context/fleet"
rm -f "$POOL_A" "$POOL_B"
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership"
: > "$FAKE_DIR/journal.log"

CLOUDBENCH_TEST_BARRIER_MIN=2 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-orphan-source.log" \
    orphan-source --no-autoscale --timeout 240 &
ORPHAN_CONTROLLER_PID=$!
PIDS+=("$ORPHAN_CONTROLLER_PID")

orphan_id=""
orphan_name=""
for _ in $(seq 1 100); do
    orphan_pair="$(FAKE_STATE="$FAKE_DIR/state.json" python3 - <<'PY'
import json
import os

with open(os.environ["FAKE_STATE"]) as fh:
    machines = json.load(fh)["machines"]
clone = next((machine for machine in machines if machine["name"] != "cloudbench-warm"), None)
if clone:
    print(clone["id"], clone["name"])
PY
)"
    orphan_id="$(printf '%s' "$orphan_pair" | awk '{print $1}')"
    orphan_name="$(printf '%s' "$orphan_pair" | awk '{print $2}')"
    [ -n "$orphan_id" ] && break
    sleep 0.1
done
[ -n "$orphan_id" ] || fail "orphan source controller never crossed Fly clone acceptance"

# Kill every descendant first so the blocked flyctl clone cannot finish and let
# a shell descendant run teardown after its parent is gone. SIGKILL intentionally
# cannot execute EXIT traps, matching a crashed app/host or forcibly deleted run.
ORPHAN_ROOT_PID="$ORPHAN_CONTROLLER_PID" python3 - <<'PY'
import os
import signal
import subprocess

root = int(os.environ["ORPHAN_ROOT_PID"])
rows = subprocess.check_output(["ps", "-axo", "pid=,ppid="], text=True).splitlines()
children = {}
for row in rows:
    pid, ppid = map(int, row.split())
    children.setdefault(ppid, []).append(pid)
order = []
stack = list(children.get(root, []))
while stack:
    pid = stack.pop()
    order.append(pid)
    stack.extend(children.get(pid, []))
for pid in reversed(order):
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
try:
    os.kill(root, signal.SIGKILL)
except ProcessLookupError:
    pass
PY
wait "$ORPHAN_CONTROLLER_PID" 2>/dev/null || true
PIDS=("${HUB_PIDS[@]}")

# Fly reports this accepted clone as started while no driver exists. Then remove
# the only ownership artifact the buggy controller used to have.
FAKE_STATE="$FAKE_DIR/state.json" ORPHAN_ID="$orphan_id" python3 - <<'PY'
import json
import os

path = os.environ["FAKE_STATE"]
with open(path) as fh:
    state = json.load(fh)
machine = next(item for item in state["machines"] if item["id"] == os.environ["ORPHAN_ID"])
machine["state"] = "started"
machine["runner_count"] = 0
with open(path, "w") as fh:
    json.dump(state, fh)
PY
rm -rf "$WS_A/.context/fleet"
rm -rf "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"

recovery_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-orphan-recovery.log" \
    orphan-recovery --no-autoscale --timeout 240 || recovery_status=$?
[ "$recovery_status" -eq 0 ] ||
    fail "successor controller must recover a positively owned idle orphan (exit=$recovery_status)"

if FAKE_STATE="$FAKE_DIR/state.json" ORPHAN_ID="$orphan_id" python3 - <<'PY'
import json
import os

with open(os.environ["FAKE_STATE"]) as fh:
    machines = json.load(fh)["machines"]
raise SystemExit(0 if any(item["id"] == os.environ["ORPHAN_ID"] for item in machines) else 1)
PY
then
    fail "SIGKILL orphan $orphan_id ($orphan_name) survived its successor controller"
fi
grep -qF "reaping stale fleet machine $orphan_id" "$TMP_ROOT/controller-orphan-recovery.log" ||
    fail "recovery must report the exact positively owned orphan it reaps"
echo "PASS: scenario 5 — successor reaped a SIGKILL orphan after workspace ledger deletion"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 6 — stale ownership with an active runner fails closed
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$WS_A/.context/fleet" "$WS_B/.context/fleet"
rm -f "$POOL_A" "$POOL_B"
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"

CLOUDBENCH_TEST_BARRIER_MIN=2 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-busy-source.log" \
    busy-source --no-autoscale --timeout 240 &
BUSY_CONTROLLER_PID=$!
PIDS+=("$BUSY_CONTROLLER_PID")
busy_id=""
for _ in $(seq 1 100); do
    busy_id="$(FAKE_STATE="$FAKE_DIR/state.json" python3 - <<'PY'
import json
import os

with open(os.environ["FAKE_STATE"]) as fh:
    machines = json.load(fh)["machines"]
clone = next((machine for machine in machines if machine["name"] != "cloudbench-warm"), None)
if clone:
    print(clone["id"])
PY
)"
    [ -n "$busy_id" ] && break
    sleep 0.1
done
[ -n "$busy_id" ] || fail "busy orphan source never crossed Fly clone acceptance"
ORPHAN_ROOT_PID="$BUSY_CONTROLLER_PID" python3 - <<'PY'
import os
import signal
import subprocess

root = int(os.environ["ORPHAN_ROOT_PID"])
rows = subprocess.check_output(["ps", "-axo", "pid=,ppid="], text=True).splitlines()
children = {}
for row in rows:
    pid, ppid = map(int, row.split())
    children.setdefault(ppid, []).append(pid)
stack = list(children.get(root, []))
order = []
while stack:
    pid = stack.pop()
    order.append(pid)
    stack.extend(children.get(pid, []))
for pid in reversed(order):
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
try:
    os.kill(root, signal.SIGKILL)
except ProcessLookupError:
    pass
PY
wait "$BUSY_CONTROLLER_PID" 2>/dev/null || true
PIDS=("${HUB_PIDS[@]}")
FAKE_STATE="$FAKE_DIR/state.json" BUSY_ID="$busy_id" python3 - <<'PY'
import json
import os

path = os.environ["FAKE_STATE"]
with open(path) as fh:
    state = json.load(fh)
machine = next(item for item in state["machines"] if item["id"] == os.environ["BUSY_ID"])
machine["state"] = "started"
machine["runner_count"] = 1
with open(path, "w") as fh:
    json.dump(state, fh)
PY
rm -rf "$WS_A/.context/fleet" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
# Assertions below concern the successor's fail-closed behavior only; the
# source controller necessarily cloned once to create the stale-owned fixture.
: > "$FAKE_DIR/journal.log"

busy_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-busy-recovery.log" \
    must-not-launch --no-autoscale --timeout 240 || busy_status=$?
[ "$busy_status" -eq 1 ] || fail "active-runner stale ownership must fail closed (exit=$busy_status)"
grep -qF "refusing to reap stale fleet machine $busy_id: runner count=1" "$TMP_ROOT/controller-busy-recovery.log" ||
    fail "fail-closed recovery must report the exact active-runner reason"
if grep -qE '^machine destroy .*'"$busy_id" "$FAKE_DIR/journal.log"; then
    fail "fail-closed recovery must never destroy a stale machine with an active runner"
fi
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then
    fail "fail-closed recovery must not provision after an uncertain/active stale owner"
fi
echo "PASS: scenario 6 — active-runner stale ownership blocks destroy and provisioning"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 7 — name-only ownership survives a provider visibility gap; the same
# role-agnostic registry also recovers an autoscaler worker clone.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
owner_host="$(hostname 2>/dev/null || uname -n)"
delayed_name="cloudbench-aaa-delayed-provider"
worker_name="cloudbench-zzz-autoscaler-worker"
worker_id="a5705ca1e00001"
write_dead_registry aaa-delayed-name reap "$owner_host" "$delayed_name"
write_dead_registry zzz-autoscaler-worker reap "$owner_host" "$worker_name" "$worker_id" autoscaler-worker
add_fake_machine "$worker_id" "$worker_name" started 0

delayed_status=0
CLOUDBENCH_CLONE_LOOKUP_SECONDS=1 CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-delayed-name.log" \
    must-wait-for-provider --no-autoscale --timeout 240 || delayed_status=$?
[ "$delayed_status" -eq 1 ] || fail "name-only provider gap must fail closed (exit=$delayed_status)"
grep -qF "retaining ownership and refusing to provision" "$TMP_ROOT/controller-delayed-name.log" ||
    fail "name-only provider gap must retain its durable ownership record"
[ -f "$SANDBOX/.git/cloudbench-fleet-ownership/aaa-delayed-name/clones/$delayed_name" ] ||
    fail "name-only durable record was discarded before provider visibility"
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then
    fail "name-only uncertainty must block new provisioning"
fi

delayed_id="de1a9ed0000001"
add_fake_machine "$delayed_id" "$delayed_name" started 0
rm -rf "$FAKE_DIR/markers"; mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
CLOUDBENCH_CLONE_LOOKUP_SECONDS=1 CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-delayed-visible.log" \
    delayed-visible --no-autoscale --timeout 240 || fail "late-visible owned clone recovery failed"
fake_machine_exists "$delayed_id" && fail "late-visible name-only clone was not reaped"
fake_machine_exists "$worker_id" && fail "durably owned autoscaler worker was not reaped"
grep -qF "reaping stale fleet machine $worker_id" "$TMP_ROOT/controller-delayed-visible.log" ||
    fail "autoscaler worker recovery was not reported"
echo "PASS: scenario 7 — delayed name and autoscaler ownership recover without orphaning"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 8 — durable pool handoff + cross-workspace dead-claim recovery.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-pool-handoff.log" \
    --provision-pool 1 || fail "durable pool provisioning failed"
pool_id="$(head -1 "$POOL_A")"
[ -n "$pool_id" ] || fail "durable pool ledger did not receive the provisioned ID"
[ -f "$POOL_A" ] || fail "pool ledger must live under git-common, outside WS_A"
if find "$SANDBOX/.git/cloudbench-fleet-ownership" -path '*/clones/*' -type f -print 2>/dev/null | grep -q .; then
    fail "verified stopped pool handoff must release ephemeral fleet ownership"
fi

# Simulate WS_A disappearing after its claimed pool machine starts. WS_B scans
# every durable pool ledger, proves the dead same-host claim and zero runners,
# and stops it even though WS_B has a different pool basename.
mkdir -p "$SANDBOX/.git/cloudbench-pool-claims"
cat > "$SANDBOX/.git/cloudbench-pool-claims/$pool_id" <<EOF
host=$owner_host
pid=999999
pid_start=Mon Jan  1 00:00:00 2001
EOF
FAKE_STATE="$FAKE_DIR/state.json" POOL_ID="$pool_id" python3 - <<'PY'
import json
import os

path = os.environ["FAKE_STATE"]
with open(path) as fh:
    state = json.load(fh)
machine = next(item for item in state["machines"] if item["id"] == os.environ["POOL_ID"])
machine["state"] = "started"
machine["runner_count"] = 0
with open(path, "w") as fh:
    json.dump(state, fh)
PY
rm -rf "$WS_A/.context/fleet" "$FAKE_DIR/markers"; mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-cross-pool-recovery.log" \
    cross-pool-recovery --no-autoscale --timeout 240 || fail "WS_B could not recover deleted WS_A pool claim"
grep -qF "recovering dead-claimed idle pool machine $pool_id" "$TMP_ROOT/controller-cross-pool-recovery.log" ||
    fail "cross-workspace dead pool claim recovery was not reported"
[ ! -f "$SANDBOX/.git/cloudbench-pool-claims/$pool_id" ] ||
    fail "verified stopped dead pool claim was not released"
pool_state="$(FAKE_STATE="$FAKE_DIR/state.json" POOL_ID="$pool_id" python3 - <<'PY'
import json
import os
with open(os.environ["FAKE_STATE"]) as fh:
    machine = next(item for item in json.load(fh)["machines"] if item["id"] == os.environ["POOL_ID"])
print(machine["state"])
PY
)"
[ "$pool_state" = "stopped" ] || fail "cross-workspace recovered pool machine must remain stopped"
echo "PASS: scenario 8 — pool handoff and deleted-workspace claim recover durably"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 9 — cleanup stop failure retains its exact pool claim.
# ═════════════════════════════════════════════════════════════════════════════
# Make WS_B own the existing stopped pool, then force Fly's cleanup stop to be a
# no-op. The controller may fail, but it must leave an auditable claim behind.
cp "$POOL_A" "$POOL_B"
cp "$POOL_A.deps" "$POOL_B.deps"
FAKE_STATE="$FAKE_DIR/state.json" POOL_ID="$pool_id" python3 - <<'PY'
import json
import os
path = os.environ["FAKE_STATE"]
with open(path) as fh:
    state = json.load(fh)
machine = next(item for item in state["machines"] if item["id"] == os.environ["POOL_ID"])
machine["ignore_stop"] = True
with open(path, "w") as fh:
    json.dump(state, fh)
PY
rm -rf "$FAKE_DIR/markers"; mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
stop_fail_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 CLOUDBENCH_POOL_STOP_ATTEMPTS=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-pool-stop-failure.log" \
    pool-stop-failure --no-autoscale --timeout 240 || stop_fail_status=$?
[ "$stop_fail_status" -eq 1 ] || fail "unverified pool stop must fail cleanup (exit=$stop_fail_status)"
[ -f "$SANDBOX/.git/cloudbench-pool-claims/$pool_id" ] ||
    fail "cleanup discarded the claim even though stop never verified"
grep -qF "retaining ownership claim" "$TMP_ROOT/controller-pool-stop-failure.log" ||
    fail "cleanup stop failure must report retained ownership"
echo "PASS: scenario 9 — failed pool stop retains ownership and exits nonzero"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 10 — retain/other-host safety and malformed/probe-error fail closed.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
retain_id="e7a10000000001"; remote_id="07e20000000001"
retain_name="cloudbench-retain-debug"; remote_name="cloudbench-remote-owner"
write_dead_registry retain-debug retain "$owner_host" "$retain_name" "$retain_id"
write_dead_registry remote-owner reap other-host.example "$remote_name" "$remote_id"
add_fake_machine "$retain_id" "$retain_name" started 0
add_fake_machine "$remote_id" "$remote_name" started 0
: > "$FAKE_DIR/journal.log"
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-safe-skips.log" \
    safe-skips --no-autoscale --timeout 240 || fail "retain/other-host safety run failed"
fake_machine_exists "$retain_id" || fail "retain-policy machine was destroyed"
fake_machine_exists "$remote_id" || fail "other-host machine was destroyed"

reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" "$FAKE_DIR/markers"
mkdir -p "$SANDBOX/.git/cloudbench-fleet-ownership/malformed/clones" "$FAKE_DIR/markers"
printf 'version=1\nhost=%s\npid=999999\npid_start=x\ncleanup_policy=reap\n' "$owner_host" \
    > "$SANDBOX/.git/cloudbench-fleet-ownership/malformed/meta"
: > "$FAKE_DIR/journal.log"
malformed_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-malformed-registry.log" \
    malformed-registry --no-autoscale --timeout 240 || malformed_status=$?
[ "$malformed_status" -eq 1 ] || fail "malformed ownership must fail closed"
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then fail "malformed ownership allowed provisioning"; fi

reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
probe_id="f70be000000001"; probe_name="cloudbench-probe-error"
write_dead_registry probe-error reap "$owner_host" "$probe_name" "$probe_id"
add_fake_machine "$probe_id" "$probe_name" started 0 1
: > "$FAKE_DIR/journal.log"
probe_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-probe-error.log" \
    probe-error --no-autoscale --timeout 240 || probe_status=$?
[ "$probe_status" -eq 1 ] || fail "unreadable runner probe must fail closed"
fake_machine_exists "$probe_id" || fail "unreadable-probe machine was destroyed"
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then fail "unreadable probe allowed provisioning"; fi
echo "PASS: scenario 10 — retain/other-host untouched; malformed/probe-error fail closed"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 11 — ownership persistence failures occur before provider mutation.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
sentinel_registry="$SANDBOX/.git/cloudbench-fleet-ownership/sentinel-existing-owner"
mkdir -p "$FAKE_DIR/markers" "$sentinel_registry/clones"
printf 'must-survive-invalid-current-token\n' > "$sentinel_registry/sentinel"
: > "$FAKE_DIR/journal.log"
init_write_status=0
CLOUDBENCH_TEST_FLEET_OWNER_TOKEN='' CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-registry-init-failure.log" \
    --provision-pool 1 || init_write_status=$?
[ "$init_write_status" -eq 1 ] || fail "registry init write failure must exit nonzero"
[ -f "$sentinel_registry/sentinel" ] ||
    fail "invalid current token cleanup removed the shared ownership root/sentinel registry"
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then
    fail "provider clone occurred without an initialized durable registry"
fi
grep -qF "refusing provider mutation" "$TMP_ROOT/controller-registry-init-failure.log" ||
    fail "registry init failure did not report its fail-closed boundary"

reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
name_write_status=0
CLOUDBENCH_FAKE_BREAK_REGISTRY_ROOT="$SANDBOX/.git/cloudbench-fleet-ownership" \
    CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_B" "$CONDUCTOR_PORT_B" "$TMP_ROOT/controller-registry-name-failure.log" \
    --provision-pool 1 || name_write_status=$?
[ "$name_write_status" -eq 1 ] || fail "clone-name ownership write failure must exit nonzero"
if grep -qE '^machine clone' "$FAKE_DIR/journal.log"; then
    fail "provider clone occurred after durable clone-name persistence failed"
fi
grep -qF "refusing provider allocation" "$TMP_ROOT/controller-registry-name-failure.log" ||
    fail "clone-name write failure did not report its pre-allocation boundary"
echo "PASS: scenario 11 — registry init/name write failures cause zero provider clones"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 12 — a failed durable pool handoff retains fleet ownership and EXIT
# teardown reaps the already allocated, verified-stopped clone.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
pool_write_status=0
CLOUDBENCH_FAKE_BREAK_POOL_LEDGER="$POOL_A" CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-pool-ledger-failure.log" \
    --provision-pool 1 || pool_write_status=$?
[ "$pool_write_status" -eq 1 ] || fail "pool-ledger transfer failure must propagate nonzero"
grep -qE '^machine clone' "$FAKE_DIR/journal.log" ||
    fail "pool transfer regression did not cross provider allocation"
grep -qE '^machine destroy' "$FAKE_DIR/journal.log" ||
    fail "pool transfer failure did not reap through fleet teardown"
grep -qF "retaining fleet ownership for teardown" "$TMP_ROOT/controller-pool-ledger-failure.log" ||
    fail "pool transfer failure did not retain its fleet ownership"
if FAKE_STATE="$FAKE_DIR/state.json" python3 - <<'PY'
import json
import os
with open(os.environ["FAKE_STATE"]) as fh:
    machines = json.load(fh)["machines"]
raise SystemExit(0 if any(machine["name"] != "cloudbench-warm" for machine in machines) else 1)
PY
then
    fail "pool-ledger transfer failure left an allocated clone alive"
fi
echo "PASS: scenario 12 — failed pool transfer retains ownership and reaps the clone"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 13 — repeated provisioning extends, rather than truncates, ownership.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-pool-first.log" \
    --provision-pool 1 || fail "first repeat-pool provisioning failed"
first_pool_id="$(head -1 "$POOL_A")"
[ -n "$first_pool_id" ] || fail "first repeat-pool ID was not persisted"
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-pool-second.log" \
    --provision-pool 1 || fail "second repeat-pool provisioning failed"
[ "$(grep -c . "$POOL_A")" -eq 2 ] || fail "repeat provisioning truncated or failed to extend the pool ledger"
[ "$(sort -u "$POOL_A" | grep -c .)" -eq 2 ] || fail "repeat provisioning did not persist two distinct IDs"
grep -Fxq "$first_pool_id" "$POOL_A" || fail "repeat provisioning forgot the original pool ID"
if ! FAKE_STATE="$FAKE_DIR/state.json" POOL_LEDGER="$POOL_A" python3 - <<'PY'
import json
import os

with open(os.environ["POOL_LEDGER"]) as fh:
    ids = [line.strip() for line in fh if line.strip()]
with open(os.environ["FAKE_STATE"]) as fh:
    machines = {machine["id"]: machine for machine in json.load(fh)["machines"]}
assert len(ids) == 2
assert all(machine_id in machines for machine_id in ids)
assert all(machines[machine_id]["state"] == "stopped" for machine_id in ids)
PY
then
    fail "repeat provisioning left a ledger ID absent or non-stopped"
fi
echo "PASS: scenario 13 — repeat provisioning preserves every prior pool owner record"

# ═══════════════════════════════════════════════════════════════════════════
# Scenario 14 — the shared-warm-box RUN footgun is closed
#
# A bare `run-bench-cloud <task>` (no --machine) would execute on the ONE shared
# warm box — NOT parallel-safe: two worktrees collide on the same machine and
# whichever stops it clobbers the other's in-flight run (a real cross-workspace
# incident: the 683e47df clobber). The guard must REJECT that run (and the
# `run-bench --single-box` dispatcher alias) at arg-parse time, BEFORE any Fly
# call. The fleet path (--machine) and the maintainer env escape hatch
# (CLOUDBENCH_ALLOW_SHARED_WARM_RUN=1) are exempt by the same guard condition —
# and the fleet path's full end-to-end success is already proven by scenario 2.
# Only the fast, Fly-free rejection paths are exercised here (a pass-through run
# would proceed into real machine provisioning).
# ═══════════════════════════════════════════════════════════════════════════
: > "$FAKE_DIR/journal.log"
guard_cloud="$TMP_ROOT/guard-cloud.log"
if env PATH="$FAKE_BIN:$PATH" CLOUDBENCH_FAKE_DIR="$FAKE_DIR" \
    bash "$WS_A/scripts/run-bench-cloud" some-bench > "$guard_cloud" 2>&1; then
    fail "scenario 14: run-bench-cloud <task> on the shared warm box must be rejected"
fi
grep -qiF "parallel-safe" "$guard_cloud" ||
    fail "scenario 14: rejection must explain the shared-warm-box parallel-safety hazard"
if grep -qE '^machine (clone|start|update|stop)' "$FAKE_DIR/journal.log"; then
    fail "scenario 14: the guard must reject BEFORE any Fly machine operation"
fi

guard_single="$TMP_ROOT/guard-single-box.log"
if env PATH="$FAKE_BIN:$PATH" bash "$WS_A/scripts/run-bench" --single-box some-bench > "$guard_single" 2>&1; then
    fail "scenario 14: run-bench --single-box must be rejected"
fi
grep -qiF "parallel-safe" "$guard_single" ||
    fail "scenario 14: --single-box rejection must explain the parallel-safety hazard"
echo "PASS: scenario 14 — the shared-warm-box run footgun is closed (fleet + escape-hatch exempt by guard condition)"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 15 — an AGED-OUT phantom name-only record must be discarded so a dead
# owner's never-materialized clone cannot block provisioning forever.
#
# Scenario 7 proves a FRESH name-only record fails closed (a real clone may still
# be lagging provider visibility — don't orphan it). But a clone REQUEST that
# never materialized leaves a name-only record that stays absent forever; failing
# closed on it permanently, deterministically aborts EVERY future run on the host
# (the real incident: a finished neighbor fleet's dead-owner registry with a
# ~45-min-old phantom blocked the ecommerce slice run after run). Once the record
# has been absent far longer than any visibility gap it is a confirmed phantom and
# recovery must discard it and keep provisioning.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
owner_host="$(hostname 2>/dev/null || uname -n)"
phantom_name="cloudbench-phantom-never-materialized"
write_dead_registry phantom-aged reap "$owner_host" "$phantom_name"
phantom_record="$SANDBOX/.git/cloudbench-fleet-ownership/phantom-aged/clones/$phantom_name"
# Age the record far beyond the phantom TTL; the machine is intentionally NEVER
# added to the fake fly state, so it stays confirmed-absent (resolve == 1).
touch -t 200001010000 "$phantom_record" 2>/dev/null || fail "scenario 15: could not backdate phantom record"
phantom_status=0
CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-phantom-aged.log" \
    --provision-pool 1 || phantom_status=$?
[ "$phantom_status" -eq 0 ] ||
    fail "scenario 15: aged-out phantom must not block provisioning (exit=$phantom_status)"
grep -qF "discarding aged-out phantom name-only clone '$phantom_name'" "$TMP_ROOT/controller-phantom-aged.log" ||
    fail "scenario 15: aged-out phantom discard was not reported"
[ -f "$phantom_record" ] && fail "scenario 15: aged-out phantom record was not removed"
pool_phantom_id="$(head -1 "$POOL_A" 2>/dev/null)"
[ -n "$pool_phantom_id" ] ||
    fail "scenario 15: provisioning did not proceed after the phantom was discarded"
# A FRESH name-only phantom (default TTL) must still fail closed — the age gate,
# not blanket discard, is what protects a real lagging clone (Scenario 7).
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
fresh_name="cloudbench-fresh-visibility-gap"
write_dead_registry phantom-fresh reap "$owner_host" "$fresh_name"
fresh_status=0
CLOUDBENCH_CLONE_LOOKUP_SECONDS=1 CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-phantom-fresh.log" \
    --provision-pool 1 || fresh_status=$?
[ "$fresh_status" -eq 1 ] ||
    fail "scenario 15: a FRESH name-only record must still fail closed (exit=$fresh_status)"
[ -f "$SANDBOX/.git/cloudbench-fleet-ownership/phantom-fresh/clones/$fresh_name" ] ||
    fail "scenario 15: a fresh name-only record must be retained, not discarded"
echo "PASS: scenario 15 — aged-out phantom is discarded (provisioning proceeds); fresh gap still fails closed"

# ═════════════════════════════════════════════════════════════════════════════
# Scenario 16 — an AMBIGUOUS clone failure must not leave a name-only orphan.
#
# RCA #6 (real incident: 7 leaked paid machines). The provision loop reserves the
# clone name durably BEFORE asking Fly to allocate (so a SIGKILL mid-clone can't
# orphan a late-appearing machine). If that attempt then fails AMBIGUOUSLY — a
# non-zero/timed-out clone that yields no id and is NOT a recognized "definitively
# unallocated" error — the original code retained the name record forever. That
# id-less orphan later hit the `*) return 1` reap arm on a single transient
# Fly-list read and aborted the whole teardown, leaking every already-id'd sibling
# (glob order put the orphan first → 0 siblings destroyed). The fix resolves the
# reserved name AUTHORITATIVELY after a failed attempt: bind the id if a machine
# materialized, RELEASE the reservation on a definite "absent". This drives the
# real controller through exactly that ambiguous failure and proves no orphan
# survives while provisioning still succeeds on retry.
# ═════════════════════════════════════════════════════════════════════════════
reset_fake_state
rm -rf "$SANDBOX/.git/cloudbench-fleet-ownership" "$SANDBOX/.git/cloudbench-pools" \
    "$SANDBOX/.git/cloudbench-pool-claims" "$FAKE_DIR/markers" "$FAKE_DIR/clone-failed-once"
mkdir -p "$FAKE_DIR/markers"
: > "$FAKE_DIR/journal.log"
amb_status=0
CLOUDBENCH_FAKE_CLONE_FAIL_ONCE=1 CLOUDBENCH_CLONE_LOOKUP_SECONDS=1 CLOUDBENCH_TEST_BARRIER_MIN=1 \
    run_controller "$WS_A" "$CONDUCTOR_PORT_A" "$TMP_ROOT/controller-amb-clone.log" \
    --provision-pool 1 || amb_status=$?
[ "$amb_status" -eq 0 ] ||
    fail "scenario 16: provisioning must recover from an ambiguous clone failure (exit=$amb_status)"
# The retry must have produced a real pool machine (the failure was survivable).
amb_pool_id="$(head -1 "$POOL_A" 2>/dev/null)"
[ -n "$amb_pool_id" ] ||
    fail "scenario 16: provisioning did not proceed after the ambiguous clone failure"
# CRITICAL: no name-only (id-less) orphan may remain — that is the exact record
# that poisons teardown and leaks siblings.
amb_orphans=0
for reg in "$SANDBOX"/.git/cloudbench-fleet-ownership/*/clones/*; do
    [ -f "$reg" ] || continue
    grep -q '^id=' "$reg" || amb_orphans=$((amb_orphans + 1))
done
[ "$amb_orphans" -eq 0 ] ||
    fail "scenario 16: ambiguous clone failure left $amb_orphans name-only orphan record(s) — RCA #6 regression"
echo "PASS: scenario 16 — ambiguous clone failure releases its reserved name (no orphan); retry provisions"

echo "PASS: two workstreams ran cloud benchmarks concurrently, isolated end to end"
