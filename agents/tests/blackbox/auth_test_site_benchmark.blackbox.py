"""Black-box coverage for the hosted Rose Shop auth benchmarks.

Every daily task uses one of four natural prompts with no sign-in hints; only
the seeded fixture decides which branch of the auth ladder is correct. These
tests pin that contract, the fail-closed fixture preflight, the evaluator, and
the runner's site lifecycle (including the stand-in user and two-run tasks).
"""

from __future__ import annotations

import asyncio
import itertools
import json
import os
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from _test_utils import BlackboxResult

TASK_SCENARIOS = {
    "browser-auth-existing-browser-session": "saved_session",
    "browser-auth-stale-session-password": "stale_session",
    "browser-auth-passkey-preferred": "passkey",
    "browser-auth-passkey-rejected-password": "passkey_rejected",
    "browser-auth-saved-password-retry": "password_retry",
    "browser-auth-password-email-2fa": "password_email_2fa",
    "browser-auth-password-app-approval": "password_app_approval",
    "browser-auth-account-locked": "account_locked",
    "browser-auth-minted-email-otp": "minted_otp",
    "browser-auth-code-never-arrives": "code_never_arrives",
    "browser-auth-expired-code-retry": "expired_code",
    "browser-auth-minted-sms-otp": "minted_sms_otp",
    "browser-auth-magic-link": "magic_link",
    "browser-auth-email-otp": "email_otp",
    "browser-auth-minted-signup": "signup",
    "browser-auth-signup-already-registered": "signup_already_registered",
    "browser-auth-all-options-fail-assistance": "all_fail",
    "browser-auth-assistance-user-signs-in": "user_signs_in",
    "browser-auth-assistance-declined": "saved_logins_fail",
    "browser-auth-guest-purchase": "guest_purchase",
    "browser-auth-member-discount-purchase": "member_discount_purchase",
    "browser-auth-member-discount-signup-fails-purchase": "member_discount_signup_fails_purchase",
    "browser-auth-paid-membership-purchase": "paid_membership_purchase",
    "browser-auth-signup-purchase": "signup_purchase",
    "browser-auth-signup-purchase-no-subscription": "signup_purchase",
    "browser-auth-signup-fails-purchase-assistance": "signup_fails_purchase",
    "browser-auth-session-expires-at-checkout": "session_expires_at_checkout",
    "browser-auth-failed-login-not-reoffered": "failed_login_not_reoffered",
    "browser-auth-created-account-reused": "created_account_reused",
    "browser-auth-named-account": "named_account",
}
PROMPTS = {
    "Tell me my member number for {auth_test_site_url}",
    "Create an account for me at {auth_test_site_url} and tell me my member number",
    "Buy me a Canvas Tote from {auth_test_site_url}",
    "Tell me my member number for my {auth_test_site_account} account at {auth_test_site_url}",
}
SAVED = ["jordan.ellis.abc@example.com", "jordan.e.abc@example.com", "j.ellis.abc@example.com"]
MINTED = "rose-agent-7@mail.example.test"
INBOX = "jordan.ellis@inbox.example"
MEMBER_NUMBER = "RS-12345678"
MINTED_PHONE = "+15555550142"
# A minted account is the passwordless login a minted sign-in records, not Minted.
MINTED_ACCOUNT_LOGINS = {
    "minted_otp": MINTED,
    "code_never_arrives": MINTED,
    "expired_code": MINTED,
    "magic_link": MINTED,
    "minted_sms_otp": MINTED_PHONE,
}


def _manifest(scenario: str, **overrides) -> dict:
    """A manifest whose ladder is exactly what the scenario promises."""
    from benchmarks.auth_test_site import NO_SESSION_SCENARIOS, SCENARIO_LADDERS

    passwords, minted_offered, passkeys, sessions = SCENARIO_LADDERS[scenario]
    minted_login = MINTED_ACCOUNT_LOGINS.get(scenario)
    saved = [minted_login] if minted_login else list(SAVED[:passwords])
    offered = MINTED if minted_offered else None
    minted = MINTED if minted_offered or minted_login else None
    reachable = scenario not in NO_SESSION_SCENARIOS
    manifest = {
        "siteId": "abc123",
        "scenario": scenario,
        "realm": "rose-shop-abc123",
        "entryUrl": "https://rose-x.ngrok.app/api/rose-shop/abc123/?authRealm=rose-shop-abc123",
        "savedPasswordUsernames": saved,
        "mintedEmail": minted,
        "mintedPhone": MINTED_PHONE if minted else None,
        "expectedSignInEmail": INBOX if scenario == "email_otp" else (MINTED if scenario == "minted_otp" else None),
        "expectedMemberNumber": MEMBER_NUMBER if reachable else None,
        "namedAccountEmail": SAVED[1] if scenario == "named_account" else None,
        "userSignIn": {"email": SAVED[0], "password": "only-the-user-knows"} if scenario == "user_signs_in" else None,
        "appApprovalUser": {
            "deviceUrl": "https://rose-x.ngrok.app/device?secret=stand-in-user-only",
            "expectedNumber": "42",
            "challengeLifetimeSeconds": 300,
        }
        if scenario == "password_app_approval"
        else None,
        "savedSession": {"saved_session": "valid", "stale_session": "expired", "all_fail": "expired"}.get(scenario),
        "savedBrowserAuthHidden": False,
        "authOptionsPreview": {
            "passwordUsernames": list(saved),
            "mintedEmail": offered,
            "passkeyCount": passkeys,
            "cookieBundleCount": sessions,
            "emailOtpInboxes": [INBOX] if scenario == "email_otp" else [],
        },
    }
    manifest.update(overrides)
    return manifest


_ATTEMPT_CLOCK = itertools.count()


def _attempt(kind: str, email: str, outcome: str, reason: str | None = None) -> dict:
    """Site events half a minute apart, the pace of an agent taking one step at a time."""
    at = datetime(2026, 10, 1, tzinfo=timezone.utc) + timedelta(seconds=30 * next(_ATTEMPT_CLOCK))
    return {
        "at": at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "kind": kind,
        "email": email,
        "outcome": outcome,
        "reason": reason,
    }


def _session(email: str, method: str) -> dict:
    return {"email": email, "method": method, "createdAt": "2026-10-01T00:00:01.000Z", "endedAt": None}


def _retry_report() -> dict:
    return {
        "signInEmail": SAVED[2],
        "attempts": [
            _attempt("password", SAVED[0], "rejected", "wrong_password"),
            _attempt("password", SAVED[1], "rejected", "unknown_account"),
            _attempt("password", SAVED[2], "signed_in"),
        ],
        "sessions": [_session(SAVED[2], "password")],
    }


def _task_raw(name: str) -> dict:
    from benchmarks.long_horizon import load_raw_catalog

    return next(task for task in load_raw_catalog() if task["name"] == name)


def _outcome_check(name: str) -> dict:
    raw = _task_raw(name)
    return next(
        check
        for evaluator in raw["evaluators"]
        for check in evaluator.get("checks") or []
        if check["type"] == "auth_test_site_outcome"
    )


