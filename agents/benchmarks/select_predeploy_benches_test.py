#!/usr/bin/env python3
"""Tests for Pre-Deploy bench selection (floor + path + history streak + cap)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SELECTOR = ROOT / "agents" / "benchmarks" / "select_predeploy_benches.py"
CATALOG = ROOT / "agents" / "benchmarks" / "tasks.json"
ATTEMPTS = ROOT / "agents" / "benchmarks" / "history" / "task_attempts.jsonl"

sys.path.insert(0, str(ROOT / "agents"))
from benchmarks.select_predeploy_benches import (  # noqa: E402
    DEFAULT_CAP,
    DEFAULT_PASS_STREAK,
    FLOOR_CATEGORIES,
    KNOWN_DEPLOY_CATEGORIES,
    has_pass_streak,
    load_attempt_passes,
    select_predeploy_benches,
)


def _write_attempts(path: Path, rows: list[tuple[str, bool]]) -> None:
    lines = []
    for index, (task, passed) in enumerate(rows):
        lines.append(
            json.dumps(
                {
                    "task": task,
                    "passed": passed,
                    "status": "COMPLETED" if passed else "FAILED",
                    "duration_seconds": 1.0,
                    "cost_cents": 0.0,
                    "timestamp": f"2026-01-01T00:00:{index:02d}+00:00",
                    "agent_id": f"a{index}",
                    "failure_reason": None,
                    "fast_mode_cache": False,
                }
            )
        )
    path.write_text("\n".join(lines) + "\n")


def test_default_cap_and_pass_streak() -> None:
    assert DEFAULT_CAP == 20
    assert DEFAULT_PASS_STREAK == 3


def test_selected_tasks_all_have_last_three_historic_passes() -> None:
    selection = select_predeploy_benches(
        catalog=CATALOG,
        changed_files=["README.md"],
        surface="local",
        cap=20,
        repo_root=ROOT,
        attempts_file=ATTEMPTS,
        pass_streak=3,
    )
    passes = load_attempt_passes(ATTEMPTS)
    assert selection.selected
    for name in selection.selected:
        assert has_pass_streak(name, passes, streak=3), name
    assert selection.pass_streak_required == 3
    # Smoke tasks without a 3-pass streak must be reported as skipped.
    assert "test-mass-agent-run-0" in selection.skipped_history
    assert "browser-biometrics-webdecoy" in selection.skipped_history
    # Floor categories with no qualified canary are uncovered, not filled with flaky tasks.
    assert "sms" in selection.uncovered_categories
    assert "browser_stateful" in selection.uncovered_categories
    assert "payment" in selection.categories_covered
    assert "grep" in selection.categories_covered


def test_path_triggers_only_add_history_qualified_depth() -> None:
    selection = select_predeploy_benches(
        catalog=CATALOG,
        changed_files=[
            "agents/browser_tools/click.py",
            "back-end/src/domains/agentcard/service.ts",
            "agents/domains/sms/supervisor.py",
        ],
        surface="local",
        cap=20,
        repo_root=ROOT,
        attempts_file=ATTEMPTS,
    )
    passes = load_attempt_passes(ATTEMPTS)
    assert "browser" in selection.triggered_categories
    assert "payment" in selection.triggered_categories
    assert "sms" in selection.triggered_categories
    for name in selection.selected:
        assert has_pass_streak(name, passes, streak=3), name
    # SMS has no 3-pass canary, so path trigger must not invent one.
    assert "sms" not in selection.categories_covered or all(
        has_pass_streak(n, passes, streak=3) for n in selection.selected
    )


def test_history_gate_picks_next_canary_with_pass_streak(tmp_path: Path) -> None:
    catalog = tmp_path / "tasks.json"
    attempts = tmp_path / "attempts.jsonl"
    catalog.write_text(
        json.dumps(
            [
                {
                    "name": "harness-smoke",
                    "tags": ["smoke"],
                    "timeout_seconds": 60,
                    "deploy_category": "harness",
                },
                {
                    "name": "flaky-payment",
                    "tags": ["payment"],
                    "timeout_seconds": 100,
                    "deploy_category": "payment",
                    "deploy_canary": True,
                },
                {
                    "name": "stable-payment",
                    "tags": ["payment"],
                    "timeout_seconds": 200,
                    "deploy_category": "payment",
                },
                {
                    "name": "stable-grep",
                    "tags": ["grep"],
                    "timeout_seconds": 100,
                    "deploy_category": "grep",
                    "deploy_canary": True,
                },
                {
                    "name": "stable-sms",
                    "tags": ["sms"],
                    "timeout_seconds": 100,
                    "deploy_category": "sms",
                    "deploy_canary": True,
                },
                {
                    "name": "browser-toast-nopa-write-lock",
                    "tags": ["browser"],
                    "timeout_seconds": 100,
                    "deploy_category": "browser_stateful",
                    "deploy_canary": True,
                },
            ]
        )
    )
    _write_attempts(
        attempts,
        [
            ("harness-smoke", True),
            ("harness-smoke", True),
            ("harness-smoke", True),
            ("flaky-payment", True),
            ("flaky-payment", True),
            ("flaky-payment", False),
            ("stable-payment", True),
            ("stable-payment", True),
            ("stable-payment", True),
            ("stable-grep", True),
            ("stable-grep", True),
            ("stable-grep", True),
            ("stable-sms", True),
            ("stable-sms", True),
            ("stable-sms", True),
            ("browser-toast-nopa-write-lock", True),
            ("browser-toast-nopa-write-lock", True),
            ("browser-toast-nopa-write-lock", True),
        ],
    )
    selection = select_predeploy_benches(
        catalog=catalog,
        changed_files=[],
        surface="local",
        cap=20,
        repo_root=ROOT,
        attempts_file=attempts,
        pass_streak=3,
    )
    assert "harness-smoke" in selection.selected
    assert "stable-payment" in selection.selected
    assert "flaky-payment" not in selection.selected
    assert "flaky-payment" in selection.skipped_history
    assert "stable-grep" in selection.selected
    assert "stable-sms" in selection.selected
    assert "browser-toast-nopa-write-lock" in selection.selected


def test_task_with_fewer_than_three_attempts_is_skipped(tmp_path: Path) -> None:
    catalog = tmp_path / "tasks.json"
    attempts = tmp_path / "attempts.jsonl"
    catalog.write_text(
        json.dumps(
            [
                {
                    "name": "new-smoke",
                    "tags": ["smoke"],
                    "timeout_seconds": 60,
                    "deploy_category": "harness",
                }
            ]
        )
    )
    _write_attempts(attempts, [("new-smoke", True), ("new-smoke", True)])
    selection = select_predeploy_benches(
        catalog=catalog,
        changed_files=[],
        surface="local",
        cap=20,
        repo_root=ROOT,
        attempts_file=attempts,
    )
    assert selection.selected == []
    assert selection.skipped_history == ["new-smoke"]


def test_hard_cap_screams_when_history_qualified_extras_overflow(tmp_path: Path) -> None:
    catalog = tmp_path / "tasks.json"
    attempts = tmp_path / "attempts.jsonl"
    tasks = [
        {
            "name": f"smoke-{i}",
            "tags": ["smoke"],
            "timeout_seconds": 60,
            "deploy_category": "harness",
        }
        for i in range(4)
    ]
    tasks.extend(
        [
            {
                "name": "pay-a",
                "tags": ["payment"],
                "timeout_seconds": 60,
                "deploy_category": "payment",
                "deploy_canary": True,
            },
            {
                "name": "pay-b",
                "tags": ["payment"],
                "timeout_seconds": 70,
                "deploy_category": "payment",
            },
            {
                "name": "grep-a",
                "tags": ["grep"],
                "timeout_seconds": 60,
                "deploy_category": "grep",
                "deploy_canary": True,
            },
            {
                "name": "sms-a",
                "tags": ["sms"],
                "timeout_seconds": 60,
                "deploy_category": "sms",
                "deploy_canary": True,
            },
            {
                "name": "browser-toast-nopa-write-lock",
                "tags": ["browser"],
                "timeout_seconds": 60,
                "deploy_category": "browser_stateful",
                "deploy_canary": True,
            },
            {
                "name": "browser-extra",
                "tags": ["browser"],
                "timeout_seconds": 60,
                "deploy_category": "browser",
            },
        ]
    )
    catalog.write_text(json.dumps(tasks))
    rows: list[tuple[str, bool]] = []
    for task in tasks:
        rows.extend([(task["name"], True)] * 3)
    _write_attempts(attempts, rows)

    selection = select_predeploy_benches(
        catalog=catalog,
        changed_files=["agents/browser_tools/x.py", "back-end/src/domains/agentcard/x.ts"],
        surface="local",
        cap=8,
        repo_root=ROOT,
        attempts_file=attempts,
    )
    # Floor alone is 4 smoke + 4 canaries = 8; path extras must scream/drop.
    assert selection.total == 8
    assert selection.cap_hit
    assert selection.dropped


def test_floor_that_exceeds_cap_fails_closed(tmp_path: Path) -> None:
    catalog = tmp_path / "tasks.json"
    attempts = tmp_path / "attempts.jsonl"
    tasks = [
        {
            "name": f"smoke-{i}",
            "tags": ["smoke"],
            "timeout_seconds": 60,
            "deploy_category": "harness",
        }
        for i in range(5)
    ]
    catalog.write_text(json.dumps(tasks))
    rows: list[tuple[str, bool]] = []
    for task in tasks:
        rows.extend([(task["name"], True)] * 3)
    _write_attempts(attempts, rows)
    with pytest.raises(SystemExit, match="PREDEPLOY FLOOR|hard cap"):
        select_predeploy_benches(
            catalog=catalog,
            changed_files=["README.md"],
            surface="local",
            cap=3,
            repo_root=ROOT,
            attempts_file=attempts,
        )


def test_cloud_surface_skips_local_only_even_with_pass_streak(tmp_path: Path) -> None:
    catalog = tmp_path / "tasks.json"
    attempts = tmp_path / "attempts.jsonl"
    catalog.write_text(
        json.dumps(
            [
                {
                    "name": "local-payment",
                    "tags": ["payment", "local-only"],
                    "timeout_seconds": 60,
                    "deploy_category": "payment",
                    "deploy_canary": True,
                },
                {
                    "name": "cloud-payment",
                    "tags": ["payment"],
                    "timeout_seconds": 90,
                    "deploy_category": "payment",
                },
                {
                    "name": "smoke-ok",
                    "tags": ["smoke"],
                    "timeout_seconds": 60,
                    "deploy_category": "harness",
                },
                {
                    "name": "grep-ok",
                    "tags": ["grep"],
                    "timeout_seconds": 60,
                    "deploy_category": "grep",
                    "deploy_canary": True,
                },
                {
                    "name": "sms-ok",
                    "tags": ["sms"],
                    "timeout_seconds": 60,
                    "deploy_category": "sms",
                    "deploy_canary": True,
                },
                {
                    "name": "browser-toast-nopa-write-lock",
                    "tags": ["browser"],
                    "timeout_seconds": 60,
                    "deploy_category": "browser_stateful",
                    "deploy_canary": True,
                },
            ]
        )
    )
    rows = []
    for name in (
        "local-payment",
        "cloud-payment",
        "smoke-ok",
        "grep-ok",
        "sms-ok",
        "browser-toast-nopa-write-lock",
    ):
        rows.extend([(name, True)] * 3)
    _write_attempts(attempts, rows)
    cloud = select_predeploy_benches(
        catalog=catalog,
        changed_files=[],
        surface="cloud",
        cap=20,
        repo_root=ROOT,
        attempts_file=attempts,
    )
    assert "local-payment" not in cloud.selected
    assert "cloud-payment" in cloud.selected


def test_cli_report_prints_total_and_history_gate() -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(SELECTOR),
            "--catalog",
            str(CATALOG),
            "--attempts-file",
            str(ATTEMPTS),
            "--format",
            "names-and-report",
            "--changed-file",
            "README.md",
            "--repo-root",
            str(ROOT),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "TOTAL SELECTED:" in result.stdout
    assert "Hard cap: 20" in result.stdout
    assert "Pass streak required" in result.stdout
    assert "---PREDEPLOY_BENCH_NAMES---" in result.stdout
    assert result.stdout.index("TOTAL SELECTED:") < result.stdout.index(
        "---PREDEPLOY_BENCH_NAMES---"
    )


def test_known_deploy_categories_cover_floor() -> None:
    for category in FLOOR_CATEGORIES:
        assert category in KNOWN_DEPLOY_CATEGORIES


def test_cli_cap_scream_appears_on_stdout_and_stderr(tmp_path: Path) -> None:
    catalog = tmp_path / "tasks.json"
    attempts = tmp_path / "attempts.jsonl"
    tasks = [
        {
            "name": f"smoke-{i}",
            "tags": ["smoke"],
            "timeout_seconds": 60,
            "deploy_category": "harness",
        }
        for i in range(3)
    ] + [
        {
            "name": "pay-a",
            "tags": ["payment"],
            "timeout_seconds": 60,
            "deploy_category": "payment",
            "deploy_canary": True,
        },
        {
            "name": "pay-b",
            "tags": ["payment"],
            "timeout_seconds": 70,
            "deploy_category": "payment",
        },
        {
            "name": "grep-a",
            "tags": ["grep"],
            "timeout_seconds": 60,
            "deploy_category": "grep",
            "deploy_canary": True,
        },
        {
            "name": "sms-a",
            "tags": ["sms"],
            "timeout_seconds": 60,
            "deploy_category": "sms",
            "deploy_canary": True,
        },
        {
            "name": "browser-toast-nopa-write-lock",
            "tags": ["browser"],
            "timeout_seconds": 60,
            "deploy_category": "browser_stateful",
            "deploy_canary": True,
        },
        {
            "name": "browser-extra",
            "tags": ["browser"],
            "timeout_seconds": 60,
            "deploy_category": "browser",
        },
    ]
    catalog.write_text(json.dumps(tasks))
    rows: list[tuple[str, bool]] = []
    for task in tasks:
        rows.extend([(task["name"], True)] * 3)
    _write_attempts(attempts, rows)

    result = subprocess.run(
        [
            sys.executable,
            str(SELECTOR),
            "--catalog",
            str(catalog),
            "--attempts-file",
            str(attempts),
            "--format",
            "report",
            "--cap",
            "7",
            "--changed-file",
            "agents/browser_tools/x.py",
            "--changed-file",
            "back-end/src/domains/agentcard/x.ts",
            "--repo-root",
            str(ROOT),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    combined = result.stdout + result.stderr
    assert "HARD CAP HIT" in combined or "HARD CAP" in combined
    assert "DROPPED" in combined
