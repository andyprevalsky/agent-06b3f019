"""Rose Shop hosted test site fixture for browser-auth benchmarks.

Live sites put CAPTCHAs in front of sign-in, so the auth ladder (saved session
→ passkey → saved passwords → email OTP → SMS OTP → minted identity → guest →
request_user_assistance) is proven against a shop the local backend serves
itself (back-end/src/domains/auth-test-site). A task opts in with
``environment.auth_test_site = {"scenario": <scenario>}`` and references the
per-run site in its prompt as ``{auth_test_site_url}``.

    run_single_task
        │ create_site ──POST /api/rose-shop/fixtures──► backend
        │                 seeds the saved session / passkey / passwords / minted
        │                 account for a per-run realm, returns the manifest
        │ validate_manifest — the auth ladder the agent will see must match the
        │                 scenario, or the run fails before an agent exists
        ▼
    goal: {auth_test_site_url} → manifest.entryUrl (public frontend proxy)
        ▼
    agent run ── browser agent signs in / signs up / buys (every site event is
        │        recorded server-side)
        ▼
    _run_declared_evaluators ── fetch_report ──GET .../fixtures/:id/report──►
        │                 attempts, sessions, accounts, orders, credential states
        ▼
    evaluate_outcome (static check ``auth_test_site_outcome``)
        ▼
    finally: delete_site ──DELETE .../fixtures/:id──► removes seeded rows
"""

from __future__ import annotations

import re
from contextvars import ContextVar
from datetime import datetime
from typing import Any, Optional

import httpx

AUTH_TEST_SITE_URL_PLACEHOLDER = "{auth_test_site_url}"
AUTH_TEST_SITE_ACCOUNT_PLACEHOLDER = "{auth_test_site_account}"
AUTH_TEST_SITE_OUTCOME_CHECK = "auth_test_site_outcome"
FIXTURES_PATH = "/api/rose-shop/fixtures"

# What auth options must list for each scenario: (saved passwords, minted offered,
# passkeys, saved-session bundles). Mirrors back-end serviceScenarios.ts.
SCENARIO_LADDERS: dict[str, tuple[int, bool, int, int]] = {
    "phone_sms_otp": (0, False, 0, 0),
    "password_retry": (3, False, 0, 0),
    "saved_logins_fail": (3, False, 0, 0),
    "user_signs_in": (3, False, 0, 0),
    "all_fail": (3, False, 1, 1),
    "minted_otp": (0, True, 0, 0),
    "saved_session": (1, False, 0, 1),
    "stale_session": (1, False, 0, 1),
    "passkey": (1, False, 1, 0),
    "passkey_rejected": (1, False, 1, 0),
    "password_email_2fa": (1, False, 0, 0),
    "account_locked": (1, False, 0, 0),
    "code_never_arrives": (0, True, 0, 0),
    "expired_code": (0, True, 0, 0),
    "minted_sms_otp": (0, True, 0, 0),
    "magic_link": (0, True, 0, 0),
    "email_otp": (0, True, 0, 0),
    "signup": (0, True, 0, 0),
    "signup_already_registered": (0, True, 0, 0),
    "guest_purchase": (0, True, 0, 0),
    "member_discount_purchase": (0, True, 0, 0),
    "member_discount_signup_fails_purchase": (0, True, 0, 0),
    "paid_membership_purchase": (0, True, 0, 0),
    "signup_purchase": (0, True, 0, 0),
    "signup_fails_purchase": (0, True, 0, 0),
    "session_expires_at_checkout": (1, False, 0, 0),
    "failed_login_not_reoffered": (2, False, 0, 0),
    "created_account_reused": (0, True, 0, 0),
    "named_account": (2, False, 0, 0),
}
AUTH_TEST_SITE_SCENARIOS = tuple(SCENARIO_LADDERS)
# Scenarios whose correct end state has no member session at all.
NO_SESSION_SCENARIOS = (
    "saved_logins_fail",
    "all_fail",
    "account_locked",
    "code_never_arrives",
    "signup_fails_purchase",
    # Members pay less but the sign-up is refused, or membership costs money:
    # the order is placed as a guest either way.
    "member_discount_signup_fails_purchase",
    "paid_membership_purchase",
)
USER_RESPONSES = ("sign_in", "decline")
# Scenarios whose manifest carries the password only the user knows.
USER_SIGN_IN_SCENARIOS = ("user_signs_in",)
OUTCOME_EXPECTATIONS = ("signed_in", "no_session", "any")
SIGN_IN_METHODS = (
    "password",
    "password_email_2fa",
    "email_code",
    "sms_code",
    "magic_link",
    "passkey",
    "saved_session",
    "signup",
)
ATTEMPT_KINDS = (
    "password",
    "code_request",
    "code_verify",
    "sms_request",
    "sms_verify",
    "link_request",
    "link_open",
    "passkey",
    "session",
    "second_factor",
    "signup",
    "signup_verify",
    "guest",
    "order",
    "run_marker",
)
ORDER_BUYERS = ("guest", "signed_in_account")
_PATTERN_KEYS = {"kind", "outcome", "reason", "email"}
_CHECK_KEYS = {
    "type",
    "expect",
    "signed_in_method",
    "require_all_saved_passwords_attempted",
    "deliverable_contains_member_number",
    "deliverable_contains_order_number",
    "trail",
    "forbid",
    "counts",
    "orders",
    "accounts_created",
    "minted_unused",
    "after_marker",
    "disabled_saved_passwords",
    "left_on_sign_in_form",
    "ladder_order",
}


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


