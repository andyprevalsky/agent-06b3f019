"""The explicit replay probe must stay separate from live benchmark proof."""

import json
import os
import subprocess
from pathlib import Path

import pytest

from benchmarks.fixture_host_guard import FIXTURE_HOST_GUARD_SECONDS
from benchmarks.hub_upload_test import _serve


def _serve_machines():
    """Loopback Machines API: the parent publisher's direct HTTP list read."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Machines(BaseHTTPRequestHandler):
        def do_GET(self):
            if not (self.path.startswith("/v1/apps/") and self.path.endswith("/machines")):
                self.send_error(404)
                return
            body = b"[]"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Machines)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"

ROOT = Path(__file__).resolve().parents[2]
READ_ONLY = "FAST_MODE_CACHE_DISABLE_WRITE_THROUGH"
PROBE = "BENCHMARK_DEMO_CACHE_READ_ONLY"
TRANSPORT = "CLOUDBENCH_FAST_CACHE_READ_ONLY"


def launch_probe(tmp_path: Path, *arguments: str):
    receipt = tmp_path / "launch.json"
    fleet = tmp_path / "fleet.sh"
    fleet.write_text(
        "#!/usr/bin/env bash\n"
        "python3 - \"$@\" <<'PY'\n"
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "Path(os.environ['DEMO_CACHE_TEST_RECEIPT']).write_text(json.dumps({\n"
        " 'args': sys.argv[1:],\n"
        " 'read_only': os.environ.get('FAST_MODE_CACHE_DISABLE_WRITE_THROUGH'),\n"
        " 'probe': os.environ.get('BENCHMARK_DEMO_CACHE_READ_ONLY'),\n"
        " 'provider_fast_mode': os.environ.get('BENCHMARK_FAST_MODE_CACHE'),\n"
        "}))\n"
        "PY\n"
    )
    # The real campaign owns inventory and publication before its fake fleets
    # launch. Supply those external collaborators rather than borrow host
    # credentials or disable the production admission and cleanup paths.
    binary = tmp_path / "bin"
    binary.mkdir()
    fly = binary / "flyctl"
    fly.write_text(
        "#!/usr/bin/env bash\n"
        'case "$1 $2" in\n'
        ' "machines list"|"volumes list") printf \'[]\\n\' ;;\n'
        " *) exit 91 ;;\n"
        "esac\n"
    )
    fly.chmod(0o700)
    server, hub_url = _serve([])
    machines_server, machines_url = _serve_machines()
    env = dict(os.environ)
    env.pop("FAST_MODE_CACHE_DISABLE_WRITE_THROUGH", None)
    env.pop("BENCHMARK_FAST_MODE_CACHE", None)
    env.pop(PROBE, None)
    env.pop(TRANSPORT, None)
    env.pop("BENCHMARK_HUB_GROUP_RUN_ID", None)
    env.pop("BENCHMARK_HUB_PARENT_RUN_ID", None)
    env.update(
        {
            "DEMO_CACHE_TEST_RECEIPT": str(receipt),
            "RUN_BENCH_FLEET_BIN_UNDER_TEST": str(fleet),
            "RUN_BENCH_CAMPAIGN_ROOT": str(tmp_path / "campaigns"),
            "PATH": str(binary) + os.pathsep + env["PATH"],
            "FLY_BENCH_API_TOKEN": "offline-demo-fixture-token-only",
            "BENCHMARK_HUB_UPLOAD_URL": hub_url,
            "BENCHMARK_HUB_API_KEY": "offline-demo-fixture-key",
            "BACKEND_API_KEY": "offline-demo-fixture-key",
            "CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY": "1",
            "FLY_FLAPS_BASE_URL": machines_url,
            # The shared Fly relay has its own offline owning control.
            "CLOUDBENCH_CAMPAIGN_SHARED_RELAY": "0",
        }
    )
    try:
        result = subprocess.run(
            ["bash", str(ROOT / "scripts/run-bench"), *arguments],
            env=env,
            capture_output=True,
            text=True,
            timeout=FIXTURE_HOST_GUARD_SECONDS,
        )
    finally:
        server.shutdown()
        server.server_close()
        machines_server.shutdown()
        machines_server.server_close()
    return result, json.loads(receipt.read_text()) if receipt.exists() else None


def test_demo_cache_probe_preserves_tasks_and_sets_command_scoped_readonly(tmp_path):
    names = ["demo-fleet-alpha", "demo-fleet-beta", "demo-fleet-gamma"]
    result, receipt = launch_probe(tmp_path, *names, "--demo-cache", "--timeout", "300")
    assert result.returncode == 0, result.stdout + result.stderr
    assert receipt == {
        "args": [*names, "--timeout", "300"],
        "read_only": "1",
        "probe": "1",
        "provider_fast_mode": None,
    }
    assert "zero LIVE proof credit" in result.stdout


def test_demo_cache_probe_existing_mass_replay_keeps_declared_judge(tmp_path):
    result, receipt = launch_probe(tmp_path, "test-mass-agent-run-0", "--demo-cache", "--timeout", "300")
    assert result.returncode == 0, result.stdout + result.stderr
    assert receipt == {
        "args": ["test-mass-agent-run-0", "--timeout", "300"],
        "read_only": "1",
        "probe": "1",
        "provider_fast_mode": None,
    }
    assert "declared LLM judges may make provider calls" in result.stdout
    assert "zero LIVE proof credit" in result.stdout


@pytest.mark.parametrize(
    "arguments",
    [
        ["spawn-sub-agents", "--demo-cache"],
        ["single-creator-arm", "--demo-cache"],
        ["demo-fleet-alpha", "--demo-cache", "--skip-autoscaler"],
        ["demo-fleet-alpha", "--demo-cache", "--sim-on", "demo-fleet-alpha"],
        ["--provision-pool", "50", "--demo-cache"],
    ],
)
def test_demo_cache_probe_rejects_uncovered_spend_or_runtime_before_launch(tmp_path, arguments):
    result, receipt = launch_probe(tmp_path, *arguments)
    assert result.returncode == 2, result.stdout + result.stderr
    assert "--demo-cache" in result.stderr
    assert receipt is None


def test_demo_cache_probe_leaves_ordinary_launch_unchanged(tmp_path):
    result, receipt = launch_probe(tmp_path, "spawn-sub-agents", "--timeout", "300")
    assert result.returncode == 0, result.stdout + result.stderr
    assert receipt == {
        "args": ["spawn-sub-agents", "--timeout", "300"],
        "read_only": None,
        "probe": None,
        "provider_fast_mode": None,
    }


def shell_json(code: str, env: dict[str, str]) -> dict:
    result = subprocess.run(
        ["bash", "-c", code],
        env={"PATH": os.environ["PATH"], **env},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout)


@pytest.mark.parametrize("read_only", ["1", None])
def test_demo_cache_probe_handoff_is_ephemeral_and_reaches_stack(read_only):
    cloud = (ROOT / "scripts/run-bench-cloud").read_text()
    boot_args = cloud[cloud.index("    _envargs=(") : cloud.index("    _pool_shape_args=()")]
    environment = {PROBE: read_only} if read_only is not None else {}
    fields = shell_json(
        boot_args
        + "\npython3 - \"${_envargs[@]}\" <<'PY'\n"
        + "import json,sys\n"
        + "args=sys.argv[1:]; fields=dict(args[i+1].split('=',1) for i in range(0,len(args),2))\n"
        + "print(json.dumps({k:v for k,v in fields.items() if k in "
        + repr([READ_ONLY, TRANSPORT])
        + "}))\nPY\n",
        environment,
    )
    assert fields == {TRANSPORT: read_only or ""}
    # The next ordinary boot explicitly clears the transport slot; the actual
    # write guard never becomes persistent Machine configuration.
    driver = (ROOT / "scripts/cloudbench-run.sh").read_text()
    inputs = driver[
        driver.index('BENCHMARK_FAST_MODE_CACHE="') : driver.index('BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS="')
    ]
    stack_env = driver[
        driver.index("STACK_ENV=(") : driver.index('if [ -n "$BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY" ]; then')
    ]
    received = shell_json(
        inputs
        + "\n"
        + stack_env
        + "\npython3 - \"${STACK_ENV[@]}\" <<'PY'\n"
        + "import json,os,sys\n"
        + "fields=dict(arg.split('=',1) for arg in sys.argv[1:])\n"
        + f"print(json.dumps({{'driver':os.environ.get('{READ_ONLY}'),'stack':fields.get('{READ_ONLY}'),"
        + f"'driver_probe':os.environ.get('{PROBE}'),'stack_probe':fields.get('{PROBE}')}}))\n"
        + "PY\n",
        fields,
    )
    assert received == {
        "driver": read_only,
        "stack": read_only,
        "driver_probe": read_only,
        "stack_probe": read_only,
    }


@pytest.mark.parametrize("probe,inherited_transport", [("1", None), (None, "1"), (None, None)])
def test_demo_cache_probe_legacy_wrapper_preserves_process_scoped_guard(probe, inherited_transport):
    cloud = (ROOT / "scripts/run-bench-cloud").read_text()
    start = cloud.index('    if [ "${BENCHMARK_DEMO_CACHE_READ_ONLY:-}" = 1 ]; then')
    export = cloud[start : cloud.index("    fi", start) + len("    fi")]
    driver = (ROOT / "scripts/cloudbench-run.sh").read_text()
    start = driver.index('if [ "${CLOUDBENCH_FAST_CACHE_READ_ONLY:-}" = 1 ]; then')
    consumer = driver[start : driver.index("\nfi", start) + len("\nfi")]
    inherited = f"export {TRANSPORT}=1" if inherited_transport else f"unset {TRANSPORT}"
    received = shell_json(
        "exports=$(\n"
        + export
        + "\n)\n"
        + f"unset {PROBE}\n"
        + inherited
        + "\n"
        + 'eval "$exports"\n'
        + consumer
        + "\npython3 - <<'PY'\nimport json,os\n"
        + f"print(json.dumps({{k:os.environ.get(k) for k in {repr([TRANSPORT, READ_ONLY, PROBE])}}}))\nPY",
        {PROBE: probe} if probe is not None else {},
    )
    assert received == {TRANSPORT: probe, READ_ONLY: probe, PROBE: probe}


def test_demo_cache_probe_rejects_demo_tag_without_runtime_replay_admission(tmp_path):
    catalog = tmp_path / "tasks.json"
    tasks = json.loads((ROOT / "agents/benchmarks/tasks.json").read_text())
    task = next(task for task in tasks if task["name"] == "demo-fleet-alpha")
    task["prompt"] = "A new uncached prompt outside the existing DEMO replay policy"
    catalog.write_text(json.dumps(tasks))
    (tmp_path / "polar_tasks.json").write_bytes((ROOT / "agents/benchmarks/polar_tasks.json").read_bytes())
    result = subprocess.run(
        [
            str(ROOT / "agents/venv/bin/python"),
            str(ROOT / "scripts/cloudbench-demo-cache.py"),
            str(catalog),
            "demo-fleet-alpha",
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 2, result.stdout + result.stderr
    assert "existing DEMO replay policy" in result.stderr


@pytest.mark.parametrize("probe", ["1", None])
def test_demo_cache_probe_task_guard_keeps_harness_judges_unchanged(probe):
    driver = (ROOT / "scripts/cloudbench-run.sh").read_text()
    start = driver.index("BENCH_HARNESS_ENV=()")
    end = driver.index('log "running benchmark:', start)
    harness_env = driver[start:end]
    received = shell_json(
        harness_env
        + "\nenv \"${BENCH_HARNESS_ENV[@]}\" python3 - <<'PY'\n"
        + "import json,os\n"
        + f"print(json.dumps({{k:os.environ.get(k) for k in {repr([PROBE, READ_ONLY, TRANSPORT])}}}))\nPY",
        {READ_ONLY: "1", **({PROBE: probe, TRANSPORT: probe} if probe is not None else {})},
    )
    assert received == {
        PROBE: None,
        READ_ONLY: None if probe is not None else "1",
        TRANSPORT: None,
    }
    assert 'run_with_heartbeat "benchmark" gosu "$APP_USER" env "${BENCH_HARNESS_ENV[@]}"' in driver


def test_demo_cache_probe_repeated_copies_keep_guard_and_existing_topology(tmp_path):
    result, receipt = launch_probe(tmp_path, "demo-fleet-alpha", "--demo-cache", "-k", "2", "--concurrency", "2")
    assert result.returncode == 0, result.stdout + result.stderr
    assert receipt["read_only"] == "1"
    summaries = list((tmp_path / "campaigns").glob("*/summary.json"))
    assert len(summaries) == 1
    summary = json.loads(summaries[0].read_text())
    assert summary["total_jobs"] == 2
    assert summary["peak_concurrency"] == 2
    assert not summary.get("shared_inventory_failed")
    assert not (Path(summary["shared_inventory"]["directory"]) / "owner").exists()
    assert [job["task"] for job in summary["jobs"]] == ["demo-fleet-alpha"] * 2
    for job in summary["jobs"]:
        assert job["controller_exit_code"] == 0
        assert "zero LIVE proof credit" in Path(job["log"]).read_text()


@pytest.mark.parametrize("probe", ["1", None])
def test_demo_cache_probe_worker_only_process_retains_spend_fence(probe):
    fleet = (ROOT / "scripts/run-bench-fleet").read_text()
    worker = fleet[
        fleet.index("    local wrapper worker_env;") : fleet.index(
            '    } > "$wrapper"', fleet.index("    local wrapper worker_env;")
        )
    ]
    start = worker.index('        if [ "${BENCHMARK_DEMO_CACHE_READ_ONLY:-}" = 1 ]; then')
    export = worker[start : worker.index("        fi", start) + len("        fi")]
    received = shell_json(
        "exports=$(\n"
        + export
        + "\n)\n"
        + f"unset {PROBE}\n"
        + 'eval "$exports"\n'
        + "python3 - <<'PY'\nimport json,os\n"
        + f"print(json.dumps({{k:os.environ.get(k) for k in {repr([PROBE, READ_ONLY, 'BENCHMARK_ISOLATED_RUN'])}}}))\nPY",
        {PROBE: probe} if probe is not None else {},
    )
    assert received == {
        PROBE: probe,
        READ_ONLY: probe,
        "BENCHMARK_ISOLATED_RUN": "true" if probe is not None else None,
    }
