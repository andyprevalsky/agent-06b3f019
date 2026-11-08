#!/usr/bin/env python3
"""Select Pre-Deploy benches: category floor + path-triggered depth, hard-capped.

Deploy cannot run the full daily suite. Selection rules:

1. Floor — every existing `smoke` harness task (no history gate), plus one canary
   per floor category
2. Path extras — more category depth when the git diff touches matching paths
3. Hard cap — default 20. Floor must always fit; extras truncate with a scream
4. History gate — ONLY for tasks being *added* to smoke (floor canaries + path
   extras). A canary/extra is eligible only when its last 3 *eligibility*
   attempts all passed. Existing `smoke`-tagged tasks always run. Attempts from
   predeploy / active-worktree runs are excluded from the streak so a selected
   canary cannot be invalidated by the deploy run that just assigned it.

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

try:
    from benchmarks import history_ledger
except ImportError:  # loaded by file path: run as a script, or through importlib by a tool
    import importlib.util

    _spec = importlib.util.spec_from_file_location(
        "benchmark_history_ledger", Path(__file__).resolve().with_name("history_ledger.py")
    )
    assert _spec and _spec.loader
    history_ledger = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(history_ledger)

DEFAULT_CAP = 20
DEFAULT_CATALOG = Path(__file__).resolve().parent / "tasks.json"
DEFAULT_ATTEMPTS = Path(__file__).resolve().parent / "history" / "task_attempts.jsonl"
# Canaries / path extras only: require last N eligibility attempts all passed.
# Existing smoke tasks bypass this gate. New or flaky canaries stay off /deploy
# until they earn this streak on the daily (or explicit non-predeploy) path.
DEFAULT_PASS_STREAK = 3
# Suites whose attempts must never feed deploy eligibility (predeploy /
# active-worktree smoke must not invalidate a canary after it is assigned).
ELIGIBILITY_EXCLUDED_SUITES = frozenset(
    {
        "predeploy",
        "pre-deploy",
        "predeploy-local",
        "predeploy-cloud",
        "deploy-smoke",
    }
)

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
        "auth",
        "plaid",
        "phone",
        "attachment",
        "claude-code",
        "research",
        "response-schema",
        "wait-for",
        "chat",
        "mass-agent",
        "display",
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
    "display": "display",
    "agentcard-lifecycle-sandbox": "payment",
    "agentcard-lifecycle-production": "payment",
}

PATH_TRIGGERS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (r"(^|/)agents/browser_tools/", ("browser", "browser_stateful")),
    (r"(^|/)agents/domains/browser", ("browser", "browser_stateful")),
    (r"(^|/)agents/.*cookie", ("browser_stateful", "browser")),
    (r"(^|/)agents/.*auth_session", ("browser_stateful", "browser")),
    (
        r"(^|/)agents/domains/spawn_browser_agent|(^|/)agents/benchmarks/auth_test_site"
        r"|(^|/)back-end/src/domains/(auth-test-site|auth-options|auth-assistance|credential-propagation)/"
        r"|(^|/)back-end/src/providers/(authOptions|authRealm|credentialEnvelope|benchmarkBrowserAuth|primitive)",
        ("auth",),
    ),
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
    (
        r"(^|/)agents/(domains|tools)/(prompts/)?display|(^|/)back-end/src/domains/agent-tools/display"
        r"|(^|/)back-end/src/providers/agentTools/display|(^|/)agents/benchmarks/display_check",
        ("display",),
    ),
    (
        r"(^|/)back-end/src/providers/(codeSessions/|e2b[A-Za-z]*\.ts)"
        r"|(^|/)back-end/src/domains/(code-sessions|projects)/"
        r"|(^|/)e2b-templates/(claude|codex)-code/"
        r"|(^|/)agents/benchmarks/code_agent",
        ("claude-code",),
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
    def production_only(self) -> bool:
        return self.raw.get("production_only") is True

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
    # Tasks considered for selection but rejected because the last
    # REQUIRED_PASS_STREAK attempts were not all passes (or history was short).
    skipped_history: list[str] = field(default_factory=list)
    # Floor categories with no history-qualified canary.
    uncovered_categories: list[str] = field(default_factory=list)
    pass_streak_required: int = DEFAULT_PASS_STREAK
    # Catalog eligibility/instructions only; runtime evidence owns every verdict.
    skip_eligibility: dict[str, list[str]] = field(default_factory=dict)

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


def standing_skip_eligibility(tasks: Sequence[TaskRef], selected: Sequence[str]) -> dict[str, list[str]]:
    """Describe existing runtime exceptions without deciding or changing a task outcome."""
    by_name = {task.name: task for task in tasks}
    eligibility: dict[str, list[str]] = {}
    for name in selected:
        task = by_name.get(name)
        if task is None:
            continue
        rules: list[str] = []
        lifecycle = task.raw.get("expected_payment_lifecycle")
        transfer = lifecycle.get("orgTransfer") if isinstance(lifecycle, dict) else None
        # Same literal catalog/mode predicate as run_benchmark._agentcard_release_skip_task.
        if isinstance(transfer, dict) and (
            (not task.production_only and "agentcard-lifecycle-sandbox" in task.tags
             and transfer.get("livemode") is False)
            or (task.production_only and "agentcard-lifecycle-production" in task.tags
                and transfer.get("livemode") is True)
        ):
            rules.append(
                "AgentCard release-stall standing warning: runtime "
                "run_benchmark.py::_agentcard_release_skip_lifecycle / "
                "_agentcard_release_stalled requires purchase HELD, walletFunding RECLAIMING, "
                "same nonempty card/transfer IDs, card CLOSED with numeric balanceCents=0, "
                "orgTransfer consumed with numeric releasedCents=0, "
                f"livemode={'true' if task.production_only else 'false'}, and stripeRefund=None. "
                "All independent catalog assertions must still pass; only the exact settlement "
                "stall qualifies. Default enabled; BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL=0 "
                "restores strict diagnostics. Record loud warning SKIP, unreleased amount and "
                "pending refund; never PASS or financial/native cleanup credit. "
                "See .claude/commands/deploy.md (Skippable tests: AgentCard) and "
                "docs/rca/cases/2026-10-02-agentcard-abandonment-closed-card-transfer-never-released.md."
            )
        if task.raw.get("requires_claude_code"):
            rules.append(
                "Claude Code credential-unavailable standing exception: after successful native "
                "credential sync, preflight must prove no synced Claude credentials and no pool "
                "token (native token route 404); auth/sync/transport errors do not prove absence. "
                "Runtime run_benchmark.py::_check_claude_code_credentials / "
                "_is_permitted_claude_code_skip controls the recorded outcome; requires "
                "BENCHMARK_ALLOW_CLAUDE_CODE_CREDENTIAL_SKIP=1 on the permitted deploy path, "
                "never silently enabled here. Shared ANTHROPIC_API_KEY fallback is not qualifying "
                "user/pool evidence. Task correctness remains hard-gated. "
                "See .claude/commands/deploy.md (Skippable tests: Claude Code smoke)."
            )
        if rules:
            eligibility[name] = rules
    return eligibility


def format_skip_eligibility(eligibility: dict[str, list[str]]) -> str:
    if not eligibility:
        return ""
    lines = ["Standing skip eligibility (instructions only, not a SKIP verdict):"]
    for name, rules in eligibility.items():
        lines.extend(f"  {name}: {rule}" for rule in rules)
    lines.append("All other assertions and owned-resource cleanup remain required; preserve native outcomes.")
    return "\n".join(lines)


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


def discover_changed_files(repo_root: Path, explicit: Sequence[str] | None = None) -> list[str]:
    if explicit is not None:
        return sorted({f.strip() for f in explicit if f and f.strip()})

    env_file = os.environ.get("PREDEPLOY_CHANGED_FILES", "").strip()
    if env_file:
        path = Path(env_file)
        if path.is_file():
            return sorted({line.strip() for line in path.read_text().splitlines() if line.strip()})

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
    if not task.eligible_status or task.production_only:
        return False
    # Both local and cloud predeploy execute against isolated backends. The
    # catalog's production-only lifecycles belong to explicit production runs.
    if task.raw.get("production_only"):
        return False
    if surface == "cloud" and task.local_only:
        return False
    return True


def counts_for_deploy_eligibility(entry: dict[str, Any]) -> bool:
    """Whether an attempts-ledger row may affect the predeploy history gate.

    Predeploy / active-worktree runs set `counts_for_deploy_eligibility=false`
    (and/or `suite=predeploy`) so assigning a canary into smoke cannot be
    invalidated by the worktree run that just selected it. Legacy rows with no
    field still count (daily / explicit history).

    Exclusion is OR: an excluded suite always drops the row, even if a stale
    `counts_for_deploy_eligibility: true` was written beside it.
    """
    suite = str(entry.get("suite") or "").strip().lower()
    if suite in ELIGIBILITY_EXCLUDED_SUITES:
        return False
    flag = entry.get("counts_for_deploy_eligibility")
    if flag is False:
        return False
    if flag is True:
        return True
    return True


def load_attempt_passes(attempts_file: Path) -> dict[str, list[bool]]:
    """Return chronological pass/fail lists keyed by task name.

    Reads `history/task_attempts.jsonl` plus its per-writer shards (append-only,
    see history_ledger.py). Entries are ordered by reader order, then by
    timestamp when present so out-of-order appends still yield a stable recent
    window. Rows that do not count for deploy eligibility (predeploy /
    active-worktree) are omitted.
    """
    rows: list[tuple[str, bool, str]] = []
    for index, raw_line in enumerate(history_ledger.read_lines(attempts_file)):
        line = raw_line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not counts_for_deploy_eligibility(entry):
            continue
        task = entry.get("task")
        if not isinstance(task, str) or not task:
            continue
        passed = bool(entry.get("passed"))
        timestamp = str(entry.get("timestamp") or "")
        # Stable tie-break on reader order when timestamps collide/missing.
        rows.append((task, passed, f"{timestamp}:{index:08d}"))
    rows.sort(key=lambda row: (row[0], row[2]))
    passes: dict[str, list[bool]] = {}
    for task, passed, _timestamp in rows:
        passes.setdefault(task, []).append(passed)
    return passes


def has_pass_streak(
    task_name: str,
    attempt_passes: dict[str, list[bool]],
    *,
    streak: int = DEFAULT_PASS_STREAK,
) -> bool:
    """True iff the task's last `streak` attempts all passed (requires >= streak)."""
    if streak < 1:
        raise ValueError("streak must be >= 1")
    history = attempt_passes.get(task_name) or []
    if len(history) < streak:
        return False
    return all(history[-streak:])


