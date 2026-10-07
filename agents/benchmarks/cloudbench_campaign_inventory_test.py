"""Copy campaigns reuse the real inventory producer without borrowing ownership."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from benchmarks.fixture_host_guard import FIXTURE_HOST_GUARD_SECONDS

ROOT = Path(os.environ.get("CLOUDBENCH_INVENTORY_ROOT_UNDER_TEST", Path(__file__).resolve().parents[2]))


def producer_source(root):
    lib = root / "scripts/lib/cloudbench-inventory.sh"
    if lib.exists():
        return lib.read_text()
    text = (root / "scripts/run-bench-fleet").read_text()
    block = text[text.index("# ── ONE shared inventory stream") : text.index("is_sim_on() {")]
    for name in ("resolve_fly_token", "registry_meta_value", "fly_with_timeout"):
        start = text.index(name + "() {")
        block = text[start : text.index("\n}\n", start) + 3] + "\n" + block
    return block


def run_consumers(tmp_path, *, shared=True, death=False, refresh=False, auth=False, production_only=False):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (scripts / "lib").mkdir()
    if production_only:
        (scripts / "cloudbench-production-only-tasks.py").write_text("import sys; sys.exit(0)\n")
    for name in ("cloudbench-env.sh",):
        shutil.copyfile(ROOT / "scripts/lib" / name, scripts / "lib" / name)
    for name in ("cloudbench-machine-readiness.py", "cloudbench-campaign-inventory.sh"):
        origin = ROOT / "scripts" / name
        if origin.exists():
            shutil.copyfile(origin, scripts / name)
    (scripts / "lib/cloudbench-inventory.sh").write_text(producer_source(ROOT))
    binary = tmp_path / "bin"
    binary.mkdir()
    machines = tmp_path / "machines.private.json"
    actual = os.environ.get("CLOUDBENCH_INVENTORY_NATIVE_PAYLOAD")
    if actual:
        shutil.copyfile(actual, machines)
        target = next(row["id"] for row in json.loads(machines.read_text()) if row.get("state") == "started")
    else:
        machines.write_text(
            json.dumps(
                [
                    {
                        "id": "fixture1",
                        "name": "fixture-one",
                        "state": "started",
                        "config": {"init": {"exec": ["sleep", "infinity"]}},
                    }
                ]
            )
        )
        target = "fixture1"
    machines.chmod(0o600)
    volumes = tmp_path / "volumes.private.json"
    volumes.write_text("[]")
    calls = tmp_path / "calls.safe.jsonl"
    fly = binary / "flyctl"
    fly.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "kind=sys.argv[1]\n"
        "if os.environ.get('FIXTURE_EXPECT_AUTH'): assert os.environ.get('FLY_API_TOKEN') == os.environ['FIXTURE_EXPECT_AUTH'], 'wrong selected credential'\n"
        "payload=Path(os.environ['FIXTURE_'+kind.upper()]).read_bytes()\n"
        "fd=os.open(os.environ['FIXTURE_CALLS'],os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)\n"
        "os.write(fd,(json.dumps({'kind':kind,'decoded_bytes':len(payload)})+'\\n').encode());os.close(fd)\n"
        "sys.stdout.buffer.write(payload)\n"
    )
    fly.chmod(0o700)
    cli = scripts / "run-bench"
    cli.write_text(
        "#!/usr/bin/env bash\nset -euo pipefail\n"
        'FLEET_DIR="$FIXTURE_ROOT/$RUN_BENCH_CAMPAIGN_JOB_ID"\nmkdir -p "$FLEET_DIR"\n'
        'APP=navi-whisper-lux-bench\nFLEET_OWNER_HOST="$(hostname)"\n'
        f"MACHINE_READINESS_SCRIPT={str(scripts / 'cloudbench-machine-readiness.py')!r}\n"
        f"source {str(scripts / 'lib/cloudbench-env.sh')!r}\n"
        f"source {str(scripts / 'lib/cloudbench-inventory.sh')!r}\n"
        'FLY_API_TOKEN="$(resolve_fly_token)"\nexport FLY_API_TOKEN\n'
        'FLY() { flyctl "$@"; }\n'
        'finish() { if declare -F stop_owned_machines_snapshot_loop >/dev/null; then stop_owned_machines_snapshot_loop; else cloudbench_terminate_tree_and_wait 30 "$SNAPSHOT_LOOP_PID"; fi; touch "$FLEET_DIR/closed"; }\n'
        "trap finish EXIT\ntrap 'exit 143' TERM\nstart_machines_snapshot_loop\n"
        'if [ "$FIXTURE_DEATH" = 1 ]; then\n'
        ' if [[ "$RUN_BENCH_CAMPAIGN_JOB_ID" == *j0002 ]]; then\n'
        '  while [ "$(python3 -c \'import json,os;print(sum(json.loads(s)["kind"]=="machines" for s in open(os.environ["FIXTURE_CALLS"])))\')" -lt 2 ] || [ -e "$INVENTORY_REFRESH_LOCK" ]; do sleep 0.1; done\n'
        '  kill "$SNAPSHOT_LOOP_PID"\n'
        " fi\n"
        ' touch "$FLEET_DIR/paused-before-gate";\n'
        ' if [ -z "${CLOUDBENCH_CAMPAIGN_INVENTORY_DIR:-}" ]; then exit 0; fi\n'
        " while :; do sleep 1; done\n"
        "fi\n"
        'touch "$FLEET_DIR/ready"\n'
        'if [[ "$RUN_BENCH_CAMPAIGN_JOB_ID" == *j0002 ]]; then\n'
        ' while [ ! -e "$FIXTURE_ROOT/r001-j0001/closed" ]; do sleep 0.1; done\n'
        ' inventory_machine_field "$FIXTURE_TARGET" state > "$FLEET_DIR/state"\n'
        ' if [ "$FIXTURE_REFRESH" = 1 ]; then\n'
        '  while [ "$(python3 -c \'import json,os;print(sum(json.loads(s)["kind"]=="machines" for s in open(os.environ["FIXTURE_CALLS"])))\')" -lt 2 ] || [ -e "$INVENTORY_REFRESH_LOCK" ]; do sleep 0.1; done\n'
        '  prior="$(machines_snapshot_identity)"; refresh_machines_snapshot_after "$prior"; test "$prior" != "$(machines_snapshot_identity)"; fi\n'
        "fi\n"
    )
    env = dict(os.environ)
    for key in list(env):
        if key.startswith("RUN_BENCH_CAMPAIGN_") or key.startswith("CLOUDBENCH_CAMPAIGN_"):
            env.pop(key)
    env.update(
        PATH=str(binary)
        + os.pathsep
        + "/opt/homebrew/bin:"
        + str(Path(sys.executable).parent)
        + os.pathsep
        + env.get("PATH", ""),
        FLY_API_TOKEN="offline-fixture-only",
        FIXTURE_ROOT=str(tmp_path),
        FIXTURE_MACHINES=str(machines),
        FIXTURE_VOLUMES=str(volumes),
        FIXTURE_CALLS=str(calls),
        FIXTURE_TARGET=target,
        FIXTURE_DEATH=str(int(death)),
        FIXTURE_REFRESH=str(int(refresh)),
        CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY=str(int(shared)),
        CLOUDBENCH_SNAPSHOT_POLL_SECONDS="60",
    )
    if auth:
        env["FLY_BENCH_API_TOKEN"] = "offline-bench-token-selected-123456789"
        env["FLY_API_TOKEN"] = "offline-injected-token-unselected"
        env["FIXTURE_EXPECT_AUTH"] = env["FLY_BENCH_API_TOKEN"]
    result = subprocess.run(
        [
            sys.executable,
            str(Path(os.environ.get("CLOUDBENCH_CAMPAIGN_SCRIPT_UNDER_TEST", ROOT / "scripts/run-bench-campaign.py"))),
            "--root",
            str(tmp_path),
            "--runs",
            "1",
            "--concurrency",
            "2",
            "--task",
            "first",
            "--task",
            "second",
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=FIXTURE_HOST_GUARD_SECONDS,
    )
    records = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
    summary = json.loads(next((tmp_path / ".context/benchmarks/campaigns").glob("*/summary.json")).read_text())
    return result, records, summary, machines.stat().st_size


def test_campaign_inventory_two_consumers_share_one_native_feed_and_leave_parent_owner_alive(tmp_path):
    result, calls, summary, payload_bytes = run_consumers(tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    machines = [call for call in calls if call["kind"] == "machines"]
    # The unchanged producer does one initial read and one first loop read.
    assert len(machines) == 2, calls
    assert sum(call["decoded_bytes"] for call in machines) == payload_bytes * 2
    assert (tmp_path / "r001-j0002/state").read_text() == "started"
    assert all(job["controller_exit_code"] == 0 for job in summary["jobs"])
    feed = Path(summary["shared_inventory"]["directory"])
    assert not (feed / "owner").exists()
    assert not (feed / "inventory-refresh.wait").exists()


def test_campaign_inventory_dead_owner_cancels_paused_startup_and_joins_clean_terminal(tmp_path):
    result, calls, summary, _ = run_consumers(tmp_path, death=True)
    assert result.returncode != 0
    assert summary["status"] == "failed" and summary["finished_at"]
    assert all(job["finished_at"] for job in summary["jobs"])
    for job in summary["jobs"]:
        assert (tmp_path / job["job_id"] / "paused-before-gate").exists()
        assert (tmp_path / job["job_id"] / "closed").exists()
    assert len([call for call in calls if call["kind"] == "machines"]) == 2, calls


def test_campaign_inventory_post_mutation_refresh_keeps_native_generation_and_ordinary_fleet_ownership(tmp_path):
    result, calls, _, _ = run_consumers(tmp_path, refresh=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert len([call for call in calls if call["kind"] == "machines"]) == 3, calls
    ordinary = tmp_path / "ordinary"
    ordinary.mkdir()
    result, calls, summary, _ = run_consumers(ordinary, shared=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "shared_inventory" not in summary
    assert len([call for call in calls if call["kind"] == "machines"]) == 4, calls


def test_campaign_inventory_reuses_existing_fleet_credential_precedence(tmp_path):
    result, _, summary, _ = run_consumers(tmp_path, auth=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert summary["status"] == "passed"


def test_campaign_inventory_keeps_existing_production_only_mode_free_of_shared_fly_feed(tmp_path):
    result, _, summary, _ = run_consumers(tmp_path, production_only=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "shared_inventory" not in summary


# The owning campaign uses the actual seed client against a loopback object store.
# No paid provider, Hub upload, credentials, or guest restore is used by these controls.
def seed_fixture(tmp_path, monkeypatch):
    import importlib.util
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    candidate = Path(os.environ.get("CLOUDBENCH_SEED_CANDIDATE_ROOT_UNDER_TEST", ROOT))
    root = tmp_path / "workspace"
    root.mkdir()
    for relative in (
        "scripts/run-bench-campaign.py",
        "scripts/cloudbench-campaign-seed.py",
        "scripts/cloudbench-seed-get.sh",
    ):
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        origin = (
            Path(os.environ.get("CLOUDBENCH_SEED_CAMPAIGN_UNDER_TEST", candidate / relative))
            if relative == "scripts/run-bench-campaign.py"
            else candidate / relative
        )
        shutil.copyfile(origin, target)
    for relative in (
        "scripts/cloudbench-campaign-barrier.py",
        "scripts/cloudbench-campaign-inventory.sh",
        "scripts/cloudbench-port-lease.py",
        "scripts/cloudbench-machine-readiness.py",
        "scripts/lib/cloudbench-env.sh",
        "scripts/lib/cloudbench-inventory.sh",
        "agents/benchmarks/seed_cache_path.py",
        "back-end/prisma/schema.prisma",
        "back-end/scripts/seed-dump-cache.ts",
        "back-end/package.json",
    ):
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, target)
    (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
    (root / "back-end/node_modules").symlink_to(ROOT / "back-end/node_modules", target_is_directory=True)
    for command in (
        ["git", "init", "-q"],
        ["git", "add", "scripts", "agents", "back-end/prisma", "back-end/scripts", "back-end/package.json"],
        ["git", "-c", "user.name=Local control", "-c", "user.email=control@localhost", "commit", "-qm", "fixture"],
    ):
        subprocess.run(command, cwd=root, check=True, capture_output=True)
    body = b"local-complete-fixture-control\n" * 8192
    calls = []

    class Storage(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append(("GET", self.path))
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_HEAD(self):
            calls.append(("HEAD", self.path))
            self.send_error(500)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Storage)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    for key in list(os.environ):
        if key.startswith(("RUN_BENCH_CAMPAIGN_", "CLOUDBENCH_CAMPAIGN_")):
            monkeypatch.delenv(key)
    for key, value in {
        "R2_ACCOUNT_ID": "offline-fixture-account",
        "R2_ACCESS_KEY_ID": "offline-fixture-key-id",
        "R2_SECRET_ACCESS_KEY": "offline-fixture-secret-only",
        "R2_BUCKET_TRACE_ARCHIVE": "fixture-bucket",
        "R2_ENDPOINT": f"http://127.0.0.1:{server.server_port}",
        "BENCHMARK_HUB_GROUP_RUN_ID": "offline-fixture-no-posts",
        "FLY_BENCH_API_TOKEN": "offline-fixture-token",
        "TZ": "UTC",
        "NO_PROXY": "localhost,127.0.0.1,::1",
        "no_proxy": "localhost,127.0.0.1,::1",
        "PATH": str(Path(sys.executable).parent) + os.pathsep + "/opt/homebrew/bin:" + os.environ["PATH"],
    }.items():
        monkeypatch.setenv(key, value)
    spec = importlib.util.spec_from_file_location("cohort_seed_fixture", root / "scripts/cloudbench-campaign-seed.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return root, module, server, thread, calls, body


def test_campaign_inventory_seed_preflight_without_optional_dotenv(tmp_path, monkeypatch):
    root, module, server, thread, calls, _body = seed_fixture(tmp_path, monkeypatch)
    try:
        (root / "back-end/.env").write_text(
            "# local selector control\nR2_ACCOUNT_ID = 'file-account'\n"
            'R2_BUCKET_TRACE_ARCHIVE="file-bucket"\nR2_ACCESS_KEY_ID=file-key\n'
        )
        for key in ("R2_ACCOUNT_ID", "R2_BUCKET_TRACE_ARCHIVE", "R2_ACCESS_KEY_ID"):
            monkeypatch.delenv(key)
        # -S is the supported system-Python situation: no optional site packages.
        script = (
            "import json,runpy,sys;from pathlib import Path;"
            "m=runpy.run_path(sys.argv[1]);r=Path(sys.argv[2]);"
            "print(json.dumps(m['fixture'](r,r/'scripts')))"
        )
        result = subprocess.run(
            [sys.executable, "-S", "-c", script, str(root / "scripts/cloudbench-campaign-seed.py"), str(root)],
            capture_output=True,
            timeout=60,
        )
        assert result.returncode == 0, "system Python cannot bind the owned canonical fixture"
        expected = {
            "R2_ACCOUNT_ID": "file-account",
            "R2_ENDPOINT": os.environ["R2_ENDPOINT"],
            "R2_BUCKET_TRACE_ARCHIVE": "file-bucket",
            "R2_ACCESS_KEY_ID": "file-key",
        }
        assert json.loads(result.stdout)["selector_sha256"] == module.digest(
            json.dumps(expected, sort_keys=True).encode()
        )
        assert calls == []
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_campaign_inventory_seed_preflight_honors_existing_deadline_before_get(tmp_path, monkeypatch):
    import time

    root, _module, server, thread, calls, _body = seed_fixture(tmp_path, monkeypatch)
    directory = root / "standalone"
    directory.mkdir()
    try:
        result = subprocess.run(
            [
                sys.executable,
                str(root / "scripts/cloudbench-campaign-seed.py"),
                "standalone",
                "--root",
                str(root),
                "--out-dir",
                str(directory),
                "--deadline",
                str(time.time() - 1),
            ],
            capture_output=True,
            timeout=60,
        )
        assert result.returncode != 0, "expired owner budget still performed and accepted a full GET"
        assert calls == [] and not list(directory.glob("seed-probe-*"))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_campaign_inventory_seed_preflight_campaign_cancellation_drains_get(tmp_path, monkeypatch):
    import signal
    import time

    root, _module, server, thread, calls, _body = seed_fixture(tmp_path, monkeypatch)
    process = None
    try:
        binary = root / "bin"
        binary.mkdir()
        fly = binary / "flyctl"
        fly.write_text('#!/usr/bin/env bash\nprintf "[]\\n"\n')
        fly.chmod(0o700)
        monkeypatch.setenv("PATH", str(binary) + os.pathsep + os.environ["PATH"])
        helper = root / "scripts/cloudbench-seed-get.sh"
        helper.write_text('#!/usr/bin/env bash\nexec "' + sys.executable + '" "$1/scripts/blocked-get.py" "$3"\n')
        (root / "scripts/blocked-get.py").write_text(
            "import json,os,subprocess,sys,time\nfrom pathlib import Path\n"
            "root=Path(__file__).parents[1]\n"
            "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(600)'])\n"
            "(root/'get-started.json').write_text(json.dumps({'pid':os.getpid(),'child':child.pid}))\n"
            "try:\n"
            " while not (root/'release-get').exists(): time.sleep(0.1)\n"
            " Path(sys.argv[1]).write_bytes(b'complete-offline-fixture')\n"
            "finally:\n child.terminate();child.wait()\n"
        )
        (root / "scripts/run-bench").write_text('#!/usr/bin/env bash\ntouch "$PWD/unexpected-child"\n')
        command = [
            sys.executable,
            str(root / "scripts/run-bench-campaign.py"),
            "--root",
            str(root),
            "--runs",
            "2",
            "--concurrency",
            "2",
            "--task",
            "local-fixture-control",
            "--forward-arg=--strict-barrier",
        ]
        with (root / "campaign.private.log").open("wb") as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            guard = time.monotonic() + FIXTURE_HOST_GUARD_SECONDS
            while not (root / "get-started.json").exists():
                assert process.poll() is None and time.monotonic() < guard, "blocked owning GET did not start"
                time.sleep(0.1)
            owned = json.loads((root / "get-started.json").read_text())
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=15)
                joined = True
            except subprocess.TimeoutExpired:
                joined = False
            assert joined, "campaign cancellation did not interrupt its owned full GET"
        summary = json.loads(next((root / ".context/benchmarks/campaigns").glob("*/summary.json")).read_text())
        assert process.returncode == 143 and summary["status"] == "cancelled"
        assert not (root / "unexpected-child").exists()
        assert not list(root.glob(".context/benchmarks/campaigns/*/startup-cohorts/*/seed-proof.private.json"))
        assert not list(root.glob(".context/benchmarks/campaigns/*/startup-cohorts/*/seed-probe-*"))
        assert not (Path(summary["shared_inventory"]["directory"]) / "owner").exists()
        for pid in (owned["pid"], owned["child"], summary["shared_inventory"]["publisher_pid"]):
            native = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
            assert not native.stdout.strip() or native.stdout.strip().startswith("Z"), (
                "owned helper retained live resources"
            )
        assert calls == []
    finally:
        (root / "release-get").touch()
        if process is not None and process.poll() is None:
            try:
                process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=60)
        server.shutdown()
        server.server_close()
        thread.join()


def test_campaign_inventory_seed_preflight_exited_get_leader_drains_owned_descendant(tmp_path, monkeypatch):
    import signal
    import time

    root, module, server, thread, calls, _body = seed_fixture(tmp_path, monkeypatch)
    directory = root / "standalone"
    directory.mkdir()
    started = root / "owned-get-child.json"
    (root / "scripts/cloudbench-seed-get.sh").write_text(
        '#!/usr/bin/env bash\nexec "' + sys.executable + '" "$1/scripts/orphan-get.py" "$3"\n'
    )
    (root / "scripts/orphan-get.py").write_text(
        "import json,subprocess,sys\nfrom pathlib import Path\n"
        "root=Path(__file__).parents[1]\n"
        "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(600)'])\n"
        "stamp=' '.join(subprocess.check_output(['ps','-p',str(child.pid),'-o','lstart='],text=True).split())\n"
        "(root/'owned-get-child.json').write_text(json.dumps({'pid':child.pid,'birth':stamp}))\n"
        "Path(sys.argv[1]).write_bytes(b'complete-owned-fixture')\n"
        "# Exit the GET leader while its exact owned descendant is still live.\n"
    )
    try:
        transfer = module.get(root, root / "scripts", {"token": "owned-fixture"}, directory, time.time() + 60)
        owned = json.loads(started.read_text())
        state = subprocess.run(
            ["ps", "-p", str(owned["pid"]), "-o", "stat="], capture_output=True, text=True
        ).stdout.strip()
        assert transfer["exit_code"] == 0 and transfer["bytes"] == len(b"complete-owned-fixture")
        assert not state or state.startswith("Z"), "exited GET leader retained a live owned descendant"
        assert not list(directory.glob("seed-probe-*")) and calls == []
    finally:
        # RED must also release its fixture without signaling a reused PID.
        if started.is_file():
            owned = json.loads(started.read_text())
            if module._identity._process_start_matches(owned["pid"], owned["birth"]):
                try:
                    os.kill(owned["pid"], signal.SIGTERM)
                except ProcessLookupError:
                    pass
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    state = subprocess.run(
                        ["ps", "-p", str(owned["pid"]), "-o", "stat="], capture_output=True, text=True
                    ).stdout.strip()
                    if not state or state.startswith("Z"):
                        break
                    time.sleep(0.05)
        server.shutdown()
        server.server_close()
        thread.join()


def test_campaign_inventory_seed_preflight_late_hash_cancellation_refuses_proof(tmp_path, monkeypatch):
    import hashlib
    import signal
    import time

    import pytest

    root, module, server, thread, calls, _body = seed_fixture(tmp_path, monkeypatch)
    directory = root / "standalone"
    directory.mkdir()
    (root / "scripts/cloudbench-seed-get.sh").write_text('printf complete-owned-fixture > "$3"\n')
    original = hashlib.sha256
    cancelled = []

    class CancelDuringHash:
        def __init__(self):
            self.inner = original()

        def update(self, chunk):
            if not cancelled:
                cancelled.append(True)
                os.kill(os.getpid(), signal.SIGTERM)
            self.inner.update(chunk)

        def hexdigest(self):
            return self.inner.hexdigest()

    try:
        with monkeypatch.context() as patch:
            patch.setattr(module.hashlib, "sha256", CancelDuringHash)
            with pytest.raises(ValueError, match="cancel"):
                module.get(root, root / "scripts", {"token": "owned-fixture"}, directory, time.time() + 60)
        assert cancelled and not list(directory.glob("seed-probe-*"))
        assert not (directory / "seed-proof.private.json").exists() and calls == []
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_campaign_inventory_seed_preflight_full_get_once_for_exact_50_and_standalone(tmp_path, monkeypatch):
    root, module, server, thread, calls, body = seed_fixture(tmp_path, monkeypatch)
    try:
        binary = root / "bin"
        binary.mkdir()
        fly = binary / "flyctl"
        fly.write_text('#!/usr/bin/env bash\nprintf "[]\\n"\n')
        fly.chmod(0o700)
        monkeypatch.setenv("PATH", str(binary) + os.pathsep + os.environ["PATH"])
        cli = root / "scripts/run-bench"
        cli.write_text("""#!/usr/bin/env bash