def test_daily_catalog_covers_every_hosted_auth_branch_with_natural_prompts() -> None:
    from benchmarks.auth_test_site import AUTH_TEST_SITE_SCENARIOS, declared_block
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.long_horizon import load_raw_catalog

    hosted = {raw["name"] for raw in load_raw_catalog() if "auth_test_site" in (raw.get("environment") or {})}
    assert hosted == set(TASK_SCENARIOS), (
        f"catalog and test disagree on hosted auth tasks: {hosted ^ set(TASK_SCENARIOS)}"
    )
    for name, scenario in TASK_SCENARIOS.items():
        task = get_task_by_name(name)
        assert task.group == "daily" and task.status == "ready", name
        assert task.environment["mode"] == "synthetic" and not task.environment.get("live_fixtures"), name
        assert declared_block(task.environment)["scenario"] == scenario, name
        assert task.enforce_declared_evaluators is True, name
        assert task.requires_browser_agent is True, name
        assert "browser-auth" in task.tags, name
        assert task.prompt in PROMPTS, f"{name}: fixtures, not prompts, must decide the branch: {task.prompt!r}"
        first_run = declared_block(task.environment).get("first_run_prompt")
        assert first_run is None or first_run in PROMPTS, f"{name}: {first_run!r}"
    assert set(TASK_SCENARIOS.values()) == set(AUTH_TEST_SITE_SCENARIOS)
    for prompt in PROMPTS:
        lowered = prompt.lower()
        for hint in (
            "password",
            "minted",
            "code",
            "otp",
            "assist",
            "help",
            "retry",
            "passkey",
            "session",
            "sign in",
            "sign-in",
            "log in",
            "login",
            "guest",
            "link",
            "text",
            "sms",
            "saved",
        ):
            assert hint not in lowered, f"prompt leaks the expected auth branch via {hint!r}: {prompt!r}"

    for name in (
        "browser-auth-all-options-fail-assistance",
        "browser-auth-account-locked",
        "browser-auth-code-never-arrives",
        "browser-auth-signup-fails-purchase-assistance",
        "browser-auth-assistance-user-signs-in",
        "browser-auth-assistance-declined",
        "browser-auth-password-app-approval",
    ):
        assert get_task_by_name(name).expected_attention_kind == "auth_assistance", name
    assert _outcome_check("browser-auth-saved-password-retry")["require_all_saved_passwords_attempted"] is True
    assert _outcome_check("browser-auth-all-options-fail-assistance")["minted_unused"] is True
    assert _outcome_check("browser-auth-minted-email-otp")["signed_in_method"] == "email_code"
    assert _outcome_check("browser-auth-signup-purchase")["orders"] == {"count": 1, "placed_by": "signed_in_account"}
    for name in (
        "browser-auth-guest-purchase",
        "browser-auth-member-discount-purchase",
        "browser-auth-member-discount-signup-fails-purchase",
        "browser-auth-paid-membership-purchase",
        "browser-auth-signup-purchase",
        "browser-auth-session-expires-at-checkout",
    ):
        lifecycle = get_task_by_name(name).expected_payment_lifecycle
        assert lifecycle["integrity"] == {"purchaseCount": 1, "walletFundingCount": 1, "cardCount": 1}, name
        assert get_task_by_name(name).expected_approval_count == 1, name

    # A purchase bench left out of the runner's payment-task lists gets no payment
    # fixture and fails on a missing Stripe hold, so the lists follow the catalog.
    from benchmarks import local, run_benchmark

    paying = {
        task["name"]
        for task in load_raw_catalog()
        if task["name"].startswith("browser-auth-") and task.get("expected_payment_lifecycle")
    } - {run_benchmark.ROSE_SHOP_NO_SUBSCRIPTION_TASK_NAME}
    assert run_benchmark.ROSE_SHOP_PAYMENT_TASK_NAMES == paying, paying
    assert local.ROSE_SHOP_PAYMENT_TASK_NAMES == paying, paying


async def test_hosted_auth_tasks_never_overlap_on_one_stack() -> None:
    """Every browser agent of a user is handed the codes sent to that user's agent inbox."""
    from benchmarks.auth_test_site import shares_agent_inbox
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _parallel_task_runners

    assert all(shares_agent_inbox(get_task_by_name(name).environment) for name in TASK_SCENARIOS)
    assert not shares_agent_inbox(get_task_by_name("whatsapp-history-recall").environment)

    running: list[str] = []
    overlaps: list[tuple[str, ...]] = []
    peak_other = 0

    async def runner(task):
        nonlocal peak_other
        running.append(task.name)
        if sum(1 for name in running if name in TASK_SCENARIOS) > 1:
            overlaps.append(tuple(running))
        peak_other = max(peak_other, len(running))
        await asyncio.sleep(0.01)
        running.remove(task.name)
        return task.name

    tasks = [
        get_task_by_name("browser-auth-minted-email-otp"),
        get_task_by_name("browser-auth-minted-email-otp"),
        get_task_by_name("browser-auth-saved-password-retry"),
        get_task_by_name("browser-auth-assistance-user-signs-in"),
        get_task_by_name("whatsapp-history-recall"),
    ]
    previous = os.environ.get("BENCHMARK_ISOLATED_BROWSER_PROFILES")
    os.environ["BENCHMARK_ISOLATED_BROWSER_PROFILES"] = "1"
    try:
        results = await asyncio.gather(*_parallel_task_runners(tasks, None, runner))
    finally:
        if previous is None:
            os.environ.pop("BENCHMARK_ISOLATED_BROWSER_PROFILES", None)
        else:
            os.environ["BENCHMARK_ISOLATED_BROWSER_PROFILES"] = previous
    assert len(results) == 5 and not overlaps, f"hosted-auth tasks overlapped: {overlaps}"
    assert peak_other >= 2, "unrelated work must still run alongside a hosted-auth task"


def test_hosted_auth_tasks_never_get_the_guest_checkout_kill_switch() -> None:
    from benchmarks.spawn_contract import tasks_require_disabled_saved_browser_auth

    assert tasks_require_disabled_saved_browser_auth(list(TASK_SCENARIOS)) is False


def test_auth_ladder_changes_pull_a_hosted_auth_bench_into_predeploy() -> None:
    from benchmarks.select_predeploy_benches import categories_triggered_by_paths, load_tasks
    from benchmarks.long_horizon import DEFAULT_CATALOG

    for path in (
        "agents/domains/spawn_browser_agent_v3/service_crypto.py",
        "back-end/src/providers/authOptions.ts",
        "back-end/src/domains/auth-test-site/serviceSignIn.ts",
        "agents/benchmarks/auth_test_site.py",
    ):
        assert "auth" in categories_triggered_by_paths([path]), path
    by_name = {task.name: task for task in load_tasks(DEFAULT_CATALOG)}
    assert all(by_name[name].deploy_category == "auth" for name in TASK_SCENARIOS)
    assert by_name["browser-auth-saved-password-retry"].deploy_canary is True


def test_catalog_rejects_inconsistent_hosted_auth_contracts() -> None:
    import copy

    from benchmarks.long_horizon import validate_task_contract

    base = _task_raw("browser-auth-saved-password-retry")
    validate_task_contract(base)

    def rejects(mutate, needle: str) -> None:
        raw = copy.deepcopy(base)
        mutate(raw)
        try:
            validate_task_contract(raw)
        except ValueError as exc:
            assert needle in str(exc), f"expected {needle!r} in {exc}"
            return
        raise AssertionError(f"contract accepted an invalid task ({needle})")

    def outcome(raw: dict) -> dict:
        return next(
            check
            for evaluator in raw["evaluators"]
            for check in evaluator.get("checks") or []
            if check["type"] == "auth_test_site_outcome"
        )

    rejects(lambda raw: raw["environment"].update(auth_test_site={"scenario": "sso"}), "scenario must be one of")
    rejects(lambda raw: raw["environment"].update(mode="live"), "synthetic")
    rejects(lambda raw: raw.update(prompt="Sign in to Rose Shop."), "{auth_test_site_url}")
    rejects(lambda raw: raw.update(enforce_declared_evaluators=False), "enforced auth_test_site_outcome")
    rejects(
        lambda raw: raw.update(evaluators=[e for e in raw["evaluators"] if e["id"] != "saved-password-retry-outcome"]),
        "enforced auth_test_site_outcome",
    )
    rejects(lambda raw: outcome(raw).update(expect="no_session"), "contradicts scenario")
    rejects(lambda raw: outcome(raw).update(signed_in_method="sms"), "signed_in_method")
    rejects(lambda raw: outcome(raw).update(trail=[{"kind": "telepathy"}]), "entries need a kind")
    rejects(lambda raw: outcome(raw).update(counts=[{"kind": "password"}]), "min and/or max")
    rejects(lambda raw: outcome(raw).update(orders={"count": "one"}), "integer count")
    rejects(lambda raw: outcome(raw).update(surprise=True), "unknown keys")
    rejects(
        lambda raw: raw["environment"]["auth_test_site"].update(user_response="shrug"), "user_response must be one of"
    )
    rejects(
        lambda raw: raw["environment"]["auth_test_site"].update(user_response="sign_in"),
        "the user knows a working password",
    )
    rejects(
        lambda raw: raw["environment"]["auth_test_site"].update(user_response="approve_app"),
        "needs scenario password_app_approval",
    )
    rejects(
        lambda raw: raw["environment"]["auth_test_site"].update(first_run_prompt="Sign in again."),
        "first_run_prompt must contain",
    )

    minted = copy.deepcopy(_task_raw("browser-auth-minted-signup"))
    outcome(minted)["require_all_saved_passwords_attempted"] = True
    try:
        validate_task_contract(minted)
    except ValueError as exc:
        assert "saved-password scenario" in str(exc)
    else:
        raise AssertionError("signup accepted a saved-password requirement")

    orphan = copy.deepcopy(base)
    orphan["environment"].pop("auth_test_site")
    try:
        validate_task_contract(orphan)
    except ValueError as exc:
        assert "requires environment.auth_test_site" in str(exc)
    else:
        raise AssertionError("an outcome check without a site was accepted")