def _canary_sort_key(task: TaskRef) -> tuple:
    group_rank = 0 if task.group == "pre-deploy" or task.is_smoke else 1
    bench_rank = 0 if task.bench == "pipeline-e2e" else 1
    canary_rank = 0 if task.deploy_canary else 1
    ready_rank = 0 if task.status == "ready" else 1
    return (canary_rank, group_rank, bench_rank, ready_rank, task.timeout_seconds, task.name)


def candidates_for_category(
    tasks: Sequence[TaskRef],
    category: str,
    surface: str,
    *,
    attempt_passes: dict[str, list[bool]] | None = None,
    pass_streak: int = DEFAULT_PASS_STREAK,
    skipped_history: list[str] | None = None,
    require_deploy_canary: bool = False,
) -> list[TaskRef]:
    """History-qualified candidates for a category, preferred-canary first.

    When `require_deploy_canary` is True (category floor), only tasks annotated
    `deploy_canary: true` may fill the slot. Prefer leaving a floor category
    uncovered over silently promoting an arbitrary category-tagged heavy.
    Path extras keep the broader candidate pool.
    """
    out: list[TaskRef] = []
    for task in tasks:
        if not _eligible(task, surface):
            continue
        if category not in categories_for_task(task):
            continue
        if require_deploy_canary and not task.deploy_canary:
            continue
        if attempt_passes is not None and not has_pass_streak(task.name, attempt_passes, streak=pass_streak):
            if skipped_history is not None and task.name not in skipped_history:
                skipped_history.append(task.name)
            continue
        out.append(task)
    return sorted(out, key=_canary_sort_key)