def declared_block(environment: Optional[dict]) -> Optional[dict]:
    """The validated ``environment.auth_test_site`` block, or None when the task has no site.

    ``scenario`` picks the fixture. ``user_response`` makes the harness play the
    user when the agent asks for sign-in help (``sign_in`` through the live
    browser, or ``decline``). ``first_run_prompt`` runs one agent to completion
    on the site before the graded run, for behavior that spans two runs.
    """
    block = (environment or {}).get("auth_test_site")
    if block is None:
        return None
    if not isinstance(block, dict):
        raise ValueError("environment.auth_test_site must be an object")
    unknown = set(block) - {"scenario", "user_response", "first_run_prompt"}
    if unknown:
        raise ValueError(f"environment.auth_test_site has unknown keys {sorted(unknown)}")
    if block.get("scenario") not in AUTH_TEST_SITE_SCENARIOS:
        raise ValueError(
            f"environment.auth_test_site.scenario must be one of {list(AUTH_TEST_SITE_SCENARIOS)}"
        )
    response = block.get("user_response")
    if response is not None and response not in USER_RESPONSES:
        raise ValueError(f"environment.auth_test_site.user_response must be one of {list(USER_RESPONSES)}")
    if response == "sign_in" and block["scenario"] not in USER_SIGN_IN_SCENARIOS:
        raise ValueError(
            "environment.auth_test_site.user_response=sign_in needs a scenario where the user "
            f"knows a working password: {list(USER_SIGN_IN_SCENARIOS)}"
        )
    first_run = block.get("first_run_prompt")
    if first_run is not None and (
        not isinstance(first_run, str) or AUTH_TEST_SITE_URL_PLACEHOLDER not in first_run
    ):
        raise ValueError(
            f"environment.auth_test_site.first_run_prompt must contain {AUTH_TEST_SITE_URL_PLACEHOLDER}"
        )
    return block


def declared_scenario(environment: Optional[dict]) -> Optional[str]:
    block = declared_block(environment)
    return None if block is None else block["scenario"]


def shares_agent_inbox(environment: Optional[dict]) -> bool:
    """True for every hosted-auth task: they must run one at a time on a stack.

    Codes and links a site sends land in the one inbox and phone the user's
    agent identity owns, and every running browser agent of that user is handed
    whatever arrives there. Two hosted-auth lanes at once therefore see each
    other's codes — including lanes whose own site never sends one, which then
    try a stranger's code. (Seen in the first concurrent batch: lanes typed
    codes issued by other lanes' sites and never asked the user for help.)
    """
    return declared_scenario(environment) is not None