def test_manifest_preflight_fails_closed_before_an_agent_exists() -> None:
    from benchmarks.auth_test_site import AuthTestSiteFixtureError, validate_manifest

    for scenario in TASK_SCENARIOS.values():
        validate_manifest(scenario, _manifest(scenario))

    def preview(scenario: str, **changes) -> dict:
        return {"authOptionsPreview": {**_manifest(scenario)["authOptionsPreview"], **changes}}

    def rejects(scenario: str, needle: str, **overrides) -> None:
        try:
            validate_manifest(scenario, _manifest(scenario, **overrides))
        except AuthTestSiteFixtureError as exc:
            assert needle in str(exc), f"expected {needle!r} in {exc}"
            return
        raise AssertionError(f"{scenario} manifest accepted ({needle})")

    rejects("password_retry", "BENCHMARK_DISABLE_SAVED_BROWSER_AUTH", savedBrowserAuthHidden=True)
    rejects("saved_session", "BENCHMARK_DISABLE_SAVED_BROWSER_AUTH", savedBrowserAuthHidden=True)
    rejects("all_fail", "expected 3", savedPasswordUsernames=SAVED[:2])
    rejects("password_retry", "freshest first", **preview("password_retry", passwordUsernames=list(reversed(SAVED))))
    rejects("all_fail", "minted account alongside", **preview("all_fail", mintedEmail=MINTED))
    rejects("all_fail", "0 passkeys, expected 1", **preview("all_fail", passkeyCount=0))
    rejects("saved_session", "0 saved sessions, expected 1", **preview("saved_session", cookieBundleCount=0))
    rejects("signup", "auth options would offer minted account", **preview("signup", mintedEmail=None))
    # A recorded minted login hides Minted; offering it too is the stale state.
    rejects("minted_otp", "minted account alongside", **preview("minted_otp", mintedEmail=MINTED))
    rejects("minted_sms_otp", "needs a minted phone number", mintedPhone=None)
    rejects("email_otp", "must list the connected inbox", **preview("email_otp", emailOtpInboxes=[]))
    rejects("all_fail", "must not have a reachable member account", expectedSignInEmail=SAVED[0])
    try:
        validate_manifest("all_fail", _manifest("password_retry"))
    except AuthTestSiteFixtureError as exc:
        assert "expected 'all_fail'" in str(exc)
    else:
        raise AssertionError("a manifest for another scenario was accepted")
    rejects("minted_otp", "missing siteId/entryUrl", entryUrl="")
    rejects("password_app_approval", "deviceUrl", appApprovalUser=None)
    rejects("password_app_approval", "deviceUrl", appApprovalUser={"expectedNumber": "42"})
    for number in (None, "7", "abc", 123):
        rejects(
            "password_app_approval",
            "two-digit expectedNumber",
            appApprovalUser={**_manifest("password_app_approval")["appApprovalUser"], "expectedNumber": number},
        )
    for lifetime in (None, 0, -1, True, "300"):
        rejects(
            "password_app_approval",
            "positive challengeLifetimeSeconds",
            appApprovalUser={
                **_manifest("password_app_approval")["appApprovalUser"],
                "challengeLifetimeSeconds": lifetime,
            },
        )


def test_outcome_check_grades_the_sites_own_records() -> None:
    from benchmarks.auth_test_site import evaluate_outcome

    retry = _outcome_check("browser-auth-saved-password-retry")
    evidence = {"manifest": _manifest("password_retry"), "report": _retry_report()}
    ok, detail = evaluate_outcome(retry, evidence, f"Your member number is {MEMBER_NUMBER}.")
    assert ok, detail
    assert "password(j.ellis.abc@example.com)→signed_in" in detail

    ok, detail = evaluate_outcome(retry, evidence, "You're signed in to Rose Shop.")
    assert not ok and MEMBER_NUMBER in detail

    # The outcome check grades information, not the output schema's typing: a
    # member number the schema typed as an integer still reaches the user.
    ok, detail = evaluate_outcome(retry, evidence, "Member Number: 12345678")
    assert ok, detail
    ok, detail = evaluate_outcome(retry, evidence, "Member Number: RS 1234 5678")
    assert ok, detail
    ok, detail = evaluate_outcome(retry, evidence, "Member Number: 87654321")
    assert not ok and MEMBER_NUMBER in detail

    lucky = {
        "manifest": _manifest("password_retry"),
        "report": {
            "signInEmail": SAVED[2],
            "attempts": [_attempt("password", SAVED[2], "signed_in")],
            "sessions": [_session(SAVED[2], "password")],
        },
    }
    ok, detail = evaluate_outcome(retry, lucky, MEMBER_NUMBER)
    assert not ok and SAVED[0] in detail, detail

    stuck = {"manifest": _manifest("password_retry"), "report": {**_retry_report(), "sessions": []}}
    ok, detail = evaluate_outcome(retry, stuck, MEMBER_NUMBER)
    assert not ok and "Never signed in as j.ellis.abc@example.com" in detail

    out_of_order = {
        "manifest": _manifest("password_retry"),
        "report": {
            "signInEmail": SAVED[1],
            "attempts": [
                _attempt("password", SAVED[2], "rejected", "wrong_password"),
                _attempt("password", SAVED[0], "rejected", "unknown_account"),
                _attempt("password", SAVED[1], "signed_in"),
            ],
            "sessions": [_session(SAVED[1], "password")],
        },
    }
    ok, detail = evaluate_outcome(retry, out_of_order, MEMBER_NUMBER)
    assert ok, f"the ladder resolves on whichever saved login is tried third: {detail}"

    never_resolved = {
        "manifest": _manifest("password_retry"),
        "report": {**_retry_report(), "signInEmail": None, "sessions": []},
    }
    ok, detail = evaluate_outcome(retry, never_resolved, MEMBER_NUMBER)
    assert not ok and "No member account was ever reachable" in detail, detail

    all_fail = _outcome_check("browser-auth-all-options-fail-assistance")
    ladder = [
        _attempt("session", SAVED[0], "rejected", "expired_session"),
        _attempt("passkey", SAVED[0], "rejected", "passkey_not_recognized"),
        _attempt("password", SAVED[0], "rejected", "wrong_password"),
        _attempt("code_request", SAVED[0], "code_withheld"),
        _attempt("password", SAVED[1], "rejected", "unknown_account"),
        _attempt("password", SAVED[2], "rejected", "wrong_password"),
    ]
    rejected = {
        "browser_page_observation": {"phase": "park_time", "path": "/login/methods"},
        "manifest": _manifest("all_fail", mintedEmail=MINTED),
        "report": {"attempts": ladder, "sessions": [], "lastPagePath": "/login/methods"},
    }
    ok, detail = evaluate_outcome(all_fail, rejected, "")
    assert ok, detail

    def all_fail_with(*, parked_path="/login/methods", **report) -> tuple[bool, str]:
        return evaluate_outcome(all_fail, {**rejected,
            "browser_page_observation": {"phase": "park_time", "path": parked_path},
            "report": {**rejected["report"], **report}}, "")

    ok, detail = all_fail_with(attempts=ladder[:4])
    assert not ok and SAVED[1] in detail
    ok, detail = all_fail_with(sessions=[_session(SAVED[0], "password")])
    assert not ok and "no option should work" in detail
    ok, detail = all_fail_with(attempts=[ladder[1], ladder[0], *ladder[2:]])
    assert not ok and "passkey:rejected was tried before the rung above it" in detail, detail
    ok, detail = all_fail_with(attempts=[*ladder, _attempt("signup", MINTED, "rejected", "signup_unavailable")])
    assert not ok and "minted identity was used" in detail, detail
    ok, detail = all_fail_with(parked_path="/account")
    assert not ok and "not on the sign-in form" in detail, detail

    minted = _outcome_check("browser-auth-minted-email-otp")
    minted_report = {
        "signInEmail": MINTED,
        "attempts": [
            _attempt("code_request", MINTED, "code_sent"),
            _attempt("code_verify", MINTED, "signed_in"),
        ],
        "sessions": [_session(MINTED.upper(), "email_code")],
    }
    ok, detail = evaluate_outcome(minted, {"manifest": _manifest("minted_otp"), "report": minted_report}, MEMBER_NUMBER)
    assert ok, detail
    wrong_method = {**minted_report, "sessions": [_session(MINTED, "password")]}
    ok, detail = evaluate_outcome(minted, {"manifest": _manifest("minted_otp"), "report": wrong_method}, MEMBER_NUMBER)
    assert not ok and "expected email_code" in detail

    ok, detail = evaluate_outcome(retry, None, MEMBER_NUMBER)
    assert not ok and "not captured" in detail
    ok, detail = evaluate_outcome(
        retry, {"manifest": _manifest("password_retry"), "report_error": "404"}, MEMBER_NUMBER
    )
    assert not ok and "report unavailable: 404" in detail


