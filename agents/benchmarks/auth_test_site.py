"""Larkspur Members hosted sign-in site fixture for browser-auth benchmarks.

Live sites put CAPTCHAs in front of sign-in, so the auth ladder (saved
passwords → email OTP → minted identity → request_user_assistance) is proven
against a members site the local backend serves itself
(back-end/src/domains/auth-test-site). A task opts in with
``environment.auth_test_site = {"scenario": <scenario>}`` and references the
per-run site in its prompt as ``{auth_test_site_url}``.

    run_single_task
        │ create_site ──POST /api/test-sites/larkspur/fixtures──► backend
        │                 seeds BrowserPassword / MintedAccount rows for a
        │                 per-run realm, returns the manifest (entryUrl, ...)
        │ validate_manifest — the auth ladder the agent will see must match the
        │                 scenario, or the run fails before an agent exists
        ▼
    goal: {auth_test_site_url} → manifest.entryUrl (public frontend proxy)
        ▼
    agent run ── browser agent signs in (every attempt recorded server-side)
        ▼
    _run_declared_evaluators ── fetch_report ──GET .../fixtures/:id/report──►
        │                 attempts, sessions, saved-password states
        ▼
    evaluate_outcome (static check ``auth_test_site_outcome``)
        ▼
    finally: delete_site ──DELETE .../fixtures/:id──► removes seeded rows
"""

from __future__ import annotations

from contextvars import ContextVar
from typing import Any, Optional

import httpx

AUTH_TEST_SITE_SCENARIOS = ("password_retry", "all_fail", "minted_otp")
AUTH_TEST_SITE_URL_PLACEHOLDER = "{auth_test_site_url}"
AUTH_TEST_SITE_OUTCOME_CHECK = "auth_test_site_outcome"
FIXTURES_PATH = "/api/test-sites/larkspur/fixtures"
SAVED_PASSWORD_SCENARIOS = ("password_retry", "all_fail")
SIGNED_IN_SCENARIOS = ("password_retry", "minted_otp")
EXPECTED_SAVED_PASSWORD_COUNT = 3
OUTCOME_EXPECTATIONS = ("signed_in", "no_session")
SIGN_IN_METHODS = ("password", "email_code")


class AuthTestSiteFixtureError(RuntimeError):
    """The hosted site could not be prepared exactly as the scenario requires."""


# Parallel lanes share one BenchmarkTask object per name (k=3 runs of the same
# task are concurrent), so the per-run manifest lives in the lane's asyncio
# context rather than on the task.
_ACTIVE_MANIFEST: ContextVar[Optional[dict]] = ContextVar("benchmark_auth_test_site", default=None)


def active_manifest() -> Optional[dict]:
    return _ACTIVE_MANIFEST.get()


def set_active_manifest(manifest: Optional[dict]) -> None:
    _ACTIVE_MANIFEST.set(manifest)


def declared_scenario(environment: Optional[dict]) -> Optional[str]:
    block = (environment or {}).get("auth_test_site")
    if block is None:
        return None
    if not isinstance(block, dict):
        raise ValueError("environment.auth_test_site must be an object")
    scenario = block.get("scenario")
    if scenario not in AUTH_TEST_SITE_SCENARIOS:
        raise ValueError(
            f"environment.auth_test_site.scenario must be one of {list(AUTH_TEST_SITE_SCENARIOS)}"
        )
    return scenario