def _validate_patterns(patterns: Any, item_id: str, field: str, counted: bool = False) -> None:
    if not isinstance(patterns, list) or not patterns:
        raise ValueError(f"{item_id}: {AUTH_TEST_SITE_OUTCOME_CHECK}.{field} must be a non-empty list")
    allowed = _PATTERN_KEYS | ({"min", "max"} if counted else set())
    for pattern in patterns:
        if not isinstance(pattern, dict) or pattern.get("kind") not in ATTEMPT_KINDS:
            raise ValueError(
                f"{item_id}: {AUTH_TEST_SITE_OUTCOME_CHECK}.{field} entries need a kind from {list(ATTEMPT_KINDS)}"
            )
        unknown = set(pattern) - allowed
        if unknown:
            raise ValueError(f"{item_id}: {AUTH_TEST_SITE_OUTCOME_CHECK}.{field} has unknown keys {sorted(unknown)}")
        if counted and "min" not in pattern and "max" not in pattern:
            raise ValueError(f"{item_id}: {AUTH_TEST_SITE_OUTCOME_CHECK}.{field} entries need min and/or max")


def validate_outcome_check(check: dict, scenario: Optional[str], item_id: str) -> None:
    """Catalog-time contract for one ``auth_test_site_outcome`` check."""
    name = AUTH_TEST_SITE_OUTCOME_CHECK
    if scenario is None:
        raise ValueError(f"{item_id}: {name} requires environment.auth_test_site")
    unknown = set(check) - _CHECK_KEYS
    if unknown:
        raise ValueError(f"{item_id}: {name} has unknown keys {sorted(unknown)}")
    expect = check.get("expect")
    if expect not in OUTCOME_EXPECTATIONS:
        raise ValueError(f"{item_id}: {name}.expect must be one of {list(OUTCOME_EXPECTATIONS)}")
    if expect == "signed_in" and scenario in NO_SESSION_SCENARIOS:
        raise ValueError(f"{item_id}: {name}.expect=signed_in contradicts scenario {scenario}")
    if expect == "no_session" and scenario not in NO_SESSION_SCENARIOS + ("guest_purchase",):
        raise ValueError(f"{item_id}: {name}.expect=no_session contradicts scenario {scenario}")
    method = check.get("signed_in_method")
    if method is not None and (expect != "signed_in" or method not in SIGN_IN_METHODS):
        raise ValueError(
            f"{item_id}: {name}.signed_in_method must be one of {list(SIGN_IN_METHODS)} and requires expect=signed_in"
        )
    if check.get("require_all_saved_passwords_attempted") and SCENARIO_LADDERS[scenario][0] == 0:
        raise ValueError(
            f"{item_id}: require_all_saved_passwords_attempted needs a saved-password scenario, not {scenario}"
        )
    if check.get("deliverable_contains_member_number") and expect != "signed_in":
        raise ValueError(f"{item_id}: deliverable_contains_member_number requires expect=signed_in")
    for field in ("trail", "forbid", "ladder_order"):
        if field in check:
            _validate_patterns(check[field], item_id, field)
    if "counts" in check:
        _validate_patterns(check["counts"], item_id, "counts", counted=True)
    after = check.get("after_marker")
    if after is not None:
        if not isinstance(after, dict) or not (set(after) <= {"trail", "forbid"}) or not after:
            raise ValueError(f"{item_id}: {name}.after_marker takes trail and/or forbid")
        for field, patterns in after.items():
            _validate_patterns(patterns, item_id, f"after_marker.{field}")
    orders = check.get("orders")
    if orders is not None:
        if (
            not isinstance(orders, dict)
            or not isinstance(orders.get("count"), int)
            or orders.get("placed_by", "signed_in_account") not in ORDER_BUYERS
            or set(orders) - {"count", "placed_by"}
        ):
            raise ValueError(f"{item_id}: {name}.orders needs an integer count and placed_by in {list(ORDER_BUYERS)}")
    if "accounts_created" in check and not isinstance(check["accounts_created"], int):
        raise ValueError(f"{item_id}: {name}.accounts_created must be an integer")
    if "disabled_saved_passwords" in check and check["disabled_saved_passwords"] != "failed_only":
        raise ValueError(f"{item_id}: {name}.disabled_saved_passwords only supports 'failed_only'")


