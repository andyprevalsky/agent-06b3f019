#!/usr/bin/env python3
"""Run /deploy Group 3 and Group 4 lanes concurrently on one frozen source.

Every lane still executes through ``scripts/run-deploy-stage`` so stage
records, logs, ``--reuse-passed`` receipts and factory timing stay unchanged.
This supervisor only schedules lanes and writes one atomic receipt:

* ``run``  starts every lane whose ``after`` dependencies have exited, with
  previously failed lanes (from the prior receipt in the same state dir)
  admitted first. Lanes keep running after a sibling fails so one iteration
  collects every failure. When all lanes finish it re-hashes the source and
  marks the receipt ``stale`` if anything changed after the freeze, so an
  older snapshot can never be reported green.
* ``wait`` blocks (local file watch, no agent turns) until the receipt shows
  the first failed lane, all lanes passed, or a stale source. Exit 0 = all
  green, 1 = a lane failed, 3 = stale source, 2 = usage/receipt error.

Plan file (JSON): {"lanes": [{"name", "command": [...], "cwd": "back-end",
"env": {...}, "after": ["lane"], "reuse_passed": true, "group": "3"}]}
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STAGE_WRAPPER = ROOT / "scripts" / "run-deploy-stage"
RECEIPT_SCHEMA = 1
TERMINAL_LANE = {"passed", "failed"}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def source_digest(root: Path = ROOT) -> dict[str, str]:
    """HEAD plus every tracked/untracked non-ignored byte of the worktree."""

    def git(*arguments: str) -> bytes:
        return subprocess.run(
            ("git", *arguments), cwd=root, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        ).stdout

    digest = hashlib.sha256()
    head = git("rev-parse", "HEAD").strip()
    digest.update(head + b"\0")
    digest.update(git("diff", "--no-ext-diff", "--binary", "HEAD", "--", ".", ":(exclude)agents/benchmarks/history") + b"\0")
    untracked = git("ls-files", "--others", "--exclude-standard", "-z")
    for raw in sorted(path for path in untracked.split(b"\0") if path):
        if raw.startswith(b"agents/benchmarks/history/"):
            continue  # append-only ledger data written by the smoke lane
        path = root / os.fsdecode(raw)
        digest.update(raw + b"\0")
        try:
            digest.update(os.readlink(path).encode() if path.is_symlink() else path.read_bytes())
        except OSError as error:
            digest.update(f"unreadable:{type(error).__name__}".encode())
        digest.update(b"\0")
    return {"head": head.decode(), "digest": digest.hexdigest()}


@dataclass
class Lane:
    name: str
    command: list[str]
    cwd: str = "."
    env: dict[str, str] = field(default_factory=dict)
    after: list[str] = field(default_factory=list)
    reuse_passed: bool = True
    group: str = ""


def load_plan(path: Path) -> list[Lane]:
    payload = json.loads(path.read_text())
    lanes = [Lane(**lane) for lane in payload["lanes"]]
    names = [lane.name for lane in lanes]
    if len(set(names)) != len(names):
        raise ValueError(f"duplicate lane names: {names}")
    for lane in lanes:
        if not lane.command:
            raise ValueError(f"{lane.name}: empty command")
        for dependency in lane.after:
            if dependency not in names or dependency == lane.name:
                raise ValueError(f"{lane.name}: invalid dependency {dependency}")
    return lanes


def failed_first(lanes: list[Lane], previous: dict | None) -> list[Lane]:
    """Stable order with the prior receipt's failed lanes admitted first."""

    failed = set()
    if previous:
        failed = {name for name, lane in previous.get("lanes", {}).items() if lane.get("status") == "failed"}
    return sorted(lanes, key=lambda lane: 0 if lane.name in failed else 1)


def write_receipt(path: Path, receipt: dict) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def overall(lanes: dict[str, dict]) -> str:
    statuses = [lane["status"] for lane in lanes.values()]
    if any(status == "failed" for status in statuses):
        return "failed" if all(s in TERMINAL_LANE for s in statuses) else "failing"
    if all(status == "passed" for status in statuses):
        return "passed"
    return "running"


