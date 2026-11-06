#!/usr/bin/env python3
"""GitHub token pool for scripts: pick the member with the most remaining quota.

Members, in order: GITHUB_TOKEN (the primary identity), GITHUB_TOKEN_2 ...
GITHUB_TOKEN_9 (machine accounts, any may be absent), then
GITHUB_DISPATCH_TOKEN as a last resort. Each key is read from the process
environment first, then agents/.env, then back-end/.env under the repo root
(agents/.env is not shell-sourceable, so the files are parsed here). Empty
values are skipped and a repeated token keeps its first name.

Ranking uses GET /rate_limit, which does not count against the quota. A member
that answers 401 is skipped. Members with quota left rank first (most remaining
wins, ties keep member order); members whose probe failed or timed out rank
next; exhausted members rank last, soonest reset first.

  python3 scripts/lib/github_token_pool.py pick [--resource core|graphql|both] [--repo-root DIR]
  python3 scripts/lib/github_token_pool.py status [--repo-root DIR]

`pick` prints only the chosen token (for `GH_TOKEN=$(...) gh ...`); `status`
prints one line per member and never a token value.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

MEMBER_NAMES = (
    ("GITHUB_TOKEN",)
    + tuple(f"GITHUB_TOKEN_{index}" for index in range(2, 10))
    + ("GITHUB_DISPATCH_TOKEN",)
)
ENV_FILES = ("agents/.env", "back-end/.env")
DEFAULT_API_BASE = "https://api.github.com"
DEFAULT_TIMEOUT_SECONDS = 5.0
RESOURCES = ("core", "graphql", "both")
REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Member:
    name: str
    token: str


@dataclass(frozen=True)
class Quota:
    remaining: int
    limit: int
    reset: int


@dataclass(frozen=True)
class Probe:
    member: Member
    status: int | None
    core: Quota | None = None
    graphql: Quota | None = None
    error: str | None = None


def read_env_file(path: Path) -> dict[str, str]:
    """KEY=VALUE pairs from a dotenv file, quotes stripped; missing file is empty."""
    values: dict[str, str] = {}
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return values
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values.setdefault(key, value)
    return values


def members(repo_root: Path | None = None, environ: Mapping[str, str] | None = None) -> list[Member]:
    """Pool members in contract order; process env wins per key over the env files."""
    root = REPO_ROOT if repo_root is None else Path(repo_root)
    env = os.environ if environ is None else environ
    files = [read_env_file(root / relative) for relative in ENV_FILES]
    found: list[Member] = []
    seen: set[str] = set()
    for name in MEMBER_NAMES:
        value = (env.get(name) or "").strip()
        if not value:
            for values in files:
                value = (values.get(name) or "").strip()
                if value:
                    break
        if value and value not in seen:
            seen.add(value)
            found.append(Member(name, value))
    return found


def _quota(resources: object, key: str) -> Quota | None:
    if not isinstance(resources, dict) or not isinstance(resources.get(key), dict):
        return None
    entry = resources[key]
    try:
        return Quota(int(entry["remaining"]), int(entry["limit"]), int(entry["reset"]))
    except (KeyError, TypeError, ValueError):
        return None


def _redact(text: str, tokens: Sequence[str]) -> str:
    for token in tokens:
        if token:
            text = text.replace(token, "<redacted>")
    return text


def probe_one(member: Member, base_url: str, timeout: float) -> Probe:
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/rate_limit",
        headers={
            "Authorization": f"Bearer {member.token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "rose-github-token-pool",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status, body = response.status, response.read()
    except urllib.error.HTTPError as error:
        return Probe(member, error.code, error=f"HTTP {error.code}")
    except Exception as error:  # timeouts, refused connections, TLS errors
        return Probe(member, None, error=_redact(f"{type(error).__name__}: {error}", [member.token]))
    try:
        resources = json.loads(body or b"{}").get("resources")
    except (ValueError, AttributeError):
        return Probe(member, status, error="unparseable /rate_limit body")
    return Probe(member, status, _quota(resources, "core"), _quota(resources, "graphql"))


def probe(
    pool: Sequence[Member], base_url: str | None = None, timeout: float = DEFAULT_TIMEOUT_SECONDS
) -> list[Probe]:
    """Probe every member concurrently; results keep member order."""
    if not pool:
        return []
    base = base_url or os.environ.get("GITHUB_API_BASE_URL") or DEFAULT_API_BASE
    with ThreadPoolExecutor(max_workers=len(pool)) as executor:
        return list(executor.map(lambda member: probe_one(member, base, timeout), pool))


def _remaining(result: Probe, resource: str) -> Quota | None:
    if resource == "core":
        return result.core
    if resource == "graphql":
        return result.graphql
    known = [quota for quota in (result.core, result.graphql) if quota is not None]
    return min(known, key=lambda quota: quota.remaining) if known else None


def rank(results: Sequence[Probe], resource: str = "both") -> list[Probe]:
    """Usable members best-first: quota left, then unknown, then exhausted."""
    if resource not in RESOURCES:
        raise ValueError(f"resource must be one of {RESOURCES}")
    ordered = []
    for position, result in enumerate(results):
        if result.status == 401:
            continue
        quota = _remaining(result, resource) if result.status == 200 else None
        if quota is not None and quota.remaining > 0:
            key = (0, -quota.remaining, position)
        elif quota is None:
            key = (1, 0, position)
        else:
            key = (2, quota.reset, position)
        ordered.append((key, result))
    return [result for _key, result in sorted(ordered, key=lambda item: item[0])]


def pick_token(
    resource: str = "both",
    repo_root: Path | None = None,
    environ: Mapping[str, str] | None = None,
    base_url: str | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> str | None:
    """The best usable member's token, or None when no member is usable."""
    ranked = rank(probe(members(repo_root, environ), base_url, timeout), resource)
    return ranked[0].member.token if ranked else None