def validate_manifest(scenario: str, manifest: dict) -> None:
    """Fail closed when the seeded site would not present the scenario's ladder."""
    if not str(manifest.get("siteId") or "") or not str(manifest.get("entryUrl") or ""):
        raise AuthTestSiteFixtureError("auth test site manifest is missing siteId/entryUrl")
    if manifest.get("scenario") != scenario:
        raise AuthTestSiteFixtureError(
            f"auth test site seeded scenario {manifest.get('scenario')!r}, expected {scenario!r}"
        )
    passwords, minted_offered, passkeys, sessions = SCENARIO_LADDERS[scenario]
    saved = list(manifest.get("savedPasswordUsernames") or [])
    preview = manifest.get("authOptionsPreview") or {}
    preview_passwords = list(preview.get("passwordUsernames") or [])
    preview_minted = preview.get("mintedEmail")
    if (passwords or passkeys or sessions) and manifest.get("savedBrowserAuthHidden") is True:
        raise AuthTestSiteFixtureError(
            "BENCHMARK_DISABLE_SAVED_BROWSER_AUTH is on for this stack, so the browser agent "
            f"would never see the seeded credentials; run {scenario} on a stack without the "
            "guest-checkout kill-switch"
        )
    if len(saved) != passwords:
        raise AuthTestSiteFixtureError(
            f"auth test site seeded {len(saved)} saved passwords; expected {passwords}"
        )
    if preview_passwords != saved:
        raise AuthTestSiteFixtureError(
            f"auth options would offer passwords {preview_passwords}, expected {saved} (freshest first)"
        )
    if int(preview.get("passkeyCount") or 0) != passkeys:
        raise AuthTestSiteFixtureError(
            f"auth options would offer {preview.get('passkeyCount')} passkeys, expected {passkeys}"
        )
    if int(preview.get("cookieBundleCount") or 0) != sessions:
        raise AuthTestSiteFixtureError(
            f"auth options would offer {preview.get('cookieBundleCount')} saved sessions, expected {sessions}"
        )
    if minted_offered:
        minted = manifest.get("mintedEmail")
        if not minted or preview_minted != minted:
            raise AuthTestSiteFixtureError(
                f"auth options would offer minted account {preview_minted!r}, expected {minted!r}"
            )
    elif preview_minted:
        raise AuthTestSiteFixtureError("auth options offer a minted account alongside saved credentials")
    if scenario == "minted_sms_otp" and not manifest.get("mintedPhone"):
        raise AuthTestSiteFixtureError("minted_sms_otp needs a minted phone number to text")
    if scenario == "email_otp":
        inbox = manifest.get("expectedSignInEmail")
        if not inbox or inbox not in [str(item).lower() for item in preview.get("emailOtpInboxes") or []]:
            raise AuthTestSiteFixtureError(
                f"auth options must list the connected inbox {inbox!r} for email OTP, "
                f"got {preview.get('emailOtpInboxes')}"
            )
    if scenario in NO_SESSION_SCENARIOS:
        if manifest.get("expectedSignInEmail") is not None or manifest.get("expectedMemberNumber"):
            raise AuthTestSiteFixtureError(f"{scenario} must not have a reachable member account")


def sign_in_url(manifest: Optional[dict]) -> Optional[str]:
    """The site's own sign-in page: where a user goes when they want to type their password."""
    entry = str((manifest or {}).get("entryUrl") or "")
    if "?" not in entry:
        return None
    base, query = entry.split("?", 1)
    return f"{base.rstrip('/')}/login?{query}"


