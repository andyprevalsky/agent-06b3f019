#!/usr/bin/env python3
"""GitHub token pool for scripts: pick the member with the most remaining quota.

Members, in order: GITHUB_TOKEN (the primary identity), GITHUB_TOKEN_2 ...
GITHUB_TOKEN_9 (machine accounts, any may be absent), the GitHub App
installation token (GITHUB_APP when GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID
and GITHUB_APP_PRIVATE_KEY_B64 are set; minted with an `openssl`-signed RS256
JWT and cached privately until five minutes before its one-hour expiry), then
GITHUB_DISPATCH_TOKEN as a last resort. Each key is read from the process
environment first, then agents/.env, then back-end/.env under the repo root
(agents/.env is not shell-sourceable, so the files are parsed here). Empty
values are skipped and a repeated token keeps its first name.

Ranking uses GET /rate_limit, which does not count against the quota. A member
that answers 401 is skipped. Members with quota left rank first (most remaining
wins, ties keep member order); members whose probe failed or timed out rank
next; exhausted members rank last, soonest reset first.

  python3 scripts/github_token_pool.py pick [--resource core|graphql|both] [--repo-root DIR]
  python3 scripts/github_token_pool.py status [--repo-root DIR]

`pick` prints only the chosen token, for READ-ONLY calls (REST/curl or the real
`gh` binary); writes that act as Andy (pushes, PRs, repo creation) must use
GITHUB_TOKEN directly. `status` prints one line per member and never a token.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
import time
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
APP_MEMBER_NAME = "GITHUB_APP"
APP_KEYS = ("GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY_B64")
APP_REFRESH_MARGIN_SECONDS = 300
ENV_FILES = ("agents/.env", "back-end/.env")
DEFAULT_API_BASE = "https://api.github.com"
DEFAULT_TIMEOUT_SECONDS = 5.0
RESOURCES = ("core", "graphql", "both")
REPO_ROOT = Path(__file__).resolve().parents[1]


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


def _lookup(name: str, env: Mapping[str, str], files: Sequence[Mapping[str, str]]) -> str:
    value = (env.get(name) or "").strip()
    if value:
        return value
    for values in files:
        value = (values.get(name) or "").strip()
        if value:
            return value
    return ""


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def app_jwt(app_id: str, private_key_pem: str, now: int | None = None) -> str:
    """A ten-minute RS256 app JWT, backdated a minute for clock skew, signed by openssl."""
    issued = int(time.time()) if now is None else now
    unsigned = ".".join(
        _b64url(json.dumps(part, separators=(",", ":")).encode())
        for part in ({"alg": "RS256", "typ": "JWT"}, {"iat": issued - 60, "exp": issued + 540, "iss": app_id})
    )
    with tempfile.TemporaryDirectory(prefix="github-app-") as private_dir:
        key_path = Path(private_dir) / "key.pem"
        key_path.touch(mode=0o600)
        key_path.write_text(private_key_pem)
        signed = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", str(key_path)],
            input=unsigned.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=30,
        )
    if signed.returncode != 0:
        raise RuntimeError("openssl could not sign the GitHub App JWT")
    return f"{unsigned}.{_b64url(signed.stdout)}"


def _app_cache_path() -> Path:
    override = os.environ.get("GITHUB_APP_TOKEN_CACHE")
    if override:
        return Path(override)
    base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return base / "rose" / "github-app-token.json"


def app_token(
    app_id: str, installation_id: str, private_key_pem: str, base_url: str | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> str | None:
    """An unexpired installation token: the private cache, else a fresh mint. None on failure."""
    cache = _app_cache_path()
    key = f"{app_id}:{installation_id}"
    try:
        cached = json.loads(cache.read_text())
        if cached.get("key") == key and float(cached["expires_at"]) - time.time() > APP_REFRESH_MARGIN_SECONDS:
            return str(cached["token"])
    except (OSError, ValueError, KeyError, TypeError):
        pass
    base = (base_url or os.environ.get("GITHUB_API_BASE_URL") or DEFAULT_API_BASE).rstrip("/")
    try:
        request = urllib.request.Request(
            f"{base}/app/installations/{installation_id}/access_tokens", method="POST", data=b"",
            headers={
                "Authorization": f"Bearer {app_jwt(app_id, private_key_pem)}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "rose-github-token-pool",
            },
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read() or b"{}")
        token = str(body["token"])
        expires_at = dt.datetime.fromisoformat(str(body["expires_at"]).replace("Z", "+00:00")).timestamp()
    except Exception as error:  # mint failures leave the static members usable
        print(f"github_token_pool: GitHub App token mint failed ({type(error).__name__})", file=sys.stderr)
        return None
    try:
        cache.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        staging = cache.with_name(f".{cache.name}.{os.getpid()}")
        staging.touch(mode=0o600)
        staging.write_text(json.dumps({"key": key, "token": token, "expires_at": expires_at}))
        os.replace(staging, cache)
    except OSError:
        pass
    return token


def members(
    repo_root: Path | None = None, environ: Mapping[str, str] | None = None,
    base_url: str | None = None, include_app: bool = True,
) -> list[Member]:
    """Pool members in contract order; process env wins per key over the env files."""
    root = REPO_ROOT if repo_root is None else Path(repo_root)
    env = os.environ if environ is None else environ
    files = [read_env_file(root / relative) for relative in ENV_FILES]
    found: list[Member] = []
    seen: set[str] = set()

    def add(name: str, value: str) -> None:
        if value and value not in seen:
            seen.add(value)
            found.append(Member(name, value))

    for name in MEMBER_NAMES:
        if name == "GITHUB_DISPATCH_TOKEN" and include_app:
            app_id, installation_id, key_b64 = (_lookup(key, env, files) for key in APP_KEYS)
            if app_id and installation_id and key_b64:
                pem = base64.b64decode(key_b64).decode()
                add(APP_MEMBER_NAME, app_token(app_id, installation_id, pem, base_url) or "")
        add(name, _lookup(name, env, files))
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
    ranked = rank(probe(members(repo_root, environ, base_url), base_url, timeout), resource)
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