def validate_outcome_check(check: dict, scenario: Optional[str], item_id: str) -> None:
    """Catalog-time contract for one ``auth_test_site_outcome`` check."""
    if scenario is None:
        raise ValueError(f"{item_id}: {AUTH_TEST_SITE_OUTCOME_CHECK} requires environment.auth_test_site")
    expect = check.get("expect")
    if expect not in OUTCOME_EXPECTATIONS:
        raise ValueError(
            f"{item_id}: {AUTH_TEST_SITE_OUTCOME_CHECK}.expect must be one of {list(OUTCOME_EXPECTATIONS)}"
        )
    if (expect == "signed_in") != (scenario in SIGNED_IN_SCENARIOS):
        raise ValueError(f"{item_id}: {AUTH_TEST_SITE_OUTCOME_CHECK}.expect={expect} contradicts scenario {scenario}")
    method = check.get("signed_in_method")
    if method is not None and (expect != "signed_in" or method not in SIGN_IN_METHODS):
        raise ValueError(
            f"{item_id}: {AUTH_TEST_SITE_OUTCOME_CHECK}.signed_in_method must be one of "
            f"{list(SIGN_IN_METHODS)} and requires expect=signed_in"
        )
    if check.get("require_all_saved_passwords_attempted") and scenario not in SAVED_PASSWORD_SCENARIOS:
        raise ValueError(
            f"{item_id}: require_all_saved_passwords_attempted needs a saved-password scenario, not {scenario}"
        )
    if check.get("deliverable_contains_member_number") and expect != "signed_in":
        raise ValueError(f"{item_id}: deliverable_contains_member_number requires expect=signed_in")


def validate_manifest(scenario: str, manifest: dict) -> None:
    """Fail closed when the seeded site would not present the scenario's ladder."""
    if not str(manifest.get("siteId") or "") or not str(manifest.get("entryUrl") or ""):
        raise AuthTestSiteFixtureError("auth test site manifest is missing siteId/entryUrl")
    if manifest.get("scenario") != scenario:
        raise AuthTestSiteFixtureError(
            f"auth test site seeded scenario {manifest.get('scenario')!r}, expected {scenario!r}"
        )
    saved = list(manifest.get("savedPasswordUsernames") or [])
    preview = manifest.get("authOptionsPreview") or {}
    preview_passwords = list(preview.get("passwordUsernames") or [])
    preview_minted = preview.get("mintedEmail")
    if scenario in SAVED_PASSWORD_SCENARIOS:
        if manifest.get("savedBrowserAuthHidden") is True:
            raise AuthTestSiteFixtureError(
                "BENCHMARK_DISABLE_SAVED_BROWSER_AUTH is on for this stack, so the browser agent "
                f"would never see the seeded passwords; run {scenario} on a stack without the "
                "guest-checkout kill-switch"
            )
        if len(saved) != EXPECTED_SAVED_PASSWORD_COUNT:
            raise AuthTestSiteFixtureError(
                f"auth test site seeded {len(saved)} saved passwords; expected {EXPECTED_SAVED_PASSWORD_COUNT}"
            )
        if preview_passwords != saved:
            raise AuthTestSiteFixtureError(
                f"auth options would offer passwords {preview_passwords}, expected {saved} (freshest first)"
            )
        if preview_minted:
            raise AuthTestSiteFixtureError("auth options offer a minted account alongside saved passwords")
    else:
        minted = manifest.get("mintedEmail")
        if saved or preview_passwords:
            raise AuthTestSiteFixtureError(
                f"{scenario} must not seed saved passwords (got {saved or preview_passwords})"
            )
        if not minted or preview_minted != minted:
            raise AuthTestSiteFixtureError(
                f"auth options would offer minted account {preview_minted!r}, expected {minted!r}"
            )
        if manifest.get("expectedSignInEmail") != minted:
            raise AuthTestSiteFixtureError("minted_otp must expect the agent to sign in with its minted email")
    if scenario in SIGNED_IN_SCENARIOS:
        if not manifest.get("expectedSignInEmail") or not manifest.get("expectedMemberNumber"):
            raise AuthTestSiteFixtureError(f"{scenario} manifest has no reachable member account")
    elif manifest.get("expectedSignInEmail") is not None:
        raise AuthTestSiteFixtureError(f"{scenario} must not have a reachable member account")


def resolve_goal(goal: str, manifest: Optional[dict]) -> str:
    if AUTH_TEST_SITE_URL_PLACEHOLDER not in goal:
        return goal
    entry_url = str((manifest or {}).get("entryUrl") or "")
    if not entry_url:
        raise AuthTestSiteFixtureError(
            f"prompt references {AUTH_TEST_SITE_URL_PLACEHOLDER} but no auth test site was created"
        )
    return goal.replace(AUTH_TEST_SITE_URL_PLACEHOLDER, entry_url)