def test_app_approval_outcome_requires_ordered_device_ack_and_sign_in() -> None:
    """A user acknowledgment alone cannot replace the site's authenticated result."""
    from benchmarks.auth_test_site import evaluate_outcome, resolve_goal

    name = "browser-auth-password-app-approval"
    check = _outcome_check(name)
    manifest = _manifest("password_app_approval")
    attempts = [
        _attempt("password", SAVED[0], "pending"),
        _attempt("second_factor", SAVED[0], "pending"),
        _attempt("app_approval", SAVED[0], "approved"),
        _attempt("second_factor", SAVED[0], "signed_in"),
    ]
    report = {
        "signInEmail": SAVED[0],
        "attempts": attempts,
        "sessions": [_session(SAVED[0], "password_app_approval")],
    }

    def evaluate(answer=MEMBER_NUMBER, **changes):
        return evaluate_outcome(check, {"manifest": manifest, "report": {**report, **changes}}, answer)

    ok, detail = evaluate()
    assert ok, detail
    fast_attempts = [{**item, "at": f"2026-10-01T00:00:0{index}.000Z"} for index, item in enumerate(attempts)]
    ok, detail = evaluate(attempts=fast_attempts)
    assert ok, f"the challenge opening and completing are not duplicate submits: {detail}"
    for missing_index in range(4):
        ok, detail = evaluate(attempts=[item for index, item in enumerate(attempts) if index != missing_index])
        assert not ok, f"missing event {missing_index} passed: {detail}"
    ok, detail = evaluate(attempts=[attempts[0], attempts[1], attempts[3], attempts[2]])
    assert not ok and "expected order" in detail, detail
    for duplicate_index in (0, 2, 3):
        duplicate = _attempt(attempts[duplicate_index]["kind"], SAVED[0], attempts[duplicate_index]["outcome"])
        ok, detail = evaluate(attempts=[*attempts, duplicate])
        assert not ok and "time(s)" in detail, detail
    ok, detail = evaluate(sessions=[])
    assert not ok and "Never signed in" in detail, detail
    ok, detail = evaluate(sessions=[_session(SAVED[0], "password")])
    assert not ok and "expected password_app_approval" in detail, detail
    ok, detail = evaluate(answer="I approved the sign-in.")
    assert not ok and MEMBER_NUMBER in detail, detail

    # Only the ordinary site URL enters the agent's task. The approval page and
    # expected number belong to the stand-in user, who acts on another device.
    goal = resolve_goal(_task_raw(name)["prompt"], manifest)
    assert manifest["entryUrl"] in goal
    assert manifest["appApprovalUser"]["deviceUrl"] not in goal
    assert "stand-in-user-only" not in goal


async def test_goal_placeholder_resolves_per_lane_and_fails_closed() -> None:
    from benchmarks import auth_test_site
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _benchmark_goal_for_task

    task = get_task_by_name("browser-auth-saved-password-retry")
    try:
        _benchmark_goal_for_task(task, "http://localhost:3201")
    except auth_test_site.AuthTestSiteFixtureError as exc:
        assert "no auth test site was created" in str(exc)
    else:
        raise AssertionError("goal resolved without a seeded site")

    async def lane(site_id: str) -> str:
        manifest = _manifest("password_retry", entryUrl=f"https://rose-x.ngrok.app/site/{site_id}/")
        auth_test_site.set_active_manifest(manifest)
        await asyncio.sleep(0.01)
        return _benchmark_goal_for_task(task, "http://localhost:3201")

    first, second = await asyncio.gather(lane("one"), lane("two"))
    assert "https://rose-x.ngrok.app/site/one/" in first and "/site/two/" not in first
    assert "https://rose-x.ngrok.app/site/two/" in second and "/site/one/" not in second
    assert auth_test_site.active_manifest() is None
    assert "{auth_test_site_url}" not in first


class _FakeBackend:
    """Stands in for the local backend's /api/rose-shop/fixtures routes."""

    def __init__(self, scenario: str, report: dict) -> None:
        self.requests: list[tuple[str, str, dict | None, dict]] = []
        backend = self

        class Handler(BaseHTTPRequestHandler):
            def _reply(self, status: int, payload: dict) -> None:
                body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _record(self, body: dict | None) -> None:
                # HTTP header names are case-insensitive and clients differ in the casing they send.
                headers = {name.lower(): value for name, value in self.headers.items()}
                backend.requests.append((self.command, self.path, body, headers))

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                self._record(body)
                self._reply(201, _manifest(scenario))

            def do_GET(self) -> None:
                self._record(None)
                self._reply(200, {**report, "siteId": "abc123", "scenario": scenario})

            def do_DELETE(self) -> None:
                self._record(None)
                self._reply(200, {"siteId": "abc123", "deleted": {"passwords": 3, "mintedAccounts": 0}})

            def log_message(self, *_args) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base_url = f"http://localhost:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> "_FakeBackend":
        self.thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self.server.shutdown()
        self.server.server_close()


