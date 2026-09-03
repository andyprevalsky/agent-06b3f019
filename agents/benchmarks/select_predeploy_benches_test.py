#!/usr/bin/env python3
"""Tests for Pre-Deploy bench selection (floor + path depth + hard cap)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SELECTOR = ROOT / "agents" / "benchmarks" / "select_predeploy_benches.py"
CATALOG = ROOT / "agents" / "benchmarks" / "tasks.json"

sys.path.insert(0, str(ROOT / "agents"))
from benchmarks.select_predeploy_benches import (  # noqa: E402
    DEFAULT_CAP,
    FLOOR_CATEGORIES,
    KNOWN_DEPLOY_CATEGORIES,
    select_predeploy_benches,
)


def test_default_cap_is_20() -> None:
    assert DEFAULT_CAP == 20


def test_floor_includes_all_smoke_and_one_canary_per_floor_category() -> None:
    selection = select_predeploy_benches(
        catalog=CATALOG,
        changed_files=["README.md"],
        surface="local",
        cap=20,
        repo_root=ROOT,
    )
    tasks = json.loads(CATALOG.read_text())
    smoke = [t["name"] for t in tasks if "smoke" in (t.get("tags") or [])]
    for name in smoke:
        assert name in selection.selected, f"smoke task {name} missing from floor"
        assert name in selection.floor
    assert selection.total == len(selection.selected)
    assert selection.total <= 20
    assert selection.total >= len(smoke) + len(FLOOR_CATEGORIES)
    for category in FLOOR_CATEGORIES:
        assert category in selection.categories_covered
    assert not selection.cap_hit
    assert selection.path_extras == []


def test_path_triggers_add_depth_and_report_is_explicit() -> None:
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
    )
    assert "browser" in selection.triggered_categories
    assert "payment" in selection.triggered_categories
    assert "sms" in selection.triggered_categories
    assert selection.path_extras, "path triggers must add depth beyond the floor"
    assert selection.total <= 20


def test_hard_cap_screams_and_drops_extras_not_floor() -> None:
    selection = select_predeploy_benches(
        catalog=CATALOG,
        changed_files=[
            "agents/browser_tools/click.py",
            "back-end/src/domains/agentcard/service.ts",
            "agents/domains/sms/supervisor.py",
            "agents/domains/user_data/grep.py",
        ],
        surface="local",
        cap=15,
        repo_root=ROOT,
    )
    assert selection.total == 15
    assert selection.cap_hit
    assert selection.dropped
    tasks = json.loads(CATALOG.read_text())
    smoke = [t["name"] for t in tasks if "smoke" in (t.get("tags") or [])]
    for name in smoke:
        assert name in selection.floor


def test_floor_that_exceeds_cap_fails_closed() -> None:
    with pytest.raises(SystemExit, match="PREDEPLOY FLOOR"):
        select_predeploy_benches(
            catalog=CATALOG,
            changed_files=["README.md"],
            surface="local",
            cap=8,
            repo_root=ROOT,
        )


def test_cloud_surface_skips_local_only_canaries() -> None:
    local = select_predeploy_benches(
        catalog=CATALOG,
        changed_files=["README.md"],
        surface="local",
        cap=20,
        repo_root=ROOT,
    )
    cloud = select_predeploy_benches(
        catalog=CATALOG,
        changed_files=["README.md"],
        surface="cloud",
        cap=20,
        repo_root=ROOT,
    )
    tasks = {t["name"]: t for t in json.loads(CATALOG.read_text())}
    for name in cloud.selected:
        tags = tasks[name].get("tags") or []
        assert "local-only" not in tags
    if "gate-subscription-card-mint" in local.selected:
        assert "gate-subscription-card-mint" not in cloud.selected


def test_new_deploy_category_task_auto_attaches_as_canary(tmp_path: Path) -> None:
    catalog = tmp_path / "tasks.json"
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
                    "name": "old-payment",
                    "tags": ["payment"],
                    "timeout_seconds": 500,
                    "deploy_category": "payment",
                },
                {
                    "name": "brand-new-payment",
                    "tags": ["payment"],
                    "timeout_seconds": 120,
                    "deploy_category": "payment",
                    "deploy_canary": True,
                },
                {
                    "name": "grep-canary",
                    "tags": ["grep"],
                    "timeout_seconds": 100,
                    "deploy_category": "grep",
                    "deploy_canary": True,
                },
                {
                    "name": "sms-canary",
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
    selection = select_predeploy_benches(
        catalog=catalog,
        changed_files=[],
        surface="local",
        cap=20,
        repo_root=ROOT,
    )
    assert "brand-new-payment" in selection.selected
    assert "old-payment" not in selection.selected
    assert "harness-smoke" in selection.selected


def test_cli_report_prints_total_before_names() -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(SELECTOR),
            "--catalog",
            str(CATALOG),
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
    assert "---PREDEPLOY_BENCH_NAMES---" in result.stdout
    assert result.stdout.index("TOTAL SELECTED:") < result.stdout.index(
        "---PREDEPLOY_BENCH_NAMES---"
    )


def test_known_deploy_categories_cover_floor() -> None:
    for category in FLOOR_CATEGORIES:
        assert category in KNOWN_DEPLOY_CATEGORIES


def test_cli_cap_scream_appears_on_stdout_and_stderr() -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(SELECTOR),
            "--catalog",
            str(CATALOG),
            "--format",
            "report",
            "--cap",
            "15",
            "--changed-file",
            "agents/browser_tools/x.py",
            "--changed-file",
            "back-end/src/domains/agentcard/x.ts",
            "--changed-file",
            "agents/domains/sms/x.py",
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
    assert "HARD CAP HIT" in combined
    assert "DROPPED" in combined
