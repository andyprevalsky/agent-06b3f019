#!/usr/bin/env python3
"""Warn when a critical pinned dependency is behind its stable release and the pin is over a month old.

/deploy runs this while preparing the final scorecard and copies every line that starts
with ⚠️ into the FOLLOWUPS box. It never blocks a deploy.

    CRITICAL (below): name, npm package, release channel (dist-tag), Dockerfile ARG pin
      └─ pin = `ARG <NAME>=<version>` in the pin file
      └─ npm registry document: dist-tags[channel] = newest, time[v] = release instant
           pin >= newest                        ─▶ OK, current
           pin behind, released <= 30 days ago  ─▶ OK, behind but within the window
           pin behind, released  > 30 days ago  ─▶ ⚠️ STALE VERSION (upgrade it)
           pin or registry unreadable           ─▶ ⚠️ UNMEASURED VERSION (never a silent OK)

    python3 scripts/check_stale_versions.py                 # one line per dependency
    python3 scripts/check_stale_versions.py --json          # machine-readable rows
    python3 scripts/check_stale_versions.py --list-pins     # offline: the pins this checkout ships

An unreadable pin also exits 1 (the list below no longer matches the repository); its
⚠️ UNMEASURED line still prints, so the scorecard never drops it.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REGISTRY = "https://registry.npmjs.org"
STALE_AFTER = timedelta(days=30)
REGISTRY_TIMEOUT_SECONDS = 60


@dataclass(frozen=True)
class Critical:
    name: str
    package: str
    # Claude Code publishes a `stable` channel next to `latest`; Codex ships prereleases under
    # their own tags, so its `latest` is the newest stable release.
    channel: str
    pin_file: str
    pin_arg: str


CRITICAL = (
    Critical(
        "Claude Code CLI", "@anthropic-ai/claude-code", "stable",
        "e2b-templates/claude-code/e2b.Dockerfile", "CLAUDE_CODE_VERSION",
    ),
    Critical(
        "Codex CLI", "@openai/codex", "latest",
        "e2b-templates/codex-code/e2b.Dockerfile", "CODEX_VERSION",
    ),
)

VERSION = re.compile(r"^\d+(\.\d+)*$")


def read_pin(root: Path, dep: Critical) -> str | None:
    try:
        text = (root / dep.pin_file).read_text()
    except OSError:
        return None
    match = re.search(rf"^ARG {re.escape(dep.pin_arg)}=(\S+)$", text, re.MULTILINE)
    return match.group(1) if match and VERSION.match(match.group(1)) else None


def version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


def released(document: dict, version: str) -> datetime:
    return datetime.fromisoformat(document["time"][version].replace("Z", "+00:00"))


def fetch_document(registry: str, package: str) -> dict:
    url = f"{registry.rstrip('/')}/{urllib.parse.quote(package, safe='@')}"
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=REGISTRY_TIMEOUT_SECONDS) as response:
        return json.load(response)


def check(dep: Critical, pinned: str, registry: str, now: datetime) -> dict:
    row = {"name": dep.name, "package": dep.package, "channel": dep.channel, "pinned": pinned,
           "pin_file": dep.pin_file, "pin_arg": dep.pin_arg}
    try:
        document = fetch_document(registry, dep.package)
        newest = document["dist-tags"][dep.channel]
        if not VERSION.match(newest):
            raise ValueError(f"{dep.channel} is not a release version: {newest}")
        pinned_at = released(document, pinned)
        newest_at = released(document, newest)
    except (OSError, urllib.error.URLError, ValueError, KeyError, TypeError) as error:
        reason = f"{type(error).__name__}: {error}"[:200]
        row.update(status="unmeasured", message=(
            f"⚠️ UNMEASURED VERSION — {dep.name} {pinned}: could not read its newest stable release "
            f"(npm dist-tag {dep.channel}: {reason})"))
        return row
    age_days = (now - pinned_at).days
    row.update(newest=newest, pinned_released=pinned_at.date().isoformat(),
               newest_released=newest_at.date().isoformat(), age_days=age_days)
    if version_key(pinned) >= version_key(newest):
        row.update(status="current", message=f"OK — {dep.name} {pinned} is the newest stable release")
    elif now - pinned_at <= STALE_AFTER:
        row.update(status="behind", message=(
            f"OK — {dep.name} {pinned} is behind stable {newest} but only {age_days} days old"))
    else:
        row.update(status="stale", message=(
            f"⚠️ STALE VERSION — {dep.name} {pinned} (released {row['pinned_released']}, "
            f"{age_days} days old); newest stable {newest} (released {row['newest_released']}). "
            f"Bump ARG {dep.pin_arg} in {dep.pin_file} and build its new templates."))
    return row


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--root", type=Path, default=ROOT, help="checkout to read the pins from")
    parser.add_argument("--registry", default=DEFAULT_REGISTRY, help="npm registry base URL")
    parser.add_argument("--now", help="ISO-8601 instant to measure age at (default: now)")
    parser.add_argument("--json", action="store_true", help="print JSON rows")
    parser.add_argument("--list-pins", action="store_true", help="print the pins only (no network)")
    args = parser.parse_args(argv)
    now = datetime.fromisoformat(args.now.replace("Z", "+00:00")) if args.now else datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    pins = {dep.name: read_pin(args.root, dep) for dep in CRITICAL}
    missing = [dep for dep in CRITICAL if pins[dep.name] is None]
    for dep in missing:
        print(f"error: no `ARG {dep.pin_arg}=<version>` in {dep.pin_file} for {dep.name}", file=sys.stderr)
    if args.list_pins:
        for dep in CRITICAL:
            if pins[dep.name] is not None:
                print(f"{dep.name} {pins[dep.name]} ({dep.package}, {dep.channel})")
        return 1 if missing else 0

    rows = [
        check(dep, pins[dep.name], args.registry, now) if pins[dep.name] else {
            "name": dep.name, "package": dep.package, "channel": dep.channel, "pinned": None,
            "pin_file": dep.pin_file, "pin_arg": dep.pin_arg, "status": "unmeasured",
            # A follow-up like any other: the scorecard copies every ⚠️ line, so none is dropped.
            "message": f"⚠️ UNMEASURED VERSION — {dep.name}: no `ARG {dep.pin_arg}=<version>` in {dep.pin_file}",
        }
        for dep in CRITICAL
    ]
    if args.json:
        print(json.dumps(rows, indent=2))
    else:
        for row in rows:
            print(row["message"])
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
