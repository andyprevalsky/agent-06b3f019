"""Canonical live-data-fixture registry for the eval catalog.

Live fixtures are the opposite of `db_fixtures` (see fixtures.py). A `db_fixture`
is a *frozen*, reproducible delta on a base image. A **live fixture** is
prod-synced state that must be **current at runtime** — compute tokens (the $0
claudeAuth path), browser cookies (authenticated site access), and browser
passwords all expire, so a frozen snapshot of them is worthless. Live fixtures
are re-synced from prod into the isolated benchmark DB right before the agent
starts, on every run, and are never frozen into a base-image snapshot.

Every `live`/`hybrid` task inherits `live_fixtures: ["base"]` unless it declares
otherwise (injected at load time in benchmark_tasks.py), exactly as tasks inherit
`base_images: ["base:victoria-prod-sync-v1"]`. The `base` fixture pulls live
compute tokens + browser cookies + browser passwords. Tasks needing extra live
state compose more fixtures onto it, e.g. `["base", "amazon_auth"]`.

This module holds only fixture *metadata* (names, defaults, resolution). The
runtime `apply` callables live in run_benchmark.py (where the prod-sync helpers
live); run_benchmark binds them into a dispatch table and asserts it covers
exactly LIVE_FIXTURE_NAMES, so the two can never drift.

Not to be confused with `tests/e2e/live_fixtures.py` — a separate (near-opposite)
concern that resolves dynamic *prompt/env string values* from a provider with TTL
*caching* for the e2e harness. This module syncs prod *DB credential rows* into
the isolated benchmark DB and deliberately never caches (a cached credential is
the anti-goal — see `requires_fresh`).
"""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_LIVE_FIXTURE = "base"


@dataclass(frozen=True)
class LiveFixtureSpec:
    name: str
    description: str
    local_only: bool = True  # refuse to apply against a prod/remote base_url
    requires_fresh: bool = True  # re-sync every run; never trust a frozen snapshot


LIVE_FIXTURES: dict[str, LiveFixtureSpec] = {
    "base": LiveFixtureSpec(
        name="base",
        description=(
            "Live prod-synced compute tokens (claude_code/gpt_code + pool) + "
            "browser cookies/context/storage + browser passwords/passkeys. "
            "Inherited by every live task unless it declares its own live_fixtures."
        ),
    ),
    "compute_tokens": LiveFixtureSpec(
        name="compute_tokens",
        description=(
            "Live prod-synced compute tokens only. Use this instead of base when a "
            "benchmark must not import browser cookies, storage, passwords, or passkeys."
        ),
    ),
    "amazon_auth": LiveFixtureSpec(
        name="amazon_auth",
        description=(
            "Active CookieBundle rows for amazon.com built from the user's "
            "synced prod cookies, so the browser agent starts logged in."
        ),
    ),
    "amazon_passkey": LiveFixtureSpec(
        name="amazon_passkey",
        description=(
            "Sync only the live Amazon passkey, remove Amazon cookies and origin storage, "
            "disable session/password alternatives, and detach the saved Kernel profile."
        ),
    ),
}

LIVE_FIXTURE_NAMES = frozenset(LIVE_FIXTURES)


def resolve_live_fixtures(environment: dict | None) -> list[str]:
    """The effective live fixtures for a task's environment.

    Mirrors the base_images default-injection: a live/hybrid env that omits
    live_fixtures inherits ["base"]; a synthetic env inherits []. An explicit
    list (including an explicit []) is returned verbatim.
    """
    if not environment:
        return [DEFAULT_LIVE_FIXTURE]
    declared = environment.get("live_fixtures")
    if declared is not None:
        return list(declared)
    if environment.get("mode") == "synthetic":
        return []
    return [DEFAULT_LIVE_FIXTURE]