async def test_runner_seeds_grades_and_deletes_the_site() -> None:
    from benchmarks import auth_test_site
    from benchmarks import run_benchmark as rb
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("browser-auth-saved-password-retry")
    headers = {"X-API-Key": "fixture-key", "X-User-Id": "user-1", "Content-Type": "application/json"}

    async def fake_headers() -> dict:
        return dict(headers)

    previous_frontend = os.environ.get("BENCHMARK_FRONTEND_URL")
    os.environ["BENCHMARK_FRONTEND_URL"] = "https://rose-x.ngrok.app/"
    try:
        with (
            _FakeBackend("password_retry", _retry_report()) as backend,
            patch.object(rb, "_api_headers", fake_headers),
            patch.object(rb, "_current_benchmark_user_id", lambda: "user-1"),
        ):
            manifest = await rb._apply_auth_test_site(task, backend.base_url)
            assert manifest is not None and auth_test_site.active_manifest() == manifest
            method, path, body, sent_headers = backend.requests[0]
            assert (method, path) == ("POST", "/api/rose-shop/fixtures")
            assert body == {
                "userId": "user-1",
                "scenario": "password_retry",
                "publicBaseUrl": "https://rose-x.ngrok.app",
            }
            assert sent_headers.get("x-api-key") == "fixture-key"
            assert manifest["entryUrl"] in rb._benchmark_goal_for_task(task, backend.base_url)

            data = {
                "agent": {"status": "COMPLETED"},
                "messages": [
                    {
                        "role": "ASSISTANT",
                        "message": "Done",
                        "metadata": {
                            "toolName": "completion_summary",
                            "toolStatus": "FINISHED",
                            "completionSummary": {"summary": f"Your Rose Shop member number is {MEMBER_NUMBER}."},
                        },
                    }
                ],
            }
            await rb._hydrate_auth_test_site_evidence(data, backend.base_url)
            assert backend.requests[1][:2] == ("GET", "/api/rose-shop/fixtures/abc123/report")
            outcome_evaluator = next(e for e in task.evaluators if e["id"] == "saved-password-retry-outcome")
            ok, detail = rb._run_declared_static_check(task, outcome_evaluator, data)
            assert ok, detail

            data["messages"][0]["metadata"]["completionSummary"]["summary"] = "Signed in."
            ok, detail = rb._run_declared_static_check(task, outcome_evaluator, data)
            assert not ok and MEMBER_NUMBER in detail

            data["messages"][0]["metadata"]["completionSummary"] = {
                "summary": "I signed in to your Rose Shop account and verified your member number.",
                "outputs": [{"key": "member_number", "label": "Member Number", "value": MEMBER_NUMBER}],
            }
            ok, detail = rb._run_declared_static_check(task, outcome_evaluator, data)
            assert ok, f"the completion card's structured outputs are part of the final answer: {detail}"

            await rb._release_auth_test_site(backend.base_url, manifest)
            assert backend.requests[2][:2] == ("DELETE", "/api/rose-shop/fixtures/abc123?userId=user-1")
            assert auth_test_site.active_manifest() is None

        unrelated = get_task_by_name("whatsapp-history-recall")
        assert await rb._apply_auth_test_site(unrelated, "http://localhost:1") is None
        try:
            await rb._apply_auth_test_site(task, "https://navi-j9a9.onrender.com")
        except RuntimeError as exc:
            assert "local benchmark stack" in str(exc)
        else:
            raise AssertionError("hosted auth site was created against a non-local backend")
    finally:
        auth_test_site.set_active_manifest(None)
        if previous_frontend is None:
            os.environ.pop("BENCHMARK_FRONTEND_URL", None)
        else:
            os.environ["BENCHMARK_FRONTEND_URL"] = previous_frontend


async def test_missing_report_fails_the_outcome_check_closed() -> None:
    from benchmarks import auth_test_site
    from benchmarks import run_benchmark as rb
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("browser-auth-minted-email-otp")
    data: dict = {"messages": []}
    await rb._hydrate_auth_test_site_evidence(data, "http://localhost:1")
    evaluator = next(e for e in task.evaluators if e["id"] == "minted-email-otp-outcome")
    ok, detail = rb._run_declared_static_check(task, evaluator, data)
    assert not ok and "no auth test site was created" in detail
    assert auth_test_site.active_manifest() is None