def resolve_goal(goal: str, manifest: Optional[dict]) -> str:
    if AUTH_TEST_SITE_URL_PLACEHOLDER not in goal and AUTH_TEST_SITE_ACCOUNT_PLACEHOLDER not in goal:
        return goal
    entry_url = str((manifest or {}).get("entryUrl") or "")
    if not entry_url:
        raise AuthTestSiteFixtureError(
            f"prompt references {AUTH_TEST_SITE_URL_PLACEHOLDER} but no auth test site was created"
        )
    goal = goal.replace(AUTH_TEST_SITE_URL_PLACEHOLDER, entry_url)
    if AUTH_TEST_SITE_ACCOUNT_PLACEHOLDER in goal:
        named = str((manifest or {}).get("namedAccountEmail") or "")
        if not named:
            raise AuthTestSiteFixtureError(
                f"prompt references {AUTH_TEST_SITE_ACCOUNT_PLACEHOLDER} but the scenario names no account"
            )
        goal = goal.replace(AUTH_TEST_SITE_ACCOUNT_PLACEHOLDER, named)
    return goal


async def create_site(
    base_url: str,
    headers: dict,
    *,
    user_id: str,
    scenario: str,
    public_base_url: str,
) -> dict:
    async with httpx.AsyncClient(timeout=60) as client:
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


async def mark_run(base_url: str, headers: dict, site_id: str, label: str) -> None:
    """Record a boundary in the site's event log (between two agent runs on one site)."""
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{base_url.rstrip('/')}{FIXTURES_PATH}/{site_id}/mark", headers=headers, json={"label": label}
        )
    if response.status_code != 201:
        raise AuthTestSiteFixtureError(
            f"auth test site mark failed {response.status_code}: {response.text[:300]}"
        )


async def delete_site(base_url: str, headers: dict, site_id: str, user_id: str | None = None) -> None:
    """Remove the site and every row it seeded.

    ``user_id`` lets the backend tear the rows down even when it no longer holds
    the site in memory (restart, eviction, expiry); only the rows of this exact
    siteId are touched.
    """
    params = {"userId": user_id} if user_id else None
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.delete(
            f"{base_url.rstrip('/')}{FIXTURES_PATH}/{site_id}", headers=headers, params=params
        )
    if response.status_code not in (200, 204, 404):
        raise AuthTestSiteFixtureError(
            f"auth test site delete failed {response.status_code}: {response.text[:300]}"
        )


def summarize_attempts(attempts: list[dict]) -> str:
    if not attempts:
        return "no site events"
    parts = []
    for attempt in attempts:
        reason = attempt.get("reason")
        outcome = f"{attempt.get('outcome')}:{reason}" if reason else str(attempt.get("outcome"))
        parts.append(f"{attempt.get('kind')}({attempt.get('email')})→{outcome}")
    return ", ".join(parts)


def _matches(attempt: dict, pattern: dict, manifest: dict) -> bool:
    for key in ("kind", "outcome", "reason"):
        if key in pattern and attempt.get(key) != pattern[key]:
            return False
    if "email" in pattern:
        wanted = pattern["email"]
        if wanted == "minted":
            wanted = manifest.get("mintedEmail") or ""
        if str(attempt.get("email") or "").casefold() != str(wanted).casefold():
            return False
    return True


def _describe(pattern: dict) -> str:
    return ":".join(str(pattern[key]) for key in ("kind", "outcome", "reason", "email") if key in pattern)


def _check_trail(attempts: list[dict], patterns: list[dict], manifest: dict) -> Optional[str]:
    """Each pattern must appear, in order, as a subsequence of the events."""
    position = 0
    for pattern in patterns:
        while position < len(attempts) and not _matches(attempts[position], pattern, manifest):
            position += 1
        if position == len(attempts):
            return _describe(pattern)
        position += 1
    return None


def _check_ladder_order(attempts: list[dict], patterns: list[dict], manifest: dict) -> Optional[str]:
    """The first event of each rung must come before the first event of the next rung."""
    previous = -1
    for pattern in patterns:
        first = next((i for i, attempt in enumerate(attempts) if _matches(attempt, pattern, manifest)), None)
        if first is None:
            return f"Site never recorded {_describe(pattern)}"
        if first < previous:
            return f"{_describe(pattern)} was tried before the rung above it"
        previous = first
    return None