def select_predeploy_benches(
    *,
    catalog: Path,
    changed_files: Sequence[str] | None = None,
    surface: str = "local",
    cap: int = DEFAULT_CAP,
    repo_root: Path | None = None,
    attempts_file: Path | None = None,
    pass_streak: int = DEFAULT_PASS_STREAK,
) -> Selection:
    if cap < 1:
        raise ValueError("cap must be >= 1")
    if surface not in {"local", "cloud"}:
        raise ValueError("surface must be 'local' or 'cloud'")
    if pass_streak < 1:
        raise ValueError("pass_streak must be >= 1")

    tasks = load_tasks(catalog)
    root = repo_root or catalog.resolve().parents[2]
    changed = discover_changed_files(root, changed_files)
    triggered = categories_triggered_by_paths(changed)
    attempts_path = attempts_file or DEFAULT_ATTEMPTS
    attempt_passes = load_attempt_passes(attempts_path)

    reasons: dict[str, list[str]] = {}
    selected: list[str] = []
    selected_set: set[str] = set()
    floor: list[str] = []
    path_extras: list[str] = []
    dropped: list[str] = []
    categories_covered: list[str] = []
    skipped_history: list[str] = []
    uncovered_categories: list[str] = []

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

    # Existing smoke tags always run — history gate applies only to canaries /
    # path extras being *added* into the predeploy smoke set.
    smoke_tasks = [t for t in tasks if t.is_smoke and _eligible(t, surface)]
    smoke_selected = 0
    for task in smoke_tasks:
        if not _add(task.name, floor, "floor:smoke"):
            raise SystemExit(
                f"PREDEPLOY FLOOR smoke set cannot fit in hard cap ({cap}). "
                "Shrink smoke-tagged tasks or raise PREDEPLOY_BENCH_CAP."
            )
        smoke_selected += 1
    if smoke_selected:
        categories_covered.append("harness")

    for category in FLOOR_CATEGORIES:
        found = False
        for cand in candidates_for_category(
            tasks,
            category,
            surface,
            attempt_passes=attempt_passes,
            pass_streak=pass_streak,
            skipped_history=skipped_history,
            require_deploy_canary=True,
        ):
            if cand.name in selected_set:
                if category not in categories_covered:
                    categories_covered.append(category)
                found = True
                break
            if not _add(cand.name, floor, f"floor:canary:{category}"):
                raise SystemExit(
                    f"PREDEPLOY FLOOR (smoke + canaries) cannot fit category "
                    f"{category!r} into hard cap ({cap}). Shrink "
                    "FLOOR_CATEGORIES / smoke set or raise PREDEPLOY_BENCH_CAP."
                )
            categories_covered.append(category)
            found = True
            break
        if not found:
            uncovered_categories.append(category)

    if len(floor) > cap:
        raise SystemExit(
            f"PREDEPLOY FLOOR ({len(floor)}) exceeds hard cap ({cap}). "
            "Shrink FLOOR_CATEGORIES / smoke set before deploying."
        )

    def _add_one_extra(category: str, reason_prefix: str) -> None:
        for cand in candidates_for_category(
            tasks,
            category,
            surface,
            attempt_passes=attempt_passes,
            pass_streak=pass_streak,
            skipped_history=skipped_history,
        ):
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
    # A category scan also visits tasks the smoke floor already selected; those are
    # selected, not history-skipped.
    skipped_history = [name for name in skipped_history if name not in selected_set]
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
        skipped_history=skipped_history,
        uncovered_categories=uncovered_categories,
        pass_streak_required=pass_streak,
        skip_eligibility=standing_skip_eligibility(tasks, selected),
    )