async def create_site(
    base_url: str,
    headers: dict,
    *,
    user_id: str,
    scenario: str,
    public_base_url: str,
) -> dict:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{base_url.rstrip('/')}{FIXTURES_PATH}",
            headers=headers,
            json={"userId": user_id, "scenario": scenario, "publicBaseUrl": public_base_url},
        )
    if response.status_code != 201:
        raise AuthTestSiteFixtureError(
            f"auth test site create failed {response.status_code}: {response.text[:300]}"
        )
    manifest = response.json()
    validate_manifest(scenario, manifest)
    return manifest


async def fetch_report(base_url: str, headers: dict, site_id: str) -> dict:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"{base_url.rstrip('/')}{FIXTURES_PATH}/{site_id}/report", headers=headers
        )
    if response.status_code != 200:
        raise AuthTestSiteFixtureError(
            f"auth test site report failed {response.status_code}: {response.text[:300]}"
        )
    return response.json()


async def delete_site(base_url: str, headers: dict, site_id: str) -> None:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.delete(f"{base_url.rstrip('/')}{FIXTURES_PATH}/{site_id}", headers=headers)
    if response.status_code not in (200, 204, 404):
        raise AuthTestSiteFixtureError(
            f"auth test site delete failed {response.status_code}: {response.text[:300]}"
        )


def summarize_attempts(attempts: list[dict]) -> str:
    if not attempts:
        return "no sign-in attempts"
    parts = []
    for attempt in attempts:
        reason = attempt.get("reason")
        outcome = f"{attempt.get('outcome')}:{reason}" if reason else str(attempt.get("outcome"))
        parts.append(f"{attempt.get('kind')}({attempt.get('email')})→{outcome}")
    return ", ".join(parts)


def evaluate_outcome(check: dict, evidence: Any, deliverable: str) -> tuple[bool, str]:
    """Judge one ``auth_test_site_outcome`` check from the site's own records."""
    if not isinstance(evidence, dict):
        return False, "Auth test site evidence was not captured"
    if evidence.get("report_error"):
        return False, f"Auth test site report unavailable: {evidence['report_error']}"
    if not isinstance(evidence.get("manifest"), dict):
        return False, "Auth test site evidence was not captured"
    manifest = evidence["manifest"]
    report = evidence.get("report") if isinstance(evidence.get("report"), dict) else {}
    attempts = [a for a in report.get("attempts") or [] if isinstance(a, dict)]
    sessions = [s for s in report.get("sessions") or [] if isinstance(s, dict)]
    trail = summarize_attempts(attempts)

    if check.get("require_all_saved_passwords_attempted"):
        attempted = {
            str(a.get("email") or "").casefold() for a in attempts if a.get("kind") == "password"
        }
        missing = [
            username
            for username in manifest.get("savedPasswordUsernames") or []
            if str(username).casefold() not in attempted
        ]
        if missing:
            return False, f"Saved password for {missing[0]} was never tried ({trail})"

    expect = check.get("expect")
    if expect == "no_session":
        if sessions:
            return False, f"Signed in as {sessions[0].get('email')} although no option should work ({trail})"
    elif expect == "signed_in":
        expected_email = str(manifest.get("expectedSignInEmail") or "").casefold()
        matching = [s for s in sessions if str(s.get("email") or "").casefold() == expected_email]
        if not matching:
            return False, f"Never signed in as {manifest.get('expectedSignInEmail')} ({trail})"
        method = check.get("signed_in_method")
        if method and not any(s.get("method") == method for s in matching):
            observed = sorted({str(s.get("method")) for s in matching})
            return False, f"Signed in via {observed}, expected {method} ({trail})"
    else:
        return False, f"Unsupported auth_test_site_outcome expect={expect!r}"

    if check.get("deliverable_contains_member_number"):
        member_number = str(manifest.get("expectedMemberNumber") or "")
        if not member_number or member_number not in deliverable:
            return False, f"Final answer did not report member number {member_number or '<unknown>'}"
    return True, f"Larkspur Members {manifest.get('scenario')}: {trail}"