def _check_event_rules(check: dict, attempts: list[dict], manifest: dict, where: str) -> Optional[str]:
    missing = _check_trail(attempts, check.get("trail") or [], manifest)
    if missing:
        return f"Site never recorded {missing}{where} in the expected order"
    out_of_order = _check_ladder_order(attempts, check.get("ladder_order") or [], manifest)
    if out_of_order:
        return out_of_order
    for pattern in check.get("forbid") or []:
        if any(_matches(attempt, pattern, manifest) for attempt in attempts):
            return f"Site recorded {_describe(pattern)}{where}, which must not happen"
    for pattern in check.get("counts") or []:
        seen = sum(1 for attempt in attempts if _matches(attempt, pattern, manifest))
        if seen < int(pattern.get("min", 0)) or seen > int(pattern.get("max", seen)):
            return (
                f"Site recorded {_describe(pattern)} {seen} time(s){where}; expected "
                f"{pattern.get('min', 0)}..{pattern.get('max', 'any')}"
            )
    return None


def _deliverable_reports(deliverable: str, identifier: str) -> bool:
    """True when the deliverable carries the identifier's information in any rendering.

    The agent's output schema may type a "member number" as an integer, so the Task
    Complete card can show 92884370 for RS-92884370. The evaluator checks that the
    information reached the user, not how the schema typed it: the exact identifier,
    or its digit run (at least four digits) once separators are removed, both count.
    """
    if not identifier:
        return False
    if identifier in deliverable:
        return True
    digits = re.sub(r"\D", "", identifier)
    if len(digits) < 4:
        return False
    return digits in re.sub(r"[\s\-_.,:/#]", "", deliverable)


def _member_number(manifest: dict, report: dict) -> str:
    sign_in_email = str(report.get("signInEmail") or "").casefold()
    for account in report.get("accounts") or []:
        if isinstance(account, dict) and str(account.get("email") or "").casefold() == sign_in_email:
            return str(account.get("memberNumber") or "")
    return str(manifest.get("expectedMemberNumber") or "")


def _check_session(check: dict, report: dict, sessions: list[dict]) -> Optional[str]:
    expect = check.get("expect")
    if expect == "no_session":
        if sessions:
            return f"Signed in as {sessions[0].get('email')} although no option should work"
        return None
    if expect != "signed_in":
        return None
    sign_in_email = str(report.get("signInEmail") or "")
    if not sign_in_email:
        return "No member account was ever reachable on the site"
    matching = [s for s in sessions if str(s.get("email") or "").casefold() == sign_in_email.casefold()]
    if not matching:
        return f"Never signed in as {sign_in_email}"
    others = sorted({str(s.get("email")) for s in sessions if s not in matching})
    if others:
        return f"Signed in to the wrong account {others[0]} (expected only {sign_in_email})"
    method = check.get("signed_in_method")
    if method and not any(s.get("method") == method for s in matching):
        observed = sorted({str(s.get("method")) for s in matching})
        return f"Signed in via {observed}, expected {method}"
    return None


def _check_orders(check: dict, report: dict) -> Optional[str]:
    rule = check.get("orders")
    if rule is None:
        return None
    orders = [order for order in report.get("orders") or [] if isinstance(order, dict)]
    if len(orders) != rule["count"]:
        return f"Site recorded {len(orders)} order(s); expected exactly {rule['count']}"
    buyer = rule.get("placed_by", "signed_in_account")
    sign_in_email = str(report.get("signInEmail") or "").casefold()
    for order in orders:
        email = order.get("email")
        if buyer == "guest" and email is not None:
            return f"Order {order.get('orderNumber')} was placed by {email}, expected a guest order"
        if buyer == "signed_in_account" and (not email or str(email).casefold() != sign_in_email):
            return f"Order {order.get('orderNumber')} was placed by {email or 'a guest'}, expected {sign_in_email}"
    return None


def _check_saved_password_states(check: dict, report: dict) -> Optional[str]:
    if check.get("disabled_saved_passwords") != "failed_only":
        return None
    for record in report.get("savedPasswords") or []:
        disabled = bool(record.get("disabledAt"))
        if record.get("matchesAccount") and disabled:
            return f"The working saved login {record.get('username')} was disabled"
        if not record.get("matchesAccount") and not disabled:
            return f"The failed saved login {record.get('username')} is still offered"
    return None


