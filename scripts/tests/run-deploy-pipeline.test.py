#!/usr/bin/env python3
"""Regression for scripts/run_deploy_pipeline.py (Group 3 + Group 4 driver).

Real run-deploy-stage lanes under a temporary timing run prove: lanes start
concurrently, ``after`` dependencies wait, ``wait`` wakes on the first failure
while siblings keep running, the next run admits that failed lane first, and a
source change after the freeze turns an all-green run into ``stale``.

Host admission (2026-10-28, PR #1627): twelve lanes with 28 workers started at
once on an 8-core/16 GB devbox (load1 39.8, MemAvailable 906 MB, the memory
watchdog TERMed node/postgres) and three structural subprocess timeouts fired
that pass in isolation. ``plan`` therefore scales deploy.md's 14-core worker
budgets to the host, ``run`` caps concurrent lanes and admits them against a
declared-memory budget, refusing a lane that can never fit. ``wait`` requires
``--since`` so a previous iteration's receipt can never be reported, and it
reports lanes that failed before any stage row existed instead of hanging.
Live admission (2026-10-30, #1640): a phased lane is charged only the running
lanes' unmaterialized declarations against live headroom (their usage is
already in MemAvailable); unphased and unobserved lanes keep the declared sum.
"""

from __future__ import annotations

import ast
import importlib.util
import inspect
import io
import json
import math
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import ExitStack, contextmanager, redirect_stdout
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
DRIVER = ROOT / "scripts" / "run_deploy_pipeline.py"
# What the stack lanes execute (pinned against run_deploy_stage.STACK_ENTRYPOINTS
# in check_scoped_inert_tables; the fixture repo materializes each one).
STACK_ENTRYPOINTS = (
    "scripts/run-predeploy-local", "scripts/run-bench", "scripts/run.sh", "scripts/lib/seed-cache.sh",
    "scripts/restore-seed-dump.sh", "scripts/save-seed-dump.sh", "scripts/validate-canonical-seed-dump.sh",
    "back-end/src/bootstrap.ts", "back-end/scripts/seed-local.ts", "back-end/scripts/seed-dump-cache.ts",
    "back-end/scripts/ensure-fast-mode-cache-schema.ts", "back-end/scripts/ensure-agent-network-grep-indexes.ts",
    "back-end/scripts/generate-test-session.ts", "agents/worker.py", "agents/benchmarks/run_benchmark.py",
    "front-end/src/main.tsx", "front-end/scripts/run-semantic-tests.sh",
)
STRUCTURAL_RUNNER = ROOT / "scripts" / "run-deploy-structural-gates.py"
# Generic scenarios must not depend on this host's free memory or core count.
UNBOUNDED = ["--max-parallel", "0", "--memory-budget-mb", "1048576"]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module  # dataclasses resolve postponed annotations via sys.modules
    sys.path.insert(0, str(path.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(path.parent))
    return module


def start_timing(run_root: Path, env: dict[str, str], cwd: Path | None = None) -> None:
    """Start a timing run; its metadata records the branch and head of ``cwd``
    (the real checkout unless a scenario binds the run to its fixture repo)."""
    subprocess.run(
        ["bash", str(DRIVER.parent / "run-deploy-stage"), "--start"],
        cwd=ROOT if cwd is None else cwd, env=env, check=True, stdout=subprocess.DEVNULL,
    )


def finish_timing(env: dict[str, str]) -> str:
    """Close the active timing run and return its id."""
    run_root = Path(env["DEPLOY_RUN_ROOT"])
    run_id = (run_root / "current").read_text().splitlines()[0].strip()
    subprocess.run(
        ["bash", str(DRIVER.parent / "run-deploy-stage"), "--finish"],
        cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL,
    )
    return run_id


def write_plan(path: Path, lanes: list[dict], **extra: object) -> None:
    # Tiny sleep/true fixture commands have explicit synthetic reservations;
    # production's 1 GiB default is not their measured footprint.
    path.write_text(json.dumps({"lanes": [{"memory_mb": 1, **lane} for lane in lanes], **extra}))


# Scenarios run with UNBOUNDED own their host sample as well: live MemAvailable
# below the driver's 2 GiB reserve (a deploy's concurrent gates on a 15 GB box,
# or the memory watchdog's own margin) leaves a 0 MB live budget that refuses
# even a 1 MB lane, which is host load, not the behaviour under test.
ROOMY_HOST = {"cpus": os.cpu_count() or 1, "mem_available_mb": 2 * 1048576}


def driver_argv(*args: str, host: dict | None = None) -> list[str]:
    """The driver CLI argv; a ``run`` with the UNBOUNDED budget gets ROOMY_HOST
    unless the scenario supplies its own host sample."""
    unbounded = args[:1] == ("run",) and any(
        list(args[i:i + len(UNBOUNDED)]) == UNBOUNDED for i in range(len(args)))
    if host is None and unbounded:
        host = ROOMY_HOST
    if host is None:
        return [sys.executable, str(DRIVER), *args]
    # Synthetic admission cases own both their reservations and host sample;
    # keep the real CLI/process path and its caller-provided timeout.
    bootstrap = (
        "import importlib.util,json,sys; from pathlib import Path; "
        "sys.path.insert(0,str(Path(sys.argv[1]).parent)); "
        "spec=importlib.util.spec_from_file_location('fixture_pipeline',sys.argv[1]); "
        "module=importlib.util.module_from_spec(spec); sys.modules[spec.name]=module; "
        "spec.loader.exec_module(module); "
        "module.host_resources=lambda:json.loads(sys.argv[2]); "
        "raise SystemExit(module.main(sys.argv[3:]))"
    )
    return [sys.executable, "-c", bootstrap, str(DRIVER), json.dumps(host), *args]


def run_driver(*args: str, env: dict[str, str], host: dict | None = None, **kwargs) -> subprocess.CompletedProcess:
    command = driver_argv(*args, host=host)
    return subprocess.run(
        command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, **kwargs,
    )


def plan_json(*args: str) -> dict:
    return json.loads(run_driver("plan", *args, env=dict(os.environ), check=True).stdout)


def check_plan_scaling() -> None:
    pipeline = load_module("run_deploy_pipeline_under_test", DRIVER)
    runner = load_module("run_deploy_structural_gates_under_test", STRUCTURAL_RUNNER)
    ceiling = plan_json("--group", "3", "--backend", "--frontend", "--agents", "--host-cpus", "14",
                        "--host-mem-mb", "32768")
    assert ceiling["workers"] == {"backend_blackbox": 4, "backend_unit": 6, "frontend": 4, "agents": 6,
                                  "structural": 8}, ceiling["workers"]
    assert ceiling["max_parallel"] == 7 and ceiling["memory_budget_mb"] == 27443, ceiling
    bigger = plan_json("--group", "3", "--backend", "--frontend", "--agents", "--host-cpus", "32",
                       "--host-mem-mb", "131072")
    assert bigger["workers"] == ceiling["workers"], "deploy.md values are a ceiling, never exceeded"
    assert bigger["max_parallel"] == 7, bigger["max_parallel"]
    devbox = plan_json("--group", "3", "--backend", "--frontend", "--agents", "--host-cpus", "8",
                       "--host-mem-mb", "11000", "--host-total-mem-mb", "16384",
                       "--host-watchdog-mb", "14472", "--backend-unit-workers", "3", "--agents-workers", "4")
    # Phased schedule (default): the structural lane runs alone, so its width is
    # every core the whole 7040 MB budget backs at the per-worker floor (3),
    # not the shared host_scale share (2) the legacy all-at-once plan keeps.
    assert devbox["workers"] == {"backend_blackbox": 1, "backend_unit": 1, "frontend": 1, "agents": 1,
                                 "structural": 3}, devbox["workers"]
    assert devbox["max_parallel"] == 4 and devbox["memory_budget_mb"] == 7040, devbox
    assert devbox["schedule"]["policy"] == "phased" and devbox["schedule"]["phases"], devbox["schedule"]
    legacy = plan_json("--group", "3", "--backend", "--frontend", "--agents", "--host-cpus", "8",
                       "--host-mem-mb", "11000", "--host-total-mem-mb", "16384",
                       "--host-watchdog-mb", "14472", "--schedule", "legacy")
    assert legacy["workers"]["structural"] == 2 and legacy["schedule"] == {"policy": "legacy", "phases": [],
                                                                            "estimates": legacy["schedule"]["estimates"]}
    legacy_structural = next(lane for lane in legacy["lanes"] if lane["name"] == "deploy-command-structural")
    assert legacy_structural["command"][-2:] == ["--max-workers", "2"] and not legacy_structural["exclusive"]
    lanes = {lane["name"]: lane for lane in devbox["lanes"]}
    backend = lanes["backend-coverage-blackbox"]
    assert backend["env"]["BLACKBOX_TEST_CONCURRENCY"] == "1" and backend["env"]["BACKEND_UNIT_CONCURRENCY"] == "1"
    assert backend["command"] == ["npm", "run", "test:coverage:sharded"], backend
    assert backend["retry_env"] == {"BACKEND_COVERAGE_FAILED_FIRST": "1"}, backend
    assert lanes["frontend-coverage-blackbox"]["command"][-1] == "--maxWorkers=1"
    assert lanes["agents-coverage-blackbox"]["env"] == {"AGENTS_COVERAGE_CONCURRENCY": "1"}
    assert all(int(lane["memory_mb"]) > 0 for lane in devbox["lanes"]), "every lane declares memory_mb"
    assert lanes["backend-coverage-blackbox"]["memory_mb"] > lanes["seed-cache-decision"]["memory_mb"]
    tiny = plan_json("--group", "3", "--backend", "--host-cpus", "1", "--host-mem-mb", "1024")
    assert all(value >= 1 for value in tiny["workers"].values()) and tiny["max_parallel"] == 1, tiny
    # The actual structural command uses its exclusive-phase, budget-backed width.
    assert lanes["deploy-command-structural"]["command"][-2:] == ["--max-workers", "3"]
    assert lanes["deploy-command-structural"]["exclusive"] is True
    assert lanes["deploy-command-structural"]["memory_mb"] == pipeline.structural_lane_memory_mb(3) == 3220 \
        <= devbox["memory_budget_mb"]
    assert [runner.default_max_workers(c) for c in (1, 2, 4, 8, 14, 32)] == [1, 1, 2, 4, 8, 8]
    assert runner.default_max_workers() <= runner.DEFAULT_MAX_WORKERS
    assert pipeline.scale_workers(1, {"cpus": 2, "mem_available_mb": 4096}) == 1
    live = plan_json("--group", "3")
    assert live["host"]["cpus"] == (os.cpu_count() or 1) and live["host"]["mem_available_mb"] is not None
    print("plan scaling: ok")


def check_structural_memory_floor() -> None:
    """The lane's width is still sized by the 1471.98 MiB largest-child floor
    (20261028-174430 stage receipt) so no active suite is starved, but its
    reservation is the recorded whole-tree peak with a 1.25x margin: 19 passed
    attempts (2026-10-30/31 devbox deploys) peaked at 2427.8-2575.4 MB at three
    workers while 1024 + 1840 * 3 = 6544 MB was declared, which held the 4096
    MB smoke lane behind it for ~9 min per round on a ~8 GB budget."""
    pipeline = load_module("run_deploy_pipeline_floor", DRIVER)
    for cpus, available, expected_workers in ((1, 8000, 1), (8, 11000, 3), (14, 32768, 8)):
        plan = plan_json("--group", "3", "--host-cpus", str(cpus),
                         "--host-mem-mb", str(available))
        workers = plan["workers"]["structural"]
        assert workers == expected_workers, plan
        lane = next(lane for lane in plan["lanes"] if lane["name"] == "deploy-command-structural")
        assert lane["memory_mb"] == pipeline.structural_lane_memory_mb(workers), (workers, lane["memory_mb"])
        assert lane["memory_mb"] >= 1.25 * 2575.4 * workers / 3, "recorded tree peak scaled to the width"
        assert lane["memory_mb"] >= 1.25 * 1471.98, "never below one suite's recorded child peak"
    assert pipeline.structural_lane_memory_mb(3) == 3220 < 1024 + 1840 * 3, "right-sized from 6544 MB"
    assert pipeline.structural_lane_memory_mb(1) == 1840, "one worker keeps the per-suite floor"
    assert [pipeline.structural_workers_within(mb, 3) for mb in (7979, 3220, 3219, 1840, 1839)] == [3, 3, 2, 1, 0]
    print("structural reservations cover the recorded tree peak: ok")


def check_macos_memory(tmp: Path, env: dict[str, str]) -> None:
    """No-/proc host samples still govern real admission; not physical RAM alone."""
    pipeline = load_module("pipeline_macos_memory", DRIVER)
    real_read = Path.read_text
    page_size = 16384
    pressure = False
    calls = []
    def read(path, *args, **kwargs):
        if str(path).startswith("/proc/"):
            raise FileNotFoundError("macOS has no /proc")
        return real_read(path, *args, **kwargs)
    def output(command, **kwargs):
        calls.append(command)
        if command == ["/usr/sbin/sysctl", "-n", "hw.memsize"]:
            return "34359738368\n"
        assert command == ["/usr/bin/vm_stat"], command
        free, inactive, speculative = (0, 0, 0) if pressure else (262144, 524288, 65536)
        return (f"Mach Virtual Memory Statistics: (page size of {page_size} bytes)\n"
                f"Pages free: {free}.\nPages inactive: {inactive}.\n"
                f"Pages speculative: {speculative}.\nPages active: 999999.\n"
                "Pages purgeable: 999999.\nFile-backed pages: 999999.\n"
                "Pages occupied by compressor: 999999.\n")
    plan = tmp / "macos-plan.json"
    write_plan(plan, [{"name": "macos", "command": ["true"], "reuse_passed": False}])
    with patch.object(pipeline.sys, "platform", "darwin"), \
         patch.object(Path, "read_text", autospec=True, side_effect=read), \
         patch.object(pipeline.subprocess, "check_output", side_effect=output), \
         patch.object(pipeline.os, "getloadavg", return_value=(1.5, 1.0, 0.5)), \
         patch.object(pipeline, "_watchdog_cap_mb", return_value=None), \
         patch.object(pipeline, "SOURCE_ROOT", Path(env["DEPLOY_PIPELINE_SOURCE_ROOT"])), \
         patch.dict(os.environ, env, clear=True):
        host = pipeline.host_resources()
        assert host["mem_total_mb"] == 32768 and host["mem_available_mb"] == 13312, host
        page_size = 4096
        assert pipeline.host_resources()["mem_available_mb"] == 3328
        page_size = 16384
        assert pipeline.run(plan, tmp / "macos-good") == 0
        good = json.loads((tmp / "macos-good" / "receipt.json").read_text())
        assert good["host_peak"]["load1_peak"] == 1.5, good["host_peak"]
        pressure = True
        assert pipeline.run(plan, tmp / "macos-low") == 1
        receipt = json.loads((tmp / "macos-low" / "receipt.json").read_text())
        assert "started_epoch" not in receipt["lanes"]["macos"], receipt
        with patch.object(pipeline.subprocess, "check_output", return_value="invalid native output"):
            try:
                pipeline.host_resources()
            except ValueError as error:
                assert "/usr/sbin/sysctl -n hw.memsize" in str(error) and "/usr/bin/vm_stat" in str(error)
            else:
                raise AssertionError("invalid macOS counters must fail closed with a repair command")
    assert ["/usr/bin/vm_stat"] in calls and ["/usr/sbin/sysctl", "-n", "hw.memsize"] in calls
    print("macOS no-/proc sampler + live admission: ok")


def check_memory_admission(tmp: Path, env: dict[str, str]) -> None:
    """Running lanes never hold more declared memory than the budget; a lane
    that can never fit is refused up front and reported by wait (no stage row)."""
    state = tmp / "admission"
    plan = tmp / "admission-plan.json"
    write_plan(plan, [
        {"name": "heavy-a", "command": ["sleep", "1.5"], "reuse_passed": False, "memory_mb": 200},
        {"name": "heavy-b", "command": ["sleep", "1.5"], "reuse_passed": False, "memory_mb": 200},
        {"name": "light", "command": ["sleep", "0.5"], "reuse_passed": False, "memory_mb": 90},
        {"name": "giant", "command": ["true"], "reuse_passed": False, "memory_mb": 4000},
    ])
    since = time.time()
    supervisor = subprocess.Popen(
        [sys.executable, str(DRIVER), "run", "--plan", str(plan), "--state-dir", str(state),
         "--max-parallel", "0", "--memory-budget-mb", "300"], env=env,
    )
    waited = run_driver("wait", "--state-dir", str(state), "--timeout", "20", "--since", str(since), env=env)
    assert waited.returncode == 1, waited.stdout + waited.stderr
    assert "FAILED giant exit=None" in waited.stdout and "refused: needs 4000 MB, memory budget 300 MB" in waited.stdout, \
        waited.stdout
    assert supervisor.wait(timeout=30) == 1
    receipt = json.loads((state / "receipt.json").read_text())
    lanes = receipt["lanes"]
    assert receipt["memory_budget_mb"] == 300 and receipt["max_parallel"] == 0, receipt
    assert lanes["giant"]["status"] == "failed" and "started_epoch" not in lanes["giant"], lanes["giant"]
    for name in ("heavy-a", "heavy-b", "light"):
        assert lanes[name]["status"] == "passed", lanes[name]
    a, b = lanes["heavy-a"], lanes["heavy-b"]
    assert b["started_epoch"] >= a["finished_epoch"] or a["started_epoch"] >= b["finished_epoch"], \
        "200 + 200 MB must never run together under a 300 MB budget"
    assert lanes["light"]["started_epoch"] < min(a["finished_epoch"], b["finished_epoch"]), \
        "a 90 MB lane fits beside one 200 MB lane and must not wait for it"
    # Default budget comes from the host: the receipt records what was used.
    write_plan(plan, [{"name": "light", "command": ["true"], "reuse_passed": False, "memory_mb": 1}])
    assert run_driver("run", "--plan", str(plan), "--state-dir", str(state), env=env).returncode == 0
    receipt = json.loads((state / "receipt.json").read_text())
    assert receipt["host"]["cpus"] == (os.cpu_count() or 1), receipt["host"]
    assert receipt["memory_budget_mb"] is not None and receipt["max_parallel"] >= 1, receipt
    # A plan's own max_parallel is honoured when the flag is absent.
    write_plan(plan, [{"name": "light", "command": ["true"], "reuse_passed": False, "memory_mb": 1}],
               max_parallel=3)
    assert run_driver("run", "--plan", str(plan), "--state-dir", str(state), env=env).returncode == 0
    assert json.loads((state / "receipt.json").read_text())["max_parallel"] == 3
    print("memory admission: ok")


def check_max_parallel_default(tmp: Path, env: dict[str, str]) -> None:
    """Without --max-parallel the host default (>= 2) bounds concurrency.

    The cap is judged on the host sample the driver recorded in its receipt,
    not on a second sample taken here: the default is a function of live
    MemAvailable, and on a box whose memory moves while another deploy runs
    (2026-10-31: the budget swung 1.2 GB in 10 s beside the 4-lane threshold)
    two samples can land on different sides of a lane boundary, which made
    this check report 4 lanes against a cap of 3 that the driver never used.
    The lane count covers the largest possible default so the bound is always
    observable."""
    pipeline = load_module("run_deploy_pipeline_cap_under_test", DRIVER)
    state = tmp / "cap"
    plan = tmp / "cap-plan.json"
    count = pipeline.CEILING_CPUS // 2 + 2
    write_plan(plan, [{"name": f"lane-{i}", "command": ["sleep", "1"], "reuse_passed": False, "memory_mb": 1}
                      for i in range(count)])
    assert run_driver("run", "--plan", str(plan), "--state-dir", str(state), "--memory-budget-mb", "1048576",
                      env=env).returncode == 0
    receipt = json.loads((state / "receipt.json").read_text())
    cap = receipt["max_parallel"]
    assert cap == pipeline.default_max_parallel(receipt["host"]), (
        f"the driver's cap {cap} is not the host default of its own recorded sample {receipt['host']}")
    assert 1 <= cap <= pipeline.CEILING_CPUS // 2 < count, (cap, count)
    lanes = receipt["lanes"]
    events = sorted([(lane["started_epoch"], 1) for lane in lanes.values()]
                    + [(lane["finished_epoch"], -1) for lane in lanes.values()])
    peak = level = 0
    for _, delta in events:
        level += delta
        peak = max(peak, level)
    assert peak <= cap, f"{peak} lanes overlapped with a host cap of {cap}"
    assert peak >= min(2, cap), "available concurrency is used"
    print(f"max-parallel default: ok (cap={cap}, peak={peak})")


def check_wait_since_and_no_row_failures(tmp: Path, env: dict[str, str]) -> None:
    state = tmp / "since"
    plan = tmp / "since-plan.json"
    write_plan(plan, [{"name": "green", "command": ["true"], "reuse_passed": False}])
    assert run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=env).returncode == 0
    old = json.loads((state / "receipt.json").read_text())
    assert old["status"] == "passed"
    # A waiter armed before the next run must ignore the previous (green) receipt.
    since = time.time()
    waiter = subprocess.Popen(
        [sys.executable, str(DRIVER), "wait", "--state-dir", str(state), "--timeout", "20", "--since", str(since)],
        env=env, stdout=subprocess.PIPE, text=True,
    )
    time.sleep(0.6)
    assert waiter.poll() is None, "wait returned on the previous iteration's receipt (false green)"
    write_plan(plan, [{"name": "red", "command": ["bash", "-c", "sleep 0.5; exit 9"], "reuse_passed": False}])
    assert run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=env).returncode == 1
    stdout, _ = waiter.communicate(timeout=30)
    assert waiter.returncode == 1 and "FAILED red exit=9" in stdout, (waiter.returncode, stdout)
    # A since newer than every receipt never resolves: exit 2, bounded by --timeout.
    late = run_driver("wait", "--state-dir", str(state), "--timeout", "1", "--since", str(time.time() + 3600),
                      env=env)
    assert late.returncode == 2 and "no-receipt" in late.stdout, late.stdout
    missing = run_driver("wait", "--state-dir", str(state), "--timeout", "1", env=env)
    assert missing.returncode == 2 and "--since" in missing.stderr, "wait without --since must be a usage error"

    # A lane that dies before run-deploy-stage writes a row (here: its cwd does
    # not exist) must wake the waiter with that lane, not hang until --timeout.
    write_plan(plan, [
        {"name": "no-row", "command": ["true"], "cwd": "does-not-exist-" + str(os.getpid()), "reuse_passed": False},
        {"name": "sibling", "command": ["sleep", "0.5"], "reuse_passed": False},
    ])
    since = time.time()
    supervisor = subprocess.Popen(
        driver_argv("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED), env=env,
    )
    started = time.monotonic()
    waited = run_driver("wait", "--state-dir", str(state), "--timeout", "15", "--since", str(since), env=env)
    assert waited.returncode == 1, waited.stdout
    assert "FAILED no-row exit=None" in waited.stdout and "spawn failed" in waited.stdout, waited.stdout
    assert time.monotonic() - started < 5, "a row-less failure must not wait for --timeout"
    assert supervisor.wait(timeout=30) == 1
    rows = (Path(json.loads((state / "receipt.json").read_text())["stage_run_dir"]) / "stages.jsonl").read_text()
    assert '"no-row"' not in rows, "the failure happened before any stage row"
    # Stage names run-deploy-stage would reject are refused when the plan loads.
    write_plan(plan, [{"name": "bad name", "command": ["true"], "reuse_passed": False}])
    bad = run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=env)
    assert bad.returncode == 2 and "invalid lane name" in bad.stderr, (bad.returncode, bad.stderr)
    print("wait --since and row-less failures: ok")


def make_source_root(path: Path) -> Path:
    """A tiny repo for the frozen-source digest: other authors editing the real
    worktree during a scenario must not turn it stale, and the stale probe
    below never touches the real checkout."""
    path.mkdir()
    (path / "tracked").write_text("v1\n")
    scripts = path / "scripts"
    scripts.mkdir()
    for name in ("run_deploy_pipeline.py", "run-deploy-stage", "run_deploy_stage.py", "deploy_stage.py",
                 "deploy_stage_wait.py", "factory_detail.py", "factory_metadata.py", "select_affected_tests.py",
                 "process-identity.py"):
        shutil.copyfile(ROOT / "scripts" / name, scripts / name)
    (scripts / "test-map").mkdir()
    shutil.copyfile(ROOT / "scripts" / "test-map" / "edges.json", scripts / "test-map" / "edges.json")
    # A minimal multi-package tree for the lane-scoped reuse scenario: the
    # change->test selector needs the backend manifest, one test per lane
    # family and a docs page nothing reads.
    for relative, text in {
        "back-end/package.json": '{"scripts": {"test:structural": "tsx src/tests/structural/none.test.ts"}}\n',
        "back-end/src/bootstrap.ts": "export {};\n",
        "back-end/src/tests/blackbox/health.blackbox.ts": "export {};\n",
        "back-end/src/tests/unit/sample.test.ts": "export {};\n",
        "agents/tests/blackbox/sample.blackbox.py": "x = 1\n",
        "agents/tests/unit/test_sample.py": "def test_sample():\n    pass\n",
        "docs/guide.md": "guide v1\n",
        # A tooling script only the backend coverage runner and one backend
        # unit test execute: the stack lanes judge it by reach (PR-14).
        "back-end/scripts/coverage-process-lock.py": "import json\n",
        "back-end/scripts/run-coverage.sh": "#!/usr/bin/env bash\npython3 scripts/coverage-process-lock.py\n",
        "back-end/src/tests/unit/coverage-process-registry.test.ts":
            "import { execFileSync } from 'node:child_process';\n"
            "execFileSync('python3', ['scripts/coverage-process-lock.py']);\n",
        # Every stack entrypoint exists (a missing one fails the reach judgement closed).
        **{entrypoint: "# fixture entrypoint\n" for entrypoint in STACK_ENTRYPOINTS},
    }.items():
        (path / relative).parent.mkdir(parents=True, exist_ok=True)
        (path / relative).write_text(text)
    # Runtime copies bind both source checks and stage-cache keys to the same
    # private checkout. Parallel authors cannot invalidate this fixture.
    # Mirror the repository's ignore rule for .context: the driver's lane
    # ledger (like the structural runner's durations.json) lives there and
    # must never count as a source change.
    (path / ".gitignore").write_text("__pycache__/\n.context/\n")
    git = ["git", "-C", str(path), "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"]
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run([*git, "add", "."], check=True)
    subprocess.run([*git, "commit", "-qm", "fixture"], check=True)
    return path


def check_watchdog_receipts(tmp: Path, env: dict[str, str]) -> None:
    """Memory-watchdog TERMs inside the run window land in the receipt."""
    # The window is compared against the stamp's own resolution: the watchdog
    # floors ``at`` to the millisecond (other producers to the second), so a
    # TERM 0.3 ms after a run started at 20.4237 is stamped 20.423 and a bare
    # ``started_epoch <= at`` dropped it. Observed as ``watchdog_terminations
    # == []`` at load 0.9 when the poll below landed within a millisecond of
    # the receipt (started 1793445378.524657, stamped ...18.524Z, -0.657 ms).
    pipeline = load_module("pipeline_watchdog_window", DRIVER)
    second = datetime(2026, 10, 31, 9, 34, 20, tzinfo=timezone.utc).timestamp()
    started_epoch, finished_epoch = second + 0.4237, second + 2.9237
    rows = tmp / "watchdog-window.jsonl"
    rows.write_text("".join(json.dumps({"pid": pid, "at": at}) + "\n" for pid, at in [
        (1, "2026-10-31T09:34:20.423Z"),  # TERM at 20.4239, 0.2 ms after the start, floored past it
        (2, "2026-10-31T09:34:20.422Z"),  # its whole millisecond precedes the start
        (3, "2026-10-31T09:34:20Z"),      # second resolution: 20.9 is stamped 20
        (4, "2026-10-31T09:34:19Z"),      # the second before the start
        (5, "2026-10-31T09:34:22.923Z"),  # 0.7 ms before the finish
        (6, "2026-10-31T09:34:22.924Z"),  # after the finish
    ]))
    inside = [row["pid"] for row in pipeline.watchdog_terminations(started_epoch, finished_epoch, log=rows)]
    assert inside == [1, 3, 5], f"a stamp floored past the start must stay inside the window: {inside}"
    assert pipeline.watchdog_terminations(started_epoch, finished_epoch, log=tmp / "absent.jsonl") == []
    log = tmp / "terminations.jsonl"
    state = tmp / "watchdog"
    plan = tmp / "watchdog-plan.json"
    write_plan(plan, [{"name": "lane", "command": ["sleep", "2"], "reuse_passed": False, "memory_mb": 1}])
    before = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 120))
    log.write_text(json.dumps({"at": before, "signal": "TERM", "pid": 1, "comm": "old"}) + "\n")
    supervisor = subprocess.Popen(
        driver_argv("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED),
        env={**env, "DEPLOY_PIPELINE_WATCHDOG_LOG": str(log)}, stderr=subprocess.PIPE, text=True,
    )
    # The receipt appears only after started_epoch is set, so a TERM written
    # after it (real milliseconds, exact-epoch window) is inside the run.
    deadline = time.monotonic() + 15
    while not (state / "receipt.json").exists():
        assert time.monotonic() < deadline, "supervisor never wrote its receipt"
        time.sleep(0.05)
    during = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    with log.open("a") as handle:
        handle.write(json.dumps({"at": during, "signal": "TERM", "pid": 4242, "comm": "postgres",
                                 "source": "whole_machine", "memAvailableBytes": 1007181824}) + "\n")
    _, stderr = supervisor.communicate(timeout=30)
    assert supervisor.returncode == 0, (supervisor.returncode, stderr)
    receipt = json.loads((state / "receipt.json").read_text())
    assert [row["pid"] for row in receipt["watchdog_terminations"]] == [4242], receipt["watchdog_terminations"]
    assert "PIPELINE_WATCHDOG: 1 memory-watchdog TERM(s)" in stderr and "postgres pid=4242" in stderr, stderr
    peak = receipt["host_peak"]
    assert peak["samples"] >= 2 and peak["mem_available_min_mb"] > 0 and peak["load1_peak"] >= 0, peak
    print("watchdog receipts + host peaks: ok")


def check_live_headroom_and_child_rusage(tmp: Path, env: dict[str, str]) -> None:
    """External pressure after planning cannot spend headroom a second time."""
    pipeline = load_module("pipeline_live_headroom", DRIVER)
    marker = tmp / "external-pressure"
    victim = tmp / "must-not-start"
    plan = tmp / "live-plan.json"
    state = tmp / "live-state"
    write_plan(plan, [
        {"name": "pressure", "command": [sys.executable, "-c",
         "from pathlib import Path; Path(" + repr(str(marker)) + ").touch()"],
         "reuse_passed": False, "memory_mb": 512},
        {"name": "victim", "command": ["touch", str(victim)], "after": ["pressure"],
         "reuse_passed": False, "memory_mb": 512},
    ])
    def host():
        return {"cpus": 8, "mem_total_mb": 16384, "watchdog_cap_mb": 14472,
                "mem_available_mb": 2300 if marker.exists() else 8192}
    with patch.object(pipeline, "host_resources", side_effect=host), \
         patch.object(pipeline, "SOURCE_ROOT", Path(env["DEPLOY_PIPELINE_SOURCE_ROOT"])), \
         patch.dict(os.environ, env, clear=True):
        result = pipeline.run(plan, state, max_parallel=2)
    receipt = json.loads((state / "receipt.json").read_text())
    assert result == 1 and not victim.exists(), "live MemAvailable fell but the next lane was still launched"
    assert "headroom" in receipt["lanes"]["victim"]["note"], receipt
    samples = receipt["host_samples"]
    assert any(sample["mem_available_mb"] == 2300 for sample in samples), samples
    child = receipt["lanes"]["pressure"]
    assert child["peak_rss_mb"] > 0 and child["rusage_source"] == "wait4", child
    print("live headroom refusal + per-lane child rusage: ok")


def check_materialized_reservation_credit(tmp: Path, env: dict[str, str], holder_start_delay_s: float = 0.0) -> None:
    """Follow-up ah (#1640, 2026-10-30): live headroom already contains what
    the running lanes use, so charging their whole declarations against it
    again made the 4096 MB smoke lane wait 16 min beside the two coverage
    lanes (3712 + 4096 > ~4700 headroom). A phased lane now reserves only the
    running lanes' unmaterialized declarations (declared - observed
    process-tree PSS, sampled at 1 Hz) against live headroom; the startup
    budget still caps declared totals; an unphased lane (semantic-stack, whose
    startup kills a running stack) keeps the declared accounting; an unobserved
    lane keeps its whole declaration; every decision's inputs land in the
    receipt. Budget 300 at start, headroom 120 once the holder has allocated:
    holder (100) + joiner (60) exceed 120 declared, but 100 - ~70 observed + 60
    fit, so joiner must start while holder is still running.
    ``holder_start_delay_s`` replays a holder descheduled before it allocates:
    on 2026-11-06 (load 10-18, MemoryHigh-throttled scope) the old 0.3 s gate
    finished first, the joiner was admitted at headroom 300 with no deferral
    and the holder was never sampled (KeyError ``tree_peak_anon_mb``)."""
    pipeline = load_module("pipeline_materialized_credit", DRIVER)
    marker = tmp / "holder-allocated"
    plan = tmp / "credit-plan.json"
    holder_command = [sys.executable, "-c",
                      f"import pathlib, time; time.sleep({holder_start_delay_s}); block = b'x' * (60 * 1024 * 1024); "
                      f"pathlib.Path({str(marker)!r}).touch(); time.sleep(4); del block"]

    def write(joined: Path, unphased: Path) -> None:
        # The gate exits once the holder has allocated (its marker), not after a
        # sleep that the holder's interpreter startup can outlast on a loaded
        # host: the joiner must always meet the post-allocation headroom.
        write_plan(plan, [
            {"name": "gate", "command": released_lane(marker), "reuse_passed": False, "group": "3", "memory_mb": 1},
            {"name": "holder", "command": holder_command, "reuse_passed": False, "group": "3", "memory_mb": 100},
            {"name": "joiner", "command": ["touch", str(joined)], "after": ["gate"], "reuse_passed": False,
             "group": "3", "memory_mb": 60},
            {"name": "unphased", "command": ["touch", str(unphased)], "after": ["gate"], "reuse_passed": False,
             "group": "4", "memory_mb": 60},
        ], schedule={"policy": "legacy"})

    def host() -> dict:
        # No MemTotal/watchdog: headroom is MemAvailable less the 2 GiB reserve.
        return {"cpus": 8, "mem_available_mb": pipeline.MEMORY_RESERVE_MB + (120 if marker.exists() else 300)}

    seen_flag: list[str] = []  # what the driver's process actually saw in each arm

    def run(state: Path, extra_env: dict[str, str] | None = None, *,
            require_unknown_deferral: bool = False, **patches) -> dict:
        if marker.exists():
            marker.unlink()
        with ExitStack() as stack:
            stack.enter_context(patch.object(pipeline, "host_resources", side_effect=host))
            stack.enter_context(patch.object(pipeline, "SOURCE_ROOT", Path(env["DEPLOY_PIPELINE_SOURCE_ROOT"])))
            # clear=True: a flag exported by the parent (the control run's
            # DEPLOY_ADMISSION_CREDIT=0) must not leak into an arm that did not set it.
            stack.enter_context(patch.dict(os.environ, {**env, **(extra_env or {})}, clear=True))
            seen_flag.append(os.environ.get("DEPLOY_ADMISSION_CREDIT", "<unset>"))
            for name, value in patches.items():
                stack.enter_context(patch.object(pipeline, name, value))
            if "sample_lane_tree_memory" not in patches:
                # Real /proc samples count only from a scan started after the
                # holder's marker, i.e. after its 60 MB block exists: under load
                # a pass can land mid-allocation (40.8 MB on 2026-11-06), which
                # the driver rightly credits as observed but which is not the
                # materialized holder these arms describe.
                allocated_sampler = pipeline.sample_lane_tree_memory

                def sample_allocated(pids: set[int]) -> dict:
                    return allocated_sampler(pids) if marker.exists() else {}

                stack.enter_context(patch.object(pipeline, "sample_lane_tree_memory", side_effect=sample_allocated))
            if require_unknown_deferral:
                # This arm asserts unknown -> deferred -> fresh -> admitted.
                # A real sample may precede gate completion, so sequence the
                # sampler input against the actual recorded decision, not time.
                unknown_deferred = False
                real_sampler = pipeline.sample_lane_tree_memory
                real_record_waiting = pipeline._record_waiting

                def record_waiting(lane_state: dict, inputs: dict, reason: str) -> None:
                    nonlocal unknown_deferred
                    real_record_waiting(lane_state, inputs, reason)
                    if (reason == "headroom" and inputs.get("accounting") == "unmaterialized"
                            and inputs.get("running", {}).get("holder", {}).get("observation") == "unknown"):
                        unknown_deferred = True

                def sample_after_deferral(pids: set[int]) -> dict:
                    observed = real_sampler(pids)
                    return observed if unknown_deferred else {}

                stack.enter_context(patch.object(pipeline, "_record_waiting", side_effect=record_waiting))
                stack.enter_context(patch.object(pipeline, "sample_lane_tree_memory", side_effect=sample_after_deferral))
            result = pipeline.run(plan, state, max_parallel=0)
        receipt = json.loads((state / "receipt.json").read_text())
        assert result == 0 and receipt["status"] == "passed", (result, receipt["status"], receipt["lanes"])
        assert receipt["memory_budget_mb"] == 300, receipt["memory_budget_mb"]
        return receipt

    if sys.platform == "linux":
        write(tmp / "credit-joined", tmp / "credit-unphased")
        receipt = run(tmp / "credit", require_unknown_deferral=True)
        lanes = receipt["lanes"]
        assert "DEPLOY_ADMISSION_CREDIT" not in env and seen_flag[-1] == "<unset>", \
            f"the true-unset default is under test here; the driver saw {seen_flag[-1]!r}"
        enabled_receipt = receipt
        holder, joiner, unphased = lanes["holder"], lanes["joiner"], lanes["unphased"]
        assert joiner["started_epoch"] < holder["finished_epoch"], \
            "joiner fits beside holder's unmaterialized reservation and must not wait for it"
        assert holder["tree_peak_anon_mb"] >= 50, holder
        admission = joiner["admission"]
        assert admission["decision"] == "admitted" and admission["accounting"] == "unmaterialized", admission
        assert admission["headroom_mb"] == 120 and admission["budget_mb"] == 300 and admission["memory_mb"] == 60
        assert admission["reserved_declared_mb"] == 100 and admission["reserved_live_mb"] < 60, admission
        assert admission["running"]["holder"]["memory_mb"] == 100 and admission["running"]["holder"]["tree_anon_mb"] >= 50
        assert admission["running"]["holder"]["observation"] == "fresh", admission["running"]
        assert admission["running"]["holder"]["tree_pss_mb"] >= admission["running"]["holder"]["tree_anon_mb"], \
            "total PSS is recorded beside the anonymous credit basis"
        assert holder["tree_peak_pss_mb"] >= holder["tree_peak_anon_mb"] >= 50, holder
        assert 0 <= admission["running"]["holder"]["observed_age_s"] <= pipeline.OBSERVATION_MAX_AGE_SECONDS
        assert holder["tree_sampled_at"] and holder["tree_sampled_mono"] is not None, holder
        assert admission["deferred"]["first"]["reason"] == "headroom", admission["deferred"]
        assert admission["deferred"]["first"]["running"]["holder"]["observation"] == "unknown", admission["deferred"]
        assert admission["deferred"]["checks"] >= 1 and admission["deferred"]["reason"] == "headroom", admission
        assert admission["deferred"]["last"]["reserved_live_mb"] + 60 > 120, admission["deferred"]
        assert unphased["started_epoch"] >= holder["finished_epoch"], \
            "an unphased lane keeps the declared accounting beside a running stack"
        assert unphased["admission"]["accounting"] == "declared", unphased["admission"]
        assert "waiting" not in joiner and "waiting" not in unphased, "deferral history moves under admission"
        # Kill switch for a matched control run: identical plan and head with
        # DEPLOY_ADMISSION_CREDIT=0. Sampling and recording continue, every
        # running lane classifies as disabled, the whole declaration is reserved
        # (pre-credit accounting) and the records say so.
        write(tmp / "disabled-joined", tmp / "disabled-unphased")
        receipt = run(tmp / "disabled", extra_env={"DEPLOY_ADMISSION_CREDIT": "0"})
        lanes = receipt["lanes"]
        holder, joiner = lanes["holder"], lanes["joiner"]
        assert joiner["started_epoch"] >= holder["finished_epoch"], \
            "DEPLOY_ADMISSION_CREDIT=0 must reserve the holder's whole declaration (no credit)"
        assert enabled_receipt["admission_credit"] == "enabled" and admission["credit"] == "enabled", admission
        assert enabled_receipt["lanes"]["unphased"]["admission"]["credit"] == "enabled"
        assert receipt["admission_credit"] == "disabled", receipt["admission_credit"]
        assert joiner["admission"]["credit"] == "disabled" and lanes["unphased"]["admission"]["credit"] == "disabled"
        last = joiner["admission"]["deferred"]["last"]
        assert last["reserved_live_mb"] == last["reserved_declared_mb"] == 100 and last["accounting"] == "unmaterialized", last
        assert last["running"]["holder"]["observation"] == "disabled", last["running"]
        # Sampling still saw the 60 MB block (held for 4 s against the 1 Hz
        # sampler: the peak is deterministic) and the final deferral still
        # recorded the latest sample. That sample is the one taken before the
        # holder's reap and may postdate its ``del block`` (the stage wrapper's
        # teardown keeps the lane alive ~0.1-0.3 s after the command exits and
        # the 1 Hz pass drifts into that window under load), so the record is
        # bound to the sampled state, never to the block's size.
        assert holder["tree_peak_anon_mb"] >= 50 and holder["tree_sampled_at"], holder
        recorded = last["running"]["holder"]
        assert recorded["tree_anon_mb"] is not None and recorded["tree_pss_mb"] is not None, \
            "observations are still sampled and recorded for evidence"
        assert 0 < recorded["tree_anon_mb"] <= recorded["tree_pss_mb"], recorded
        assert recorded["tree_anon_mb"] <= holder["tree_peak_anon_mb"] and \
            recorded["tree_pss_mb"] <= holder["tree_peak_pss_mb"], (recorded, holder)
        assert recorded["observed_age_s"] is not None and recorded["observed_age_s"] >= 0, recorded
        assert seen_flag[-1] == "0", seen_flag
        # Explicit "enabled" arm (DEPLOY_ADMISSION_CREDIT=1), separate from the
        # true-unset default: the credit applies and the records say enabled.
        write(tmp / "enabled-joined", tmp / "enabled-unphased")
        receipt = run(tmp / "enabled", extra_env={"DEPLOY_ADMISSION_CREDIT": "1"})
        lanes = receipt["lanes"]
        assert seen_flag[-1] == "1", seen_flag
        assert lanes["joiner"]["started_epoch"] < lanes["holder"]["finished_epoch"], "an explicit 1 credits"
        assert receipt["admission_credit"] == "enabled" and lanes["joiner"]["admission"]["credit"] == "enabled", receipt
        assert lanes["joiner"]["admission"]["reserved_live_mb"] < 60, lanes["joiner"]["admission"]
    else:
        print("materialized reservation credit: process-tree sampling is Linux-only; conservative path only")
    # Unobserved usage (macOS, unreadable /proc) keeps the whole declaration: joiner waits.
    write(tmp / "unobserved-joined", tmp / "unobserved-unphased")
    lanes = run(tmp / "unobserved", sample_lane_tree_memory=lambda pids: {})["lanes"]
    assert lanes["joiner"]["started_epoch"] >= lanes["holder"]["finished_epoch"], lanes["joiner"]
    assert lanes["joiner"]["admission"]["running"] == {} and lanes["holder"]["tree_anon_mb"] is None, lanes
    assert "tree_peak_anon_mb" not in lanes["holder"], lanes["holder"]
    last = lanes["joiner"]["admission"]["deferred"]["last"]["running"]["holder"]
    assert last["tree_anon_mb"] is None and last["observation"] == "unknown", last
    assert pipeline.unmaterialized_mb(100, None) == 100 and pipeline.unmaterialized_mb(100, 70.4) == 30
    assert pipeline.unmaterialized_mb(100, 250.0) == 0
    print("materialized reservation credit: ok")


# Admission scenarios run real lanes against a mocked sampler and host probe.
# Their order is fixed by events (a lane exits only when the fixture releases
# it; the fixture waits for the lane's allocation marker or its exit), never by
# sleeps racing the 1 s sampling clock: under host load a lane's startup alone
# can outlast a sampling pass. The limit only bounds a broken fixture.
FIXTURE_EVENT_LIMIT_SECONDS = 120


def await_fixture(condition, what: str) -> None:
    deadline = time.monotonic() + FIXTURE_EVENT_LIMIT_SECONDS
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError(f"fixture event never happened: {what}")
        time.sleep(0.02)


def released_lane(release: Path) -> list[str]:
    """A lane that exits 0 once ``release`` exists (3 if it never does)."""
    polls = int(FIXTURE_EVENT_LIMIT_SECONDS / 0.05)
    return ["bash", "-c", f"for _ in $(seq {polls}); do [ -e {shlex.quote(str(release))} ] && exit 0; "
                          "sleep 0.05; done; exit 3"]


def allocating_lane(marker: Path, release: Path) -> list[str]:
    """A lane that marks its allocation, then holds until ``release`` exists."""
    return [sys.executable, "-c",
            f"import pathlib, sys, time; pathlib.Path({str(marker)!r}).touch(); "
            f"release, end = pathlib.Path({str(release)!r}), time.monotonic() + {FIXTURE_EVENT_LIMIT_SECONDS}\n"
            "while not release.exists():\n"
            "    if time.monotonic() > end: sys.exit(3)\n"
            "    time.sleep(0.05)\n"]


def lane_pid(pids: set[int], release: Path) -> int:
    """The running lane whose command waits on ``release``."""
    needle = os.fsencode(str(release))
    found: list[int] = []

    def match() -> bool:
        for pid in pids:
            try:
                if needle in Path(f"/proc/{pid}/cmdline").read_bytes():
                    found.append(pid)
                    return True
            except OSError:
                continue
        return False

    await_fixture(match, f"a lane waiting on {release.name}")
    return found[0]


def lane_exited(pid: int) -> bool:
    """The lane has exited; the pipeline has not reaped it yet (a zombie)."""
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] == "Z"
    except (OSError, IndexError):
        return True


@contextmanager
def releasing(*releases: Path):
    """Release every fixture lane on the way out, so a failed scenario leaves
    no lane waiting out its bound (the deploy worker would see a survivor)."""
    try:
        yield
    finally:
        for release in releases:
            release.touch()


def check_identity_verified_zombie_memory(tmp: Path) -> None:
    """Existing sampler owner: real ESRCH zombie plus conservative fake-proc negatives."""
    pipeline = load_module("pipeline_verified_zombie", DRIVER)
    proc = tmp / 'identity-zombie-proc'
    pid = 901
    (proc / str(pid)).mkdir(parents=True)
    stat_path, rollup = proc / str(pid) / 'stat', proc / str(pid) / 'smaps_rollup'
    def stat_text(state='S', birth='100', threads='1'):
        fields = [state, '1'] + ['0'] * 17 + [birth, '0', '0']
        fields[17] = threads
        return f"{pid} (fake with spaces) {' '.join(fields)}\n"
    stat_path.write_text(stat_text())
    original_read = Path.read_text
    original_exists = Path.exists
    def observe(*, error=None, current=None, vanished=False, initial='S'):
        stat_path.write_text(stat_text(initial))
        calls = 0
        def read(path, *args, **kwargs):
            nonlocal calls
            if path == rollup:
                calls += 1
                if error is not None:
                    raise error
                return 'Pss: 2048 kB\nPss_Anon: 1024 kB\n'
            if path == stat_path and calls and current is not None:
                return current
            return original_read(path, *args, **kwargs)
        def exists(path):
            if vanished and path == proc / str(pid) and calls:
                return False
            return original_exists(path)
        with patch.object(Path, 'read_text', read), patch.object(Path, 'exists', exists):
            result = pipeline.sample_lane_tree_memory({pid}, proc)
        assert calls == 1, 'one original smaps read, no retry'
        return result
    zero = {pid: {'anon_mb': 0.0, 'pss_mb': 0.0}}
    unknown = {pid: None}
    # Same observed identity, current Z at failedread; both initial Z and S->Z allowed.
    for initial in ('S', 'Z'):
        assert observe(error=ProcessLookupError(3, 'synthetic'), current=stat_text('Z'), initial=initial) == zero
    for threads in ('2','0','malformed','-1','1.0'):
        assert observe(error=ProcessLookupError(3, 'synthetic'), current=stat_text('Z',threads=threads)) == unknown
    assert observe(error=PermissionError(13, 'synthetic'), current=stat_text('S')) == unknown
    assert observe(error=ProcessLookupError(3, 'synthetic'), current=stat_text('S')) == unknown
    assert observe(error=ProcessLookupError(3, 'synthetic'), current=stat_text('Z','101')) == unknown
    assert observe(error=ProcessLookupError(3, 'synthetic'), current=stat_text('S','101'), initial='Z') == unknown
    assert observe(error=ProcessLookupError(3, 'synthetic'), current='malformed') == unknown
    assert observe(error=ProcessLookupError(3, 'synthetic'), vanished=True) == zero
    assert observe() == {pid: {'anon_mb':1.0,'pss_mb':2.0}}
    def malformed_read(path,*args,**kwargs):
        return 'Pss: malformed\nPss_Anon: 1024 kB\n' if path==rollup else original_read(path,*args,**kwargs)
    with patch.object(Path,'read_text',malformed_read):
        assert pipeline.sample_lane_tree_memory({pid},proc)==unknown


def check_identity_verified_zombie_memory_real(tmp: Path) -> None:
    """Physical owning RED is independently runnable, not masked by fake-proc RED."""
    pipeline = load_module("pipeline_verified_zombie_real", DRIVER)
    if sys.platform == 'linux':
        child = os.fork()
        if child == 0:
            os._exit(0)
        try:
            child_stat = Path('/proc') / str(child) / 'stat'
            def is_zombie():
                return child_stat.read_text().rsplit(') ',1)[1].split()[0] == 'Z'
            await_fixture(is_zombie, 'owned child zombie before waitpid')
            before = child_stat.read_text().rsplit(') ',1)[1].split()
            assert before[0] == 'Z'
            assert pipeline.sample_lane_tree_memory({child}) == {child:{'anon_mb':0.0,'pss_mb':0.0}}
            after = child_stat.read_text().rsplit(') ',1)[1].split()
            assert after[0] == 'Z' and after[19] == before[19]
        finally:
            reaped, status = os.waitpid(child,0)  # Exact own exited child only; no signals.
            assert reaped == child and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0


def check_observation_validity(tmp: Path, env: dict[str, str]) -> None:
    """Review of f3127ca41: the credit must bind to a fresh, fully observed
    PSS sample. (1) Summed RSS is never a PSS substitute: shared pages count
    once per process and would over-credit the lane, so a tree with any live
    process whose smaps_rollup is unreadable is unknown. (2) Every sampling
    pass re-marks every running lane: a lane sampled at 80 MB whose later
    passes fail (process gone, /proc unreadable, PID reuse) is unknown again,
    not still credited 80 MB; and an observation older than
    OBSERVATION_MAX_AGE_SECONDS is stale. Unknown and stale keep the whole
    declaration; only fresh credits."""
    pipeline = load_module("pipeline_observation_validity", DRIVER)
    # (2) Stale after a sampling failure. The holder is observed once at 80 MB
    # (the first pass) and never again; the gate is released during the second
    # (failed) pass, so the joiner becomes eligible only after a failed pass has
    # made the holder unknown. The holder is released once the joiner has
    # waited and a third pass has run.
    record_waiting = pipeline._record_waiting
    marker = tmp / "validity-holder-allocated"
    gate_release = tmp / "validity-gate-release"
    holder_release = tmp / "validity-holder-release"
    joined = tmp / "validity-joiner-started"
    plan = tmp / "validity-plan.json"
    state = tmp / "validity"
    write_plan(plan, [
        {"name": "gate", "command": released_lane(gate_release), "reuse_passed": False, "group": "3",
         "memory_mb": 1},
        {"name": "holder", "command": allocating_lane(marker, holder_release),
         "reuse_passed": False, "group": "3", "memory_mb": 100},
        {"name": "joiner", "command": ["touch", str(joined)], "after": ["gate"], "reuse_passed": False,
         "group": "3", "memory_mb": 60},
    ], schedule={"policy": "legacy"})
    calls: list[set[int]] = []
    deferrals: list[str] = []

    def flaky_sampler(pids: set[int]) -> dict[int, dict | None]:
        calls.append(set(pids))
        if len(calls) == 2:
            await_fixture(marker.exists, "holder allocation")
            gate_release.touch()  # the gate's exit is reaped after this failed pass
        if len(calls) >= 3 and (deferrals or joined.exists()):
            holder_release.touch()  # (an early joiner fails the start-order assertion below)
        return {pid: {"anon_mb": 80.0, "pss_mb": 96.0} for pid in pids} if len(calls) == 1 else {}

    def counted_waiting(lane_state: dict, inputs: dict, reason: str) -> None:
        record_waiting(lane_state, inputs, reason)
        deferrals.append(reason)

    def host() -> dict:
        return {"cpus": 8, "mem_available_mb": pipeline.MEMORY_RESERVE_MB + (120 if marker.exists() else 300)}

    with releasing(gate_release, holder_release), \
         patch.object(pipeline, "host_resources", side_effect=host), \
         patch.object(pipeline, "sample_lane_tree_memory", side_effect=flaky_sampler), \
         patch.object(pipeline, "_record_waiting", side_effect=counted_waiting), \
         patch.object(pipeline, "SOURCE_ROOT", Path(env["DEPLOY_PIPELINE_SOURCE_ROOT"])), \
         patch.dict(os.environ, env, clear=True):
        result = pipeline.run(plan, state, max_parallel=0)
    receipt = json.loads((state / "receipt.json").read_text())
    assert result == 0 and receipt["status"] == "passed", (result, receipt["lanes"])
    holder, joiner = receipt["lanes"]["holder"], receipt["lanes"]["joiner"]
    assert len(calls) >= 3, f"the sampler must have failed after its first pass: {len(calls)} passes"
    assert joiner["started_epoch"] >= holder["finished_epoch"], \
        "a stale 80 MB observation stayed credited after sampling failed"
    assert holder["tree_peak_anon_mb"] == 80.0 and holder["tree_peak_pss_mb"] == 96.0, holder
    assert holder["tree_anon_mb"] is None and holder["tree_pss_mb"] is None, holder
    last = joiner["admission"]["deferred"]["last"]["running"]["holder"]
    assert last == {"memory_mb": 100, "tree_anon_mb": None, "tree_pss_mb": None,
                    "observed_age_s": last["observed_age_s"], "observation": "unknown"} \
        and last["observed_age_s"] is not None, last
    # (1) Anonymous PSS only. A rollup unreadable for one live process, or
    # lacking Pss / Pss_Anon, makes the tree unknown (never summed RSS); a
    # file-backed footprint with zero Pss_Anon is observed as 0 MB and leaves
    # the growth reservation untouched: those pages are still in MemAvailable.
    proc = tmp / "fake-proc"
    for pid, ppid in ((100, 1), (101, 100), (102, 101), (200, 1)):
        (proc / str(pid)).mkdir(parents=True)
        fields = ["S", str(ppid), str(pid), str(pid)] + ["0"] * 17 + ["1000", "25000"]  # ... vsize, rss pages
        (proc / str(pid) / "stat").write_text(f"{pid} (fake) {' '.join(fields)}\n")
    (proc / "not-a-pid").mkdir()
    rollup = "Rss: 4096 kB\nPss: 2048 kB\nPss_Dirty: 1024 kB\nPss_Anon: 1024 kB\nPss_File: 1024 kB\nPss_Shmem: 0 kB\n"
    for pid in (100, 101):
        (proc / str(pid) / "smaps_rollup").write_text(rollup)
    assert pipeline.sample_lane_tree_memory({100, 200}, proc) == {100: None, 200: None}, "102 and 200 lack a rollup"
    (proc / "102" / "smaps_rollup").write_text("Rss: 4096 kB\nPss: 1024 kB\nPss_Anon: 512 kB\nPss_File: 512 kB\n")
    assert pipeline.sample_lane_tree_memory({100}, proc) == {100: {"anon_mb": 2.5, "pss_mb": 5.0}}, \
        "anon 1 + 1 + 0.5 MB, total 2 + 2 + 1 MB over 100, 101, 102"
    shutil.rmtree(proc / "102")  # exited since the listing: gone, not unknown
    listing = os.listdir(proc)
    with patch.object(pipeline.os, "listdir", return_value=listing + ["102"]):
        assert pipeline.sample_lane_tree_memory({100}, proc) == {100: {"anon_mb": 2.0, "pss_mb": 4.0}}
    (proc / "101" / "smaps_rollup").write_text("Rss: 4096 kB\nPss: 2048 kB\nPss_File: 2048 kB\n")  # no Pss_Anon
    assert pipeline.sample_lane_tree_memory({100}, proc) == {100: None}, "a rollup without Pss_Anon is unknown"
    (proc / "101" / "smaps_rollup").write_text("Rss: 4096 kB\nPss_Anon: 1024 kB\n")  # no Pss
    assert pipeline.sample_lane_tree_memory({100}, proc) == {100: None}, "a rollup without Pss is unknown"
    (proc / "101" / "smaps_rollup").write_text(rollup)
    (proc / "100" / "smaps_rollup").write_text(
        "Rss: 92160 kB\nPss: 92160 kB\nPss_Dirty: 0 kB\nPss_Anon: 0 kB\nPss_File: 92160 kB\nPss_Shmem: 0 kB\n")
    file_backed = pipeline.sample_lane_tree_memory({100}, proc)
    assert file_backed == {100: {"anon_mb": 1.0, "pss_mb": 92.0}}, file_backed
    assert pipeline.unmaterialized_mb(100, 0.0) == 100 and pipeline.unmaterialized_mb(100, 1.0) == 99, \
        "90 MB of file-backed PSS reduces no reservation; only the anonymous MB do"
    assert pipeline.sample_lane_tree_memory({100}, tmp / "no-such-proc") == {100: None}
    assert pipeline.sample_lane_tree_memory(set(), proc) == {}
    # A fresh observation with zero anonymous memory and a large file-backed
    # footprint credits nothing: the joiner must still wait for the holder.
    # The gate exits once the holder has allocated; the holder is released once
    # the joiner has waited on a fresh observation of it.
    anon_marker = tmp / "anon-holder-allocated"
    anon_release = tmp / "anon-holder-release"
    anon_joined = tmp / "anon-joiner-started"
    anon_plan = tmp / "anon-plan.json"
    anon_state = tmp / "anon"
    write_plan(anon_plan, [
        {"name": "gate", "command": released_lane(anon_marker), "reuse_passed": False, "group": "3",
         "memory_mb": 1},
        {"name": "holder", "command": allocating_lane(anon_marker, anon_release),
         "reuse_passed": False, "group": "3", "memory_mb": 100},
        {"name": "joiner", "command": ["touch", str(anon_joined)], "after": ["gate"], "reuse_passed": False,
         "group": "3", "memory_mb": 60},
    ], schedule={"policy": "legacy"})

    def anon_sampler(pids: set[int]) -> dict[int, dict | None]:
        if anon_joined.exists():
            anon_release.touch()  # an early joiner fails the start-order assertion below
        return {pid: {"anon_mb": 0.0, "pss_mb": 95.0} for pid in pids}

    def anon_host() -> dict:
        return {"cpus": 8, "mem_available_mb": pipeline.MEMORY_RESERVE_MB + (120 if anon_marker.exists() else 300)}

    def anon_waiting(lane_state: dict, inputs: dict, reason: str) -> None:
        record_waiting(lane_state, inputs, reason)
        if inputs.get("running", {}).get("holder", {}).get("observation") == "fresh":
            anon_release.touch()

    with releasing(anon_marker, anon_release), \
         patch.object(pipeline, "host_resources", side_effect=anon_host), \
         patch.object(pipeline, "sample_lane_tree_memory", side_effect=anon_sampler), \
         patch.object(pipeline, "_record_waiting", side_effect=anon_waiting), \
         patch.object(pipeline, "SOURCE_ROOT", Path(env["DEPLOY_PIPELINE_SOURCE_ROOT"])), \
         patch.dict(os.environ, env, clear=True):
        result = pipeline.run(anon_plan, anon_state, max_parallel=0)
    receipt = json.loads((anon_state / "receipt.json").read_text())
    assert result == 0 and receipt["status"] == "passed", (result, receipt["lanes"])
    holder, joiner = receipt["lanes"]["holder"], receipt["lanes"]["joiner"]
    assert joiner["started_epoch"] >= holder["finished_epoch"], \
        "95 MB of file-backed PSS with zero Pss_Anon reduced the holder's growth reservation"
    last = joiner["admission"]["deferred"]["last"]["running"]["holder"]
    assert last["observation"] == "fresh" and last["tree_anon_mb"] == 0.0 and last["tree_pss_mb"] == 95.0, last
    assert joiner["admission"]["deferred"]["last"]["reserved_live_mb"] == 100, joiner["admission"]["deferred"]
    assert holder["tree_peak_anon_mb"] == 0.0 and holder["tree_peak_pss_mb"] == 95.0, holder
    # A delayed scan: the observation is as old as the scan's START. The first
    # pass takes 3.5 s (over the 3 s limit) and reports 80 MB when it returns;
    # the gate exits during that scan, so the joiner's first check runs right
    # after it and must see the holder stale (not fresh because the scan "just
    # finished"), then unknown as later passes fail; it waits for the holder,
    # which is released once a failed pass has followed that check.
    slow_marker = tmp / "slow-holder-allocated"
    slow_gate_release = tmp / "slow-gate-release"
    slow_holder_release = tmp / "slow-holder-release"
    slow_plan = tmp / "slow-scan-plan.json"
    slow_state = tmp / "slow-scan"
    write_plan(slow_plan, [
        {"name": "gate", "command": released_lane(slow_gate_release), "reuse_passed": False, "group": "3",
         "memory_mb": 1},
        {"name": "holder", "command": allocating_lane(slow_marker, slow_holder_release),
         "reuse_passed": False, "group": "3", "memory_mb": 100},
        {"name": "joiner", "command": ["true"], "after": ["gate"], "reuse_passed": False, "group": "3",
         "memory_mb": 60},
    ], schedule={"policy": "legacy"})
    slow_calls: list[float] = []

    def slow_sampler(pids: set[int]) -> dict[int, dict | None]:
        slow_calls.append(time.monotonic())
        if len(slow_calls) == 1:
            await_fixture(slow_marker.exists, "holder allocation")
            gate = lane_pid(pids, slow_gate_release)
            slow_gate_release.touch()
            await_fixture(lambda: lane_exited(gate), "gate exit during the slow scan")
            time.sleep(max(0.0, slow_calls[0] + pipeline.OBSERVATION_MAX_AGE_SECONDS + 0.5 - time.monotonic()))
            return {pid: {"anon_mb": 80.0, "pss_mb": 96.0} for pid in pids}
        if len(slow_calls) >= 3:
            slow_holder_release.touch()  # the joiner has waited through a failed pass
        return {}

    def slow_host() -> dict:
        return {"cpus": 8, "mem_available_mb": pipeline.MEMORY_RESERVE_MB + (120 if slow_marker.exists() else 300)}

    with releasing(slow_gate_release, slow_holder_release), \
         patch.object(pipeline, "host_resources", side_effect=slow_host), \
         patch.object(pipeline, "sample_lane_tree_memory", side_effect=slow_sampler), \
         patch.object(pipeline, "SOURCE_ROOT", Path(env["DEPLOY_PIPELINE_SOURCE_ROOT"])), \
         patch.dict(os.environ, env, clear=True):
        result = pipeline.run(slow_plan, slow_state, max_parallel=0)
    receipt = json.loads((slow_state / "receipt.json").read_text())
    assert result == 0 and receipt["status"] == "passed", (result, receipt["lanes"])
    holder, joiner = receipt["lanes"]["holder"], receipt["lanes"]["joiner"]
    assert joiner["started_epoch"] >= holder["finished_epoch"], \
        "an observation from a scan older than the limit was credited because the scan had just returned"
    first = joiner["admission"]["deferred"]["first"]["running"]["holder"]
    assert first["observation"] == "stale" and first["tree_anon_mb"] == 80.0, first
    assert first["observed_age_s"] >= pipeline.OBSERVATION_MAX_AGE_SECONDS, first
    assert joiner["admission"]["deferred"]["last"]["running"]["holder"]["observation"] == "unknown", joiner
    assert holder["tree_peak_anon_mb"] == 80.0 and holder["tree_sampled_at"], holder
    # Fresh, stale (too old, unstamped), invalid (from the future) and unknown
    # observations on the monotonic clock. The raw elapsed value is compared;
    # only the displayed age is rounded (3.04 s must not read as 3.0 and pass,
    # -0.04 s must not read as -0.0 and pass).
    now = 1_000.0
    limit = pipeline.OBSERVATION_MAX_AGE_SECONDS

    def classify(age: float) -> tuple[float | None, dict]:
        return pipeline.fresh_tree_anon_mb({"tree_anon_mb": 80.0, "tree_pss_mb": 96.0,
                                            "tree_sampled_mono": now - age}, now)

    fresh, detail = classify(1.0)
    assert fresh == 80.0 and detail == {"tree_anon_mb": 80.0, "tree_pss_mb": 96.0, "observed_age_s": 1.0,
                                        "observation": "fresh"}, detail
    assert classify(limit - 0.04) == (80.0, {"tree_anon_mb": 80.0, "tree_pss_mb": 96.0,
                                             "observed_age_s": round(limit - 0.04, 2), "observation": "fresh"})
    assert classify(limit)[0] == 80.0, "exactly the limit is still fresh"
    over, detail = classify(limit + 0.04)
    assert over is None and detail["observation"] == "stale" and detail["observed_age_s"] == round(limit + 0.04, 2), \
        f"{limit + 0.04:.2f} s must not round down to the limit: {detail}"
    stale, detail = classify(limit + 0.1)
    assert stale is None and detail["observation"] == "stale" and detail["tree_anon_mb"] == 80.0, detail
    future, detail = classify(-0.04)
    assert future is None and detail["observation"] == "invalid" and detail["observed_age_s"] == -0.04, \
        f"-0.04 s must not round to -0.0 and pass: {detail}"
    future, detail = classify(-5.0)
    assert future is None and detail == {"tree_anon_mb": 80.0, "tree_pss_mb": 96.0, "observed_age_s": -5.0,
                                         "observation": "invalid"}, detail
    assert pipeline.fresh_tree_anon_mb({"tree_anon_mb": 80.0}, now) == (None, {
        "tree_anon_mb": 80.0, "tree_pss_mb": None, "observed_age_s": None, "observation": "stale"})
    assert pipeline.fresh_tree_anon_mb({"tree_anon_mb": None, "tree_sampled_mono": now}, now)[1]["observation"] == "unknown"
    assert pipeline.fresh_tree_anon_mb({}, now) == (None, {"tree_anon_mb": None, "tree_pss_mb": None,
                                                        "observed_age_s": None, "observation": "unknown"})
    assert pipeline.fresh_tree_anon_mb({"tree_anon_mb": 80.0, "tree_sampled_mono": time.monotonic()})[0] == 80.0, \
        "the default clock is monotonic, not wall time"
    # A delayed host probe: the holder is observed fresh (80 MB), the gate exits
    # just before that sampling pass and the joiner's admission probe, right
    # after the pass, then takes 3.2 s. The classification must be made after
    # that probe, at the decision point, where the sample is over 3.2 s old:
    # stale, no credit, the joiner waits (later passes fail, so it keeps waiting
    # until the holder is released). A prompt probe crediting a fresh sample is
    # the first scenario of check_materialized_reservation_credit.
    probe_marker = tmp / "probe-holder-allocated"
    probe_gate_release = tmp / "probe-gate-release"
    probe_holder_release = tmp / "probe-holder-release"
    probe_plan = tmp / "probe-plan.json"
    probe_state = tmp / "probe"
    write_plan(probe_plan, [
        {"name": "gate", "command": released_lane(probe_gate_release), "reuse_passed": False,
         "group": "3", "memory_mb": 1},
        {"name": "holder", "command": allocating_lane(probe_marker, probe_holder_release),
         "reuse_passed": False, "group": "3", "memory_mb": 100},
        {"name": "joiner", "command": ["true"], "after": ["gate"], "reuse_passed": False, "group": "3",
         "memory_mb": 60},
    ], schedule={"policy": "legacy"})
    probe_calls: list[set[int]] = []
    gate_exited: list[float] = []
    slow_probes: list[float] = []

    def once_sampler(pids: set[int]) -> dict[int, dict | None]:
        probe_calls.append(set(pids))
        if len(probe_calls) >= 3:
            probe_holder_release.touch()  # the joiner has waited through the delayed probe
        return {pid: {"anon_mb": 80.0, "pss_mb": 96.0} for pid in pids} if len(probe_calls) <= 2 else {}

    def delayed_host() -> dict:
        if probe_calls and not gate_exited:
            # The second pass's host sample (the joiner is not eligible yet, so
            # nothing else probes): the gate exits now, the pass then observes
            # the holder fresh and the joiner's decision follows in that loop.
            await_fixture(probe_marker.exists, "holder allocation")
            gate = lane_pid(probe_calls[0], probe_gate_release)
            probe_gate_release.touch()
            await_fixture(lambda: lane_exited(gate), "gate exit before the second pass")
            gate_exited.append(time.monotonic())
        elif gate_exited and not slow_probes:
            slow_probes.append(time.monotonic())
            time.sleep(pipeline.OBSERVATION_MAX_AGE_SECONDS + 0.2)
        return {"cpus": 8, "mem_available_mb": pipeline.MEMORY_RESERVE_MB + (120 if probe_marker.exists() else 300)}

    with releasing(probe_gate_release, probe_holder_release), \
         patch.object(pipeline, "host_resources", side_effect=delayed_host), \
         patch.object(pipeline, "sample_lane_tree_memory", side_effect=once_sampler), \
         patch.object(pipeline, "SOURCE_ROOT", Path(env["DEPLOY_PIPELINE_SOURCE_ROOT"])), \
         patch.dict(os.environ, env, clear=True):
        result = pipeline.run(probe_plan, probe_state, max_parallel=0)
    receipt = json.loads((probe_state / "receipt.json").read_text())
    assert result == 0 and receipt["status"] == "passed", (result, receipt["lanes"])
    holder, joiner = receipt["lanes"]["holder"], receipt["lanes"]["joiner"]
    assert slow_probes and holder["tree_peak_anon_mb"] == 80.0, (slow_probes, holder)
    assert joiner["started_epoch"] >= holder["finished_epoch"], \
        "a sample that expired during the host probe was still credited at the decision"
    first = joiner["admission"]["deferred"]["first"]["running"]["holder"]
    assert first["observation"] == "stale" and first["observed_age_s"] > pipeline.OBSERVATION_MAX_AGE_SECONDS, first
    assert joiner["admission"]["deferred"]["first"]["reserved_live_mb"] == 100, joiner["admission"]["deferred"]
    print("observation validity: ok")


def check_semantic_stack_beside_stack_owners(tmp: Path, env: dict[str, str]) -> None:
    """Follow-up "an" (2026-10-31): semantic-stack's ``run.sh --benchmark``
    sweeps spare every process of a live isolated run (kill-services.test.sh,
    run-isolated-cloud-kill.test.sh), so the loader no longer appends the
    implied ``after`` edges from semantic-stack to the stack-owning lanes
    (``STACK_KILLER_LANES`` is empty): with unbounded memory semantic-stack
    starts while smoke and agentcard-lifecycle are still running and the
    receipt's ``after`` shows only its declared edge. Memory still rules: when
    smoke + semantic-stack exceed the budget, admission defers semantic-stack
    until smoke releases its reservation, without touching any declaration.
    The edge mechanism itself is kept for a future stack-killing lane: with a
    lane listed, edges are appended, never duplicated, and a plan that would
    close a cycle through the implied edge is refused."""
    pipeline = load_module("pipeline_stack_owner", DRIVER)
    assert pipeline.STACK_KILLER_LANES == () and pipeline.STACK_OWNER_LANES == ("smoke", "agentcard-lifecycle")
    plan = tmp / "stack-owner-plan.json"
    state = tmp / "stack-owner"
    marker = tmp / "semantic-started"
    write_plan(plan, [
        {"name": "cov", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "3"},
        # The stack owners run until semantic-stack has started (its marker), not
        # for a fixed sleep racing cov's startup on a loaded host.
        {"name": "smoke", "command": released_lane(marker), "reuse_passed": False, "group": "4", "phase": "coverage"},
        {"name": "agentcard-lifecycle", "command": released_lane(marker), "reuse_passed": False, "group": "4",
         "phase": "coverage"},
        {"name": "semantic-stack", "command": ["touch", str(marker)], "after": ["cov"], "reuse_passed": False,
         "group": "4"},
    ], schedule={"policy": "legacy"})
    with releasing(marker):
        ran = run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=env, timeout=120)
    receipt = json.loads((state / "receipt.json").read_text())
    assert ran.returncode == 0 and receipt["status"] == "passed", (ran.returncode, ran.stderr, receipt["status"])
    lanes = receipt["lanes"]
    assert lanes["semantic-stack"]["started_epoch"] < min(lanes["smoke"]["finished_epoch"],
                                                           lanes["agentcard-lifecycle"]["finished_epoch"]), \
        "semantic-stack must be admitted while the stack-owning lanes are still running"
    assert receipt["after"]["semantic-stack"] == ["cov"], receipt["after"]
    assert receipt["after"]["smoke"] == [] and receipt["after"]["agentcard-lifecycle"] == [], receipt["after"]
    assert lanes["smoke"]["started_epoch"] < lanes["cov"]["finished_epoch"], "owners are not held back"
    # Memory, not an edge, keeps them apart when both declarations do not fit:
    # cov (25) + smoke (40) fit a 70 MB budget, semantic-stack (40) does not
    # beside smoke, so it waits for smoke's reservation and is admitted after
    # a recorded budget deferral. The declarations are the plan's own.
    budget_state = tmp / "stack-owner-budget"
    write_plan(plan, [
        {"name": "cov", "command": ["sleep", "0.4"], "reuse_passed": False, "group": "3", "memory_mb": 25},
        {"name": "smoke", "command": ["sleep", "1.5"], "reuse_passed": False, "group": "4", "phase": "coverage",
         "memory_mb": 40},
        {"name": "semantic-stack", "command": ["true"], "after": ["cov"], "reuse_passed": False, "group": "4",
         "memory_mb": 40},
    ], schedule={"policy": "legacy"})
    ran = run_driver("run", "--plan", str(plan), "--state-dir", str(budget_state), "--max-parallel", "0",
                     "--memory-budget-mb", "70", env=env, timeout=120)
    receipt = json.loads((budget_state / "receipt.json").read_text())
    assert ran.returncode == 0 and receipt["status"] == "passed", (ran.returncode, ran.stderr, receipt["status"])
    lanes = receipt["lanes"]
    assert receipt["after"]["semantic-stack"] == ["cov"], receipt["after"]
    assert lanes["smoke"]["started_epoch"] < lanes["cov"]["finished_epoch"], "cov and smoke fit the budget together"
    assert lanes["semantic-stack"]["started_epoch"] >= lanes["smoke"]["finished_epoch"], \
        "40 + 40 MB declared must never run together under a 70 MB budget"
    deferred = lanes["semantic-stack"]["admission"]["deferred"]
    assert deferred and deferred["first"]["reason"] == "budget" and deferred["checks"] >= 1, deferred
    assert deferred["first"]["reserved_declared_mb"] == 40 and deferred["first"]["memory_mb"] == 40, deferred
    assert {lane["memory_mb"] for lane in (lanes["smoke"], lanes["semantic-stack"])} == {40}, "declarations unchanged"
    # The implied-edge mechanism, with a killer lane listed: edges appended to
    # the declared ones, no duplicates, other names untouched, cycles refused.
    with patch.object(pipeline, "STACK_KILLER_LANES", ("semantic-stack",)):
        write_plan(plan, [
            {"name": "cov", "command": ["true"], "group": "3"},
            {"name": "smoke", "command": ["true"], "group": "4", "phase": "coverage"},
            {"name": "agentcard-lifecycle", "command": ["true"], "group": "4", "phase": "coverage"},
            {"name": "semantic-stack", "command": ["true"], "after": ["cov"], "group": "4"},
            {"name": "semantic", "command": ["true"], "group": "4"},
            {"name": "smoke-like", "command": ["true"], "group": "4", "phase": "coverage"},
        ])
        loaded = {lane.name: lane for lane in pipeline.load_plan_payload(plan)[0]}
        assert loaded["semantic-stack"].after == ["cov", "smoke", "agentcard-lifecycle"], loaded
        assert loaded["semantic"].after == [] and loaded["smoke"].after == [], loaded
        write_plan(plan, [
            {"name": "smoke", "command": ["true"], "group": "4", "phase": "coverage"},
            {"name": "semantic-stack", "command": ["true"], "after": ["smoke"], "group": "4"},
        ])
        assert pipeline.load_plan_payload(plan)[0][1].after == ["smoke"]
        write_plan(plan, [
            {"name": "smoke", "command": ["true"], "group": "4", "phase": "coverage", "after": ["semantic-stack"]},
            {"name": "semantic-stack", "command": ["true"], "group": "4"},
        ])
        try:
            pipeline.load_plan_payload(plan)
        except ValueError as error:
            assert "cyclic" in str(error), error
        else:
            raise AssertionError("an owner that waits for a listed killer lane must be refused as a cycle")
    # Without a listed killer lane the same cycle plan is simply an edge.
    assert pipeline.load_plan_payload(plan)[0][0].after == ["semantic-stack"]
    print("semantic-stack beside stack owners: ok")


def check_wait_receipt_contract(tmp: Path, pipeline=None, scenario="both") -> None:
    """Replay terminal receipts at the supervisor/row waiter boundary."""
    pipeline = pipeline or load_module("pipeline_wait_contract", DRIVER)
    if scenario in {"both", "rowless"}:
        event = pipeline._supervisor_event({"status": "failed", "lanes": {
            "no-row": {"status": "failed", "exit": 2}}, "supervisor_pid": os.getpid()})
        assert event == (1, {"event": "failed", "failed": ["no-row"]}), \
            "terminal rowless failure produced no wake event"
        print("rowless failure receipt: ok")
    if scenario not in {"both", "stale"}:
        return
    state = tmp / "contract-state"
    state.mkdir()
    stages = tmp / "contract-stages"
    stages.mkdir()
    old = {"status": "passed", "started_epoch": 1, "stage_run_dir": str(stages),
           "source": {"head": "fixture"}, "supervisor_pid": os.getpid(),
           "lanes": {"old": {"status": "passed"}}}
    pipeline.write_receipt(state / "receipt.json", old)
    def publish():
        time.sleep(0.3)
        pipeline.write_receipt(state / "receipt.json", {**old, "started_epoch": 3,
            "status": "failed", "lanes": {"new": {"status": "failed", "exit": 9}}})
    publisher = threading.Thread(target=publish)
    publisher.start()
    try:
        # The old implementation has no lower-bound parameter. Replay that
        # exact interface too, to prove its observable result is a false green.
        kwargs = {"since": 2} if "since" in inspect.signature(pipeline.wait).parameters else {}
        with patch.object(pipeline.deploy_stage_wait, "wait_for_stages", return_value=(0, {"event": "passed"})):
            result = pipeline.wait(state, timeout=2, **kwargs)
        assert result == 1, f"stale green receipt returned exit={result} before the new failed run"
        print("old green receipt ignored until new failure: ok")
    finally:
        publisher.join()


def check_wait_follows_supersede_behind_stage_failure(tmp: Path) -> None:
    """A stage failure is reported before the supervisor hook runs; if the
    attempt was superseded meanwhile the waiter follows the new attempt
    instead of reporting the discarded failure."""
    pipeline = load_module("pipeline_wait_supersede", DRIVER)
    state = tmp / "supersede-wait"
    state.mkdir()
    stages = tmp / "supersede-stages"
    stages.mkdir()
    first = {"status": "failing", "attempt": 1, "started_epoch": 1, "stage_run_dir": str(stages),
             "source": {"head": "a", "digest": "b"}, "supervisor_pid": os.getpid(), "follow_source": True,
             "lanes": {"x": {"status": "failed", "exit": 1}}}
    pipeline.write_receipt(state / "receipt.json", first)
    calls: list[int] = []

    def fake_wait(*_args, **_kwargs):
        calls.append(1)
        if len(calls) == 1:  # attempt 1's failure surfaces after attempt 2 already replaced it
            pipeline.write_receipt(state / "receipt.json", {**first, "attempt": 2, "started_epoch": 3,
                                                            "status": "passed", "lanes": {"x": {"status": "passed"}}})
            return (1, {"event": "failed", "failed": ["x"]})
        return (0, {"event": "passed"})

    with patch.object(pipeline.deploy_stage_wait, "wait_for_stages", side_effect=fake_wait):
        result = pipeline.wait(state, timeout=5, since=0)
    assert result == 0 and len(calls) == 2, (result, calls)
    print("waiter follows a supersede behind a stage failure: ok")


def check_interrupted_rounds_and_dead_supervisor_deferral() -> None:
    """A signalled run (``interrupted`` receipt) is not a completed failed round
    for FIX_LOOP_CAP, and the waiter only defers a failure to a supersede while a
    live supervisor on a still-running attempt can deliver one."""
    pipeline = load_module("pipeline_interrupted_rounds", DRIVER)
    failed = {"status": "failed", "lanes": {"x": {"status": "failed", "exit": 1}}}
    interrupted = {"status": "failed", "interrupted": "SIGTERM", "lanes": {"x": {"status": "failed", "exit": 143}}}
    state = pipeline.fix_loop_state([failed, interrupted, failed], 2)
    assert state["failed_rounds"] == 2 and state["capped"], state
    state = pipeline.fix_loop_state([interrupted, interrupted, interrupted], 2)
    assert state["failed_rounds"] == 0 and not state["capped"], "interrupted runs counted as completed rounds"
    # Deferral predicate: terminal receipt or dead supervisor must not defer (the waiter would spin forever).
    dead = {"status": "failed", "follow_source": True, "supervisor_pid": 2**22 - 1, "source": {"head": "a", "digest": "b"}}
    assert not pipeline._supervisor_alive(dead), "pid sentinel unexpectedly alive"
    assert dead.get("status") != "running"
    # A freeze without head/digest (tests patch source_digest to {}) renders "-" instead of raising.
    assert pipeline._source_label({}) == "head=- digest=-" and pipeline._source_label(None) == "head=- digest=-"
    assert pipeline._source_label({"head": "abc", "digest": "0123456789abcdef"}) == "head=abc digest=0123456789ab"
    print("interrupted rounds + dead-supervisor deferral + source label: ok")


def check_exclusive_lane_resizes_to_free_memory(tmp: Path, env: dict[str, str]) -> None:
    """The exclusive structural lane is planned against the budget measured at
    plan time; when less is free at admission it runs narrower instead of being
    refused (PR1634 coordinator, 2026-10-29), and is still refused below one
    worker. Exact widths: the pure fitter; the driver: a real narrowed spawn."""
    pipeline = load_module("pipeline_fit_exclusive", DRIVER)
    declared = pipeline.structural_lane_memory_mb
    lane = pipeline.Lane("deploy-command-structural",
                         ["python3", "scripts/run-deploy-structural-gates.py", "--max-workers", "3"],
                         memory_mb=declared(3), exclusive=True)
    fitted = pipeline.fit_exclusive_lane(lane, declared(2) + 50)
    assert fitted.command[-2:] == ["--max-workers", "2"] and fitted.memory_mb == declared(2), fitted
    assert pipeline.fit_exclusive_lane(lane, declared(9)).command[-1] == "3", "never wider than planned"
    assert pipeline.fit_exclusive_lane(lane, declared(1) - 1) is None, "below one worker stays a refusal"
    assert pipeline.fit_exclusive_lane(pipeline.Lane("other", ["true"], exclusive=False), 10**6) is None
    assert pipeline.fit_exclusive_lane(pipeline.Lane("no-flag", ["true"], exclusive=True), 10**6) is None
    # CodeRabbit on #1658: the structural formula sizes only the structural
    # runner's own command; a custom exclusive plan lane keeps its declaration.
    custom = pipeline.Lane("custom-exclusive", ["python3", "x.py", "--max-workers", "3"], memory_mb=5000,
                           exclusive=True)
    assert pipeline.fit_exclusive_lane(custom, 10**6) is None and custom.memory_mb == 5000, custom
    assert pipeline.fit_exclusive_lane(custom, 4000) is None, "never resized by the structural formula"
    state = tmp / "resize"
    plan = tmp / "resize-plan.json"
    probe = tmp / "resize-args.txt"
    write_plan(plan, [{"name": "structural", "exclusive": True, "reuse_passed": False,
                       "memory_mb": declared(3),
                       "command": ["bash", "-c", f"printf '%s\\n' \"$@\" > {probe}",
                                   "scripts/run-deploy-structural-gates.py", "--max-workers", "3"]}])
    # The scenario owns its host sample: on a loaded host (the deploy runs this
    # beside its other gates) live MemAvailable alone can be below one worker,
    # and the lane would be refused for host load instead of fitted to the budget.
    roomy = {"cpus": 8, "mem_available_mb": pipeline.MEMORY_RESERVE_MB + declared(9)}
    run = run_driver("run", "--plan", str(plan), "--state-dir", str(state), "--max-parallel", "0",
                     "--memory-budget-mb", str(declared(2) + 50), env=env, host=roomy)
    assert run.returncode == 0, run.stdout + run.stderr
    receipt = json.loads((state / "receipt.json").read_text())["lanes"]["structural"]
    args = probe.read_text().split()
    workers = int(args[args.index("--max-workers") + 1])
    assert receipt["status"] == "passed" and 1 <= workers <= 2, (receipt, args)
    assert receipt["note"].startswith(f"resized: 3 -> {workers} workers") and "PIPELINE_LANE_RESIZED" in run.stdout, \
        (receipt, run.stdout)
    assert receipt["memory_mb"] == declared(workers), receipt
    run = run_driver("run", "--plan", str(plan), "--state-dir", str(state), "--max-parallel", "0",
                     "--memory-budget-mb", "1000", env=env, host=roomy)
    receipt = json.loads((state / "receipt.json").read_text())["lanes"]["structural"]
    assert run.returncode == 1 and receipt["status"] == "failed" and receipt["note"].startswith("refused: needs"), receipt
    print("exclusive lane resize: ok")


def check_lane_scoped_reuse(tmp: Path, env: dict[str, str], source_root: Path) -> None:
    """Plan ``lane_scoped_reuse`` passes ``--lane-scoped-reuse`` to every lane;
    a docs-only commit then turns the scoped lanes into ``reused-scoped``
    receipt lanes with the stage row's provenance, the run is green for
    ``wait``/``verify`` and nothing executed; without the field (default) the
    same commit reruns both lanes and records plain passes."""
    state = tmp / "scoped-state"
    counters = tmp / "scoped-counters"
    counters.mkdir()
    # Own stage run and duration ledger: these real lane names must not seed
    # the phase estimates of the other scenarios with 0-second passes.
    ledger = tmp / "scoped-lanes.json"
    env = {**env, "DEPLOY_RUN_ROOT": str(tmp / "scoped-runs"), "DEPLOY_PIPELINE_LANE_DURATIONS": str(ledger)}
    # Timing runs bound to the fixture repo: cross-run discovery compares the
    # branch each run's metadata recorded, which must be the fixture's.
    start_timing(tmp / "scoped-runs", env, cwd=source_root)
    git = ["git", "-C", str(source_root), "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"]

    def commit_docs(text: str) -> str:
        (source_root / "docs" / "guide.md").write_text(text)
        subprocess.run([*git, "add", "docs/guide.md"], check=True)
        subprocess.run([*git, "commit", "-qm", "docs"], check=True)
        return subprocess.run([*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()

    markers = {"backend-coverage-blackbox": "npm run test:coverage:sharded", "smoke": "bash scripts/run-predeploy-local",
               "live-probes": "python3 scripts/run_deploy_live_probes.py"}

    def lane(name: str, **extra: object) -> dict:
        # $0 carries the lane's real command marker; a lane name alone is never scoped.
        return {"name": name, "command": ["bash", "-c", f'printf run >> "{counters / name}"', markers.get(name, "_")],
                "reuse_passed": False, "memory_mb": 1, **extra}

    def runs(name: str) -> int:
        return len((counters / name).read_text()) // 3 if (counters / name).exists() else 0

    def run_and_wait(plan: Path) -> dict:
        since = time.time()
        ran = run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=env)
        assert ran.returncode == 0, ran.stderr + ran.stdout
        waited = run_driver("wait", "--state-dir", str(state), "--timeout", "20", "--since", str(since), env=env)
        assert waited.returncode == 0, waited.stdout
        return json.loads((state / "receipt.json").read_text())

    lanes = [lane("backend-coverage-blackbox", group="3"), lane("smoke", group="4", phase="coverage"),
             lane("quick-gate", group="3"),
             # Scoped lane whose own env carries the kill switch: it reruns while its siblings reuse.
             lane("live-probes", group="4", env={"DEPLOY_LANE_SCOPED_REUSE": "0"})]
    plan = tmp / "scoped-plan.json"
    write_plan(plan, lanes, lane_scoped_reuse=True)
    first_head = subprocess.run([*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    receipt = run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=env)
    assert receipt.returncode == 0, receipt.stderr
    receipt = json.loads((state / "receipt.json").read_text())
    assert receipt["lane_scoped_reuse"] is True and receipt["reused_scoped_lanes"] == []
    assert {name: lane["status"] for name, lane in receipt["lanes"].items()} == {
        "backend-coverage-blackbox": "passed", "smoke": "passed", "quick-gate": "passed", "live-probes": "passed"}, \
        receipt["lanes"]
    assert runs("backend-coverage-blackbox") == 1 and runs("smoke") == 1 and runs("quick-gate") == 1
    assert all(lane["lane_token"].startswith(f"{name}.1.") for name, lane in receipt["lanes"].items()), receipt["lanes"]

    second_head = commit_docs("guide v2\n")
    receipt = run_and_wait(plan)
    assert receipt["status"] == "passed", receipt["status"]
    assert receipt["reused_scoped_lanes"] == ["backend-coverage-blackbox", "smoke"], receipt["reused_scoped_lanes"]
    for name in ("backend-coverage-blackbox", "smoke"):
        lane_state = receipt["lanes"][name]
        assert lane_state["status"] == "reused-scoped", (name, lane_state)
        assert lane_state["exit"] == 0
        reuse = lane_state["reuse"]
        assert reuse["kind"] == "scoped" and reuse["hit"] is True, reuse
        assert reuse["passed_head"] == first_head and reuse["current_head"] == second_head, reuse
        assert len(reuse["passed_fingerprint"]) == 64 and reuse["passed_run_id"], reuse
        assert reuse["changed"] == [{"path": "docs/guide.md", "rule": "inert:docs/*",
                                     "graph": reuse["changed"][0]["graph"]}], reuse["changed"]
        assert reuse["changed"][0]["graph"].startswith("graph:no "), reuse["changed"][0]
        assert runs(name) == 1, f"{name} executed despite the scoped reuse"
    # A lane the scoped table does not list keeps today's behaviour: it reruns.
    assert receipt["lanes"]["quick-gate"]["status"] == "passed" and runs("quick-gate") == 2
    # The kill switch in a lane's own env reruns that lane as a plain pass.
    assert receipt["lanes"]["live-probes"]["status"] == "passed" and runs("live-probes") == 2
    assert "reuse" not in receipt["lanes"]["live-probes"]
    run_dir = Path(receipt["stage_run_dir"])
    rows = [json.loads(line) for line in (run_dir / "stages.jsonl").read_text().splitlines() if line.strip()]
    scoped_rows = [row for row in rows if row.get("status") == "reused-scoped"]
    assert sorted(row["stage"] for row in scoped_rows) == ["backend-coverage-blackbox", "smoke"], scoped_rows
    assert all(row["detail"]["reuse"]["passed_head"] == first_head for row in scoped_rows)
    verified = run_driver("verify", "--state-dir", str(state), "--expect-head", second_head, env=env)
    assert verified.returncode == 0, verified.stdout
    assert "reused_scoped=backend-coverage-blackbox,smoke" in verified.stdout, verified.stdout
    # A reused-scoped lane records no duration sample: nothing was measured.
    recorded = json.loads(ledger.read_text())["lanes"]
    assert all(sample.get("status") != "reused-scoped" for samples in recorded.values() for sample in samples)
    assert len(recorded["smoke"]) == 1 and len(recorded["quick-gate"]) == 2, recorded
    assert receipt["reused_scoped_cross_run_lanes"] == [], receipt["reused_scoped_cross_run_lanes"]

    # Cross-run: the green run is closed (--finish) and a test-only sync needs
    # a new --start run. Its own passed-cache is empty, so the scoped lanes
    # reuse the first run's records in place (same branch, ancestor head,
    # fresh): the receipt names the source run and lists the lanes as
    # cross-run reuse; nothing executes and no duration is recorded.
    first_run_id = finish_timing(env)
    first_run_dir = tmp / "scoped-runs" / first_run_id
    start_timing(tmp / "scoped-runs", env, cwd=source_root)
    cross_head = commit_docs("guide v2 cross-run\n")
    receipt = run_and_wait(plan)
    assert receipt["status"] == "passed", receipt["status"]
    assert receipt["stage_run_dir"] != str(first_run_dir), receipt["stage_run_dir"]
    assert receipt["reused_scoped_lanes"] == ["backend-coverage-blackbox", "smoke"], receipt["reused_scoped_lanes"]
    assert receipt["reused_scoped_cross_run_lanes"] == ["backend-coverage-blackbox", "smoke"], \
        receipt["reused_scoped_cross_run_lanes"]
    for name in ("backend-coverage-blackbox", "smoke"):
        lane_state = receipt["lanes"][name]
        assert lane_state["status"] == "reused-scoped" and lane_state["exit"] == 0, (name, lane_state)
        reuse = lane_state["reuse"]
        assert reuse["kind"] == "scoped" and reuse["hit"] is True and reuse["cross_run"] is True, reuse
        assert reuse["passed_run_id"] == first_run_id and reuse["passed_run_dir"] == str(first_run_dir), reuse
        assert reuse["passed_head"] == first_head and reuse["current_head"] == cross_head, reuse
        record = Path(reuse["passed_record"])
        assert record.parent == first_run_dir / "passed-cache" / name / "scoped" and record.is_file(), reuse
        assert reuse["considered_runs"] == [Path(receipt["stage_run_dir"]).name, first_run_id], reuse
        assert runs(name) == 1, f"{name} executed despite the cross-run scoped reuse"
    assert not (Path(receipt["stage_run_dir"]) / "passed-cache" / "smoke").exists(), "record copied into the new run"
    assert receipt["lanes"]["quick-gate"]["status"] == "passed" and runs("quick-gate") == 3
    assert receipt["lanes"]["live-probes"]["status"] == "passed" and runs("live-probes") == 3
    verified = run_driver("verify", "--state-dir", str(state), "--expect-head", cross_head, env=env)
    assert verified.returncode == 0, verified.stdout
    assert "reused_scoped=backend-coverage-blackbox,smoke cross_run=backend-coverage-blackbox,smoke" in verified.stdout, \
        verified.stdout
    recorded = json.loads(ledger.read_text())["lanes"]
    assert all(sample.get("status") != "reused-scoped" for samples in recorded.values() for sample in samples)
    assert len(recorded["smoke"]) == 1 and len(recorded["quick-gate"]) == 3, recorded

    # Default off: the same kind of commit reruns both lanes as plain passes.
    write_plan(plan, lanes)
    third_head = commit_docs("guide v3\n")
    receipt = run_and_wait(plan)
    assert receipt["lane_scoped_reuse"] is False and receipt["reused_scoped_lanes"] == []
    assert {name: lane["status"] for name, lane in receipt["lanes"].items()} == {
        "backend-coverage-blackbox": "passed", "smoke": "passed", "quick-gate": "passed", "live-probes": "passed"}, \
        receipt["lanes"]
    assert runs("backend-coverage-blackbox") == 2 and runs("smoke") == 2, "flag off must rerun"
    assert "reuse" not in receipt["lanes"]["smoke"]
    verified = run_driver("verify", "--state-dir", str(state), "--expect-head", third_head, env=env)
    assert verified.returncode == 0 and "reused_scoped=- cross_run=-" in verified.stdout, verified.stdout
    # The environment can never enable: the same plan with DEPLOY_LANE_SCOPED_REUSE=1 still reruns.
    fourth_head = commit_docs("guide v4\n")
    since = time.time()
    ran = run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED,
                     env={**env, "DEPLOY_LANE_SCOPED_REUSE": "1"})
    assert ran.returncode == 0, ran.stderr
    receipt = json.loads((state / "receipt.json").read_text())
    assert receipt["lane_scoped_reuse"] is False and receipt["reused_scoped_lanes"] == [], receipt["reused_scoped_lanes"]
    assert runs("smoke") == 3 and receipt["lanes"]["smoke"]["status"] == "passed", receipt["lanes"]["smoke"]
    assert receipt["source"]["head"] == fourth_head and since > 0

    # Cross-deploy reuse on a tooling change (PR-14): a script only the
    # coverage runners execute, a backend unit test and a docs page change
    # after a green run that was closed. The stack lanes (smoke,
    # semantic-stack) judge the script by reach and reuse the earlier run's
    # pass in place; the coverage lanes rerun and name the paths that blocked
    # them; each rerun lane's log starts with its own (flushed) decision.
    tooling_counters = tmp / "scoped-tooling-counters"
    tooling_counters.mkdir()
    tooling_markers = {"backend-coverage-blackbox": "npm run test:coverage:sharded",
                       "agents-coverage-blackbox": "bash scripts/run-coverage.sh",
                       "smoke": "bash scripts/run-predeploy-local",
                       "semantic-stack": "bash front-end/scripts/run-semantic-tests.sh"}

    def tooling_lane(name: str) -> dict:
        return {"name": name, "reuse_passed": False, "memory_mb": 1,
                "command": ["bash", "-c", f'printf run >> "{tooling_counters / name}"; echo TOOLING-LANE-OUTPUT',
                            tooling_markers[name]]}

    def tooling_runs(name: str) -> int:
        return len((tooling_counters / name).read_text()) // 3 if (tooling_counters / name).exists() else 0

    tooling_plan = tmp / "scoped-tooling-plan.json"
    write_plan(tooling_plan, [tooling_lane(name) for name in tooling_markers], lane_scoped_reuse=True)
    receipt = run_and_wait(tooling_plan)
    assert receipt["status"] == "passed" and receipt["reused_scoped_lanes"] == [], receipt
    assert all(tooling_runs(name) == 1 for name in tooling_markers), {name: tooling_runs(name) for name in tooling_markers}
    base_run_id = finish_timing(env)
    base_run_dir = tmp / "scoped-runs" / base_run_id
    script = "back-end/scripts/coverage-process-lock.py"
    unit_test = "back-end/src/tests/unit/coverage-process-registry.test.ts"
    (source_root / script).write_text("import json\nTIMEOUT = 2\n")
    (source_root / unit_test).write_text((source_root / unit_test).read_text() + "// v2\n")
    (source_root / "docs" / "guide.md").write_text("guide v5\n")
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run([*git, "commit", "-qm", "tooling"], check=True)
    tooling_head = subprocess.run([*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    start_timing(tmp / "scoped-runs", env, cwd=source_root)
    receipt = run_and_wait(tooling_plan)
    assert receipt["status"] == "passed", receipt["status"]
    new_run_dir = Path(receipt["stage_run_dir"])
    assert new_run_dir != base_run_dir
    assert receipt["reused_scoped_lanes"] == ["semantic-stack", "smoke"], receipt["reused_scoped_lanes"]
    assert receipt["reused_scoped_cross_run_lanes"] == ["semantic-stack", "smoke"], receipt["reused_scoped_cross_run_lanes"]
    for name in ("smoke", "semantic-stack"):
        lane_state = receipt["lanes"][name]
        assert lane_state["status"] == "reused-scoped" and lane_state["exit"] == 0, (name, lane_state)
        reuse = lane_state["reuse"]
        assert reuse["hit"] is True and reuse["cross_run"] is True, reuse
        assert reuse["passed_run_id"] == base_run_id and reuse["passed_run_dir"] == str(base_run_dir), reuse
        assert reuse["passed_head"] == fourth_head and reuse["current_head"] == tooling_head, reuse
        assert reuse["passed_run_branch"] == subprocess.run(
            [*git, "branch", "--show-current"], check=True, capture_output=True, text=True).stdout.strip(), reuse
        changed = {entry["path"]: entry for entry in reuse["changed"]}
        assert set(changed) == {script, unit_test, "docs/guide.md"}, changed
        assert changed[script]["rule"] == "not in the lane's declared inert set; stack lane: judged by reach", changed
        assert changed[script]["graph"] == "graph:no ALL fallback; unreached from the stack entrypoints", changed
        assert changed[unit_test]["rule"] == "inert:back-end/src/tests/*", changed
        assert changed["docs/guide.md"]["rule"] == "inert:docs/*", changed
        assert tooling_runs(name) == 1, f"{name} executed despite the cross-deploy scoped reuse"
        assert not (new_run_dir / "passed-cache" / name).exists(), "record copied into the new run"
        log = Path(lane_state["log"]).read_text()
        assert f"== reused passed deploy stage (lane-scoped): {name} " in log, log[-800:]
    rows = [json.loads(line) for line in (new_run_dir / "stages.jsonl").read_text().splitlines() if line.strip()]
    for name, blocked_paths in (("backend-coverage-blackbox", [script, unit_test]), ("agents-coverage-blackbox", [script])):
        lane_state = receipt["lanes"][name]
        assert lane_state["status"] == "passed" and tooling_runs(name) == 2, (name, lane_state, tooling_runs(name))
        [row] = [row for row in rows if row["stage"] == name]
        scoped = row["detail"]["reuse"]["scoped"]
        assert scoped["miss_reason"] == f"{len(blocked_paths)} changed path(s) are not provably inert", scoped
        assert [entry["path"] for entry in scoped["blocked"]] == blocked_paths, scoped["blocked"]
        assert all(entry["rule"] == "not in the lane's declared inert set" for entry in scoped["blocked"]), scoped
        # The decision line is flushed before the command starts: the lane
        # log's last round begins with its own miss, not the previous one's.
        log = Path(lane_state["log"]).read_text()
        miss = f"== lane-scoped reuse unavailable for {name}: {scoped['miss_reason']} =="
        assert miss in log, log[-800:]
        tail = log[log.rindex(miss):]
        assert "TOOLING-LANE-OUTPUT" in tail, f"{name}: the decision must precede the command's first output byte"
        assert tail.index(f"== deploy stage: {name} ==") < tail.index("TOOLING-LANE-OUTPUT"), tail[:600]
        for path in blocked_paths:
            assert f"   rerun: {path} (not in the lane's declared inert set; graph not consulted)" in tail, tail[:600]
    verified = run_driver("verify", "--state-dir", str(state), "--expect-head", tooling_head, env=env)
    assert verified.returncode == 0, verified.stdout
    assert "reused_scoped=semantic-stack,smoke cross_run=semantic-stack,smoke" in verified.stdout, verified.stdout


def check_reconcile_reused_lane(tmp: Path) -> None:
    """The receipt relabels a 0-exit lane from its own stage row whatever the
    plan enabled: by the per-launch token at any start time, or (token-less,
    older receipts) by a row that started between the lane's start and its
    finish; a row from outside that window or another token never matches,
    and the duration ledger skips reused-scoped rows."""
    pipeline = load_module("reconcile_pipeline", DRIVER)
    run_dir = tmp / "reconcile-run"
    run_dir.mkdir()
    base = 1_700_000_000.0
    provenance = {"kind": "scoped", "passed_head": "a" * 40, "current_head": "b" * 40, "changed": []}
    cross_run_provenance = {**provenance, "cross_run": True, "passed_run_id": "earlier", "passed_run_dir": "/runs/earlier"}

    def row(stage: str, status: str, started: float, token: str | None) -> dict:
        reuse = cross_run_provenance if stage == "backend-coverage-blackbox" else provenance
        detail = {"reuse": reuse if status == "reused-scoped" else {"requested": False}}
        if token:
            detail["lane_token"] = token
        return {"stage": stage, "status": status, "started_epoch": started, "finished_epoch": started + 1.0,
                "exit_code": 0, "duration_seconds": 1.0, "detail": detail}

    rows = [
        row("smoke", "reused-scoped", base + 20.0, "smoke.1.tok"),          # token match, 20 s after spawn
        row("backend-coverage-blackbox", "reused-scoped", base + 40.0, None),  # token-less, inside the window
        row("live-probes", "reused-scoped", base + 200.0, None),           # token-less, after the lane finished
        row("semantic-stack", "reused-scoped", base + 1.0, "semantic-stack.1.other"),  # another launch's token
        row("agents-coverage-blackbox", "passed", base + 1.0, "agents.1.tok"),
    ]
    (run_dir / "stages.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    receipt = {"stage_run_dir": str(run_dir), "lane_scoped_reuse": False, "reused_scoped_lanes": [], "lanes": {
        "smoke": {"status": "running", "started_epoch": base, "lane_token": "smoke.1.tok"},
        "backend-coverage-blackbox": {"status": "running", "started_epoch": base},
        "live-probes": {"status": "running", "started_epoch": base},
        "semantic-stack": {"status": "running", "started_epoch": base, "lane_token": "semantic-stack.1.tok"},
        "agents-coverage-blackbox": {"status": "running", "started_epoch": base, "lane_token": "agents.1.tok"},
    }}
    finished = base + 100.0
    outcomes = {name: pipeline.reconcile_reused_lane(receipt, name, state, finished_epoch=finished)
                for name, state in receipt["lanes"].items()}
    assert outcomes == {"smoke": "reused-scoped", "backend-coverage-blackbox": "reused-scoped", "live-probes": "passed",
                        "semantic-stack": "passed", "agents-coverage-blackbox": "passed"}, outcomes
    assert receipt["lanes"]["smoke"]["reuse"] == provenance and "reuse" not in receipt["lanes"]["live-probes"]
    assert receipt["reused_scoped_lanes"] == ["backend-coverage-blackbox", "smoke"], receipt["reused_scoped_lanes"]
    # Only the lane whose row says cross_run is listed as a cross-run reuse.
    assert receipt["lanes"]["backend-coverage-blackbox"]["reuse"] == cross_run_provenance
    assert receipt["reused_scoped_cross_run_lanes"] == ["backend-coverage-blackbox"], receipt["reused_scoped_cross_run_lanes"]
    assert pipeline.overall({"a": {"status": "reused-scoped"}, "b": {"status": "passed"}}) == "passed"
    assert pipeline.overall({"a": {"status": "reused-scoped"}, "b": {"status": "running"}}) == "running"
    # An older driver's receipt that still says "passed" records no sample for a reused-scoped row.
    ledger = tmp / "reconcile-ledger.json"
    stale = {"stage_run_dir": str(run_dir), "lanes": {
        "smoke": {"status": "passed", "started_epoch": base, "finished_epoch": finished, "wall_s": 100.0,
                  "lane_token": "smoke.1.tok"},
        "agents-coverage-blackbox": {"status": "passed", "started_epoch": base, "finished_epoch": base + 2.0,
                                     "wall_s": 2.0, "lane_token": "agents.1.tok"},
    }}
    recorded = pipeline.record_lane_durations(stale, ledger)
    assert "smoke" not in recorded and len(recorded["agents-coverage-blackbox"]) == 1, recorded
    print("reconcile reused lane: ok")


def check_cross_run_record_guards(tmp: Path, source_root: Path) -> None:
    """The cross-run guards, each against the real decision over the fixture
    repo: a later-started run is not a source while an earlier run of another
    branch is (its branch is recorded, never compared; PR-14); a record is
    accepted only with a finite, non-future ``finished_epoch`` (future-dated
    ones would sort first and outrank every failed head), within the bound,
    with a passed head that is an ancestor of HEAD and carrying its own run's
    id; and a candidate whose bytes change between the read and the hit is
    never reused."""
    stage = load_module("stage_guards", source_root / "scripts" / "run_deploy_stage.py")
    git = ["git", "-C", str(source_root)]
    head = subprocess.run([*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    branch = subprocess.run([*git, "branch", "--show-current"], check=True, capture_output=True, text=True).stdout.strip()
    assert branch, "fixture repo must be on a branch"
    run_root = tmp / "guard-runs"
    now = time.time()

    def run_dir(name: str, started: float, run_branch: str = branch) -> Path:
        path = run_root / name
        path.mkdir(parents=True)
        (path / "metadata.json").write_text(json.dumps({"schema_version": 1, "run_id": name, "status": "completed",
                                                          "started_epoch": started, "branch": run_branch}))
        return path

    current = run_dir("cur", now - 100)
    earlier = run_dir("earlier", now - 200)
    oldest = run_dir("oldest", now - 300)
    run_dir("later", now)                      # started after the current run: never a source
    run_dir("same-start", now - 100)           # not strictly earlier
    other_branch = run_dir("other-branch", now - 250, "other")
    run_dir("no-branch", now - 260, "")        # no branch recorded: still a source (guards decide)
    (run_root / "no-metadata").mkdir()
    (run_root / "bad-json").mkdir()
    (run_root / "bad-json" / "metadata.json").write_text("{not-json")
    (run_root / "current").write_text("cur\n")  # the pointer file is not a run
    considered = stage._considered_runs(run_root, current)
    assert [(run.run_id, run.cross_run, run.branch) for run in considered] == \
        [("cur", False, branch), ("earlier", True, branch), ("other-branch", True, "other"),
         ("no-branch", True, None), ("oldest", True, branch)], considered

    command = ["bash", "scripts/run-predeploy-local"]
    invocation = stage._invocation_digest(command)

    def write_record(run: Path, name: str, directory: str = "scoped", **overrides: object) -> Path:
        record = {"schema_version": 1, "stage": "smoke", "head": head, "fingerprint": "f" * 64, "run_id": run.name,
                  "exit_code": 0, "finished_at": "2026-01-01T00:00:00Z", "finished_epoch": now - 10,
                  "invocation": invocation, "dirty_paths": [], **overrides}
        path = run / "passed-cache" / "smoke" / directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record) + "\n")
        return path

    real = write_record(earlier, "real.json")
    write_record(earlier, "future.json", finished_epoch=now + 10 * 365 * 86400)
    write_record(earlier, "nan.json", finished_epoch=float("nan"))
    write_record(earlier, "old.json", finished_epoch=now - 25 * 3600)
    write_record(earlier, "foreign.json", run_id="cur")
    write_record(current, "in-run-future.json", finished_epoch=now + 60)
    # Another branch with an ancestor head is a source; the same branch with a
    # non-ancestor head is not.
    other = write_record(other_branch, "other.json", run_id="other-branch", finished_epoch=now - 20)
    with patch.object(stage, "_is_ancestor", lambda ancestor, descendant: ancestor != "0" * 40):
        write_record(oldest, "sibling.json", head="0" * 40)
        records, rejected = stage._scoped_records_across_runs(
            considered, "smoke", invocation, failed=False, current_head=head, now=now)
    assert rejected == {"age": 4, "not_ancestor": 1, "foreign_run_id": 1}, rejected
    assert [record["_record_path"] for record in records] == [str(real), str(other)], records
    assert records[0]["_source"] == {"run_id": "earlier", "run_dir": str(earlier), "cross_run": True,
                                     "branch": branch}
    assert records[1]["_source"] == {"run_id": "other-branch", "run_dir": str(other_branch), "cross_run": True,
                                     "branch": "other"}
    other.unlink()
    # Failures are never filtered: every one of them can veto.
    failed = write_record(earlier, "x.json", directory="scoped-failed", exit_code=1, finished_epoch=now + 60)
    failures, _ = stage._scoped_records_across_runs(
        considered, "smoke", invocation, failed=True, current_head=head, now=now)
    assert [record["_record_path"] for record in failures] == [str(failed)], failures
    failed.unlink()
    for extra in ("future.json", "nan.json", "old.json", "foreign.json"):
        (earlier / "passed-cache" / "smoke" / "scoped" / extra).unlink()
    (current / "passed-cache" / "smoke" / "scoped" / "in-run-future.json").unlink()
    (oldest / "passed-cache" / "smoke" / "scoped" / "sibling.json").unlink()

    # _record_is_intact: the bytes read must still be the bytes on disk.
    [loaded] = stage._load_scoped_records(real.parent, "smoke", invocation)
    assert stage._record_is_intact(loaded)
    original = real.read_bytes()
    real.write_bytes(original + b"\n")
    assert not stage._record_is_intact(loaded)
    real.write_bytes(original)
    assert stage._record_is_intact(loaded)
    assert not stage._record_is_intact({"_record_digest": loaded["_record_digest"]})

    # The real decision over the fixture repo: the cross-run record is the
    # hit; when its bytes change after the read (inside the judge, before the
    # hit) the decision misses and says so.
    rules = stage._SCOPED_REUSE_LANES["smoke"]

    def inert_judge(rules, changed, judge):
        return [{"path": path, "rule": "inert:test"} for path in changed], [], judge

    def mutate_then_judge(rules, changed, judge):
        real.write_bytes(original + b"\n")
        return inert_judge(rules, changed, judge)

    with patch.object(stage, "_judge_changes", inert_judge):
        decision = stage._scoped_reuse_decision(run_root, current, "smoke", rules, command)
    assert decision.hit and decision.record["_record_path"] == str(real), decision.provenance()
    assert decision.provenance()["cross_run"] is True and decision.provenance()["passed_run_dir"] == str(earlier)
    assert decision.provenance()["passed_run_branch"] == branch, decision.provenance()
    with patch.object(stage, "_judge_changes", mutate_then_judge):
        decision = stage._scoped_reuse_decision(run_root, current, "smoke", rules, command)
    assert not decision.hit, decision.provenance()
    assert decision.miss_reason == "1 candidate record(s) changed or vanished before the hit", decision.miss_reason
    real.write_bytes(original)

    def vanish_then_judge(rules, changed, judge):
        real.unlink()
        return inert_judge(rules, changed, judge)

    with patch.object(stage, "_judge_changes", vanish_then_judge):
        decision = stage._scoped_reuse_decision(run_root, current, "smoke", rules, command)
    assert not decision.hit and decision.candidates == 1, decision.provenance()
    print("cross-run record guards: ok")


def check_scoped_inert_tables() -> None:
    """Pin the lane-scoped reuse tables: the exact never-inert patterns, the
    scoped lanes with their command markers, inert sets and graph lanes, and
    negative probes for paths the lanes are known to execute."""
    stage = load_module("stage_tables", ROOT / "scripts" / "run_deploy_stage.py")
    docs = ("docs/*", "README.md", "*/README.md", "research/*", "pitch-deck/*", "prompt-review/*", "claude-code-src/*")
    agents_tests = ("agents/tests/blackbox/*", "agents/tests/unit/*", "agents/tests/demo_cache/*")
    backend_tests, frontend_tests, mac_tests, script_tests = \
        ("back-end/src/tests/*",), ("front-end/src/tests/*",), ("mac-app/tests/*",), ("scripts/tests/*",)
    assert stage._NEVER_INERT == (".claude/*", "CLAUDE.md", "AGENTS.md", "*/CLAUDE.md", "*/AGENTS.md", ".github/*",
                                  ".conductor/*", ".cursor/*"), stage._NEVER_INERT
    expected = {
        "backend-coverage-blackbox": ((*docs, *agents_tests, *frontend_tests, *mac_tests),
                                      ("backend-blackbox", "backend-unit"), ("test:coverage:sharded", "run-coverage-sharded")),
        "live-probes": ((*docs, *agents_tests, *frontend_tests, *mac_tests),
                        ("backend-blackbox", "backend-unit"), ("run_deploy_live_probes.py",)),
        "agents-coverage-blackbox": ((*docs, *backend_tests, *frontend_tests, *mac_tests),
                                     ("agents-blackbox", "agents-pytest"), ("run-coverage.sh",)),
        "smoke": ((*docs, *agents_tests, *backend_tests, *frontend_tests, *mac_tests, *script_tests), (),
                  ("run-predeploy-local",)),
        "semantic-stack": ((*docs, *agents_tests, *backend_tests, *frontend_tests, *mac_tests, *script_tests), (),
                           ("run-semantic-tests.sh",)),
    }
    assert set(stage._SCOPED_REUSE_LANES) == set(expected), sorted(stage._SCOPED_REUSE_LANES)
    for name, (inert, graph_lanes, markers) in expected.items():
        rules = stage._SCOPED_REUSE_LANES[name]
        assert rules.inert == inert, (name, rules.inert)
        assert rules.graph_lanes == graph_lanes and rules.markers == markers, (name, rules.graph_lanes, rules.markers)
    # The lane name alone never selects an inert set; the real command does.
    assert stage._scoped_lane("smoke", ["bash", "scripts/tests/foo.sh"]) is None
    assert stage._scoped_lane("smoke", ["bash", "scripts/run-predeploy-local"]) is stage._SCOPED_REUSE_LANES["smoke"]
    assert stage._scoped_lane("backend-coverage-blackbox", ["npm", "run", "test:coverage:sharded"]) is not None
    assert stage._scoped_lane("backend-coverage-blackbox", ["npm", "run", "test:coverage"]) is None
    assert stage._scoped_lane("agentcard-lifecycle", ["bash", "scripts/run-bench", "--local"]) is None
    # Paths the lanes execute are never inert: run_benchmark.py and
    # direct_chat_latency.py import agents/tests/e2e and agents/tests/env_defaults.py;
    # backend coverage runs scripts/tests/blackbox-backend-teardown.test.sh; the
    # agents benchmark domain executes scripts/tests fixtures; semantic runs
    # front-end/tests-e2e specs; prompts and skills ship as Markdown.
    def inert(name: str, path: str) -> bool:
        return stage._judge_declared(path, stage._SCOPED_REUSE_LANES[name])[0]

    every = list(expected)
    for path in ("agents/tests/e2e/test_helpers.py", "agents/tests/env_defaults.py", "front-end/tests-e2e/chat.spec.ts",
                 ".claude/commands/deploy.md", ".claude/skills/x/SKILL.md", "CLAUDE.md", "agents/CLAUDE.md", "AGENTS.md",
                 "agents/prompts/system.md", "back-end/src/prompts/router.md", "agents/benchmarks/tasks.json",
                 "agents/benchmarks/history/task_attempts.jsonl", "back-end/prisma/schema.prisma", "package-lock.json",
                 ".github/workflows/ci.yml", "scripts/run_deploy_stage.py"):
        assert not any(inert(name, path) for name in every), f"{path} must not be inert for any lane"
    for name in ("backend-coverage-blackbox", "live-probes", "agents-coverage-blackbox"):
        assert not inert(name, "scripts/tests/blackbox-backend-teardown.test.sh"), name
    for name in ("smoke", "semantic-stack"):
        assert inert(name, "scripts/tests/some-gate.test.sh"), name
    for name in every:
        assert inert(name, "docs/rca/cases/x.md") and inert(name, "README.md") and inert(name, "agents/README.md"), name
    # Reach judgement (PR-14): the stack entrypoints are pinned and exist; only
    # a non-test code file under a tooling tree, outside the declared set of a
    # stack lane, is eligible. Everything else keeps the declared-only rule.
    assert stage.STACK_ENTRYPOINTS == STACK_ENTRYPOINTS, stage.STACK_ENTRYPOINTS
    for entrypoint in stage.STACK_ENTRYPOINTS:
        assert (ROOT / entrypoint).is_file(), f"stack entrypoint {entrypoint} is gone: update STACK_ENTRYPOINTS"
    assert stage._STACK_REACH_TREES == ("scripts/*", "back-end/scripts/*", "front-end/scripts/*", "agents/scripts/*",
                                        "mac-app/scripts/*"), stage._STACK_REACH_TREES

    def eligible(name: str, path: str) -> bool:
        return stage._reach_eligible(path, stage._SCOPED_REUSE_LANES[name])[0]

    for name in ("smoke", "semantic-stack"):
        assert eligible(name, "back-end/scripts/coverage-process-lock.py"), name
        assert eligible(name, "scripts/run_deploy_stage.py") and eligible(name, "agents/scripts/backfill_x.py"), name
        for path in ("back-end/src/domains/x/service.ts", "agents/tools/x.py", "front-end/src/App.tsx",
                     "agents/tests/e2e/test_helpers.py", "agents/tests/env_defaults.py", "front-end/tests-e2e/chat.spec.ts",
                     "agents/benchmarks/fixtures/x.json", "agents/benchmarks/tasks.json", "back-end/prisma/migrations/x/m.sql",
                     "back-end/scripts/prisma-local-push.test.sh", "scripts/tests/x.test.py", "scripts/run-bench",
                     "front-end/postcss.config.js", "front-end/playwright.config.ts", "package.json", "agents/prompts/x.md",
                     "back-end/scripts/README.md", "scripts/lib/seed-cache.sh"):
            assert not eligible(name, path) or path == "scripts/lib/seed-cache.sh", (name, path)
    for name in ("backend-coverage-blackbox", "live-probes", "agents-coverage-blackbox"):
        assert not eligible(name, "back-end/scripts/coverage-process-lock.py"), name
        assert stage._reach_eligible("scripts/x.py", stage._SCOPED_REUSE_LANES[name]) == (False, "lane has graph lanes")
    # The judge consults neither the entrypoints nor the reverse index for a
    # declared-inert path (deploy-stage gate regression: its fixture carries
    # no entrypoint and a docs-only commit reran smoke); an undeclared path
    # fails closed when an entrypoint is missing from the graph.
    class _NoSelection:
        all_lanes, reasons, selected, full_lanes = False, [], {}, set()

    class _NoEntrypointSelector:
        config = {"run_lanes": []}

        class graph:
            fileset: set = set()

        def select(self, changed):
            return _NoSelection()

        def upstream(self, changed):
            raise AssertionError("reverse index consulted for a declared-inert path")

    judge = stage._GraphJudge.__new__(stage._GraphJudge)
    judge._module, judge._selector = stage._selector_module(), _NoEntrypointSelector()
    smoke = stage._SCOPED_REUSE_LANES["smoke"]
    assert judge.judge("docs/guide.md", smoke) == (True, "graph:no ALL fallback")
    assert judge.judge("back-end/src/tests/unit/x.test.ts", smoke, declared=True) == (True, "graph:no ALL fallback")
    assert judge.judge("back-end/scripts/x.py", smoke, declared=False) == \
        (False, "graph:stack entrypoint missing: scripts/run-predeploy-local")
    assert judge.judge("docs/guide.md", stage._SCOPED_REUSE_LANES["backend-coverage-blackbox"]) == \
        (True, "graph:no backend-blackbox/backend-unit test selected")
    assert not inert("agents-coverage-blackbox", "agents/tests/blackbox/rose.blackbox.py")
    assert all(inert(n, "agents/tests/blackbox/rose.blackbox.py") for n in every if n != "agents-coverage-blackbox")
    assert not inert("backend-coverage-blackbox", "back-end/src/tests/blackbox/x.blackbox.ts")
    assert not inert("live-probes", "back-end/src/tests/unit/x.test.ts")
    assert all(inert(n, "back-end/src/tests/blackbox/x.blackbox.ts") for n in ("agents-coverage-blackbox", "smoke", "semantic-stack"))
    print("scoped inert tables: ok")


# Largest ``lanes[<name>].tree_peak_pss_mb`` the pipeline receipts recorded per
# lane (``.context/deploy-pipeline/history.jsonl`` of the 2026-10-30/31 devbox
# deploys, 43 attempts; receipt schema: ``tree_peak_pss_mb`` / ``tree_peak_anon_mb``
# on each lane, ``memory_mb`` its declaration). Recorded, never estimated.
RECORDED_LANE_PEAK_PSS_MB = {
    "deploy-command-structural": 2575.4,   # 19 samples, 3 workers
    "smoke": 3319.4,                       # 14 samples; 20261031-115354 receipt (deploy 9 round 2)
    "agents-coverage-blackbox": 743.1,     # 15 samples
    "eslint": 1857.8,                      # 19 samples
    "typescript": 1553.3,                  # 19 samples
    "backend-structural": 285.7,           # 19 samples
    "seed-cache-decision": 23.7,           # 19 samples
    "canonical-seed-whatsapp-content": 58.7,  # 19 samples
    "backend-coverage-blackbox": 4556.8,   # 15 samples
}
# Knowingly under-declared: backend coverage declares its width formula (1536
# + 512 x workers: 2560 MB here, 3072 MB at the launcher width) although its
# recorded tree peak is 3656.3 MB on run 20261031-164809-1083486 (head
# a334edca1) and 4556.8 MB in history.jsonl. The honest 1.25x declaration
# (5696 MB) would serialize it behind smoke (+18 min per round): on that run's
# 8890 MB budget the three coverage-phase peaks alone sum to 8865 MB (smoke
# 3319.4 + backend 4556.8 + agents 989.3), so no margin fits beside them. The
# lane relies on the PR-11 live-headroom admission plus the host's measured
# floor (mem_available_min 6452 MB on that run); the true lever is re-deriving
# the budget from the measured floor, not relaxing declarations. Pinned here
# so right-sizing it is a deliberate schedule decision (follow-up 13 replayed
# the 4571/5696 alternatives: both defer a coverage lane for 18-20 min).
KNOWN_UNDER_DECLARED_LANES = {"backend-coverage-blackbox"}
# The devbox host the receipts recorded: 8 cores, MemAvailable 11563 MB of
# 16007 MB, watchdog cap 14471 MB -> memory_budget_mb 7979 (20261031-115354).
RECORDED_DEVBOX = ("--host-cpus", "8", "--host-mem-mb", "11563", "--host-total-mem-mb", "16007",
                   "--host-watchdog-mb", "14471")


def check_recorded_peak_reservations() -> None:
    """Follow-up lane-memory-b (2026-10-31): every standard-plan lane with
    recorded peak data declares at least 1.25x that peak on the recorded host,
    except the pinned known under-declaration, which must still be under
    (so the exception cannot silently outlive its reason)."""
    plan = plan_json("--group", "all", "--backend", "--agents", "--smoke", "local", *RECORDED_DEVBOX)
    assert plan["memory_budget_mb"] == 7979, plan["memory_budget_mb"]
    lanes = {lane["name"]: lane for lane in plan["lanes"]}
    checked = 0
    for name, peak in RECORDED_LANE_PEAK_PSS_MB.items():
        declared = lanes[name]["memory_mb"]
        if name in KNOWN_UNDER_DECLARED_LANES:
            assert declared < peak, f"{name}: {declared} MB now covers the {peak} MB peak; drop the exception"
            continue
        assert declared >= 1.25 * peak, f"{name}: declares {declared} MB, recorded tree peak {peak} MB (x1.25 = {1.25 * peak:.0f})"
        checked += 1
    assert checked == len(RECORDED_LANE_PEAK_PSS_MB) - len(KNOWN_UNDER_DECLARED_LANES)
    structural, smoke = lanes["deploy-command-structural"], lanes["smoke"]
    assert structural["memory_mb"] == 3220 and structural["exclusive"] is True, structural
    assert smoke["memory_mb"] == 4150 == math.ceil(1.25 * 3319.4), smoke
    # The under-declared lane keeps its width formula (follow-up 13 kept it
    # after replaying the honest alternatives, see KNOWN_UNDER_DECLARED_LANES).
    backend = lanes["backend-coverage-blackbox"]
    width = int(backend["env"]["BLACKBOX_TEST_CONCURRENCY"]) + int(backend["env"]["BACKEND_UNIT_CONCURRENCY"])
    assert backend["memory_mb"] == 1536 + 512 * width == 2560, (backend, width)
    assert structural["memory_mb"] + smoke["memory_mb"] <= plan["memory_budget_mb"], \
        "the right-sized structural lane and the smoke lane fit the recorded budget together"
    assert structural["memory_mb"] + smoke["memory_mb"] + lanes["backend-coverage-blackbox"]["memory_mb"] \
        > plan["memory_budget_mb"], "the coverage lanes still wait for the exclusive phase on this budget"
    print("recorded peak reservations: ok")


VERSIONED_TAIL_LANES = ("live-probes", "semantic-stack", "e2b-smoke")
VERSIONED_TAIL_FLAGS = ("--live-probes", "--semantic-stack", "--e2b-smoke")


def _without_versioned_tails(plan: dict) -> dict:
    """``plan`` with the three flagged lanes and their schedule entries removed."""
    stripped = json.loads(json.dumps(plan))
    stripped["lanes"] = [lane for lane in stripped["lanes"] if lane["name"] not in VERSIONED_TAIL_LANES]
    schedule = stripped["schedule"]
    schedule["estimates"] = {name: value for name, value in schedule["estimates"].items()
                             if name not in VERSIONED_TAIL_LANES}
    schedule["phases"] = [{"phase": phase["phase"],
                           "lanes": [name for name in phase["lanes"] if name not in VERSIONED_TAIL_LANES]}
                          for phase in schedule["phases"]]
    return stripped


def check_versioned_group4_lanes(tmp: Path) -> None:
    """Follow-up 12 (2026-10-31): the Step 4p live probes and the Steps 5/6b/6c
    semantic stack existed only in a private launcher plan (``live-probes``
    1536 MB after every Group 3 lane; ``semantic-stack`` 4096 MB after the
    structural lane, backend coverage and live-probes, running UI semantics,
    the latency ratchet AND the E2B smoke). ``plan --live-probes
    --semantic-stack --e2b-smoke`` versions them: flag-less plans are unchanged
    byte for byte; ``live-probes`` (963 MB = 1.25 x 769.7 recorded) still waits
    for every other Group 3 lane and joins the coverage phase; ``semantic-stack``
    (6108 MB = 1.25 x 4886.2, its first split-lane receipt; follow-up 13
    re-pinned it from the 5205.2 MB launcher-lane peak) now holds UI semantics
    + latency only and waits for the structural lane plus the agents/frontend
    coverage lanes whose worker.py/Playwright/npm/vite children its
    non-isolated run.sh sweeps would reap, never for backend coverage or
    live-probes; ``e2b-smoke`` (812 MB = 1.25 x 649.1, its first receipt;
    follow-up 13 replaced the 1536 MB estimate) runs Step 6c alone after the
    lanes that drive run-blackbox-tests.sh against victoria_<workspace>.
    Budget math on the recorded 7979 MB devbox: semantic-stack is deferred
    behind backend coverage (6108 + 2560) and smoke (6108 + 4150) by memory
    and behind agents coverage (6108 + 1152 would fit) by the sweep edge;
    e2b-smoke (6108 + 812 = 6920) overlaps it there and on the launcher's
    8755 MB budget. Backend coverage keeps its width formula (2560 / 3072),
    see KNOWN_UNDER_DECLARED_LANES."""
    pipeline = load_module("run_deploy_pipeline_group4_tails", DRIVER)
    assert pipeline.LIVE_PROBES_RECORDED_TREE_PEAK_MB == 769.7
    assert pipeline.SEMANTIC_STACK_RECORDED_TREE_PEAK_MB == 4886.2
    assert pipeline.E2B_SMOKE_RECORDED_TREE_PEAK_MB == 649.1
    assert not hasattr(pipeline, "BACKEND_COVERAGE_RECORDED_TREE_PEAK_MB"), "backend coverage keeps its width formula"
    assert not hasattr(pipeline, "E2B_SMOKE_ESTIMATED_MEMORY_MB"), "the e2b-smoke estimate is replaced by its receipt"
    assert pipeline.live_probes_lane_memory_mb() == 963 == math.ceil(1.25 * 769.7)
    assert pipeline.semantic_stack_lane_memory_mb() == 6108 == math.ceil(1.25 * 4886.2)
    assert pipeline.e2b_smoke_lane_memory_mb() == 812 == math.ceil(1.25 * 649.1)
    assert set(VERSIONED_TAIL_LANES) <= set(pipeline.DEFAULT_LANE_SECONDS), "simulate must not call the tails UNMEASURED"
    script = ROOT / pipeline.SEMANTIC_STACK_SCRIPT
    assert script.is_file() and os.access(script, os.X_OK), script

    base = ("--group", "all", "--backend", "--agents", "--smoke", "local", *RECORDED_DEVBOX)
    plain = plan_json(*base)
    full = plan_json(*base, *VERSIONED_TAIL_FLAGS)
    plain_text = json.dumps(plain)
    assert not set(VERSIONED_TAIL_LANES) & {lane["name"] for lane in plain["lanes"]}
    assert "run-deploy-semantic-stack.sh" not in plain_text and "run_deploy_live_probes" not in plain_text
    assert json.dumps(_without_versioned_tails(full), sort_keys=True) == json.dumps(plain, sort_keys=True), \
        "the flags may only append lanes: every other byte of the plan is unchanged"
    assert plain["memory_budget_mb"] == full["memory_budget_mb"] == 7979
    names = [lane["name"] for lane in full["lanes"]]
    assert names[-3:] == ["smoke", "semantic-stack", "e2b-smoke"] and names[-4] == "live-probes", names
    lanes = {lane["name"]: lane for lane in full["lanes"]}
    group3 = [lane["name"] for lane in full["lanes"] if lane["group"] == "3" and lane["name"] != "live-probes"]

    probes = lanes["live-probes"]
    assert probes["command"] == ["python3", "scripts/run_deploy_live_probes.py"] and probes["cwd"] == "."
    assert probes["group"] == "3" and probes["memory_mb"] == 963 and probes["reuse_passed"] is True
    assert probes["after"] == group3 == ["eslint", "typescript", "backend-structural", "deploy-command-structural",
                                         "seed-cache-decision", "canonical-seed-whatsapp-content",
                                         "backend-coverage-blackbox", "agents-coverage-blackbox"], probes["after"]
    assert "phase" not in probes and "exclusive" not in probes, probes
    phases = {phase["phase"]: phase["lanes"] for phase in full["schedule"]["phases"]}
    assert "live-probes" in phases["coverage"], phases
    assert not any(name in lanes_in for name in ("semantic-stack", "e2b-smoke") for lanes_in in phases.values()), \
        "the Group 4 tails stay unphased"

    semantic = lanes["semantic-stack"]
    assert semantic["command"] == ["bash", "scripts/run-deploy-semantic-stack.sh"] and semantic["cwd"] == "."
    assert semantic["group"] == "4" and semantic["memory_mb"] == 6108 and semantic["reuse_passed"] is True
    assert semantic["after"] == ["deploy-command-structural", "agents-coverage-blackbox"], semantic["after"]
    assert "backend-coverage-blackbox" not in semantic["after"] and "live-probes" not in semantic["after"]
    assert "phase" not in semantic, semantic

    e2b = lanes["e2b-smoke"]
    assert e2b["command"] == ["bash", "scripts/run-deploy-semantic-stack.sh", "--e2b-smoke-only"] and e2b["cwd"] == "."
    assert e2b["group"] == "4" and e2b["memory_mb"] == 812 and e2b["reuse_passed"] is True
    assert e2b["after"] == ["backend-coverage-blackbox", "live-probes"], e2b["after"]
    assert "phase" not in e2b, e2b

    # Budget math the design accepts (honest declarations, no overlap forced).
    budget = full["memory_budget_mb"]
    assert semantic["memory_mb"] <= budget, "never refused outright"
    assert semantic["memory_mb"] + lanes["backend-coverage-blackbox"]["memory_mb"] > budget
    assert semantic["memory_mb"] + lanes["smoke"]["memory_mb"] > budget
    assert semantic["memory_mb"] + lanes["agents-coverage-blackbox"]["memory_mb"] <= budget, \
        "only the sweep edge keeps semantic-stack behind agents coverage on this budget"
    assert lanes["backend-coverage-blackbox"]["memory_mb"] == 2560, lanes["backend-coverage-blackbox"]
    assert semantic["memory_mb"] + e2b["memory_mb"] == 6920 <= budget, \
        "re-pinned from their first receipts, the two Group 4 tails overlap on the recorded devbox too"
    launcher = plan_json("--group", "all", "--backend", "--agents", "--frontend", "--smoke", "local",
                         "--host-cpus", "8", "--host-mem-mb", "12339", "--host-total-mem-mb", "16007",
                         "--host-watchdog-mb", "14471", *VERSIONED_TAIL_FLAGS)
    assert launcher["memory_budget_mb"] == 8755, launcher["memory_budget_mb"]
    launcher_lanes = {lane["name"]: lane for lane in launcher["lanes"]}
    assert launcher_lanes["semantic-stack"]["after"] == ["deploy-command-structural", "frontend-coverage-blackbox",
                                                         "agents-coverage-blackbox"]
    assert launcher["workers"]["backend_blackbox"] + launcher["workers"]["backend_unit"] == 3, launcher["workers"]
    assert launcher_lanes["backend-coverage-blackbox"]["memory_mb"] == 3072 == 1536 + 512 * 3
    assert 6108 + launcher_lanes["backend-coverage-blackbox"]["memory_mb"] > 8755
    assert 6108 + launcher_lanes["agents-coverage-blackbox"]["memory_mb"] <= 8755
    assert 6108 + launcher_lanes["e2b-smoke"]["memory_mb"] <= 8755, "the two tails overlap on the launcher budget"
    assert launcher_lanes["live-probes"]["after"][-3:] == ["backend-coverage-blackbox", "frontend-coverage-blackbox",
                                                           "agents-coverage-blackbox"]

    # Flags follow their group: no Group 3 lane means no edges to wait on.
    group4 = plan_json("--group", "4", "--smoke", "local", *VERSIONED_TAIL_FLAGS)
    group4_lanes = {lane["name"]: lane for lane in group4["lanes"]}
    assert set(group4_lanes) == {"smoke", "semantic-stack", "e2b-smoke"}, set(group4_lanes)
    assert group4_lanes["semantic-stack"]["after"] == [] and group4_lanes["e2b-smoke"]["after"] == []
    group3_only = plan_json("--group", "3", *VERSIONED_TAIL_FLAGS)
    assert [lane["name"] for lane in group3_only["lanes"]][-1] == "live-probes"
    assert not {"semantic-stack", "e2b-smoke"} & {lane["name"] for lane in group3_only["lanes"]}

    # The flagged plan loads through the real loader (edges valid, DAG acyclic
    # with the implied phase edges) and simulates: the phased live-probes lane
    # is projected from a recorded or default duration (never unknown); the
    # unphased Group 4 tails are outside the Group 3 projection by design.
    plan_path = tmp / "versioned-tails-plan.json"
    plan_path.write_text(json.dumps(full))
    simulated = run_driver("simulate", "--plan", str(plan_path), env=dict(os.environ))
    assert simulated.returncode == 0, simulated.stderr
    projection = json.loads(simulated.stdout)
    assert projection["lanes"]["live-probes"]["source"] in {"default", "ledger", "stage-receipts"}, projection["lanes"]
    assert projection["lanes"]["live-probes"]["loaded_s"] > 0
    assert not {"semantic-stack", "e2b-smoke"} & set(projection["lanes"]), "unphased tails are not projected"
    assert isinstance(projection["phased_union_wall_s"], (int, float))

    # The old deploy.md Steps 5/6b/6c named these flags, the script, its standalone E2B mode and its
    # regression. They are now anchored to the sources that execute them: the staged planner
    # (deploy_test_plan.standard_template) calls the driver with the three flags and carries the three
    # lanes with the driver's own commands; the script and its --e2b-smoke-only mode are the commands
    # asserted above; the script's regression is a registered structural gate.
    planner_text = (ROOT / "scripts" / "deploy_test_plan.py").read_text()
    assert '"--live-probes", "--semantic-stack", "--e2b-smoke"' in planner_text, \
        "the staged planner must request the versioned Group 4 lanes"
    staged = {gate["name"]: gate for gate in staged_template()["gates"]}
    for name in VERSIONED_TAIL_LANES:
        assert name in staged, f"the staged template must carry the {name} lane"
        assert staged[name]["command"] == lanes[name]["command"], (name, staged[name]["command"])
        assert staged[name]["cwd"] == lanes[name]["cwd"], (name, staged[name]["cwd"])
    assert staged["semantic-stack"]["command"] == ["bash", pipeline.SEMANTIC_STACK_SCRIPT]
    assert staged["e2b-smoke"]["command"] == ["bash", pipeline.SEMANTIC_STACK_SCRIPT, "--e2b-smoke-only"]
    registry = load_module("run_deploy_structural_gates_semantic_stack", STRUCTURAL_RUNNER)
    semantic_gate = next(gate for gate in registry.GATES if gate.name == "deploy-semantic-stack")
    assert tuple(semantic_gate.command) == ("bash", "scripts/tests/run-deploy-semantic-stack.test.sh"), semantic_gate
    print("versioned group 4 lanes: ok")


def check_stack_phase_lanes(tmp: Path, env: dict[str, str]) -> None:
    """Follow-up lane-memory-b (2026-10-31): on #1639/#1640 and the
    speed-followup deploys the 27 min smoke lane started only when the 9-10 min
    exclusive structural lane (declared 6544 MB, recorded tree peak <= 2575 MB)
    released its reservation, and semantic-stack waited for smoke in turn
    (~50 min rounds). A Group 4 lane may declare ``"phase": "stack"``: it is
    admitted right after the quick phase, beside the exclusive lane when both
    declarations fit the budget, no later phase waits for it, and the
    coverage lanes still wait for the exclusive lane. Values mirror the
    recorded plan at 1/40 scale: budget 200 = 7979, structural 80 = 3220,
    smoke 104 = 4150, cov 64 = 2560 (80 + 104 fit; 80 + 104 + 64 do not)."""
    def sample(wall: float, concurrent: int) -> dict:
        return {"wall_s": wall, "status": "passed", "concurrent": concurrent, "at": "2026-10-31T00:00:00Z"}

    ledger = tmp / "stack-phase-ledger.json"
    ledger.write_text(json.dumps({"schema_version": 1, "lanes": {
        "quick": [sample(5.0, 3)], "big": [sample(550.0, 1)], "cov": [sample(1100.0, 3)], "smoke": [sample(1600.0, 2)],
        "probe": [sample(40.0, 3)],  # recorded, so the coverage order (longest first) is deterministic
    }}))
    env = {**env, "DEPLOY_PIPELINE_LANE_DURATIONS": str(ledger)}
    plan = tmp / "stack-phase-plan.json"
    state = tmp / "stack-phase"
    stack_semantic_started = tmp / "stack-phase-semantic-started"
    write_plan(plan, [
        {"name": "quick", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "3", "memory_mb": 10},
        {"name": "big", "command": ["sleep", "0.6"], "reuse_passed": False, "group": "3", "exclusive": True,
         "memory_mb": 80},
        {"name": "cov", "command": ["sleep", "0.3"], "reuse_passed": False, "group": "3", "memory_mb": 64},
        # Runs until semantic has started (quick -> big -> cov -> probe ->
        # semantic, five admission passes), however long the loaded host takes.
        {"name": "smoke", "command": released_lane(stack_semantic_started), "reuse_passed": False, "group": "4",
         "memory_mb": 104, "phase": "stack"},
        {"name": "probe", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "3", "memory_mb": 10,
         "after": ["big", "cov"]},
        {"name": "semantic", "command": ["touch", str(stack_semantic_started)], "reuse_passed": False,
         "group": "4", "memory_mb": 10, "after": ["big", "cov", "probe"]},
    ], schedule={"policy": "phased"})
    with releasing(stack_semantic_started):
        ran = run_driver("run", "--plan", str(plan), "--state-dir", str(state), "--max-parallel", "0",
                         "--memory-budget-mb", "200", env=env, timeout=120)
    receipt = json.loads((state / "receipt.json").read_text())
    assert ran.returncode == 0 and receipt["status"] == "passed", (ran.returncode, ran.stderr, receipt["status"])
    lanes = receipt["lanes"]
    assert all(lane["status"] == "passed" for lane in lanes.values()), lanes
    phases = [(p["phase"], p["lanes"]) for p in receipt["schedule"]["phases"]]
    assert phases == [("quick", ["quick"]), ("stack", ["smoke"]), ("exclusive", ["big"]), ("coverage", ["cov", "probe"])], phases
    assert receipt["after"]["smoke"] == ["quick"], "the stack lane waits only for the quick phase"
    assert receipt["after"]["big"] == ["quick"], "the exclusive lane does not wait for the stack lane"
    assert receipt["after"]["cov"] == ["quick", "big"], "coverage waits for the exclusive lane, never for the stack lane"
    assert receipt["after"]["semantic"] == ["big", "cov", "probe"], "declared edges kept, no implied edges added"
    big, smoke, cov = lanes["big"], lanes["smoke"], lanes["cov"]
    assert smoke["started_epoch"] >= lanes["quick"]["finished_epoch"], "the stack lane waits for the quick phase"
    assert big["started_epoch"] < smoke["started_epoch"], "plan order: the exclusive lane is admitted first"
    assert smoke["started_epoch"] < big["finished_epoch"], "smoke starts beside the exclusive lane"
    assert smoke["admission"]["decision"] == "admitted" and not smoke["admission"].get("deferred"), smoke["admission"]
    assert big["admission"].get("note") is None and lanes["big"].get("note") is None, "the exclusive lane runs at planned width"
    assert cov["started_epoch"] >= big["finished_epoch"], "coverage waits for the exclusive lane"
    assert cov["started_epoch"] < smoke["finished_epoch"], "coverage overlaps the smoke lane"
    assert lanes["semantic"]["started_epoch"] < smoke["finished_epoch"], "semantic is not gated by the smoke lane"

    # Too small a budget for both: the exclusive lane (first in plan order)
    # runs at planned width and the stack lane waits for its release, which is
    # exactly the previous coverage-phase behaviour (never smoke first).
    tight = tmp / "stack-phase-tight"
    ran = run_driver("run", "--plan", str(plan), "--state-dir", str(tight), "--max-parallel", "0",
                     "--memory-budget-mb", "150", env=env, timeout=120)
    receipt = json.loads((tight / "receipt.json").read_text())
    assert ran.returncode == 0 and receipt["status"] == "passed", (ran.returncode, ran.stderr)
    big, smoke = receipt["lanes"]["big"], receipt["lanes"]["smoke"]
    assert big.get("note") is None, "no resize: 80 fits 150; 80 + 104 does not"
    assert smoke["started_epoch"] >= big["finished_epoch"], "smoke waits for the exclusive lane's release"
    assert smoke["admission"]["deferred"]["reason"] == "budget", smoke["admission"]
    print("stack phase lanes: ok")


def check_exclusive_lane_defers_behind_stack_lane(tmp: Path, env: dict[str, str]) -> None:
    """CodeRabbit on #1658 (Major): with a stack lane running, the exclusive
    structural lane skipped the resize step and the static budget check refused
    a lane planned wider than this attempt's budget (six workers, 6439 MB, vs a
    6000 MB budget). It must defer with a ``budget`` waiting record and be
    resized by fit_exclusive_lane once the running lanes release their share;
    a lane that can never fit (not even one worker) stays refused."""
    pipeline = load_module("pipeline_defer_exclusive", DRIVER)
    declared = pipeline.structural_lane_memory_mb
    assert declared(6) == 6439, declared(6)
    host = {"cpus": 8, "mem_available_mb": pipeline.MEMORY_RESERVE_MB + 6000}
    probe = tmp / "defer-args.txt"
    plan = tmp / "defer-plan.json"
    state = tmp / "defer"
    # ``gate`` (unphased, admitted at attempt start) holds the exclusive lane
    # back until the stack lane is running (smoke's start marker, not a sleep
    # racing quick's startup): in plan order the exclusive lane would otherwise
    # be admitted first and resized alone.
    smoke_started = tmp / "defer-smoke-started"
    write_plan(plan, [
        {"name": "quick", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "3", "memory_mb": 10},
        {"name": "gate", "command": released_lane(smoke_started), "reuse_passed": False, "group": "4",
         "memory_mb": 10},
        {"name": "big", "exclusive": True, "reuse_passed": False, "group": "3", "memory_mb": declared(6),
         "after": ["gate"],
         "command": ["bash", "-c", f"printf '%s\\n' \"$@\" > {probe}",
                     "scripts/run-deploy-structural-gates.py", "--max-workers", "6"]},
        {"name": "smoke", "command": ["bash", "-c", f"touch {shlex.quote(str(smoke_started))}; sleep 2.5"],
         "reuse_passed": False, "group": "4", "memory_mb": 4150, "phase": "stack"},
    ], schedule={"policy": "phased"})
    with releasing(smoke_started):
        ran = run_driver("run", "--plan", str(plan), "--state-dir", str(state), "--max-parallel", "0",
                         "--memory-budget-mb", "6000", env=env, host=host, timeout=120)
    receipt = json.loads((state / "receipt.json").read_text())
    assert ran.returncode == 0 and receipt["status"] == "passed", (ran.returncode, ran.stderr, receipt["lanes"]["big"])
    big, smoke = receipt["lanes"]["big"], receipt["lanes"]["smoke"]
    assert smoke["status"] == "passed" and big["status"] == "passed", (smoke, big)
    assert smoke["started_epoch"] < receipt["lanes"]["gate"]["finished_epoch"], "the stack lane ran before big was ready"
    assert big["admission"]["deferred"]["reason"] == "budget", big["admission"]
    assert big["admission"]["deferred"]["first"]["memory_mb"] == declared(6), big["admission"]
    assert big["started_epoch"] >= smoke["finished_epoch"], "resized and admitted once the stack lane released"
    args = probe.read_text().split()
    workers = int(args[args.index("--max-workers") + 1])
    assert 1 <= workers <= 5 and big["memory_mb"] == declared(workers) <= 6000, (workers, big)
    assert big["note"].startswith(f"resized: 6 -> {workers} workers") and "PIPELINE_LANE_RESIZED" in ran.stdout, \
        (big, ran.stdout)
    # A lane that can never fit is still refused, stack lane or not.
    never = tmp / "defer-never"
    write_plan(plan, [
        {"name": "big", "exclusive": True, "reuse_passed": False, "group": "3", "memory_mb": declared(6),
         "command": ["bash", "-c", "true", "scripts/run-deploy-structural-gates.py", "--max-workers", "6"]},
        {"name": "smoke", "command": ["sleep", "0.5"], "reuse_passed": False, "group": "4", "memory_mb": 500,
         "phase": "stack"},
    ], schedule={"policy": "phased"})
    ran = run_driver("run", "--plan", str(plan), "--state-dir", str(never), "--max-parallel", "0",
                     "--memory-budget-mb", str(declared(1) - 1), env=env, host=host, timeout=120)
    big = json.loads((never / "receipt.json").read_text())["lanes"]["big"]
    assert ran.returncode == 1 and big["status"] == "failed" and big["note"].startswith("refused: needs"), big
    print("exclusive lane defers behind the stack lane: ok")


def check_static_ceiling_credits_observed_lanes(tmp: Path, env: dict[str, str]) -> None:
    """Follow-up PR-11 (#1658 round 1, 2026-10-31): smoke 4150 + backend 3072
    + agents 1536 = 8758 MB declared against an 8755 MB budget deferred
    agents-coverage on reason ``budget`` for ~14 min although the live check
    had 157 MB to spare. The static ceiling now charges a phased candidate
    only the freshly observed running lanes' unmaterialized declarations;
    unobserved lanes, a disabled credit and an unphased candidate keep the
    whole declarations. Budget 150: holder (100) + joiner (60) exceed it
    declared, but 100 - ~70 observed + 60 fit; live headroom (300) is never the
    binding check here."""
    if sys.platform != "linux":
        print("static ceiling credit: skipped (Linux /proc sampling)")
        return
    pipeline = load_module("pipeline_static_credit", DRIVER)
    marker = tmp / "static-holder-allocated"
    plan = tmp / "static-credit-plan.json"
    holder_command = [sys.executable, "-c",
                      "import pathlib, time; block = b'x' * (60 * 1024 * 1024); "
                      f"pathlib.Path({str(marker)!r}).touch(); time.sleep(5); del block"]

    def write(group: str) -> None:
        write_plan(plan, [
            {"name": "gate", "command": ["sleep", "0.3"], "reuse_passed": False, "group": "3", "memory_mb": 1},
            {"name": "holder", "command": holder_command, "reuse_passed": False, "group": "3", "memory_mb": 100},
            {"name": "joiner", "command": ["sleep", "0.2"], "after": ["gate"], "reuse_passed": False,
             "group": group, "memory_mb": 60},
        ], schedule={"policy": "legacy"})

    def host() -> dict:
        return {"cpus": 8, "mem_available_mb": pipeline.MEMORY_RESERVE_MB + 300}

    def run(state: Path, extra_env: dict[str, str] | None = None) -> dict:
        if marker.exists():
            marker.unlink()
        with ExitStack() as stack:
            stack.enter_context(patch.object(pipeline, "host_resources", side_effect=host))
            stack.enter_context(patch.object(pipeline, "SOURCE_ROOT", Path(env["DEPLOY_PIPELINE_SOURCE_ROOT"])))
            stack.enter_context(patch.dict(os.environ, {**env, **(extra_env or {})}, clear=True))
            result = pipeline.run(plan, state, max_parallel=0, budget_mb=150)
        receipt = json.loads((state / "receipt.json").read_text())
        assert result == 0 and receipt["status"] == "passed", (result, receipt["status"], receipt["lanes"])
        assert receipt["memory_budget_mb"] == 150, receipt["memory_budget_mb"]
        return receipt["lanes"]

    write("3")
    lanes = run(tmp / "static-credit")
    holder, joiner = lanes["holder"], lanes["joiner"]
    assert joiner["started_epoch"] < holder["finished_epoch"], \
        "a phased candidate fits the budget beside the holder's unmaterialized reservation"
    admission = joiner["admission"]
    assert admission["decision"] == "admitted" and admission["budget_mb"] == 150, admission
    assert admission["reserved_declared_mb"] == 100 and admission["reserved_static_mb"] < 60, admission
    assert admission["reserved_live_mb"] < 60, "the same credit applies against live headroom"
    deferred = admission.get("deferred")
    if deferred:  # the holder was not yet observed when the gate finished
        assert deferred["reason"] == "budget" and deferred["first"]["reserved_static_mb"] == 100, deferred
        assert deferred["first"]["running"]["holder"]["observation"] in {"unknown", "stale"}, deferred

    lanes = run(tmp / "static-credit-off", {"DEPLOY_ADMISSION_CREDIT": "0"})
    holder, joiner = lanes["holder"], lanes["joiner"]
    assert joiner["started_epoch"] >= holder["finished_epoch"], "with the credit disabled the whole declarations rule"
    waited = joiner["admission"]["deferred"]
    assert waited["reason"] == "budget" and waited["last"]["reserved_static_mb"] == 100, waited
    assert waited["last"]["running"]["holder"]["observation"] == "disabled", waited

    write("4")  # unphased candidate: declared-peak accounting, no credit
    lanes = run(tmp / "static-credit-unphased")
    assert lanes["joiner"]["started_epoch"] >= lanes["holder"]["finished_epoch"], lanes["joiner"]
    assert lanes["joiner"]["admission"]["deferred"]["last"]["reserved_static_mb"] == 100, lanes["joiner"]["admission"]
    print("static ceiling credit: ok")


def check_recorded_budget_admits_coverage_beside_smoke(tmp: Path, env: dict[str, str]) -> None:
    """The recorded #1658 round-1 shape on its 8755 MB budget: quick lanes,
    smoke (stack, 4150) beside the exclusive structural lane (4293), then
    backend-coverage (the generated plan's declaration at the launcher width,
    3072) and agents-coverage (1536) must run together while smoke still
    runs: 4150 + 3072 + 1536 = 8758 declared exceeds the budget, but smoke's
    observed usage leaves room under both ceilings. The backend declaration
    is read from the real plan so an honest re-pin surfaces its schedule
    effect here (follow-up 13 replayed 4571 and 5696: each defers a coverage
    lane 18-20 min) instead of passing on a literal."""
    if sys.platform != "linux":
        print("recorded budget coverage admission: skipped (Linux /proc sampling)")
        return
    pipeline = load_module("pipeline_recorded_budget", DRIVER)
    launcher = plan_json("--group", "all", "--backend", "--agents", "--frontend", "--smoke", "local",
                         "--host-cpus", "8", "--host-mem-mb", "12339", "--host-total-mem-mb", "16007",
                         "--host-watchdog-mb", "14471")
    backend_mb = next(lane["memory_mb"] for lane in launcher["lanes"] if lane["name"] == "backend-coverage-blackbox")
    assert launcher["memory_budget_mb"] == 8755 and backend_mb == 3072, (launcher["memory_budget_mb"], backend_mb)
    plan = tmp / "recorded-budget-plan.json"
    state = tmp / "recorded-budget"
    smoke_command = [sys.executable, "-c",
                     "import time; block = b'x' * (60 * 1024 * 1024); time.sleep(8); del block"]
    write_plan(plan, [
        {"name": "quick", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "3", "memory_mb": 10},
        {"name": "structural", "command": ["sleep", "0.6"], "reuse_passed": False, "group": "3", "exclusive": True,
         "memory_mb": 4293},
        {"name": "smoke", "command": smoke_command, "reuse_passed": False, "group": "4", "memory_mb": 4150,
         "phase": "stack"},
        {"name": "backend", "command": ["sleep", "3"], "reuse_passed": False, "group": "3", "memory_mb": backend_mb},
        {"name": "agents", "command": ["sleep", "0.5"], "reuse_passed": False, "group": "3", "memory_mb": 1536},
    ], schedule={"policy": "phased"})
    ledger = tmp / "recorded-budget-ledger.json"
    ledger.write_text(json.dumps({"schema_version": 1, "lanes": {
        "quick": [{"wall_s": 5.0, "status": "passed", "concurrent": 3, "at": "2026-10-31T00:00:00Z"}],
        "structural": [{"wall_s": 486.0, "status": "passed", "concurrent": 2, "at": "2026-10-31T00:00:00Z"}],
        "backend": [{"wall_s": 1100.0, "status": "passed", "concurrent": 3, "at": "2026-10-31T00:00:00Z"}],
        "agents": [{"wall_s": 1400.0, "status": "passed", "concurrent": 3, "at": "2026-10-31T00:00:00Z"}],
        "smoke": [{"wall_s": 1600.0, "status": "passed", "concurrent": 2, "at": "2026-10-31T00:00:00Z"}],
    }}))

    def host() -> dict:
        return {"cpus": 8, "mem_available_mb": pipeline.MEMORY_RESERVE_MB + 8755}

    with ExitStack() as stack:
        stack.enter_context(patch.object(pipeline, "host_resources", side_effect=host))
        stack.enter_context(patch.object(pipeline, "SOURCE_ROOT", Path(env["DEPLOY_PIPELINE_SOURCE_ROOT"])))
        stack.enter_context(patch.dict(os.environ, {**env, "DEPLOY_PIPELINE_LANE_DURATIONS": str(ledger)}, clear=True))
        result = pipeline.run(plan, state, max_parallel=0, budget_mb=8755)
    receipt = json.loads((state / "receipt.json").read_text())
    assert result == 0 and receipt["status"] == "passed", (result, receipt["status"], receipt["lanes"])
    assert receipt["memory_budget_mb"] == 8755, receipt["memory_budget_mb"]
    kinds = [p["phase"] for p in receipt["schedule"]["phases"]]
    assert kinds == ["quick", "stack", "exclusive", "coverage"], receipt["schedule"]["phases"]
    lanes = receipt["lanes"]
    structural, smoke, backend, agents = lanes["structural"], lanes["smoke"], lanes["backend"], lanes["agents"]
    assert smoke["started_epoch"] < structural["finished_epoch"], "smoke runs beside the structural lane"
    assert backend["started_epoch"] >= structural["finished_epoch"], "coverage waits for the exclusive lane"
    assert agents["started_epoch"] < backend["finished_epoch"], "agents-coverage runs together with backend-coverage"
    assert agents["started_epoch"] < smoke["finished_epoch"], "while the smoke stack still runs"
    admission = agents["admission"]
    assert admission["decision"] == "admitted" and admission["reserved_declared_mb"] == 4150 + backend_mb, admission
    assert admission["reserved_static_mb"] + 1536 <= 8755 < admission["reserved_declared_mb"] + 1536, admission
    assert admission["running"]["smoke"]["observation"] == "fresh", admission["running"]
    print("recorded budget admits coverage beside smoke: ok")


def main() -> int:
    global DRIVER
    with tempfile.TemporaryDirectory(prefix="deploy-pipeline-test-") as raw:
        tmp = Path(raw)
        source_root = make_source_root(tmp / "source")
        DRIVER = source_root / "scripts" / "run_deploy_pipeline.py"
        # The matched control run exports DEPLOY_ADMISSION_CREDIT=0 for the whole
        # pipeline, and the structural lane that executes this suite inherits
        # it: every scenario sets the admission knobs it needs explicitly, so
        # the base environment carries none of them (in-process runs patch
        # os.environ with clear=True for the same reason).
        # A launcher exports FACTORY_METADATA_FILE for its own worktree; the
        # telemetry scenario selects its own fixture snapshot explicitly.
        env = {**{key: value for key, value in os.environ.items()
                  if not key.startswith("DEPLOY_ADMISSION_") and key not in {"FACTORY_METADATA_FILE", "DEPLOY_LANE_SCOPED_REUSE"}},
               "DEPLOY_RUN_ROOT": str(tmp / "runs"), "DEPLOY_PIPELINE_SOURCE_ROOT": str(source_root)}
        # Read-only gh calls ask the GitHub token pool first; scenarios never
        # probe the real API: by default the pool has no member (GH_TOKEN reads).
        no_pool = tmp / "no-token-pool.py"
        no_pool.write_text("import sys\nsys.exit('github_token_pool: no member configured')\n")
        env["DEPLOY_GH_TOKEN_POOL"] = str(no_pool)
        start_timing(tmp / "runs", env)
        marker = tmp / "slow-finished"
        plan = tmp / "plan.json"
        write_plan(plan, [
            {"name": "fast-a", "command": ["sleep", "1"], "reuse_passed": False},
            {"name": "fast-b", "command": ["sleep", "1"], "reuse_passed": False},
            {"name": "fails", "command": ["bash", "-c", "sleep 0.5; exit 7"], "reuse_passed": False},
            {"name": "slow", "command": ["bash", "-c", f"sleep 4; touch {marker}"], "reuse_passed": False},
            {"name": "dependent", "command": ["true"], "after": ["fast-a"], "reuse_passed": False},
        ])
        state = tmp / "state"
        since = time.time()
        started = time.monotonic()
        supervisor = subprocess.Popen(
            driver_argv("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED),
            env=env,
        )
        waited = run_driver("wait", "--state-dir", str(state), "--timeout", "30", "--since", str(since), env=env)
        wake_s = time.monotonic() - started
        assert waited.returncode == 1, waited.stdout
        assert "FAILED fails exit=7" in waited.stdout, waited.stdout
        assert "slow" in waited.stdout.split("still_running=")[1], waited.stdout
        assert wake_s < 3.5, f"wait must wake on first failure, took {wake_s:.1f}s"
        assert not marker.exists(), "wake happened only after the slow sibling"
        assert supervisor.wait(timeout=30) == 1
        assert marker.exists(), "siblings keep running after a failure"
        total = time.monotonic() - started
        assert total < 7, f"lanes must run concurrently (serial would be >=6.5s), took {total:.1f}s"
        receipt = json.loads((state / "receipt.json").read_text())
        lanes = receipt["lanes"]
        assert receipt["status"] == "failed", receipt
        assert lanes["dependent"]["started_epoch"] >= lanes["fast-a"]["finished_epoch"]
        stage_lines = (Path(env["DEPLOY_RUN_ROOT"]) / Path(
            (Path(env["DEPLOY_RUN_ROOT"]) / "current").read_text().strip())).glob("**/*.jsonl")
        recorded = "".join(path.read_text() for path in stage_lines)
        for name in ("fast-a", "fails", "slow", "dependent"):
            assert f'"{name}"' in recorded, f"run-deploy-stage record missing for {name}"

        # Retry: the previously failed lane is admitted first; serial cap makes order observable.
        # retry_env (backend coverage's failed-first sweep) applies only to the
        # lane that failed in the previous receipt.
        retry_marks = tmp / "retry-marks"
        retry_marks.mkdir()
        mark = f'echo "${{PIPELINE_RETRY:-0}}" > {retry_marks}/'
        write_plan(plan, [
            {"name": "fast-a", "command": ["bash", "-c", mark + "fast-a"], "reuse_passed": False,
             "retry_env": {"PIPELINE_RETRY": "1"}},
            {"name": "fails", "command": ["bash", "-c", mark + "fails"], "reuse_passed": False,
             "retry_env": {"PIPELINE_RETRY": "1"}},
        ])
        retry = run_driver("run", "--plan", str(plan), "--state-dir", str(state), "--max-parallel", "1",
                           "--memory-budget-mb", "1048576", env=env)
        receipt = json.loads((state / "receipt.json").read_text())
        assert retry.returncode == 0, (retry.returncode, receipt["status"], receipt.get("final_source"), retry.stderr)
        assert receipt["order"][0] == "fails", receipt["order"]
        assert receipt["lanes"]["fails"]["started_epoch"] < receipt["lanes"]["fast-a"]["started_epoch"]
        assert (state / "history.jsonl").read_text().count("\n") == 1
        assert (retry_marks / "fails").read_text().strip() == "1", "failed lane must get its retry_env"
        assert (retry_marks / "fast-a").read_text().strip() == "0", "passed lane must not get retry_env"

        # A --reuse-passed cache hit records status "reused" (exp/telemetry); the
        # shared stage waiter must treat it as a pass, never as a failed lane.
        write_plan(plan, [{"name": "cached", "command": ["true"], "reuse_passed": True}])
        since = time.time()
        for _ in range(2):
            ran = run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=env)
            assert ran.returncode == 0, ran.stderr
        waited = run_driver("wait", "--state-dir", str(state), "--timeout", "10", "--since", str(since), env=env)
        run_dir = Path(json.loads((state / "receipt.json").read_text())["stage_run_dir"])
        reused_rows = [row for row in map(json.loads, (run_dir / "stages.jsonl").read_text().splitlines())
                       if row.get("stage") == "cached" and row.get("status") == "reused"]
        assert reused_rows, "second run must be an exact-input reuse"
        assert waited.returncode == 0, waited.stdout

        # A source edit during the sweep must never report green.
        probe = source_root / ".pipeline-stale-probe.tmp"
        write_plan(plan, [{"name": "edits", "command": ["bash", "-c", f"echo x > {probe}"],
                           "reuse_passed": False}])
        since = time.time()
        stale = run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=env)
        waited = run_driver("wait", "--state-dir", str(state), "--timeout", "10", "--since", str(since), env=env)
        assert stale.returncode == 5 and waited.returncode == 5, (stale.returncode, waited.stdout)
        receipt = json.loads((state / "receipt.json").read_text())
        assert receipt["source_root"] == str(source_root), receipt["source_root"]
        probe.unlink()

        check_wait_receipt_contract(tmp)
        check_live_headroom_and_child_rusage(tmp, env)
        check_materialized_reservation_credit(tmp, env)
        # Control: the suite itself inherits the control run's flag and every
        # credit scenario (default on, explicitly off, unobserved) still holds,
        # with the holder starting 1.5 s late (past the old gate's 0.6-0.8 s
        # margin) as on a loaded host.
        (tmp / "inherited-flag").mkdir()
        with patch.dict(os.environ, {"DEPLOY_ADMISSION_CREDIT": "0"}):
            check_materialized_reservation_credit(tmp / "inherited-flag", env, holder_start_delay_s=1.5)
        check_observation_validity(tmp, env)
        check_identity_verified_zombie_memory(tmp)
        check_identity_verified_zombie_memory_real(tmp)
        check_semantic_stack_beside_stack_owners(tmp, env)
        check_lane_scoped_reuse(tmp, env, source_root)
        check_reconcile_reused_lane(tmp)
        check_scoped_inert_tables()
        check_cross_run_record_guards(tmp, source_root)
        check_plan_scaling()
        check_structural_memory_floor()
        check_macos_memory(tmp, env)
        check_memory_admission(tmp, env)
        check_max_parallel_default(tmp, env)
        check_wait_since_and_no_row_failures(tmp, env)
        check_watchdog_receipts(tmp, env)
        check_follow_source(tmp, env)
        check_lane_teardown(tmp, env)
        check_owner_run_preflight(tmp, env)
        check_attempt_refreshes_factory_snapshot(tmp, env)
        check_fix_loop_cap(tmp, env)
        check_interrupted_rounds_and_dead_supervisor_deferral()
        check_wait_follows_supersede_behind_stage_failure(tmp)
        check_exclusive_lane_resizes_to_free_memory(tmp, env)
        check_standard_plan_typescript()
        check_schedule_phases(tmp, env)
        check_stage_receipt_seed(tmp, env)
        check_passed_only_estimates_and_dag_phases(tmp, env)
        check_declared_phase_lanes(tmp, env)
        check_stack_phase_lanes(tmp, env)
        check_exclusive_lane_defers_behind_stack_lane(tmp, env)
        check_static_ceiling_credits_observed_lanes(tmp, env)
        check_recorded_budget_admits_coverage_beside_smoke(tmp, env)
        check_recorded_peak_reservations()
        check_versioned_group4_lanes(tmp)
        check_dependencies_through_unphased_lanes(tmp, env)
        check_simulate_legacy_plan_group3(tmp, env)
        check_receipt_readers(tmp)
        check_production_fly_wait(tmp, env)
        check_production_render(tmp, env)
        check_production_semantic(tmp, env)
        check_semantic_workflow_source_sha()
    print("run-deploy-pipeline: all checks passed")
    return 0


def check_receipt_readers(tmp: Path) -> None:
    """The driver binds one definition per module-level name (Python keeps
    the last ``def``: a second ``_read_receipt`` added with ``production-semantic``
    once silently replaced the deploy-lane reader for every earlier caller),
    and the two receipt readers keep their distinct contracts: ``_read_receipt``
    (``receipt.json``) returns a dict or None, so ``verify`` reports a non-dict
    file as no receipt instead of crashing; ``_read_production_receipt``
    (``production.json``) returns whatever JSON the file holds."""
    seen: dict[str, int] = {}
    for node in ast.parse(DRIVER.read_text()).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            assert node.name not in seen, f"{DRIVER.name} defines {node.name} twice (lines {seen[node.name]} and {node.lineno})"
            seen[node.name] = node.lineno
    assert {"_read_receipt", "_read_production_receipt"} <= seen.keys(), sorted(seen)
    pipeline = load_module("pipeline_receipt_readers", DRIVER)
    receipts = tmp / "receipt-readers"
    receipts.mkdir()
    (receipts / "list.json").write_text("[1, 2]\n")
    (receipts / "dict.json").write_text('{"status": "passed"}\n')
    (receipts / "broken.json").write_text("{\n")
    assert pipeline._read_receipt(receipts / "list.json") is None, "receipt.json must read as a dict or nothing"
    assert pipeline._read_production_receipt(receipts / "list.json") == [1, 2], "production.json reads as parsed"
    assert pipeline._read_receipt(receipts / "dict.json") == {"status": "passed"}
    assert pipeline._read_production_receipt(receipts / "dict.json") == {"status": "passed"}
    for name in ("broken.json", "missing.json"):
        assert pipeline._read_receipt(receipts / name) is None and pipeline._read_production_receipt(receipts / name) is None, name
    state = receipts / "verify-state"
    state.mkdir()
    (state / "receipt.json").write_text("[]\n")
    out = io.StringIO()
    with redirect_stdout(out):
        code = pipeline.verify(state)
    assert code == 2 and "PIPELINE_VERIFY status=no-receipt exit=2" in out.getvalue(), (code, out.getvalue())
    print("receipt readers: ok")


def check_production_fly_wait(tmp: Path, env: dict[str, str]) -> None:
    """``production`` gates the Step 13b dispatch on the exact deploy-agents.yml
    run of the merged SHA: an agent runtime change waits for the run to
    complete and for the Step 13ab proof (durable job SUCCEEDED, identity bound
    to the merged SHA and run attempt, monitor --verify), recording run id,
    attempt, job id, conclusion and job stage; a merge without agent runtime
    changes never calls gh; a run that concluded failure still opens the gate
    when its resumed durable job is SUCCEEDED, and a job that is not SUCCEEDED
    blocks with the exact resume command. gh and node are fake executables on
    PATH."""
    repo = tmp / "production-source"
    repo.mkdir()
    scripts = repo / "scripts"
    scripts.mkdir()
    for name in ("run_deploy_pipeline.py", "deploy_stage_wait.py", "factory_metadata.py",
                 "classify-agent-runtime-changes.sh"):
        shutil.copyfile(ROOT / "scripts" / name, scripts / name)
    (repo / ".gitignore").write_text(".context/\n__pycache__/\n")
    # The merge's own deploy-agents.yml push filter decides the cutover.
    (repo / ".github" / "workflows").mkdir(parents=True)
    shutil.copyfile(ROOT / ".github" / "workflows" / "deploy-agents.yml", repo / ".github" / "workflows" / "deploy-agents.yml")
    git = ["git", "-C", str(repo), "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"]
    subprocess.run(["git", "init", "-q", str(repo)], check=True)

    def commit(message: str, files: dict[str, str]) -> str:
        for relative, content in files.items():
            path = repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        subprocess.run([*git, "add", "-A"], check=True)
        subprocess.run([*git, "commit", "-qm", message], check=True)
        return subprocess.run([*git, "rev-parse", "HEAD"], check=True, stdout=subprocess.PIPE, text=True).stdout.strip()

    commit("base", {"README": "base\n", "agents/fly.toml": 'app = "navi-whisper-lux"\n',
                    "scripts/agent_workflow_surface_hash.py": 'print("feedface")\n'})
    tests_only = commit("agents tests + backend", {"agents/tests/new_case.py": "x\n", "back-end/src/x.ts": "y\n"})
    runtime = commit("agents runtime", {"agents/worker_patch.py": "z\n"})
    # 2026-11-16 (#2147): a controller-only merge starts deploy-agents.yml through its push paths.
    controller = commit("cutover controller", {"scripts/worker_pool_cutover.py": "c\n"})
    sys.path.insert(0, str(scripts))
    try:
        fixture_pipeline = load_module("production_fixture_pipeline", scripts / "run_deploy_pipeline.py")
    finally:
        sys.path.remove(str(scripts))
    assert fixture_pipeline.agent_cutover_required(["scripts/worker_pool_cutover.py"], repo, controller) == {
        "required": True, "runtime_files": [], "workflow_changed": False,
        "trigger_files": ["scripts/worker_pool_cutover.py"]}
    assert fixture_pipeline.agent_cutover_required(["agents/tests/new_case.py", "back-end/src/x.ts"], repo,
                                                   tests_only)["required"] is False
    fake = tmp / "production-fake"
    fake.mkdir()
    bin_dir = fake / "bin"
    bin_dir.mkdir()
    (bin_dir / "gh").write_text(
        "#!/usr/bin/env bash\n"
        'echo "$*" >> "$FAKE_GH_DIR/calls.log"\n'
        'case "$1 $2" in\n'
        '  "api --allow-escape-sequences") [ "$3" = "repos/{owner}/{repo}/actions/runs/123/attempts/1/logs" ] || exit 1; cat "$FAKE_GH_DIR/logs.zip" ;;\n'
        '  "run list") cat "$FAKE_GH_DIR/list.json" ;;\n'
        '  "run view")\n'
        '    case " $* " in\n'
        '      *" --log "*) cat "$FAKE_GH_DIR/log.txt" ;;\n'
        '      *) n=$(cat "$FAKE_GH_DIR/view-count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAKE_GH_DIR/view-count"\n'
        '         f="$FAKE_GH_DIR/view-$n.json"; [ -f "$f" ] || f="$FAKE_GH_DIR/view-last.json"; cat "$f" ;;\n'
        '    esac ;;\n'
        '  *) echo "unexpected gh $*" >&2; exit 1 ;;\n'
        "esac\n")
    (bin_dir / "node").write_text(
        "#!/usr/bin/env bash\n"
        'echo "$*" >> "$FAKE_GH_DIR/node-calls.log"\n'
        'case " $* " in\n'
        '  *production-worker-qualification.ts*) n=$(cat "$FAKE_GH_DIR/qualification-count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAKE_GH_DIR/qualification-count"\n'
        '    f="$FAKE_GH_DIR/qualification.json"; if [ "$n" -gt 1 ] && [ -f "$FAKE_GH_DIR/qualification-next.json" ]; then f="$FAKE_GH_DIR/qualification-next.json"; fi; cat "$f" ;;\n'
        '  *worker-deployment-queue.ts*) args="$*"; id="${args##*--job-id }"; id="${id%% *}"\n'
        '    f="$FAKE_GH_DIR/job-$id.json"\n'
        '    [ -f "$f" ] || f="$FAKE_GH_DIR/job.json"; cat "$f" ;;\n'
        '  *monitor-cooperative-cutover.ts*--json*) args="$*"; id="${args##*--job-id }"; id="${id%% *}"\n'
        '    f="$FAKE_GH_DIR/monitor-$id.json"; [ -f "$f" ] && cat "$f"; exit 0 ;;\n'
        '  *monitor-cooperative-cutover.ts*) case "$*" in *"${FAKE_MONITOR_FAIL_JOB:-none}"*) exit 1 ;; esac\n'
        '    exit "${FAKE_MONITOR_EXIT:-0}" ;;\n'
        '  *) echo "unexpected node $*" >&2; exit 1 ;;\n'
        "esac\n")
    for name in ("gh", "node"):
        (bin_dir / name).chmod(0o755)
    job_id = "a" * 64
    driver = scripts / "run_deploy_pipeline.py"
    prod_env = {**env, "PATH": f"{bin_dir}:{env.get('PATH', os.environ.get('PATH', ''))}", "FAKE_GH_DIR": str(fake)}
    calls = fake / "calls.log"

    def reset(list_rows: list[dict], views: list[dict], log: str = "") -> None:
        for stale in fake.glob("view-*"):
            stale.unlink()
        for stale in (calls, fake / "node-calls.log", fake / "qualification-count", fake / "qualification-next.json",
                      *fake.glob("job-*.json"), *fake.glob("monitor-*.json")):
            stale.unlink(missing_ok=True)
        (fake / "list.json").write_text(json.dumps(list_rows))
        for index, view in enumerate(views, start=1):
            (fake / f"view-{index}.json").write_text(json.dumps(view))
        (fake / "view-last.json").write_text(json.dumps(views[-1]))
        (fake / "log.txt").write_text(log)
        write_job("SUCCEEDED", runtime, "123-1")

    def write_job(stage: str, source: str, attempt: str) -> None:
        (fake / "job.json").write_text(json.dumps({"stage": stage, "identity": {"sourceCommit": source,
                                                                               "attempt": attempt}}))

    def run_production(merged: str, state: Path, *extra: str, env: dict | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(driver), "production", "--merged-sha", merged, "--state-dir", str(state),
             "--poll-seconds", "0.05", "--expected-hash", "feedface", *extra,
             "--", "bash", "-c", f'echo dispatch >> "{calls}"'],
            env=env or prod_env, cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120)

    def call_lines() -> list[str]:
        return calls.read_text().splitlines() if calls.exists() else []

    # 1. Agent runtime change: the newest run belongs to another SHA and must be
    #    ignored; the exact run is in progress twice, then completed/success.
    running = {"databaseId": 123, "headSha": runtime, "status": "in_progress", "conclusion": None, "attempt": 1,
               "url": "https://github.com/acme/rose/actions/runs/123"}
    other = {**running, "databaseId": 999, "headSha": "f" * 40}
    log = f"2026-10-30T20:00:00Z cutover Queued production worker deployment {job_id} for {runtime}\n"
    reset([other, running], [{"status": "in_progress", "conclusion": None, "attempt": 1, "url": running["url"]},
                             {"status": "in_progress", "conclusion": None, "attempt": 1, "url": running["url"]},
                             {"status": "completed", "conclusion": "success", "attempt": 1, "url": running["url"]}], log)
    state = tmp / "production-state"
    ran = run_production(runtime, state)
    assert ran.returncode == 0, ran.stdout
    lines = call_lines()
    assert lines and lines[-1] == "dispatch", lines
    assert sum(1 for line in lines if line.startswith("run list")) == 1, lines
    views = [line for line in lines if line.startswith("run view 123") and "--json" in line]
    assert len(views) == 3, lines
    log_index = next(i for i, line in enumerate(lines) if line == "run view 123 --log")
    assert log_index > lines.index(views[-1]) and lines.index("dispatch") > log_index, lines
    assert not any("999" in line for line in lines), "a run on another SHA must never be polled"
    node_calls = (fake / "node-calls.log").read_text().splitlines()
    assert node_calls[0].endswith(f"worker-deployment-queue.ts read --job-id {job_id}"), node_calls
    assert node_calls[1].endswith(f"monitor-cooperative-cutover.ts --job-id {job_id} --expected-hash feedface --verify"), node_calls
    receipt = json.loads((state / "production.json").read_text())
    assert receipt["status"] == "passed" and receipt["merged_sha"] == runtime, receipt
    assert receipt["agent_cutover"] == {"required": True, "runtime_files": ["agents/worker_patch.py"],
                                        "workflow_changed": False, "trigger_files": []}, receipt["agent_cutover"]
    fly = receipt["fly"]
    assert fly["run_id"] == "123" and fly["attempt"] == "1" and fly["job_id"] == job_id, fly
    assert fly["conclusion"] == "success" and fly["job_stage"] == "SUCCEEDED" and fly["deployment_token"] == "123-1", fly
    assert receipt["cutover_verify"]["monitor_verify_exit"] == 0 and receipt["cutover_verify"]["queue_read"] == "ok"
    assert receipt["cutover_verify"]["job_stage"] == "SUCCEEDED", receipt["cutover_verify"]
    waits = receipt["github_waits"]
    assert [w["kind"] for w in waits] == ["run-start", "run-complete"], waits
    assert waits[0]["run_id"] == "123" and waits[0]["outcome"] == "found", waits
    assert waits[1]["polls"] == 3 and waits[1]["conclusion"] == "success" and waits[1]["outcome"] == "completed", waits
    assert receipt["semantic_dispatch"]["exit"] == 0, receipt["semantic_dispatch"]
    assert "PIPELINE_PRODUCTION fly=completed run=123 attempt=1" in ran.stdout, ran.stdout

    # 2. No agent runtime change (tests + back-end only): no gh call, dispatch at once.
    reset([other], [{"status": "queued", "conclusion": None, "attempt": 1}])
    ran = run_production(tests_only, tmp / "production-state-2")
    assert ran.returncode == 0, ran.stdout
    assert call_lines() == ["dispatch"], call_lines()
    receipt = json.loads((tmp / "production-state-2" / "production.json").read_text())
    assert receipt["fly"] == {"required": False,
                              "reason": "no agent runtime or deploy-agents.yml push-path change in the merge"}
    assert receipt["agent_cutover"]["required"] is False and receipt["github_waits"] == [], receipt
    assert not (fake / "node-calls.log").exists(), "no cutover verification without a Fly lane"

    # 3a. The exact run concluded failure but its durable job was resumed through
    #     the queue CLI and is SUCCEEDED (deploy.md Step 13): the job, not the
    #     GitHub conclusion, is the authority, so the gate opens; both are recorded.
    failed_run = {"status": "completed", "conclusion": "failure", "attempt": 2,
                  "url": "https://github.com/acme/rose/actions/runs/124"}
    reset([{**running, "databaseId": 124}], [failed_run], log)
    write_job("SUCCEEDED", runtime, "124-2")
    ran = run_production(runtime, tmp / "production-state-3a")
    assert ran.returncode == 0, ran.stdout
    assert call_lines()[-1] == "dispatch", call_lines()
    node_calls = (fake / "node-calls.log").read_text().splitlines()
    assert len(node_calls) == 2 and "--verify" in node_calls[1], node_calls
    receipt = json.loads((tmp / "production-state-3a" / "production.json").read_text())
    assert receipt["status"] == "passed", receipt
    fly = receipt["fly"]
    assert fly["conclusion"] == "failure" and fly["job_stage"] == "SUCCEEDED", fly
    assert fly["run_id"] == "124" and fly["attempt"] == "2" and fly["deployment_token"] == "124-2", fly
    assert fly["job_id"] == job_id and receipt["cutover_verify"]["job_stage"] == "SUCCEEDED", receipt
    assert receipt["github_waits"][-1]["conclusion"] == "failure", receipt["github_waits"]

    # 3b. The exact run concluded failure and the durable job is not SUCCEEDED:
    #     blocked with the exact resume command, never dispatched, nothing verified.
    reset([{**running, "databaseId": 124}], [failed_run], log)
    write_job("PREPARING", runtime, "124-2")
    ran = run_production(runtime, tmp / "production-state-3b")
    assert ran.returncode == 1, ran.stdout
    assert "dispatch" not in call_lines(), call_lines()
    assert f"durable job {job_id} is PREPARING, not SUCCEEDED" in ran.stdout and "Do not dispatch" in ran.stdout, ran.stdout
    assert (f"node --import tsx scripts/worker-deployment-queue.ts run --job-id {job_id} -- "
            "python3 ../scripts/worker_pool_cutover.py") in ran.stdout, ran.stdout
    assert "rerun this gate once the durable job is SUCCEEDED" in ran.stdout, ran.stdout
    node_calls = (fake / "node-calls.log").read_text().splitlines()
    assert len(node_calls) == 1 and "read --job-id" in node_calls[0], "a job that is not SUCCEEDED must not reach the monitor"
    receipt = json.loads((tmp / "production-state-3b" / "production.json").read_text())
    assert receipt["status"] == "failed" and receipt["fly"]["conclusion"] == "failure", receipt
    assert receipt["fly"]["job_stage"] == "PREPARING" and receipt["fly"]["job_id"] == job_id, receipt["fly"]
    assert receipt["cutover_verify"] is None and "not SUCCEEDED" in receipt["error"], receipt
    # A completed run whose log never named a durable job cannot be verified.
    reset([{**running, "databaseId": 124}], [failed_run], "no queue line here\n")
    ran = run_production(runtime, tmp / "production-state-3c")
    assert ran.returncode == 1 and "exact deployment job was not recovered from run 124" in ran.stdout, ran.stdout
    assert "dispatch" not in call_lines() and not (fake / "node-calls.log").exists(), call_lines()

    # 4. The exact run never appears: blocked with the manual start command.
    reset([other], [{"status": "queued", "conclusion": None, "attempt": 1}])
    ran = run_production(runtime, tmp / "production-state-4", "--start-timeout", "0.2")
    assert ran.returncode == 1 and "did not start" in ran.stdout and f"expected_sha={runtime}" in ran.stdout, ran.stdout
    assert "dispatch" not in call_lines(), call_lines()
    receipt = json.loads((tmp / "production-state-4" / "production.json").read_text())
    assert receipt["github_waits"] == [{**receipt["github_waits"][0], "kind": "run-start", "outcome": "timeout",
                                        "run_id": None}], receipt["github_waits"]

    # 5. A job bound to another SHA/attempt or a failed monitor blocks the dispatch.
    reset([running], [{"status": "completed", "conclusion": "success", "attempt": 1, "url": running["url"]}], log)
    write_job("SUCCEEDED", tests_only, "123-1")
    ran = run_production(runtime, tmp / "production-state-5")
    assert ran.returncode == 1 and "source/attempt mismatch" in ran.stdout and "dispatch" not in call_lines(), ran.stdout
    reset([running], [{"status": "completed", "conclusion": "success", "attempt": 1, "url": running["url"]}], log)
    ran = subprocess.run(
        [sys.executable, str(driver), "production", "--merged-sha", runtime, "--state-dir", str(tmp / "production-state-6"),
         "--poll-seconds", "0.05", "--expected-hash", "feedface", "--", "bash", "-c", f'echo dispatch >> "{calls}"'],
        env={**prod_env, "FAKE_MONITOR_EXIT": "3"}, cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, timeout=120)
    assert ran.returncode == 1 and "monitor-cooperative-cutover.ts --verify failed (exit 3)" in ran.stdout, ran.stdout
    assert "dispatch" not in call_lines(), call_lines()

    # 7. The merged job never cut over itself: the queue coalesced it into a
    #    queued git descendant (SUPERSEDED). The gate opens only on that
    #    descendant's SUCCEEDED job + monitor --verify, recorded as verified by
    #    descendant cutover; a pending, non-descendant or unlinked one blocks.
    head = subprocess.run([*git, "rev-parse", "HEAD"], check=True, stdout=subprocess.PIPE, text=True).stdout.strip()
    tree = subprocess.run([*git, "rev-parse", f"{runtime}^{{tree}}"], check=True, stdout=subprocess.PIPE,
                          text=True).stdout.strip()
    later = subprocess.run([*git, "commit-tree", tree, "-p", runtime, "-m", "later main merge"], check=True,
                           stdout=subprocess.PIPE, text=True).stdout.strip()
    descendant_id = "d" * 64

    def write_superseded(descendant_stage: str, descendant_source: str, link: object = descendant_id) -> None:
        (fake / "job.json").write_text(json.dumps({
            "jobId": job_id, "stage": "SUPERSEDED", "identity": {"app": "app", "sourceCommit": runtime,
                                                                  "attempt": "123-1"},
            "evidence": {"SUPERSEDED": {"supersededBy": link}}}))
        (fake / f"job-{descendant_id}.json").write_text(json.dumps({
            "jobId": descendant_id, "stage": descendant_stage,
            "identity": {"app": "app", "sourceCommit": descendant_source, "attempt": "130-1", "surfaceHash": "c0ffee"}}))

    done = {"status": "completed", "conclusion": "success", "attempt": 1, "url": running["url"], "headSha": runtime}
    reset([running], [done], log)
    write_superseded("SUCCEEDED", later)
    ran = run_production(runtime, tmp / "production-state-7a")
    assert ran.returncode == 0, ran.stdout
    assert call_lines()[-1] == "dispatch", call_lines()
    assert f"verified_by=descendant-cutover descendant={descendant_id}" in ran.stdout, ran.stdout
    node_calls = (fake / "node-calls.log").read_text().splitlines()
    assert node_calls[0].endswith(f"read --job-id {job_id}") and node_calls[1].endswith(f"read --job-id {descendant_id}")
    assert node_calls[2].endswith(f"monitor-cooperative-cutover.ts --job-id {descendant_id} --verify"), node_calls
    receipt = json.loads((tmp / "production-state-7a" / "production.json").read_text())
    verified = receipt["cutover_verify"]
    assert receipt["status"] == "passed" and receipt["fly"]["job_stage"] == "SUPERSEDED", receipt
    assert verified["verified_by"] == "descendant-cutover" and verified["job_stage"] == "SUPERSEDED", verified
    assert verified["descendant_job_id"] == descendant_id and verified["descendant_source_commit"] == later, verified
    assert verified["chain"] == [job_id, descendant_id] and verified["job_id"] == job_id, verified
    assert receipt["fly"]["verified_by_descendant"]["descendant_job_id"] == descendant_id, receipt["fly"]
    for stage, source, link, expected in (
            ("PREPARING", later, descendant_id, f"SUPERSEDED by {descendant_id}, which is PREPARING, not SUCCEEDED"),
            ("SUCCEEDED", tests_only, descendant_id, f"commit {tests_only} is not a descendant of {runtime}"),
            ("SUCCEEDED", "e" * 40, descendant_id, "could not be proven (missing history)"),
            ("SUCCEEDED", later, None, "has no valid supersededBy link")):
        reset([running], [done], log)
        write_superseded(stage, source, link)
        ran = run_production(runtime, tmp / f"production-state-7-{stage}-{source[:4]}-{link is None}")
        assert ran.returncode == 1 and expected in ran.stdout, (expected, ran.stdout)
        assert "dispatch" not in call_lines(), call_lines()
        assert "monitor-cooperative-cutover.ts" not in (fake / "node-calls.log").read_text(), "no monitor before proof"
    # 7b. That descendant's own generation was itself replaced by a later cutover
    #     before this gate ran (production 11-15: 7e8af6d1 superseded by the live
    #     a556f348): its monitor can never pass on the moved pointer. The gate opens
    #     only on the live pointer's own job, SUCCEEDED, same app and a descendant of
    #     the merge, with its monitor --verify; anything else stays blocked.
    live_id = "e" * 64

    def write_monitor(target_id: str, updated_by: str) -> None:
        # What monitor-cooperative-cutover.ts --json really prints on stdout+stderr:
        # Prisma INFO log lines, then JSON.stringify(report, null, 2) (multi-line).
        (fake / f"monitor-{target_id}.json").write_text(
            "\x1b[36m[2026-11-16T09:02:16.291Z] INFO [Prisma] db.query model=ToolSideEffect operation=findUnique\x1b[0m\n"
            + json.dumps({"phase": "managed_deployment_pending", "deploymentJobId": target_id,
                          "pointerMatchesExpected": False,
                          "livePointer": {"surfaceHash": "beef", "updatedBy": updated_by},
                          "messages": ["A managed predecessor requires its durable qualified retirement certificate."]},
                         indent=2) + "\n"
            # A later structured log line must not displace the report.
            + '{"level": "info", "msg": "monitor done"}\n')

    newest = subprocess.run([*git, "commit-tree", tree, "-p", later, "-m", "newest main merge"], check=True,
                            stdout=subprocess.PIPE, text=True).stdout.strip()

    def write_replaced(live_stage: str, live_source: str) -> None:
        write_superseded("SUCCEEDED", later)
        write_monitor(descendant_id, live_id)
        (fake / f"job-{live_id}.json").write_text(json.dumps({
            "jobId": live_id, "stage": live_stage,
            "identity": {"app": "app", "sourceCommit": live_source, "attempt": "140-1", "surfaceHash": "beef"}}))

    replaced_env = {**prod_env, "FAKE_MONITOR_FAIL_JOB": descendant_id}
    reset([running], [done], log)
    write_replaced("SUCCEEDED", newest)
    ran = run_production(runtime, tmp / "production-state-7b", env=replaced_env)
    assert ran.returncode == 0, ran.stdout
    assert call_lines()[-1] == "dispatch", call_lines()
    assert f"verified_by=live-successor-cutover live={live_id}" in ran.stdout, ran.stdout
    node_calls = (fake / "node-calls.log").read_text().splitlines()
    assert node_calls[-2].endswith(f"read --job-id {live_id}"), node_calls
    assert node_calls[-1].endswith(f"monitor-cooperative-cutover.ts --job-id {live_id} --verify"), node_calls
    verified = json.loads((tmp / "production-state-7b" / "production.json").read_text())["cutover_verify"]
    assert verified["verified_by"] == "live-successor-cutover" and verified["live_job_id"] == live_id, verified
    assert verified["replaced_job_id"] == descendant_id and verified["live_source_commit"] == newest, verified
    for stage, source, expected in (
            ("SUCCEEDED", tests_only, f"live job {live_id} commit {tests_only} is not a descendant of {runtime}"),
            ("PREPARING", newest, f"replaced by live job {live_id}, which is PREPARING, not SUCCEEDED")):
        reset([running], [done], log)
        write_replaced(stage, source)
        ran = run_production(runtime, tmp / f"production-state-7b-{stage}-{source[:4]}", env=replaced_env)
        assert ran.returncode == 1 and expected in ran.stdout, (expected, ran.stdout)
        assert "dispatch" not in call_lines(), call_lines()
        assert f"--job-id {live_id} --verify" not in (fake / "node-calls.log").read_text(), "no live verify before proof"
    # Failed before enqueue: no original identity may be invented. A read-only
    # durable snapshot proves absence and names the live strict descendant.
    reset([running], [{**done, "conclusion": "failure"}], "build timed out before enqueue\nNo queued worker deployment for navi-whisper-lux\n")
    (fake / "qualification.json").write_text(json.dumps({
        "app": "navi-whisper-lux", "sourceCommit": runtime, "attempt": "123-1", "originalJobs": [],
        "livePointer": {"updatedBy": live_id},
        "liveJob": {"jobId": live_id, "stage": "SUCCEEDED", "identity": {
            "app": "navi-whisper-lux", "sourceCommit": newest, "attempt": "140-1", "surfaceHash": "feedface"}}}))
    (fake / f"job-{live_id}.json").write_text(json.dumps({"jobId": live_id, "stage": "SUCCEEDED", "identity": {
        "app": "navi-whisper-lux", "sourceCommit": newest, "attempt": "140-1", "surfaceHash": "feedface"}}))
    import zipfile
    with zipfile.ZipFile(fake / "logs.zip", "w") as archive:
        archive.writestr("0_deploy.txt", "build timed out before enqueue\n")
        archive.writestr("1_recover.txt", "No queued worker deployment for navi-whisper-lux\n")
    state_no_job = tmp / "production-prequeue"
    ran = run_production(runtime, state_no_job)
    assert ran.returncode == 0, ran.stdout
    qualified = json.loads((state_no_job / "production.json").read_text())
    assert qualified["fly"]["job_id"] is None and qualified["fly"]["conclusion"] == "failure", qualified
    assert qualified["fly"]["deployment_token"] == "123-1", qualified
    assert qualified["cutover_verify"]["verified_by"] == "prequeue-live-descendant", qualified
    assert qualified["cutover_verify"]["attempt"] == "140-1", qualified
    assert call_lines()[-1] == "dispatch", call_lines()

    # Local replace refs must not change the source app, runtime classifier,
    # ancestry or the hash algorithm used for physical qualification.
    forged = commit("forged replacement", {
        "agents/fly.toml": 'app = "foreign"\n',
        "scripts/agent_workflow_surface_hash.py": 'print("forged")\n',
    })
    subprocess.run([*git, "reset", "--hard", head], check=True, stdout=subprocess.PIPE)
    for original in (runtime, newest):
        subprocess.run([*git, "replace", original, forged], check=True)
    try:
        reset([running], [{**done, "conclusion": "failure"}],
              "No queued worker deployment for navi-whisper-lux\n")
        (fake / f"job-{live_id}.json").write_text(json.dumps(json.loads((fake / "qualification.json").read_text())["liveJob"]))
        ran = run_production(runtime, tmp / "prequeue-replacement-ignored")
        assert ran.returncode == 0 and call_lines()[-1] == "dispatch", ran.stdout
    finally:
        for original in (runtime, newest):
            subprocess.run([*git, "replace", "-d", original], check=True, stdout=subprocess.PIPE)

    snapshot_path = fake / "qualification.json"
    good_snapshot = json.loads(snapshot_path.read_text())
    for name, changed in (
            ("original-inserted", {**good_snapshot, "originalJobs": [{"jobId": job_id}]}),
            ("pointer-moved", {**good_snapshot, "livePointer": {"updatedBy": job_id}})):
        reset([running], [{**done, "conclusion": "failure"}],
              "No queued worker deployment for navi-whisper-lux\n")
        (fake / f"job-{live_id}.json").write_text(json.dumps(good_snapshot["liveJob"]))
        (fake / "qualification-next.json").write_text(json.dumps(changed))
        ran = run_production(runtime, tmp / f"prequeue-race-{name}")
        assert ran.returncode == 1 and "changed during qualification" in ran.stdout, ran.stdout
        assert "dispatch" not in call_lines(), call_lines()
    for name, changed in (
            ("attempt", {"attempt": 2}), ("active", {"status": "in_progress"}),
            ("source", {"headSha": tests_only})):
        reset([running], [{**done, "conclusion": "failure"}, {**done, "conclusion": "failure", **changed}],
              "No queued worker deployment for navi-whisper-lux\n")
        (fake / f"job-{live_id}.json").write_text(json.dumps(good_snapshot["liveJob"]))
        ran = run_production(runtime, tmp / f"prequeue-race-{name}")
        assert ran.returncode == 1 and "changed during qualification" in ran.stdout, ran.stdout
        assert "dispatch" not in call_lines(), call_lines()
    reset([running], [{**done, "conclusion": "failure"}],
          "No queued worker deployment for navi-whisper-lux\n")
    # Invalid/unreadable authoritative data never grants execution credit.
    mutations = {
        "existing-original": lambda x: x.update(originalJobs=[{"jobId": job_id}]),
        "missing-absence": lambda x: x.pop("originalJobs"),
        "wrong-app": lambda x: x["liveJob"]["identity"].update(app="foreign"),
        "equal-source": lambda x: x["liveJob"]["identity"].update(sourceCommit=runtime),
        "unrelated-source": lambda x: x["liveJob"]["identity"].update(sourceCommit=tests_only),
        "unknown-source": lambda x: x["liveJob"]["identity"].update(sourceCommit="f" * 40),
        "unsucceeded": lambda x: x["liveJob"].update(stage="PREPARING"),
        "missing-pointer": lambda x: x.update(livePointer=None),
        "pointer-mismatch": lambda x: x["livePointer"].update(updatedBy=job_id),
        "hash-mismatch": lambda x: x["liveJob"]["identity"].update(surfaceHash="bad"),
        "missing-attempt": lambda x: x["liveJob"]["identity"].update(attempt=""),
    }
    for name, mutate in mutations.items():
        snapshot = json.loads(json.dumps(good_snapshot))
        mutate(snapshot)
        snapshot_path.write_text(json.dumps(snapshot))
        calls.unlink(missing_ok=True)
        ran = run_production(runtime, tmp / f"prequeue-negative-{name}")
        assert ran.returncode == 1, (name, ran.stdout)
        assert "dispatch" not in call_lines(), (name, call_lines())
    snapshot_path.write_text(json.dumps(good_snapshot))
    for name, log_content, monitor_exit in (
            ("partial-log", "build timed out\n", "0"),
            ("empty-log", "", "0"),
            ("ambiguous-jobs", log + f"Queued production worker deployment {live_id}\n", "0"),
            ("retirement-unqualified", "No queued worker deployment for navi-whisper-lux\n", "1")):
        reset([running], [{**done, "conclusion": "failure"}], log_content)
        (fake / f"job-{live_id}.json").write_text(json.dumps(good_snapshot["liveJob"]))
        ran = run_production(runtime, tmp / f"prequeue-negative-{name}",
                             env={**prod_env, "FAKE_MONITOR_EXIT": monitor_exit})
        assert ran.returncode == 1, (name, ran.stdout)
        assert "dispatch" not in call_lines(), (name, call_lines())
    archive_path = fake / "logs.zip"
    good_archive = archive_path.read_bytes()
    for name, content in (("truncated-archive", good_archive[:-20]), ("auth-failed-archive", b"Forbidden")):
        archive_path.write_bytes(content)
        reset([running], [{**done, "conclusion": "failure"}],
              "No queued worker deployment for navi-whisper-lux\n")
        ran = run_production(runtime, tmp / f"prequeue-negative-{name}")
        assert ran.returncode == 1 and "dispatch" not in call_lines(), (name, ran.stdout)
    archive_path.write_bytes(good_archive)
    snapshot_path.write_text("not JSON")
    reset([running], [{**done, "conclusion": "failure"}],
          "No queued worker deployment for navi-whisper-lux\n")
    ran = run_production(runtime, tmp / "prequeue-negative-invalid-json")
    assert ran.returncode == 1 and "dispatch" not in call_lines(), ran.stdout

    # 7c. The merge's own job SUCCEEDED (never superseded) and a later cutover then
    #     moved the pointer (production 11-16, #2328: d345a37c at 765eb3abe5 overtaken
    #     by live dc4b75d6 at 20f67b1ca9). The live successor verifies it.
    succeeded_env = {**prod_env, "FAKE_MONITOR_FAIL_JOB": job_id}
    reset([running], [done], log)
    (fake / "job.json").write_text(json.dumps({"jobId": job_id, "stage": "SUCCEEDED", "identity": {
        "app": "app", "sourceCommit": runtime, "attempt": "123-1"}}))
    write_monitor(job_id, live_id)
    (fake / f"job-{live_id}.json").write_text(json.dumps({
        "jobId": live_id, "stage": "SUCCEEDED",
        "identity": {"app": "app", "sourceCommit": newest, "attempt": "140-1", "surfaceHash": "beef"}}))
    ran = run_production(runtime, tmp / "production-state-7c", env=succeeded_env)
    assert ran.returncode == 0, ran.stdout
    assert call_lines()[-1] == "dispatch", call_lines()
    verified = json.loads((tmp / "production-state-7c" / "production.json").read_text())["cutover_verify"]
    assert verified["verified_by"] == "live-successor-cutover" and verified["live_job_id"] == live_id, verified
    assert verified["replaced_job_id"] == job_id and verified["job_stage"] == "SUCCEEDED", verified
    node_calls = (fake / "node-calls.log").read_text().splitlines()
    assert node_calls[-2].endswith(f"read --job-id {live_id}"), node_calls
    assert node_calls[-1].endswith(f"monitor-cooperative-cutover.ts --job-id {live_id} --verify"), node_calls
    assert subprocess.run([*git, "rev-parse", "HEAD"], check=True, stdout=subprocess.PIPE,
                          text=True).stdout.strip() == head, "the descendant fixture must not move HEAD"
    # 8. The queue refused an older/diverged release instead of rolling the live one
    #    back: blocked with the refusal, no resume advice, no monitor, no dispatch.
    reset([running], [done], log)
    (fake / "job.json").write_text(json.dumps({
        "jobId": job_id, "stage": "ABORTED", "identity": {"app": "app", "sourceCommit": runtime, "attempt": "123-1"},
        "evidence": {"ABORTED": {"reason": "ROLLBACK_REFUSED", "liveJobId": descendant_id,
                                 "message": "Refused: could roll production back"}}}))
    ran = run_production(runtime, tmp / "production-state-8")
    assert ran.returncode == 1 and "was refused before cutover: Refused: could roll production back" in ran.stdout, ran.stdout
    assert "production was not rolled back" in ran.stdout and "worker_pool_cutover.py" not in ran.stdout, ran.stdout
    assert "dispatch" not in call_lines(), call_lines()
    assert "monitor-cooperative-cutover.ts" not in (fake / "node-calls.log").read_text()

    # 9. No --expected-hash: the monitor is bound to the MERGED commit's surface
    #    hash (what deploy-agents.yml computed on its checkout of that commit),
    #    never the deployer's working tree. Here the checkout sits on a later
    #    branch head with a different workflow plus an uncommitted edit, as a
    #    deployer still on its pre-merge branch did (PR #2024: 1160939de2bc
    #    working tree vs 533d313d5760 merged, a successful cutover refused).
    hasher = (ROOT / "scripts" / "agent_workflow_surface_hash.py").read_text()
    merged_surface = commit("merge agent workflow", {"scripts/agent_workflow_surface_hash.py": hasher,
                                                     "agents/workflows/agent_workflow.py": "import helpers.loop\n",
                                                     "agents/helpers/__init__.py": "",
                                                     "agents/helpers/loop.py": "VALUE = 'merged'\n"})
    commit("branch head behind main", {"agents/helpers/loop.py": "VALUE = 'branch'\n"})
    (repo / "agents" / "workflows" / "agent_workflow.py").write_text("import helpers.loop\nDIRTY = True\n")
    clean = tmp / "production-merged-checkout"
    clean.mkdir()
    subprocess.run(f'git -C "{repo}" archive {merged_surface} | tar -x -C "{clean}"', shell=True, check=True)

    def fixture_hash(checkout: Path) -> str:
        return subprocess.run([sys.executable, "scripts/agent_workflow_surface_hash.py"], cwd=checkout, check=True,
                              stdout=subprocess.PIPE, text=True).stdout.strip()

    merged_hash, working_hash = fixture_hash(clean), fixture_hash(repo)
    assert merged_hash != working_hash, "the fixture must give the working tree a different surface"
    merged_row = {**running, "headSha": merged_surface}
    reset([merged_row], [done], log)
    write_job("SUCCEEDED", merged_surface, "123-1")
    ran = subprocess.run(
        [sys.executable, str(driver), "production", "--merged-sha", merged_surface, "--state-dir",
         str(tmp / "production-state-9"), "--poll-seconds", "0.05", "--", "bash", "-c", f'echo dispatch >> "{calls}"'],
        env=prod_env, cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120)
    assert ran.returncode == 0 and call_lines()[-1] == "dispatch", ran.stdout
    node_calls = (fake / "node-calls.log").read_text().splitlines()
    assert node_calls[-1].endswith(f"--job-id {job_id} --expected-hash {merged_hash} --verify"), (merged_hash, node_calls)
    receipt = json.loads((tmp / "production-state-9" / "production.json").read_text())
    assert receipt["cutover_verify"]["expected_hash"] == merged_hash, receipt["cutover_verify"]
    assert f"hash={merged_hash}" in ran.stdout, ran.stdout
    assert (repo / "agents" / "workflows" / "agent_workflow.py").read_text().endswith("DIRTY = True\n"), \
        "hashing the merged commit must leave the working tree untouched"
    # A merged commit without the hash algorithm fails closed even though the
    # working tree has one: no monitor, no dispatch.
    subprocess.run([*git, "rm", "-q", "scripts/agent_workflow_surface_hash.py"], check=True)
    missing = commit("runtime change without the hash script", {"agents/worker_patch.py": "changed\n"})
    (repo / "scripts" / "agent_workflow_surface_hash.py").write_text(hasher)
    reset([{**running, "headSha": missing}], [done], log)
    write_job("SUCCEEDED", missing, "123-1")
    ran = subprocess.run(
        [sys.executable, str(driver), "production", "--merged-sha", missing, "--state-dir",
         str(tmp / "production-state-9b"), "--poll-seconds", "0.05", "--", "bash", "-c", f'echo dispatch >> "{calls}"'],
        env=prod_env, cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120)
    assert ran.returncode == 1 and f"could not compute the agent workflow surface hash of {missing}" in ran.stdout, ran.stdout
    assert "dispatch" not in call_lines() and not (fake / "node-calls.log").exists(), call_lines()
    print("production fly wait: ok")


def check_production_render(tmp: Path, env: dict[str, str]) -> None:
    """``production-render`` (deploy.md Step 13a step 1) serves the merged
    backend's proof from the Render deploys API, stubbed on loopback, over a
    fixture repo: (a) no deploy for the merged SHA, live commit an ancestor
    with no change under the Render service paths -> source-equivalent,
    receipt recorded, the follow-up command runs; a root package.json change
    or (b) a back-end change since the live commit keeps waiting to the bound;
    (c) a live commit with the identical back-end tree that is neither an
    ancestor nor a descendant keeps waiting (only ancestry blocks); (d) a
    deploy for the merged SHA takes the exact-SHA path (live opens,
    build_failed blocks); (f) a live descendant with the identical backend is
    equivalent, (g) a live descendant that changed the backend is verified by
    descendant (never source-equivalent, never RENDER_LIVE); (j) a merged
    deploy Render canceled or (k) deactivated because a newer main commit
    replaced it is verified by that live descendant once it is live, while
    (l) a canceled merged deploy with only an older commit live, (m) a
    descendant whose own deploy failed and (n) a deactivated merged deploy
    replaced by a non-descendant (a rollback) block at once; (o) a live
    descendant this checkout has not fetched is learned by one fetch of
    origin main; (e) a Render API error or missing credentials fails closed (exit 2)
    without the follow-up. Every blocked receipt names the observed live
    commit. The lane never overwrites, and is never overwritten by, the Fly
    lane's receipt of the same merged SHA."""
    repo = tmp / "render-source"
    repo.mkdir()
    scripts = repo / "scripts"
    scripts.mkdir()
    for name in ("run_deploy_pipeline.py", "deploy_stage_wait.py", "factory_metadata.py",
                 "classify-agent-runtime-changes.sh"):
        shutil.copyfile(ROOT / "scripts" / name, scripts / name)
    (repo / ".gitignore").write_text(".context/\n__pycache__/\n")
    # The merge's own deploy-agents.yml push filter decides the cutover.
    (repo / ".github" / "workflows").mkdir(parents=True)
    shutil.copyfile(ROOT / ".github" / "workflows" / "deploy-agents.yml", repo / ".github" / "workflows" / "deploy-agents.yml")
    git = ["git", "-C", str(repo), "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"]
    subprocess.run(["git", "init", "-q", str(repo)], check=True)

    def commit(message: str, files: dict[str, str]) -> str:
        for relative, content in files.items():
            path = repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        subprocess.run([*git, "add", "-A"], check=True)
        subprocess.run([*git, "commit", "-qm", message], check=True)
        return subprocess.run([*git, "rev-parse", "HEAD"], check=True, stdout=subprocess.PIPE, text=True).stdout.strip()

    commit("base", {"README": "base\n", "agents/fly.toml": 'app = "navi-whisper-lux"\n',
                    "scripts/agent_workflow_surface_hash.py": 'print("feedface")\n'})
    live = commit("backend v1", {"back-end/src/server.ts": "v1\n"})
    docs_only = commit("docs only", {"docs/notes.md": "notes\n", "scripts/tool.py": "x = 1\n"})
    backend_change = commit("backend v2", {"back-end/src/server.ts": "v2\n"})
    docs_after = commit("docs after", {"docs/after.md": "after\n"})
    root_manifest = commit("root manifest", {"package.json": '{"workspaces": ["back-end"]}\n'})
    backend_v3 = commit("backend v3", {"back-end/src/server.ts": "v3\n"})
    branch = subprocess.run([*git, "rev-parse", "--abbrev-ref", "HEAD"], check=True, stdout=subprocess.PIPE,
                            text=True).stdout.strip()
    # `side` forks from the live commit with a docs-only change: its back-end
    # tree is identical to every main-line commit built on `live`, so only
    # ancestry can decide.
    subprocess.run([*git, "checkout", "-q", "-b", "side", live], check=True)
    sibling = commit("sibling docs", {"docs/other.md": "other\n"})
    subprocess.run([*git, "checkout", "-q", branch], check=True)

    fake = tmp / "render-fake"
    fake.mkdir()
    requests_log = fake / "requests.log"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args: object) -> None:  # keep the suite's output clean
            pass

        def do_GET(self) -> None:  # http.server dispatches on this exact name
            with requests_log.open("a") as handle:
                handle.write(f"{self.path} auth={self.headers.get('Authorization')}\n")
            if self.path.split("?")[0] != "/services/srv-fixture/deploys":
                self.send_error(404)
                return
            if self.headers.get("Authorization") != "Bearer fixture-key":
                self.send_error(401)
                return
            if (fake / "fail").exists():
                self.send_error(500, "fixture outage")
                return
            count = int((fake / "count").read_text()) + 1 if (fake / "count").exists() else 1
            (fake / "count").write_text(str(count))
            path = fake / f"deploys-{count}.json"
            if not path.exists():
                path = fake / "deploys-last.json"
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    driver = scripts / "run_deploy_pipeline.py"
    render_env = {**{key: value for key, value in env.items() if not key.startswith("RENDER_")},
                  "DEPLOY_RENDER_API_BASE": f"http://127.0.0.1:{server.server_address[1]}",
                  "RENDER_API_KEY": "fixture-key", "RENDER_SERVICE_ID": "srv-fixture"}
    probes = fake / "probes.log"
    service_paths = ["back-end/", "render.yaml", "package.json", "package-lock.json"]

    def deploy(commit_id: str, status: str, deploy_id: str) -> dict:
        return {"deploy": {"id": deploy_id, "status": status, "commit": {"id": commit_id, "message": "m"}},
                "cursor": deploy_id}

    def reset(*pages: list[dict]) -> None:
        for stale in fake.glob("deploys-*.json"):
            stale.unlink()
        for stale in (fake / "count", fake / "fail", requests_log, probes):
            stale.unlink(missing_ok=True)
        for index, page in enumerate(pages, start=1):
            (fake / f"deploys-{index}.json").write_text(json.dumps(page))
        (fake / "deploys-last.json").write_text(json.dumps(pages[-1]))

    def run_render(merged: str, state: Path, *extra: str, env_override: dict[str, str] | None = None
                   ) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(driver), "production-render", "--merged-sha", merged, "--state-dir", str(state),
             "--poll-seconds", "0.05", *extra, "--", "bash", "-c", f'echo probes >> "{probes}"'],
            env=render_env if env_override is None else env_override, cwd=repo, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, timeout=120)

    def run_fly(merged: str, state: Path) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(driver), "production", "--merged-sha", merged, "--state-dir", str(state),
             "--poll-seconds", "0.05", "--", "true"],
            env={**render_env, "PATH": "/usr/bin:/bin"}, cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, timeout=120)

    def requests() -> list[str]:
        return requests_log.read_text().splitlines() if requests_log.exists() else []

    def receipt_of(state: Path) -> dict:
        return json.loads((state / "production.json").read_text())

    def blocked(merged: str, live_commit: str, state: Path, reason: str) -> dict:
        """Run to a short bound against a live deploy of ``live_commit``: the
        gate must block (exit 1), never print equivalence, never run the
        follow-up, and record the observed live commit and ``reason``."""
        reset([deploy(live_commit, "live", "dep-live")])
        ran = run_render(merged, state, "--timeout", "0.3")
        assert ran.returncode == 1, ran.stdout
        assert "RENDER_SOURCE_EQUIVALENT" not in ran.stdout and not probes.exists(), ran.stdout
        assert f"Render did not bring {merged[:7]} live within 0s" in ran.stdout, ran.stdout
        assert f"live commit {live_commit[:9]} is not source-equivalent ({reason})" in ran.stdout, ran.stdout
        assert len(requests()) >= 2, "the bounded wait must keep polling the deploys API"
        render = receipt_of(state)["render"]
        assert render["status"] == "timeout" and render["live_commit"] is None and render["polls"] >= 2, render
        assert render["observed_live_commit"] == live_commit and render["observed_live_deploy_id"] == "dep-live", render
        assert render["equivalence"]["equivalent"] is False and render["equivalence"]["reason"] == reason, render
        assert reason in render["error"], render
        return render

    try:
        # (a) Render skipped the merge (no deploy for it); the live deploy's commit
        #     is an ancestor and nothing under the service paths changed: equivalent.
        reset([deploy(live, "live", "dep-live")])
        state_a = tmp / "render-state-a"
        ran = run_render(docs_only, state_a)
        assert ran.returncode == 0, ran.stdout
        assert f"RENDER_SOURCE_EQUIVALENT live={live} merged={docs_only} reason=live-ancestor-same-backend" in ran.stdout
        assert "RENDER_LIVE " not in ran.stdout and "PIPELINE_RENDER then exit=0" in ran.stdout, ran.stdout
        assert probes.read_text() == "probes\n", "the follow-up command must run once the live backend is proven"
        assert requests() == ["/services/srv-fixture/deploys?limit=20 auth=Bearer fixture-key"], requests()
        render = receipt_of(state_a)["render"]
        assert render["provider"] == "render" and render["status"] == "source-equivalent", render
        assert render["merged_sha"] == docs_only and render["live_commit"] == live, render
        assert render["observed_live_commit"] == live and render["service_paths"] == service_paths, render
        assert render["backend_diff"] == [] and render["deploy_id"] == "dep-live" and render["polls"] == 1, render
        equivalence = render["equivalence"]
        assert equivalence["equivalent"] is True and equivalence["relationship"] == "ancestor", equivalence
        assert equivalence["live_is_ancestor"] is True and equivalence["live_is_descendant"] is False, equivalence
        assert equivalence["backend_diff"] == [] and equivalence["service_paths"] == service_paths, equivalence
        assert equivalence["reason"] == "live-ancestor-same-backend" and "Root Directory" in equivalence["detail"]
        assert sorted(equivalence["changed_files"]) == ["docs/notes.md", "scripts/tool.py"], equivalence
        assert render["then"] == {**render["then"], "exit": 0} and render["then"]["command"][0] == "bash", render
        assert receipt_of(state_a)["merged_sha"] == docs_only and "wall_s" in render, receipt_of(state_a)
        # The Fly lane of the same merged SHA carries the Render lane forward.
        ran = run_fly(docs_only, state_a)
        assert ran.returncode == 0, ran.stdout
        after = receipt_of(state_a)
        assert after["status"] == "passed" and after["fly"]["required"] is False, after
        assert after["render"] == render, "production must not drop the Render lane of the same merged SHA"

        # A merge that changes only the root workspace manifest is a backend
        # build input (Render resolves the root workspace graph): never equivalent.
        render = blocked(root_manifest, docs_after, tmp / "render-state-a2", "live-ancestor-backend-changed")
        assert render["backend_diff"] == ["package.json"] and render["equivalence"]["live_is_ancestor"] is True, render

        # (b) A back-end change since the live commit is never equivalent: the
        #     exact-SHA wait runs to its bound and blocks; no follow-up.
        render = blocked(backend_change, live, tmp / "render-state-b", "live-ancestor-backend-changed")
        assert render["backend_diff"] == ["back-end/src/server.ts"], render
        assert render["equivalence"]["live_is_ancestor"] is True and "back-end/" in render["equivalence"]["detail"]

        # (c) The live commit is neither an ancestor nor a descendant of the
        #     merged SHA (a sibling branch) although their back-end trees are
        #     identical: only ancestry blocks, and it does.
        render = blocked(docs_only, sibling, tmp / "render-state-c", "live-unrelated")
        assert render["backend_diff"] == [] and render["equivalence"]["relationship"] == "unrelated", render
        assert render["equivalence"]["live_is_ancestor"] is False and render["equivalence"]["live_is_descendant"] is False

        # (d) Render created a deploy for the merged SHA: the exact-SHA path is
        #     unchanged (building twice, then live); no equivalence is consulted.
        building = [deploy(backend_change, "build_in_progress", "dep-new"), deploy(live, "live", "dep-live")]
        reset(building, building, [deploy(backend_change, "live", "dep-new"), deploy(live, "deactivated", "dep-live")])
        state_d = tmp / "render-state-d"
        ran = run_render(backend_change, state_d)
        assert ran.returncode == 0, ran.stdout
        assert f"RENDER_LIVE commit={backend_change} deploy=dep-new" in ran.stdout, ran.stdout
        assert "RENDER_SOURCE_EQUIVALENT" not in ran.stdout and probes.read_text() == "probes\n", ran.stdout
        assert ran.stdout.count("Render: status=build_in_progress") == 2 and len(requests()) == 3, ran.stdout
        render = receipt_of(state_d)["render"]
        assert render["status"] == "live" and render["live_commit"] == backend_change, render
        assert render["observed_live_commit"] == backend_change and render["observed_live_deploy_id"] == "dep-new"
        assert render["deploy_id"] == "dep-new" and render["deploy_status"] == "live" and render["polls"] == 3, render
        assert render["equivalence"] is None and render["backend_diff"] == [], render
        # A failed deploy for the merged SHA blocks at once, as before.
        reset([deploy(backend_change, "build_failed", "dep-bad"), deploy(live, "live", "dep-live")])
        state_d2 = tmp / "render-state-d2"
        ran = run_render(backend_change, state_d2)
        assert ran.returncode == 1 and "Render deploy build_failed for" in ran.stdout and "dep-bad" in ran.stdout, ran.stdout
        assert not probes.exists() and len(requests()) == 1, ran.stdout
        render = receipt_of(state_d2)["render"]
        assert render["status"] == "deploy-failed" and render["deploy_status"] == "build_failed", render
        assert render["observed_live_commit"] == live, render
        # The Render lane joins an existing Fly-lane receipt of the same SHA
        # instead of replacing it.
        state_e = tmp / "render-state-e"
        ran = run_fly(backend_change, state_e)
        assert ran.returncode == 0, ran.stdout
        reset([deploy(backend_change, "live", "dep-new")])
        ran = run_render(backend_change, state_e)
        assert ran.returncode == 0, ran.stdout
        joined = receipt_of(state_e)
        assert joined["status"] == "passed" and joined["fly"]["required"] is False, joined
        assert joined["render"]["status"] == "live" and joined["semantic_dispatch"]["exit"] == 0, joined

        # (f) Another PR deployed after the merge without touching the service
        #     paths: the live commit is a descendant with the identical backend.
        reset([deploy(docs_after, "live", "dep-later")])
        state_f = tmp / "render-state-f"
        ran = run_render(backend_change, state_f)
        assert ran.returncode == 0, ran.stdout
        assert (f"RENDER_SOURCE_EQUIVALENT live={docs_after} merged={backend_change} "
                "reason=live-descendant-same-backend") in ran.stdout, ran.stdout
        assert probes.read_text() == "probes\n", ran.stdout
        render = receipt_of(state_f)["render"]
        assert render["status"] == "source-equivalent" and render["live_commit"] == docs_after, render
        assert render["merged_sha"] == backend_change and render["observed_live_commit"] == docs_after, render
        equivalence = render["equivalence"]
        assert equivalence["relationship"] == "descendant" and equivalence["equivalent"] is True, equivalence
        assert equivalence["live_is_ancestor"] is False and equivalence["live_is_descendant"] is True, equivalence
        assert equivalence["live_commit"] == docs_after and equivalence["merged_sha"] == backend_change, equivalence
        assert equivalence["backend_diff"] == [] and equivalence["changed_files"] == ["docs/after.md"], equivalence

        # (g) No deploy for the merged SHA and a live descendant that changed
        #     the backend: the live backend contains the merge, so the gate opens
        #     as verified-by-descendant, never as source-equivalent or RENDER_LIVE.
        reset([deploy(backend_change, "live", "dep-later")])
        state_g = tmp / "render-state-g"
        ran = run_render(docs_only, state_g, "--timeout", "5")
        assert ran.returncode == 0, ran.stdout
        assert (f"RENDER_VERIFIED_BY_DESCENDANT live={backend_change} merged={docs_only} "
                "reason=live-descendant-backend-changed") in ran.stdout, ran.stdout
        assert "RENDER_SOURCE_EQUIVALENT" not in ran.stdout and "RENDER_LIVE " not in ran.stdout, ran.stdout
        assert probes.read_text() == "probes\n", ran.stdout
        render = receipt_of(state_g)["render"]
        assert render["status"] == "verified-by-descendant" and render["live_commit"] == backend_change, render
        assert render["deploy_id"] == "dep-later" and render["deploy_status"] == "live", render
        assert render["backend_diff"] == ["back-end/src/server.ts"], render
        assert render["equivalence"]["equivalent"] is False and render["equivalence"]["live_is_descendant"] is True
        descendant = render["verified_by_descendant"]
        assert descendant["reason"] == "live-descendant-backend-changed", descendant
        assert descendant["live_commit"] == backend_change and descendant["merged_sha"] == docs_only, descendant
        assert descendant["live_deploy_id"] == "dep-later" and descendant["merged_deploy_id"] is None, descendant

        # (j) Render canceled the merged deploy because a newer main commit
        #     replaced it: keep waiting while that descendant builds, then open
        #     on it as verified-by-descendant (never relabelled an exact pass).
        superseding = [deploy(backend_v3, "build_in_progress", "dep-v3"), deploy(backend_change, "canceled", "dep-mine"),
                       deploy(live, "live", "dep-live")]
        reset(superseding, [deploy(backend_v3, "live", "dep-v3"), deploy(backend_change, "canceled", "dep-mine"),
                            deploy(live, "deactivated", "dep-live")])
        state_j = tmp / "render-state-j"
        ran = run_render(backend_change, state_j, "--timeout", "30")
        assert ran.returncode == 0, ran.stdout
        assert (f"RENDER_VERIFIED_BY_DESCENDANT live={backend_v3} merged={backend_change} "
                "reason=merged-deploy-canceled-live-descendant") in ran.stdout, ran.stdout
        assert "RENDER_LIVE " not in ran.stdout and "RENDER_SOURCE_EQUIVALENT" not in ran.stdout, ran.stdout
        assert probes.read_text() == "probes\n" and len(requests()) == 2, ran.stdout
        render = receipt_of(state_j)["render"]
        assert render["status"] == "verified-by-descendant" and render["live_commit"] == backend_v3, render
        assert render["deploy_id"] == "dep-v3" and render["deploy_status"] == "live", render
        descendant = render["verified_by_descendant"]
        assert descendant["reason"] == "merged-deploy-canceled-live-descendant", descendant
        assert descendant["merged_deploy_id"] == "dep-mine" and descendant["merged_deploy_status"] == "canceled"
        assert descendant["live_commit"] == backend_v3 and descendant["live_deploy_id"] == "dep-v3", descendant

        # (k) The merged deploy went live and was deactivated by a newer
        #     descendant: verified by that descendant at the first poll.
        reset([deploy(backend_v3, "live", "dep-v3"), deploy(backend_change, "deactivated", "dep-mine")])
        state_k = tmp / "render-state-k"
        ran = run_render(backend_change, state_k, "--timeout", "5")
        assert ran.returncode == 0, ran.stdout
        assert (f"RENDER_VERIFIED_BY_DESCENDANT live={backend_v3} merged={backend_change} "
                "reason=merged-deploy-deactivated-live-descendant") in ran.stdout, ran.stdout
        assert probes.read_text() == "probes\n" and len(requests()) == 1, ran.stdout
        render = receipt_of(state_k)["render"]
        assert render["status"] == "verified-by-descendant" and render["polls"] == 1, render
        assert render["verified_by_descendant"]["merged_deploy_status"] == "deactivated", render

        def refused(merged: str, page: list[dict], state: Path, expected: str) -> dict:
            reset(page)
            ran = run_render(merged, state, "--timeout", "5")
            assert ran.returncode == 1 and expected in ran.stdout, ran.stdout
            assert "RENDER_VERIFIED_BY_DESCENDANT" not in ran.stdout and "RENDER_LIVE " not in ran.stdout, ran.stdout
            assert not probes.exists() and len(requests()) == 1, ran.stdout
            render = receipt_of(state)["render"]
            assert render["status"] == "deploy-failed" and render["live_commit"] is None, render
            assert "verified_by_descendant" not in render, render
            return render

        # (l) Canceled with only an older commit live and nothing newer
        #     deploying: blocked at once, naming the live commit.
        render = refused(backend_change, [deploy(backend_change, "canceled", "dep-mine"), deploy(live, "live", "dep-live")],
                         tmp / "render-state-l", "Render deploy canceled for")
        assert render["observed_live_commit"] == live and render["deploy_status"] == "canceled", render
        assert live[:9] in render["error"] and "no newer descendant" in render["error"], render
        # (m) The descendant that replaced it failed its own build: an unhealthy
        #     rollout is never accepted.
        render = refused(backend_change, [deploy(backend_v3, "build_failed", "dep-v3"),
                                          deploy(backend_change, "canceled", "dep-mine"), deploy(live, "live", "dep-live")],
                         tmp / "render-state-m", "Render deploy canceled for")
        assert render["observed_live_commit"] == live, render
        # (n) Deactivated by a commit that does not descend from the merge (a
        #     rollback to an older commit): blocked at once.
        render = refused(backend_change, [deploy(live, "live", "dep-rollback"),
                                          deploy(backend_change, "deactivated", "dep-mine")],
                         tmp / "render-state-n", "Render deploy deactivated for")
        assert render["observed_live_commit"] == live and "not a descendant" in render["error"], render
        # (o) The live descendant is a newer main merge this checkout has not
        #     fetched yet: one `git fetch origin main` learns it, then it verifies.
        origin = tmp / "render-origin.git"
        subprocess.run(["git", "clone", "-q", "--bare", str(repo), str(origin)], check=True)
        work = tmp / "render-origin-work"
        subprocess.run(["git", "clone", "-q", str(origin), str(work)], check=True)
        (work / "back-end" / "src" / "server.ts").write_text("v4\n")
        work_git = ["git", "-C", str(work), "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"]
        subprocess.run([*work_git, "commit", "-qam", "backend v4 (newer main)"], check=True)
        unfetched = subprocess.run([*work_git, "rev-parse", "HEAD"], check=True, stdout=subprocess.PIPE,
                                   text=True).stdout.strip()
        subprocess.run([*work_git, "push", "-q", "origin", "HEAD:refs/heads/main"], check=True)
        subprocess.run([*git, "remote", "add", "origin", str(origin)], check=True)
        assert subprocess.run([*git, "cat-file", "-e", f"{unfetched}^{{commit}}"],
                              stderr=subprocess.DEVNULL).returncode != 0, "the newer main merge must start unfetched"
        reset([deploy(unfetched, "live", "dep-v4"), deploy(backend_v3, "canceled", "dep-mine")])
        state_o = tmp / "render-state-o"
        ran = run_render(backend_v3, state_o, "--timeout", "5")
        assert ran.returncode == 0, ran.stdout
        assert (f"RENDER_VERIFIED_BY_DESCENDANT live={unfetched} merged={backend_v3} "
                "reason=merged-deploy-canceled-live-descendant") in ran.stdout, ran.stdout
        assert receipt_of(state_o)["render"]["status"] == "verified-by-descendant", receipt_of(state_o)

        # (e) A Render API error fails closed: exit 2, no follow-up, error
        #     recorded; missing credentials never reach the API.
        reset([deploy(live, "live", "dep-live")])
        (fake / "fail").touch()
        state_h = tmp / "render-state-h"
        ran = run_render(docs_only, state_h)
        assert ran.returncode == 2 and "HTTP 500" in ran.stdout and "PIPELINE_RENDER status=error exit=2" in ran.stdout, ran.stdout
        assert "RENDER_SOURCE_EQUIVALENT" not in ran.stdout and not probes.exists(), ran.stdout
        render = receipt_of(state_h)["render"]
        assert render["status"] == "error" and "HTTP 500" in render["error"] and render["then"] is None, render
        reset([deploy(live, "live", "dep-live")])
        ran = run_render(docs_only, tmp / "render-state-i",
                         env_override={k: v for k, v in render_env.items() if k != "RENDER_API_KEY"})
        assert ran.returncode == 2 and "RENDER_API_KEY not set" in ran.stdout and requests() == [], ran.stdout
        assert not probes.exists(), ran.stdout
        assert receipt_of(tmp / "render-state-i")["render"]["status"] == "error", receipt_of(tmp / "render-state-i")
    finally:
        server.shutdown()
        server.server_close()
    print("production render wait: ok")


def check_production_semantic(tmp: Path, env: dict[str, str]) -> None:
    """``production-semantic`` (deploy.md Step 13b) dispatches the production
    semantic workflow with ``source_sha=<merged SHA>``, binds to the newest run
    created after the dispatch whose title names that SHA (an older run, even
    one titled with the same SHA, a newer run of another SHA and a decoy whose
    headSha is the merged SHA but carries no title are never adopted), polls
    it, records the run under ``semantic`` in production.json, exits non-zero
    unless the run succeeded, reruns only failed jobs exactly once with
    ``--retry-failed-once`` and refuses a second retry. Re-running the Fly
    gate (``production``) for the same SHA carries the semantic lane forward,
    and a run left ``in_progress`` by a CLI-side timeout is resumed, never
    re-dispatched. A dispatch gh confirmed but whose run was never adopted (a
    failed ``gh run list`` or a discovery timeout) is recorded as
    ``dispatched`` and resumed by the next call, which adopts its run without
    a second ``workflow run``; only a confirmed dispatch older than the resume
    window with still no run is abandoned and dispatched anew. gh is a fake
    executable on PATH; the receipt the Fly gate writes is required first."""
    repo = tmp / "semantic-source"
    repo.mkdir()
    scripts = repo / "scripts"
    scripts.mkdir()
    for name in ("run_deploy_pipeline.py", "deploy_stage_wait.py", "factory_metadata.py",
                 "classify-agent-runtime-changes.sh"):
        shutil.copyfile(ROOT / "scripts" / name, scripts / name)
    (repo / ".gitignore").write_text(".context/\n__pycache__/\n")
    # The merge's own deploy-agents.yml push filter decides the cutover.
    (repo / ".github" / "workflows").mkdir(parents=True)
    shutil.copyfile(ROOT / ".github" / "workflows" / "deploy-agents.yml", repo / ".github" / "workflows" / "deploy-agents.yml")
    git = ["git", "-C", str(repo), "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"]
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    for message, files in (("base", {"README": "base\n"}), ("backend only", {"back-end/src/x.ts": "y\n"})):
        for relative, content in files.items():
            (repo / relative).parent.mkdir(parents=True, exist_ok=True)
            (repo / relative).write_text(content)
        subprocess.run([*git, "add", "-A"], check=True)
        subprocess.run([*git, "commit", "-qm", message], check=True)
    merged = subprocess.run([*git, "rev-parse", "HEAD"], check=True, stdout=subprocess.PIPE, text=True).stdout.strip()
    other_head = "2" * 40
    driver = scripts / "run_deploy_pipeline.py"
    fake = tmp / "semantic-fake"
    fake.mkdir()
    bin_dir = fake / "bin"
    bin_dir.mkdir()
    (bin_dir / "gh").write_text(
        "#!/usr/bin/env bash\n"
        'echo "$*" >> "$FAKE_GH_DIR/calls.log"\n'
        'echo "$1 $2 ${GH_TOKEN:-unset}" >> "$FAKE_GH_DIR/tokens.log"\n'
        # A token GitHub refuses (e.g. the exhausted primary) fails every read.
        'if [ -n "${FAKE_GH_DENY_TOKEN:-}" ] && [ "${GH_TOKEN:-}" = "$FAKE_GH_DENY_TOKEN" ]; then\n'
        '  case "$1 $2" in "run view"|"run list") echo "$FAKE_GH_DENY_MESSAGE" >&2; exit 1 ;; esac\n'
        'fi\n'
        'case "$1 $2" in\n'
        '  "workflow run") [ -f "$FAKE_GH_DIR/dispatch-fail" ] && { echo "HTTP 422: Unexpected inputs provided" >&2; exit 1; }\n'
        '    for a in "$@"; do case "$a" in dispatch_id=*) echo "${a#dispatch_id=}" > "$FAKE_GH_DIR/dispatch-id" ;; esac; done; exit 0 ;;\n'
        '  "run list") [ -f "$FAKE_GH_DIR/list-fail" ] && { echo "HTTP 502: Bad Gateway" >&2; exit 1; }\n'
        '    n=$(cat "$FAKE_GH_DIR/list-count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAKE_GH_DIR/list-count"\n'
        '    f="$FAKE_GH_DIR/list-$n.json"; [ -f "$f" ] || f="$FAKE_GH_DIR/list-last.json"\n'
        '    sed "s/__DISPATCH__/$(cat "$FAKE_GH_DIR/dispatch-id" 2>/dev/null)/g" "$f" ;;\n'
        '  "run rerun") [ -f "$FAKE_GH_DIR/rerun-fail" ] && { echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; }\n'
        '    touch "$FAKE_GH_DIR/rerun-done"; exit 0 ;;\n'
        '  "run view") prefix=view; [ -f "$FAKE_GH_DIR/rerun-done" ] && prefix=rerun-view\n'
        '    n=$(cat "$FAKE_GH_DIR/$prefix-count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAKE_GH_DIR/$prefix-count"\n'
        '    f="$FAKE_GH_DIR/$prefix-$n.json"; [ -f "$f" ] || f="$FAKE_GH_DIR/$prefix-last.json"\n'
        '    sed "s/__DISPATCH__/$(cat "$FAKE_GH_DIR/dispatch-id" 2>/dev/null)/g" "$f" ;;\n'
        '  *) echo "unexpected gh $*" >&2; exit 1 ;;\n'
        "esac\n")
    (bin_dir / "gh").chmod(0o755)
    # The live frontend's /version.json (vite.config.ts productionBuildId): by
    # default it serves the merge's own build, so the exact binding applies.
    version_body = fake / "version.json"
    version_body.write_text(json.dumps({"buildId": f"{merged[:12]}-mwfixture"}))

    class VersionHandler(BaseHTTPRequestHandler):
        def log_message(self, *_args) -> None:  # keep the fixture output clean
            return

        def do_GET(self) -> None:
            with (fake / "version-requests.log").open("a") as log:
                log.write(f"{self.path} {self.headers.get('Cache-Control')}\n")
            if (fake / "version-fail").exists():
                self.send_error(503, "fixture outage")
                return
            count = int((fake / "version-count").read_text()) + 1 if (fake / "version-count").exists() else 1
            (fake / "version-count").write_text(str(count))
            step = fake / f"version-{count}.json"  # an optional per-read sequence, then version.json
            body = step.read_bytes() if step.exists() else version_body.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    version_server = ThreadingHTTPServer(("127.0.0.1", 0), VersionHandler)
    threading.Thread(target=version_server.serve_forever, daemon=True).start()
    sem_env = {**env, "PATH": f"{bin_dir}:{env.get('PATH', os.environ.get('PATH', ''))}", "FAKE_GH_DIR": str(fake),
               "DEPLOY_SEMANTIC_VERSION_URL": f"http://127.0.0.1:{version_server.server_address[1]}/version.json"}
    sem_env.pop("DEPLOY_GH_BIN", None)
    calls = fake / "calls.log"
    tokens = fake / "tokens.log"
    past = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    later = (datetime.now(timezone.utc) + timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")

    def row(run_id: int, created: str, sha: str | None, head: str, status: str = "in_progress",
            dispatch: str = "__DISPATCH__") -> dict:
        """``__DISPATCH__`` is the fake gh's latest dispatch_id: the run that dispatch created."""
        title = (f"Production semantic gate source_sha={sha} dispatch={dispatch}" if sha
                 else "Production semantic gate deployment=77")
        return {"databaseId": run_id, "createdAt": created, "headSha": head, "status": status, "conclusion": None,
                "event": "workflow_dispatch", "url": f"https://github.com/acme/rose/actions/runs/{run_id}",
                "displayTitle": title}

    # An older run titled with the same SHA (yesterday's deploy of it), an older
    # run of another SHA, the run this dispatch creates (headSha = main's later
    # head, title = merged SHA), a newer run of another SHA and a decoy whose
    # headSha is the merged SHA but whose title names no source commit.
    old_same = row(100, past, merged, merged, "completed")
    old_other = row(101, past, "3" * 40, "3" * 40, "completed")
    ours = row(200, future, merged, other_head)
    newer_other = row(300, later, "4" * 40, "4" * 40)
    # Another dispatch's run of the same source, created after ours (two
    # verifications bound to one live commit, 2026-11-15 runs 43690260324 and
    # 43690277150): its dispatch id differs, so it is never adopted.
    twin = row(250, later, merged, other_head, dispatch="f" * 32)
    decoy = row(400, later, None, merged)

    def job(name: str, conclusion: str | None, status: str = "completed") -> dict:
        return {"name": name, "status": status, "conclusion": conclusion, "url": f"https://github.com/acme/rose/actions/runs/200/job/{abs(hash(name)) % 1000}"}

    lifecycle = [f"Chat full-lifecycle latency ratchet ({path})" for path in ("direct_answer", "web_search", "agent_plan", "agent_execute")]
    all_success = [job("Semantic frontend flows", "success"), *[job(name, "success") for name in lifecycle]]
    semantic_failed = [job("Semantic frontend flows", "failure"), *[job(name, "success") for name in lifecycle]]
    running_jobs = [job("Semantic frontend flows", None, "in_progress")]

    def view(status: str, conclusion: str | None, attempt: int, jobs: list[dict]) -> dict:
        return {"status": status, "conclusion": conclusion, "attempt": attempt, "url": ours["url"], "headSha": other_head,
                "displayTitle": ours["displayTitle"], "createdAt": future, "updatedAt": later, "jobs": jobs}

    def reset(lists: list[list[dict]], views: list[dict], rerun_views: list[dict] | None = None) -> None:
        for stale in list(fake.glob("list-*")) + list(fake.glob("view-*")) + list(fake.glob("rerun-*")):
            stale.unlink()
        calls.unlink(missing_ok=True)
        tokens.unlink(missing_ok=True)
        (fake / "dispatch-fail").unlink(missing_ok=True)
        for index, rows in enumerate(lists, start=1):
            (fake / f"list-{index}.json").write_text(json.dumps(rows))
        (fake / "list-last.json").write_text(json.dumps(lists[-1]))
        for index, payload in enumerate(views, start=1):
            (fake / f"view-{index}.json").write_text(json.dumps(payload))
        (fake / "view-last.json").write_text(json.dumps(views[-1]))
        for index, payload in enumerate(rerun_views or [], start=1):
            (fake / f"rerun-view-{index}.json").write_text(json.dumps(payload))
        if rerun_views:
            (fake / "rerun-view-last.json").write_text(json.dumps(rerun_views[-1]))

    def run_gate(state: Path) -> dict:
        """The real Fly gate for a merge without agent runtime changes: it opens
        without any gh call and writes the receipt the semantic lane requires."""
        calls.unlink(missing_ok=True)
        ran = subprocess.run([sys.executable, str(driver), "production", "--merged-sha", merged, "--state-dir", str(state),
                              "--expected-hash", "feedface"], env=sem_env, cwd=repo, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, timeout=120)
        assert ran.returncode == 0 and not calls.exists(), ran.stdout
        return receipt_of(state)

    def write_gate(state: Path, sha: str, status: str) -> None:
        state.mkdir(parents=True, exist_ok=True)
        (state / "production.json").write_text(json.dumps({"schema_version": 1, "merged_sha": sha, "status": status,
                                                            "github_waits": [], "fly": {"required": False}}))

    def run_semantic(state: Path, *extra: str, env_override: dict[str, str] | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(driver), "production-semantic", "--merged-sha", merged, "--state-dir", str(state),
             "--poll-seconds", "0.05", "--start-timeout", "0.5", *extra],
            env=env_override or sem_env, cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120)

    def call_lines() -> list[str]:
        return calls.read_text().splitlines() if calls.exists() else []

    def receipt_of(state: Path) -> dict:
        return json.loads((state / "production.json").read_text())

    def semantic_waits(receipt: dict) -> list[dict]:
        return [w for w in receipt["github_waits"] if w["workflow"] == "chat-lifecycle-ratchet.yml"]

    # 1. Success: the run is not listed on the first poll; then it is picked
    #    among older, newer and decoy runs; three views until completed/success.
    state = tmp / "semantic-state"
    gate = run_gate(state)
    assert gate["status"] == "passed" and gate["fly"]["required"] is False and "semantic" not in gate, gate
    reset([[old_other, old_same, decoy], [newer_other, twin, decoy, ours, old_other, old_same]],
          [view("queued", None, 1, []), view("in_progress", None, 1, running_jobs), view("completed", "success", 1, all_success)])
    ran = run_semantic(state, "--frontend-url", "https://preview.roselabs.ai", "--backend-url", "https://api.roselabs.ai")
    assert ran.returncode == 0, ran.stdout
    lines = call_lines()
    dispatch_id = receipt_of(state)["semantic"]["dispatch"]["inputs"]["dispatch_id"]
    assert re.fullmatch(r"[0-9a-f]{32}", dispatch_id), dispatch_id
    assert lines[0] == ("workflow run chat-lifecycle-ratchet.yml --ref main -f source_sha=" + merged +
                        " -f frontend_url=https://preview.roselabs.ai -f backend_url=https://api.roselabs.ai"
                        " -f dispatch_id=" + dispatch_id), lines
    list_calls = [line for line in lines if line.startswith("run list")]
    assert len(list_calls) == 2 and "--workflow chat-lifecycle-ratchet.yml" in list_calls[0], list_calls
    assert "--event workflow_dispatch" in list_calls[0] and "--branch main" in list_calls[0], list_calls
    view_calls = [line for line in lines if line.startswith("run view")]
    assert len(view_calls) == 3 and all(line.startswith("run view 200 --json") for line in view_calls), lines
    assert not any(f" {decoy_id} " in f" {line} " for line in lines for decoy_id in (100, 101, 250, 300, 400)), lines
    assert not any(line.startswith("run rerun") for line in lines), lines
    assert "SEMANTIC_RUN_ID=200" in ran.stdout and "SEMANTIC_LANE_END " in ran.stdout, ran.stdout
    assert ran.stdout.index("SEMANTIC_RUN_ID=200") < ran.stdout.index("SEMANTIC_LANE_END"), ran.stdout
    assert "PIPELINE_SEMANTIC status=passed exit=0 run=200" in ran.stdout, ran.stdout
    receipt = receipt_of(state)
    assert receipt["status"] == "passed" and receipt["merged_sha"] == merged, receipt  # the Fly decision is untouched
    entry = receipt["semantic"]
    assert entry["outcome"] == "passed" and entry["run_id"] == "200" and entry["url"] == ours["url"], entry
    assert entry["head_sha"] == other_head and entry["source_sha"] == merged, entry
    assert entry["display_title"] == ours["displayTitle"].replace("__DISPATCH__", dispatch_id), entry
    assert entry["created_at"] == future, entry
    assert entry["completed_at"] == later and entry["conclusion"] == "success" and entry["attempt"] == 1, entry
    assert entry["status"] == "completed" and entry["retry"] is None, entry
    assert entry["dispatch"]["ref"] == "main" and entry["dispatch"]["at"], entry["dispatch"]
    assert entry["dispatch"]["inputs"] == {"source_sha": merged, "frontend_url": "https://preview.roselabs.ai",
                                           "backend_url": "https://api.roselabs.ai", "dispatch_id": dispatch_id}, entry["dispatch"]
    assert [(j["name"], j["conclusion"]) for j in entry["jobs"]] == [(j["name"], "success") for j in all_success], entry["jobs"]
    waits = semantic_waits(receipt)
    assert [w["kind"] for w in waits] == ["run-start", "run-complete"], waits
    assert waits[0] == {**waits[0], "run_id": "200", "polls": 2, "outcome": "found", "head": merged}
    assert waits[1] == {**waits[1], "run_id": "200", "polls": 3, "conclusion": "success", "attempt": 1}

    # 2. Failure without the retry flag: exit 1, no rerun, the earlier passed
    #    entry is kept in semantic_history. The default URLs are the production ones.
    reset([[ours, old_same]], [view("completed", "failure", 1, semantic_failed)])
    ran = run_semantic(state)
    assert ran.returncode == 1, ran.stdout
    assert "-f frontend_url=https://www.roselabs.ai -f backend_url=https://navi-j9a9.onrender.com -f dispatch_id=" in call_lines()[0], call_lines()
    assert receipt_of(state)["semantic"]["dispatch"]["inputs"]["dispatch_id"] != dispatch_id, "every dispatch gets a fresh id"
    assert "PIPELINE_SEMANTIC status=failed exit=1 run=200" in ran.stdout and "conclusion=failure" in ran.stdout, ran.stdout
    assert "Semantic frontend flows=failure" in ran.stdout and "SEMANTIC_LANE_END " in ran.stdout, ran.stdout
    assert 'retry=available (--retry-failed-once "<justification>")' in ran.stdout, ran.stdout
    assert not any(line.startswith("run rerun") for line in call_lines()), call_lines()
    receipt = receipt_of(state)
    assert receipt["semantic"]["outcome"] == "failed" and receipt["semantic"]["conclusion"] == "failure", receipt["semantic"]
    assert receipt["semantic"]["error"] == "run 200 concluded failure", receipt["semantic"]
    assert [h["outcome"] for h in receipt["semantic_history"]] == ["passed"], receipt["semantic_history"]
    assert receipt["status"] == "passed", "the Fly gate decision must not be rewritten by the semantic lane"
    assert len(semantic_waits(receipt)) == 4, semantic_waits(receipt)

    # 2b. The Step 13b block is re-run: `production` for the same SHA carries the
    #     semantic lane (run, history, waits) forward instead of forgetting it.
    gate = run_gate(state)
    assert gate["status"] == "passed" and gate["started_at"], gate
    assert gate["semantic"] == receipt["semantic"] and gate["semantic_history"] == receipt["semantic_history"], gate
    assert semantic_waits(gate) == semantic_waits(receipt) and not [w for w in gate["github_waits"] if w["workflow"] != "chat-lifecycle-ratchet.yml"], gate["github_waits"]

    # 3. One retry of that recorded failed run: no new dispatch, `gh run rerun
    #    200 --failed`, the stale completed attempt-1 view is not accepted, the
    #    attempt-2 success is; the justification is recorded.
    reset([[ours]], [view("completed", "failure", 1, semantic_failed)],
          rerun_views=[view("completed", "failure", 1, semantic_failed), view("in_progress", None, 2, semantic_failed),
                       view("completed", "success", 2, all_success)])
    ran = run_semantic(state, "--retry-failed-once", "provider outage: Kernel 502 in the semantic job")
    assert ran.returncode == 0, ran.stdout
    lines = call_lines()
    assert lines[0] == "run rerun 200 --failed", lines
    assert not any(line.startswith("workflow run") or line.startswith("run list") for line in lines), lines
    assert len([line for line in lines if line.startswith("run view 200")]) == 3, lines
    assert "SEMANTIC_RUN_ID=200" in ran.stdout and "retry=failed-jobs run=200" in ran.stdout, ran.stdout
    entry = receipt_of(state)["semantic"]
    assert entry["outcome"] == "passed" and entry["conclusion"] == "success" and entry["attempt"] == 2, entry
    retry = entry["retry"]
    assert retry["justification"] == "provider outage: Kernel 502 in the semantic job", retry
    assert retry["previous_attempt"] == 1 and retry["previous_conclusion"] == "failure" and retry["attempt"] == 2, retry
    assert retry["failed_jobs"] == ["Semantic frontend flows"], retry

    # 4. A second retry is refused without any gh call, also after the Fly gate
    #    re-ran; the receipt keeps the first.
    run_gate(state)
    reset([[ours]], [view("completed", "success", 2, all_success)])
    ran = run_semantic(state, "--retry-failed-once", "again")
    assert ran.returncode == 2 and "already used its one --retry-failed-once" in ran.stdout, ran.stdout
    assert call_lines() == [], call_lines()
    assert receipt_of(state)["semantic"]["retry"]["justification"].startswith("provider outage"), receipt_of(state)["semantic"]

    # 5. Flag on a fresh dispatch: dispatch, fail, rerun failed jobs once, fail
    #    again -> exit 1 with the retry recorded; a further flagged call is refused.
    state5 = tmp / "semantic-state-5"
    run_gate(state5)
    reset([[ours]], [view("completed", "failure", 1, semantic_failed)],
          rerun_views=[view("completed", "failure", 2, semantic_failed)])
    ran = run_semantic(state5, "--retry-failed-once", "flaky runner")
    assert ran.returncode == 1 and "retry=used" in ran.stdout, ran.stdout
    lines = call_lines()
    assert lines[0].startswith("workflow run chat-lifecycle-ratchet.yml") and lines.count("run rerun 200 --failed") == 1, lines
    entry = receipt_of(state5)["semantic"]
    assert entry["outcome"] == "failed" and entry["attempt"] == 2 and entry["retry"]["attempt"] == 2, entry
    calls.unlink()
    ran = run_semantic(state5, "--retry-failed-once", "once more")
    assert ran.returncode == 2 and call_lines() == [], (ran.stdout, call_lines())

    # 5b. A rejected rerun (403) does not consume the single retry: the next
    #     flagged call reruns the recorded run.
    state5b = tmp / "semantic-state-5b"
    run_gate(state5b)
    reset([[ours]], [view("completed", "failure", 1, semantic_failed)])
    (fake / "rerun-fail").touch()
    ran = run_semantic(state5b, "--retry-failed-once", "token lacked actions:write")
    assert ran.returncode == 1 and "Resource not accessible by integration" in ran.stdout, ran.stdout
    entry = receipt_of(state5b)["semantic"]
    assert entry["retry"] is None and entry["run_id"] == "200" and entry["status"] == "completed", entry
    reset([[ours]], [view("completed", "failure", 1, semantic_failed)],
          rerun_views=[view("completed", "success", 2, all_success)])
    ran = run_semantic(state5b, "--retry-failed-once", "token fixed")
    assert ran.returncode == 0 and call_lines()[0] == "run rerun 200 --failed", (ran.stdout, call_lines())
    entry = receipt_of(state5b)["semantic"]
    assert entry["retry"]["justification"] == "token fixed" and entry["retry"]["attempt"] == 2 and entry["outcome"] == "passed", entry

    # 6. No passed Fly-gate receipt for this SHA: refused before any gh call.
    for state6, sha, status in ((tmp / "semantic-state-6a", merged, "failed"), (tmp / "semantic-state-6b", other_head, "passed")):
        write_gate(state6, sha, status)
        reset([[ours]], [view("completed", "success", 1, all_success)])
        ran = run_semantic(state6)
        assert ran.returncode == 2 and "Fly lane gate is not open" in ran.stdout and call_lines() == [], ran.stdout
    reset([[ours]], [view("completed", "success", 1, all_success)])
    ran = run_semantic(tmp / "semantic-state-6c")
    assert ran.returncode == 2 and "no receipt" in ran.stdout and call_lines() == [], ran.stdout

    # 7. Only older runs (one titled with the same SHA) and the decoy ever
    #    appear: the dispatch is unconfirmed, nothing is adopted or polled, exit 1.
    state7 = tmp / "semantic-state-7"
    run_gate(state7)
    reset([[old_same, old_other, decoy]], [view("completed", "success", 1, all_success)])
    ran = run_semantic(state7)
    assert ran.returncode == 1 and "an older run is never adopted" in ran.stdout and "host clock" in ran.stdout, ran.stdout
    lines = call_lines()
    assert lines[0].startswith("workflow run") and not any(line.startswith("run view") for line in lines), lines
    assert len([line for line in lines if line.startswith("run list")]) >= 2, lines
    receipt = receipt_of(state7)
    assert receipt["semantic"]["outcome"] == "failed" and receipt["semantic"]["run_id"] is None, receipt["semantic"]
    assert receipt["semantic"]["status"] == "dispatched", "gh confirmed the dispatch: it must be recorded"
    assert receipt["github_waits"][-1] == {**receipt["github_waits"][-1], "kind": "run-start", "outcome": "timeout",
                                           "workflow": "chat-lifecycle-ratchet.yml"}, receipt["github_waits"]
    assert "it resumes this dispatch for 900s before dispatching again" in ran.stdout, ran.stdout
    # The confirmed dispatch is resumed: the next call looks for its run and
    # adopts it without a second `workflow run` (the gate would run twice).
    dispatch7 = receipt["semantic"]["dispatch"]
    reset([[ours]], [view("completed", "success", 1, all_success)])
    ran = run_semantic(state7)
    assert ran.returncode == 0 and f"PIPELINE_SEMANTIC resume dispatch at={dispatch7['at']}" in ran.stdout, ran.stdout
    lines = call_lines()
    assert lines[0].startswith("run list") and not any(line.startswith("workflow run") for line in lines), lines
    receipt = receipt_of(state7)
    assert receipt["semantic"]["run_id"] == "200" and receipt["semantic"]["outcome"] == "passed", receipt["semantic"]
    assert receipt["semantic"]["dispatch"] == dispatch7 and "semantic_history" not in receipt, receipt

    # 8. The dispatch itself fails (e.g. main's workflow lacks the input): exit 1
    #    with gh's message, no discovery.
    state8 = tmp / "semantic-state-8"
    run_gate(state8)
    reset([[ours]], [view("completed", "success", 1, all_success)])
    (fake / "dispatch-fail").touch()
    ran = run_semantic(state8)
    assert ran.returncode == 1 and "Unexpected inputs provided" in ran.stdout, ran.stdout
    assert [line.split()[0:2] for line in call_lines()] == [["workflow", "run"]], call_lines()

    # 9. A malformed SHA is a usage error before anything runs.
    ran = subprocess.run([sys.executable, str(driver), "production-semantic", "--merged-sha", "main", "--state-dir", str(state)],
                         env=sem_env, cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=60)
    assert ran.returncode == 2 and "full 40-hex commit SHA" in ran.stdout, ran.stdout

    # 10. DEPLOY_GH_BIN selects the gh binary (boxes.dev's PATH wrapper swaps
    #     the token); with it set, the PATH gh is never consulted.
    (bin_dir / "gh-real").write_text("#!/usr/bin/env bash\n"
                                     'echo "$*" >> "$FAKE_GH_DIR/real-calls.log"\n'
                                     'exec "$(dirname "$0")/gh" "$@"\n')
    (bin_dir / "gh-real").chmod(0o755)
    state10 = tmp / "semantic-state-10"
    run_gate(state10)
    reset([[ours]], [view("completed", "success", 1, all_success)])
    ran = run_semantic(state10, env_override={**sem_env, "PATH": "/usr/bin:/bin", "DEPLOY_GH_BIN": str(bin_dir / "gh-real")})
    assert ran.returncode == 0, ran.stdout
    real_calls = (fake / "real-calls.log").read_text().splitlines()
    assert len(real_calls) == len(call_lines()) == 3 and real_calls[0].startswith("workflow run"), (real_calls, call_lines())

    # 11. A CLI-side timeout leaves the run in_progress; the next call resumes
    #     that run (no dispatch, no discovery) and goes green.
    state11 = tmp / "semantic-state-11"
    run_gate(state11)
    reset([[ours]], [view("in_progress", None, 1, running_jobs)])
    ran = run_semantic(state11, "--timeout", "0.2")
    assert ran.returncode == 1 and "is still in_progress after 0s" in ran.stdout, ran.stdout
    entry = receipt_of(state11)["semantic"]
    assert entry["run_id"] == "200" and entry["status"] == "in_progress" and entry["outcome"] == "failed", entry
    assert semantic_waits(receipt_of(state11))[-1] == {**semantic_waits(receipt_of(state11))[-1], "kind": "run-complete", "outcome": "timeout"}
    reset([[ours]], [view("in_progress", None, 1, running_jobs), view("completed", "success", 1, all_success)])
    ran = run_semantic(state11)
    assert ran.returncode == 0 and "PIPELINE_SEMANTIC resume run=200 status=in_progress" in ran.stdout, ran.stdout
    lines = call_lines()
    assert lines and all(line.startswith("run view 200") for line in lines) and len(lines) == 2, lines
    entry = receipt_of(state11)["semantic"]
    assert entry["outcome"] == "passed" and entry["conclusion"] == "success" and entry["retry"] is None, entry
    assert entry["dispatch"]["at"] and entry["run_id"] == "200", entry

    # 12. Timeout, then a flagged resume: the run concluded failure meanwhile,
    #     failed jobs are rerun once in the same call; a timeout during the
    #     retry watch resumes at the retry attempt; a later flag is refused.
    state12 = tmp / "semantic-state-12"
    run_gate(state12)
    reset([[ours]], [view("in_progress", None, 1, running_jobs)])
    ran = run_semantic(state12, "--timeout", "0.2")
    assert ran.returncode == 1 and receipt_of(state12)["semantic"]["status"] == "in_progress", ran.stdout
    reset([[ours]], [view("completed", "failure", 1, semantic_failed)],
          rerun_views=[view("completed", "failure", 1, semantic_failed), view("in_progress", None, 2, running_jobs)])
    ran = run_semantic(state12, "--retry-failed-once", "runner lost the browser", "--timeout", "0.3")
    assert ran.returncode == 1 and "resume run=200" in ran.stdout and "retry=failed-jobs run=200" in ran.stdout, ran.stdout
    lines = call_lines()
    assert not any(line.startswith("workflow run") or line.startswith("run list") for line in lines), lines
    assert lines.count("run rerun 200 --failed") == 1, lines
    entry = receipt_of(state12)["semantic"]
    assert entry["retry"]["justification"] == "runner lost the browser" and entry["retry"]["attempt"] is None, entry
    assert entry["status"] == "in_progress" and entry["attempt"] == 2, entry
    reset([[ours]], [view("completed", "failure", 1, semantic_failed)],
          rerun_views=[view("completed", "success", 2, all_success)])
    (fake / "rerun-done").touch()  # the rerun already happened on GitHub
    ran = run_semantic(state12)
    assert ran.returncode == 0 and "resume run=200 status=in_progress" in ran.stdout, ran.stdout
    assert call_lines() == ["run view 200 --json " + "status,conclusion,attempt,url,headSha,displayTitle,createdAt,updatedAt,jobs"], call_lines()
    entry = receipt_of(state12)["semantic"]
    assert entry["outcome"] == "passed" and entry["attempt"] == 2 and entry["retry"]["attempt"] == 2, entry
    calls.unlink()
    ran = run_semantic(state12, "--retry-failed-once", "again")
    assert ran.returncode == 2 and call_lines() == [], (ran.stdout, call_lines())

    # 13. `gh run list` fails right after a confirmed dispatch: exit 1 with the
    #     dispatch recorded (status dispatched, run_id null, inputs); the next
    #     call adopts that dispatch's run without a second `workflow run`.
    state13 = tmp / "semantic-state-13"
    run_gate(state13)
    reset([[ours]], [view("completed", "success", 1, all_success)])
    (fake / "list-fail").touch()
    ran = run_semantic(state13)
    assert ran.returncode == 1 and "Bad Gateway" in ran.stdout and "SEMANTIC_LANE_END " in ran.stdout, ran.stdout
    assert [line.split()[0:2] for line in call_lines()] == [["workflow", "run"], ["run", "list"]], call_lines()
    entry = receipt_of(state13)["semantic"]
    assert entry["status"] == "dispatched" and entry["run_id"] is None and entry["outcome"] == "failed", entry
    assert entry["dispatch"]["at"] and entry["dispatch"]["inputs"] == {
        "source_sha": merged, "frontend_url": "https://www.roselabs.ai", "backend_url": "https://navi-j9a9.onrender.com",
        "dispatch_id": entry["dispatch"]["inputs"]["dispatch_id"]}, entry
    assert call_lines()[0].endswith(" -f dispatch_id=" + entry["dispatch"]["inputs"]["dispatch_id"]), call_lines()
    dispatch13 = entry["dispatch"]
    reset([[ours]], [view("completed", "success", 1, all_success)])
    ran = run_semantic(state13)
    assert ran.returncode == 0 and f"PIPELINE_SEMANTIC resume dispatch at={dispatch13['at']}" in ran.stdout, ran.stdout
    lines = call_lines()
    assert lines[0].startswith("run list") and not any(line.startswith("workflow run") for line in lines), lines
    assert "SEMANTIC_RUN_ID=200" in ran.stdout and "PIPELINE_SEMANTIC status=passed exit=0 run=200" in ran.stdout, ran.stdout
    receipt = receipt_of(state13)
    entry = receipt["semantic"]
    assert entry["outcome"] == "passed" and entry["run_id"] == "200" and entry["status"] == "completed", entry
    assert entry["dispatch"] == dispatch13 and "semantic_history" not in receipt, receipt
    assert [(w["kind"], w["outcome"]) for w in semantic_waits(receipt)] == [("run-start", "found"), ("run-complete", "completed")], semantic_waits(receipt)

    # 14. A confirmed dispatch older than the resume window gets one more
    #     query: its run, when listed, is adopted (14a); with no run it is
    #     abandoned to semantic_history and the gate is dispatched anew (14b).
    stale_at = (datetime.now(timezone.utc) - timedelta(minutes=16)).strftime("%Y-%m-%dT%H:%M:%SZ")

    def stale_dispatch(state: Path) -> None:
        run_gate(state)
        reset([[ours]], [view("completed", "success", 1, all_success)])
        (fake / "list-fail").touch()
        assert run_semantic(state).returncode == 1
        receipt = receipt_of(state)
        assert receipt["semantic"]["status"] == "dispatched", receipt["semantic"]
        receipt["semantic"]["dispatch"]["at"] = stale_at
        (state / "production.json").write_text(json.dumps(receipt))

    state14a = tmp / "semantic-state-14a"
    stale_dispatch(state14a)
    reset([[ours]], [view("completed", "success", 1, all_success)])
    ran = run_semantic(state14a)
    assert ran.returncode == 0 and f"resume dispatch at={stale_at}" in ran.stdout, ran.stdout
    lines = call_lines()
    assert lines[0].startswith("run list") and not any(line.startswith("workflow run") for line in lines), lines
    receipt = receipt_of(state14a)
    assert receipt["semantic"]["run_id"] == "200" and receipt["semantic"]["dispatch"]["at"] == stale_at, receipt["semantic"]
    assert "semantic_history" not in receipt and "abandoning" not in ran.stdout, (receipt, ran.stdout)

    state14b = tmp / "semantic-state-14b"
    stale_dispatch(state14b)
    reset([[old_same, decoy], [ours]], [view("completed", "success", 1, all_success)])
    ran = run_semantic(state14b)
    assert ran.returncode == 0 and f"dispatch at={stale_at} is older than 900s with no run: abandoning it and dispatching again" in ran.stdout, ran.stdout
    lines = call_lines()
    assert [line.split()[0:2] for line in lines[:3]] == [["run", "list"], ["workflow", "run"], ["run", "list"]], lines
    assert len([line for line in lines if line.startswith("workflow run")]) == 1, lines
    receipt = receipt_of(state14b)
    entry = receipt["semantic"]
    assert entry["run_id"] == "200" and entry["outcome"] == "passed" and entry["dispatch"]["at"] != stale_at, entry
    history = receipt["semantic_history"]
    assert len(history) == 1 and history[0]["status"] == "dispatched" and history[0]["run_id"] is None, history
    assert history[0]["dispatch"]["at"] == stale_at and history[0]["outcome"] == "abandoned", history
    assert [w["outcome"] for w in semantic_waits(receipt) if w["kind"] == "run-start"][-2:] == ["abandoned", "found"], semantic_waits(receipt)

    # 15. GH_TOKEN's REST quota is exhausted mid-run (2026-11-09, run
    #     42668217644: `gh run view` HTTP 403 rate limit while the workflow was
    #     still in_progress). Reads (discovery, polls) use the token pool's best
    #     member; the dispatch keeps the workflow-scoped GH_TOKEN; the result
    #     semantics are unchanged.
    rate_limited = ("HTTP 403: API rate limit exceeded for user ID 25310436. (https://api.github.com/repos/"
                    "Rose-Ai-Labs/rose/actions/runs/200/jobs?per_page=100)")
    pool = fake / "token-pool.py"
    pool.write_text("import os, sys\n"
                    "open(os.environ['FAKE_GH_DIR'] + '/pool-calls.log', 'a').write(' '.join(sys.argv[1:]) + '\\n')\n"
                    "token = os.environ.get('FAKE_GH_POOL_TOKEN')\n"
                    "print(token) if token else sys.exit('github_token_pool: no member configured')\n")
    pool_env = {**sem_env, "GH_TOKEN": "primary-exhausted", "DEPLOY_GH_TOKEN_POOL": str(pool),
                "FAKE_GH_POOL_TOKEN": "pool-app", "FAKE_GH_DENY_TOKEN": "primary-exhausted",
                "FAKE_GH_DENY_MESSAGE": rate_limited}

    def token_lines() -> list[list[str]]:
        return [line.split() for line in tokens.read_text().splitlines()] if tokens.exists() else []

    state15 = tmp / "semantic-state-15"
    run_gate(state15)
    reset([[ours]], [view("in_progress", None, 1, running_jobs), view("completed", "success", 1, all_success)])
    ran = run_semantic(state15, env_override=pool_env)
    assert ran.returncode == 0 and "PIPELINE_SEMANTIC status=passed exit=0 run=200" in ran.stdout, ran.stdout
    assert "rate limit" not in ran.stdout, ran.stdout
    used = token_lines()
    assert used[0] == ["workflow", "run", "primary-exhausted"], used  # the write keeps GH_TOKEN
    assert [row for row in used[1:]] == [["run", "list", "pool-app"], ["run", "view", "pool-app"],
                                         ["run", "view", "pool-app"]], used
    pool_calls = (fake / "pool-calls.log").read_text().splitlines()
    assert len(pool_calls) == 3 and all(line.startswith("pick --resource core --repo-root ") for line in pool_calls), pool_calls
    entry = receipt_of(state15)["semantic"]
    assert entry["outcome"] == "passed" and entry["conclusion"] == "success" and entry["run_id"] == "200", entry

    # 15b. The same exhausted GH_TOKEN, and the run concludes failure: still exit
    #      1 with the run's own conclusion (the token never turns a red run green).
    state15b = tmp / "semantic-state-15b"
    run_gate(state15b)
    reset([[ours]], [view("completed", "failure", 1, semantic_failed)])
    ran = run_semantic(state15b, env_override=pool_env)
    assert ran.returncode == 1 and "rate limit" not in ran.stdout, ran.stdout
    assert receipt_of(state15b)["semantic"]["conclusion"] == "failure", receipt_of(state15b)["semantic"]

    # 15c. The pool's member cannot read the run (a 404 from the App or a
    #      machine account is not authoritative): the read retries once with
    #      GH_TOKEN (15c); both failing reports both messages and stays
    #      blocked (15e).
    state15c = tmp / "semantic-state-15c"
    run_gate(state15c)
    reset([[ours]], [view("completed", "success", 1, all_success)])
    ran = run_semantic(state15c, env_override={**pool_env, "GH_TOKEN": "primary", "FAKE_GH_DENY_TOKEN": "pool-app",
                                               "FAKE_GH_DENY_MESSAGE": "HTTP 404: Not Found"})
    assert ran.returncode == 0, ran.stdout
    assert token_lines() == [["workflow", "run", "primary"], ["run", "list", "pool-app"], ["run", "list", "primary"],
                             ["run", "view", "pool-app"], ["run", "view", "primary"]], token_lines()
    state15e = tmp / "semantic-state-15e"
    run_gate(state15e)
    reset([[ours]], [view("completed", "success", 1, all_success)])
    (fake / "list-fail").touch()
    ran = run_semantic(state15e, env_override={**pool_env, "FAKE_GH_DENY_TOKEN": "pool-app",
                                               "FAKE_GH_DENY_MESSAGE": "HTTP 404: Not Found"})
    assert ran.returncode == 1 and "failed with the token pool's member (HTTP 404: Not Found) and with GH_TOKEN: HTTP 502: Bad Gateway" in ran.stdout, ran.stdout
    (fake / "list-fail").unlink()

    # 15f. No usable pool member: reads use GH_TOKEN exactly as before.
    state15f = tmp / "semantic-state-15f"
    run_gate(state15f)
    reset([[ours]], [view("completed", "success", 1, all_success)])
    ran = run_semantic(state15f, env_override={**pool_env, "GH_TOKEN": "primary", "FAKE_GH_POOL_TOKEN": ""})
    assert ran.returncode == 0 and "token pool picked no member" in ran.stdout, ran.stdout
    assert {row[2] for row in token_lines()} == {"primary"}, token_lines()

    # 16. Spec/live skew (2026-11-15, run 43681354141): the live frontend
    #     already served a strict descendant of the merge whose PR changed the
    #     UI and its spec (PR #2097 removed the 'Integration team sharing'
    #     region), so the merge's own spec failed against intended live UI.
    #     The lane binds the spec to the commit the live frontend serves: a
    #     strict descendant is dispatched as source_sha and recorded
    #     verified-by-descendant; the merge's own build stays an exact binding;
    #     an ancestor build with an identical front-end/ (Vercel has not
    #     promoted the merge yet) is source-equivalent and dispatches the
    #     merge; an ancestor whose front-end/ differs is waited out and then
    #     refused; an unrelated build or an unreadable /version.json
    #     dispatches nothing.
    def commit_tree(parent: str | None, files: dict[str, str], message: str) -> str:
        """A commit on no branch (HEAD stays the merge the Fly gate binds)."""
        index = fake / "fixture.index"
        index.unlink(missing_ok=True)
        git_env = {**os.environ, "GIT_INDEX_FILE": str(index)}
        subprocess.run([*git, "read-tree", merged], check=True, env=git_env)
        for relative, content in files.items():
            blob = subprocess.run([*git, "hash-object", "-w", "--stdin"], input=content, check=True,
                                  stdout=subprocess.PIPE, text=True).stdout.strip()
            subprocess.run([*git, "update-index", "--add", "--cacheinfo", f"100644,{blob},{relative}"], check=True,
                           env=git_env)
        tree = subprocess.run([*git, "write-tree"], check=True, env=git_env, stdout=subprocess.PIPE,
                              text=True).stdout.strip()
        return subprocess.run([*git, "commit-tree", tree, *(["-p", parent] if parent else []), "-m", message],
                              check=True, stdout=subprocess.PIPE, text=True).stdout.strip()

    descendant = commit_tree(merged, {"front-end/src/teams.tsx": "no team-sharing region\n"}, "descendant UI change")
    unrelated = commit_tree(None, {"front-end/src/teams.tsx": "unrelated\n"}, "unrelated root")
    ancestor = subprocess.run([*git, "rev-parse", f"{merged}^"], check=True, stdout=subprocess.PIPE,
                              text=True).stdout.strip()
    ours_descendant = row(500, future, descendant, other_head)

    def serve_build(build_id: str, *sequence: str) -> None:
        """Serve ``sequence`` on the first reads, then ``build_id``."""
        version_body.write_text(json.dumps({"buildId": build_id}))
        for stale in [fake / "version-requests.log", fake / "version-count", *fake.glob("version-[0-9]*.json")]:
            stale.unlink(missing_ok=True)
        for index, step in enumerate(sequence, start=1):
            (fake / f"version-{index}.json").write_text(json.dumps({"buildId": step}))

    def view_of(source: str, run_id: int) -> dict:
        return {**view("completed", "success", 1, all_success), "displayTitle": f"Production semantic gate source_sha={source}",
                "url": f"https://github.com/acme/rose/actions/runs/{run_id}"}

    state16 = tmp / "semantic-state-16"
    run_gate(state16)
    serve_build(f"{descendant[:12]}-mwhfbf5c")
    # The merge's own run title is listed too: it is never adopted for a descendant dispatch.
    reset([[ours, ours_descendant, old_same]], [view_of(descendant, 500)])
    ran = run_semantic(state16)
    assert ran.returncode == 0, ran.stdout
    lines = call_lines()
    assert lines[0] == ("workflow run chat-lifecycle-ratchet.yml --ref main -f source_sha=" + descendant +
                        " -f frontend_url=https://www.roselabs.ai -f backend_url=https://navi-j9a9.onrender.com"
                        " -f dispatch_id=" + receipt_of(state16)["semantic"]["dispatch"]["inputs"]["dispatch_id"]), lines
    assert [line for line in lines if line.startswith("run view")] and all(
        line.startswith("run view 500 ") for line in lines if line.startswith("run view")), lines
    requests = (fake / "version-requests.log").read_text().splitlines()
    assert requests == ["/version.json no-cache"], requests
    assert (f"PIPELINE_SEMANTIC binding=verified-by-descendant merged_sha={merged} live_frontend={descendant}"
            in ran.stdout), ran.stdout
    assert f"PIPELINE_SEMANTIC status=passed exit=0 run=500 attempt=1 source_sha={descendant} " in ran.stdout, ran.stdout
    entry = receipt_of(state16)["semantic"]
    assert entry["merged_sha"] == merged and entry["source_sha"] == descendant and entry["run_id"] == "500", entry
    assert entry["dispatch"]["inputs"]["source_sha"] == descendant, entry["dispatch"]
    binding = entry["binding"]
    assert binding["kind"] == "verified-by-descendant" and binding["live_frontend_commit"] == descendant, binding
    assert binding["build_id"] == f"{descendant[:12]}-mwhfbf5c" and binding["version_url"] == sem_env[
        "DEPLOY_SEMANTIC_VERSION_URL"] and binding["observed_at"], binding
    assert receipt_of(state16)["status"] == "passed", "the Fly gate decision must not be rewritten"
    # A confirmed descendant dispatch whose run was never adopted resumes by its own source title.
    state16p = tmp / "semantic-state-16p"
    run_gate(state16p)
    reset([[ours_descendant]], [view_of(descendant, 500)])
    (fake / "list-fail").touch()
    assert run_semantic(state16p).returncode == 1
    (fake / "list-fail").unlink()
    serve_build(f"{merged[:12]}-later")  # the resumed lookup never re-binds
    reset([[ours, ours_descendant]], [view_of(descendant, 500)])
    ran = run_semantic(state16p)
    assert ran.returncode == 0 and "SEMANTIC_RUN_ID=500" in ran.stdout, ran.stdout
    assert not any(line.startswith("workflow run") for line in call_lines()), call_lines()
    assert not (fake / "version-requests.log").exists(), "a resumed dispatch keeps its recorded binding"
    assert receipt_of(state16p)["semantic"]["binding"]["kind"] == "verified-by-descendant", receipt_of(state16p)["semantic"]

    # Negative control: the merge's own build is the exact binding, as before.
    state16e = tmp / "semantic-state-16e"
    run_gate(state16e)
    serve_build(f"{merged[:12]}-mwexact")
    reset([[ours_descendant, ours]], [view("completed", "success", 1, all_success)])
    ran = run_semantic(state16e)
    assert ran.returncode == 0 and call_lines()[0].startswith(f"workflow run chat-lifecycle-ratchet.yml --ref main -f source_sha={merged} "), (ran.stdout, call_lines())
    entry = receipt_of(state16e)["semantic"]
    assert entry["source_sha"] == merged and entry["run_id"] == "200" and entry["binding"]["kind"] == "exact", entry
    assert entry["binding"]["live_frontend_commit"] == merged, entry["binding"]

    # The merge's build is not promoted yet: the live ancestor has the same
    # front-end/, so the merge's specs describe the live UI (source-equivalent).
    state16a = tmp / "semantic-state-16a"
    run_gate(state16a)
    serve_build(f"{ancestor[:12]}-mwparent")
    reset([[ours]], [view("completed", "success", 1, all_success)])
    ran = run_semantic(state16a)
    assert ran.returncode == 0 and call_lines()[0].startswith(f"workflow run chat-lifecycle-ratchet.yml --ref main -f source_sha={merged} "), (ran.stdout, call_lines())
    assert f"PIPELINE_SEMANTIC binding=source-equivalent merged_sha={merged} live_frontend={ancestor}" in ran.stdout, ran.stdout
    entry = receipt_of(state16a)["semantic"]
    assert entry["source_sha"] == merged and entry["binding"]["kind"] == "source-equivalent", entry
    assert entry["binding"]["live_frontend_commit"] == ancestor and entry["binding"]["frontend_paths"] == ["front-end/"], entry

    # A merge whose parent changed front-end/ while that parent's build is not
    # live yet: the ancestor build is re-read until the merge goes live (exact),
    # and refused when it never does within --live-timeout.
    frontend_parent = commit_tree(merged, {"front-end/src/teams.tsx": "new team UI\n"}, "frontend change")
    frontend_merge = commit_tree(frontend_parent, {"front-end/src/teams.tsx": "new team UI\n", "scripts/x.sh": "y\n"},
                                 "scripts-only merge after a frontend change")
    ours_frontend_merge = row(600, future, frontend_merge, other_head)

    def run_frontend_merge(state: Path, *extra: str) -> subprocess.CompletedProcess:
        write_gate(state, frontend_merge, "passed")
        return subprocess.run(
            [sys.executable, str(driver), "production-semantic", "--merged-sha", frontend_merge, "--state-dir",
             str(state), "--poll-seconds", "0.05", "--start-timeout", "0.5", *extra],
            env=sem_env, cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120)

    serve_build(f"{frontend_merge[:12]}-mwlive", f"{merged[:12]}-mwold", f"{merged[:12]}-mwold")
    reset([[ours, ours_frontend_merge]], [view_of(frontend_merge, 600)])
    ran = run_frontend_merge(tmp / "semantic-state-16w")
    assert ran.returncode == 0 and ran.stdout.count(f"PIPELINE_SEMANTIC waiting live_frontend={merged[:12]}") == 2, ran.stdout
    assert call_lines()[0].startswith(f"workflow run chat-lifecycle-ratchet.yml --ref main -f source_sha={frontend_merge} "), call_lines()
    entry = receipt_of(tmp / "semantic-state-16w")["semantic"]
    assert entry["binding"]["kind"] == "exact" and entry["binding"]["polls"] == 3 and entry["run_id"] == "600", entry
    serve_build(f"{merged[:12]}-mwold")
    reset([[ours, ours_frontend_merge]], [view_of(frontend_merge, 600)])
    ran = run_frontend_merge(tmp / "semantic-state-16t", "--live-timeout", "0.2")
    assert ran.returncode == 1 and f"live frontend {merged[:12]} is not {frontend_merge[:12]} or a strict descendant of it: it is an ancestor" in ran.stdout, ran.stdout
    assert "front-end/ differs in 1 path(s)" in ran.stdout and call_lines() == [], (ran.stdout, call_lines())
    assert receipt_of(tmp / "semantic-state-16t")["semantic"]["dispatch"]["at"] is None

    # Refusals: an unrelated build fails closed without dispatching; an
    # unreadable /version.json or a build id with no commit is a tooling error
    # (exit 2), never a guess.
    for label, build_id, code, text in (
            ("unrelated", f"{unrelated[:12]}-mwx", 1, f"live frontend {unrelated[:12]} is not {merged[:12]} or a strict descendant of it"),
            ("local", "local-mwdev", 2, "names no commit"),
            ("unknown", f"{'e' * 12}-mwgone", 2, f"cannot resolve the live frontend commit {'e' * 12}"),
            ("outage", None, 2, "HTTP 503")):
        state_r = tmp / f"semantic-state-16-{label}"
        run_gate(state_r)
        reset([[ours, ours_descendant]], [view("completed", "success", 1, all_success)])
        if build_id is None:
            (fake / "version-fail").touch()
        else:
            serve_build(build_id)
        ran = run_semantic(state_r)
        (fake / "version-fail").unlink(missing_ok=True)
        assert ran.returncode == code and text in ran.stdout, (label, ran.stdout)
        assert call_lines() == [], (label, call_lines())
        entry = receipt_of(state_r)["semantic"]
        assert entry["run_id"] is None and entry["dispatch"]["at"] is None and entry["outcome"] in ("failed", "error"), (label, entry)
    serve_build(f"{merged[:12]}-mwfixture")

    # Selection rule in-process: newest matching only, by createdAt then id.
    pipeline = load_module("pipeline_semantic_select", DRIVER)
    # A pending dispatch is exactly: this SHA, status dispatched, no run, a dispatch clock.
    pending_entry = {"merged_sha": merged, "status": "dispatched", "run_id": None, "dispatch": {"at": "2026-10-31T12:00:00Z"}}
    assert pipeline.semantic_pending_dispatch(pending_entry, merged) == datetime(2026, 10, 31, 12, 0, tzinfo=timezone.utc)
    assert pipeline.semantic_pending_dispatch({**pending_entry, "run_id": "200"}, merged) is None
    assert pipeline.semantic_pending_dispatch({**pending_entry, "status": None}, merged) is None
    assert pipeline.semantic_pending_dispatch({**pending_entry, "merged_sha": other_head}, merged) is None
    assert pipeline.semantic_pending_dispatch({**pending_entry, "dispatch": {"at": None}}, merged) is None
    assert pipeline.semantic_pending_dispatch(None, merged) is None
    assert pipeline.SEMANTIC_DISPATCH_RESUME_WINDOW_S == 900.0
    dispatched = datetime(2026, 10, 31, 12, 0, 0, tzinfo=timezone.utc)
    rows = [
        {"databaseId": 1, "createdAt": "2026-10-31T11:59:54Z", "displayTitle": f"x source_sha={merged}"},  # 6 s early: older
        {"databaseId": 2, "createdAt": "2026-10-31T11:59:56Z", "displayTitle": f"x source_sha={merged}"},  # within skew
        {"databaseId": 3, "createdAt": "2026-10-31T12:00:10Z", "displayTitle": f"x source_sha={other_head}"},
        {"databaseId": 4, "createdAt": "2026-10-31T12:00:05Z", "displayTitle": f"x source_sha={merged}", "event": "push"},
        {"databaseId": 5, "createdAt": "2026-10-31T12:00:05Z", "displayTitle": f"x source_sha={merged}"},
        {"databaseId": 6, "createdAt": "2026-10-31T12:00:05Z", "displayTitle": f"x source_sha={merged}"},
        {"databaseId": 7, "createdAt": "not a time", "displayTitle": f"x source_sha={merged}"},
        {"databaseId": 8, "createdAt": "2026-10-31T12:00:30Z", "displayTitle": "x deployment=1", "headSha": merged},  # decoy
        "junk",
    ]
    assert pipeline.semantic_select_run(rows, merged, dispatched)["databaseId"] == 6, "newest match, id breaks the tie"
    assert pipeline.semantic_select_run(rows[:2], merged, dispatched)["databaseId"] == 2
    assert pipeline.semantic_select_run(rows[:1] + rows[2:4] + rows[7:], merged, dispatched) is None
    assert pipeline.semantic_select_run(None, merged, dispatched) is None
    # With a dispatch id, only the run whose title echoes that id matches (the
    # newer twin of the same source from another dispatch never does); an
    # entry recorded before ids existed (None) keeps the source-only rule.
    mine, other = "a" * 32, "b" * 32
    titled = [
        {"databaseId": 11, "createdAt": "2026-10-31T12:00:05Z", "displayTitle": f"x source_sha={merged} dispatch={mine}"},
        {"databaseId": 12, "createdAt": "2026-10-31T12:00:09Z", "displayTitle": f"x source_sha={merged} dispatch={other}"},
        {"databaseId": 13, "createdAt": "2026-10-31T12:00:10Z", "displayTitle": f"x source_sha={merged} dispatch={mine}x"},
        {"databaseId": 14, "createdAt": "2026-10-31T12:00:11Z", "displayTitle": f"x source_sha={merged}"},
    ]
    assert pipeline.semantic_select_run(titled, merged, dispatched, mine)["databaseId"] == 11
    assert pipeline.semantic_select_run(titled[1:], merged, dispatched, mine) is None
    assert pipeline.semantic_select_run(titled, merged, dispatched)["databaseId"] == 14
    print("production semantic: ok")


def check_semantic_workflow_source_sha() -> None:
    """The production semantic workflow accepts ``source_sha`` and every
    checkout in both jobs uses it: a dispatch checks out exactly that commit
    (validated as a full SHA and verified to be on the default branch before
    any checkout) or the dispatched ref's head, a deployment event still
    checks out the trusted default branch, the effective commit is recorded in
    job outputs and the step summary, and the run title carries the exact
    marker the CLI watcher parses."""
    try:
        import yaml  # transitive dependency of agents/venv (huggingface_hub); the gate runs with that venv active
    except ImportError as error:  # pragma: no cover - environment defect, never a silent skip
        raise AssertionError("PyYAML is required to validate .github/workflows/chat-lifecycle-ratchet.yml: "
                             "run this gate with agents/venv activated") from error
    path = ROOT / ".github" / "workflows" / "chat-lifecycle-ratchet.yml"
    workflow = yaml.safe_load(path.read_text())
    triggers = workflow.get("on", workflow.get(True))
    inputs = triggers["workflow_dispatch"]["inputs"]
    assert "source_sha" in inputs and inputs["source_sha"].get("required") is False, inputs
    assert inputs["source_sha"].get("default", "") == "", "source_sha must default to the dispatched ref's head"
    assert "dispatch_id" in inputs and inputs["dispatch_id"].get("required") is False, inputs
    assert inputs["dispatch_id"].get("default", "") == "", "an undispatched or legacy run names no dispatch id"
    run_name = workflow["run-name"]
    assert "github.event_name == 'workflow_dispatch'" in run_name, "deployment runs must not claim a source_sha"
    marker = re.search(r"format\('([a-z_]+=)\{0\}', inputs\.source_sha \|\| github\.sha\)", run_name)
    assert marker, f"run-name must format the source commit marker from inputs.source_sha || github.sha: {run_name}"
    suffix = "${{ inputs.dispatch_id && format(' dispatch={0}', inputs.dispatch_id) || '' }}"
    assert run_name.endswith(suffix), f"run-name must end with the dispatch id marker {suffix}: {run_name}"
    pipeline = load_module("pipeline_semantic_marker", DRIVER)
    sample = "Production semantic gate source_sha=" + "1" * 40 + " dispatch=" + "c" * 32
    assert pipeline.SEMANTIC_DISPATCH_PATTERN.search(sample).group(1) == "c" * 32, pipeline.SEMANTIC_DISPATCH_PATTERN.pattern
    assert pipeline.SEMANTIC_TITLE_PATTERN.pattern == marker.group(1) + "([0-9a-f]{40})", (
        f"CLI marker {pipeline.SEMANTIC_TITLE_PATTERN.pattern!r} must match the workflow run-name marker {marker.group(1)!r}")
    jobs = workflow["jobs"]
    assert set(jobs) == {"semantic", "lifecycle"}, list(jobs)
    for name, job in jobs.items():
        steps = job["steps"]
        checkouts = [i for i, step in enumerate(steps)
                     if str(step.get("uses", "")).startswith(("actions/checkout", "useblacksmith/checkout"))]
        assert len(checkouts) == 1, f"{name}: exactly one checkout, found {len(checkouts)}"
        index = checkouts[0]
        ref = steps[index]["with"]["ref"]
        assert "inputs.source_sha ||" in ref, f"{name}: checkout must prefer inputs.source_sha: {ref}"
        assert "github.event_name == 'workflow_dispatch' && github.sha" in ref, f"{name}: dispatch default is the ref head: {ref}"
        assert ref.rstrip().endswith("github.event.repository.default_branch }}"), f"{name}: deployment events keep the trusted default branch: {ref}"
        assert steps[index]["with"].get("filter") == "blob:none", f"{name}: blob-filtered checkout retained"
        before = steps[:index]
        assert len(before) == 1 and "uses" not in before[0], f"{name}: only the source_sha verification precedes the checkout"
        verify = before[0]
        assert verify.get("if") == "inputs.source_sha != ''", f"{name}: verification runs only for an explicit source_sha: {verify.get('if')}"
        script = verify["run"]
        assert '[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||' in script, f"{name}: validate the SHA before calling GitHub: {script}"
        assert script.index("=~ ^[0-9a-f]{40}$") < script.index("gh api"), f"{name}: SHA validation must precede gh api"
        assert "compare/${DEFAULT_BRANCH}...${SOURCE_SHA}" in script, script
        labels = re.findall(r"^\s*([a-z|]+)\)", script, re.MULTILINE)
        assert labels == ["identical|behind"], f"{name}: only identical|behind may pass, found case labels {labels}: {script}"
        assert re.search(r"^\s*\*\).*exit 1", script, re.MULTILINE), f"{name}: any other compare status fails closed"
        assert verify["env"]["SOURCE_SHA"] == "${{ inputs.source_sha }}" and verify["env"]["GH_TOKEN"] == "${{ github.token }}", verify["env"]
        record = steps[index + 1]
        assert record.get("id") == "source" and "git rev-parse HEAD" in record["run"], f"{name}: record the effective commit right after checkout"
        assert "GITHUB_OUTPUT" in record["run"] and "GITHUB_STEP_SUMMARY" in record["run"], record["run"]
        assert job["outputs"] == {"source_sha": "${{ steps.source.outputs.sha }}"}, job.get("outputs")
    print("semantic workflow source_sha: ok")


def check_follow_source(tmp: Path, env: dict[str, str]) -> None:
    """A settled source change supersedes the attempt in flight: the lanes bound
    to the old digest are terminated and discarded, the new attempt starts at
    once (failed lane first), ``wait`` follows it, and ``verify`` binds the
    green receipt to the exact bytes. The review ledger is never touched."""
    review_ledger = ROOT / ".context" / "deploy-review-cycle.json"
    ledger_before = review_ledger.stat().st_mtime_ns if review_ledger.exists() else None
    # The fix lands in the scratch source root the driver digests (never the
    # real checkout), exactly like the stale probe in main().
    probe = Path(env["DEPLOY_PIPELINE_SOURCE_ROOT"]) / ".pipeline-supersede-probe.tmp"
    probe.unlink(missing_ok=True)
    state = tmp / "follow"
    plan = tmp / "follow-plan.json"
    long_marker = tmp / "long-finished"
    write_plan(plan, [
        {"name": "long", "command": ["bash", "-c", f"sleep 6; touch {long_marker}"], "reuse_passed": False},
        {"name": "fails", "command": ["bash", "-c", f"sleep 0.3; test -f {probe}"], "reuse_passed": False},
        {"name": "quick", "command": ["sleep", "0.5"], "reuse_passed": False},
    ])
    started = time.monotonic()
    since = time.time()
    supervisor = subprocess.Popen(
        driver_argv("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED,
         "--follow-source", "--settle-seconds", "0.5", "--poll-seconds", "0.2", "--fix-loop-cap", "0"),
        env=env, stdout=subprocess.PIPE, text=True,
    )
    first = subprocess.Popen(
        [sys.executable, str(DRIVER), "wait", "--state-dir", str(state), "--timeout", "40", "--since", str(since)],
        env=env, stdout=subprocess.PIPE, text=True,
    )
    waiter = None
    try:
        # The agent wakes on the first failure while `long` is still running...
        first_out, _ = first.communicate(timeout=40)
        assert first.returncode == 1 and "FAILED fails exit=1" in first_out, (first.returncode, first_out)
        assert "still_running=long" in first_out, first_out
        # ...lands the fix as an untracked file and re-arms the waiter.
        probe.write_text("fixed\n")
        waiter = subprocess.Popen(
            [sys.executable, str(DRIVER), "wait", "--state-dir", str(state), "--timeout", "40", "--since", str(since)],
            env=env, stdout=subprocess.PIPE, text=True,
        )
        supervisor_out, _ = supervisor.communicate(timeout=40)
        total = time.monotonic() - started
        waiter_out, _ = waiter.communicate(timeout=40)
        assert supervisor.returncode == 0, (supervisor.returncode, supervisor_out)
        assert waiter.returncode == 0, (waiter.returncode, waiter_out)
        assert total < 11.0, f"supersede must not wait for the in-flight lanes (took {total:.1f}s; serial >= 12s)"
        receipt = json.loads((state / "receipt.json").read_text())
        assert receipt["status"] == "passed" and receipt["attempt"] == 2, receipt
        assert receipt["supersedes"]["head"] == receipt["source"]["head"]
        assert receipt["supersedes"]["digest"] != receipt["source"]["digest"], "attempts must bind to different bytes"
        assert receipt["order"][0] == "fails", receipt["order"]
        history = [json.loads(line) for line in (state / "history.jsonl").read_text().splitlines()]
        superseded = history[-1]
        assert superseded["status"] == "superseded" and superseded["attempt"] == 1, superseded
        assert "long" in superseded["superseded_lanes"], superseded
        assert superseded["lanes"]["long"]["status"] == "superseded", superseded["lanes"]["long"]
        assert superseded["lanes"]["long"]["exit"] != 0, "the superseded lane was terminated, not finished"
        assert "PIPELINE_SUPERSEDED attempt=1" in supervisor_out and "PIPELINE_ATTEMPT attempt=2" in supervisor_out
        assert "PIPELINE_SUPERSEDED attempt=1" in waiter_out and "attempt=2" in waiter_out.split("PIPELINE_WAKE")[1]
        # Results are bound to SHA + digest: verify passes only on these bytes.
        bound = subprocess.run(
            [sys.executable, str(DRIVER), "verify", "--state-dir", str(state),
             "--expect-head", receipt["source"]["head"]], env=env, stdout=subprocess.PIPE, text=True, check=False,
        )
        assert bound.returncode == 0 and "status=bound" in bound.stdout, bound.stdout
        wrong_head = subprocess.run(
            [sys.executable, str(DRIVER), "verify", "--state-dir", str(state), "--expect-head", "0" * 40],
            env=env, stdout=subprocess.PIPE, text=True, check=False,
        )
        assert wrong_head.returncode == 5, wrong_head.stdout
        probe.unlink()
        other_bytes = subprocess.run(
            [sys.executable, str(DRIVER), "verify", "--state-dir", str(state)],
            env=env, stdout=subprocess.PIPE, text=True, check=False,
        )
        assert other_bytes.returncode == 5 and "source-mismatch" in other_bytes.stdout, other_bytes.stdout
    finally:
        probe.unlink(missing_ok=True)
        for process in (supervisor, first, waiter):
            if process is not None and process.poll() is None:
                process.kill()
                process.wait()
    ledger_after = review_ledger.stat().st_mtime_ns if review_ledger.exists() else None
    assert ledger_before == ledger_after, "speculative gates must never touch the review-cycle ledger"
    # Without --follow-source the same edit is still a stale run, never a pass.
    assert "superseded" not in json.dumps(json.loads((tmp / "state" / "receipt.json").read_text())["status"])


def _process_alive(pid: int) -> bool:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return False
    return stat[stat.rindex(")") + 2:].split()[0] not in ("Z", "X")


def check_lane_teardown(tmp: Path, env: dict[str, str]) -> None:
    """A superseded lane is signalled as a process group, but the smoke lane's
    chain starts its isolated stack in a session of its own (``run.sh
    --benchmark`` under benchmarks/local.py), so the group TERM never reaches
    it: on #1640 two such stacks outlived their superseded smoke lanes, kept
    live owner records under .context/benchmarks and blocked the semantic
    latency gate (3600 s wait) until a human TERMed them. The supervisor now
    waits (bounded) for every owner record the lane's own processes wrote,
    TERMs the run's live controller (never a wrapper above it, never the stack
    while the controller lives), lets a controller that keeps publishing
    cleanup progress drain past the wait bound, SIGKILLs only a run that shows
    no progress after the controller's shutdown budget, writes a receipt and
    reports it; a record whose pid the lane never started (another run) is
    reported and left alone."""
    pipeline = load_module("pipeline_teardown", DRIVER)
    source_root = Path(env["DEPLOY_PIPELINE_SOURCE_ROOT"])
    context_root = source_root / ".context" / "benchmarks"
    context_root.mkdir(parents=True, exist_ok=True)
    probe = source_root / ".pipeline-teardown-probe.tmp"
    probe.unlink(missing_ok=True)
    scripts = tmp / "teardown-scripts"
    scripts.mkdir()
    # The "stack": records its own pid like local.py's local-stack-owner.json,
    # then idles. "stubborn" ignores TERM like a stack hung in its teardown.
    (scripts / "stack.sh").write_text(
        "#!/bin/bash\n"
        "mkdir -p \"$1\"\n"
        "[ \"$2\" = stubborn ] && trap '' TERM\n"
        "printf '{\"version\":1,\"run_id\":\"%s\",\"pid\":%d,\"token\":\"fixture\","
        "\"native_identity\":\"fixture\",\"birth\":\"fixture\"}\\n' \"$(basename \"$1\")\" \"$$\" "
        "> \"$1/local-stack-owner.json.tmp\"\n"
        "mv \"$1/local-stack-owner.json.tmp\" \"$1/local-stack-owner.json\"\n"
        "exec sleep 300\n"
    )
    # The "controller": like benchmarks/local.py it runs in its own session under
    # a generated run id that embeds its pid, starts the stack with a scrubbed
    # environment (owned only through the parent chain) and, on TERM, drains for
    # longer than the wait bound while publishing cleanup-status progress.
    (scripts / "controller.sh").write_text(
        "#!/bin/bash\n"
        "run_dir=\"$1/$(date +%s)-$$-7\"\n"
        "mkdir -p \"$run_dir\"\n"
        "env -i /bin/sleep 300 </dev/null >/dev/null 2>&1 &\n"
        "stack=$!\n"
        "printf '{\"version\":1,\"run_id\":\"%s\",\"pid\":%d,\"token\":\"fixture\","
        "\"native_identity\":\"fixture\",\"birth\":\"fixture\"}\\n' \"$(basename \"$run_dir\")\" \"$stack\" "
        "> \"$run_dir/local-stack-owner.json.tmp\"\n"
        "mv \"$run_dir/local-stack-owner.json.tmp\" \"$run_dir/local-stack-owner.json\"\n"
        "printf '%s\\n' \"$run_dir\" > \"$2\"\n"
        "drain() {\n"
        "  trap '' TERM\n"
        "  for step in 1 2 3 4 5 6; do\n"
        "    printf 'version=2\\nstate=pending\\nstep=%s\\n' \"$step\" > \"$run_dir/local-stack-cleanup.status.tmp\"\n"
        "    mv -f \"$run_dir/local-stack-cleanup.status.tmp\" \"$run_dir/local-stack-cleanup.status\"\n"
        "    sleep 0.5\n"
        "  done\n"
        "  kill \"$stack\" 2>/dev/null\n"
        "  wait \"$stack\" 2>/dev/null\n"
        "  printf 'version=2\\nstate=clean\\n' > \"$run_dir/local-stack-cleanup.status.tmp\"\n"
        "  mv -f \"$run_dir/local-stack-cleanup.status.tmp\" \"$run_dir/local-stack-cleanup.status\"\n"
        "  exit 0\n"
        "}\n"
        "trap drain TERM\n"
        "while kill -0 \"$stack\" 2>/dev/null; do wait \"$stack\"; done\n"
    )
    # The lane: like run-predeploy-local -> local.py it starts its stack or
    # controller in a new session with its own service log (never the stage
    # wrapper's output pipe) and waits on its work; once the fix (probe) exists
    # it passes at once.
    (scripts / "lane.sh").write_text(
        "#!/bin/bash\n"
        "[ -f \"$3\" ] && exit 0\n"
        "if [ \"$2\" = controller ]; then\n"
        "  setsid bash \"$(dirname \"$0\")/controller.sh\" \"$1\" \"$4\" >/dev/null 2>&1 </dev/null &\n"
        "else\n"
        "  setsid bash \"$(dirname \"$0\")/stack.sh\" \"$1\" \"$2\" >/dev/null 2>&1 </dev/null &\n"
        "fi\n"
        "sleep 60\n"
    )
    run_dirs = {name: context_root / f"teardown-{name}" for name in ("stack", "stubborn")}
    marker = tmp / "controller-run-dir"
    plan = tmp / "teardown-plan.json"
    state = tmp / "teardown-state"
    lane = str(scripts / "lane.sh")
    write_plan(plan, [
        {"name": "controller", "reuse_passed": False,
         "command": ["bash", lane, str(context_root), "controller", str(probe), str(marker)]},
        {"name": "stack", "reuse_passed": False,
         "command": ["bash", lane, str(run_dirs["stack"]), "plain", str(probe), "-"]},
        {"name": "stubborn", "reuse_passed": False,
         "command": ["bash", lane, str(run_dirs["stubborn"]), "stubborn", str(probe), "-"]},
    ])
    # A run dir older than the lanes (a dead controller's record): never a candidate.
    old = context_root / "1700000000-1-1"
    old.mkdir()
    (old / "local-stack-owner.json").write_text(json.dumps({"version": 1, "run_id": old.name, "pid": 1}))
    stale = time.time() - 600
    os.utime(old / "local-stack-owner.json", (stale, stale))
    os.utime(old, (stale, stale))
    # Another run's live owner: a pid the lanes never started carries no lane token.
    foreign = subprocess.Popen(["sleep", "300"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL)
    foreign_dir = context_root / "teardown-foreign"
    # wait bound 1 s; the last resort may run 6 s after the TERM, and only
    # when nothing progressed for a whole wait bound.
    scenario_env = {**env, "DEPLOY_PIPELINE_TEARDOWN_WAIT_SECONDS": "1",
                    "DEPLOY_PIPELINE_TEARDOWN_KILL_AFTER_SECONDS": "6"}
    supervisor = subprocess.Popen(
        driver_argv("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED,
         "--follow-source", "--settle-seconds", "0.5", "--poll-seconds", "0.2", "--fix-loop-cap", "0"),
        env=scenario_env, stdout=subprocess.PIPE, text=True,
    )
    owners: dict[str, int] = {}
    controller_pid = 0
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not (marker.exists() and all(
                (d / "local-stack-owner.json").exists() for d in run_dirs.values())):
            time.sleep(0.1)
        controller_dir = Path(marker.read_text().strip())
        controller_pid = int(controller_dir.name.split("-")[1])
        run_dirs["controller"] = controller_dir
        for name, run_dir in run_dirs.items():
            owners[name] = json.loads((run_dir / "local-stack-owner.json").read_text())["pid"]
        foreign_dir.mkdir()
        (foreign_dir / "local-stack-owner.json").write_text(json.dumps(
            {"version": 1, "run_id": foreign_dir.name, "pid": foreign.pid, "token": "x",
             "native_identity": "x", "birth": "x"}))
        probe.write_text("fixed\n")
        out, _ = supervisor.communicate(timeout=120)
        assert supervisor.returncode == 0, (supervisor.returncode, out)
        receipt = json.loads((state / "receipt.json").read_text())
        assert receipt["status"] == "passed" and receipt["attempt"] == 2, receipt["status"]
        history = [json.loads(line) for line in (state / "history.jsonl").read_text().splitlines()]
        superseded = history[-1]
        assert superseded["status"] == "superseded"
        assert sorted(superseded["superseded_lanes"]) == ["controller", "stack", "stubborn"]
        expectations = {"controller": "terminated", "stack": "terminated", "stubborn": "killed"}
        details: dict[str, dict] = {}
        for name, expected in expectations.items():
            lane_state = superseded["lanes"][name]
            assert lane_state["status"] == "superseded" and lane_state["lane_token"].startswith(f"{name}.1."), lane_state
            summary = lane_state["teardown"]
            assert summary["outcome"] == expected, (name, summary)
            assert summary["survivors"] == [] and summary["eperm"] == [], (name, summary)
            assert not _process_alive(owners[name]), f"{name}'s stack outlived its teardown"
            detail_path = Path(summary["receipt"])
            assert detail_path == state / "teardown" / f"attempt-1-{name}.json", detail_path
            detail = json.loads(detail_path.read_text())
            details[name] = detail
            assert detail["older_run_dirs"] == 1 and all(r["run_id"] != old.name for r in detail["records"])
            assert detail["wait_seconds"] == 1.0 and detail["kill_after_seconds"] == 6.0, detail
            assert detail["kill_after_source"] == "DEPLOY_PIPELINE_TEARDOWN_KILL_AFTER_SECONDS", detail
            assert detail["lingering"] == [], detail["lingering"]
            assert f"PIPELINE_LANE_TEARDOWN attempt=1 lane={name} outcome={expected} owned=" in out, out
            assert f"receipt={detail_path}" in out, out
        # Plain stack, no controller left: the exact owner pid is TERMed and exits.
        stack = superseded["lanes"]["stack"]["teardown"]
        assert stack["owned_pids"] == [owners["stack"]] and stack["escalated"] == [owners["stack"]], stack
        assert stack["killed"] == [] and [p["phase"] for p in details["stack"]["phases"]] == ["wait", "term"]
        assert [(r["pid"], r["path"]) for r in details["stack"]["owned"]] == \
            [(owners["stack"], str(run_dirs["stack"] / "local-stack-owner.json"))], details["stack"]["owned"]
        # Live controller: it alone is TERMed (never its stack, never a wrapper),
        # its stack is owned through the parent chain despite a scrubbed
        # environment, and its 3 s drain with progress receipts outlives the 1 s
        # wait bound without being killed; the receipt ends with its clean status.
        controller = superseded["lanes"]["controller"]["teardown"]
        assert controller["escalated"] == [controller_pid], controller
        assert controller["owned_pids"] == sorted([controller_pid, owners["controller"]]), controller
        assert controller["killed"] == [] and [p["phase"] for p in details["controller"]["phases"]] == ["wait", "term"]
        term = details["controller"]["phases"][1]
        assert term["seconds"] >= 2.5 and term["stall"] is None, term
        owned_kinds = {(r["pid"], r["kind"]) for r in details["controller"]["owned"]}
        assert owned_kinds == {(controller_pid, "run-id-controller"), (owners["controller"], "local-stack-owner.json")}, owned_kinds
        cleanup = [r for r in details["controller"]["records"] if r["kind"] == "local-stack-cleanup.status"]
        assert cleanup and cleanup[0]["status"] == "receipt" and cleanup[0]["state"] == "clean", cleanup
        assert not _process_alive(controller_pid), "the controller outlived its drain"
        # TERM-ignoring stack: the last resort runs only after the kill-after
        # bound passed with no progress for a whole wait bound.
        stubborn = superseded["lanes"]["stubborn"]["teardown"]
        assert stubborn["escalated"] == [owners["stubborn"]] and stubborn["killed"] == [owners["stubborn"]], stubborn
        phases = details["stubborn"]["phases"]
        assert [p["phase"] for p in phases] == ["wait", "term", "kill"], phases
        assert phases[1]["seconds"] >= 6.0 and phases[1]["stall"].startswith("no progress"), phases[1]
        assert phases[1]["last_progress_age_s"] >= 1.0, phases[1]
        assert phases[2]["note"].startswith("last resort"), phases[2]
        # Token scoping: each teardown saw the other lanes' live stacks as foreign
        # and left them for their own teardown; nothing ever touched the other run.
        assert controller["foreign_pids"] == sorted([foreign.pid, owners["stack"], owners["stubborn"]]), controller
        assert stack["foreign_pids"] == sorted([foreign.pid, owners["stubborn"]]), stack
        assert stubborn["foreign_pids"] == [foreign.pid], stubborn
        assert _process_alive(foreign.pid), "a foreign owner record's process must never be signalled"
        assert f"foreign={foreign.pid}" in out.split("lane=stubborn")[1].split("\n")[0], out
        # Lanes that passed were never signalled: no teardown, no receipt.
        assert "teardown" not in receipt["lanes"]["stack"] and not list((state / "teardown").glob("attempt-2-*"))
        # Both bounds are validated before any lane starts.
        for variable in ("DEPLOY_PIPELINE_TEARDOWN_WAIT_SECONDS", "DEPLOY_PIPELINE_TEARDOWN_KILL_AFTER_SECONDS"):
            bad = run_driver("run", "--plan", str(plan), "--state-dir", str(tmp / "teardown-bad"), *UNBOUNDED,
                             env={**env, variable: "soon"})
            assert bad.returncode == 2 and variable in bad.stderr, (variable, bad.returncode, bad.stderr)
            assert not (tmp / "teardown-bad" / "receipt.json").exists()
    finally:
        probe.unlink(missing_ok=True)
        if supervisor.poll() is None:
            supervisor.kill()
            supervisor.wait()
        for pid in (*owners.values(), foreign.pid, controller_pid):
            if pid:
                try:
                    os.kill(pid, 9)
                except ProcessLookupError:
                    pass
        foreign.wait()
        shutil.rmtree(context_root, ignore_errors=True)
    # Without the override the last resort waits for the controller's published
    # shutdown budget plus the margin; this fixture has no agents/ producer, so
    # the documented default applies, and the real checkout asks the producer.
    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("DEPLOY_PIPELINE_TEARDOWN_KILL_AFTER_SECONDS", None)
        assert pipeline.teardown_kill_after_seconds() == (2175.0 + 120.0, "default + 120s margin")
        real = load_module("pipeline_teardown_real", ROOT / "scripts" / "run_deploy_pipeline.py")
        published = int(subprocess.run(
            [sys.executable, str(ROOT / "agents/scripts/local_worker_supervisor.py"), "--shutdown-timeout"],
            cwd=ROOT / "agents", check=True, stdout=subprocess.PIPE, text=True).stdout)
        assert real.teardown_kill_after_seconds() == (
            published + 120.0, "local_worker_supervisor.py --shutdown-timeout + 120s margin")
    # Ownership through the parent chain when a child's environment cannot be
    # read (a root child), zombies never count, and a lane-owned pid the
    # supervisor may not signal is recorded as eperm instead of aborting.
    fake = tmp / "teardown-fake-proc"
    stat_tail = "0 0 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 {start} 0 0 0 0"
    for pid, comm, state_char, ppid, start in ((100, "ctrl", "S", 1, 5000), (101, "sudo", "S", 100, 5001),
                                               (102, "other", "S", 1, 5002), (103, "gone", "Z", 100, 5003)):
        (fake / str(pid)).mkdir(parents=True)
        (fake / str(pid) / "stat").write_text(f"{pid} ({comm}) {state_char} {ppid} " + stat_tail.format(start=start) + "\n")
    (fake / "100" / "environ").write_bytes(b"HOME=/x\0DEPLOY_PIPELINE_LANE_TOKEN=tok\0")
    (fake / "101" / "environ").write_bytes(b"secret\0")
    (fake / "101" / "environ").chmod(0)
    (fake / "102" / "environ").write_bytes(b"DEPLOY_PIPELINE_LANE_TOKEN=other\0")
    try:
        owned, processes = pipeline.lane_owned_processes("tok", proc=fake)
    finally:
        (fake / "101" / "environ").chmod(0o600)
    assert sorted(owned) == [100, 101] and owned[100]["token"] is True and owned[101]["token"] is False, owned
    assert 103 not in processes and 102 in processes, sorted(processes)
    with patch.object(pipeline.os, "kill", side_effect=PermissionError):
        assert pipeline._signal_pids([4242], {4242: {"comm": "sudo"}}, pipeline.signal.SIGKILL) == [
            {"pid": 4242, "comm": "sudo", "signal": "SIGKILL", "error": "eperm"}]
    with patch.object(pipeline.os, "kill", side_effect=ProcessLookupError):
        assert pipeline._signal_pids([4242], {}, pipeline.signal.SIGTERM) == []
    records = [{"run_id": "1-77-1", "kind": "run-id-controller", "pid": 77, "status": "owned"},
               {"run_id": "1-77-1", "kind": "local-stack-owner.json", "pid": 88, "status": "owned"},
               {"run_id": "custom", "kind": "local-stack-owner.json", "pid": 99, "status": "owned"},
               {"run_id": "1-66-1", "kind": "run-id-controller", "pid": 66, "status": "exited"},
               {"run_id": "1-66-1", "kind": "services.json", "pid": 55, "status": "owned"}]
    assert pipeline._escalation_targets(records, [88, 99, 55, 77]) == [77, 99, 55]
    print("lane teardown: ok")


def _fake_process(proc: Path, pid: int, comm: str, *, ppid: int = 1, start: int = 5000, environ: bytes = b"",
                  cmdline: str = "") -> None:
    stat_tail = "0 0 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 {start} 0 0 0 0"
    (proc / str(pid)).mkdir(parents=True)
    (proc / str(pid) / "stat").write_text(f"{pid} ({comm}) S {ppid} " + stat_tail.format(start=start) + "\n")
    (proc / str(pid) / "environ").write_bytes(environ)
    (proc / str(pid) / "cmdline").write_bytes(cmdline.replace(" ", "\0").encode() + b"\0")


def _owner_run_dir(context_root: Path, run_id: str, *, age_s: float, benchmark: dict | None = None,
                   stack: dict | None = None, manifest: dict | None = None, cleanup: str | None = None) -> Path:
    run_dir = context_root / run_id
    run_dir.mkdir(parents=True)
    (run_dir / "logs").mkdir()
    (run_dir / "logs" / "frontend.log").write_text("evidence\n")
    for name, payload in (("local-benchmark-owner.json", benchmark), ("local-stack-owner.json", stack),
                          ("services.json", manifest)):
        if payload is not None:
            (run_dir / name).write_text(json.dumps(payload))
    if cleanup is not None:
        (run_dir / "local-stack-cleanup.status").write_text(cleanup)
    stamp = time.time() - age_s
    for path in (run_dir / "logs" / "frontend.log", run_dir / "logs", *run_dir.iterdir(), run_dir):
        os.utime(path, (stamp, stamp))
    return run_dir


# A pid above the kernel's default pid_max can never be alive on the host.
DEAD_PID = 4194309


def check_owner_run_preflight(tmp: Path, env: dict[str, str]) -> None:
    """2026-10-31 (deploy-5 round 1, PR #1655 round 2): an isolated run stopped
    before its controller bound a pid leaves ``local-benchmark-owner.json``
    with ``state: not_started, pid: null`` (and/or a pid-less stack owner); the
    launch preflight refused the deploy on it until a human moved the run to
    ``_aborted/``. One shared classification (live / finished / aborted /
    stranded / bootstrapping / unknown) now serves the launch preflight and the
    lane teardown: this deploy's own aborted run is set aside (renamed,
    evidence intact) and the launch proceeds; a run inside the bootstrap grace
    (newest file under it) is protected and waited out; a pid-less run whose
    run id a live process carries (environment, ``--run-id`` argv, or a
    command line naming it when the environment is unreadable) is live and
    never set aside; a run that left a manifest without a clean cleanup
    receipt is stranded and left for --reconcile-cleanup; another session's
    runs are reported, never renamed and never waited on; an unreadable
    record, a symlinked context root or an unavailable process table refuses
    the launch (fail closed)."""
    pipeline = load_module("pipeline_owner_runs", DRIVER)
    source_root = Path(env["DEPLOY_PIPELINE_SOURCE_ROOT"])
    context_root = source_root / ".context" / "benchmarks"
    shutil.rmtree(context_root, ignore_errors=True)
    not_started = {"version": 1, "run_id": "", "state": "not_started", "pid": None, "native_identity": "",
                   "token": "", "receipt": "", "signal": None}
    stopped_manifest = {"status": "stopped", "run_sh_pid": DEAD_PID, "services": []}
    clean = "version=2\nstate=clean\n"

    # ── Unit: the classification itself, on a fake /proc ───────────────────
    fake = tmp / "owner-runs-fake-proc"
    _fake_process(fake, 100, "python3", cmdline="python3 benchmarks/local.py --port 1")
    _fake_process(fake, 101, "bash", cmdline="bash scripts/run.sh --benchmark",
                  environ=b"BENCHMARK_RUN_ID=carried-run\0")
    _fake_process(fake, 102, "sleep", cmdline="sleep 300")
    # Environment unreadable (EACCES): only its command line names the run.
    _fake_process(fake, 103, "cloudflared", environ=b"secret\0",
                  cmdline="cloudflared tunnel --logfile /x/.context/benchmarks/eacces-run/cloudflared.log")
    (fake / "103" / "environ").chmod(0)
    # A controller with a custom run id (run-predeploy-local's YYYYMMDD-HHMMSS-$$):
    # the id embeds no pid and a runtime environ write never reaches /proc.
    _fake_process(fake, 104, "python3", cmdline="python3 benchmarks/local.py --run-id 20261031-064512-555 --port 2")
    unit_root = tmp / "owner-runs-unit"
    identities = {102: "linux:boot:5002"}
    now = time.time()

    def unit(run_id: str, age_s: float, **records: object) -> Path:
        bench = records.pop("benchmark", None)
        if bench == "not_started":
            bench = {**not_started, "run_id": run_id}
        return _owner_run_dir(unit_root, run_id, age_s=age_s, benchmark=bench, **records)

    unit("1700000000-999-1", 600, benchmark="not_started")
    unit("1700000000-998-1", 5, benchmark="not_started")
    unit("carried-run", 600, benchmark="not_started")
    unit("1700000000-100-1", 600, benchmark="not_started")
    unit("manifest-live", 600, stack={"version": 1, "run_id": "manifest-live", "pid": None},
         manifest={"status": "running", "run_sh_pid": 101})
    unit("stack-live", 600, stack={"version": 1, "run_id": "stack-live", "pid": 102, "native_identity": "linux:boot:5002"})
    unit("stack-reused-pid", 600,
         stack={"version": 1, "run_id": "stack-reused-pid", "pid": 102, "native_identity": "linux:boot:1"})
    unit("stack-exited", 600, stack={"version": 1, "run_id": "stack-exited", "pid": 7777, "native_identity": "linux:boot:7"},
         cleanup=clean)
    unit("young-but-stopped", 5, benchmark="not_started", manifest=stopped_manifest, cleanup=clean)
    unit("young-manifest-no-pid", 5, benchmark="not_started", manifest={"status": "starting", "services": []})
    unit("stranded-pending", 600, benchmark="not_started", manifest={"status": "running", "run_sh_pid": 7777},
         cleanup="version=2\nstate=pending\n")
    unit("stranded-no-receipt", 600, benchmark="not_started", manifest=stopped_manifest)
    young_log = unit("young-log", 600, benchmark="not_started")
    (young_log / "logs" / "services.log").write_text("still bootstrapping\n")
    unit("eacces-run", 600, benchmark="not_started")
    unit("20261031-064512-555", 600, benchmark="not_started")
    broken = unit("broken", 600)
    (broken / "local-benchmark-owner.json").write_text("{not json")
    (unit_root / "seed-cache").mkdir()
    (unit_root / "_aborted" / "1600000000-1-1").mkdir(parents=True)
    (unit_root / "_aborted" / "1600000000-1-1" / "local-benchmark-owner.json").write_text(json.dumps(not_started))
    try:
        runs = pipeline.classify_owner_runs(unit_root, proc=fake, identity_of=lambda pid: identities.get(pid, ""),
                                            now=now, grace_seconds=90)
    finally:
        (fake / "103" / "environ").chmod(0o600)
    classes = {run["run_id"]: run["classification"] for run in runs}
    expected = {
        "1700000000-999-1": "aborted", "1700000000-998-1": "bootstrapping", "carried-run": "live",
        "1700000000-100-1": "live", "manifest-live": "live", "stack-live": "live", "stack-reused-pid": "finished",
        "stack-exited": "finished", "young-but-stopped": "aborted", "young-manifest-no-pid": "stranded",
        "stranded-pending": "stranded", "stranded-no-receipt": "stranded", "young-log": "bootstrapping",
        "eacces-run": "live", "20261031-064512-555": "live", "broken": "unknown",
    }
    assert classes == expected, classes
    by_id = {run["run_id"]: run for run in runs}
    assert by_id["carried-run"]["pids"] == [101] and "carried by live process" in by_id["carried-run"]["reason"]
    assert by_id["1700000000-100-1"]["pids"] == [100] and by_id["manifest-live"]["pids"] == [101]
    assert by_id["stack-live"]["pids"] == [102] and "matching identity" in by_id["stack-live"]["reason"]
    assert by_id["eacces-run"]["pids"] == [103] and by_id["20261031-064512-555"]["pids"] == [104], by_id
    assert "unreadable" in by_id["broken"]["reason"], by_id["broken"]
    assert "grace" in by_id["1700000000-998-1"]["reason"] and "bootstrap ended" in by_id["young-but-stopped"]["reason"]
    assert by_id["young-log"]["age_s"] < 5, by_id["young-log"]
    for run_id in ("stranded-pending", "stranded-no-receipt", "young-manifest-no-pid"):
        assert f"--run-id {run_id} --reconcile-cleanup" in by_id[run_id]["reason"], by_id[run_id]
    # The same record is bootstrapping now and aborted once the grace passed.
    later = pipeline.classify_owner_runs(unit_root, proc=fake, identity_of=lambda pid: "", now=now + 100,
                                         grace_seconds=90, run_ids={"1700000000-998-1"})
    assert [run["classification"] for run in later] == ["aborted"], later
    # No process table (another platform, /proc unlistable): every run unknown,
    # a reconcile refuses and renames nothing; a symlinked root likewise.
    missing = pipeline.classify_owner_runs(unit_root, proc=tmp / "owner-runs-missing-proc", identity_of=lambda pid: "",
                                           now=now, grace_seconds=90)
    assert {run["run_id"] for run in missing} == set(expected), missing
    assert all(run["classification"] == "unknown" for run in missing), missing
    assert all("process table" in run["reason"] for run in missing if run["run_id"] != "broken"), missing
    unavailable = pipeline.reconcile_owner_runs(unit_root, tmp / "owner-runs-unavailable-state", stage="unit",
                                                proc=tmp / "owner-runs-missing-proc", identity_of=lambda pid: "",
                                                grace_seconds=90)
    assert unavailable["set_aside"] == [] and len(unavailable["refused"]) == len(expected), unavailable["refused"]
    link = tmp / "owner-runs-linked-root"
    link.symlink_to(unit_root)
    linked = pipeline.reconcile_owner_runs(link, tmp / "owner-runs-linked-state", stage="unit", proc=fake,
                                           identity_of=lambda pid: "", grace_seconds=90)
    assert linked["set_aside"] == [] and [r["classification"] for r in linked["refused"]] == ["unknown"], linked
    assert "symlink" in linked["refused"][0]["reason"], linked["refused"]
    assert (unit_root / "1700000000-999-1").is_dir() and not (unit_root / "_aborted" / "1700000000-999-1").exists()
    # A run directory removed by a concurrent cleanup after ``is_dir()``
    # succeeded (PR #1656 review, 2026-10-31): the FileNotFoundError from its
    # newest-mtime stat or from a record read made the run ``unknown`` and the
    # preflight refused the whole attempt. A confirmed-vanished run is
    # ``finished`` (reported, never refused, never renamed); the same error
    # while the directory still exists stays ``unknown`` (fail closed).
    vanishing = unit("1700000000-997-1", 600, benchmark="not_started")
    original_newest_mtime = pipeline._newest_mtime

    def vanish_before_stat(run_dir: Path) -> float:
        if run_dir == vanishing:
            shutil.rmtree(run_dir)
        return original_newest_mtime(run_dir)

    with patch.object(pipeline, "_newest_mtime", vanish_before_stat):
        gone = pipeline.reconcile_owner_runs(unit_root, tmp / "owner-runs-vanished-state", stage="unit", proc=fake,
                                             identity_of=lambda pid: "", grace_seconds=90,
                                             run_ids={vanishing.name, "stack-exited"})
    assert gone["refused"] == [] and gone["set_aside"] == [], gone
    assert gone["counts"]["finished"] == 2 and gone["counts"]["unknown"] == 0, gone["counts"]
    row = next(run for run in gone["runs"] if run["run_id"] == vanishing.name)
    assert row["classification"] == "finished" and "vanished" in row["reason"] and row["action"] == "left", row
    assert not vanishing.exists() and not (unit_root / "_aborted" / vanishing.name).exists()
    assert vanishing.name in (tmp / "owner-runs-vanished-state" / "owner-runs.jsonl").read_text()
    # The same race on an owner-record read (the directory goes between is_file() and read_text()).
    vanishing = unit("1700000000-997-1", 600, benchmark="not_started")
    original_read_text = Path.read_text

    def vanish_before_read(self: Path, *args, **kwargs):
        if self.parent == vanishing:
            shutil.rmtree(vanishing)
        return original_read_text(self, *args, **kwargs)

    with patch.object(Path, "read_text", vanish_before_read):
        gone = pipeline.classify_owner_runs(unit_root, proc=fake, identity_of=lambda pid: "", now=now,
                                            grace_seconds=90, run_ids={vanishing.name})
    assert [run["classification"] for run in gone] == ["finished"] and "vanished" in gone[0]["reason"], gone
    assert not vanishing.exists()
    # Control: a FileNotFoundError while the run directory still exists is not a vanished run.
    present = unit("1700000000-996-1", 600, benchmark="not_started")

    def phantom_missing(run_dir: Path) -> float:
        raise FileNotFoundError(f"phantom {run_dir}")

    with patch.object(pipeline, "_newest_mtime", phantom_missing):
        kept = pipeline.classify_owner_runs(unit_root, proc=fake, identity_of=lambda pid: "", now=now,
                                            grace_seconds=90, run_ids={present.name})
    assert [run["classification"] for run in kept] == ["unknown"], kept
    assert kept[0]["reason"] == "run dir unreadable (FileNotFoundError)" and present.is_dir(), kept
    # Grace comes from the same variable run.sh / kill-services.sh honour.
    with patch.dict(os.environ, {"BENCHMARK_STARTUP_GRACE_SECONDS": "7"}):
        assert pipeline.bootstrap_grace_seconds() == 7.0
    with patch.dict(os.environ, {"BENCHMARK_STARTUP_GRACE_SECONDS": "soon"}):
        assert pipeline.bootstrap_grace_seconds() == 90.0
    # benchmarks/local.py exports the run id before it writes not_started, so
    # every later child of a custom-id controller carries it.
    local_py = (ROOT / "agents" / "benchmarks" / "local.py").read_text()
    export = 'os.environ["BENCHMARK_RUN_ID"] = stack.run_id'
    assert local_py.count(export) == 1 and local_py.index(export) < local_py.index('benchmark_owner.record("not_started")')

    # ── Driver: the launch preflight on the real /proc ─────────────────────
    plan = tmp / "owner-runs-plan.json"
    write_plan(plan, [{"name": "quick", "command": ["true"], "reuse_passed": False}])
    aborted_id = "1793428424-669285-80519"  # the record that blocked deploy-5 round 1
    aborted = _owner_run_dir(context_root, aborted_id, age_s=600,
                             benchmark={**not_started, "run_id": aborted_id},
                             stack={"version": 1, "run_id": aborted_id, "pid": DEAD_PID, "token": "t",
                                    "native_identity": "linux:gone:1", "birth": "x"},
                             manifest=stopped_manifest, cleanup=clean)
    carrier = subprocess.Popen(["sleep", "300"], env={**os.environ, "BENCHMARK_RUN_ID": "1793428424-1-2"},
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    protected = _owner_run_dir(context_root, "1793428424-1-2", age_s=600,
                               benchmark={**not_started, "run_id": "1793428424-1-2"})
    young = _owner_run_dir(context_root, "1793428424-1-3", age_s=0, benchmark={**not_started, "run_id": "1793428424-1-3"})
    stranded = _owner_run_dir(context_root, "1793428424-1-5", age_s=600,
                              benchmark={**not_started, "run_id": "1793428424-1-5"},
                              manifest={"status": "running", "run_sh_pid": DEAD_PID, "services": []},
                              cleanup="version=2\nstate=pending\n")
    # Another session's run under this checkout: identical record, not named
    # by any of this state dir's teardowns.
    foreign = _owner_run_dir(context_root, "1793428424-1-6", age_s=600, benchmark={**not_started, "run_id": "1793428424-1-6"})
    state = tmp / "owner-runs-state"
    (state / "teardown").mkdir(parents=True)
    (state / "teardown" / "attempt-0-smoke.json").write_text(json.dumps({
        "records": [{"run_id": aborted_id}, {"run_id": young.name}, {"run_id": stranded.name}]}))
    scenario_env = {**env, "BENCHMARK_STARTUP_GRACE_SECONDS": "2"}
    try:
        started = time.monotonic()
        ran = run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=scenario_env)
        waited = time.monotonic() - started
        assert ran.returncode == 0, (ran.returncode, ran.stdout, ran.stderr)
        receipt = json.loads((state / "receipt.json").read_text())
        assert receipt["status"] == "passed", receipt["status"]
        summary = receipt["owner_runs"]
        assert summary["stage"] == "attempt-1-preflight" and summary["refused"] == [], summary
        # The young own record was protected until its grace passed, then set aside too.
        assert summary["waited_s"] >= 2.0 and waited >= 2.0, (summary, waited)
        assert summary["counts"] == {"live": 1, "finished": 0, "aborted": 3, "stranded": 1, "bootstrapping": 0,
                                     "unknown": 0}, summary
        assert sorted(run["run_id"] for run in summary["set_aside"]) == sorted([aborted_id, young.name]), summary
        # The carrier-protected run is another session's too: reported, left.
        assert sorted(summary["foreign"]) == sorted([protected.name, foreign.name]), summary
        line = next(l for l in ran.stdout.splitlines() if l.startswith("PIPELINE_OWNER_RUNS "))
        assert ("attempt=1 stage=attempt-1-preflight live=1 finished=0 aborted=3 stranded=1 bootstrapping=0 "
                "unknown=0 foreign=2 set_aside=") in line and "refused=-" in line, line
        # Set aside, never deleted: the evidence moved intact with the classification beside it.
        for run_dir in (aborted, young):
            assert not run_dir.exists(), run_dir
            moved = context_root / "_aborted" / run_dir.name
            assert (moved / "logs" / "frontend.log").read_text() == "evidence\n", moved
            assert json.loads((moved / "local-benchmark-owner.json").read_text())["state"] == "not_started"
            mark = json.loads((moved / "aborted-by-deploy-pipeline.json").read_text())
            assert mark["classification"] == "aborted" and mark["original_path"] == str(run_dir), mark
        assert (context_root / "_aborted" / aborted_id / "services.json").exists()
        # _aborted/ itself stays as old as its oldest run (the young run sorts
        # first and would otherwise stamp it with "now"): the shell readers'
        # young-directory bootstrap heuristics must not see a fresh bootstrap.
        assert time.time() - (context_root / "_aborted").stat().st_mtime >= 500, (context_root / "_aborted").stat()
        # Stranded (manifest without a clean receipt) and foreign runs stay put.
        assert stranded.exists() and foreign.exists(), (stranded.exists(), foreign.exists())
        # A pid-less record whose run id a live process carries is live: untouched.
        assert protected.exists() and _process_alive(carrier.pid)
        assert json.loads((protected / "local-benchmark-owner.json").read_text())["pid"] is None
        rows = {r["run_id"]: r for r in map(json.loads, (state / "owner-runs.jsonl").read_text().splitlines())}
        assert rows[protected.name]["classification"] == "live" and rows[protected.name]["pids"] == [carrier.pid]
        assert rows[protected.name]["action"].startswith("left") and "carried by live process" in rows[protected.name]["reason"]
        assert rows[stranded.name]["classification"] == "stranded" and rows[stranded.name]["action"] == "left"
        assert rows[foreign.name]["classification"] == "aborted" and rows[foreign.name]["own"] is False
        assert rows[foreign.name]["action"] == "left (not this deploy's run)", rows[foreign.name]
        assert {rows[r]["action"] for r in (aborted_id, young.name)} == {"set-aside"}, rows

        # Unreadable record (any session's): unknown, the launch is refused, nothing moved or signalled.
        broken = _owner_run_dir(context_root, "1793428424-1-4", age_s=600)
        (broken / "local-stack-owner.json").write_text("{\"pid\": ")
        since = time.time()
        refused = run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=scenario_env)
        assert refused.returncode == 1, (refused.returncode, refused.stdout, refused.stderr)
        assert "PIPELINE_OWNER_RUNS_REFUSED attempt=1 1793428424-1-4: unknown" in refused.stderr, refused.stderr
        receipt = json.loads((state / "receipt.json").read_text())
        assert receipt["status"] == "failed" and receipt["refused"][0]["run_id"] == broken.name, receipt
        assert receipt["lanes"]["quick"]["status"] == "failed", receipt["lanes"]
        assert receipt["lanes"]["quick"]["note"].startswith("refused: owner-run preflight"), receipt["lanes"]
        assert broken.exists() and protected.exists() and foreign.exists() and _process_alive(carrier.pid)
        assert not (context_root / "_aborted" / broken.name).exists()
        woke = run_driver("wait", "--state-dir", str(state), "--timeout", "10", "--since", str(since), env=scenario_env)
        assert woke.returncode == 1, (woke.returncode, woke.stdout)
        # A refused launch is not a completed failed round for the fix-loop cap.
        history = [json.loads(l) for l in (state / "history.jsonl").read_text().splitlines()] + [receipt]
        assert pipeline.fix_loop_state(history, 1)["failed_rounds"] == 0 and not pipeline.fix_loop_state(history, 1)["capped"]
        shutil.rmtree(broken)
        # Another session's run still bootstrapping: reported, never waited on.
        foreign_young = _owner_run_dir(context_root, "1793428424-1-7", age_s=0,
                                       benchmark={**not_started, "run_id": "1793428424-1-7"})
        again = run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=scenario_env)
        assert again.returncode == 0, (again.returncode, again.stderr)
        summary = json.loads((state / "receipt.json").read_text())["owner_runs"]
        assert summary["waited_s"] < 1.0 and summary["counts"]["bootstrapping"] == 1, summary
        # waited_s reports a wait, not how long one classification pass took:
        # on a loaded host a single /proc scan of this fixture took 2.9 s.
        def slow_classify(*_args, **_kwargs) -> list[dict]:
            time.sleep(1.2)
            return [{"run_id": "1793428424-1-9", "classification": pipeline.OWNER_RUN_BOOTSTRAPPING,
                     "reason": "fixture: still bootstrapping"}]

        with patch.object(pipeline, "classify_owner_runs", side_effect=slow_classify):
            foreign_only = pipeline.reconcile_owner_runs(context_root, tmp / "slow-scan-state", stage="slow-scan",
                                                         wait_seconds=3.0, grace_seconds=2.0,
                                                         own_run_ids=set(), poll_seconds=0.1)
            own = pipeline.reconcile_owner_runs(context_root, tmp / "slow-scan-state", stage="slow-scan-own",
                                                wait_seconds=1.5, grace_seconds=2.0,
                                                own_run_ids={"1793428424-1-9"}, poll_seconds=0.1)
        assert foreign_only["waited_s"] == 0.0 and foreign_only["foreign"] == ["1793428424-1-9"], foreign_only
        assert own["waited_s"] >= 1.5 and own["refused"], own
        assert foreign_young.exists() and foreign.exists() and summary["set_aside"] == [], summary
        assert sorted(summary["foreign"]) == sorted([protected.name, foreign.name, foreign_young.name]), summary
    finally:
        carrier.kill()
        carrier.wait()
        shutil.rmtree(context_root, ignore_errors=True)

    # ── Teardown: a superseded lane's not_started run is set aside by the lane teardown ──
    scripts = tmp / "owner-runs-scripts"
    scripts.mkdir()
    probe = source_root / ".owner-runs-probe.tmp"
    probe.unlink(missing_ok=True)
    # The lane: like local.py it records not_started under a generated run id
    # that embeds the controller pid, then (the controller being stopped before
    # it bound a benchmark child) idles until the lane is superseded.
    (scripts / "lane.sh").write_text(
        "#!/bin/bash\n"
        "[ -f \"$2\" ] && exit 0\n"
        "run_dir=\"$1/$(date +%s)-$$-9\"\n"
        "mkdir -p \"$run_dir\"\n"
        "printf '{\"version\":1,\"run_id\":\"%s\",\"state\":\"not_started\",\"pid\":null,\"native_identity\":\"\","
        "\"token\":\"\",\"receipt\":\"\",\"signal\":null}\\n' \"$(basename \"$run_dir\")\" > \"$run_dir/local-benchmark-owner.json\"\n"
        "printf '%s\\n' \"$run_dir\" > \"$3\"\n"
        "sleep 60\n"
    )
    marker = tmp / "owner-runs-lane-run-dir"
    plan = tmp / "owner-runs-teardown-plan.json"
    write_plan(plan, [{"name": "smoke", "reuse_passed": False,
                       "command": ["bash", str(scripts / "lane.sh"), str(context_root), str(probe), str(marker)]}])
    state = tmp / "owner-runs-teardown-state"
    supervisor = subprocess.Popen(
        driver_argv("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED,
         "--follow-source", "--settle-seconds", "0.5", "--poll-seconds", "0.2", "--fix-loop-cap", "0"),
        env={**env, "DEPLOY_PIPELINE_TEARDOWN_WAIT_SECONDS": "1", "DEPLOY_PIPELINE_TEARDOWN_KILL_AFTER_SECONDS": "2",
             "BENCHMARK_STARTUP_GRACE_SECONDS": "0"},
        stdout=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not marker.exists():
            time.sleep(0.1)
        lane_run_dir = Path(marker.read_text().strip())
        probe.write_text("fixed\n")
        out, _ = supervisor.communicate(timeout=120)
        assert supervisor.returncode == 0, (supervisor.returncode, out)
        history = [json.loads(line) for line in (state / "history.jsonl").read_text().splitlines()]
        superseded = history[-1]
        assert superseded["status"] == "superseded" and superseded["superseded_lanes"] == ["smoke"], superseded
        teardown = superseded["lanes"]["smoke"]["teardown"]
        assert teardown["set_aside"] == [lane_run_dir.name], teardown
        assert teardown["owner_runs"] == {lane_run_dir.name: "aborted"}, teardown
        detail = json.loads(Path(teardown["receipt"]).read_text())
        assert detail["owner_runs"]["stage"] == "attempt-1-teardown-smoke" and detail["owner_runs"]["waited_s"] < 1, detail["owner_runs"]
        assert not lane_run_dir.exists() and (context_root / "_aborted" / lane_run_dir.name / "local-benchmark-owner.json").exists()
        assert f"lane=smoke outcome=clean owned=- foreign=- escalated=- killed=- eperm=- survivors=- set_aside={lane_run_dir.name} " in out, out
        # The second attempt's preflight knows that run as its own and found nothing left to set aside.
        receipt = json.loads((state / "receipt.json").read_text())
        assert receipt["attempt"] == 2 and receipt["owner_runs"]["set_aside"] == [] and receipt["owner_runs"]["refused"] == []
        assert pipeline.own_run_ids_from_state(state) == {lane_run_dir.name}, pipeline.own_run_ids_from_state(state)
    finally:
        probe.unlink(missing_ok=True)
        if supervisor.poll() is None:
            supervisor.kill()
            supervisor.wait()
        shutil.rmtree(context_root, ignore_errors=True)
    print("owner-run preflight and teardown: ok")

def check_attempt_refreshes_factory_snapshot(tmp: Path, env: dict[str, str]) -> None:
    """Every attempt re-stamps the selected factory telemetry snapshot with the
    head it freezes (observed_at + validation.source_sha and its evidence), so a
    superseding attempt's stage rows carry the launched head; nothing else in
    the snapshot changes. A snapshot that is not this checkout's own .context/
    file (a sibling deploy's file inherited through the environment) is reported
    and left alone, a retrospective keeps its observation, and a snapshot with
    keys outside the allowlist is rejected unchanged."""
    source_root = Path(env["DEPLOY_PIPELINE_SOURCE_ROOT"])
    snapshot = source_root / ".context" / "factory-metadata.json"
    snapshot.parent.mkdir(exist_ok=True)
    sample = {"schema_version": 1, "observed_at": "2026-10-28T02:35:09+00:00", "record_type": "snapshot",
              "execution": {"model": "test-model"}, "validation": {"source_sha": "0" * 40},
              "evidence": {"execution.model": "fixture receipt", "validation.source_sha": "stale fixture head"}}
    snapshot.write_text(json.dumps(sample))
    head = subprocess.run(["git", "-C", str(source_root), "rev-parse", "HEAD"], check=True,
                          stdout=subprocess.PIPE, text=True).stdout.strip()
    plan = tmp / "telemetry-plan.json"
    write_plan(plan, [{"name": "telemetry-lane", "command": ["true"], "reuse_passed": False}])
    selected = {**env, "FACTORY_METADATA_FILE": str(snapshot)}
    ran = run_driver("run", "--plan", str(plan), "--state-dir", str(tmp / "telemetry-state"), *UNBOUNDED, env=selected)
    assert ran.returncode == 0, (ran.returncode, ran.stderr)
    assert f"PIPELINE_TELEMETRY factory metadata: refreshed {snapshot}" in ran.stdout and head in ran.stdout, ran.stdout
    refreshed = json.loads(snapshot.read_text())
    assert refreshed["validation"]["source_sha"] == head and refreshed["observed_at"] != sample["observed_at"]
    assert refreshed["execution"] == sample["execution"] and refreshed["evidence"]["execution.model"] == "fixture receipt"
    assert "run_deploy_pipeline attempt 1" in refreshed["evidence"]["validation.source_sha"]
    assert head in refreshed["evidence"]["validation.source_sha"], refreshed["evidence"]
    receipt = json.loads((tmp / "telemetry-state" / "receipt.json").read_text())
    rows = [json.loads(line) for line in (Path(receipt["stage_run_dir"]) / "stages.jsonl").read_text().splitlines()]
    row = [r for r in rows if r.get("stage") == "telemetry-lane"][-1]
    assert row["telemetry"]["validation"]["source_sha"] == head, row["telemetry"]
    elsewhere = tmp / "elsewhere-factory-metadata.json"
    elsewhere.write_text(json.dumps(sample))
    before = elsewhere.read_bytes()
    outside = run_driver("run", "--plan", str(plan), "--state-dir", str(tmp / "telemetry-outside"), *UNBOUNDED,
                         env={**env, "FACTORY_METADATA_FILE": str(elsewhere)})
    assert outside.returncode == 0 and "factory metadata: not refreshed" in outside.stdout, outside.stdout
    assert "is not this checkout's" in outside.stdout, outside.stdout
    assert elsewhere.read_bytes() == before, "a snapshot outside the checkout must never be re-stamped"
    snapshot.write_text(json.dumps({**sample, "record_type": "retrospective"}))
    before = snapshot.read_bytes()
    retro = run_driver("run", "--plan", str(plan), "--state-dir", str(tmp / "telemetry-retro"), *UNBOUNDED,
                       env=selected)
    assert retro.returncode == 0 and "retrospective" in retro.stdout and "not refreshed" in retro.stdout, retro.stdout
    assert snapshot.read_bytes() == before, "a retrospective keeps its original observation"
    snapshot.write_text(json.dumps({**sample, "api_key": "must-not-leak"}))
    before = snapshot.read_bytes()
    rejected = run_driver("run", "--plan", str(plan), "--state-dir", str(tmp / "telemetry-rejected"), *UNBOUNDED,
                          env=selected)
    assert rejected.returncode != 0 and "PIPELINE_TELEMETRY factory metadata: rejected" in rejected.stderr, rejected.stderr
    assert "must-not-leak" not in rejected.stdout + rejected.stderr
    assert snapshot.read_bytes() == before, "an invalid snapshot must be left exactly as found"
    snapshot.unlink()
    print("attempt factory snapshot refresh: ok")


def check_fix_loop_cap(tmp: Path, env: dict[str, str]) -> None:
    """Two completed failed rounds stop a blind third rerun with FIX_LOOP_CAP
    (exit 6) and the failure classes; --after-rca restarts the count and a
    passed round resets it."""
    state = tmp / "cap"
    plan = tmp / "cap-plan.json"
    flag = tmp / "cap-pass"
    write_plan(plan, [
        {"name": "fails", "command": ["bash", "-c", f"test -f {flag}"], "reuse_passed": False},
        {"name": "ok", "command": ["true"], "reuse_passed": False},
    ])

    def run_once(*extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            driver_argv("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, *extra),
            env=env, stdout=subprocess.PIPE, text=True, check=False,
        )

    assert run_once().returncode == 1
    assert run_once().returncode == 1
    since = time.time()
    capped = run_once()
    assert capped.returncode == 6, (capped.returncode, capped.stdout)
    assert "FIX_LOOP_CAP: 2 full gate round(s) failed" in capped.stdout, capped.stdout
    assert "fails=nonzero-exit,nonzero-exit" in capped.stdout, capped.stdout
    assert "/RCA" in capped.stdout and "--after-rca" in capped.stdout
    receipt = json.loads((state / "receipt.json").read_text())
    assert receipt["status"] == "capped" and receipt["fix_loop"] == {
        "cap": 2, "failed_rounds": 2, "classes": {"fails": ["nonzero-exit", "nonzero-exit"]},
        "rca_ref": None, "rca_ack": False, "capped": True,
    }, receipt["fix_loop"]
    waited = subprocess.run(
        [sys.executable, str(DRIVER), "wait", "--state-dir", str(state), "--timeout", "5", "--since", str(since)],
        env=env, stdout=subprocess.PIPE, text=True, check=False,
    )
    assert waited.returncode == 6 and "status=fix-loop-cap" in waited.stdout, waited.stdout
    # The cap is tunable and recorded; 0 disables it.
    assert run_once("--fix-loop-cap", "0").returncode == 1
    assert json.loads((state / "receipt.json").read_text())["fix_loop"]["cap"] == 0
    assert run_once("--fix-loop-cap", "4").returncode == 1, "cap 4 admits a fourth consecutive round"
    assert run_once("--fix-loop-cap", "4").returncode == 6, "four consecutive failed rounds hit cap 4"
    # An RCA reference authorizes the next round and restarts the count.
    acknowledged = run_once("--after-rca", "RCA-2026-10-28-fails")
    assert acknowledged.returncode == 1, acknowledged.stdout
    assert json.loads((state / "receipt.json").read_text())["fix_loop"]["rca_ref"] == "RCA-2026-10-28-fails"
    assert run_once().returncode == 1, "round two after the RCA still runs"
    assert run_once().returncode == 6, "round three after the RCA is capped again"
    # A capped state is left only through --after-rca; the fix lands with it.
    flag.write_text("1\n")
    assert run_once().returncode == 6, "capped stays capped without an RCA reference"
    assert run_once("--after-rca", "RCA-2026-10-28-fix").returncode == 0
    # A passed round resets the count: fail, pass, then two failures are rounds one and two.
    flag.unlink()
    assert run_once().returncode == 1
    flag.write_text("1\n")
    assert run_once().returncode == 0
    flag.unlink()
    assert run_once().returncode == 1, "round one after a passed round"
    assert run_once().returncode == 1, "round two"
    assert run_once().returncode == 6, "round three is capped"
    rounds = [r["status"] for r in map(json.loads, (state / "history.jsonl").read_text().splitlines())]
    assert rounds.count("capped") == 4, rounds
    assert check_env_cap(tmp, env, plan)


def check_env_cap(tmp: Path, env: dict[str, str], plan: Path) -> bool:
    state = tmp / "cap-env"
    for _ in range(3):
        result = subprocess.run(
            driver_argv("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED),
            env={**env, "DEPLOY_FIX_LOOP_CAP": "3"}, stdout=subprocess.PIPE, text=True, check=False,
        )
        assert result.returncode == 1, "DEPLOY_FIX_LOOP_CAP=3 admits three rounds"
    return json.loads((state / "receipt.json").read_text())["fix_loop"]["cap"] == 3


def staged_template() -> dict:
    """``deploy_test_plan.standard_template()``: the gate template ``scripts/deploy gates`` plans
    from (this driver's lanes plus the gates the staged runner adds), built by the real planner
    in a child interpreter so no planner import state leaks into this suite."""
    code = "import json, deploy_test_plan; print(json.dumps(deploy_test_plan.standard_template()))"
    return json.loads(subprocess.run(
        [sys.executable, "-c", code], cwd=ROOT / "scripts", stdout=subprocess.PIPE, text=True, check=True,
    ).stdout)


def staged_quick_typescript_recipe() -> list[str]:
    """The only ``typescript`` command the staged runner's quick-triage refresh accepts: the literal
    ``typescript = [...]`` recipe in ``deploy_test_cycle.triage_quick`` (rejects any other argv)."""
    tree = ast.parse((ROOT / "scripts" / "deploy_test_cycle.py").read_text())
    for function in ast.walk(tree):
        if isinstance(function, ast.FunctionDef) and function.name == "triage_quick":
            for node in ast.walk(function):
                if (isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "typescript"
                                                         for t in node.targets)):
                    return ast.literal_eval(node.value)
    raise AssertionError("deploy_test_cycle.triage_quick no longer pins the typescript quick recipe")


def check_standard_plan_typescript() -> None:
    """The typescript lane is an incremental check with a per-worktree buildinfo
    under .context. ``scripts/deploy gates`` plans the identical command
    (deploy_test_plan.standard_template takes its lanes from this driver), the staged
    runner's quick recipe accepts only that command, and the merge path requires the
    staged receipt bound to HEAD (verify --require-staged), so the lane, the staged
    gate and the merge proof cannot drift apart. The old deploy.md Step 3 / Phase 3
    wording that pinned these is retired with that document."""
    standard = json.loads(subprocess.run(
        [sys.executable, str(DRIVER), "plan", "--group", "3"], stdout=subprocess.PIPE, text=True, check=True,
    ).stdout)
    typescript = next(lane for lane in standard["lanes"] if lane["name"] == "typescript")
    command = " ".join(typescript["command"])
    assert "tsc --noEmit --incremental --tsBuildInfoFile ../.context/tsbuildinfo/back-end.tsbuildinfo" in command, command
    assert typescript["cwd"] == "back-end", typescript
    # Anchor 1: the staged plan carries this lane's exact command and cwd.
    staged = next(gate for gate in staged_template()["gates"] if gate["name"] == "typescript")
    assert staged["command"] == typescript["command"], "the staged typescript gate must run the lane's incremental tsc command"
    assert staged["cwd"] == typescript["cwd"] and staged["checks"] == ["typescript"], staged
    # Anchor 2: the staged runner's fixed quick recipe is the same command.
    assert staged_quick_typescript_recipe() == typescript["command"], \
        "deploy_test_cycle.triage_quick must accept the same incremental tsc command the plan emits"
    # Anchor 3: the merge path (scripts/deploy merge) and the gates path both require the staged
    # receipt bound to HEAD, and merge runs it before require-mergeable.
    for relative in ("scripts/deploy_cli.py", "scripts/deploy_gates.py"):
        text = " ".join((ROOT / relative).read_text().split())
        assert re.search(r"'verify', '--require-staged', '--state-dir', str\(\w+\), '--expect-head', \w+\]", text), \
            f"{relative} must require the staged receipt bound to HEAD (verify --require-staged --expect-head)"
    merge = " ".join((ROOT / "scripts" / "deploy_cli.py").read_text().split())
    assert merge.index("'verify', '--require-staged'") < merge.index("'require-mergeable'"), \
        "scripts/deploy merge must verify the staged receipt before require-mergeable"
    with tempfile.TemporaryDirectory(prefix="require-staged-") as raw:
        refused = run_driver("verify", "--require-staged", "--state-dir", raw, env=dict(os.environ))
    assert refused.returncode == 2 and "PIPELINE_VERIFY status=no-staged-cycle exit=2" in refused.stdout, \
        (refused.returncode, refused.stdout, refused.stderr)
    # The driver keeps the fix-loop and speculative-source flags the retired deploy.md Phase 3 pinned by
    # wording (--follow-source, FIX_LOOP_CAP / --fix-loop-cap / --after-rca, default of two failed rounds);
    # their behavior is asserted by check_follow_source, check_fix_loop_cap and check_env_cap.
    pipeline = load_module("run_deploy_pipeline_fix_loop_rule", DRIVER)
    assert pipeline.DEFAULT_FIX_LOOP_CAP == 2, "two failed rounds refuse a blind rerun"
    run_help = run_driver("run", "--help", env=dict(os.environ), check=True).stdout
    for flag in ("--follow-source", "--fix-loop-cap", "--after-rca"):
        assert flag in run_help, f"run_deploy_pipeline.py run must keep {flag}"


def check_schedule_phases(tmp: Path, env: dict[str, str]) -> None:
    """EXP-L Group 3 admission schedule: quick lanes first, the exclusive
    structural lane alone, then the coverage lanes together (longest recorded
    first); every lane still runs (full sweep, no skip), Group 4 is unphased,
    the ledger records the lanes' own wall clocks, ``legacy`` keeps the
    all-at-once admission and ``simulate`` projects both from the ledger."""
    ledger = tmp / "lane-durations.json"
    env = {**env, "DEPLOY_PIPELINE_LANE_DURATIONS": str(ledger)}

    def sample(wall: float, concurrent: int) -> dict:
        return {"wall_s": wall, "status": "passed", "concurrent": concurrent, "at": "2026-10-29T00:00:00Z"}

    ledger.write_text(json.dumps({"schema_version": 1, "lanes": {
        "quick-a": [sample(5.0, 3)], "quick-b": [sample(8.0, 3)],
        "big-structural": [sample(1500.0, 3), sample(600.0, 1)],  # loaded vs alone
        "cov-a": [sample(300.0, 3)], "cov-b": [sample(200.0, 3)],
    }}))
    state = tmp / "schedule"
    plan = tmp / "schedule-plan.json"

    def lanes_for(policy: str) -> None:
        lanes = [
            {"name": "quick-a", "command": ["sleep", "0.3"], "reuse_passed": False, "group": "3"},
            {"name": "quick-b", "command": ["sleep", "0.3"], "reuse_passed": False, "group": "3"},
            {"name": "big-structural", "command": ["sleep", "0.6"], "reuse_passed": False, "group": "3",
             "exclusive": True},
            {"name": "cov-a", "command": ["sleep", "0.5"], "reuse_passed": False, "group": "3"},
            {"name": "cov-b", "command": ["sleep", "0.5"], "reuse_passed": False, "group": "3"},
            {"name": "mystery", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "3"},
            {"name": "g4", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "4"},
        ]
        write_plan(plan, lanes, schedule={"policy": policy})

    lanes_for("phased")
    ran = run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=env)
    receipt = json.loads((state / "receipt.json").read_text())
    assert ran.returncode == 0 and receipt["status"] == "passed", (ran.returncode, ran.stderr, receipt["status"])
    lanes = receipt["lanes"]
    assert all(lane["status"] == "passed" and lane.get("wall_s") for lane in lanes.values()), "no lane skipped"
    schedule = receipt["schedule"]
    assert schedule["policy"] == "phased", schedule
    assert [(p["phase"], p["lanes"]) for p in schedule["phases"]] == [
        ("quick", ["quick-a", "quick-b"]),
        ("exclusive", ["big-structural"]),
        ("coverage", ["mystery", "cov-a", "cov-b"]),  # unknown lanes are never quick; then longest first
    ], schedule["phases"]
    assert schedule["estimates"]["big-structural"] == {"seconds": 1050.0, "samples": 2, "source": "ledger",
                                                        "isolated_s": 600.0}, schedule["estimates"]
    assert schedule["estimates"]["mystery"]["source"] == "unknown"
    assert receipt["after"]["cov-a"] == ["quick-a", "quick-b", "big-structural"], receipt["after"]
    assert receipt["after"]["g4"] == [] and receipt["after"]["quick-a"] == [], receipt["after"]
    quick_end = max(lanes["quick-a"]["finished_epoch"], lanes["quick-b"]["finished_epoch"])
    structural = lanes["big-structural"]
    assert structural["started_epoch"] >= quick_end, "exclusive lane waits for the quick phase"
    assert abs(lanes["quick-a"]["started_epoch"] - lanes["quick-b"]["started_epoch"]) < 0.5, "quick lanes start together"
    for name in ("quick-a", "quick-b", "cov-a", "cov-b", "mystery"):
        other = lanes[name]
        assert other["finished_epoch"] <= structural["started_epoch"] or other["started_epoch"] >= structural["finished_epoch"], \
            f"{name} overlapped the exclusive lane"
    coverage = [lanes[name] for name in ("cov-a", "cov-b", "mystery")]
    assert all(lane["started_epoch"] >= structural["finished_epoch"] for lane in coverage)
    assert max(lane["started_epoch"] for lane in coverage) < min(lane["finished_epoch"] for lane in coverage), \
        "coverage lanes start together and overlap"
    assert lanes["g4"]["started_epoch"] < quick_end, "Group 4 is not phased"
    run_dir = Path(receipt["stage_run_dir"])
    rows = {row["stage"] for row in map(json.loads, (run_dir / "stages.jsonl").read_text().splitlines())
            if float(row.get("started_epoch") or 0) >= receipt["started_epoch"]}
    assert rows >= set(lanes), f"every lane ran through run-deploy-stage: {sorted(set(lanes) - rows)} missing"
    recorded = json.loads(ledger.read_text())["lanes"]
    assert recorded["big-structural"][-1]["status"] == "passed" and recorded["big-structural"][-1]["concurrent"] == 1
    assert recorded["big-structural"][-1]["wall_s"] >= 0.5 and len(recorded["big-structural"]) == 3
    assert recorded["mystery"][0]["concurrent"] == 3 and recorded["g4"][0]["source"] == "receipt"

    # Legacy policy: the previous all-at-once admission (structural overlaps the quick lanes).
    lanes_for("legacy")
    ran = run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=env)
    receipt = json.loads((state / "receipt.json").read_text())
    assert ran.returncode == 0 and receipt["schedule"] == {"policy": "legacy", "phases": [], "estimates": {},
                                                            "implied_after": {}}, (ran.stderr, receipt["schedule"])
    assert receipt["lanes"]["big-structural"]["started_epoch"] < receipt["lanes"]["quick-a"]["finished_epoch"]

    # simulate: isolated samples drive the phased projection; lanes without one are UNMEASURED.
    # (A fresh seeded ledger: the two runs above appended their own real samples.)
    lanes_for("phased")
    seeded = tmp / "lane-durations-seeded.json"
    seeded.write_text(json.dumps({"schema_version": 1, "lanes": {
        "quick-a": [sample(5.0, 3)], "quick-b": [sample(8.0, 3)],
        "big-structural": [sample(1500.0, 3), sample(600.0, 1)],
        "cov-a": [sample(300.0, 3)], "cov-b": [sample(200.0, 3)],
    }}))
    empty_runs = tmp / "no-runs"
    empty_runs.mkdir(exist_ok=True)
    simulated = json.loads(run_driver("simulate", "--plan", str(plan), "--max-parallel", "0",
                                      env={**env, "DEPLOY_PIPELINE_LANE_DURATIONS": str(seeded),
                                           "DEPLOY_RUN_ROOT": str(empty_runs)}, check=True).stdout)
    # phased: quick (max 5, 8) -> structural alone (isolated 600) -> coverage (max 300, 200, unknown 0)
    # legacy: everything at once at the loaded medians (structural median of 1500/600 = 1050)
    assert simulated["phased_union_wall_s"] == 8.0 + 600.0 + 300.0, simulated
    assert simulated["legacy_union_wall_s"] == 1050.0 and simulated["delta_s"] == 142.0, simulated
    assert simulated["lanes"]["big-structural"] == {"loaded_s": 1050.0, "phased_s": 600.0, "source": "ledger"}
    assert simulated["unmeasured_isolated"] == ["quick-a", "quick-b", "cov-a", "cov-b", "mystery"], simulated
    # An unknown policy is refused before any lane starts.
    write_plan(plan, [{"name": "x", "command": ["true"], "reuse_passed": False}], schedule={"policy": "bogus"})
    assert run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=env).returncode == 2
    print("schedule phases: ok")


def check_stage_receipt_seed(tmp: Path, env: dict[str, str]) -> None:
    """Without a ledger the estimates come from this worktree's stage receipts
    (duration + concurrent_stages), never from the default table."""
    pipeline = load_module("pipeline_stage_seed", DRIVER)
    run_root = tmp / "seed-runs" / "20261029-000000-x"
    run_root.mkdir(parents=True)
    rows = [
        {"stage": "deploy-command-structural", "status": "passed", "duration_seconds": 441.2, "started_epoch": 1.0,
         "started_at": "2026-10-29T00:00:00Z", "detail": {"timing": {"concurrent_stages": 1}}},
        {"stage": "deploy-command-structural", "status": "passed", "duration_seconds": 1559.5, "started_epoch": 2.0,
         "started_at": "2026-10-29T01:00:00Z", "detail": {"timing": {"concurrent_stages": 2}}},
        {"stage": "deploy-command-structural", "status": "reused", "duration_seconds": 1.0, "started_epoch": 3.0},
        {"stage": "eslint", "status": "failed", "duration_seconds": 24.0, "started_epoch": 4.0,
         "detail": {"timing": {"concurrent_stages": 4}}},
    ]
    (run_root / "stages.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
    lanes = [pipeline.Lane(name="deploy-command-structural", command=["true"], group="3", exclusive=True),
             pipeline.Lane(name="eslint", command=["true"], group="3"),
             pipeline.Lane(name="agents-coverage-blackbox", command=["true"], group="3")]
    samples = pipeline.stage_receipt_samples([lane.name for lane in lanes], run_root.parent)
    estimates = pipeline.lane_estimates(lanes, {}, samples)
    assert estimates["deploy-command-structural"] == {"seconds": 1000.4, "samples": 2, "source": "stage-receipts",
                                                       "isolated_s": 441.2}, estimates
    # eslint's only receipt FAILED: not evidence of its duration (follow-up k), so the default table applies.
    assert estimates["eslint"] == {"seconds": 24.0, "samples": 0, "source": "default", "isolated_s": None}, estimates
    assert estimates["agents-coverage-blackbox"] == {"seconds": 800.0, "samples": 0, "source": "default",
                                                      "isolated_s": None}
    phases = pipeline.schedule_phases(lanes, estimates)
    assert [p["lanes"] for p in phases] == [["eslint"], ["deploy-command-structural"], ["agents-coverage-blackbox"]], phases
    assert pipeline.implied_dependencies(phases)["agents-coverage-blackbox"] == ["eslint", "deploy-command-structural"]
    devbox = {"cpus": 8, "mem_available_mb": 11000, "mem_total_mb": 16384, "watchdog_cap_mb": 14472}
    assert pipeline.exclusive_structural_workers(devbox) == 3, "whole budget (7040 MB) backs 3 workers at the floor"
    assert pipeline.exclusive_structural_workers({"cpus": 14, "mem_available_mb": 32768}) == 8
    assert pipeline.exclusive_structural_workers({"cpus": 2, "mem_available_mb": 32768}) == 2
    print("stage receipt seed: ok")


def check_passed_only_estimates_and_dag_phases(tmp: Path, env: dict[str, str]) -> None:
    """Follow-ups k/n (2026-10-30): only passed samples estimate a lane (a
    2.5 s FAILED backend-coverage sample and a 4.9 s FAILED live-probes sample
    were re-phased as quick); phases are layered over the plan's ``after``
    DAG so a lane that waits for the exclusive lane never lands in the quick
    phase (attempt 7 deadlocked with every lane pending); an explicit cycle or
    an unknown dependency fails the attempt loudly before any lane starts."""
    pipeline = load_module("pipeline_passed_only", DRIVER)

    def sample(wall: float, status: str, concurrent: int = 1) -> dict:
        return {"wall_s": wall, "status": status, "concurrent": concurrent, "at": "2026-10-30T00:00:00Z"}

    lanes = [pipeline.Lane(name="probe", command=["true"], group="3"),
             pipeline.Lane(name="eslint", command=["true"], group="3")]
    estimates = pipeline.lane_estimates(lanes, {"probe": [sample(4.9, "failed", 3)]},
                                        {"probe": [sample(2.5, "failed")], "eslint": [sample(24.0, "failed")]})
    assert estimates["probe"] == {"seconds": None, "samples": 0, "source": "unknown", "isolated_s": None}, estimates
    assert estimates["eslint"]["source"] == "default", estimates
    estimates = pipeline.lane_estimates(
        lanes, {"probe": [sample(4.9, "failed", 3), sample(70.0, "passed", 1), sample(2.0, "failed")]}, {})
    assert estimates["probe"] == {"seconds": 70.0, "samples": 1, "source": "ledger", "isolated_s": 70.0}, estimates
    estimates = pipeline.lane_estimates(lanes, {"probe": [sample(4.9, "failed")]}, {"probe": [sample(30.0, "passed", 2)]})
    assert estimates["probe"] == {"seconds": 30.0, "samples": 1, "source": "stage-receipts", "isolated_s": None}, estimates
    assert [p["lanes"] for p in pipeline.schedule_phases(lanes, pipeline.lane_estimates(
        lanes, {"probe": [sample(4.9, "failed", 3)]}, {}))] == [["eslint"], ["probe"]], "a failed-only lane is never quick"

    ledger = tmp / "passed-only-ledger.json"
    ledger.write_text(json.dumps({"schema_version": 1, "lanes": {
        "probe": [sample(4.9, "failed", 3)], "big": [sample(600.0, "passed", 1)],
        "quick": [sample(5.0, "passed", 3)], "quick-after": [sample(6.0, "passed", 3)], "cov": [sample(300.0, "passed", 3)],
    }}))
    assert pipeline.load_lane_durations(ledger)["probe"][0]["status"] == "failed", "failed samples stay as telemetry"
    env = {**env, "DEPLOY_PIPELINE_LANE_DURATIONS": str(ledger)}
    state = tmp / "dag"
    plan = tmp / "dag-plan.json"
    write_plan(plan, [
        {"name": "quick", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "3"},
        {"name": "quick-after", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "3", "after": ["quick"]},
        {"name": "big", "command": ["sleep", "0.4"], "reuse_passed": False, "group": "3", "exclusive": True},
        {"name": "probe", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "3", "after": ["big"]},
        {"name": "cov", "command": ["sleep", "0.3"], "reuse_passed": False, "group": "3"},
    ], schedule={"policy": "phased"})
    ran = run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=env, timeout=120)
    receipt = json.loads((state / "receipt.json").read_text())
    assert ran.returncode == 0 and receipt["status"] == "passed", (ran.returncode, ran.stderr, receipt["status"])
    phases = [(p["phase"], p["lanes"]) for p in receipt["schedule"]["phases"]]
    assert phases == [("quick", ["quick", "quick-after"]), ("exclusive", ["big"]), ("coverage", ["probe", "cov"])], phases
    assert receipt["schedule"]["estimates"]["probe"]["source"] == "unknown", receipt["schedule"]["estimates"]
    assert receipt["after"]["probe"][0] == "big" and set(receipt["after"]["probe"]) == {"big", "quick", "quick-after"}
    assert receipt["after"]["quick-after"] == ["quick"], "an edge inside the quick phase adds no implied edges"
    ran_lanes = receipt["lanes"]
    assert all(lane["status"] == "passed" for lane in ran_lanes.values()), ran_lanes
    assert ran_lanes["quick-after"]["started_epoch"] >= ran_lanes["quick"]["finished_epoch"]
    assert ran_lanes["big"]["started_epoch"] >= ran_lanes["quick-after"]["finished_epoch"]
    assert ran_lanes["probe"]["started_epoch"] >= ran_lanes["big"]["finished_epoch"]
    recorded = json.loads(ledger.read_text())["lanes"]
    assert recorded["probe"][0]["status"] == "failed" and recorded["probe"][-1]["status"] == "passed", recorded["probe"]

    for policy in ("phased", "legacy"):
        write_plan(plan, [{"name": "a", "command": ["true"], "reuse_passed": False, "group": "3", "after": ["b"]},
                          {"name": "b", "command": ["true"], "reuse_passed": False, "group": "3", "after": ["a"]}],
                   schedule={"policy": policy})
        cyc = run_driver("run", "--plan", str(plan), "--state-dir", str(tmp / f"cycle-{policy}"), *UNBOUNDED,
                         env=env, timeout=60)
        assert cyc.returncode == 2 and "cycl" in cyc.stderr, (policy, cyc.returncode, cyc.stderr)
        assert not (tmp / f"cycle-{policy}" / "receipt.json").exists(), "a cyclic plan must fail before any lane starts"
    write_plan(plan, [{"name": "a", "command": ["true"], "reuse_passed": False, "group": "3", "after": ["ghost"]}],
               schedule={"policy": "phased"})
    ghost = run_driver("run", "--plan", str(plan), "--state-dir", str(tmp / "ghost"), *UNBOUNDED, env=env, timeout=60)
    assert ghost.returncode == 2 and "ghost" in ghost.stderr, (ghost.returncode, ghost.stderr)
    print("passed-only estimates + DAG phases: ok")


def check_declared_phase_lanes(tmp: Path, env: dict[str, str]) -> None:
    """Follow-up x (2026-10-30): the 4096 MB local smoke lane (Group 4, no
    ``after`` edges) was admitted at attempt start and held the memory the
    exclusive structural lane (6544 MB of a 7752 MB budget) needed, so the
    pipeline ran smoke alone for ~22 min (11-24 min across attempts) before
    any Group 3 lane ran. A lane
    outside Group 3 may now declare ``"phase": "coverage"``: it joins the
    coverage phase (after the quick and exclusive phases) and runs beside the
    coverage lanes within the budget. Undeclared Group 4 lanes stay unphased,
    the plan's own ``after`` edges are kept exactly, and a lane whose edges are
    met starts as soon as memory allows: nothing waits for the declared smoke
    lane unless its plan says so. ``plan`` declares it for the local smoke
    lane and ``simulate`` projects the declared lanes beside Group 3."""
    def sample(wall: float, concurrent: int) -> dict:
        return {"wall_s": wall, "status": "passed", "concurrent": concurrent, "at": "2026-10-30T00:00:00Z"}

    ledger = tmp / "declared-phase-ledger.json"
    ledger.write_text(json.dumps({"schema_version": 1, "lanes": {
        "quick": [sample(5.0, 3)], "big": [sample(600.0, 1)], "cov": [sample(300.0, 3)], "smoke": [sample(1400.0, 2)],
    }}))
    env = {**env, "DEPLOY_PIPELINE_LANE_DURATIONS": str(ledger)}
    plan = tmp / "declared-phase-plan.json"
    state = tmp / "declared-phase"
    semantic_started = tmp / "declared-phase-semantic-started"
    # Preserve the original smoke duration, then synchronize overlap with semantic
    # admission instead of assuming child startup/reaping fits inside 1.2 seconds.
    smoke_command = [sys.executable, "-c",
                     "import pathlib, time; "
                     f"marker = pathlib.Path({str(semantic_started)!r}); "
                     "time.sleep(1.2); deadline = time.monotonic() + 10\n"
                     "while not marker.exists() and time.monotonic() < deadline: time.sleep(0.01)\n"
                     "assert marker.exists(), 'semantic start was serialized behind smoke'"]
    # Budget 100: smoke (50) beside big (80) cannot fit; cov (30) beside smoke can.
    write_plan(plan, [
        {"name": "quick", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "3", "memory_mb": 10},
        {"name": "big", "command": ["sleep", "0.4"], "reuse_passed": False, "group": "3", "exclusive": True,
         "memory_mb": 80},
        {"name": "cov", "command": ["sleep", "0.3"], "reuse_passed": False, "group": "3", "memory_mb": 30},
        {"name": "smoke", "command": smoke_command, "reuse_passed": False, "group": "4", "memory_mb": 50,
         "phase": "coverage"},
        {"name": "probe", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "3", "memory_mb": 10,
         "after": ["big", "cov"]},
        {"name": "semantic", "command": [sys.executable, "-c",
                                          f"import pathlib, time; pathlib.Path({str(semantic_started)!r}).touch(); "
                                          "time.sleep(0.2)"], "reuse_passed": False, "group": "4", "memory_mb": 10,
         "after": ["big", "cov", "probe"]},
        {"name": "g4-free", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "4", "memory_mb": 10},
    ], schedule={"policy": "phased"})
    with releasing(semantic_started):
        ran = run_driver("run", "--plan", str(plan), "--state-dir", str(state), "--max-parallel", "0",
                         "--memory-budget-mb", "100", env=env, timeout=120)
    receipt = json.loads((state / "receipt.json").read_text())
    assert ran.returncode == 0 and receipt["status"] == "passed", (ran.returncode, ran.stderr, receipt["status"])
    lanes = receipt["lanes"]
    assert all(lane["status"] == "passed" for lane in lanes.values()), lanes
    phases = [(p["phase"], p["lanes"]) for p in receipt["schedule"]["phases"]]
    assert phases[:2] == [("quick", ["quick"]), ("exclusive", ["big"])], phases
    assert phases[2][0] == "coverage" and set(phases[2][1]) == {"cov", "probe", "smoke"}, phases
    assert receipt["after"]["smoke"] == ["quick", "big"], receipt["after"]
    assert receipt["after"]["semantic"] == ["big", "cov", "probe"], "declared edges kept, no implied edges added"
    assert receipt["after"]["g4-free"] == [], receipt["after"]
    big, smoke, cov, probe = lanes["big"], lanes["smoke"], lanes["cov"], lanes["probe"]
    assert big["started_epoch"] >= lanes["quick"]["finished_epoch"], "exclusive lane waits for the quick phase"
    assert big["started_epoch"] < smoke["started_epoch"], "the exclusive lane is admitted before the smoke lane"
    assert smoke["started_epoch"] >= big["finished_epoch"] and cov["started_epoch"] >= big["finished_epoch"]
    assert max(smoke["started_epoch"], cov["started_epoch"]) < min(smoke["finished_epoch"], cov["finished_epoch"]), \
        "smoke overlaps the coverage lane"
    assert probe["started_epoch"] >= cov["finished_epoch"] and probe["started_epoch"] < smoke["finished_epoch"], \
        "a lane whose own edges are met starts while smoke still runs"
    assert lanes["semantic"]["started_epoch"] >= probe["finished_epoch"], receipt["after"]
    assert lanes["semantic"]["started_epoch"] < smoke["finished_epoch"], "semantic is not gated by the smoke lane"
    assert lanes["g4-free"]["started_epoch"] < lanes["quick"]["finished_epoch"], "undeclared Group 4 stays unphased"

    # The standard plan declares the stack phase for the local smoke lane and
    # the AgentCard lifecycle lane (check_stack_phase_lanes); the cloud smoke
    # lane stays unphased.
    local = {lane["name"]: lane for lane in plan_json("--group", "4", "--smoke", "local", "--agentcard")["lanes"]}
    assert local["smoke"]["phase"] == "stack" and local["smoke"]["memory_mb"] == 4150, local["smoke"]
    assert local["agentcard-lifecycle"]["phase"] == "stack" and local["agentcard-lifecycle"]["memory_mb"] == 4150, \
        local["agentcard-lifecycle"]
    cloud = {lane["name"]: lane for lane in plan_json("--group", "4", "--smoke", "cloud")["lanes"]}
    assert not cloud["smoke"].get("phase"), cloud["smoke"]
    phased_plan = plan_json("--group", "all", "--backend", "--smoke", "local", "--schedule", "phased")
    kinds = [p["phase"] for p in phased_plan["schedule"]["phases"]]
    assert kinds == ["quick", "stack", "exclusive", "coverage"], phased_plan["schedule"]["phases"]
    assert phased_plan["schedule"]["phases"][1]["lanes"] == ["smoke"], phased_plan["schedule"]["phases"]
    assert "backend-coverage-blackbox" in phased_plan["schedule"]["phases"][3]["lanes"], phased_plan["schedule"]["phases"]
    assert "smoke" not in phased_plan["schedule"]["phases"][0]["lanes"]
    assert "smoke" in phased_plan["schedule"]["estimates"], "the smoke lane has a default estimate"

    # simulate projects the declared lane beside Group 3 and reports the Group 3-only wall separately.
    write_plan(plan, [
        {"name": "quick", "command": ["true"], "group": "3"},
        {"name": "big", "command": ["true"], "group": "3", "exclusive": True},
        {"name": "cov", "command": ["true"], "group": "3"},
        {"name": "smoke", "command": ["true"], "group": "4", "phase": "coverage"},
        {"name": "g4-free", "command": ["true"], "group": "4"},
    ], schedule={"policy": "phased"})
    # A fresh seeded ledger: the run above appended its own real samples to the first one.
    seeded = tmp / "declared-phase-seeded.json"
    seeded.write_text(json.dumps({"schema_version": 1, "lanes": {
        "quick": [sample(5.0, 3)], "big": [sample(600.0, 1)], "cov": [sample(300.0, 3)], "smoke": [sample(1400.0, 2)],
    }}))
    empty_runs = tmp / "declared-no-runs"
    empty_runs.mkdir(exist_ok=True)
    simulated = json.loads(run_driver("simulate", "--plan", str(plan), "--max-parallel", "0",
                                      env={**env, "DEPLOY_PIPELINE_LANE_DURATIONS": str(seeded),
                                           "DEPLOY_RUN_ROOT": str(empty_runs)}, check=True).stdout)
    # phased: quick 5 -> big alone 600 -> cov 300 beside smoke 1400; legacy: everything at once.
    assert simulated["phased_union_wall_s"] == 5.0 + 600.0 + 1400.0, simulated
    assert simulated["legacy_union_wall_s"] == 1400.0, simulated
    assert simulated["group3"] == {"legacy_union_wall_s": 600.0, "phased_union_wall_s": 905.0, "delta_s": -305.0}, simulated
    assert simulated["lanes"]["smoke"]["phase"] == "coverage" and "g4-free" not in simulated["lanes"], simulated["lanes"]
    assert [p["lanes"] for p in simulated["phases"]] == [["quick"], ["big"], ["smoke", "cov"]], simulated["phases"]

    # An unknown declared phase is refused before any lane starts.
    write_plan(plan, [{"name": "x", "command": ["true"], "reuse_passed": False, "group": "4", "phase": "quick"}],
               schedule={"policy": "phased"})
    bogus = run_driver("run", "--plan", str(plan), "--state-dir", str(tmp / "declared-bogus"), *UNBOUNDED, env=env)
    assert bogus.returncode == 2 and "phase" in bogus.stderr, (bogus.returncode, bogus.stderr)
    assert not (tmp / "declared-bogus" / "receipt.json").exists()
    print("declared phase lanes: ok")


def check_dependencies_through_unphased_lanes(tmp: Path, env: dict[str, str]) -> None:
    """CodeRabbit on #1639 (2026-10-30): a quick Group 3 lane ``q`` that waits
    for an unphased lane ``u`` which in turn waits for a coverage lane ``p``
    landed in the quick phase (its only direct edge, ``u``, is unphased and
    was dropped), so the implied coverage edge p -> q closed the cycle
    p -> u -> q -> p and ``assert_acyclic`` refused the plan before any lane
    started. Dependencies are now followed through unphased lanes: ``q``
    joins ``p``'s coverage phase, the plan's own edges stay exact, admission
    honours p -> u -> q and ``simulate`` projects the same chain."""
    pipeline = load_module("pipeline_unphased_chain", DRIVER)

    def sample(wall: float, concurrent: int = 1) -> dict:
        return {"wall_s": wall, "status": "passed", "concurrent": concurrent, "at": "2026-10-30T00:00:00Z"}

    walls = {"q": [sample(5.0)], "p": [sample(300.0)], "quick": [sample(4.0)]}
    lanes = [pipeline.Lane(name="q", command=["true"], group="3", after=["u"]),
             pipeline.Lane(name="u", command=["true"], group="4", after=["p"]),
             pipeline.Lane(name="p", command=["true"], group="3"),
             pipeline.Lane(name="quick", command=["true"], group="3")]
    phases = pipeline.schedule_phases(lanes, pipeline.lane_estimates(lanes, walls, {}))
    assert [(p["phase"], p["lanes"]) for p in phases] == [("quick", ["quick"]), ("coverage", ["p", "q"])], phases
    assert pipeline.phased_dependencies(lanes) == {"q": ["p"], "p": [], "quick": []}, pipeline.phased_dependencies(lanes)

    ledger = tmp / "unphased-chain-ledger.json"
    ledger.write_text(json.dumps({"schema_version": 1, "lanes": walls}))
    env = {**env, "DEPLOY_PIPELINE_LANE_DURATIONS": str(ledger)}
    plan = tmp / "unphased-chain-plan.json"
    write_plan(plan, [
        {"name": "q", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "3", "after": ["u"]},
        {"name": "u", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "4", "after": ["p"]},
        {"name": "p", "command": ["sleep", "0.3"], "reuse_passed": False, "group": "3"},
        {"name": "quick", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "3"},
    ], schedule={"policy": "phased"})
    state = tmp / "unphased-chain"
    ran = run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=env, timeout=120)
    assert ran.returncode == 0, (ran.returncode, ran.stderr)
    receipt = json.loads((state / "receipt.json").read_text())
    assert receipt["status"] == "passed", receipt["status"]
    assert [(p["phase"], p["lanes"]) for p in receipt["schedule"]["phases"]] == \
        [("quick", ["quick"]), ("coverage", ["p", "q"])], receipt["schedule"]["phases"]
    assert receipt["after"] == {"q": ["u", "quick"], "u": ["p"], "p": ["quick"], "quick": []}, receipt["after"]
    ran_lanes = receipt["lanes"]
    assert ran_lanes["u"]["started_epoch"] >= ran_lanes["p"]["finished_epoch"], "u waits for p (plan edge)"
    assert ran_lanes["q"]["started_epoch"] >= ran_lanes["u"]["finished_epoch"], "q waits for u (plan edge)"
    # A fresh seeded ledger: the run above appended its own real samples to the first one.
    seeded = tmp / "unphased-chain-seeded.json"
    seeded.write_text(json.dumps({"schema_version": 1, "lanes": walls}))
    empty_runs = tmp / "unphased-no-runs"
    empty_runs.mkdir(exist_ok=True)
    simulated = json.loads(run_driver("simulate", "--plan", str(plan), "--max-parallel", "0",
                                      env={**env, "DEPLOY_PIPELINE_LANE_DURATIONS": str(seeded),
                                           "DEPLOY_RUN_ROOT": str(empty_runs)}, check=True).stdout)
    assert [p["lanes"] for p in simulated["phases"]] == [["quick"], ["p", "q"]], simulated["phases"]
    # legacy: p (300) then q (5) through u, quick beside them; phased: quick 4 -> p 300 -> q 5.
    assert simulated["legacy_union_wall_s"] == 305.0 and simulated["phased_union_wall_s"] == 309.0, simulated
    print("dependencies through unphased lanes: ok")


def check_simulate_legacy_plan_group3(tmp: Path, env: dict[str, str]) -> None:
    """CodeRabbit on #1639 (2026-10-30): ``simulate --legacy-plan`` replaced only
    the top-level legacy wall and delta; the ``group3`` block still compared
    the phased plan against itself. Both blocks now describe the supplied
    legacy plan."""
    def sample(wall: float, concurrent: int = 1) -> dict:
        return {"wall_s": wall, "status": "passed", "concurrent": concurrent, "at": "2026-10-30T00:00:00Z"}

    ledger = tmp / "legacy-plan-ledger.json"
    ledger.write_text(json.dumps({"schema_version": 1, "lanes": {
        "quick": [sample(5.0, 3)], "big": [sample(600.0)], "cov": [sample(300.0, 3)], "smoke": [sample(1400.0, 2)],
        "legacy-extra": [sample(1000.0, 3)],
    }}))
    empty_runs = tmp / "legacy-plan-no-runs"
    empty_runs.mkdir(exist_ok=True)
    env = {**env, "DEPLOY_PIPELINE_LANE_DURATIONS": str(ledger), "DEPLOY_RUN_ROOT": str(empty_runs)}
    phased = [
        {"name": "quick", "command": ["true"], "group": "3"},
        {"name": "big", "command": ["true"], "group": "3", "exclusive": True},
        {"name": "cov", "command": ["true"], "group": "3"},
        {"name": "smoke", "command": ["true"], "group": "4", "phase": "coverage"},
    ]
    plan = tmp / "legacy-plan-phased.json"
    legacy_plan = tmp / "legacy-plan-legacy.json"
    write_plan(plan, phased, schedule={"policy": "phased"})
    # The legacy plan carries a Group 3 lane the phased plan does not (its own structural shape).
    write_plan(legacy_plan, [*phased, {"name": "legacy-extra", "command": ["true"], "group": "3"}],
               schedule={"policy": "legacy"})
    simulated = json.loads(run_driver("simulate", "--plan", str(plan), "--legacy-plan", str(legacy_plan),
                                      "--max-parallel", "0", env=env, check=True).stdout)
    assert simulated["legacy_plan"] == str(legacy_plan), simulated
    # Top level: legacy plan all at once (smoke 1400 dominates); phased quick 5 -> big 600 -> smoke 1400.
    assert simulated["legacy_union_wall_s"] == 1400.0 and simulated["phased_union_wall_s"] == 2005.0, simulated
    assert simulated["delta_s"] == -605.0, simulated
    # Group 3: the legacy plan's own lanes (legacy-extra 1000 dominates), not the phased plan's 600.
    assert simulated["group3"] == {"legacy_union_wall_s": 1000.0, "phased_union_wall_s": 905.0, "delta_s": 95.0}, \
        simulated["group3"]
    print("simulate --legacy-plan group3: ok")


if __name__ == "__main__":
    raise SystemExit(main())
