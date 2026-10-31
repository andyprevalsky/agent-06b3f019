"""Bounded, secret-free outcome detail for factory stage records and events.

Stage records (`run_deploy_stage.py`) and factory events
(`record_factory_event.py`, `descend_step_log.py`) carry an optional
`detail` object so a later review can explain gap time, reruns and failures:

- outcome: exit code class, failure class, first failing names, counts
- attempt: attempt number, prior attempt, retry cause and fix commit
- reuse: exact-input cache hit or miss with the miss reason
- timing: setup (pre-exec) seconds, optional queue wait, concurrent stages
- host: load average and available-memory samples, peak child RSS
- source: HEAD, merge base, diff size and changed lanes

Every value is allowlisted, typed and length-bounded. Names are restricted to a
safe character set and long opaque tokens are rejected so a log line can never
copy a credential into the tracked ledger. Absent data stays absent; nothing is
estimated. `detail.schema_version` versions this object independently of the
envelope, so readers that ignore `detail` are unaffected.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import resource
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Iterable, Sequence

DETAIL_SCHEMA_VERSION = 1
MAX_NAMES = 10
MAX_TEXT = 160
LOG_TAIL_BYTES = 2 * 1024 * 1024
SAMPLE_INTERVAL_SECONDS = 5.0
LANE_PREFIXES = (
    ("back-end/prisma/", "schema"),
    ("back-end/", "backend"),
    ("front-end/", "frontend"),
    ("agents/benchmarks/history/", "history"),
    ("agents/benchmarks/", "benchmarks"),
    ("agents/", "agents"),
    ("mac-app/", "mac-app"),
    ("docs/", "docs"),
    ("research/", "research"),
    (".claude/", "instructions"),
    ("scripts/", "scripts"),
    (".github/", "ci"),
)
SAFE_TEXT_RE = re.compile(r"^[A-Za-z0-9_.:/\[\]()<>=,+@#|~ -]+$")
# Credential-shaped runs: 24+ base64/alnum characters mixing letters and digits.
OPAQUE_TOKEN_RE = re.compile(r"(?=[A-Za-z0-9+/=]*\d)(?=[A-Za-z0-9+/=]*[A-Za-z])[A-Za-z0-9+/=]{24,}")
HEX_SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")

# Ordered: the first matching class wins. These label tooling logs for the
# factory review only; they never steer an agent or a gate's verdict.
FAILURE_CLASSES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("disk-full", re.compile(r"ENOSPC|No space left on device")),
    ("oom", re.compile(r"Out of memory|MemoryError|JavaScript heap out of memory|memory watchdog")),
    ("db-pool", re.compile(r"EMAXCONN|P2024|too many clients|remaining connection slots")),
    ("network", re.compile(r"ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|Connection refused")),
    ("rate-limit", re.compile(r"\b429\b|rate.?limit", re.IGNORECASE)),
    ("timeout", re.compile(r"timed out|TimeoutError|Timeout of \d+ms exceeded|deadline exceeded", re.IGNORECASE)),
    ("typecheck", re.compile(r"error TS\d{4}|mypy: .*error")),
    ("lint", re.compile(r"\d+ problems? \(\d+ errors?|eslint.*error|Code style issues found|ruff.*error|Would reformat")),
    ("coverage", re.compile(r"coverage.*(threshold|below)|fail_under|ERROR: Coverage for", re.IGNORECASE)),
    ("test-failure", re.compile(r"FAILED |^not ok |✗|✖|\bFAIL\b|AssertionError|failed deploy structural gates", re.MULTILINE)),
    ("missing-dependency", re.compile(r"command not found|ModuleNotFoundError|Cannot find module|ERR_MODULE_NOT_FOUND")),
)
FAILING_NAME_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"failed deploy structural gates: (?P<list>.+)$", re.MULTILINE),
    re.compile(r"^FAILED (?P<name>\S+)", re.MULTILINE),
    re.compile(r"^not ok \d+ - (?P<name>.+)$", re.MULTILINE),
    re.compile(r"^\s*(?:✖|✗|×) (?P<name>[^\n(]+?)(?: \(\d|$)", re.MULTILINE),
    re.compile(r"^ FAIL  (?P<name>\S+)", re.MULTILINE),
    re.compile(r"^== (?P<name>[A-Za-z0-9._-]+): exit=(?!0\b)\d+", re.MULTILINE),
    re.compile(r"^(?P<name>\S+\.(?:ts|tsx|js|py))\(\d+,\d+\): error TS\d+", re.MULTILINE),
)
COUNT_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    # pytest: "== 2 failed, 40 passed in 3.1s =="
    ("pytest", re.compile(r"=+ (?:(?P<failed>\d+) failed)?(?:, )?(?:(?P<passed>\d+) passed)?[^=\n]* in [\d.]+s")),
    # node:test TAP summary
    ("node-test", re.compile(r"^# pass (?P<passed>\d+)\n(?:#[^\n]*\n)*?# fail (?P<failed>\d+)", re.MULTILINE)),
    # vitest: "Tests  2 failed | 40 passed (42)"
    ("vitest", re.compile(r"Tests\s+(?:(?P<failed>\d+) failed \| )?(?P<passed>\d+) passed")),
    # blackbox runners: "RESULTS: 40/42 passed"
    ("results", re.compile(r"RESULTS: (?P<passed>\d+)/(?P<total>\d+) passed")),
)
SELECTION_RE = re.compile(r"TOTAL SELECTED: (?P<selected>\d+) / (?P<total>\d+)")

EVENT_DETAIL_FIELDS: dict[str, type] = {
    "provider": str,
    "service": str,
    "request_id": str,
    "run_id": str,
    "reason": str,
    "failure_class": str,
    "outcome_class": str,
    "fix_sha": str,
    "pr_number": int,
    "review_cycle": int,
    "attempt": int,
    "repro_attempt": int,
    "failed_count": int,
    "passed_count": int,
    "total_count": int,
    "task_count": int,
    "infra_failed": int,
    "scheduled_total": int,
    "duration_seconds": float,
    "failing": list,
}


class DetailError(ValueError):
    """Raised when detail values are outside the allowlist."""


def safe_text(value: object) -> str | None:
    """Return a bounded single-line name, or None when it could carry secrets."""
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())[:MAX_TEXT].strip()
    if not text or not SAFE_TEXT_RE.fullmatch(text):
        return None
    if OPAQUE_TOKEN_RE.search(text) or re.search(r"(?i)(?<![a-z0-9])[a-f0-9]{24,}(?![a-z0-9])", text):
        return None
    return text


def _bounded_names(names: Iterable[str]) -> list[str]:
    out: list[str] = []
    for raw in names:
        name = safe_text(raw)
        if name and name not in out:
            out.append(name)
        if len(out) >= MAX_NAMES:
            break
    return out


def read_log_tail(path: Path, limit: int = LOG_TAIL_BYTES) -> str:
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - limit))
            return handle.read().decode(errors="replace")
    except OSError:
        return ""


def scan_log(text: str) -> dict[str, Any]:
    """Extract failure class, failing names and counts from a stage log."""
    detail: dict[str, Any] = {}
    for name, pattern in FAILURE_CLASSES:
        if pattern.search(text):
            detail["log_failure_class"] = name
            break
    names: list[str] = []
    for pattern in FAILING_NAME_PATTERNS:
        for match in pattern.finditer(text):
            group = match.groupdict()
            if group.get("list"):
                names.extend(part.strip() for part in group["list"].split(","))
            elif group.get("name"):
                names.append(group["name"].strip())
    failing = _bounded_names(names)
    if failing:
        detail["failing"] = failing
    for runner, pattern in COUNT_PATTERNS:
        matches = [m for m in pattern.finditer(text) if any(m.groupdict().values())]
        if not matches:
            continue
        values = matches[-1].groupdict()
        failed = int(values.get("failed") or 0)
        passed = int(values.get("passed") or 0)
        total = int(values["total"]) if values.get("total") else failed + passed
        if runner == "results":
            failed = max(0, total - passed)
        detail.update(
            {"count_source": runner, "failed_count": failed, "passed_count": passed, "total_count": total}
        )
        break
    selection = list(SELECTION_RE.finditer(text))
    if selection:
        detail["selected_count"] = int(selection[-1]["selected"])
        detail["selectable_total"] = int(selection[-1]["total"])
    return detail


def reported_test_failure(text: str) -> dict[str, Any]:
    """Use only a terminal runner inventory, never a stale nested marker."""
    prefix = "FACTORY_TEST_FAILURE "
    lines = text.rstrip().splitlines()
    if not lines or not lines[-1].startswith(prefix):
        return {}
    try:
        value = json.loads(lines[-1][len(prefix):])
    except (ValueError, TypeError):
        return {}
    if not isinstance(value, dict) or value.get("runner") != "agents-blackbox-domains":
        return {}
    counts = [value.get(key) for key in ("passed", "failed", "total")]
    if not all(type(count) is int and count >= 0 for count in counts):
        return {}
    passed, failed, total = counts
    names = value.get("failing")
    if failed == 0 or passed + failed != total or not isinstance(names, list):
        return {}
    if len(names) != failed or any(
        not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9_.-]+", name)
        for name in names
    ):
        return {}
    if len(set(names)) != failed:
        return {}
    return {"failure_class": "test-failure", "failure_class_source": "runner-summary",
            "count_source": "agents-blackbox-domains", "passed_count": passed,
            "failed_count": failed, "total_count": total, "failing": _bounded_names(names)}


def outcome_detail(exit_code: int, log_text: str) -> dict[str, Any]:
    scanned = scan_log(log_text)
    if exit_code == 0:
        failure_class = None
    elif exit_code == 124:
        failure_class = scanned.get("log_failure_class") or "timeout"
    elif exit_code > 128:
        failure_class = scanned.get("log_failure_class") or f"signal-{exit_code - 128}"
    elif exit_code == 127:
        failure_class = "missing-dependency"
    else:
        failure_class = scanned.get("log_failure_class") or "nonzero-exit"
    out: dict[str, Any] = {"exit_code": exit_code, "failure_class": failure_class}
    for key in ("failing", "failed_count", "passed_count", "total_count", "count_source",
                "selected_count", "selectable_total"):
        if key in scanned:
            out[key] = scanned[key]
    if exit_code == 1:
        reported = reported_test_failure(log_text)
        if reported:
            if scanned.get("log_failure_class"):
                out["unverified_log_failure_hint"] = scanned["log_failure_class"]
            out.update(reported)
    if exit_code == 0:
        out.pop("failing", None)
    return out


def _git(repo: Path, *args: str) -> str | None:
    try:
        return subprocess.run(
            ["git", *args], cwd=repo, check=True, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=30
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def lane_for(path: str) -> str:
    for prefix, lane in LANE_PREFIXES:
        if path.startswith(prefix):
            return lane
    return "root"


def source_detail(repo: Path, base_ref: str = "origin/main") -> dict[str, Any]:
    """HEAD, merge base, committed+working diff size and changed lanes."""
    head = _git(repo, "rev-parse", "HEAD")
    if not head:
        return {}
    out: dict[str, Any] = {"sha": head}
    base = _git(repo, "merge-base", "HEAD", base_ref)
    working = _git(repo, "diff", "--no-ext-diff", "HEAD")
    if working is not None:
        out["dirty"] = bool(working)
        if working:
            out["dirty_digest"] = hashlib.sha256(working.encode()).hexdigest()[:16]
    if base:
        out["base_sha"] = base
        numstat = _git(repo, "diff", "--numstat", base)
        untracked_text = _git(repo, "ls-files", "--others", "--exclude-standard")
        if untracked_text is not None:
            out["untracked_files"] = len(untracked_text.splitlines())
        if numstat is None:
            return out
        files: list[str] = []
        insertions = deletions = 0
        for line in numstat.splitlines():
            parts = line.split("\t", 2)
            if len(parts) != 3:
                continue
            added, removed, path = parts
            files.append(path)
            insertions += int(added) if added.isdigit() else 0
            deletions += int(removed) if removed.isdigit() else 0
        out.update(insertions=insertions, deletions=deletions)
        if untracked_text is None:
            return out
        files.extend(untracked_text.splitlines())
        out.update(
            {
                "files_changed": len(files),
                "insertions": insertions,
                "deletions": deletions,
                "lanes": sorted({lane_for(path) for path in files}),
            }
        )
    return out


def _load_rows(path: Path) -> list[dict[str, Any]]:
    rows = []
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return rows
    for line in lines:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def attempt_detail(run_dir: Path, stage: str, source: dict[str, Any]) -> dict[str, Any]:
    """Attempt number in this run, and why it was rerun when it is a retry."""
    prior = [
        row for row in _load_rows(run_dir / "stages.jsonl")
        if row.get("stage") == stage and row.get("status") != "reused"
    ]
    out: dict[str, Any] = {"attempt": len(prior) + 1}
    if not prior:
        return out
    last = max(prior, key=lambda row: float(row.get("started_epoch") or 0.0))
    out["retry_of_started_at"] = last.get("started_at")
    out["prior_status"] = last.get("status")
    last_source = (last.get("detail") or {}).get("source") or {}
    prior_sha = last_source.get("sha")
    current_sha = source.get("sha")
    if prior_sha and current_sha and prior_sha != current_sha:
        out["retry_cause"] = "new-commit"
        out["fix_sha"] = current_sha
        out["prior_sha"] = prior_sha
    elif prior_sha and current_sha and not (
        ("dirty" in last_source or last_source.get("dirty_digest"))
        and ("dirty" in source or source.get("dirty_digest"))
    ):
        out["retry_cause"] = "unrecorded-source-state"
    elif prior_sha and current_sha and last_source.get("dirty_digest") != source.get("dirty_digest"):
        out["retry_cause"] = "worktree-edit"
    elif prior_sha and current_sha:
        out["retry_cause"] = "unchanged-source"
    else:
        out["retry_cause"] = "unrecorded-prior-source"
    return out


def reuse_detail(cache_dir: Path, fingerprint: str | None, *, requested: bool, hit: bool) -> dict[str, Any]:
    """Explain a --reuse-passed decision without exposing hashed inputs."""
    if not requested:
        return {"requested": False}
    out: dict[str, Any] = {"requested": True, "hit": hit}
    if fingerprint:
        out["fingerprint"] = fingerprint[:12]
    if hit:
        return out
    if fingerprint is None:
        out["miss_reason"] = "fingerprint-unavailable"
    else:
        try:
            others = [p for p in cache_dir.glob("*.json") if p.stem != fingerprint]
        except OSError:
            others = []
        out["miss_reason"] = "inputs-changed" if others else "no-prior-pass"
    return out


def active_admissions(run_dir: Path) -> int:
    try:
        return sum(1 for _ in (run_dir / "admissions").glob("*.json"))
    except OSError:
        return 0


def _meminfo() -> tuple[float | None, float | None]:
    try:
        values = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, _, rest = line.partition(":")
            if key in {"MemTotal", "MemAvailable"}:
                values[key] = int(rest.split()[0]) / 1024.0
        return values.get("MemTotal"), values.get("MemAvailable")
    except (OSError, ValueError, IndexError):
        return None, None


def _load1() -> float | None:
    try:
        return os.getloadavg()[0]
    except OSError:
        return None


class HostSampler:
    """Low-rate background sampler of host load and available memory."""

    def __init__(self, interval: float = SAMPLE_INTERVAL_SECONDS) -> None:
        self.interval = interval
        self.samples = 0
        self.load_start = _load1()
        self.load_peak = self.load_start
        total, available = _meminfo()
        self.mem_total = total
        self.mem_available_min = available
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _sample(self) -> None:
        self.samples += 1
        load = _load1()
        if load is not None:
            self.load_peak = load if self.load_peak is None else max(self.load_peak, load)
        _, available = _meminfo()
        if available is not None:
            self.mem_available_min = (
                available if self.mem_available_min is None else min(self.mem_available_min, available)
            )

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            self._sample()

    def start(self) -> "HostSampler":
        self._thread.start()
        return self

    def stop(self) -> dict[str, Any]:
        self._stop.set()
        self._thread.join(timeout=1.0)
        self._sample()
        rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        rss_mb = rss / (1024.0 * 1024.0) if sys.platform == "darwin" else rss / 1024.0
        out: dict[str, Any] = {"cpu_count": os.cpu_count(), "samples": self.samples}
        for key, value in (
            ("load1_start", self.load_start),
            ("load1_peak", self.load_peak),
            ("mem_total_mb", self.mem_total),
            ("mem_available_min_mb", self.mem_available_min),
            ("child_peak_rss_mb", rss_mb),
        ):
            if value is not None:
                out[key] = round(float(value), 2)
        return out


def queue_seconds(started_epoch: float) -> float | None:
    """Wait before the stage began, when the caller exported when it queued."""
    raw = os.environ.get("FACTORY_STAGE_QUEUED_EPOCH")
    if not raw:
        return None
    try:
        queued = float(raw)
    except ValueError:
        return None
    if queued <= 0 or queued > started_epoch:
        return None
    return round(started_epoch - queued, 3)


def stage_detail(
    *,
    exit_code: int,
    log_path: Path | None,
    invoked_epoch: float,
    started_epoch: float,
    finished_epoch: float,
    concurrent_stages: int,
    host: dict[str, Any],
    source: dict[str, Any],
    attempt: dict[str, Any],
    reuse: dict[str, Any],
) -> dict[str, Any]:
    timing: dict[str, Any] = {
        "setup_seconds": round(max(0.0, started_epoch - invoked_epoch), 3),
        "exec_seconds": round(max(0.0, finished_epoch - started_epoch), 3),
        "concurrent_stages": concurrent_stages,
    }
    waited = queue_seconds(started_epoch)
    if waited is not None:
        timing["queue_seconds"] = waited
    text = read_log_tail(log_path) if log_path is not None else ""
    return {
        "schema_version": DETAIL_SCHEMA_VERSION,
        "outcome": outcome_detail(exit_code, text),
        "attempt": attempt,
        "reuse": reuse,
        "timing": timing,
        "host": host,
        "source": source,
    }


def parse_event_detail(pairs: Sequence[str]) -> dict[str, Any]:
    """Validate `KEY=VALUE` pairs for factory events against the allowlist."""
    out: dict[str, Any] = {}
    for pair in pairs:
        key, sep, raw = pair.partition("=")
        expected = EVENT_DETAIL_FIELDS.get(key)
        if not sep or expected is None:
            raise DetailError(
                f"unsupported factory detail {key!r}; allowed: {', '.join(sorted(EVENT_DETAIL_FIELDS))}"
            )
        if expected is int:
            if not (raw.isascii() and raw.isdigit() and len(raw) <= 18):
                raise DetailError(f"factory detail {key} must be a non-negative integer")
            out[key] = int(raw)
        elif expected is float:
            try:
                value = float(raw)
            except ValueError as error:
                raise DetailError(f"factory detail {key} must be a number") from error
            if value < 0 or value != value or value == float("inf"):
                raise DetailError(f"factory detail {key} must be finite and non-negative")
            out[key] = value
        elif expected is list:
            names = _bounded_names(part for part in raw.split(","))
            if not names:
                raise DetailError(f"factory detail {key} has no safe names")
            out[key] = names
        else:
            if key == "fix_sha" and not HEX_SHA_RE.fullmatch(raw):
                raise DetailError("factory detail fix_sha must be a hex commit SHA")
            text = raw if key == "fix_sha" else safe_text(raw)
            if text is None:
                raise DetailError(f"factory detail {key} is not a safe bounded name")
            out[key] = text
    if out:
        out = {"schema_version": DETAIL_SCHEMA_VERSION, **out}
    return out
