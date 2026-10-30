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

import importlib.util
import inspect
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
DRIVER = ROOT / "scripts" / "run_deploy_pipeline.py"
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


def start_timing(run_root: Path, env: dict[str, str]) -> None:
    subprocess.run(
        ["bash", str(DRIVER.parent / "run-deploy-stage"), "--start"],
        cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL,
    )


def write_plan(path: Path, lanes: list[dict], **extra: object) -> None:
    # Tiny sleep/true fixture commands have explicit synthetic reservations;
    # production's 1 GiB default is not their measured footprint.
    path.write_text(json.dumps({"lanes": [{"memory_mb": 1, **lane} for lane in lanes], **extra}))


def run_driver(*args: str, env: dict[str, str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(DRIVER), *args], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
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
    assert lanes["deploy-command-structural"]["memory_mb"] == 1024 + 1840 * 3 <= devbox["memory_budget_mb"]
    assert [runner.default_max_workers(c) for c in (1, 2, 4, 8, 14, 32)] == [1, 1, 2, 4, 8, 8]
    assert runner.default_max_workers() <= runner.DEFAULT_MAX_WORKERS
    assert pipeline.scale_workers(1, {"cpus": 2, "mem_available_mb": 4096}) == 1
    live = plan_json("--group", "3")
    assert live["host"]["cpus"] == (os.cpu_count() or 1) and live["host"]["mem_available_mb"] is not None
    print("plan scaling: ok")


def check_structural_memory_floor() -> None:
    # Captured largest child: 1471.98 MiB in the original 20261028-174430
    # stage receipt. Every concurrently active suite can reach that floor.
    for cpus, available, expected_workers in ((1, 8000, 1), (8, 11000, 3), (14, 32768, 8)):
        plan = plan_json("--group", "3", "--host-cpus", str(cpus),
                         "--host-mem-mb", str(available))
        workers = plan["workers"]["structural"]
        assert workers == expected_workers, plan
        lane = next(lane for lane in plan["lanes"] if lane["name"] == "deploy-command-structural")
        floor = 1024 + 1471.98 * 1.25 * workers
        assert lane["memory_mb"] >= floor, (workers, lane["memory_mb"], floor)
    print("structural reservations cover measured per-worker floor: ok")


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
         patch.dict(os.environ, env):
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
    """Without --max-parallel the host default (>= 2) bounds concurrency."""
    pipeline = load_module("run_deploy_pipeline_cap_under_test", DRIVER)
    cap = pipeline.default_max_parallel(pipeline.host_resources())
    state = tmp / "cap"
    plan = tmp / "cap-plan.json"
    count = cap + 2
    write_plan(plan, [{"name": f"lane-{i}", "command": ["sleep", "1"], "reuse_passed": False, "memory_mb": 1}
                      for i in range(count)])
    assert run_driver("run", "--plan", str(plan), "--state-dir", str(state), "--memory-budget-mb", "1048576",
                      env=env).returncode == 0
    lanes = json.loads((state / "receipt.json").read_text())["lanes"]
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
        [sys.executable, str(DRIVER), "run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED], env=env,
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
                 "deploy_stage_wait.py", "factory_detail.py", "factory_metadata.py"):
        shutil.copyfile(ROOT / "scripts" / name, scripts / name)
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
    log = tmp / "terminations.jsonl"
    state = tmp / "watchdog"
    plan = tmp / "watchdog-plan.json"
    write_plan(plan, [{"name": "lane", "command": ["sleep", "2"], "reuse_passed": False, "memory_mb": 1}])
    before = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 120))
    log.write_text(json.dumps({"at": before, "signal": "TERM", "pid": 1, "comm": "old"}) + "\n")
    supervisor = subprocess.Popen(
        [sys.executable, str(DRIVER), "run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED],
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
         patch.dict(os.environ, env):
        result = pipeline.run(plan, state, max_parallel=2)
    receipt = json.loads((state / "receipt.json").read_text())
    assert result == 1 and not victim.exists(), "live MemAvailable fell but the next lane was still launched"
    assert "headroom" in receipt["lanes"]["victim"]["note"], receipt
    samples = receipt["host_samples"]
    assert any(sample["mem_available_mb"] == 2300 for sample in samples), samples
    child = receipt["lanes"]["pressure"]
    assert child["peak_rss_mb"] > 0 and child["rusage_source"] == "wait4", child
    print("live headroom refusal + per-lane child rusage: ok")


def check_materialized_reservation_credit(tmp: Path, env: dict[str, str]) -> None:
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
    fit, so joiner must start while holder is still running."""
    pipeline = load_module("pipeline_materialized_credit", DRIVER)
    marker = tmp / "holder-allocated"
    plan = tmp / "credit-plan.json"
    holder_command = [sys.executable, "-c",
                      "import pathlib, time; block = b'x' * (60 * 1024 * 1024); "
                      f"pathlib.Path({str(marker)!r}).touch(); time.sleep(4); del block"]

    def write(joined: Path, unphased: Path) -> None:
        write_plan(plan, [
            {"name": "gate", "command": ["sleep", "0.3"], "reuse_passed": False, "group": "3", "memory_mb": 1},
            {"name": "holder", "command": holder_command, "reuse_passed": False, "group": "3", "memory_mb": 100},
            {"name": "joiner", "command": ["touch", str(joined)], "after": ["gate"], "reuse_passed": False,
             "group": "3", "memory_mb": 60},
            {"name": "unphased", "command": ["touch", str(unphased)], "after": ["gate"], "reuse_passed": False,
             "group": "4", "memory_mb": 60},
        ], schedule={"policy": "legacy"})

    def host() -> dict:
        # No MemTotal/watchdog: headroom is MemAvailable less the 2 GiB reserve.
        return {"cpus": 8, "mem_available_mb": pipeline.MEMORY_RESERVE_MB + (120 if marker.exists() else 300)}

    def run(state: Path, **patches) -> dict:
        if marker.exists():
            marker.unlink()
        with ExitStack() as stack:
            stack.enter_context(patch.object(pipeline, "host_resources", side_effect=host))
            stack.enter_context(patch.object(pipeline, "SOURCE_ROOT", Path(env["DEPLOY_PIPELINE_SOURCE_ROOT"])))
            stack.enter_context(patch.dict(os.environ, env))
            for name, value in patches.items():
                stack.enter_context(patch.object(pipeline, name, value))
            result = pipeline.run(plan, state, max_parallel=0)
        receipt = json.loads((state / "receipt.json").read_text())
        assert result == 0 and receipt["status"] == "passed", (result, receipt["status"], receipt["lanes"])
        assert receipt["memory_budget_mb"] == 300, receipt["memory_budget_mb"]
        return receipt

    if sys.platform == "linux":
        write(tmp / "credit-joined", tmp / "credit-unphased")
        lanes = run(tmp / "credit")["lanes"]
        holder, joiner, unphased = lanes["holder"], lanes["joiner"], lanes["unphased"]
        assert joiner["started_epoch"] < holder["finished_epoch"], \
            "joiner fits beside holder's unmaterialized reservation and must not wait for it"
        assert holder["tree_peak_rss_mb"] >= 50, holder
        admission = joiner["admission"]
        assert admission["decision"] == "admitted" and admission["accounting"] == "unmaterialized", admission
        assert admission["headroom_mb"] == 120 and admission["budget_mb"] == 300 and admission["memory_mb"] == 60
        assert admission["reserved_declared_mb"] == 100 and admission["reserved_live_mb"] < 60, admission
        assert admission["running"]["holder"]["memory_mb"] == 100 and admission["running"]["holder"]["tree_rss_mb"] >= 50
        assert admission["running"]["holder"]["observation"] == "fresh", admission["running"]
        assert 0 <= admission["running"]["holder"]["observed_age_s"] <= pipeline.OBSERVATION_MAX_AGE_SECONDS
        assert holder["tree_rss_at"] and holder["tree_rss_mono"] is not None, holder
        assert admission["deferred"]["first"]["reason"] == "headroom", admission["deferred"]
        assert admission["deferred"]["first"]["running"]["holder"]["observation"] == "unknown", admission["deferred"]
        assert admission["deferred"]["checks"] >= 1 and admission["deferred"]["reason"] == "headroom", admission
        assert admission["deferred"]["last"]["reserved_live_mb"] + 60 > 120, admission["deferred"]
        assert unphased["started_epoch"] >= holder["finished_epoch"], \
            "an unphased lane keeps the declared accounting beside a running stack"
        assert unphased["admission"]["accounting"] == "declared", unphased["admission"]
        assert "waiting" not in joiner and "waiting" not in unphased, "deferral history moves under admission"
    else:
        print("materialized reservation credit: process-tree sampling is Linux-only; conservative path only")
    # Unobserved usage (macOS, unreadable /proc) keeps the whole declaration: joiner waits.
    write(tmp / "unobserved-joined", tmp / "unobserved-unphased")
    lanes = run(tmp / "unobserved", sample_lane_tree_rss=lambda pids: {})["lanes"]
    assert lanes["joiner"]["started_epoch"] >= lanes["holder"]["finished_epoch"], lanes["joiner"]
    assert lanes["joiner"]["admission"]["running"] == {} and lanes["holder"]["tree_rss_mb"] is None, lanes
    assert "tree_peak_rss_mb" not in lanes["holder"], lanes["holder"]
    last = lanes["joiner"]["admission"]["deferred"]["last"]["running"]["holder"]
    assert last["tree_rss_mb"] is None and last["observation"] == "unknown", last
    assert pipeline.unmaterialized_mb(100, None) == 100 and pipeline.unmaterialized_mb(100, 70.4) == 30
    assert pipeline.unmaterialized_mb(100, 250.0) == 0
    print("materialized reservation credit: ok")


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
    # (first pass, ~1 s) and never again; the joiner becomes eligible only at
    # ~2.5 s, by which time the failed passes must have made the holder unknown.
    marker = tmp / "validity-holder-allocated"
    plan = tmp / "validity-plan.json"
    state = tmp / "validity"
    write_plan(plan, [
        {"name": "gate", "command": ["sleep", "2.5"], "reuse_passed": False, "group": "3", "memory_mb": 1},
        {"name": "holder", "command": [sys.executable, "-c",
                                       f"import pathlib, time; pathlib.Path({str(marker)!r}).touch(); time.sleep(5)"],
         "reuse_passed": False, "group": "3", "memory_mb": 100},
        {"name": "joiner", "command": ["true"], "after": ["gate"], "reuse_passed": False, "group": "3",
         "memory_mb": 60},
    ], schedule={"policy": "legacy"})
    calls: list[set[int]] = []

    def flaky_sampler(pids: set[int]) -> dict[int, float | None]:
        calls.append(set(pids))
        return {pid: 80.0 for pid in pids} if len(calls) == 1 else {}

    def host() -> dict:
        return {"cpus": 8, "mem_available_mb": pipeline.MEMORY_RESERVE_MB + (120 if marker.exists() else 300)}

    with patch.object(pipeline, "host_resources", side_effect=host), \
         patch.object(pipeline, "sample_lane_tree_rss", side_effect=flaky_sampler), \
         patch.object(pipeline, "SOURCE_ROOT", Path(env["DEPLOY_PIPELINE_SOURCE_ROOT"])), \
         patch.dict(os.environ, env):
        result = pipeline.run(plan, state, max_parallel=0)
    receipt = json.loads((state / "receipt.json").read_text())
    assert result == 0 and receipt["status"] == "passed", (result, receipt["lanes"])
    holder, joiner = receipt["lanes"]["holder"], receipt["lanes"]["joiner"]
    assert len(calls) >= 3, f"the sampler must have failed after its first pass: {len(calls)} passes"
    assert joiner["started_epoch"] >= holder["finished_epoch"], \
        "a stale 80 MB observation stayed credited after sampling failed"
    assert holder["tree_peak_rss_mb"] == 80.0 and holder["tree_rss_mb"] is None, holder
    last = joiner["admission"]["deferred"]["last"]["running"]["holder"]
    assert last == {"memory_mb": 100, "tree_rss_mb": None, "observed_age_s": last["observed_age_s"],
                    "observation": "unknown"} and last["observed_age_s"] is not None, last
    # (1) PSS unreadable for one live process: the tree is unknown, never summed RSS.
    proc = tmp / "fake-proc"
    for pid, ppid in ((100, 1), (101, 100), (102, 101), (200, 1)):
        (proc / str(pid)).mkdir(parents=True)
        fields = ["S", str(ppid), str(pid), str(pid)] + ["0"] * 17 + ["1000", "25000"]  # ... vsize, rss pages
        (proc / str(pid) / "stat").write_text(f"{pid} (fake) {' '.join(fields)}\n")
    (proc / "not-a-pid").mkdir()
    for pid in (100, 101):
        (proc / str(pid) / "smaps_rollup").write_text("Rss: 4096 kB\nPss: 2048 kB\nPss_Anon: 1024 kB\n")
    assert pipeline.sample_lane_tree_rss({100, 200}, proc) == {100: None, 200: None}, "102 and 200 lack PSS"
    (proc / "102" / "smaps_rollup").write_text("Rss: 4096 kB\nPss: 1024 kB\n")
    assert pipeline.sample_lane_tree_rss({100}, proc) == {100: 5.0}, "PSS of 100 + 101 + 102 = 2 + 2 + 1 MB"
    shutil.rmtree(proc / "102")  # exited since the listing: gone, not unknown
    listing = os.listdir(proc)
    with patch.object(pipeline.os, "listdir", return_value=listing + ["102"]):
        assert pipeline.sample_lane_tree_rss({100}, proc) == {100: 4.0}
    (proc / "101" / "smaps_rollup").write_text("Rss: 4096 kB\n")  # no Pss line
    assert pipeline.sample_lane_tree_rss({100}, proc) == {100: None}
    assert pipeline.sample_lane_tree_rss({100}, tmp / "no-such-proc") == {100: None}
    assert pipeline.sample_lane_tree_rss(set(), proc) == {}
    # A delayed scan: the observation is as old as the scan's START. The first
    # pass takes 3.5 s (over the 3 s limit) and reports 80 MB when it returns;
    # the gate exits during that scan, so the joiner's first check runs right
    # after it and must see the holder stale (not fresh because the scan "just
    # finished"), then unknown as later passes fail; it waits for the holder.
    slow_marker = tmp / "slow-holder-allocated"
    slow_plan = tmp / "slow-scan-plan.json"
    slow_state = tmp / "slow-scan"
    write_plan(slow_plan, [
        {"name": "gate", "command": ["sleep", "4.0"], "reuse_passed": False, "group": "3", "memory_mb": 1},
        {"name": "holder", "command": [sys.executable, "-c",
                                       f"import pathlib, time; pathlib.Path({str(slow_marker)!r}).touch(); "
                                       "time.sleep(6.5)"],
         "reuse_passed": False, "group": "3", "memory_mb": 100},
        {"name": "joiner", "command": ["true"], "after": ["gate"], "reuse_passed": False, "group": "3",
         "memory_mb": 60},
    ], schedule={"policy": "legacy"})
    slow_calls: list[float] = []

    def slow_sampler(pids: set[int]) -> dict[int, float | None]:
        slow_calls.append(time.monotonic())
        if len(slow_calls) == 1:
            time.sleep(pipeline.OBSERVATION_MAX_AGE_SECONDS + 0.5)
            return {pid: 80.0 for pid in pids}
        return {}

    def slow_host() -> dict:
        return {"cpus": 8, "mem_available_mb": pipeline.MEMORY_RESERVE_MB + (120 if slow_marker.exists() else 300)}

    with patch.object(pipeline, "host_resources", side_effect=slow_host), \
         patch.object(pipeline, "sample_lane_tree_rss", side_effect=slow_sampler), \
         patch.object(pipeline, "SOURCE_ROOT", Path(env["DEPLOY_PIPELINE_SOURCE_ROOT"])), \
         patch.dict(os.environ, env):
        result = pipeline.run(slow_plan, slow_state, max_parallel=0)
    receipt = json.loads((slow_state / "receipt.json").read_text())
    assert result == 0 and receipt["status"] == "passed", (result, receipt["lanes"])
    holder, joiner = receipt["lanes"]["holder"], receipt["lanes"]["joiner"]
    assert joiner["started_epoch"] >= holder["finished_epoch"], \
        "an observation from a scan older than the limit was credited because the scan had just returned"
    first = joiner["admission"]["deferred"]["first"]["running"]["holder"]
    assert first["observation"] == "stale" and first["tree_rss_mb"] == 80.0, first
    assert first["observed_age_s"] >= pipeline.OBSERVATION_MAX_AGE_SECONDS, first
    assert joiner["admission"]["deferred"]["last"]["running"]["holder"]["observation"] == "unknown", joiner
    assert holder["tree_peak_rss_mb"] == 80.0 and holder["tree_rss_at"], holder
    # Fresh, stale (too old, from the future, unstamped) and unknown observations
    # on the monotonic clock.
    now = 1_000.0
    fresh, detail = pipeline.fresh_tree_rss_mb({"tree_rss_mb": 80.0, "tree_rss_mono": now - 1.0}, now)
    assert fresh == 80.0 and detail == {"tree_rss_mb": 80.0, "observed_age_s": 1.0, "observation": "fresh"}, detail
    stale, detail = pipeline.fresh_tree_rss_mb(
        {"tree_rss_mb": 80.0, "tree_rss_mono": now - pipeline.OBSERVATION_MAX_AGE_SECONDS - 0.1}, now)
    assert stale is None and detail["observation"] == "stale" and detail["tree_rss_mb"] == 80.0, detail
    future, detail = pipeline.fresh_tree_rss_mb({"tree_rss_mb": 80.0, "tree_rss_mono": now + 5.0}, now)
    assert future is None and detail == {"tree_rss_mb": 80.0, "observed_age_s": -5.0, "observation": "stale"}, detail
    assert pipeline.fresh_tree_rss_mb({"tree_rss_mb": 80.0}, now) == (None, {
        "tree_rss_mb": 80.0, "observed_age_s": None, "observation": "stale"})
    assert pipeline.fresh_tree_rss_mb({"tree_rss_mb": None, "tree_rss_mono": now}, now)[1]["observation"] == "unknown"
    assert pipeline.fresh_tree_rss_mb({}, now) == (None, {"tree_rss_mb": None, "observed_age_s": None,
                                                        "observation": "unknown"})
    assert pipeline.fresh_tree_rss_mb({"tree_rss_mb": 80.0, "tree_rss_mono": time.monotonic()})[0] == 80.0, \
        "the default clock is monotonic, not wall time"
    print("observation validity: ok")


def check_stack_owner_dependency(tmp: Path, env: dict[str, str]) -> None:
    """semantic-stack's ``run.sh --benchmark`` startup runs kill-services.sh
    against every runtime process this worktree owns, so it must never start
    while the local smoke lane or the AgentCard lifecycle lane (their own
    local stacks) is running. On #1640 only memory kept them apart (4096 +
    4096 MB against an 8188 MB budget). The plan loader now appends the edge
    (declared edges kept, receipt ``after`` shows it); with unbounded memory
    only the dependency can hold semantic-stack back. Plans without a
    stack-owning lane and lanes with other names are untouched, and a plan
    that would close a cycle through the implied edge is refused."""
    pipeline = load_module("pipeline_stack_owner", DRIVER)
    plan = tmp / "stack-owner-plan.json"
    state = tmp / "stack-owner"
    marker = tmp / "semantic-started"
    write_plan(plan, [
        {"name": "cov", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "3"},
        {"name": "smoke", "command": ["sleep", "1.5"], "reuse_passed": False, "group": "4", "phase": "coverage"},
        {"name": "agentcard-lifecycle", "command": ["sleep", "1.0"], "reuse_passed": False, "group": "4",
         "phase": "coverage"},
        {"name": "semantic-stack", "command": ["touch", str(marker)], "after": ["cov"], "reuse_passed": False,
         "group": "4"},
    ], schedule={"policy": "legacy"})
    ran = run_driver("run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, env=env, timeout=120)
    receipt = json.loads((state / "receipt.json").read_text())
    assert ran.returncode == 0 and receipt["status"] == "passed", (ran.returncode, ran.stderr, receipt["status"])
    lanes = receipt["lanes"]
    assert lanes["semantic-stack"]["started_epoch"] >= max(lanes["smoke"]["finished_epoch"],
                                                            lanes["agentcard-lifecycle"]["finished_epoch"]), \
        "semantic-stack started while a lane owning a worktree stack was still running"
    assert receipt["after"]["semantic-stack"] == ["cov", "smoke", "agentcard-lifecycle"], receipt["after"]
    assert receipt["after"]["smoke"] == [] and receipt["after"]["agentcard-lifecycle"] == [], receipt["after"]
    assert lanes["smoke"]["started_epoch"] < lanes["cov"]["finished_epoch"], "owners are not held back"
    # No stack-owning lane in the plan: nothing is added; other names are untouched.
    write_plan(plan, [
        {"name": "cov", "command": ["true"], "group": "3"},
        {"name": "semantic-stack", "command": ["true"], "after": ["cov"], "group": "4"},
        {"name": "semantic", "command": ["true"], "group": "4"},
        {"name": "smoke-like", "command": ["true"], "group": "4", "phase": "coverage"},
    ])
    loaded = {lane.name: lane for lane in pipeline.load_plan_payload(plan)[0]}
    assert loaded["semantic-stack"].after == ["cov"] and loaded["semantic"].after == [], loaded
    # An implied edge never duplicates a declared one, and a plan that makes an
    # owner wait for the killer is a cycle, refused before any lane starts.
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
        raise AssertionError("an owner that waits for semantic-stack must be refused as a cycle")
    print("stack owner dependency: ok")


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
    floor = pipeline.STRUCTURAL_WORKER_MEMORY_MB
    lane = pipeline.Lane("deploy-command-structural", ["python3", "x.py", "--max-workers", "3"],
                         memory_mb=1024 + floor * 3, exclusive=True)
    fitted = pipeline.fit_exclusive_lane(lane, 1024 + floor * 2 + 50)
    assert fitted.command[-2:] == ["--max-workers", "2"] and fitted.memory_mb == 1024 + floor * 2, fitted
    assert pipeline.fit_exclusive_lane(lane, 1024 + floor * 9).command[-1] == "3", "never wider than planned"
    assert pipeline.fit_exclusive_lane(lane, 1024 + floor - 1) is None, "below one worker stays a refusal"
    assert pipeline.fit_exclusive_lane(pipeline.Lane("other", ["true"], exclusive=False), 10**6) is None
    assert pipeline.fit_exclusive_lane(pipeline.Lane("no-flag", ["true"], exclusive=True), 10**6) is None
    state = tmp / "resize"
    plan = tmp / "resize-plan.json"
    probe = tmp / "resize-args.txt"
    write_plan(plan, [{"name": "structural", "exclusive": True, "reuse_passed": False,
                       "memory_mb": 1024 + floor * 3,
                       "command": ["bash", "-c", f"printf '%s\\n' \"$@\" > {probe}", "_", "--max-workers", "3"]}])
    run = run_driver("run", "--plan", str(plan), "--state-dir", str(state), "--max-parallel", "0",
                     "--memory-budget-mb", str(1024 + floor * 2 + 50), env=env)
    assert run.returncode == 0, run.stdout + run.stderr
    receipt = json.loads((state / "receipt.json").read_text())["lanes"]["structural"]
    args = probe.read_text().split()
    workers = int(args[args.index("--max-workers") + 1])
    assert receipt["status"] == "passed" and 1 <= workers <= 2, (receipt, args)
    assert receipt["note"].startswith(f"resized: 3 -> {workers} workers") and "PIPELINE_LANE_RESIZED" in run.stdout, \
        (receipt, run.stdout)
    assert receipt["memory_mb"] == 1024 + floor * workers, receipt
    run = run_driver("run", "--plan", str(plan), "--state-dir", str(state), "--max-parallel", "0",
                     "--memory-budget-mb", "1000", env=env)
    receipt = json.loads((state / "receipt.json").read_text())["lanes"]["structural"]
    assert run.returncode == 1 and receipt["status"] == "failed" and receipt["note"].startswith("refused: needs"), receipt
    print("exclusive lane resize: ok")


def main() -> int:
    global DRIVER
    with tempfile.TemporaryDirectory(prefix="deploy-pipeline-test-") as raw:
        tmp = Path(raw)
        source_root = make_source_root(tmp / "source")
        DRIVER = source_root / "scripts" / "run_deploy_pipeline.py"
        env = {**os.environ, "DEPLOY_RUN_ROOT": str(tmp / "runs"),
               "DEPLOY_PIPELINE_SOURCE_ROOT": str(source_root)}
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
            [sys.executable, str(DRIVER), "run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED],
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
        check_observation_validity(tmp, env)
        check_stack_owner_dependency(tmp, env)
        check_plan_scaling()
        check_structural_memory_floor()
        check_macos_memory(tmp, env)
        check_memory_admission(tmp, env)
        check_max_parallel_default(tmp, env)
        check_wait_since_and_no_row_failures(tmp, env)
        check_watchdog_receipts(tmp, env)
        check_follow_source(tmp, env)
        check_fix_loop_cap(tmp, env)
        check_interrupted_rounds_and_dead_supervisor_deferral()
        check_wait_follows_supersede_behind_stage_failure(tmp)
        check_exclusive_lane_resizes_to_free_memory(tmp, env)
        check_standard_plan_typescript()
        check_schedule_phases(tmp, env)
        check_stage_receipt_seed(tmp, env)
        check_passed_only_estimates_and_dag_phases(tmp, env)
        check_declared_phase_lanes(tmp, env)
        check_dependencies_through_unphased_lanes(tmp, env)
        check_simulate_legacy_plan_group3(tmp, env)
        check_production_fly_wait(tmp, env)
    print("run-deploy-pipeline: all checks passed")
    return 0


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
    for name in ("run_deploy_pipeline.py", "deploy_stage_wait.py", "classify-agent-runtime-changes.sh"):
        shutil.copyfile(ROOT / "scripts" / name, scripts / name)
    (repo / ".gitignore").write_text(".context/\n__pycache__/\n")
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

    commit("base", {"README": "base\n"})
    tests_only = commit("agents tests + backend", {"agents/tests/new_case.py": "x\n", "back-end/src/x.ts": "y\n"})
    runtime = commit("agents runtime", {"agents/worker_patch.py": "z\n"})
    fake = tmp / "production-fake"
    fake.mkdir()
    bin_dir = fake / "bin"
    bin_dir.mkdir()
    (bin_dir / "gh").write_text(
        "#!/usr/bin/env bash\n"
        'echo "$*" >> "$FAKE_GH_DIR/calls.log"\n'
        'case "$1 $2" in\n'
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
        '  *worker-deployment-queue.ts*) cat "$FAKE_GH_DIR/job.json" ;;\n'
        '  *monitor-cooperative-cutover.ts*) exit "${FAKE_MONITOR_EXIT:-0}" ;;\n'
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
        for stale in (calls, fake / "node-calls.log"):
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

    def run_production(merged: str, state: Path, *extra: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(driver), "production", "--merged-sha", merged, "--state-dir", str(state),
             "--poll-seconds", "0.05", "--expected-hash", "feedface", *extra,
             "--", "bash", "-c", f'echo dispatch >> "{calls}"'],
            env=prod_env, cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120)

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
                                        "workflow_changed": False}, receipt["agent_cutover"]
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
    assert receipt["fly"] == {"required": False, "reason": "no agent runtime or deploy-agents.yml change in the merge"}
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
    print("production fly wait: ok")


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
        [sys.executable, str(DRIVER), "run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED,
         "--follow-source", "--settle-seconds", "0.5", "--poll-seconds", "0.2", "--fix-loop-cap", "0"],
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
            [sys.executable, str(DRIVER), "run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED, *extra],
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
            [sys.executable, str(DRIVER), "run", "--plan", str(plan), "--state-dir", str(state), *UNBOUNDED],
            env={**env, "DEPLOY_FIX_LOOP_CAP": "3"}, stdout=subprocess.PIPE, text=True, check=False,
        )
        assert result.returncode == 1, "DEPLOY_FIX_LOOP_CAP=3 admits three rounds"
    return json.loads((state / "receipt.json").read_text())["fix_loop"]["cap"] == 3


def check_standard_plan_typescript() -> None:
    """The typescript lane is an incremental check with a per-worktree buildinfo
    under .context, and deploy.md Step 3 runs the identical command."""
    standard = json.loads(subprocess.run(
        [sys.executable, str(DRIVER), "plan", "--group", "3"], stdout=subprocess.PIPE, text=True, check=True,
    ).stdout)
    typescript = next(lane for lane in standard["lanes"] if lane["name"] == "typescript")
    command = " ".join(typescript["command"])
    assert "tsc --noEmit --incremental --tsBuildInfoFile ../.context/tsbuildinfo/back-end.tsbuildinfo" in command, command
    assert typescript["cwd"] == "back-end", typescript
    deploy_md = (ROOT / ".claude" / "commands" / "deploy.md").read_text()
    assert typescript["command"][-1] in deploy_md, "deploy.md Step 3 must run the same incremental tsc command"
    assert "run_deploy_pipeline.py verify --state-dir" in deploy_md, "Phase 3 must bind the receipt to HEAD"
    assert "--follow-source" in deploy_md and "FIX_LOOP_CAP" in deploy_md


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
    # Budget 100: smoke (50) beside big (80) cannot fit; cov (30) beside smoke can.
    write_plan(plan, [
        {"name": "quick", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "3", "memory_mb": 10},
        {"name": "big", "command": ["sleep", "0.4"], "reuse_passed": False, "group": "3", "exclusive": True,
         "memory_mb": 80},
        {"name": "cov", "command": ["sleep", "0.3"], "reuse_passed": False, "group": "3", "memory_mb": 30},
        {"name": "smoke", "command": ["sleep", "1.2"], "reuse_passed": False, "group": "4", "memory_mb": 50,
         "phase": "coverage"},
        {"name": "probe", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "3", "memory_mb": 10,
         "after": ["big", "cov"]},
        {"name": "semantic", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "4", "memory_mb": 10,
         "after": ["big", "cov", "probe"]},
        {"name": "g4-free", "command": ["sleep", "0.2"], "reuse_passed": False, "group": "4", "memory_mb": 10},
    ], schedule={"policy": "phased"})
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

    # The standard plan declares the phase for the local smoke lane and the
    # AgentCard lifecycle lane; the cloud smoke lane stays unphased.
    local = {lane["name"]: lane for lane in plan_json("--group", "4", "--smoke", "local", "--agentcard")["lanes"]}
    assert local["smoke"]["phase"] == "coverage" and local["smoke"]["memory_mb"] == 4096, local["smoke"]
    assert local["agentcard-lifecycle"]["phase"] == "coverage", local["agentcard-lifecycle"]
    cloud = {lane["name"]: lane for lane in plan_json("--group", "4", "--smoke", "cloud")["lanes"]}
    assert not cloud["smoke"].get("phase"), cloud["smoke"]
    phased_plan = plan_json("--group", "all", "--backend", "--smoke", "local", "--schedule", "phased")
    coverage = [p for p in phased_plan["schedule"]["phases"] if p["phase"] == "coverage"]
    assert coverage and "smoke" in coverage[-1]["lanes"] and "backend-coverage-blackbox" in coverage[-1]["lanes"], \
        phased_plan["schedule"]["phases"]
    assert phased_plan["schedule"]["phases"][0]["phase"] == "quick" and "smoke" not in phased_plan["schedule"]["phases"][0]["lanes"]
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