def _iso(epoch: int) -> str:
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def status_lines(results: Sequence[Probe]) -> list[str]:
    tokens = [result.member.token for result in results]
    lines = []
    for result in results:
        parts = [result.member.name, f"http={result.status if result.status is not None else 'error'}"]
        for label, quota in (("core", result.core), ("graphql", result.graphql)):
            if quota is not None:
                parts.append(f"{label}={quota.remaining}/{quota.limit} reset={_iso(quota.reset)}")
        if result.error:
            parts.append(f"error={result.error}")
        lines.append(_redact(" ".join(parts), tokens))
    return lines


def _timeout() -> float:
    try:
        return float(os.environ.get("GITHUB_TOKEN_POOL_TIMEOUT_SECONDS") or DEFAULT_TIMEOUT_SECONDS)
    except ValueError:
        return DEFAULT_TIMEOUT_SECONDS


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    commands = parser.add_subparsers(dest="command", required=True)
    pick_parser = commands.add_parser("pick", help="print the token with the most remaining quota")
    pick_parser.add_argument("--resource", choices=RESOURCES, default="both")
    status_parser = commands.add_parser("status", help="print each member's quota (never the token)")
    for sub in (pick_parser, status_parser):
        sub.add_argument("--repo-root", type=Path, default=None)
    args = parser.parse_args(argv)

    pool = members(args.repo_root)
    if args.command == "status":
        if not pool:
            print("no GitHub token pool members (GITHUB_TOKEN, GITHUB_TOKEN_2..9, GITHUB_DISPATCH_TOKEN)")
            return 0
        print("\n".join(status_lines(probe(pool, timeout=_timeout()))))
        return 0
    if not pool:
        print(
            "github_token_pool: no member configured (GITHUB_TOKEN, GITHUB_TOKEN_2..9, "
            "GITHUB_DISPATCH_TOKEN in the environment, agents/.env or back-end/.env)",
            file=sys.stderr,
        )
        return 1
    ranked = rank(probe(pool, timeout=_timeout()), args.resource)
    if not ranked:
        print("github_token_pool: every member was rejected (HTTP 401)", file=sys.stderr)
        return 1
    print(ranked[0].member.token)
    return 0


if __name__ == "__main__":
    sys.exit(main())