# Kinds whose form carries a side effect: a failed sign-in counted against the
# account, a second account, a second order.
_SUBMIT_KINDS = ("password", "second_factor", "code_verify", "sms_verify", "signup", "signup_verify", "order")
# An agent needs at least a model turn and a typed field between two submits of
# the same form; anything closer is the browser sending one submit twice.
DUPLICATE_SUBMIT_WINDOW_SECONDS = 8.0


def _attempt_time(attempt: dict) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(str(attempt.get("at") or "").replace("Z", "+00:00"))
    except ValueError:
        return None


def _check_duplicate_submissions(attempts: list[dict]) -> Optional[str]:
    """One click must reach the site as one submit."""
    last_seen: dict[tuple[str, str], datetime] = {}
    for attempt in attempts:
        kind = str(attempt.get("kind") or "")
        at = _attempt_time(attempt)
        if kind not in _SUBMIT_KINDS or at is None:
            continue
        key = (kind, str(attempt.get("email") or "").casefold())
        previous = last_seen.get(key)
        last_seen[key] = at
        if previous is not None and (at - previous).total_seconds() < DUPLICATE_SUBMIT_WINDOW_SECONDS:
            gap = (at - previous).total_seconds()
            return f"The {kind} form for {key[1] or 'the guest'} reached the site twice {gap:.1f}s apart"
    return None


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

    def failed(detail: str) -> tuple[bool, str]:
        return False, f"{detail} ({trail})"

    if check.get("expect") not in OUTCOME_EXPECTATIONS:
        return False, f"Unsupported auth_test_site_outcome expect={check.get('expect')!r}"
    if check.get("require_all_saved_passwords_attempted"):
        attempted = {str(a.get("email") or "").casefold() for a in attempts if a.get("kind") == "password"}
        missing = [
            username
            for username in manifest.get("savedPasswordUsernames") or []
            if str(username).casefold() not in attempted
        ]
        if missing:
            return failed(f"Saved password for {missing[0]} was never tried")
    if check.get("minted_unused") and manifest.get("mintedEmail"):
        minted = str(manifest["mintedEmail"]).casefold()
        if any(str(a.get("email") or "").casefold() == minted for a in attempts):
            return failed("The minted identity was used although saved credentials exist")

    marker = next((index for index, a in enumerate(attempts) if a.get("kind") == "run_marker"), None)
    problem = (
        _check_duplicate_submissions(attempts)
        or _check_session(check, report, sessions)
        or _check_event_rules(check, attempts, manifest, "")
        or _check_orders(check, report)
        or _check_saved_password_states(check, report)
    )
    if problem is None and check.get("after_marker") is not None:
        if marker is None:
            problem = "The site saw no second run"
        else:
            problem = _check_event_rules(check["after_marker"], attempts[marker + 1 :], manifest, " in the second run")
    if problem is None and check.get("left_on_sign_in_form"):
        last_page = str(report.get("lastPagePath") or "")
        if not last_page.startswith("/login"):
            problem = f"The browser was left on {last_page or 'no page'}, not on the sign-in form"
    if problem is None and "accounts_created" in check:
        created = [
            account
            for account in report.get("accounts") or []
            if isinstance(account, dict) and account.get("origin") == "signup" and account.get("verified")
        ]
        if len(created) != check["accounts_created"]:
            problem = f"Site has {len(created)} verified new account(s); expected {check['accounts_created']}"
    if problem is not None:
        return failed(problem)

    if check.get("deliverable_contains_member_number"):
        member_number = _member_number(manifest, report)
        if not _deliverable_reports(deliverable, member_number):
            return False, f"Final answer did not report member number {member_number or '<unknown>'}"
    if check.get("deliverable_contains_order_number"):
        numbers = [str(order.get("orderNumber") or "") for order in report.get("orders") or []]
        if not numbers or not all(_deliverable_reports(deliverable, number) for number in numbers):
            return False, f"Final answer did not report order number {numbers or '<none placed>'}"
    return True, f"Rose Shop {manifest.get('scenario')}: {trail}"
