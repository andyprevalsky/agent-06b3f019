#!/usr/bin/env python3
"""Select Pre-Deploy benches: category floor + path-triggered depth, hard-capped.

Deploy cannot run the full daily suite. Selection rules:

1. Floor — every `smoke`-tagged harness task, plus one canary per floor category
2. Path extras — more category depth when the git diff touches matching paths
3. Hard cap — default 20. Floor must always fit; extras truncate with a scream

New catalog tasks auto-attach via `deploy_category` (or derived tags). Preferred
canary order: `deploy_canary: true` → `pre-deploy`/`smoke` → `pipeline-e2e` →
shorter `timeout_seconds`.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

DEFAULT_CAP = 20
DEFAULT_CATALOG = Path(__file__).resolve().parent / "tasks.json"

FLOOR_CATEGORIES: tuple[str, ...] = (
    "payment",
    "grep",
    "sms",
    "browser_stateful",
)

KNOWN_DEPLOY_CATEGORIES: frozenset[str] = frozenset(
    {
        *FLOOR_CATEGORIES,
        "harness",
        "browser",
        "plaid",
        "phone",
        "attachment",
        "claude-code",
        "research",
        "response-schema",
        "wait-for",
        "chat",
        "mass-agent",
    }
)

TAG_TO_CATEGORY: dict[str, str] = {
    "payment": "payment",
    "grep": "grep",
    "sms": "sms",
    "phone": "phone",
    "plaid": "plaid",
    "attachment": "attachment",
    "claude-code": "claude-code",
    "browser": "browser",
    "research": "research",
    "response-schema": "response-schema",
    "wait-for": "wait-for",
    "chat": "chat",
    "mass-agent": "mass-agent",
    "agentcard-lifecycle-sandbox": "payment",
    "agentcard-lifecycle-production": "payment",
}

PATH_TRIGGERS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (r"(^|/)agents/browser_tools/", ("browser", "browser_stateful")),
    (r"(^|/)agents/domains/browser", ("browser", "browser_stateful")),
    (r"(^|/)agents/.*cookie", ("browser_stateful", "browser")),
    (r"(^|/)agents/.*auth_session", ("browser_stateful", "browser")),
    (
        r"request_payment_card|agentcard|agent_card|/purchases?/|wallet-funding|test-payment",
        ("payment",),
    ),
    (r"(^|/)agents/domains/.*payment", ("payment",)),
    (r"(^|/)back-end/src/domains/(agentcard|purchases|test-payment)/", ("payment",)),
    (r"(^|/)agents/.*grep|(^|/)agents/domains/.*user_data|(^|/)agents/tools/.*grep", ("grep",)),
    (r"(^|/)agents/.*plaid|(^|/)back-end/.*/plaid", ("plaid", "grep")),
    (r"(^|/)agents/.*sms|(^|/)agents/domains/.*sms|(^|/)back-end/.*/sms", ("sms",)),
    (r"(^|/)agents/.*phone|(^|/)agents/.*voice|(^|/)agents/domains/.*phone", ("phone",)),
    (
        r"(^|/)agents/.*attachment|(^|/)agents/.*file_upload|(^|/)agents/tools/.*vision",
        ("attachment",),
    ),
    (r"claude.?code|claude_code", ("claude-code",)),
    (r"(^|/)agents/(loop|workflows|helpers|activities)/", ("harness",)),
    (r"(^|/)agents/tools/", ("harness",)),
    (r"(^|/)agents/worker\.py$|(^|/)agents/config\.py$", ("harness",)),
    (r"(^|/)back-end/src/(services|routes|providers|temporal)/", ("harness",)),
    (r"(^|/)agents/benchmarks/tasks\.json$", ("harness",)),
)

STATEFUL_BROWSER_NAME_RE = re.compile(
    r"(write-?lock|cookie-payment|nopa|toast-nopa)",
    re.IGNORECASE,
)

CAP_SCREAM = """
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
!! PREDEPLOY BENCH HARD CAP HIT: {selected}/{cap} benches selected
!! {dropped_count} candidate(s) DROPPED to stay within the hard cap.
!! Deploy coverage is truncated — fix by narrowing path triggers, moving
!! long tasks off the floor, or raising PREDEPLOY_BENCH_CAP (needs review).
!! Dropped: {dropped}
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
""".strip()


@dataclass(frozen=True)
class TaskRef:
    name: str
    tags: tuple[str, ...]
    group: str | None
    status: str | None
    bench: str | None
    timeout_seconds: int
    deploy_category: str | None
    deploy_canary: bool
    raw: dict[str, Any]

    @property
    def local_only(self) -> bool:
        return "local-only" in self.tags

    @property
    def is_smoke(self) -> bool:
        return "smoke" in self.tags

    @property
    def eligible_status(self) -> bool:
        return self.status not in {"retired", "incomplete"}


@dataclass
class Selection:
    selected: list[str]
    floor: list[str]
    path_extras: list[str]
    dropped: list[str]
    cap: int
    cap_hit: bool
    categories_covered: list[str]
    changed_files: list[str]
    triggered_categories: list[str]
    reasons: dict[str, list[str]] = field(default_factory=dict)
    surface: str = "local"

    @property
    def total(self) -> int:
        return len(self.selected)


def load_tasks(catalog: Path) -> list[TaskRef]:
    raw = json.loads(catalog.read_text())
    if not isinstance(raw, list):
        raise ValueError(f"{catalog}: expected a JSON array")
    tasks: list[TaskRef] = []
    for item in raw:
        if not isinstance(item, dict) or not item.get("name"):
            continue
        tags = tuple(str(t) for t in (item.get("tags") or []))
        timeout = item.get("timeout_seconds")
        try:
            timeout_i = int(timeout) if timeout is not None else 10_000
        except (TypeError, ValueError):
            timeout_i = 10_000
        deploy_category = item.get("deploy_category")
        if deploy_category is not None:
            deploy_category = str(deploy_category)
            if deploy_category not in KNOWN_DEPLOY_CATEGORIES:
                raise ValueError(
                    f"{item['name']}: unknown deploy_category {deploy_category!r}; "
                    f"known={sorted(KNOWN_DEPLOY_CATEGORIES)}"
                )
        tasks.append(
            TaskRef(
                name=str(item["name"]),
                tags=tags,
                group=(str(item["group"]) if item.get("group") is not None else None),
                status=(str(item["status"]) if item.get("status") is not None else None),
                bench=(str(item["bench"]) if item.get("bench") is not None else None),
                timeout_seconds=timeout_i,
                deploy_category=deploy_category,
                deploy_canary=bool(item.get("deploy_canary")),
                raw=item,
            )
        )
    return tasks


def categories_for_task(task: TaskRef) -> set[str]:
    cats: set[str] = set()
    if task.deploy_category:
        cats.add(task.deploy_category)
    for tag in task.tags:
        mapped = TAG_TO_CATEGORY.get(tag)
        if mapped:
            cats.add(mapped)
    if task.is_smoke:
        cats.add("harness")
    if "browser" in task.tags and STATEFUL_BROWSER_NAME_RE.search(task.name):
        cats.add("browser_stateful")
    extra = task.raw.get("deploy_categories") or []
    if isinstance(extra, list):
        for cat in extra:
            if cat in KNOWN_DEPLOY_CATEGORIES:
                cats.add(str(cat))
    return cats


def discover_changed_files(
    repo_root: Path, explicit: Sequence[str] | None = None
) -> list[str]:
    if explicit is not None:
        return sorted({f.strip() for f in explicit if f and f.strip()})

    env_file = os.environ.get("PREDEPLOY_CHANGED_FILES", "").strip()
    if env_file:
        path = Path(env_file)
        if path.is_file():
            return sorted(
                {line.strip() for line in path.read_text().splitlines() if line.strip()}
            )

    env_list = os.environ.get("PREDEPLOY_CHANGED_FILE_LIST", "").strip()
    if env_list:
        return sorted({part.strip() for part in env_list.splitlines() if part.strip()})

    files: set[str] = set()
    commands = [
        ["git", "diff", "--name-only", "origin/main...HEAD"],
        ["git", "diff", "--name-only", "HEAD"],
        ["git", "ls-files", "--others", "--exclude-standard"],
    ]
    for cmd in commands:
        try:
            result = subprocess.run(
                cmd,
                cwd=repo_root,
                text=True,
                capture_output=True,
                check=False,
            )
        except OSError:
            continue
        if result.returncode != 0:
            continue
        files.update(line.strip() for line in result.stdout.splitlines() if line.strip())
    return sorted(files)


def categories_triggered_by_paths(changed_files: Sequence[str]) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    for path in changed_files:
        for pattern, cats in PATH_TRIGGERS:
            if re.search(pattern, path):
                for cat in cats:
                    if cat not in seen:
                        seen.add(cat)
                        found.append(cat)
    return found


def _eligible(task: TaskRef, surface: str) -> bool:
    if not task.eligible_status:
        return False
    if surface == "cloud" and task.local_only:
        return False
    return True


def _canary_sort_key(task: TaskRef) -> tuple:
    group_rank = 0 if task.group == "pre-deploy" or task.is_smoke else 1
    bench_rank = 0 if task.bench == "pipeline-e2e" else 1
    canary_rank = 0 if task.deploy_canary else 1
    ready_rank = 0 if task.status == "ready" else 1
    return (canary_rank, group_rank, bench_rank, ready_rank, task.timeout_seconds, task.name)


def candidates_for_category(
    tasks: Sequence[TaskRef], category: str, surface: str
) -> list[TaskRef]:
    out = [
        t
        for t in tasks
        if _eligible(t, surface) and category in categories_for_task(t)
    ]
    return sorted(out, key=_canary_sort_key)


def select_predeploy_benches(
    *,
    catalog: Path,
    changed_files: Sequence[str] | None = None,
    surface: str = "local",
    cap: int = DEFAULT_CAP,
    repo_root: Path | None = None,
) -> Selection:
    if cap < 1:
        raise ValueError("cap must be >= 1")
    if surface not in {"local", "cloud"}:
        raise ValueError("surface must be 'local' or 'cloud'")

    tasks = load_tasks(catalog)
    root = repo_root or catalog.resolve().parents[2]
    changed = discover_changed_files(root, changed_files)
    triggered = categories_triggered_by_paths(changed)

    reasons: dict[str, list[str]] = {}
    selected: list[str] = []
    selected_set: set[str] = set()
    floor: list[str] = []
    path_extras: list[str] = []
    dropped: list[str] = []
    categories_covered: list[str] = []

    def _add(name: str, bucket: list[str], reason: str) -> bool:
        if name in selected_set:
            reasons.setdefault(name, []).append(reason)
            return True
        if len(selected) >= cap:
            dropped.append(name)
            reasons.setdefault(name, []).append(f"dropped:{reason}")
            return False
        selected.append(name)
        selected_set.add(name)
        bucket.append(name)
        reasons.setdefault(name, []).append(reason)
        return True

    smoke_tasks = [t for t in tasks if t.is_smoke and _eligible(t, surface)]
    for task in smoke_tasks:
        if not _add(task.name, floor, "floor:smoke"):
            raise SystemExit(
                f"PREDEPLOY FLOOR smoke set cannot fit in hard cap ({cap}). "
                "Shrink smoke-tagged tasks or raise PREDEPLOY_BENCH_CAP."
            )
    if smoke_tasks:
        categories_covered.append("harness")

    for category in FLOOR_CATEGORIES:
        for cand in candidates_for_category(tasks, category, surface):
            if cand.name in selected_set:
                if category not in categories_covered:
                    categories_covered.append(category)
                break
            if not _add(cand.name, floor, f"floor:canary:{category}"):
                raise SystemExit(
                    f"PREDEPLOY FLOOR (smoke + canaries) cannot fit category "
                    f"{category!r} into hard cap ({cap}). Shrink "
                    "FLOOR_CATEGORIES / smoke set or raise PREDEPLOY_BENCH_CAP."
                )
            categories_covered.append(category)
            break

    if len(floor) > cap:
        raise SystemExit(
            f"PREDEPLOY FLOOR ({len(floor)}) exceeds hard cap ({cap}). "
            "Shrink FLOOR_CATEGORIES / smoke set before deploying."
        )

    def _add_one_extra(category: str, reason_prefix: str) -> None:
        for cand in candidates_for_category(tasks, category, surface):
            if cand.name in selected_set:
                continue
            # One attempt per category slot — never walk the whole candidate
            # list once the cap is full (that would inflate dropped counts).
            if _add(cand.name, path_extras, f"{reason_prefix}:{category}"):
                if category not in categories_covered:
                    categories_covered.append(category)
            break

    for category in triggered:
        if category == "harness":
            continue
        _add_one_extra(category, "path")

    for category in triggered:
        if category not in FLOOR_CATEGORIES and category != "browser":
            continue
        _add_one_extra(category, "path-depth")

    # Deduplicate dropped while preserving order (cap can reject the same
    # name via multiple reason attempts only if logic regresses).
    deduped_dropped: list[str] = []
    seen_dropped: set[str] = set()
    for name in dropped:
        if name not in seen_dropped:
            seen_dropped.add(name)
            deduped_dropped.append(name)

    cap_hit = len(selected) >= cap and len(deduped_dropped) > 0
    return Selection(
        selected=selected,
        floor=floor,
        path_extras=path_extras,
        dropped=deduped_dropped,
        cap=cap,
        cap_hit=cap_hit,
        categories_covered=categories_covered,
        changed_files=list(changed),
        triggered_categories=triggered,
        reasons=reasons,
        surface=surface,
    )


def format_report(selection: Selection) -> str:
    lines = [
        "========== PREDEPLOY BENCH SELECTION ==========",
        f"Surface: {selection.surface}",
        f"Hard cap: {selection.cap}",
        f"Changed files: {len(selection.changed_files)}",
        f"Path-triggered categories: {', '.join(selection.triggered_categories) or '(none)'}",
        f"Categories covered: {', '.join(selection.categories_covered) or '(none)'}",
        f"Floor ({len(selection.floor)}): {', '.join(selection.floor) or '(none)'}",
        f"Path extras ({len(selection.path_extras)}): {', '.join(selection.path_extras) or '(none)'}",
        f"TOTAL SELECTED: {selection.total} / {selection.cap}",
    ]
    if selection.cap_hit:
        lines.append(
            CAP_SCREAM.format(
                selected=selection.total,
                cap=selection.cap,
                dropped_count=len(selection.dropped),
                dropped=", ".join(selection.dropped) or "(none)",
            )
        )
    elif selection.total == selection.cap:
        lines.append(
            f"*** AT HARD CAP ({selection.cap}/{selection.cap}) — "
            "no room for further extras ***"
        )
    if selection.dropped and not selection.cap_hit:
        lines.append(f"Dropped: {', '.join(selection.dropped)}")
    lines.append("==============================================")
    return "\n".join(lines)


def scream_if_cap_hit(selection: Selection, stream=None) -> None:
    stream = stream or sys.stderr
    if not selection.cap_hit:
        if selection.total == selection.cap:
            msg = (
                f"*** PREDEPLOY BENCH COUNT AT HARD CAP: "
                f"{selection.total}/{selection.cap} ***"
            )
            print(msg, file=stream)
            print(msg, file=sys.stdout)
        return
    text = CAP_SCREAM.format(
        selected=selection.total,
        cap=selection.cap,
        dropped_count=len(selection.dropped),
        dropped=", ".join(selection.dropped) or "(none)",
    )
    print(text, file=stream)
    print(text, file=sys.stdout)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--catalog",
        type=Path,
        default=Path(os.environ.get("PREDEPLOY_CATALOG", DEFAULT_CATALOG)),
    )
    parser.add_argument(
        "--surface",
        choices=("local", "cloud"),
        default=os.environ.get("PREDEPLOY_SURFACE", "local"),
    )
    parser.add_argument(
        "--cap",
        type=int,
        default=int(os.environ.get("PREDEPLOY_BENCH_CAP", DEFAULT_CAP)),
    )
    parser.add_argument(
        "--changed-file",
        action="append",
        default=None,
        help="Explicit changed path (repeatable).",
    )
    parser.add_argument(
        "--changed-files-from",
        type=Path,
        default=None,
        help="Read changed paths from a file (one path per line).",
    )
    parser.add_argument(
        "--format",
        choices=("names", "report", "json", "names-and-report"),
        default="names-and-report",
    )
    parser.add_argument("--repo-root", type=Path, default=None)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    explicit: list[str] | None = None
    if args.changed_files_from is not None:
        explicit = [
            line.strip()
            for line in args.changed_files_from.read_text().splitlines()
            if line.strip()
        ]
    if args.changed_file:
        explicit = (explicit or []) + list(args.changed_file)

    selection = select_predeploy_benches(
        catalog=args.catalog,
        changed_files=explicit,
        surface=args.surface,
        cap=args.cap,
        repo_root=args.repo_root,
    )

    if args.format == "names":
        print("\n".join(selection.selected))
        scream_if_cap_hit(selection)
    elif args.format == "report":
        print(format_report(selection))
        scream_if_cap_hit(selection)
    elif args.format == "json":
        print(
            json.dumps(
                {
                    "selected": selection.selected,
                    "floor": selection.floor,
                    "path_extras": selection.path_extras,
                    "dropped": selection.dropped,
                    "cap": selection.cap,
                    "cap_hit": selection.cap_hit,
                    "total": selection.total,
                    "categories_covered": selection.categories_covered,
                    "triggered_categories": selection.triggered_categories,
                    "changed_files_count": len(selection.changed_files),
                    "reasons": selection.reasons,
                    "surface": selection.surface,
                },
                indent=2,
                sort_keys=True,
            )
        )
        scream_if_cap_hit(selection)
    else:
        print(format_report(selection))
        scream_if_cap_hit(selection)
        print("---PREDEPLOY_BENCH_NAMES---")
        print("\n".join(selection.selected))
        print("---END_PREDEPLOY_BENCH_NAMES---")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
