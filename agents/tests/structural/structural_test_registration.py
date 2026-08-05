"""Structural test: every blackbox test function is actually registered and run.

`agents/tests/blackbox/*.blackbox.py` are NOT auto-discovered. `run_blackbox_tests.py`
only calls each module's `run_all_tests()`, so a `test_*` function that nobody
registers via `r.record(...)` / `await r.record_async(...)` silently never runs —
and the suite still reports green. That directly defeats CLAUDE.md rule 1
("functionality is only guaranteed if a test measures it and that test is cemented
in a consistently-run path"): the test exists, looks like coverage in review, and
measures nothing.

A function is considered registered if its name appears anywhere in its own file
beyond its own `def` line — that covers direct `r.record(name, fn)` registration
and the `test_x()` -> `_x_case()` wrapper convention.

KNOWN_UNREGISTERED is a ratcheting debt ledger, not an exemption list. It records
tests that were already dead when this guard landed. It may only SHRINK: registering
one of these (and deleting its ledger entry) is always correct, and the guard fails
if a ledger entry becomes registered but is left behind, so the ledger cannot go
stale. Adding a NEW entry is never the right fix — register the test instead.
"""

import ast
import asyncio
import sys
from pathlib import Path

from _result import Result as BlackboxResult

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
BLACKBOX_DIR = AGENTS_ROOT / "tests" / "blackbox"
STRUCTURAL_DIR = AGENTS_ROOT / "tests" / "structural"

# Pre-existing dead tests, captured when this guard landed. Only ever remove entries.
KNOWN_UNREGISTERED: dict[str, frozenset[str]] = {
    "benchmark.blackbox.py": frozenset(
        [
            "test_admin_bypass_card_mint_variant_wiring",
            "test_benchmark_agent_source_override_validates_known_sources",
            "test_benchmark_sms_source_override_updates_local_agent_source",
            "test_browser_search_single_result_tasks_use_browser_only",
            "test_cache_coverage_uses_root_scoped_tool_counts",
            "test_catalog_world_model_mode_is_optional_and_validated",
            "test_indeed_account_creation_benchmark_contract",
            "test_keep_agents_env_preserves_successes_and_failures",
            "test_local_services_manifest_reports_anon_capability",
            "test_payment_benchmark_accepts_org_client_credentials_from_dotenv",
            "test_payment_benchmark_rejects_retired_agentcard_api_key",
            "test_payment_benchmark_rejects_retired_direct_or_user_credentials",
            "test_payment_receipt_validation_allows_partial_live_receipts",
            "test_prompt_user_denial_uses_rejection_sentinel",
            "test_x_post_prompt_keeps_goal_and_prefers_email_auth",
        ]
    ),
    "llm.blackbox.py": frozenset(
        [
            "test_call_llm_structured_streaming_replayed_native_tool_call_without_json",
            "test_heartbeat_compute_token_lineage_activity_posts_lineage_key",
        ]
    ),
    "request_payment_card.blackbox.py": frozenset(
        [
            "test_normalize_payload_accepts_serialized_browser_tool_args",
        ]
    ),
    "rose_browser_use.blackbox.py": frozenset(
        [
            "test_browser_attempt_completion_uses_canonical_prompt_and_empty_schema",
            "test_build_browser_use_system_prompt_auth_priority_is_numbered",
            "test_build_browser_use_system_prompt_reuses_main_grading_prompt",
            "test_normalize_request_payment_card_parses_tool_string_arguments",
            "test_normalize_request_payment_card_preserves_receipt",
        ]
    ),
    "spawn_browser_agent_v3.blackbox.py": frozenset(
        [
            "test_agent_anti_detection_normalizes_fcaptcha_behavioral_payload",
            "test_browser_supervisor_recovery_uses_fallback_url_when_page_url_missing",
            "test_goto_action_returns_current_url_for_recovery_fallback",
            "test_idle_mouse_drift_generates_visible_tremor_samples",
            "test_select_auth_assistance_current_url_keeps_current_when_it_has_query_params",
            "test_select_auth_assistance_current_url_restores_pre_submit_query_params",
            "test_simulated_browser_usage_preserves_transport_model",
        ]
    ),
    "tool_schemas.blackbox.py": frozenset(
        [
            "test_all_phase_tools_superset",
        ]
    ),
}