def format_report(selection: Selection) -> str:
    lines = [
        "========== PREDEPLOY BENCH SELECTION ==========",
        f"Surface: {selection.surface}",
        f"Hard cap: {selection.cap}",
        f"Pass streak required for added canaries/path extras (not existing smoke): "
        f"last {selection.pass_streak_required} eligibility runs all passed "
        f"(predeploy/worktree attempts excluded)",
        f"Changed files: {len(selection.changed_files)}",
        f"Path-triggered categories: {', '.join(selection.triggered_categories) or '(none)'}",
        f"Categories covered: {', '.join(selection.categories_covered) or '(none)'}",
        f"Floor ({len(selection.floor)}): {', '.join(selection.floor) or '(none)'}",
        f"Path extras ({len(selection.path_extras)}): {', '.join(selection.path_extras) or '(none)'}",
        f"TOTAL SELECTED: {selection.total} / {selection.cap}",
    ]
    if selection.skipped_history:
        lines.append(
            f"Skipped (need last {selection.pass_streak_required} historic passes) "
            f"({len(selection.skipped_history)}): "
            f"{', '.join(selection.skipped_history)}"
        )
    if selection.uncovered_categories:
        lines.append(
            f"Uncovered floor categories (no canary with "
            f"{selection.pass_streak_required}-pass streak): "
            f"{', '.join(selection.uncovered_categories)}"
        )
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
        lines.append(f"*** AT HARD CAP ({selection.cap}/{selection.cap}) — no room for further extras ***")
    if selection.dropped and not selection.cap_hit:
        lines.append(f"Dropped: {', '.join(selection.dropped)}")
    if guidance := format_skip_eligibility(selection.skip_eligibility):
        lines.append(guidance)
    lines.append("==============================================")
    return "\n".join(lines)