def test_outcome_check_fails_a_form_that_reached_the_site_twice() -> None:
    """One click is one submit: the browser re-sending a sign-in form doubles a
    failed attempt against the account, and would double an order."""
    from benchmarks.auth_test_site import evaluate_outcome

    retry = _outcome_check("browser-auth-saved-password-retry")
    report = _retry_report()
    first = report["attempts"][0]
    echo = dict(first)
    echo["at"] = (
        (datetime.fromisoformat(first["at"].replace("Z", "+00:00")) + timedelta(seconds=4.3))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    report["attempts"].insert(1, echo)
    ok, detail = evaluate_outcome(retry, {"manifest": _manifest("password_retry"), "report": report}, MEMBER_NUMBER)
    assert not ok and "reached the site twice 4.3s apart" in detail, detail

    # The same login tried again a full agent step later is a retry, not an echo.
    echo["at"] = (
        (datetime.fromisoformat(first["at"].replace("Z", "+00:00")) + timedelta(seconds=20))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    ok, detail = evaluate_outcome(retry, {"manifest": _manifest("password_retry"), "report": report}, MEMBER_NUMBER)
    assert ok, detail


def test_outcome_check_grades_orders_accounts_and_second_runs() -> None:
    from benchmarks.auth_test_site import evaluate_outcome

    key = _outcome_check("browser-auth-signup-purchase")
    account = {"email": MINTED, "memberNumber": MEMBER_NUMBER, "origin": "signup", "verified": True}
    order = {
        "orderNumber": "ORD-10000001",
        "email": MINTED,
        "totalCents": 2123,
        "purchaseId": "p1",
        "itemIds": ["canvas-tote"],
    }
    bought = {
        "signInEmail": MINTED,
        "attempts": [
            _attempt("signup", MINTED, "pending"),
            _attempt("signup_verify", MINTED, "signed_in"),
            _attempt("order", MINTED, "placed"),
        ],
        "sessions": [_session(MINTED, "signup")],
        "accounts": [account],
        "orders": [order],
    }

    def key_with(answer: str = "Order ORD-10000001 is placed.", **report) -> tuple[bool, str]:
        return evaluate_outcome(key, {"manifest": _manifest("signup_purchase"), "report": {**bought, **report}}, answer)

    ok, detail = key_with()
    assert ok, detail
    ok, detail = key_with(orders=[order, {**order, "orderNumber": "ORD-10000002"}])
    assert not ok and "2 order(s); expected exactly 1" in detail, detail
    ok, detail = key_with(orders=[{**order, "email": None}])
    assert not ok and "placed by a guest" in detail, detail
    ok, detail = key_with(accounts=[{**account, "verified": False}])
    assert not ok and "0 verified new account(s)" in detail, detail
    ok, detail = key_with(answer="Your tote is on its way.")
    assert not ok and "ORD-10000001" in detail, detail

    guest = _outcome_check("browser-auth-guest-purchase")
    guest_report = {
        "attempts": [_attempt("guest", "", "started"), _attempt("order", "", "placed")],
        "sessions": [],
        "orders": [{**order, "email": None}],
    }
    ok, detail = evaluate_outcome(
        guest, {"manifest": _manifest("guest_purchase"), "report": guest_report}, "ORD-10000001"
    )
    assert ok, detail
    signed_up = {**guest_report, "attempts": [_attempt("signup", MINTED, "pending"), *guest_report["attempts"]]}
    ok, detail = evaluate_outcome(guest, {"manifest": _manifest("guest_purchase"), "report": signed_up}, "ORD-10000001")
    assert not ok and "signup" in detail and "must not happen" in detail, detail

    reoffer = _outcome_check("browser-auth-failed-login-not-reoffered")
    two_runs = {
        "signInEmail": SAVED[1],
        "attempts": [
            _attempt("password", SAVED[0], "rejected", "wrong_password"),
            _attempt("password", SAVED[1], "signed_in"),
            _attempt("run_marker", "graded-run", "started"),
            _attempt("password", SAVED[1], "signed_in"),
        ],
        "sessions": [_session(SAVED[1], "password"), _session(SAVED[1], "password")],
        "savedPasswords": [
            {"username": SAVED[0], "matchesAccount": False, "disabledAt": "2026-10-01T00:00:02.000Z"},
            {"username": SAVED[1], "matchesAccount": True, "disabledAt": None},
        ],
    }

    def reoffer_with(**report) -> tuple[bool, str]:
        evidence = {"manifest": _manifest("failed_login_not_reoffered"), "report": {**two_runs, **report}}
        return evaluate_outcome(reoffer, evidence, MEMBER_NUMBER)

    ok, detail = reoffer_with()
    assert ok, detail
    still_offered = [{**two_runs["savedPasswords"][0], "disabledAt": None}, two_runs["savedPasswords"][1]]
    ok, detail = reoffer_with(savedPasswords=still_offered)
    assert not ok and "is still offered" in detail, detail
    again = _attempt("password", SAVED[0], "rejected", "wrong_password")
    retried = [*two_runs["attempts"][:3], again, _attempt("password", SAVED[1], "signed_in")]
    ok, detail = reoffer_with(attempts=retried)
    assert not ok and "in the second run" in detail, detail
    ok, detail = reoffer_with(attempts=two_runs["attempts"][:2])
    assert not ok and "no second run" in detail, detail

    named = _outcome_check("browser-auth-named-account")
    wrong_account = {
        "signInEmail": SAVED[1],
        "attempts": [_attempt("password", SAVED[0], "signed_in"), _attempt("password", SAVED[1], "signed_in")],
        "sessions": [_session(SAVED[0], "password"), _session(SAVED[1], "password")],
    }
    ok, detail = evaluate_outcome(
        named, {"manifest": _manifest("named_account"), "report": wrong_account}, MEMBER_NUMBER
    )
    assert not ok and "wrong account" in detail, detail

    never_arrives = _outcome_check("browser-auth-code-never-arrives")
    one_request = {"attempts": [_attempt("code_request", MINTED, "code_withheld")], "sessions": []}
    ok, detail = evaluate_outcome(
        never_arrives, {"manifest": _manifest("code_never_arrives"), "report": one_request}, ""
    )
    assert not ok and "1 time(s)" in detail, detail


async def test_goal_names_the_account_and_first_run_precedes_the_graded_run() -> None:
    from benchmarks import auth_test_site
    from benchmarks import run_benchmark as rb
    from benchmarks.benchmark_tasks import get_task_by_name

    named = get_task_by_name("browser-auth-named-account")
    try:
        auth_test_site.set_active_manifest(_manifest("named_account"))
        goal = rb._benchmark_goal_for_task(named, "http://localhost:3201")
        assert SAVED[1] in goal and "{auth_test_site_account}" not in goal, goal
        auth_test_site.set_active_manifest(_manifest("password_retry"))
        try:
            rb._benchmark_goal_for_task(named, "http://localhost:3201")
        except auth_test_site.AuthTestSiteFixtureError as exc:
            assert "names no account" in str(exc)
        else:
            raise AssertionError("a named-account goal resolved without a named account")
    finally:
        auth_test_site.set_active_manifest(None)

    task = get_task_by_name("browser-auth-created-account-reused")
    headers = {"X-API-Key": "fixture-key", "X-User-Id": "user-1", "Content-Type": "application/json"}

    async def fake_headers() -> dict:
        return dict(headers)

    created_goals: list[str] = []
    first_run_status = {"value": "COMPLETED"}

    async def fake_create_agent(base_url: str, first_task) -> str:
        created_goals.append(rb._benchmark_goal_for_task(first_task, base_url))
        assert first_task.evaluators == [] and first_task.enforce_declared_evaluators is False
        return "first-run-agent"

    async def fake_poll_agent(base_url: str, agent_id: str, first_task, *_args):
        return {"agent": {"status": first_run_status["value"]}}, 0, 0, None

    previous_frontend = os.environ.get("BENCHMARK_FRONTEND_URL")
    os.environ["BENCHMARK_FRONTEND_URL"] = "https://rose-x.ngrok.app/"
    try:
        with (
            _FakeBackend("created_account_reused", {}) as backend,
            patch.object(rb, "_api_headers", fake_headers),
            patch.object(rb, "_current_benchmark_user_id", lambda: "user-1"),
            patch.object(rb, "create_agent", fake_create_agent),
            patch.object(rb, "poll_agent", fake_poll_agent),
        ):
            manifest = await rb._apply_auth_test_site(task, backend.base_url)
            assert manifest is not None and manifest["firstRunAgentId"] == "first-run-agent"
            assert len(created_goals) == 1 and created_goals[0].startswith("Create an account for me at https://")
            assert [request[:2] for request in backend.requests] == [
                ("POST", "/api/rose-shop/fixtures"),
                ("POST", "/api/rose-shop/fixtures/abc123/mark"),
            ], backend.requests
            assert backend.requests[1][2] == {"label": "graded-run"}
            assert rb._benchmark_goal_for_task(task, backend.base_url).startswith(
                "Tell me my member number for https://"
            )
            await rb._release_auth_test_site(backend.base_url, manifest)

            first_run_status["value"] = "FAILED"
            backend.requests.clear()
            try:
                await rb._apply_auth_test_site(task, backend.base_url)
            except auth_test_site.AuthTestSiteFixtureError as exc:
                assert "first run did not complete" in str(exc)
            else:
                raise AssertionError("a failed first run was allowed to continue into the graded run")
            # Teardown names the benchmark user so the backend can remove the rows
            # even when it no longer holds the site in memory.
            assert backend.requests[-1][:2] == ("DELETE", "/api/rose-shop/fixtures/abc123?userId=user-1"), (
                backend.requests
            )
            assert auth_test_site.active_manifest() is None
    finally:
        auth_test_site.set_active_manifest(None)
        if previous_frontend is None:
            os.environ.pop("BENCHMARK_FRONTEND_URL", None)
        else:
            os.environ["BENCHMARK_FRONTEND_URL"] = previous_frontend


async def test_lane_after_a_connected_inbox_waits_out_the_cached_user_context() -> None:
    """The worker caches user context for five minutes. After the email-otp lane
    the next lane's root agent still saw that lane's fixture inbox as the user's
    connected email and signed up with it."""
    import benchmarks.run_benchmark as rb
    from benchmarks import auth_test_site

    slept: list[float] = []

    async def fake_sleep(seconds):
        slept.append(seconds)

    async def fake_delete(base_url, headers, site_id, user_id=None):
        return None

    async def fake_headers():
        return {}

    manifest = _manifest("email_otp")
    manifest["authOptionsPreview"] = {**manifest.get("authOptionsPreview", {}), "emailOtpInboxes": ["a@mail.example"]}
    plain = _manifest("password_retry")
    with (
        patch.object(rb.asyncio, "sleep", fake_sleep),
        patch.object(rb, "_api_headers", fake_headers),
        patch.object(auth_test_site, "delete_site", fake_delete),
    ):
        rb._connected_inbox_released_at = None
        await rb._release_auth_test_site("http://localhost:1", plain)
        assert await rb._wait_out_connected_inbox_context() == 0.0 and slept == [], "ordinary lanes add no wait"

        await rb._release_auth_test_site("http://localhost:1", manifest)
        released = rb._connected_inbox_released_at
        assert released is not None
        waited = await rb._wait_out_connected_inbox_context(now=lambda: released + 100)
        assert abs(waited - (rb.USER_CONTEXT_CACHE_SECONDS - 100)) < 1 and slept == [waited], (waited, slept)
        assert await rb._wait_out_connected_inbox_context() == 0.0, "the wait is paid once"

        await rb._release_auth_test_site("http://localhost:1", manifest)
        released = rb._connected_inbox_released_at
        assert await rb._wait_out_connected_inbox_context(now=lambda: released + 3600) == 0.0, "already expired"
    from helpers.get_user_context import CACHE_TTL_MINUTES

    assert rb.USER_CONTEXT_CACHE_SECONDS > CACHE_TTL_MINUTES * 60, "the wait must outlast the worker's cache"


async def test_stand_in_user_signs_in_or_declines_a_sign_in_help_request() -> None:
    from benchmarks import auth_assistance_user, auth_test_site
    from benchmarks import run_benchmark as rb

    # The request names only the browser session; the task id is on the agent's own message.
    request = {"id": "req-12345678", "metadata": {"requestUserAuthentication": {"requestId": "req-12345678"}}}
    announcement = {
        "role": "TOOL",
        "metadata": {
            "action_type": "auth_assistance",
            "requestUserAuthentication": {"requestId": "req-12345678", "taskId": "browser-task-1"},
        },
    }
    other = {"role": "TOOL", "metadata": {"requestUserAuthentication": {"requestId": "another", "taskId": "task-9"}}}
    assert auth_assistance_user.browser_task_id(request, [other, announcement]) == "browser-task-1"
    assert auth_assistance_user.browser_task_id(request, [other]) is None

    polls = {"count": 0}

    async def fake_get_agent(base_url, agent_id):
        polls["count"] += 1
        return {"messages": [other] if polls["count"] == 1 else [other, announcement]}

    calls: list[tuple] = []

    async def fake_headers() -> dict:
        return {"X-API-Key": "fixture-key"}

    async def fake_sign_in(base_url, headers, req, task_id, credentials, sign_in_url=None):
        # The stand-in knows the site's sign-in page: the agent may have left a code page open.
        assert sign_in_url == "https://rose-x.ngrok.app/api/rose-shop/abc123/login?authRealm=rose-shop-abc123", (
            sign_in_url
        )
        calls.append(("sign_in", req["id"], task_id, credentials["email"], credentials["password"]))
        return "https://site/account"

    async def no_sleep(_seconds):
        return None

    async def fake_decline(base_url, headers, req):
        calls.append(("decline", req["id"]))

    async def fake_mark(base_url, headers, site_id, label):
        calls.append(("mark", site_id, label))

    try:
        with (
            patch.object(rb, "_api_headers", fake_headers),
            patch.object(auth_assistance_user, "sign_in_as_user", fake_sign_in),
            patch.object(auth_assistance_user, "decline", fake_decline),
            patch.object(auth_test_site, "mark_run", fake_mark),
            patch.object(rb, "get_agent", fake_get_agent),
            patch.object(rb.asyncio, "sleep", no_sleep),
        ):
            auth_test_site.set_active_manifest(_manifest("user_signs_in"))
            await rb._respond_as_user_to_auth_assistance("http://localhost:1", "agent-1", request, "sign_in")
            assert calls == [("sign_in", "req-12345678", "browser-task-1", SAVED[0], "only-the-user-knows")], calls
            assert polls["count"] == 2, "the stand-in waits for the agent's message instead of failing"

            calls.clear()
            auth_test_site.set_active_manifest(_manifest("saved_logins_fail"))
            await rb._respond_as_user_to_auth_assistance("http://localhost:1", "agent-1", request, "decline")
            assert calls == [("decline", "req-12345678"), ("mark", "abc123", "user-declined")], calls

            try:
                await rb._respond_as_user_to_auth_assistance("http://localhost:1", "agent-1", request, "sign_in")
            except RuntimeError as exc:
                assert "no password for the user" in str(exc)
            else:
                raise AssertionError("the stand-in user signed in without a password to type")
    finally:
        auth_test_site.set_active_manifest(None)


async def test_stand_in_user_approves_on_separate_device_before_resuming() -> None:
    """The helper acknowledges in an isolated app, without entering any password."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, MagicMock

    import httpx

    from benchmarks import auth_assistance_user as user

    calls: list[tuple] = []
    failure = {"value": None}

    async def goto(url, **kwargs):
        calls.append(("device", url))
        return SimpleNamespace(
            ok=failure["value"] != "device_http", status=503 if failure["value"] == "device_http" else 200
        )

    async def fill(number):
        calls.append(("number", number))

    async def click():
        calls.append(("approve",))

    async def wait_for(**kwargs):
        calls.append(("ack",))
        if failure["value"] == "ack":
            raise RuntimeError("no acknowledgment at secret-device-url")

    page = MagicMock()
    page.goto = AsyncMock(side_effect=goto)
    page.get_by_label.return_value.fill = AsyncMock(side_effect=fill)
    page.get_by_role.return_value.click = AsyncMock(side_effect=click)
    page.locator.return_value.wait_for = AsyncMock(side_effect=wait_for)
    context = SimpleNamespace(new_page=AsyncMock(return_value=page))
    browser = SimpleNamespace(new_context=AsyncMock(return_value=context), close=AsyncMock())
    chromium = SimpleNamespace(launch=AsyncMock(return_value=browser), connect_over_cdp=AsyncMock())
    playwright_context = MagicMock()
    playwright_context.__aenter__ = AsyncMock(return_value=SimpleNamespace(chromium=chromium))
    playwright_context.__aexit__ = AsyncMock(return_value=None)
    lookup = {"count": 0}

    def handle(request):
        assert request.headers["X-User-Id"] == "user-1"
        if request.method == "GET":
            assert request.url.path == "/api/browser-session/task/browser-1"
            assert request.url.params["validateLive"] == "true"
            lookup["count"] += 1
            calls.append(("live", lookup["count"]))
            if failure["value"] == "lookup_http":
                return httpx.Response(502, text="unavailable")
            available = not (failure["value"] == "retired" and lookup["count"] == 2)
            changed = failure["value"] == "changed" and lookup["count"] == 2
            return httpx.Response(
                200,
                json={
                    "same_session_available": available,
                    "ws_url": "ws://browser.invalid/changed" if changed else "ws://browser.invalid/original",
                },
            )
        assert request.method == "POST" and request.url.path == "/api/auth-assistance/request-1/complete"
        assert json.loads(request.content) == {}
        calls.append(("complete", "request-1"))
        return httpx.Response(503 if failure["value"] == "complete_http" else 200, json={})

    real_client = httpx.AsyncClient

    def client(**kwargs):
        return real_client(transport=httpx.MockTransport(handle), **kwargs)

    request = {"id": "request-1"}
    app = {"deviceUrl": "https://device.invalid/secret-device-url", "expectedNumber": "42"}
    headers = {"X-User-Id": "user-1"}
    with (
        patch("playwright.async_api.async_playwright", return_value=playwright_context),
        patch.object(user.httpx, "AsyncClient", client),
        patch.object(user, "_type_credentials", AsyncMock(side_effect=AssertionError("user must not type a password"))),
    ):
        await user.approve_app_as_user("http://backend.invalid/", headers, request, "browser-1", app)
        assert calls == [
            ("live", 1),
            ("device", app["deviceUrl"]),
            ("number", "42"),
            ("approve",),
            ("ack",),
            ("live", 2),
            ("complete", "request-1"),
        ], calls
        chromium.launch.assert_awaited_once_with(headless=True)
        chromium.connect_over_cdp.assert_not_awaited()
        browser.new_context.assert_awaited_once_with()
        browser.close.assert_awaited_once()
        page.get_by_label.assert_called_once_with("Sign-in number", exact=True)
        page.get_by_role.assert_called_once_with("button", name="Approve sign-in", exact=True)
        page.locator.assert_called_once_with("[data-app-approval-status='approved']")

        # The same driver can acknowledge an app that requires no matching number.
        calls.clear()
        lookup["count"] = 0
        await user.approve_app_as_user(
            "http://backend.invalid", headers, request, "browser-1", {"deviceUrl": app["deviceUrl"]}
        )
        assert not any(call[0] == "number" for call in calls), calls
        assert calls[-1] == ("complete", "request-1")

        for fault, expected in (
            ("lookup_http", "lookup failed 502"),
            ("device_http", "open successfully (503)"),
            ("ack", "did not confirm"),
            ("retired", "not left running"),
            ("changed", "session changed"),
            ("complete_http", "request failed 503"),
        ):
            calls.clear()
            lookup["count"] = 0
            failure["value"] = fault
            try:
                await user.approve_app_as_user("http://backend.invalid", headers, request, "browser-1", app)
            except user.AuthAssistanceUserError as exc:
                assert expected in str(exc), (fault, str(exc))
                assert "secret-device-url" not in str(exc)
            else:
                raise AssertionError(f"app approval ignored {fault}")
            if fault != "complete_http":
                assert not any(call[0] == "complete" for call in calls), (fault, calls)

        failure["value"] = None
        for bad_request, task_id, bad_app, expected in (
            ({}, "browser-1", app, "missing its id"),
            (request, "", app, "browser task id"),
            (request, "browser-1", {}, "no approval app URL"),
            (request, "browser-1", {**app, "expectedNumber": "wrong"}, "two digits"),
        ):
            calls.clear()
            try:
                await user.approve_app_as_user("http://backend.invalid", headers, bad_request, task_id, bad_app)
            except user.AuthAssistanceUserError as exc:
                assert expected in str(exc), str(exc)
            else:
                raise AssertionError("app approval accepted incomplete inputs")
            assert calls == [], "input validation must precede browser/device work"


async def test_runner_routes_app_approval_to_the_real_auth_request() -> None:
    from unittest.mock import AsyncMock

    from benchmarks import auth_assistance_user, auth_test_site
    from benchmarks import run_benchmark as rb

    request = {"id": "request-2", "metadata": {"requestUserAuthentication": {"requestId": "request-2"}}}
    announcement = {"metadata": {"requestUserAuthentication": {"requestId": "request-2", "taskId": "browser-2"}}}
    app = {"deviceUrl": "https://device.invalid/secret", "expectedNumber": "42"}
    headers = {"X-User-Id": "user-1"}
    approve = AsyncMock()
    try:
        auth_test_site.set_active_manifest({"appApprovalUser": app})
        with (
            patch.object(rb, "_api_headers", AsyncMock(return_value=headers)),
            patch.object(rb, "get_agent", AsyncMock(return_value={"messages": [announcement]})),
            patch.object(auth_assistance_user, "approve_app_as_user", approve),
            patch.object(
                auth_assistance_user, "sign_in_as_user", AsyncMock(side_effect=AssertionError("no user password"))
            ),
        ):
            await rb._respond_as_user_to_auth_assistance("http://backend.invalid", "agent-2", request, "approve_app")
            approve.assert_awaited_once_with("http://backend.invalid", headers, request, "browser-2", app)

            approve.reset_mock()
            for bad_request, manifest, expected in (
                ({"id": "wrong-kind"}, {"appApprovalUser": app}, "requires an auth-assistance request"),
                (request, {}, "no approval app"),
            ):
                auth_test_site.set_active_manifest(manifest)
                try:
                    await rb._respond_as_user_to_auth_assistance(
                        "http://backend.invalid", "agent-2", bad_request, "approve_app"
                    )
                except RuntimeError as exc:
                    assert expected in str(exc), str(exc)
                else:
                    raise AssertionError("the runner acknowledged without a usable real request/manifest")
            approve.assert_not_awaited()
    finally:
        auth_test_site.set_active_manifest(None)




async def test_park_time_native_observation_survives_activity_manager_and_hydration():
    from auth_park_measurement_fixture import run_pipeline
    await run_pipeline()

async def test_root_park_measurement_uses_real_workflow_state_owner():
    from auth_park_measurement_fixture import run_pipeline
    for mode in ('no_bus', 'bus'):
        await run_pipeline(workflow_root_mode=mode)

async def test_unrelated_tasks_do_not_acquire_park_measurement_judge_inputs():
    from auth_park_measurement_fixture import check_unrelated_task_measurement_input_absence
    await check_unrelated_task_measurement_input_absence()

async def run_all_tests():
    print("auth-test-site-benchmark blackbox tests:")
    runner = BlackboxResult()
    await runner.record_async("root_park_measurement_uses_real_workflow_state_owner", test_root_park_measurement_uses_real_workflow_state_owner)
    await runner.record_async(
        "unrelated_tasks_do_not_acquire_park_measurement_judge_inputs",
        test_unrelated_tasks_do_not_acquire_park_measurement_judge_inputs,
    )
    runner.record(
        "daily_catalog_covers_every_hosted_auth_branch_with_natural_prompts",
        test_daily_catalog_covers_every_hosted_auth_branch_with_natural_prompts,
    )
    await runner.record_async(
        "hosted_auth_tasks_never_overlap_on_one_stack",
        test_hosted_auth_tasks_never_overlap_on_one_stack,
    )
    runner.record(
        "hosted_auth_tasks_never_get_the_guest_checkout_kill_switch",
        test_hosted_auth_tasks_never_get_the_guest_checkout_kill_switch,
    )
    runner.record(
        "auth_ladder_changes_pull_a_hosted_auth_bench_into_predeploy",
        test_auth_ladder_changes_pull_a_hosted_auth_bench_into_predeploy,
    )
    runner.record(
        "catalog_rejects_inconsistent_hosted_auth_contracts",
        test_catalog_rejects_inconsistent_hosted_auth_contracts,
    )
    runner.record(
        "manifest_preflight_fails_closed_before_an_agent_exists",
        test_manifest_preflight_fails_closed_before_an_agent_exists,
    )
    runner.record(
        "outcome_check_grades_the_sites_own_records",
        test_outcome_check_grades_the_sites_own_records,
    )
    runner.record(
        "app_approval_outcome_requires_ordered_device_ack_and_sign_in",
        test_app_approval_outcome_requires_ordered_device_ack_and_sign_in,
    )
    await runner.record_async(
        "goal_placeholder_resolves_per_lane_and_fails_closed",
        test_goal_placeholder_resolves_per_lane_and_fails_closed,
    )
    await runner.record_async(
        "runner_seeds_grades_and_deletes_the_site",
        test_runner_seeds_grades_and_deletes_the_site,
    )
    await runner.record_async(
        "missing_report_fails_the_outcome_check_closed",
        test_missing_report_fails_the_outcome_check_closed,
    )
    runner.record(
        "outcome_check_fails_a_form_that_reached_the_site_twice",
        test_outcome_check_fails_a_form_that_reached_the_site_twice,
    )
    runner.record(
        "outcome_check_grades_orders_accounts_and_second_runs",
        test_outcome_check_grades_orders_accounts_and_second_runs,
    )
    await runner.record_async(
        "lane_after_a_connected_inbox_waits_out_the_cached_user_context",
        test_lane_after_a_connected_inbox_waits_out_the_cached_user_context,
    )
    await runner.record_async(
        "goal_names_the_account_and_first_run_precedes_the_graded_run",
        test_goal_names_the_account_and_first_run_precedes_the_graded_run,
    )
    await runner.record_async(
        "stand_in_user_signs_in_or_declines_a_sign_in_help_request",
        test_stand_in_user_signs_in_or_declines_a_sign_in_help_request,
    )
    await runner.record_async(
        "stand_in_user_approves_on_separate_device_before_resuming",
        test_stand_in_user_approves_on_separate_device_before_resuming,
    )
    await runner.record_async(
        "runner_routes_app_approval_to_the_real_auth_request",
        test_runner_routes_app_approval_to_the_real_auth_request,
    )
    await runner.record_async("park_time_native_observation_survives_activity_manager_and_hydration", test_park_time_native_observation_survives_activity_manager_and_hydration)
    return runner.all_passed
