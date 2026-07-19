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
            "Current production compute tokens and complete browser auth state, "
            "including context, cookies/storage, passwords, passkeys, provider "
            "profiles, CookieBundles, and Steel sessions."
        ),
    ),
}

LIVE_FIXTURE_NAMES = frozenset(LIVE_FIXTURES)


def resolve_live_fixtures(environment: dict | None) -> list[str]:
    """Return only the fixtures explicitly declared by a task."""
    if not environment:
        return []
    declared = environment.get("live_fixtures")
    return list(declared) if declared is not None else []