def run(plan: Path, state_dir: Path, max_parallel: int) -> int:
    lanes = load_plan(plan)
    state_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = state_dir / "receipt.json"
    previous = None
    if receipt_path.exists():
        try:
            previous = json.loads(receipt_path.read_text())
        except json.JSONDecodeError:
            previous = None
        if previous:
            history = state_dir / "history.jsonl"
            with history.open("a") as handle:
                handle.write(json.dumps(previous, sort_keys=True) + "\n")
    order = failed_first(lanes, previous)
    frozen = source_digest()
    receipt: dict = {
        "schema_version": RECEIPT_SCHEMA,
        "plan": str(plan),
        "supervisor_pid": os.getpid(),
        "started_at": _now(),
        "started_epoch": time.time(),
        "source": frozen,
        "order": [lane.name for lane in order],
        "lanes": {lane.name: {"status": "pending", "group": lane.group} for lane in order},
        "status": "running",
    }
    write_receipt(receipt_path, receipt)
    log_dir = state_dir / "logs"
    log_dir.mkdir(exist_ok=True)

    processes: dict[str, subprocess.Popen[bytes]] = {}
    stopping = 0

    def terminate(signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = signum
        for process in processes.values():
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass

    for forwarded in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(forwarded, terminate)

    pending = list(order)
    while True:
        if not stopping:
            running = sum(1 for p in processes.values() if p.poll() is None)
            for lane in list(pending):
                if max_parallel and running >= max_parallel:
                    break
                if any(receipt["lanes"][d]["status"] not in TERMINAL_LANE for d in lane.after):
                    continue
                pending.remove(lane)
                argv = ["bash", str(STAGE_WRAPPER), lane.name]
                if lane.reuse_passed:
                    argv.append("--reuse-passed")
                argv += ["--", *lane.command]
                log_path = log_dir / f"{lane.name}.log"
                with log_path.open("ab") as log_handle:
                    processes[lane.name] = subprocess.Popen(
                        argv,
                        cwd=ROOT / lane.cwd,
                        env={**os.environ, **lane.env},
                        stdout=log_handle,
                        stderr=subprocess.STDOUT,
                        stdin=subprocess.DEVNULL,
                        start_new_session=True,
                    )
                receipt["lanes"][lane.name].update(
                    status="running", started_epoch=time.time(), log=str(log_path)
                )
                running += 1
            write_receipt(receipt_path, receipt)
        elif pending:
            for lane in pending:
                receipt["lanes"][lane.name].update(status="failed", exit=128 + stopping, note="not started")
            pending = []
        changed = False
        for name, process in processes.items():
            lane_state = receipt["lanes"][name]
            if lane_state["status"] == "running" and process.poll() is not None:
                lane_state.update(
                    status="passed" if process.returncode == 0 else "failed",
                    exit=process.returncode,
                    finished_epoch=time.time(),
                    wall_s=round(time.time() - lane_state["started_epoch"], 1),
                )
                changed = True
        if changed:
            receipt["status"] = overall(receipt["lanes"])
            write_receipt(receipt_path, receipt)
        if not pending and all(state["status"] in TERMINAL_LANE for state in receipt["lanes"].values()):
            break
        time.sleep(0.2)

    receipt["finished_at"] = _now()
    receipt["wall_s"] = round(time.time() - receipt["started_epoch"], 1)
    final_source = source_digest()
    receipt["final_source"] = final_source
    receipt["status"] = overall(receipt["lanes"])
    if final_source != frozen:
        receipt["status"] = "stale"
    write_receipt(receipt_path, receipt)
    return {"passed": 0, "failed": 1, "stale": 3}.get(receipt["status"], 1)


def wait(state_dir: Path, timeout: float) -> int:
    receipt_path = state_dir / "receipt.json"
    deadline = time.monotonic() + timeout if timeout else None
    while True:
        try:
            receipt = json.loads(receipt_path.read_text())
        except (OSError, json.JSONDecodeError):
            receipt = None
        if receipt:
            status = receipt.get("status")
            failed = [n for n, lane in receipt["lanes"].items() if lane.get("status") == "failed"]
            if status in {"failed", "failing"} or failed:
                for name in failed:
                    lane = receipt["lanes"][name]
                    print(f"FAILED {name} exit={lane.get('exit')} log={lane.get('log')}")
                running = [n for n, lane in receipt["lanes"].items() if lane.get("status") == "running"]
                print(f"PIPELINE_WAKE status=failed still_running={','.join(running) or '-'}")
                return 1
            if status == "passed":
                print(f"PIPELINE_WAKE status=passed wall_s={receipt.get('wall_s')} head={receipt['source']['head']}")
                return 0
            if status == "stale":
                print("PIPELINE_WAKE status=stale (source changed after freeze; rerun on the new source)")
                return 3
            pid = receipt.get("supervisor_pid")
            if pid and status == "running":
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    print(f"PIPELINE_WAKE status=supervisor-died pid={pid}")
                    return 2
        if deadline and time.monotonic() > deadline:
            print("PIPELINE_WAKE status=timeout")
            return 2
        time.sleep(0.5)


AGENTCARD_TASKS = (
    "agent-payment-test-shop",
    "agent-payment-setup-resume",
    "agent-payment-idempotent-abandonment",
    "agent-payment-abandonment",
)


def standard_plan(args: argparse.Namespace) -> dict:
    """Group 3 + Group 4 lanes exactly as deploy.md writes them."""

    lanes: list[dict] = []

    def lane(name: str, command: list[str], cwd: str = ".", group: str = "3", **extra: object) -> None:
        lanes.append({"name": name, "command": command, "cwd": cwd, "group": group, **extra})

    if args.group in {"3", "all"}:
        lane("eslint", ["bash", "-c", "xargs node scripts/lint-affected.mjs < ../.context/deploy-lint-ts.txt"],
             "back-end")
        lane("typescript", ["npx", "tsc", "--noEmit"], "back-end")
        lane("backend-structural", ["npm", "run", "test:structural"], "back-end")
        lane("deploy-command-structural", ["python3", "scripts/run-deploy-structural-gates.py"])
        lane("seed-cache-decision", ["bash", "scripts/tests/seed-cache-decision.test.sh"])
        lane("canonical-seed-whatsapp-content", ["bash", "scripts/tests/canonical-seed-whatsapp-content.test.sh"])
        if args.backend:
            lane("backend-coverage-blackbox", ["npm", "run", "test:coverage"], "back-end", env={
                "BLACKBOX_TEST_CONCURRENCY": str(args.backend_blackbox_workers),
                "CONTRACT_TEST_CONCURRENCY": str(args.backend_blackbox_workers),
                "BACKEND_UNIT_CONCURRENCY": str(args.backend_unit_workers),
            })
        if args.frontend:
            lane("frontend-coverage-blackbox",
                 ["npm", "run", "test:coverage", "--", f"--maxWorkers={args.frontend_workers}"], "front-end")
        if args.agents:
            lane("agents-coverage-blackbox", ["bash", "scripts/run-coverage.sh"], "agents",
                 env={"AGENTS_COVERAGE_CONCURRENCY": str(args.agents_workers)})
    if args.group in {"4", "all"}:
        if args.smoke == "cloud":
            lane("smoke", ["bash", "scripts/run-predeploy-cloud"], group="4")
        elif args.smoke == "local":
            lane("smoke", ["bash", "scripts/run-predeploy-local"], group="4")
        if args.agentcard:
            # Alongside smoke, never after it: its own isolated local stack.
            lane("agentcard-lifecycle",
                 ["bash", "scripts/run-bench", "--local", *AGENTCARD_TASKS, "--bootstrap",
                  "--max-concurrency", "1", "--no-dashboard"], group="4", env={
                     "BENCHMARK_SKIP_WMH_BUILD": "1",
                     "BENCHMARK_ATTEMPT_SUITE": "predeploy",
                     "BENCHMARK_COUNTS_FOR_DEPLOY_ELIGIBILITY": "0",
                     "BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL": "1",
                 }, reuse_passed=False)
    for entry in lanes:
        if entry["group"] == "4":
            entry.setdefault("reuse_passed", False)
    return {"lanes": lanes}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="action", required=True)
    run_parser = sub.add_parser("run")
    run_parser.add_argument("--plan", type=Path, required=True)
    run_parser.add_argument("--state-dir", type=Path, required=True)
    run_parser.add_argument("--max-parallel", type=int, default=0)
    wait_parser = sub.add_parser("wait")
    wait_parser.add_argument("--state-dir", type=Path, required=True)
    wait_parser.add_argument("--timeout", type=float, default=0)
    plan_parser = sub.add_parser("plan", help="print the standard Group 3/4 plan JSON")
    plan_parser.add_argument("--group", choices=("3", "4", "all"), default="all")
    plan_parser.add_argument("--backend", action="store_true")
    plan_parser.add_argument("--frontend", action="store_true")
    plan_parser.add_argument("--agents", action="store_true")
    plan_parser.add_argument("--smoke", choices=("cloud", "local", "skip"), default="cloud")
    plan_parser.add_argument("--agentcard", action="store_true")
    plan_parser.add_argument("--backend-blackbox-workers", type=int, default=4)
    plan_parser.add_argument("--backend-unit-workers", type=int, default=6)
    plan_parser.add_argument("--frontend-workers", type=int, default=4)
    plan_parser.add_argument("--agents-workers", type=int, default=6)
    args = parser.parse_args(argv)
    if args.action == "plan":
        print(json.dumps(standard_plan(args), indent=2))
        return 0
    if args.action == "run":
        return run(args.plan, args.state_dir, args.max_parallel)
    return wait(args.state_dir, args.timeout)


if __name__ == "__main__":
    sys.exit(main())
