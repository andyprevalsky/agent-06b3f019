#!/usr/bin/env python3
"""Tests for Pre-Deploy bench selection (floor + path + history streak + cap)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from .select_predeploy_benches import (
    DEFAULT_CAP,
    DEFAULT_PASS_STREAK,
    FLOOR_CATEGORIES,
    KNOWN_DEPLOY_CATEGORIES,
    has_pass_streak,
    load_attempt_passes,
    format_report,
    main,
    select_predeploy_benches,
)

ROOT = Path(__file__).resolve().parents[2]
SELECTOR = ROOT / "agents" / "benchmarks" / "select_predeploy_benches.py"
CATALOG = ROOT / "agents" / "benchmarks" / "tasks.json"
ATTEMPTS = ROOT / "agents" / "benchmarks" / "history" / "task_attempts.jsonl"


def _write_attempts(
    path: Path,
    rows: list[tuple[str, bool] | tuple[str, bool, dict]],
) -> None:
    lines = []
    for index, row in enumerate(rows):
        task, passed = row[0], row[1]
        extra = row[2] if len(row) == 3 else {}
        entry = {
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
        entry.update(extra)
        lines.append(json.dumps(entry))
    path.write_text("\n".join(lines) + "\n")


def _smoke_names(catalog: Path) -> set[str]:
    return {task["name"] for task in json.loads(catalog.read_text()) if "smoke" in (task.get("tags") or []) and not task.get("deploy_quarantine")}


def test_default_cap_and_pass_streak() -> None:
    assert DEFAULT_CAP == 20
    assert DEFAULT_PASS_STREAK == 3


@pytest.mark.parametrize("surface", ["local", "cloud"])
def test_predeploy_excludes_production_only_even_with_pass_streak(tmp_path: Path, surface: str) -> None:
    """Both predeploy surfaces use isolated backends, even when a prod task has earned its streak."""
    catalog = tmp_path / "tasks.json"
    attempts = tmp_path / "attempts.jsonl"
    tasks = [
        {"name": "normal-smoke", "tags": ["smoke"], "requires_claude_code": True},
        {"name": "production-smoke", "tags": ["smoke"], "production_only": True},
        {
            "name": "normal-payment", "tags": ["payment", "agentcard-lifecycle-sandbox"],
            "expected_payment_lifecycle": {"orgTransfer": {"livemode": False}},
            "deploy_canary": True, "timeout_seconds": 20,
        },
        {
            "name": "production-payment",
            "tags": ["payment"],
            "deploy_canary": True,
            "timeout_seconds": 10,
            "production_only": True,
        },
        {"name": "normal-depth", "tags": ["payment"], "timeout_seconds": 30},
        {"name": "production-depth", "tags": ["payment"], "timeout_seconds": 10, "production_only": True},
    ]
    catalog.write_text(json.dumps(tasks))
    _write_attempts(attempts, [(task["name"], True) for task in tasks for _ in range(3)])
    selection = select_predeploy_benches(
        catalog=catalog,
        changed_files=["back-end/src/domains/purchases/service.ts"],
        surface=surface,
        attempts_file=attempts,
        repo_root=ROOT,
    )
    assert not set(selection.selected) & {task["name"] for task in tasks if task.get("production_only")}, (
        selection.selected
    )
    assert selection.floor == ["normal-smoke", "normal-payment"]
    assert selection.path_extras == ["normal-depth"]
    assert selection.cap == 20 and selection.pass_streak_required == 3
    assert not selection.cap_hit and not selection.dropped and not selection.skipped_history
    # This test is also called by benchmark.blackbox.py's registered selector
    # case: selection-time eligibility must be visible before a native run.
    report = format_report(selection)
    assert "Standing skip eligibility" in report
    assert "normal-payment" in report and "_agentcard_release_skip_lifecycle" in report
    assert "HELD" in report and "RECLAIMING" in report and "releasedCents=0" in report
    assert "livemode=false" in report and "stripeRefund" in report
    assert "_check_claude_code_credentials" in report and "native credential sync" in report
    assert "no synced Claude credentials and no pool token" in report
    assert "All other assertions and owned-resource cleanup remain required" in report
    assert "not a SKIP verdict" in report
    assert set(selection.skip_eligibility) == {"normal-smoke", "normal-payment"}


def test_skip_display_uses_literal_catalog_contract_and_preserves_cli(tmp_path: Path, capsys) -> None:
    catalog, attempts = tmp_path / "tasks.json", tmp_path / "attempts.jsonl"
    tasks = [
        {"name": "unrelated-smoke", "tags": ["smoke"]},
        {"name": "payment-eligible", "tags": ["smoke", "agentcard-lifecycle-sandbox"],
         "expected_payment_lifecycle": {"orgTransfer": {"livemode": False}}},
        {"name": "claude-eligible", "tags": ["smoke"], "requires_claude_code": True},
        {"name": "boolean-zero-is-not-false", "tags": ["smoke", "agentcard-lifecycle-sandbox"],
         "expected_payment_lifecycle": {"orgTransfer": {"livemode": 0}}},
        {"name": "cross-mode", "tags": ["smoke", "agentcard-lifecycle-sandbox"],
         "expected_payment_lifecycle": {"orgTransfer": {"livemode": True}}},
        {"name": "tag-without-contract", "tags": ["smoke", "agentcard-lifecycle-sandbox"]},
        {"name": "contract-without-tag", "tags": ["smoke"],
         "expected_payment_lifecycle": {"orgTransfer": {"livemode": False}}},
        {"name": "tagged-claude-without-requirement", "tags": ["smoke", "claude-code"]},
        {"name": "production-excluded", "tags": ["smoke", "agentcard-lifecycle-production"],
         "production_only": True, "expected_payment_lifecycle": {"orgTransfer": {"livemode": True}}},
    ]
    catalog.write_text(json.dumps(tasks))
    attempts.write_text("")
    args = ["--catalog", str(catalog), "--attempts-file", str(attempts),
            "--changed-file", "README.md", "--repo-root", str(ROOT)]
    expected = [task["name"] for task in tasks if not task.get("production_only")]
    assert main([*args, "--format", "names"]) == 0
    names = capsys.readouterr()
    assert names.out.splitlines() == expected
    assert "Standing skip eligibility" in names.err
    assert "payment-eligible" in names.err and "claude-eligible" in names.err
    assert main([*args, "--format", "json"]) == 0
    output = capsys.readouterr()
    payload = json.loads(output.out)
    assert output.err == ""
    assert payload["selected"] == expected and payload["total"] == len(expected)
    assert set(payload["skip_eligibility"]) == {"payment-eligible", "claude-eligible"}
    assert payload["cap"] == DEFAULT_CAP and not payload["cap_hit"]
    assert not payload["dropped"] and not payload["skipped_history"]
    assert main([*args, "--format", "names-and-report"]) == 0
    combined = capsys.readouterr().out
    assert combined.split("---PREDEPLOY_BENCH_NAMES---\n")[1].split("---END_PREDEPLOY_BENCH_NAMES---")[0].splitlines() == expected
    assert combined.index("Standing skip eligibility") < combined.index("---PREDEPLOY_BENCH_NAMES---")


def test_smoke_always_selected_canaries_need_last_three_passes() -> None:
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
    smoke = _smoke_names(CATALOG)
    assert selection.selected
    # Existing smoke always runs — even without a 3-pass streak.
    assert "test-mass-agent-run-0" not in selection.selected
    assert "test-mass-agent-run-0" in selection.deploy_quarantined
    assert "browser-biometrics-webdecoy" in selection.selected
    assert "test-mass-agent-run-0" not in selection.skipped_history
    assert "browser-biometrics-webdecoy" not in selection.skipped_history
    # Only *added* canaries/path extras must clear the history gate.
    for name in selection.selected:
        if name in smoke:
            continue
        assert has_pass_streak(name, passes, streak=3), name
    assert selection.pass_streak_required == 3
    # Floor canaries without a 3-pass streak stay uncovered rather than
    # silently promoting an arbitrary category-tagged heavy.
    assert "sms" in selection.uncovered_categories
    assert "browser_stateful" in selection.uncovered_categories
    catalog_by_name = {t["name"]: t for t in json.loads(CATALOG.read_text())}
    for name in selection.selected:
        if name in smoke:
            continue
        task = catalog_by_name.get(name) or {}
        if task.get("deploy_category") in {"payment", "grep", "sms", "browser_stateful"}:
            assert task.get("deploy_canary") is True, name


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
    smoke = _smoke_names(CATALOG)
    assert "browser" in selection.triggered_categories
    assert "payment" in selection.triggered_categories
    assert "sms" in selection.triggered_categories
    for name in selection.selected:
        if name in smoke:
            continue
        assert has_pass_streak(name, passes, streak=3), name
    # SMS has no 3-pass canary, so path trigger must not invent one.
    assert "sms" not in selection.categories_covered or all(
        name in smoke or has_pass_streak(name, passes, streak=3) for name in selection.selected
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
                    # Second annotated canary — fills the floor when the
                    # preferred (shorter) canary lacks a pass streak.
                    "deploy_canary": True,
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


def test_existing_smoke_without_three_attempts_still_selected(tmp_path: Path) -> None:
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
    assert selection.selected == ["new-smoke"]
    assert selection.skipped_history == []


def test_canary_without_three_attempts_is_skipped(tmp_path: Path) -> None:
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
                    "name": "new-payment",
                    "tags": ["payment"],
                    "timeout_seconds": 60,
                    "deploy_category": "payment",
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
            ("new-payment", True),
            ("new-payment", True),
        ],
    )
    selection = select_predeploy_benches(
        catalog=catalog,
        changed_files=[],
        surface="local",
        cap=20,
        repo_root=ROOT,
        attempts_file=attempts,
    )
    assert "harness-smoke" in selection.selected
    assert "new-payment" not in selection.selected
    assert "new-payment" in selection.skipped_history
    assert "payment" in selection.uncovered_categories


def test_predeploy_worktree_attempts_do_not_invalidate_canary_streak(
    tmp_path: Path,
) -> None:
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
                    "name": "stable-payment",
                    "tags": ["payment"],
                    "timeout_seconds": 60,
                    "deploy_category": "payment",
                    "deploy_canary": True,
                },
            ]
        )
    )
    # Three daily passes earn eligibility; later predeploy/worktree failures
    # must not wipe the streak after the canary is assigned into smoke.
    _write_attempts(
        attempts,
        [
            ("harness-smoke", True),
            ("harness-smoke", True),
            ("harness-smoke", True),
            ("stable-payment", True),
            ("stable-payment", True),
            ("stable-payment", True),
            (
                "stable-payment",
                False,
                {"suite": "predeploy", "counts_for_deploy_eligibility": False},
            ),
            (
                "stable-payment",
                False,
                {"suite": "predeploy", "counts_for_deploy_eligibility": False},
            ),
        ],
    )
    selection = select_predeploy_benches(
        catalog=catalog,
        changed_files=[],
        surface="local",
        cap=20,
        repo_root=ROOT,
        attempts_file=attempts,
    )
    assert "stable-payment" in selection.selected
    assert "stable-payment" not in selection.skipped_history
    assert "payment" in selection.categories_covered


def test_suite_only_exclusion_preserves_canary_streak(tmp_path: Path) -> None:
    """Excluded suite alone must drop the row even without the bool flag."""
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
                    "name": "stable-payment",
                    "tags": ["payment"],
                    "timeout_seconds": 60,
                    "deploy_category": "payment",
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
            ("stable-payment", True),
            ("stable-payment", True),
            ("stable-payment", True),
            ("stable-payment", False, {"suite": "predeploy"}),
            (
                "stable-payment",
                False,
                {"suite": "predeploy", "counts_for_deploy_eligibility": True},
            ),
        ],
    )
    selection = select_predeploy_benches(
        catalog=catalog,
        changed_files=[],
        surface="local",
        cap=20,
        repo_root=ROOT,
        attempts_file=attempts,
    )
    assert "stable-payment" in selection.selected
    assert "payment" in selection.categories_covered


def test_flag_only_exclusion_preserves_canary_streak(tmp_path: Path) -> None:
    """`counts_for_deploy_eligibility=false` alone must drop the row."""
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
                    "name": "stable-payment",
                    "tags": ["payment"],
                    "timeout_seconds": 60,
                    "deploy_category": "payment",
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
            ("stable-payment", True),
            ("stable-payment", True),
            ("stable-payment", True),
            ("stable-payment", False, {"counts_for_deploy_eligibility": False}),
        ],
    )
    selection = select_predeploy_benches(
        catalog=catalog,
        changed_files=[],
        surface="local",
        cap=20,
        repo_root=ROOT,
        attempts_file=attempts,
    )
    assert "stable-payment" in selection.selected
    assert "payment" in selection.categories_covered


def test_floor_does_not_silently_promote_non_canary(tmp_path: Path) -> None:
    """Floor leaves a category uncovered when only non-canaries have a streak."""
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
                    "name": "payment-heavy",
                    "tags": ["payment"],
                    "timeout_seconds": 900,
                    "deploy_category": "payment",
                },
                {
                    "name": "payment-canary",
                    "tags": ["payment"],
                    "timeout_seconds": 60,
                    "deploy_category": "payment",
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
            ("payment-heavy", True),
            ("payment-heavy", True),
            ("payment-heavy", True),
            # Canary lacks a streak — floor must NOT promote payment-heavy.
        ],
    )
    selection = select_predeploy_benches(
        catalog=catalog,
        changed_files=[],
        surface="local",
        cap=20,
        repo_root=ROOT,
        attempts_file=attempts,
    )
    assert "payment-heavy" not in selection.selected
    assert "payment-canary" not in selection.selected
    assert "payment" in selection.uncovered_categories


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
                    "deploy_canary": True,
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


@pytest.mark.parametrize("surface", ["local", "cloud"])
def test_predeploy_surfaces_skip_production_only_even_with_pass_streak(
    tmp_path: Path, surface: str
) -> None:
    catalog = tmp_path / "tasks.json"
    attempts = tmp_path / "attempts.jsonl"
    catalog.write_text(
        json.dumps(
            [
                {
                    "name": "prod-payment",
                    "tags": ["payment"],
                    "timeout_seconds": 60,
                    "deploy_category": "payment",
                    "deploy_canary": True,
                    "production_only": True,
                },
                {
                    "name": "local-payment",
                    "tags": ["payment"],
                    "timeout_seconds": 90,
                    "deploy_category": "payment",
                    "deploy_canary": True,
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
        "prod-payment",
        "local-payment",
        "smoke-ok",
        "grep-ok",
        "sms-ok",
        "browser-toast-nopa-write-lock",
    ):
        rows.extend([(name, True)] * 3)
    _write_attempts(attempts, rows)
    selected = select_predeploy_benches(
        catalog=catalog,
        changed_files=["back-end/src/providers/agentcard/org-runtime.ts"],
        surface=surface,
        cap=20,
        repo_root=ROOT,
        attempts_file=attempts,
    )
    assert "prod-payment" not in selected.selected
    assert "local-payment" in selected.selected


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
    assert result.stdout.index("TOTAL SELECTED:") < result.stdout.index("---PREDEPLOY_BENCH_NAMES---")


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
    for stream in (result.stdout, result.stderr):
        assert "HARD CAP HIT" in stream or "HARD CAP" in stream
        assert "DROPPED" in stream


def test_cli_cap_clamps_above_default(tmp_path: Path) -> None:
    """CLI/env caps above DEFAULT_CAP must clamp so launchers cannot overrun 20."""
    catalog = tmp_path / "tasks.json"
    attempts = tmp_path / "attempts.jsonl"
    # Keep floor tiny so clamping (not floor overflow) is what we exercise.
    tasks = [
        {
            "name": "smoke-0",
            "tags": ["smoke"],
            "timeout_seconds": 60,
            "deploy_category": "harness",
        }
    ] + [
        {
            "name": f"extra-{i}",
            "tags": ["payment"],
            "timeout_seconds": 60,
            "deploy_category": "payment",
            "deploy_canary": True,
        }
        for i in range(30)
    ]
    catalog.write_text(json.dumps(tasks))
    rows: list[tuple[str, bool]] = [(task["name"], True) for task in tasks for _ in range(3)]
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
            "names",
            "--cap",
            "50",
            "--repo-root",
            str(ROOT),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    names = [line for line in result.stdout.splitlines() if line.strip()]
    assert len(names) <= DEFAULT_CAP
    assert "clamping" in result.stderr.lower() or "ceiling" in result.stderr.lower()


AGENTCARD_SANDBOX_LIFECYCLE = (
    "agent-payment-test-shop",
    "agent-payment-setup-resume",
    "agent-payment-idempotent-abandonment",
    "agent-payment-abandonment",
)


@pytest.mark.parametrize("surface", ["local", "cloud"])
def test_agentcard_sandbox_lifecycle_tasks_are_ordinary_smoke_with_isolated_fixtures(
    tmp_path: Path, surface: str
) -> None:
    """The retired AgentCard deploy lane's four tasks run in smoke on every deploy.

    They are smoke-tagged, so failed attempts never evict them (no history gate),
    they fit the hard cap with path extras, and the release-stall guidance rides
    along. Their mutable payment fixture is isolated per task on both surfaces:
    cloud seeds it on each task's own guest, and the local runner at the
    predeploy concurrency gives each task an independent world.
    """
    attempts = tmp_path / "attempts.jsonl"
    _write_attempts(attempts, [(name, False) for name in AGENTCARD_SANDBOX_LIFECYCLE for _ in range(3)])
    catalog = {task["name"]: task for task in json.loads(CATALOG.read_text())}
    for changed in (["README.md"], ["back-end/src/domains/agentcard/service.ts", "agents/loop/run_agent.py"]):
        selection = select_predeploy_benches(
            catalog=CATALOG,
            changed_files=changed,
            surface=surface,
            cap=DEFAULT_CAP,
            repo_root=ROOT,
            attempts_file=attempts,
            pass_streak=DEFAULT_PASS_STREAK,
        )
        assert not selection.cap_hit and selection.total <= DEFAULT_CAP, selection.selected
        for name in AGENTCARD_SANDBOX_LIFECYCLE:
            task = catalog[name]
            assert "smoke" in task["tags"] and task["group"] == "pre-deploy", name
            assert name in selection.floor and "floor:smoke" in selection.reasons[name], name
            assert name not in selection.skipped_history, name
            assert any("release-stall standing warning" in rule for rule in selection.skip_eligibility[name]), name
    if surface == "local":
        from benchmarks.local_worlds import needs_independent_worlds

        local_concurrency = 2  # scripts/run-predeploy-local PREDEPLOY_LOCAL_CONCURRENCY default
        assert needs_independent_worlds(selection.selected, local_concurrency)
    else:
        driver = (ROOT / "scripts" / "cloudbench-run.sh").read_text()
        case = driver.index(
            "agent-payment-test-shop|agent-payment-idempotent-abandonment|"
            "agent-payment-abandonment|agent-payment-setup-resume)"
        )
        assert "BENCH_NEEDS_PAYMENT_FIXTURE=1" in driver[case : driver.index(";;", case)]


@pytest.mark.parametrize("output_format", ["names", "json"])
@pytest.mark.parametrize("drop_extra", [False, True])
def test_cli_machine_formats_keep_cap_warning_on_stderr(
    tmp_path: Path, output_format: str, drop_extra: bool,
) -> None:
    """A full selection remains machine-readable, with the complete warning on stderr."""
    catalog, attempts = tmp_path / "tasks.json", tmp_path / "attempts.jsonl"
    tasks = [
        {"name": "smoke", "tags": ["smoke"]},
        {"name": "payment", "tags": ["payment"], "deploy_canary": True},
    ]
    if drop_extra:
        tasks.append({"name": "payment-extra", "tags": ["payment"]})
    catalog.write_text(json.dumps(tasks))
    _write_attempts(attempts, [(task["name"], True) for task in tasks for _ in range(3)])
    result = subprocess.run(
        [sys.executable, str(SELECTOR), "--catalog", str(catalog),
         "--attempts-file", str(attempts), "--surface", "cloud", "--cap", "2",
         "--changed-file", "back-end/src/domains/agentcard/service.ts",
         "--repo-root", str(ROOT), "--format", output_format],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    if output_format == "names":
        assert result.stdout.splitlines() == ["smoke", "payment"]
    else:
        payload = json.loads(result.stdout)
        assert payload["selected"] == ["smoke", "payment"]
        assert payload["cap"] == 2 and payload["total"] == 2
        assert payload["cap_hit"] is drop_extra
        assert payload["dropped"] == (["payment-extra"] if drop_extra else [])
    warning = "PREDEPLOY BENCH HARD CAP HIT" if drop_extra else "PREDEPLOY BENCH COUNT AT HARD CAP"
    assert warning in result.stderr
    if drop_extra:
        assert "payment-extra" in result.stderr and "DROPPED" in result.stderr


@pytest.mark.parametrize("output_format", ["names", "json"])
def test_machine_readable_cap_output_keeps_warnings_on_stderr(tmp_path: Path, output_format: str) -> None:
    catalog = tmp_path / "tasks.json"
    attempts = tmp_path / "attempts.jsonl"
    tasks = [{"name": f"smoke-{i}", "tags": ["smoke"], "timeout_seconds": 60,
              "deploy_category": "harness"} for i in range(DEFAULT_CAP)]
    catalog.write_text(json.dumps(tasks))
    attempts.write_text("")
    result = subprocess.run([sys.executable, str(SELECTOR), "--catalog", str(catalog),
        "--attempts-file", str(attempts), "--format", output_format, "--cap", str(DEFAULT_CAP),
        "--repo-root", str(tmp_path)], text=True, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr
    selected = json.loads(result.stdout)["selected"] if output_format == "json" else result.stdout.splitlines()
    assert set(selected) == {task["name"] for task in tasks}
    assert len(selected) == DEFAULT_CAP
    assert "HARD CAP" in result.stderr


@pytest.mark.parametrize("surface", ["local", "cloud"])
@pytest.mark.parametrize("changed", [["README.md"], ["agents/benchmarks/run_benchmark.py", "agents/worker.py", "back-end/src/server.ts"]])
def test_mass_deploy_quarantine_cannot_reenter_through_floor_or_paths(tmp_path, surface, changed):
    from .select_predeploy_benches import load_tasks, _eligible

    attempts = tmp_path / "attempts.jsonl"
    _write_attempts(attempts, [("test-mass-agent-run-0", True)] * 5)
    selection = select_predeploy_benches(
        catalog=CATALOG, changed_files=changed, surface=surface, cap=10000,
        repo_root=ROOT, attempts_file=attempts, pass_streak=1,
    )
    assert "test-mass-agent-run-0" not in selection.selected
    assert "test-mass-agent-run-0" not in selection.dropped
    assert "Deploy quarantine (not run): test-mass-agent-run-0" in format_report(selection)
    task = next(t for t in load_tasks(CATALOG) if t.name == "test-mass-agent-run-0")
    assert not _eligible(task, surface)
    # The executable task, smoke tag, prompt and evaluators remain in the catalog.
    assert task.is_smoke and task.eligible_status
    from .benchmark_tasks import get_task_by_name
    assert get_task_by_name(task.name).name == task.name


def test_deploy_quarantine_does_not_disable_ordinary_failure_quarantine(tmp_path):
    catalog = tmp_path / "tasks.json"
    catalog.write_text(json.dumps([
        {"name": "disabled", "tags": ["smoke"], "deploy_quarantine": "user instruction"},
        {"name": "still-run", "tags": ["smoke"], "quarantine": {"since": "2026-11-10", "repair": "issue", "error": "flaky", "evidence": "receipt"}},
    ]))
    selection = select_predeploy_benches(catalog=catalog, changed_files=[], repo_root=ROOT)
    assert selection.selected == ["still-run"]
    assert selection.deploy_quarantined == {"disabled": "user instruction"}


def test_stale_cloud_deploy_plan_cannot_admit_quarantined_mass(tmp_path, monkeypatch):
    # A saved pre-quarantine plan must refuse before network or native admission.
    monkeypatch.syspath_prepend(str(ROOT / "scripts"))
    import deploy_test_cloud as cloud
    from unittest.mock import Mock
    catalog = tmp_path / "agents/benchmarks/tasks.json"
    catalog.parent.mkdir(parents=True)
    catalog.write_bytes(CATALOG.read_bytes())
    source = {"head": "frozen"}
    monkeypatch.setattr(cloud, "source", lambda root: source)
    fetch = Mock(side_effect=AssertionError("must refuse before fetching or admission"))
    launch = Mock(side_effect=AssertionError("must never launch the quarantined task"))
    monkeypatch.setattr(cloud, "origin_fetchable", fetch)
    monkeypatch.setattr(cloud, "launch", launch)
    with pytest.raises(cloud.SourceRefusal, match="regenerate selection: test-mass-agent-run-0"):
        cloud.execute({"checks": ["test-mass-agent-run-0"], "token": "fixture", "source": source}, tmp_path)
    fetch.assert_not_called()
    launch.assert_not_called()


def test_refresh_omits_only_explicit_deploy_quarantines(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "scripts"))
    import deploy_test_quarantine as quarantine
    from copy import deepcopy
    catalog = tmp_path / "agents/benchmarks/tasks.json"
    catalog.parent.mkdir(parents=True)
    rows = [
        {"name": "mass", "deploy_quarantine": "Explicit user exclusion"},
        {"name": "ordinary", "quarantine": {"error": "Still runs"}},
        {"name": "peer"},
    ]
    catalog.write_text(json.dumps(rows))
    before = {"category": "smoke", "native_cloud": True, "checks": ["mass", "ordinary", "peer"]}
    original = deepcopy(before)
    after = {**before, "checks": ["ordinary", "peer"]}
    assert quarantine.deploy_selection_omissions(tmp_path, before, after) == {"mass": "Explicit user exclusion"}
    assert before == original
    for checks in (["peer"], ["mass", "peer"], ["ordinary"]):
        with pytest.raises(ValueError):
            quarantine.deploy_selection_omissions(tmp_path, before, {**after, "checks": checks})
    for bad in (False, 1, "", {}, None):
        rows[0]["deploy_quarantine"] = bad
        catalog.write_text(json.dumps(rows))
        with pytest.raises(ValueError):
            quarantine.deploy_selection_omissions(tmp_path, before, after)
    rows[0]["deploy_quarantine"] = "Explicit user exclusion"
    catalog.write_text(json.dumps(rows + [rows[0]]))
    with pytest.raises(ValueError):
        quarantine.deploy_selection_omissions(tmp_path, before, after)
    catalog.write_text(json.dumps(rows))
    with pytest.raises(ValueError):
        quarantine.deploy_selection_omissions(tmp_path, {**before, "category": "backend"}, after)


@pytest.mark.parametrize("surface", ["local", "cloud"])
@pytest.mark.parametrize("fields,eligible", [
    ({}, True),
    ({"status": "retired"}, False),
    ({"status": "incomplete"}, False),
    ({"production_only": True}, False),
])
def test_manual_eligibility_bypasses_only_deploy_quarantine(tmp_path, surface, fields, eligible):
    from .select_predeploy_benches import _eligible, load_tasks

    catalog = tmp_path / "tasks.json"
    catalog.write_text(json.dumps([{
        "name": "manual-task", "tags": ["smoke"],
        "deploy_quarantine": "user-directed deploy omission", **fields,
    }]))
    task = load_tasks(catalog)[0]
    assert not _eligible(task, surface)
    assert _eligible(task, surface, for_deploy=False) is eligible


def test_manual_cloud_eligibility_still_rejects_local_only(tmp_path):
    from .select_predeploy_benches import _eligible, load_tasks

    catalog = tmp_path / "tasks.json"
    catalog.write_text(json.dumps([{
        "name": "manual-local", "tags": ["local-only"],
        "deploy_quarantine": "user-directed deploy omission",
    }]))
    task = load_tasks(catalog)[0]
    assert _eligible(task, "local", for_deploy=False)
    assert not _eligible(task, "cloud", for_deploy=False)