set -euo pipefail
root="$PWD"
if [ -n "${CLOUDBENCH_CAMPAIGN_SEED_PROOF:-}" ]; then
 python3 "$root/scripts/cloudbench-campaign-seed.py" consume --root "$root" --inventory "$CLOUDBENCH_CAMPAIGN_INVENTORY_DIR" --barrier "$RUN_BENCH_CAMPAIGN_BARRIER_DIR" --proof "$CLOUDBENCH_CAMPAIGN_SEED_PROOF" --job "$RUN_BENCH_CAMPAIGN_JOB_ID" --controller-pid "$$" --deadline "$(python3 -c 'import time;print(time.time()+60)')"
else
 token="$(python3 "$root/agents/benchmarks/seed_cache_path.py" --cache-token --pg-major 15 "$root/back-end/prisma/schema.prisma")"
 probe="$(mktemp)"
 trap 'rm -f "$probe"' EXIT
 bash "$root/scripts/cloudbench-seed-get.sh" "$root" "$token" "$probe"
fi
python3 "$root/scripts/cloudbench-campaign-barrier.py" --controller-pid "$$" --deadline "$(python3 -c 'import time;print(time.time()+60)')"
""")
        command = [
            sys.executable,
            str(root / "scripts/run-bench-campaign.py"),
            "--root",
            str(root),
            "--runs",
            "50",
            "--concurrency",
            "50",
            "--task",
            "local-fixture-control",
            "--forward-arg=--strict-barrier",
        ]
        result = subprocess.run(command, env=dict(os.environ), capture_output=True, timeout=90)
        assert result.returncode == 0, "owning local campaign failed; inspect private test capture"
        summary = json.loads(next((root / ".context/benchmarks/campaigns").glob("*/summary.json")).read_text())
        assert summary["status"] == "passed" and summary["peak_concurrency"] == 50
        assert len(summary["jobs"]) == 50 and all(job["controller_exit_code"] == 0 for job in summary["jobs"])
        feed = Path(summary["shared_inventory"]["directory"])
        assert not (feed / "owner").exists() and not (feed / "inventory-refresh.wait").exists()
        check = subprocess.run(
            ["ps", "-p", str(summary["shared_inventory"]["publisher_pid"]), "-o", "lstart="], capture_output=True
        )
        assert not check.stdout.strip()
        proof = next((root / ".context/benchmarks/campaigns").glob("*/startup-cohorts/*/seed-proof.private.json"), None)
        # This same control deliberately fails RED against the unchanged campaign:
        # every child made a full GET and there was no shared cohort proof.
        assert len(calls) == 1 and calls[0][0] == "GET"
        assert proof is not None
        payload = json.loads(proof.read_text())
        assert payload["get"]["bytes"] == len(body) and payload["get"]["sha256"] == module.digest(body)
        assert len(payload["members"]) == 50 and proof.stat().st_mode & 0o777 == 0o600
        standalone = root / "standalone"
        standalone.mkdir()
        original_read = Path.read_bytes

        def forbid_unbounded_dump_read(path):
            if path.name.startswith("seed-probe-"):
                raise AssertionError("host receipt must hash the completed full GET in bounded chunks")
            return original_read(path)

        monkeypatch.setattr(Path, "read_bytes", forbid_unbounded_dump_read)
        transfer = module.get(root, root / "scripts", module.fixture(root, root / "scripts"), standalone)
        assert transfer["bytes"] == len(body) and len(calls) == 2 and all(call[0] == "GET" for call in calls)
        assert not list(standalone.glob("seed-probe-*"))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_campaign_inventory_seed_preflight_rejects_foreign_owner_member_and_fixture_without_get(tmp_path, monkeypatch):
    import copy
    import fcntl
    import time

    import pytest

    root, module, server, thread, calls, body = seed_fixture(tmp_path, monkeypatch)
    campaign = root / "campaign"
    campaign.mkdir()
    inventory = campaign / "shared-inventory"
    inventory.mkdir()
    barrier = campaign / "startup-cohorts/c001"
    barrier.mkdir(parents=True)
    lock = (barrier.parent / "parent.lock").open("w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    authority = {
        "app": "navi-whisper-lux-bench",
        "pid": str(os.getpid()),
        "pid_start": module.birth(os.getpid()),
        "token": "local-owner-fixture",
        "parent_pid": str(os.getpid()),
        "parent_start": module.birth(os.getpid()),
    }
    (inventory / "owner").write_text("".join(f"{key}={value}\n" for key, value in authority.items()))
    (barrier / "manifest.json").write_text(json.dumps({"cohort_id": "c001", "jobs": {"fixture": os.getpid()}}))
    try:
        proof = module.prepare(root, root / "scripts", inventory, barrier)
        original = json.loads(proof.read_text())
        # A real child can reach preflight between Popen and PID-map publication.
        import threading

        manifest_path = barrier / "manifest.json"
        manifest_path.write_text(json.dumps({"cohort_id": "c001", "jobs": {"fixture": None}}))

        def publish_pid():
            temporary = barrier / ".manifest.delayed-publication"
            temporary.write_text(json.dumps({"cohort_id": "c001", "jobs": {"fixture": os.getpid()}}))
            temporary.replace(manifest_path)

        publisher = threading.Timer(0.3, publish_pid)
        publisher.start()
        try:
            assert module.consume(
                root, root / "scripts", inventory, barrier, proof, "fixture", os.getpid(), time.time() + 10
            )["bytes"] == len(body)
        finally:
            publisher.join()
        manifest_path.write_text(json.dumps({"cohort_id": "c001", "jobs": {"fixture": os.getpid() + 1}}))
        with pytest.raises(ValueError):
            module.consume(root, root / "scripts", inventory, barrier, proof, "fixture", os.getpid(), time.time() + 10)
        publish_pid()
        assert module.consume(
            root, root / "scripts", inventory, barrier, proof, "fixture", os.getpid(), time.time() + 2
        )["bytes"] == len(body)
        for field, key in (
            ("owner", "token"),
            ("owner", "parent_start"),
            ("fixture", "selector_sha256"),
            ("fixture", "source_sha"),
            ("fixture", "schema_sha256"),
            ("fixture", "token"),
        ):
            value = copy.deepcopy(original)
            value[field][key] = "foreign-fixture"
            proof.write_text(json.dumps(value))
            with pytest.raises(ValueError):
                module.consume(
                    root, root / "scripts", inventory, barrier, proof, "fixture", os.getpid(), time.time() + 2
                )
        for name, value in (("members", ["foreign"]), ("cohort_id", "c999")):
            changed = copy.deepcopy(original)
            changed[name] = value
            proof.write_text(json.dumps(changed))
            with pytest.raises(ValueError):
                module.consume(
                    root, root / "scripts", inventory, barrier, proof, "fixture", os.getpid(), time.time() + 2
                )
        proof.write_text(json.dumps(original))
        with pytest.raises(ValueError):
            module.consume(root, root / "scripts", inventory, barrier, proof, "foreign", os.getpid(), time.time() + 2)
        lock.close()
        with pytest.raises(ValueError):
            module.consume(root, root / "scripts", inventory, barrier, proof, "fixture", os.getpid(), time.time() + 2)
        assert len(calls) == 1 and calls[0][0] == "GET"
    finally:
        if not lock.closed:
            lock.close()
        server.shutdown()
        server.server_close()
        thread.join()


def test_campaign_inventory_seed_preflight_failed_proof_publication_never_admits_controller(tmp_path, monkeypatch):
    root, module, server, thread, calls, body = seed_fixture(tmp_path, monkeypatch)
    try:
        binary = root / "bin"
        binary.mkdir()
        fly = binary / "flyctl"
        # Fail only atomic publication after the real complete GET has succeeded.
        fly.write_text("""#!/usr/bin/env bash
