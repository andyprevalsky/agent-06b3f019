"""Offline checks for the replay_cli fixture: stub dispatch, delegation, refusal, controller and owner meta."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from pathlib import Path

import pytest

from benchmarks.claude_md_replay import fixtures
from benchmarks.claude_md_replay.manifest import load_manifest

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "skill_manifests" / "benchmark.json"
REAL_RUN_BENCH = """#!/usr/bin/env bash
if [ "$1" = report-format ]; then echo "REAL REPORT FORMAT"; exit 0; fi
if [ "$1" = list ]; then echo "real-catalog-task"; exit 0; fi
echo "real usage"; exit 0
"""
SCENARIO = {
    "scenario": "unit",
    "provenance": {"recorded": "secret notes"},
    "vars": {"RUN_DIR": "{REPO}/.context/fleet/runs/r1"},
    "controller": {"token": "a" * 32, "run_id": "r1", "start": "rule", "children": 1, "max_lifetime_seconds": 120,
                   "on_term_files": {"{RUN_DIR}/terminated": "yes\n"}},
    "rules": [
        {"id": "launch", "match": r"^task-a(\s|$)", "start_controller": True,
         "responses": [{"stdout": "launched pid={CONTROLLER_PID} owner={CONTROLLER_TOKEN}\n", "files": {"{RUN_DIR}/x.json": {"pid": "{CONTROLLER_PID}"}}},
                       {"stdout": "second\n", "exit_code": 3}]},
        {"id": "mon-alive", "match": r"^monitor\s", "when": {"controller": "alive"}, "responses": [{"stdout": "alive\n"}]},
        {"id": "mon-dead", "match": r"^monitor\s", "when": {"controller": "exited"}, "responses": [{"stdout": "terminal\n"}]},
        {"id": "card", "match": r"^scorecard\s+\S+\s+--html\s+(?P<HTML>\S+)", "responses": [{"stdout": "{HTML}\n", "files": {"{HTML}": "<html/>"}}]},
    ],
}


@pytest.fixture()
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "run"
    repo = root / "repo"
    (repo / "scripts").mkdir(parents=True)
    (root / "mocks").mkdir()
    (repo / "scripts" / "run-bench").write_text(REAL_RUN_BENCH)
    (repo / "scripts" / "run-bench").chmod(0o755)
    for name in ("run-bench-fleet", "run-bench-campaign.py"):
        (repo / "scripts" / name).write_text("#!/bin/sh\necho REAL\n")
    subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "base"], check=True)
    scenarios = tmp_path / "scenarios"
    scenarios.mkdir()
    (scenarios / "unit.json").write_text(json.dumps(SCENARIO))
    monkeypatch.setattr(fixtures, "SKILL_SCENARIOS", scenarios)
    yield repo
    info = root / "mocks" / "controller.json"
    if info.is_file():  # never leave a dummy controller behind
        pid = json.loads(info.read_text())["pid"]
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


def call(repo: Path, *argv: str, via: str = "direct") -> subprocess.CompletedProcess:
    cmd = {"direct": ["scripts/run-bench"], "bash": ["bash", "scripts/run-bench"], "python": ["python3", "scripts/run-bench"]}[via]
    return subprocess.run([*cmd, *argv], cwd=repo, capture_output=True, text=True, timeout=60)


def rows(repo: Path, name: str = "run-bench.jsonl") -> list[dict]:
    path = repo.parent / "mocks" / name
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.is_file() else []


def wait_for(predicate, seconds: float = 10.0) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.1)
    return predicate()


def test_install_hides_stub_and_strips_provenance(repo: Path) -> None:
    receipt = fixtures.apply_fixture("replay_cli:unit", repo)
    assert (repo / "scripts" / ".run-bench.real").read_text() == REAL_RUN_BENCH
    assert "scripts/run-bench" in receipt["skip_worktree"]
    status = subprocess.run(["git", "-C", str(repo), "status", "--porcelain"], capture_output=True, text=True).stdout
    assert status == ""
    installed = json.loads((repo / ".git" / "replay-cli" / "scenario.json").read_text())
    assert "provenance" not in installed and installed["rules"]


def test_rules_sequences_controller_meta_and_term(repo: Path) -> None:
    fixtures.apply_fixture("replay_cli:unit", repo)
    first = call(repo, "task-a", via="bash")
    info = json.loads((repo.parent / "mocks" / "controller.json").read_text())
    pid = info["pid"]
    assert first.returncode == 0 and first.stdout == f"launched pid={pid} owner={'a' * 32}\n"
    assert json.loads((repo / ".context/fleet/runs/r1/x.json").read_text()) == {"pid": str(pid)}
    meta = dict(line.split("=", 1) for line in (repo / ".git/cloudbench-fleet-ownership" / ("a" * 32) / "meta").read_text().splitlines())
    assert meta["pid"] == str(pid) and meta["pid_start"].startswith("proc-start:") and meta["version"] == "2"
    second = call(repo, "task-a")
    third = call(repo, "task-a", via="python")
    assert (second.stdout, second.returncode, third.stdout, third.returncode) == ("second\n", 3, "second\n", 3)
    assert call(repo, "monitor", "x").stdout == "alive\n"
    card = call(repo, "scorecard", "d", "--html", str(repo / "card.html"))
    assert card.stdout.strip() == str(repo / "card.html") and (repo / "card.html").read_text() == "<html/>"
    os.kill(pid, signal.SIGUSR1)
    os.kill(pid, signal.SIGTERM)
    assert wait_for(lambda: any(r.get("event") == "exit" and r["role"] == "controller" for r in rows(repo, "controller-signals.jsonl")))
    events = rows(repo, "controller-signals.jsonl")
    controller = [r for r in events if r["role"] == "controller"]
    assert [r.get("signal") for r in controller if r["event"] == "signal"] == ["SIGUSR1", "SIGTERM"]
    assert controller[-1]["reason"] == "term"
    assert (repo / ".context/fleet/runs/r1/terminated").read_text() == "yes\n"
    assert wait_for(lambda: call(repo, "monitor", "x").stdout == "terminal\n")
    log = rows(repo)
    assert [(r["rule"], r["response_index"]) for r in log[:3]] == [("launch", 0), ("launch", 1), ("launch", 2)]


def test_delegates_read_only_and_refuses_direct_controllers(repo: Path) -> None:
    fixtures.apply_fixture("replay_cli:unit", repo)
    assert call(repo, "report-format").stdout == "REAL REPORT FORMAT\n"
    assert call(repo, "list").stdout == "real-catalog-task\n"
    assert call(repo, "--help").stdout == "real usage\n"
    unknown = call(repo, "something-else")
    assert unknown.returncode == 2 and "refused" in unknown.stderr
    fleet = subprocess.run(["bash", "scripts/run-bench-fleet", "t"], cwd=repo, capture_output=True, text=True)
    campaign = subprocess.run(["python3", "scripts/run-bench-campaign.py", "--x"], cwd=repo, capture_output=True, text=True)
    assert fleet.returncode == 1 and campaign.returncode == 1
    log = rows(repo)
    assert [r.get("delegated") for r in log if r.get("phase") != "end"][:3] == [True, True, True]
    refused = [(r["tool"], r["argv"]) for r in log if r.get("refused")]
    assert refused == [("run-bench-fleet", ["t"]), ("run-bench-campaign.py", ["--x"])]
    assert any(r["rule"] is None and r["argv"] == ["something-else"] for r in log if "rule" in r and not r.get("delegated"))


def test_benchmark_manifest_fixtures_resolve() -> None:
    manifest = load_manifest(MANIFEST)
    assert len(manifest.tasks) == 10
    for task in manifest.tasks:
        assert task.kind == "temptation" and task.timeout_seconds == 1500 and 5 <= len(task.rubric) <= 8
        assert task.prompt.startswith("/benchmark")
        fixtures.resolve_fixture(task.fixture)
        scenario = json.loads(fixtures.scenario_path(task.fixture.split(":", 1)[1]).read_text())
        assert scenario["provenance"]["recorded"] and scenario["provenance"]["synthesized"]
