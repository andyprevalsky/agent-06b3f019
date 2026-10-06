"""Canonical runtime credential overlay for the benchmark catalog.

The immutable base image and task-specific ``db_fixtures`` provide reproducible
database state. The single ``live`` fixture is an explicit, current-at-runtime
overlay for expiring production credentials: compute tokens, browser context,
cookies and storage, passwords, passkeys, provider profiles, CookieBundles, and
Steel session authentication.

Tasks do not inherit the overlay. A benchmark that truly exercises current
credentials declares ``live_fixtures: ["live"]``; all other tasks run from the
base image plus any task-specific database deltas. In simulator mode the whole
overlay is skipped, rather than applying a misleading subset of it.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LiveFixtureSpec:
    name: str
    description: str
    local_only: bool = True
    requires_fresh: bool = True


LIVE_FIXTURES: dict[str, LiveFixtureSpec] = {
    "live": LiveFixtureSpec(
        name="live",
        description=(
            "Current production compute tokens, email send credentials "
            "(Gmail/Yahoo EmailIntegrationCredential rows), and complete browser "
            "auth state, including context, cookies/storage, passwords, passkeys, "
            "provider profiles, CookieBundles, and Steel sessions."
        ),
    ),
    "live-tamy-identity": LiveFixtureSpec(
        name="live-tamy-identity",
        description=(
            "The complete current production-credential overlay for the Mexico-based "
            "identity: her User row, browser context, profiles, cookies/storage, "
            "passwords, passkeys, CookieBundles, and Steel session authentication, "
            "plus the shared compute-token refresh. The fixture also selects her as "
            "the benchmark run user; without it the isolated DB has no parent User "
            "row and browser-session init fails on AgentIdentity_userId_fkey."
        ),
    ),
    "live-tamy-account-snapshot": LiveFixtureSpec(
        name="live-tamy-account-snapshot",
        description=(
            "A prod-synced snapshot of the Mexico-based identity's ACCOUNT rows as the "
            "run's base environment: User, credits, subscription, integrations, email "
            "credentials, contacts, message history, API keys, blueprints, SMS session "
            "and feedback. It is data, not a credential overlay, so it also applies in "
            "world-model simulate mode (where the identity overlay skips itself); browser "
            "auth is never synced. Selects her as the benchmark run user."
        ),
    ),
    "live-aman-food-plan-identity": LiveFixtureSpec(
        name="live-aman-food-plan-identity",
        description=(
            "Complete live overlay for Aman Gottumukkala's DoorDash food-plan repro: "
            "User row, scoped doordash.com browser auth, compute tokens, and the "
            "benchmark run user retarget. Pairs with the frozen prod-derived grocery "
            "manifest fixture for browser-doordash-food-plan-grocery-order."
        ),
    ),
}

# The production identity `live-tamy-identity` materializes, and the auth realms it
# is seeded for. Kept here rather than inline in the runner so the fixture's
# contract is declared in one place alongside its description.
TAMY_IDENTITY_USER_ID = "43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9"
TAMY_IDENTITY_COOKIE_DOMAINS = ("amazon.com.mx", "amazon.com")

# Aman's prod account was removed upstream; the food-plan repro now runs as the
# dev identity that still owns live DoorDash auth in prod (see pinned_facts).
AMAN_FOOD_PLAN_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
AMAN_FOOD_PLAN_COOKIE_DOMAINS = ("doordash.com",)

LIVE_FIXTURE_NAMES = frozenset(LIVE_FIXTURES)


def resolve_live_fixtures(environment: dict | None) -> list[str]:
    """Return only the fixtures explicitly declared by a task."""
    if not environment:
        return []
    declared = environment.get("live_fixtures")
    return list(declared) if declared is not None else []