mkdir -p "$RUN_BENCH_CAMPAIGN_ROOT/$RUN_BENCH_CAMPAIGN_ID/startup-cohorts/c001/seed-proof.private.json"
printf '[]\n'
""")
        fly.chmod(0o700)
        monkeypatch.setenv("PATH", str(binary) + os.pathsep + os.environ["PATH"])
        monkeypatch.setenv("RUN_BENCH_CAMPAIGN_ID", "local-proof-write-failure")
        monkeypatch.setenv("RUN_BENCH_CAMPAIGN_ROOT", str(root / "campaigns"))
        (root / "scripts/run-bench").write_text('#!/usr/bin/env bash\ntouch "$PWD/unexpected-child"\nexit 0\n')
        result = subprocess.run(
            [
                sys.executable,
                str(root / "scripts/run-bench-campaign.py"),
                "--root",
                str(root),
                "--runs",
                "50",
                "--concurrency",
                "50",
                "--task",
                "local-fixture-control",
                "--forward-arg=--strict-barrier",
            ],
            env=dict(os.environ),
            capture_output=True,
            timeout=30,
        )
        summary = json.loads((root / "campaigns/local-proof-write-failure/summary.json").read_text())
        assert result.returncode == 1 and summary["status"] == "failed" and summary["finished_at"]
        assert summary["peak_concurrency"] == 0 and not (root / "unexpected-child").exists()
        assert len(summary["jobs"]) == 50 and all(job["controller_exit_code"] is None for job in summary["jobs"])
        assert summary["startup_cohorts"][0]["status"] == "aborted"
        feed = Path(summary["shared_inventory"]["directory"])
        assert not (feed / "owner").exists()
        check = subprocess.run(
            ["ps", "-p", str(summary["shared_inventory"]["publisher_pid"]), "-o", "lstart="], capture_output=True
        )
        assert not check.stdout.strip()
        assert len(calls) == 1 and calls[0][0] == "GET"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_campaign_inventory_seed_preflight_native_linux_owner_tick_and_legacy_formats(tmp_path):
    if not Path("/proc/self/stat").exists():
        import pytest

        pytest.skip("native Linux owner identity is verified in the existing offline Linux image")
    import fcntl
    import importlib.util

    candidate = Path(os.environ.get("CLOUDBENCH_SEED_CANDIDATE_ROOT_UNDER_TEST", ROOT))
    spec = importlib.util.spec_from_file_location(
        "native_cohort_seed", candidate / "scripts/cloudbench-campaign-seed.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    inventory = tmp_path / "shared-inventory"
    inventory.mkdir()
    barrier = tmp_path / "startup-cohorts/c001"
    barrier.mkdir(parents=True)
    lock = (barrier.parent / "parent.lock").open("w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    native = subprocess.check_output(
        [
            "bash",
            "-c",
            'FLEET_DIR="$1"; source "$2"; source "$3"; inventory_pid_start_time "$4"',
            "native-seed-owner",
            str(inventory),
            str(ROOT / "scripts/lib/cloudbench-env.sh"),
            str(ROOT / "scripts/lib/cloudbench-inventory.sh"),
            str(os.getpid()),
        ],
        text=True,
    ).strip()
    assert native.startswith("proc-start:")
    authority = {
        "app": "navi-whisper-lux-bench",
        "pid": str(os.getpid()),
        "pid_start": native,
        "token": "offline-native-owner",
        "parent_pid": str(os.getpid()),
        "parent_start": native,
    }

    def publish():
        (inventory / "owner").write_text("".join(f"{key}={value}\n" for key, value in authority.items()))

    try:
        publish()
        assert module.owner(inventory, barrier) == authority
        for field in ("pid_start", "parent_start"):
            prefix, tick = native.rsplit(":", 1)
            authority[field] = prefix + ":" + str(int(tick) + 1)
            publish()
            try:
                module.owner(inventory, barrier)
            except ValueError:
                pass
            else:
                raise AssertionError("foreign native start tick was accepted")
            authority[field] = native
        legacy = subprocess.check_output(["ps", "-p", str(os.getpid()), "-o", "lstart="], text=True).strip()
        authority.update(pid_start=legacy, parent_start=legacy)
        publish()
        assert module.owner(inventory, barrier) == authority
    finally:
        lock.close()


def test_campaign_inventory_seed_preflight_preserves_parent_toolchain_path_for_both_paths(tmp_path):
    candidate = Path(os.environ.get("CLOUDBENCH_SEED_CANDIDATE_ROOT_UNDER_TEST", ROOT))
    fleet = Path(
        os.environ.get("CLOUDBENCH_SEED_FLEET_SCRIPT_UNDER_TEST", candidate / "scripts/run-bench-fleet")
    ).read_text()
    anchor = "# Detached fleet controllers can inherit a stripped PATH"
    assert anchor in fleet, "canonical preflight must retain the original parent PATH resolution"
    start = fleet.index(anchor, fleet.index('CLOUDBENCH_GUEST_PG_MAJOR="${'))
    end = fleet.index('if [ -n "${CLOUDBENCH_CAMPAIGN_SEED_PROOF:-}" ]; then', start)
    stanza = fleet[start:end]
    binary = tmp_path / "node_modules/.bin"
    binary.mkdir(parents=True)
    for name in ("node", "npx"):
        path = binary / name
        path.write_text("#!/bin/sh\nexit 0\n")
        path.chmod(0o700)
    command = (
        'set -eu\nROOT_DIR="$1"\nexport PATH=/usr/bin:/bin\n'
        + stanza
        + '\ncommand -v npx >/dev/null\ncommand -v node >/dev/null\nnode -e "process.exit(0)"\n'
    )
    for proof in ("", "advertised-owned-proof"):
        environment = dict(os.environ, CLOUDBENCH_CAMPAIGN_SEED_PROOF=proof)
        result = subprocess.run(
            ["bash", "-c", command, "seed-parent-path", str(tmp_path)], env=environment, capture_output=True, timeout=10
        )
        assert result.returncode == 0, "resolved Node/npm PATH did not survive in fleet parent"


def test_campaign_inventory_seed_preflight_normalizes_guest_pg_default_before_consume(tmp_path, monkeypatch):
    import fcntl
    import importlib.util
    import time

    root, module, server, thread, calls, body = seed_fixture(tmp_path, monkeypatch)
    campaign = root / "campaign"
    inventory = campaign / "shared-inventory"
    inventory.mkdir(parents=True)
    barrier = campaign / "startup-cohorts/c001"
    barrier.mkdir(parents=True)
    lock = (barrier.parent / "parent.lock").open("w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    authority = {
        "app": "navi-whisper-lux-bench",
        "pid": str(os.getpid()),
        "pid_start": module.birth(os.getpid()),
        "token": "local-pg-default-owner",
        "parent_pid": str(os.getpid()),
        "parent_start": module.birth(os.getpid()),
    }
    (inventory / "owner").write_text("".join(f"{key}={value}\n" for key, value in authority.items()))
    (barrier / "manifest.json").write_text(json.dumps({"cohort_id": "c001", "jobs": {"fixture": os.getpid()}}))
    normalize = next(
        line
        for line in (ROOT / "scripts/run-bench-fleet").read_text().splitlines()
        if line.startswith('CLOUDBENCH_GUEST_PG_MAJOR="${')
    )
    spec = importlib.util.spec_from_file_location("native_seed_token", root / "agents/benchmarks/seed_cache_path.py")
    seed = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(seed)
    try:
        for configured in (None, "", "15", "16"):
            if configured is None:
                monkeypatch.delenv("CLOUDBENCH_GUEST_PG_MAJOR", raising=False)
            else:
                monkeypatch.setenv("CLOUDBENCH_GUEST_PG_MAJOR", configured)
            proof = module.prepare(root, root / "scripts", inventory, barrier)
            fleet_pg = subprocess.check_output(
                [
                    "bash",
                    "-c",
                    normalize + '\nprintf "%s" "$CLOUDBENCH_GUEST_PG_MAJOR"',
                ],
                text=True,
            )
            payload = json.loads(proof.read_text())
            assert payload["fixture"]["pg_major"] == fleet_pg, "parent proof disagrees with fleet PG-major default"
            assert payload["fixture"]["token"] == seed.seed_cache_token(
                root / "back-end/prisma/schema.prisma", fleet_pg
            )
            monkeypatch.setenv("CLOUDBENCH_GUEST_PG_MAJOR", fleet_pg)
            assert module.consume(
                root,
                root / "scripts",
                inventory,
                barrier,
                proof,
                "fixture",
                os.getpid(),
                time.time() + 10,
            )["bytes"] == len(body)
        assert len(calls) == 4 and all(method == "GET" for method, _ in calls)
    finally:
        lock.close()
        server.shutdown()
        server.server_close()
        thread.join()