def scream_if_cap_hit(selection: Selection, stream=None, *, include_stdout: bool = True) -> None:
    stream = stream or sys.stderr
    if not selection.cap_hit:
        if selection.total == selection.cap:
            msg = f"*** PREDEPLOY BENCH COUNT AT HARD CAP: {selection.total}/{selection.cap} ***"
            print(msg, file=stream)
            if include_stdout:
                print(msg, file=sys.stdout)
        return
    text = CAP_SCREAM.format(
        selected=selection.total,
        cap=selection.cap,
        dropped_count=len(selection.dropped),
        dropped=", ".join(selection.dropped) or "(none)",
    )
    print(text, file=stream)
    if include_stdout:
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
    parser.add_argument(
        "--attempts-file",
        type=Path,
        default=Path(os.environ.get("PREDEPLOY_ATTEMPTS_FILE", DEFAULT_ATTEMPTS)),
        help="Historic attempts JSONL used for the last-N-pass gate.",
    )
    parser.add_argument(
        "--pass-streak",
        type=int,
        default=int(os.environ.get("PREDEPLOY_PASS_STREAK", DEFAULT_PASS_STREAK)),
        help="Require the last N historic attempts to all pass (default 3).",
    )
    parser.add_argument("--repo-root", type=Path, default=None)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if args.cap > DEFAULT_CAP:
        print(
            f"WARNING: --cap/{args.cap} exceeds hard ceiling {DEFAULT_CAP}; clamping",
            file=sys.stderr,
        )
        args.cap = DEFAULT_CAP
    explicit: list[str] | None = None
    if args.changed_files_from is not None:
        explicit = [line.strip() for line in args.changed_files_from.read_text().splitlines() if line.strip()]
    if args.changed_file:
        explicit = (explicit or []) + list(args.changed_file)

    selection = select_predeploy_benches(
        catalog=args.catalog,
        changed_files=explicit,
        surface=args.surface,
        cap=args.cap,
        repo_root=args.repo_root,
        attempts_file=args.attempts_file,
        pass_streak=args.pass_streak,
    )

    if args.format == "names":
        print("\n".join(selection.selected))
        if guidance := format_skip_eligibility(selection.skip_eligibility):
            print(guidance, file=sys.stderr)
        # stdout is the task inventory consumed by the native deploy planner.
        # Keep the full cap warning on stderr without inventing task rows.
        scream_if_cap_hit(selection, include_stdout=False)
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
                    "skipped_history": selection.skipped_history,
                    "uncovered_categories": selection.uncovered_categories,
                    "pass_streak_required": selection.pass_streak_required,
                    "reasons": selection.reasons,
                    "surface": selection.surface,
                    "skip_eligibility": selection.skip_eligibility,
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
