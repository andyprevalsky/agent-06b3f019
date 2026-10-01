"""Black-box coverage for the hosted Larkspur Members auth benchmarks.

The three daily tasks share one natural prompt; only the seeded fixture decides
whether the correct end state is a password retry, an auth-assistance request,
or a minted-identity email-code sign-in. These tests pin that contract, the
fail-closed fixture preflight, the evaluator, and the runner's site lifecycle.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from _test_utils import BlackboxResult

TASK_SCENARIOS = {
    "browser-auth-saved-password-retry": "password_retry",
    "browser-auth-all-options-fail-assistance": "all_fail",
    "browser-auth-minted-email-otp": "minted_otp",
}
SAVED = ["jordan.ellis.abc@example.com", "jordan.e.abc@example.com", "j.ellis.abc@example.com"]
MINTED = "rose-agent-7@mail.example.test"
MEMBER_NUMBER = "LM-12345678"


def _manifest(scenario: str, **overrides) -> dict:
    password_scenario = scenario != "minted_otp"
    manifest = {
        "siteId": "abc123",
        "scenario": scenario,
        "realm": "larkspur-abc123.test",
        "entryUrl": "https://rose-x.ngrok.app/api/test-sites/larkspur/abc123/?authRealm=larkspur-abc123.test",
        "savedPasswordUsernames": list(SAVED) if password_scenario else [],
        "mintedEmail": None if password_scenario else MINTED,
        "expectedSignInEmail": MINTED if scenario == "minted_otp" else None,
        "expectedMemberNumber": None if scenario == "all_fail" else MEMBER_NUMBER,
        "savedBrowserAuthHidden": False,
        "authOptionsPreview": {
            "passwordUsernames": list(SAVED) if password_scenario else [],
            "mintedEmail": None if password_scenario else MINTED,
        },
    }
    manifest.update(overrides)
    return manifest


def _attempt(kind: str, email: str, outcome: str, reason: str | None = None) -> dict:
    return {"at": "2026-10-01T00:00:00.000Z", "kind": kind, "email": email, "outcome": outcome, "reason": reason}


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


def test_daily_catalog_covers_every_hosted_auth_branch_with_one_natural_prompt() -> None:
    from benchmarks.auth_test_site import AUTH_TEST_SITE_SCENARIOS
    from benchmarks.benchmark_tasks import get_task_by_name

    prompts = set()
    for name, scenario in TASK_SCENARIOS.items():
        task = get_task_by_name(name)
        assert task.group == "daily" and task.status == "ready", name
        assert task.environment["mode"] == "synthetic" and not task.environment.get("live_fixtures"), name
        assert task.environment["auth_test_site"] == {"scenario": scenario}, name
        assert task.enforce_declared_evaluators is True, name
        assert task.requires_browser_agent is True, name
        prompts.add(task.prompt)
    assert set(TASK_SCENARIOS.values()) == set(AUTH_TEST_SITE_SCENARIOS)
    assert len(prompts) == 1, f"fixtures, not prompts, must decide the branch: {prompts}"
    prompt = prompts.pop().lower()
    assert "{auth_test_site_url}" in prompt
    for hint in ("password", "minted", "code", "otp", "assist", "help", "retry", "email"):
        assert hint not in prompt, f"prompt leaks the expected auth branch via {hint!r}"

    assert get_task_by_name("browser-auth-all-options-fail-assistance").expected_attention_kind == "auth_assistance"
    assert _outcome_check("browser-auth-saved-password-retry")["require_all_saved_passwords_attempted"] is True
    assert _outcome_check("browser-auth-all-options-fail-assistance")["require_all_saved_passwords_attempted"] is True
    assert _outcome_check("browser-auth-minted-email-otp")["signed_in_method"] == "email_code"


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
    rejects(lambda raw: raw.update(prompt="Sign in to Larkspur Members."), "{auth_test_site_url}")
    rejects(lambda raw: raw.update(enforce_declared_evaluators=False), "enforced auth_test_site_outcome")
    rejects(
        lambda raw: raw.update(evaluators=[e for e in raw["evaluators"] if e["id"] != "saved-password-retry-outcome"]),
        "enforced auth_test_site_outcome",
    )
    rejects(lambda raw: outcome(raw).update(expect="no_session"), "contradicts scenario")
    rejects(lambda raw: outcome(raw).update(signed_in_method="sms"), "signed_in_method")

    minted = copy.deepcopy(_task_raw("browser-auth-minted-email-otp"))
    outcome(minted)["require_all_saved_passwords_attempted"] = True
    try:
        validate_task_contract(minted)
    except ValueError as exc:
        assert "saved-password scenario" in str(exc)
    else:
        raise AssertionError("minted_otp accepted a saved-password requirement")

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

    def rejects(scenario: str, needle: str, **overrides) -> None:
        try:
            validate_manifest(scenario, _manifest(scenario, **overrides))
        except AuthTestSiteFixtureError as exc:
            assert needle in str(exc), f"expected {needle!r} in {exc}"
            return
        raise AssertionError(f"{scenario} manifest accepted ({needle})")

    rejects("password_retry", "BENCHMARK_DISABLE_SAVED_BROWSER_AUTH", savedBrowserAuthHidden=True)
    rejects("all_fail", "expected 3", savedPasswordUsernames=SAVED[:2])
    rejects(
        "password_retry",
        "freshest first",
        authOptionsPreview={"passwordUsernames": list(reversed(SAVED)), "mintedEmail": None},
    )
    rejects(
        "all_fail",
        "minted account alongside",
        authOptionsPreview={"passwordUsernames": list(SAVED), "mintedEmail": MINTED},
    )
    rejects(
        "minted_otp",
        "auth options would offer minted account",
        authOptionsPreview={"passwordUsernames": [], "mintedEmail": None},
    )
    rejects(
        "minted_otp",
        "must not seed saved passwords",
        authOptionsPreview={"passwordUsernames": [SAVED[0]], "mintedEmail": MINTED},
    )
    rejects("password_retry", "no reachable member account", expectedMemberNumber=None)
    rejects("password_retry", "decides its member account at sign-in", expectedSignInEmail=SAVED[2])
    rejects("all_fail", "must not have a reachable member account", expectedSignInEmail=SAVED[0])
    try:
        validate_manifest("all_fail", _manifest("password_retry"))
    except AuthTestSiteFixtureError as exc:
        assert "expected 'all_fail'" in str(exc)
    else:
        raise AssertionError("a manifest for another scenario was accepted")
    rejects("minted_otp", "missing siteId/entryUrl", entryUrl="")


def test_outcome_check_grades_the_sites_own_records() -> None:
    from benchmarks.auth_test_site import evaluate_outcome

    retry = _outcome_check("browser-auth-saved-password-retry")
    evidence = {"manifest": _manifest("password_retry"), "report": _retry_report()}
    ok, detail = evaluate_outcome(retry, evidence, f"Your member number is {MEMBER_NUMBER}.")
    assert ok, detail
    assert "password(j.ellis.abc@example.com)→signed_in" in detail

    ok, detail = evaluate_outcome(retry, evidence, "You're signed in to Larkspur Members.")
    assert not ok and MEMBER_NUMBER in detail

    lucky = {
        "manifest": _manifest("password_retry"),
        "report": {
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
    rejected = {
        "manifest": _manifest("all_fail"),
        "report": {
            "attempts": [
                _attempt("password", SAVED[0], "rejected", "wrong_password"),
                _attempt("code_request", SAVED[0], "code_withheld"),
                _attempt("password", SAVED[1], "rejected", "unknown_account"),
                _attempt("password", SAVED[2], "rejected", "wrong_password"),
            ],
            "sessions": [],
        },
    }
    ok, detail = evaluate_outcome(all_fail, rejected, "")
    assert ok, detail
    gave_up_early = {"manifest": _manifest("all_fail"), "report": {**rejected["report"], "attempts": rejected["report"]["attempts"][:2]}}
    ok, detail = evaluate_outcome(all_fail, gave_up_early, "")
    assert not ok and SAVED[1] in detail
    broke_in = {"manifest": _manifest("all_fail"), "report": {**rejected["report"], "sessions": [_session(SAVED[0], "password")]}}
    ok, detail = evaluate_outcome(all_fail, broke_in, "")
    assert not ok and "no option should work" in detail

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
    ok, detail = evaluate_outcome(retry, {"manifest": _manifest("password_retry"), "report_error": "404"}, MEMBER_NUMBER)
    assert not ok and "report unavailable: 404" in detail


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
    """Stands in for the local backend's /api/test-sites/larkspur/fixtures routes."""

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
                backend.requests.append((self.command, self.path, body, dict(self.headers)))

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
        with _FakeBackend("password_retry", _retry_report()) as backend, patch.object(
            rb, "_api_headers", fake_headers
        ), patch.object(rb, "_current_benchmark_user_id", lambda: "user-1"):
            manifest = await rb._apply_auth_test_site(task, backend.base_url)
            assert manifest is not None and auth_test_site.active_manifest() == manifest
            method, path, body, sent_headers = backend.requests[0]
            assert (method, path) == ("POST", "/api/test-sites/larkspur/fixtures")
            assert body == {"userId": "user-1", "scenario": "password_retry", "publicBaseUrl": "https://rose-x.ngrok.app"}
            assert sent_headers.get("X-API-Key") == "fixture-key"
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
                            "completionSummary": {"summary": f"Your Larkspur member number is {MEMBER_NUMBER}."},
                        },
                    }
                ],
            }
            await rb._hydrate_auth_test_site_evidence(data, backend.base_url)
            assert backend.requests[1][:2] == ("GET", "/api/test-sites/larkspur/fixtures/abc123/report")
            outcome_evaluator = next(e for e in task.evaluators if e["id"] == "saved-password-retry-outcome")
            ok, detail = rb._run_declared_static_check(task, outcome_evaluator, data)
            assert ok, detail

            data["messages"][0]["metadata"]["completionSummary"]["summary"] = "Signed in."
            ok, detail = rb._run_declared_static_check(task, outcome_evaluator, data)
            assert not ok and MEMBER_NUMBER in detail

            data["messages"][0]["metadata"]["completionSummary"] = {
                "summary": "I signed in to your Larkspur Members account and verified your member number.",
                "outputs": [{"key": "member_number", "label": "Member Number", "value": MEMBER_NUMBER}],
            }
            ok, detail = rb._run_declared_static_check(task, outcome_evaluator, data)
            assert ok, f"the completion card's structured outputs are part of the final answer: {detail}"

            await rb._release_auth_test_site(backend.base_url, manifest)
            assert backend.requests[2][:2] == ("DELETE", "/api/test-sites/larkspur/fixtures/abc123")
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


async def run_all_tests():
    print("auth-test-site-benchmark blackbox tests:")
    runner = BlackboxResult()
    runner.record(
        "daily_catalog_covers_every_hosted_auth_branch_with_one_natural_prompt",
        test_daily_catalog_covers_every_hosted_auth_branch_with_one_natural_prompt,
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
    return runner.all_passed