def _is_test_function(name: str) -> bool:
    """Both blackbox naming conventions: `test_*`, and the `_*_case` async-body form.

    Several suites split an async test into `_<name>_case()` (the body) plus a thin
    registered wrapper. A `_*_case` helper is just as dead as a `test_*` function
    when nothing references it, so hold both to the same rule.
    """
    return name.startswith("test_") or (name.startswith("_") and name.endswith("_case"))


def _unregistered_tests(path: Path) -> set[str]:
    """Module-level test functions whose name is never referenced in their own file."""
    source = path.read_text()
    tree = ast.parse(source)
    unregistered = set()
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not _is_test_function(node.name):
            continue
        # The definition itself is one occurrence; any further occurrence means
        # something references it (registration, or a wrapper that calls it).
        if source.count(node.name) <= 1:
            unregistered.add(node.name)
    return unregistered


def test_every_blackbox_test_is_registered():
    """A new blackbox test must be registered in its module's run_all_tests()."""
    new_dead = []
    for path in sorted(BLACKBOX_DIR.glob("*.blackbox.py")):
        allowed = KNOWN_UNREGISTERED.get(path.name, frozenset())
        for name in sorted(_unregistered_tests(path) - allowed):
            new_dead.append(f"{path.name}::{name}")

    assert not new_dead, (
        f"{len(new_dead)} blackbox test(s) are defined but never run — nothing "
        f"registers them, so the suite reports green while measuring nothing:\n"
        + "\n".join(f"  - {v}" for v in new_dead)
        + "\n\nFix: register each in that file's run_all_tests(), e.g.\n"
        '  await r.record_async("<name>", <fn>)   # async test\n'
        '  r.record("<name>", <fn>)               # sync test\n'
        "Do NOT add it to KNOWN_UNREGISTERED — that ledger only shrinks."
    )


def test_known_unregistered_ledger_is_not_stale():
    """Ledger entries that got registered (or deleted) must be removed from the ledger."""
    stale = []
    for filename, names in sorted(KNOWN_UNREGISTERED.items()):
        path = BLACKBOX_DIR / filename
        if not path.exists():
            stale.append(f"{filename} (file no longer exists)")
            continue
        still_dead = _unregistered_tests(path)
        for name in sorted(names - still_dead):
            stale.append(f"{filename}::{name} (now registered or deleted)")

    assert not stale, (
        f"{len(stale)} stale KNOWN_UNREGISTERED entr(ies) — the debt was paid but "
        f"the ledger still lists it. Remove these so the ratchet cannot slip back:\n"
        + "\n".join(f"  - {v}" for v in stale)
    )


def test_every_structural_suite_runs_in_test_sh():
    """Structural suites are hardcoded in scripts/test.sh — the same footgun, one level up.

    `tests/structural/*.py` is not auto-discovered either: each file is named
    explicitly in scripts/test.sh's serial AND background invocation. A new
    structural file that is not added to BOTH lines never runs.
    """
    test_sh = (AGENTS_ROOT.parent / "scripts" / "test.sh").read_text()
    missing = []
    for path in sorted(STRUCTURAL_DIR.glob("structural*.py")):
        invocation = f"tests/structural/{path.name}"
        # Must appear in both the serial (run_suite) and background (bg_suite) paths.
        if test_sh.count(invocation) < 2:
            missing.append(f"{path.name} (found {test_sh.count(invocation)}x, need 2)")

    assert not missing, (
        f"{len(missing)} structural suite(s) are not wired into both scripts/test.sh "
        f"invocations, so they never run:\n"
        + "\n".join(f"  - {v}" for v in missing)
        + "\n\nFix: append `&& python tests/structural/<file>.py` to BOTH the "
        '`run_suite "Agents Structural"` and `bg_suite "Agents Structural"` lines.'
    )


async def run_all_tests():
    print("structural-test-registration tests:")
    r = BlackboxResult()
    r.record("every_blackbox_test_is_registered", test_every_blackbox_test_is_registered)
    r.record("known_unregistered_ledger_is_not_stale", test_known_unregistered_ledger_is_not_stale)
    r.record("every_structural_suite_runs_in_test_sh", test_every_structural_suite_runs_in_test_sh)
    return r.all_passed


if __name__ == "__main__":
    passed = asyncio.run(run_all_tests())
    sys.exit(0 if passed else 1)
