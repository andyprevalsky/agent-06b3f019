"""Rose vs raw-CLI parity for the code-bench tasks (plan C8).

C8 criterion: on the same code-bench tasks, the Rose code agent passes at least
as many tasks as the underlying CLI run directly, within max(1 task, 5%), and
each leg reproduces across K=3 runs.

Data path (both legs grade with ``code_bench.evaluate_archive_bytes``):

  Rose leg   scripts/run-bench [--local] <code-bench-*>   (root agent -> spawn_claude_code_agent
             -> E2B sandbox; graded by run_benchmark's declared evaluators)
             -> agents/benchmarks/runs/*.json  --rose-records / --run-rose local
  Raw leg    <sandbox>/attachments/<fixture>.tar.gz  (byte-identical to the Rose attachment)
             claude --print ... | codex exec ...  (cwd = sandbox, same task text, same model,
             isolated CLI config: no user CLAUDE.md, settings, skills or AGENTS.md)
             -> <sandbox>/output/result.tar.gz -> hidden tests (+ screenshot judge)
  Report     per task x/K for each leg, per-run pass counts, mean, stdev, flaky tasks,
             parity_ok = mean(rose) >= mean(raw) - max(1, 5% of tasks), reproducible
             = per-run spread <= that tolerance.

Usage (from the repository root):

  scripts/run-bench code-parity --run-rose local -k 3            # all code-bench tasks, Claude Code
  scripts/run-bench code-parity --rose-records agents/benchmarks/runs/<run>.json ... -k 3
  scripts/run-bench code-parity --tasks code-bench-bugfix-invoice-rounding -k 1 --skip-rose

Raw-leg credentials are the same variables the E2B templates read:
CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY for Claude Code; CODEX_AUTH_JSON or
OPENAI_API_KEY for Codex. Without them the CLI's own managed login (if any) is used;
an auth failure is reported as that attempt's failure reason, never as a pass.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
import re
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional

from benchmarks import code_bench as cb

AGENTS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENTS_DIR.parent
TASKS_JSON = Path(__file__).resolve().parent / "tasks.json"
DEFAULT_OUT_ROOT = REPO_ROOT / ".context" / "code-bench-parity"
FRONTEND_URL = "https://roselabs.ai"
PROD_BACKEND_URL = "https://navi-j9a9.onrender.com"
OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api"  # claudeCodeSandboxAuth.ts
BENCH_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"  # run_benchmark.USER_ID

# Mirror the flash row of back-end/src/providers/codeAgentModels.ts (the
# unknown-tier default e2b.ts and e2b-templates/*/ws-server.mjs use) so both
# legs run the same model and flags.
DEFAULT_MODELS = {"claude": "claude-opus-5-5", "codex": "gpt-6.1-sol"}
DEFAULT_EFFORT = "medium"
EFFORT_ENV = {"claude": "CLAUDE_CODE_EFFORT", "codex": "CODEX_REASONING_EFFORT"}
MODEL_ENV = {"claude": "CLAUDE_CODE_MODEL", "codex": "CODEX_CODE_MODEL"}
CLAUDE_ALLOWED_TOOLS = "Bash,Read,Write,Edit,MultiEdit,Glob,Grep,LS,TodoWrite"
CREDENTIAL_ENV = {
    "claude": ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"),
    "codex": ("OPENAI_API_KEY",),
}
_BASE_ENV = ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR")
TOLERANCE_FRACTION = 0.05
# The caller's environment at import, before any agents/.env load in this process.
_CALLER_ENV = dict(os.environ)


@dataclass(frozen=True)
class CliCommand:
    argv: list[str]
    stdin: Optional[str]


def cli_command(cli: str, model: str, workdir: Path, prompt: str, *, cli_bin: Optional[str] = None, effort: str = DEFAULT_EFFORT) -> CliCommand:
    """The direct CLI invocation: the template's flags without Rose's system prompt or task wrapper."""
    if cli == "claude":
        argv = [
            cli_bin or "claude",
            "--print",
            "--verbose",
            "--output-format",
            "stream-json",
            "--model",
            model,
            "--effort",
            effort,
            "--permission-mode",
            "bypassPermissions",
            "--allowedTools",
            CLAUDE_ALLOWED_TOOLS,
        ]
        return CliCommand(argv=argv, stdin=prompt)
    if cli == "codex":
        argv = [
            cli_bin or "codex",
            "exec",
            "--ignore-user-config",
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            "--json",
            "--cd",
            str(workdir),
            "-c",
            f'model_reasoning_effort={json.dumps(effort)}',
            "-m",
            model,
            prompt,
        ]
        return CliCommand(argv=argv, stdin=None)
    raise ValueError(f"unsupported cli {cli!r}; expected claude or codex")


def default_model(cli: str) -> str:
    return os.environ.get(MODEL_ENV[cli], "").strip() or DEFAULT_MODELS[cli]


def cli_env(
    cli: str, sandbox: Path, *, pass_env: Iterable[str] = (), source_env: Optional[Mapping[str, str]] = None
) -> dict[str, str]:
    """Allowlisted environment with a fresh CLI config dir inside the sandbox.

    ``source_env`` is the caller's environment captured before anything in this
    process loads ``agents/.env``: the screenshot judge's config load would
    otherwise leak the shared ANTHROPIC_API_KEY into every later CLI attempt.
    """
    source = os.environ if source_env is None else source_env
    env = {name: source[name] for name in (*_BASE_ENV, *CREDENTIAL_ENV[cli], *pass_env) if name in source}
    env.setdefault("PATH", "/usr/bin:/bin")
    env["NO_COLOR"] = "1"
    if cli == "claude":
        config = sandbox / ".claude-config"
        config.mkdir(exist_ok=True)
        env["CLAUDE_CONFIG_DIR"] = str(config)
    else:
        codex_home = sandbox / ".codex-home"
        codex_home.mkdir(exist_ok=True)
        env["CODEX_HOME"] = str(codex_home)
        auth_json = source.get("CODEX_AUTH_JSON")
        if auth_json:
            json.loads(auth_json)
            auth_path = codex_home / "auth.json"
            auth_path.write_text(auth_json)
            auth_path.chmod(0o600)
    return env


def describe_transport(env: Mapping[str, str]) -> str:
    """Which credential/gateway the CLI attempt used, without any secret value."""
    base = env.get("ANTHROPIC_BASE_URL")
    if env.get("CLAUDE_CODE_OAUTH_TOKEN"):
        kind = "oauth-token"
    elif env.get("ANTHROPIC_API_KEY") or env.get("ANTHROPIC_AUTH_TOKEN"):
        kind = "api-key"
    elif env.get("OPENAI_API_KEY"):
        kind = "openai-api-key"
    else:
        kind = "cli-managed-login"
    return f"{kind}@{base}" if base else kind


def _run_cli(argv: list[str], *, cwd: Path, stdin: Optional[str], timeout: int, env: dict[str, str]) -> tuple[int, str]:
    """Run one CLI attempt in its own process group; kill the group on timeout."""
    try:
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
    except FileNotFoundError as exc:
        return 127, f"{argv[0]} not found on PATH ({exc}); install the CLI or pass --cli-bin"
    try:
        out, _ = proc.communicate(input=stdin, timeout=timeout)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGKILL)
        out, _ = proc.communicate()
        return -9, f"timed out after {timeout}s\n{out or ''}"
    return proc.returncode, out or ""


def _json_lines(transcript: str) -> Iterable[dict]:
    for line in transcript.splitlines():
        line = line.strip()
        if line.startswith("{"):
            with contextlib.suppress(json.JSONDecodeError):
                event = json.loads(line)
                if isinstance(event, dict):
                    yield event


def summarize_transcript(cli: str, transcript: str) -> dict[str, Any]:
    """Usage, cost and loaded extensions from the CLI's JSON event stream.

    Extensions (skills, plugins, MCP servers, hooks) come from the host's managed
    or user configuration, not from the task; a non-empty list means this raw leg
    did not run the bare CLI and the report says so.
    """
    summary: dict[str, Any] = {}
    if cli == "claude":
        hooks = 0
        for event in _json_lines(transcript):
            kind, subtype = event.get("type"), event.get("subtype")
            if kind == "system" and subtype == "init":
                summary["cli_version"] = event.get("claude_code_version")
                summary["model"] = event.get("model")
                summary["skills"] = list(event.get("skills") or [])
                summary["plugins"] = [
                    p.get("name")
                    for p in event.get("plugins") or []
                    if isinstance(p, dict) and p.get("path") != "builtin"
                ]
                summary["mcp_servers"] = [
                    s.get("name") if isinstance(s, dict) else s for s in event.get("mcp_servers") or []
                ]
            elif kind == "system" and subtype == "hook_started":
                hooks += 1
            elif kind == "result":
                usage = event.get("usage") or {}
                summary.update(
                    {
                        "result": subtype,
                        "is_error": event.get("is_error"),
                        "api_error_status": event.get("api_error_status"),
                        "result_text": str(event.get("result") or "")[:300],
                        "num_turns": event.get("num_turns"),
                        "cost_usd": event.get("total_cost_usd"),
                        "input_tokens": usage.get("input_tokens"),
                        "output_tokens": usage.get("output_tokens"),
                        "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
                        "cache_creation_input_tokens": usage.get("cache_creation_input_tokens"),
                    }
                )
        summary["hooks_run"] = hooks
        # Built-in CLI skills ship in both legs; hooks, MCP servers and installed
        # plugins come from the host configuration.
        summary["host_extensions"] = bool(summary.get("plugins") or summary.get("mcp_servers") or hooks)
    else:
        totals = {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}
        turns = 0
        for event in _json_lines(transcript):
            if event.get("type") == "turn.completed":
                turns += 1
                for key in totals:
                    totals[key] += int((event.get("usage") or {}).get(key) or 0)
        summary.update(totals, num_turns=turns)
    return summary


def infra_failure(cli_run: dict[str, Any], exit_code: int) -> Optional[str]:
    """A provider/credential error reported by the CLI itself, not a capability verdict.

    Claude Code's result event carries the API's HTTP status when a request failed
    (for example 400 "Credit balance is too low", 401, 429, 529). Such attempts are
    retried with ``--rerun-infra`` and never count as task failures.
    """
    status = cli_run.get("api_error_status")
    if exit_code != 0 and cli_run.get("is_error") and status:
        return f"provider API error {status}: {cli_run.get('result_text') or 'no message'}"
    if exit_code == 127:
        return "CLI executable not found"
    return None


def load_catalog_task(task_name: str) -> dict:
    for task in json.loads(TASKS_JSON.read_text()):
        if task.get("name") == task_name:
            return task
    raise KeyError(f"{task_name} is not in {TASKS_JSON}")


def code_bench_task_names() -> list[str]:
    return [f"{cb.TASK_NAME_PREFIX}{fixture_id}" for fixture_id in cb.fixture_ids()]


def _screenshot_evaluator(task: dict) -> Optional[dict]:
    return next((e for e in task.get("evaluators") or [] if e.get("method") == cb.SCREENSHOT_METHOD), None)


async def run_raw_attempt(
    task_name: str,
    *,
    cli: str,
    model: str,
    timeout: Optional[int] = None,
    judge: bool = True,
    cli_bin: Optional[str] = None,
    pass_env: Iterable[str] = (),
    source_env: Optional[Mapping[str, str]] = None,
    evidence_dir: Optional[Path] = None,
    keep_sandbox: bool = False,
) -> dict[str, Any]:
    """One raw-CLI attempt on a fresh copy of the fixture, graded like the Rose leg."""
    fixture = cb.load_fixture(cb.fixture_id_for_task(task_name))
    task = load_catalog_task(task_name)
    timeout = int(timeout or task.get("timeout_seconds") or 900)
    sandbox = Path(tempfile.mkdtemp(prefix="code-bench-raw-")).resolve()
    if sandbox.is_relative_to(REPO_ROOT.resolve()):
        shutil.rmtree(sandbox, ignore_errors=True)
        raise RuntimeError(
            f"TMPDIR places the raw sandbox inside the repository ({sandbox}); the CLI would read the repo's "
            "CLAUDE.md/AGENTS.md. Set TMPDIR outside the checkout (for example /var/tmp)."
        )
    attachments = sandbox / "attachments"
    output = sandbox / "output"
    output.mkdir(parents=True)
    archive = cb.build_fixture_archive(fixture.id, attachments)
    prompt = cb.render_code_task(fixture, str(attachments), str(output))
    source = os.environ if source_env is None else source_env
    effort = source.get(EFFORT_ENV[cli], "").strip() or DEFAULT_EFFORT
    command = cli_command(cli, model, sandbox, prompt, cli_bin=cli_bin, effort=effort)
    result: dict[str, Any] = {
        "task": task_name,
        "fixture": fixture.id,
        "cli": cli,
        "model": model,
        "effort": effort,
        "input_archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        env = cli_env(cli, sandbox, pass_env=pass_env, source_env=source_env)
        result["transport"] = describe_transport(env)
        started = time.monotonic()
        exit_code, transcript = await asyncio.to_thread(
            _run_cli, command.argv, cwd=sandbox, stdin=command.stdin, timeout=timeout, env=env
        )
        result["duration_seconds"] = round(time.monotonic() - started, 1)
        result["exit_code"] = exit_code
        result["cli_run"] = summarize_transcript(cli, transcript)
        if evidence_dir is not None:
            evidence_dir.mkdir(parents=True, exist_ok=True)
            (evidence_dir / "cli-transcript.log").write_text(transcript)
            (evidence_dir / "prompt.txt").write_text(prompt)
            result["transcript"] = str(evidence_dir / "cli-transcript.log")
        produced = output / cb.RESULT_ARCHIVE
        if not produced.is_file():
            graded = {"passed": False, "reason": f"the CLI did not write {produced}", "steps": []}
        else:
            payload = produced.read_bytes()
            if evidence_dir is not None:
                shutil.copyfile(produced, evidence_dir / cb.RESULT_ARCHIVE)
            graded = await asyncio.to_thread(
                cb.evaluate_archive_bytes,
                fixture,
                payload,
                cb.RESULT_ARCHIVE,
                capture_screenshot=judge and bool(fixture.screenshot),
            )
        result["hidden_tests_passed"] = bool(graded.get("passed"))
        result["steps"] = graded.get("steps", [])
        reasons = [] if graded.get("passed") else [str(graded.get("reason"))]
        if exit_code != 0:
            reasons.insert(0, f"CLI exited {exit_code}: {transcript.strip()[-400:]}")
        evaluator = _screenshot_evaluator(task)
        if evaluator is not None:
            if not judge:
                result["judge"] = "skipped"
                reasons.append("screenshot judge skipped (--no-judge); attempt not comparable")
            elif graded.get("passed"):
                judged = await cb.run_screenshot_judge(evaluator, {"_benchmark": {cb.STATE_KEY: {fixture.id: graded}}})
                result["judge"] = judged
                if float(judged.get("score", 0.0)) < float(evaluator.get("pass_threshold", 1.0)):
                    reasons.append(f"screenshot judge failed: {judged.get('reasoning')}")
        infra = infra_failure(result["cli_run"], exit_code)
        if infra:
            result["infra"] = True
            reasons.insert(0, f"INFRA: {infra}")
        result["passed"] = not reasons
        result["reason"] = "; ".join(reasons)[:1500] or str(graded.get("reason"))
        return result
    finally:
        if keep_sandbox:
            result["sandbox"] = str(sandbox)
        else:
            shutil.rmtree(sandbox, ignore_errors=True)


# ---------------------------------------------------------------------------
# Rose leg: outcomes from run records
# ---------------------------------------------------------------------------


# run_benchmark's own lifecycle reasons that are not a task verdict: the run was
# interrupted, or owned-resource cleanup could not be verified after the stack
# died (live 2026-10-20: the devbox memory watchdog TERMed the local backend).
# Such rows are INFRA; the task is rerun and the row never counts as a failure.
ROSE_INFRA_REASON_PREFIXES = ("Cloud cleanup failed", "Benchmark interrupted")


def rose_row_is_infra(row: dict) -> bool:
    if row.get("passed"):
        return False
    reason = str(row.get("failure_reason") or "")
    return row.get("status") == "CANCELLED" or reason.startswith(ROSE_INFRA_REASON_PREFIXES)


def rose_infra_rows(paths: Iterable[Path], task_names: Iterable[str]) -> list[dict]:
    wanted = list(task_names)
    rows = []
    for path in paths:
        for row in json.loads(Path(path).read_text()).get("tasks") or []:
            if row.get("name") in wanted and rose_row_is_infra(row):
                rows.append(
                    {
                        "task": row.get("name"),
                        "agent_id": row.get("agent_id") or "",
                        "status": row.get("status"),
                        "reason": str(row.get("failure_reason") or "")[:300],
                        "record": str(path),
                    }
                )
    return rows


def rose_outcomes_from_records(
    paths: Iterable[Path], task_names: Iterable[str]
) -> tuple[dict[str, list[bool]], dict[str, list[str]]]:
    """Per-task verdicts in record order. SKIPPED and INFRA rows are not verdicts."""
    wanted = list(task_names)
    outcomes: dict[str, list[bool]] = {}
    agents: dict[str, list[str]] = {}
    for path in paths:
        record = json.loads(Path(path).read_text())
        for row in record.get("tasks") or []:
            name = row.get("name")
            if name not in wanted or row.get("status") == "SKIPPED" or rose_row_is_infra(row):
                continue
            outcomes.setdefault(name, []).append(bool(row.get("passed")))
            agents.setdefault(name, []).append(str(row.get("agent_id") or ""))
    return outcomes, agents


def _extract_results_path(output: str) -> Optional[Path]:
    marker = "Results saved:"
    for line in output.splitlines():
        if marker in line:
            candidate = line.split(marker, 1)[1].strip()
            if candidate:
                return Path(candidate)
    return None


RUNS_DIR = AGENTS_DIR / "benchmarks" / "runs"
_REPORT_RUN_ID = re.compile(r"\[report-card\] run=([0-9a-f-]{36})")


def record_for_output(output: str, runs_dir: Path = RUNS_DIR) -> Optional[Path]:
    """The run record a ``--local`` run wrote.

    ``BenchmarkRun.save`` writes the JSON before its Hub upload, so a run whose
    upload failed (dead local backend) prints no "Results saved:" line but still
    left its record; find it by the report-card run id.
    """
    path = _extract_results_path(output)
    if path is not None and path.is_file():
        return path
    match = _REPORT_RUN_ID.search(output)
    if match:
        found = sorted(runs_dir.glob(f"*_{match.group(1)}_*.json"))
        if found:
            return found[-1]
    return None


def _run_local(task_names: list[str], log_path: Path) -> Optional[Path]:
    with open(log_path, "w") as log:
        proc = subprocess.Popen(
            [str(REPO_ROOT / "scripts" / "run-bench"), "--local", *task_names],
            cwd=REPO_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        assert proc.stdout is not None
        captured = []
        for line in proc.stdout:
            sys.stdout.write(line)
            log.write(line)
            captured.append(line)
        code = proc.wait()
    record = record_for_output("".join(captured))
    if record is None:
        print(f"[code-parity] Rose run (exit {code}) wrote no run record; INFRA for every task; see {log_path}")
    return record


def run_rose_local(
    task_names: list[str],
    k: int,
    log_dir: Path,
    *,
    retry_infra: int = 2,
    runner: Callable[[list[str], Path], Optional[Path]] = _run_local,
) -> list[Path]:
    """K sequential ``scripts/run-bench --local`` runs (one isolated stack at a time).

    Rows without a verdict (INFRA: interrupted runs, unverified cleanup) are
    rerun for just the short tasks, at most ``retry_infra`` extra runs.
    """
    records: list[Path] = []
    for index in range(k):
        print(f"\n[code-parity] Rose leg run {index + 1}/{k}: scripts/run-bench --local {' '.join(task_names)}")
        record = runner(task_names, log_dir / f"rose-local-run-{index + 1}.log")
        if record is not None:
            records.append(record)
    for attempt in range(retry_infra):
        outcomes, _ = rose_outcomes_from_records(records, task_names)
        short = [t for t in task_names if len(outcomes.get(t, [])) < k]
        if not short:
            break
        print(f"\n[code-parity] Rose INFRA retry {attempt + 1}/{retry_infra}: {' '.join(short)}")
        record = runner(short, log_dir / f"rose-local-infra-retry-{attempt + 1}.log")
        if record is not None:
            records.append(record)
    return records


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


def tolerance_tasks(task_count: int) -> float:
    return max(1.0, TOLERANCE_FRACTION * task_count)


def _leg_stats(tasks: list[str], outcomes: dict[str, list[Optional[bool]]], k: int) -> dict[str, Any]:
    """Per-leg statistics. ``None`` is an INFRA attempt: no verdict, and the leg stays incomplete."""

    def first_k(task: str) -> list[Optional[bool]]:
        return list(outcomes.get(task, []))[:k]

    per_run = [sum(1 for t in tasks if len(first_k(t)) > i and first_k(t)[i] is True) for i in range(k)]
    verdicts = {t: [v for v in first_k(t) if v is not None] for t in tasks}
    complete = all(len(verdicts[t]) >= k for t in tasks)
    mean = statistics.fmean(per_run) if per_run else 0.0
    return {
        "per_run_passes": per_run,
        "mean_passes": round(mean, 3),
        "stdev_passes": round(statistics.pstdev(per_run), 3) if per_run else 0.0,
        "pass_rate": round(mean / len(tasks), 3) if tasks else 0.0,
        "spread": (max(per_run) - min(per_run)) if per_run else 0,
        "task_passes": {t: f"{sum(verdicts[t])}/{len(verdicts[t])}" for t in tasks},
        "infra_attempts": sum(1 for t in tasks for v in first_k(t) if v is None),
        "flaky_tasks": [t for t in tasks if 0 < sum(verdicts[t]) < len(verdicts[t])],
        "complete": complete,
    }


def build_report(
    tasks: list[str], rose: dict[str, list[bool]], raw: dict[str, list[bool]], *, k: int
) -> dict[str, Any]:
    tolerance = tolerance_tasks(len(tasks))
    rose_stats = _leg_stats(tasks, rose, k)
    raw_stats = _leg_stats(tasks, raw, k)
    for stats in (rose_stats, raw_stats):
        stats["reproducible"] = stats["complete"] and stats["spread"] <= tolerance
    # No verdict from a missing leg: an empty Rose leg must not read as parity.
    parity_ok = (
        rose_stats["complete"]
        and raw_stats["complete"]
        and rose_stats["mean_passes"] >= raw_stats["mean_passes"] - tolerance
    )
    return {
        "tasks": tasks,
        "k": k,
        "tolerance_tasks": tolerance,
        "rose": rose_stats,
        "raw": raw_stats,
        "parity_ok": parity_ok,
        "c8_ok": parity_ok
        and rose_stats["complete"]
        and raw_stats["complete"]
        and rose_stats["reproducible"]
        and raw_stats["reproducible"],
    }


def render_text(report: dict[str, Any], *, rose_agents: dict[str, list[str]], raw_cli: str) -> str:
    width = max(len(t) for t in report["tasks"]) if report["tasks"] else 10
    lines = [
        f"Code-bench parity (K={report['k']}, tolerance {report['tolerance_tasks']:g} task(s))",
        f"{'task':<{width}}  {'rose':>5}  {raw_cli:>6}",
    ]
    for task in report["tasks"]:
        lines.append(
            f"{task:<{width}}  {report['rose']['task_passes'][task]:>5}  {report['raw']['task_passes'][task]:>6}"
        )
    for leg, label in (("rose", "Rose"), ("raw", f"raw {raw_cli}")):
        stats = report[leg]
        lines.append(
            f"{label}: per-run passes {stats['per_run_passes']} mean {stats['mean_passes']} "
            f"stdev {stats['stdev_passes']} flaky {stats['flaky_tasks'] or 'none'} infra {stats['infra_attempts']} "
            f"complete={stats['complete']} reproducible={stats['reproducible']}"
        )
    lines.append(f"parity_ok={report['parity_ok']} c8_ok={report['c8_ok']}")
    links = report.get("rose_agent_links") or {
        task: [f"{FRONTEND_URL}/?agent-id={a}" for a in ids if a] for task, ids in rose_agents.items()
    }
    for task, urls in links.items():
        for url in urls:
            lines.append(f"Rose {task}: {url}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="scripts/run-bench code-parity", description=__doc__.split("\n\n")[0])
    parser.add_argument("--tasks", help="Comma-separated code-bench task names (default: every code-bench task)")
    parser.add_argument("-k", "--runs", type=int, default=3, help="Runs per leg (default 3)")
    parser.add_argument(
        "--cli", choices=("claude", "codex"), default="claude", help="Raw CLI (match the Rose provider)"
    )
    parser.add_argument("--model", help="Raw-leg model (default: the E2B default for --cli)")
    parser.add_argument("--cli-bin", help="Explicit CLI executable for the raw leg")
    parser.add_argument("--pass-env", action="append", default=[], help="Extra env var to forward to the raw CLI")
    rose = parser.add_mutually_exclusive_group()
    rose.add_argument("--rose-records", nargs="+", type=Path, help="Existing Rose run records (runs/*.json)")
    rose.add_argument("--run-rose", choices=("local",), help="Run the Rose leg now: K sequential --local runs")
    parser.add_argument(
        "--rose-retry-infra",
        type=int,
        default=2,
        help="With --run-rose local: extra --local runs for tasks whose rows were INFRA (default 2)",
    )
    rose.add_argument("--skip-rose", action="store_true", help="Raw leg only")
    parser.add_argument("--raw-results", type=Path, help="Reuse a previous raw-leg results JSON instead of rerunning")
    parser.add_argument("--no-judge", action="store_true", help="Skip the screenshot judge on the raw leg")
    parser.add_argument("--raw-concurrency", type=int, default=1, help="Raw-leg attempts in flight (default 1)")
    parser.add_argument(
        "--rerun-infra",
        action="store_true",
        help="With --raw-results: rerun only INFRA attempts (provider/credential errors); keep every other attempt",
    )
    parser.add_argument(
        "--lease-claude-token",
        action="store_true",
        help="Run the raw Claude leg on a Claude compute token leased through the backend (released afterwards)",
    )
    parser.add_argument(
        "--openrouter-gateway",
        action="store_true",
        help=(
            "Run the raw Claude leg through the funded OpenRouter Anthropic gateway the Rose sandbox uses when no "
            "Claude credential is available (OPENROUTER_API_KEY from back-end/.env or the caller environment)"
        ),
    )
    parser.add_argument(
        "--lease-backend", default=PROD_BACKEND_URL, help=f"Backend for --lease-claude-token ({PROD_BACKEND_URL})"
    )
    parser.add_argument("--lease-user-id", default=BENCH_USER_ID, help="User whose compute tokens are leased")
    parser.add_argument(
        "--publish-evidence",
        action="store_true",
        help="Publish and fresh-browser-verify each Rose agent's durable FE link (scripts/publish_evidence_links.py)",
    )
    parser.add_argument("--out-dir", type=Path, help="Evidence directory (default .context/code-bench-parity/<ts>)")
    args = parser.parse_args(argv)
    if args.runs < 1:
        parser.error("-k must be >= 1")
    if args.raw_concurrency < 1:
        parser.error("--raw-concurrency must be >= 1")
    if args.rerun_infra and not args.raw_results:
        parser.error("--rerun-infra needs --raw-results")
    if args.lease_claude_token and args.openrouter_gateway:
        parser.error("choose one of --lease-claude-token and --openrouter-gateway")
    if args.openrouter_gateway and args.cli != "claude":
        parser.error("--openrouter-gateway applies to --cli claude")
    if args.lease_claude_token and args.cli != "claude":
        parser.error("--lease-claude-token applies to --cli claude; pass CODEX_AUTH_JSON or OPENAI_API_KEY for codex")
    args.source_env = dict(_CALLER_ENV)
    return args


def publish_rose_evidence(records: list[Path], tasks: list[str]) -> dict[str, str]:
    """Durable, fresh-browser-verified FE link per Rose agent (or the publisher's failure)."""
    links: dict[str, str] = {}
    for record in records:
        for row in json.loads(Path(record).read_text()).get("tasks") or []:
            agent_id = str(row.get("agent_id") or "")
            if row.get("name") not in tasks or not agent_id or agent_id in links or rose_row_is_infra(row):
                continue
            proc = subprocess.run(
                [
                    sys.executable,
                    str(REPO_ROOT / "scripts" / "publish_evidence_links.py"),
                    "--run-json",
                    str(record),
                    "--agent-id",
                    agent_id,
                ],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                timeout=600,
                check=False,
            )
            line = next((ln for ln in proc.stdout.splitlines() if ln.startswith("FE link: ")), "")
            if proc.returncode == 0 and line:
                links[agent_id] = line[len("FE link: ") :].split(" ", 1)[0]
            else:
                tail = (proc.stdout + proc.stderr).strip()[-300:]
                links[agent_id] = f"UNVERIFIED (publish_evidence_links exit {proc.returncode}): {tail}"
    return links


def openrouter_gateway_env(source_env: Mapping[str, str]) -> dict[str, str]:
    """The sandbox transport Rose picks without a Claude credential (claudeCodeSandboxAuth.ts).

    ``resolveClaudeCodeSandboxApiKey`` routes Claude Code to OpenRouter's
    Anthropic-compatible base with the funded OPENROUTER_API_KEY; the raw leg can
    use the identical gateway so both legs hit the same served model.
    """
    key = source_env.get("OPENROUTER_API_KEY") or ""
    if not key:
        from dotenv import dotenv_values

        key = str(dotenv_values(REPO_ROOT / "back-end" / ".env").get("OPENROUTER_API_KEY") or "")
    if not key:
        raise RuntimeError("--openrouter-gateway needs OPENROUTER_API_KEY in the environment or back-end/.env")
    env = {k: v for k, v in source_env.items() if k not in CREDENTIAL_ENV["claude"]}
    env.update({"ANTHROPIC_BASE_URL": OPENROUTER_ANTHROPIC_BASE_URL, "ANTHROPIC_API_KEY": key})
    return env


async def lease_claude_token(backend_url: str, user_id: str) -> dict[str, Any]:
    """Lease a Claude compute token through the backend (the same pool the Rose leg uses)."""
    os.environ["BACKEND_API_URL"] = backend_url.rstrip("/")
    from helpers.llm import fetch_compute_token_activity

    lease = await fetch_compute_token_activity(
        user_id, lineage_key=f"code-bench-parity-{os.getpid()}-{int(time.time())}", token_type="claude"
    )
    if not lease or lease.get("type") != "claude" or not lease.get("accessToken"):
        raise RuntimeError(
            f"no Claude compute token leased from {backend_url} for user {user_id}; check BACKEND_API_KEY "
            "in agents/.env and the user's compute tokens, or pass CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY"
        )
    return lease


async def release_lease(lease: Optional[dict]) -> None:
    if lease and lease.get("lineageKey"):
        from helpers.llm import release_compute_token_lineage_activity

        await release_compute_token_lineage_activity(str(lease["lineageKey"]))


def classify_loaded_attempts(raw_attempts: dict[str, list[dict]], cli: str) -> dict[str, list[dict]]:
    """Re-derive INFRA flags for saved attempts from their retained CLI transcripts."""
    for attempts in raw_attempts.values():
        for attempt in attempts:
            if "infra" in attempt:
                continue
            transcript = Path(str(attempt.get("transcript") or ""))
            if transcript.is_file():
                attempt["cli_run"] = summarize_transcript(cli, transcript.read_text())
            reason = infra_failure(attempt.get("cli_run") or {}, int(attempt.get("exit_code") or 0))
            if reason:
                attempt["infra"] = True
                attempt["passed"] = False
                attempt["reason"] = f"INFRA: {reason}; {attempt.get('reason', '')}"[:1500]
    return raw_attempts


def _infra_jobs(raw_attempts: dict[str, list[dict]]) -> list[tuple[int, str]]:
    return [
        (int(a.get("run") or index + 1) - 1, task)
        for task, attempts in raw_attempts.items()
        for index, a in enumerate(attempts)
        if a.get("infra")
    ]


def merge_reruns(raw_attempts: dict[str, list[dict]], reruns: dict[str, list[dict]]) -> dict[str, list[dict]]:
    """Replace infra attempts by their reruns; the superseded attempts stay attached."""
    merged = {task: [dict(a) for a in attempts] for task, attempts in raw_attempts.items()}
    for task, attempts in reruns.items():
        for rerun in attempts:
            slot = next(i for i, a in enumerate(merged[task]) if int(a.get("run") or i + 1) == rerun["run"])
            previous = merged[task][slot]
            rerun["superseded_infra_attempts"] = [
                *previous.get("superseded_infra_attempts", []),
                {k: v for k, v in previous.items() if k != "superseded_infra_attempts"},
            ]
            merged[task][slot] = rerun
    return merged


def attempt_outcome(attempt: dict) -> Optional[bool]:
    """True/False capability verdict; None for an infra attempt (not a verdict)."""
    return None if attempt.get("infra") else bool(attempt.get("passed"))


async def _raw_leg(
    args: argparse.Namespace,
    tasks: list[str],
    out_dir: Path,
    jobs: Optional[list[tuple[int, str]]] = None,
) -> dict[str, list[dict]]:
    model = args.model or default_model(args.cli)
    gate = asyncio.Semaphore(args.raw_concurrency)

    async def one(run: int, task: str) -> dict:
        async with gate:
            print(f"[code-parity] raw {args.cli} ({model}) run {run + 1}/{args.runs}: {task}", flush=True)
            attempt = await run_raw_attempt(
                task,
                cli=args.cli,
                model=model,
                judge=not args.no_judge,
                cli_bin=args.cli_bin,
                pass_env=args.pass_env,
                source_env=args.source_env,
                evidence_dir=out_dir / "raw" / task / f"run-{run + 1}",
            )
            verdict = "INFRA" if attempt.get("infra") else "PASS" if attempt["passed"] else "FAIL"
            print(f"    <- {task} run {run + 1}: {verdict} {attempt.get('reason', '')[:300]}", flush=True)
            attempt["run"] = run + 1
            return attempt

    # Each attempt has its own sandbox and CLI config, so runs are independent;
    # results keep run order regardless of completion order.
    planned = jobs if jobs is not None else [(run, task) for run in range(args.runs) for task in tasks]
    results = await asyncio.gather(*(one(run, task) for run, task in planned))
    attempts: dict[str, list[dict]] = {}
    for attempt in sorted(results, key=lambda a: a["run"]):
        attempts.setdefault(attempt["task"], []).append(attempt)
    return attempts


def _cli_version(cli: str, cli_bin: Optional[str]) -> str:
    try:
        out = subprocess.run([cli_bin or cli, "--version"], capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"unavailable: {exc}"
    return (out.stdout or out.stderr).strip()[:200]


def main(argv: Optional[list[str]] = None) -> int:
    args = _parse_args(argv)
    known = code_bench_task_names()
    tasks = [t.strip() for t in args.tasks.split(",")] if args.tasks else known
    unknown = [t for t in tasks if t not in known]
    if unknown:
        print(f"Unknown code-bench task(s): {unknown}. Known: {known}", file=sys.stderr)
        return 2
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = (args.out_dir or DEFAULT_OUT_ROOT / stamp).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    rose_records: list[Path] = []
    if args.rose_records:
        rose_records = list(args.rose_records)
    elif args.run_rose == "local":
        rose_records = run_rose_local(tasks, args.runs, out_dir, retry_infra=args.rose_retry_infra)
    rose_outcomes, rose_agents = rose_outcomes_from_records(rose_records, tasks)
    verified_links = publish_rose_evidence(rose_records, tasks) if args.publish_evidence else {}

    raw_attempts = None
    if args.raw_results:
        raw_attempts = classify_loaded_attempts(json.loads(args.raw_results.read_text())["raw_attempts"], args.cli)
    jobs = None
    if args.rerun_infra:
        jobs = [(run, task) for run, task in _infra_jobs(raw_attempts or {}) if task in tasks]
        print(f"[code-parity] rerunning {len(jobs)} infra attempt(s): {jobs}", flush=True)
    if raw_attempts is None or jobs:
        lease = None
        try:
            if args.openrouter_gateway:
                args.source_env = openrouter_gateway_env(args.source_env)
                print(f"[code-parity] raw leg routes Claude Code through {OPENROUTER_ANTHROPIC_BASE_URL}")
            if args.lease_claude_token:
                lease = asyncio.run(lease_claude_token(args.lease_backend, args.lease_user_id))
                args.source_env = {k: v for k, v in args.source_env.items() if k not in CREDENTIAL_ENV["claude"]}
                args.source_env["CLAUDE_CODE_OAUTH_TOKEN"] = lease["accessToken"]
                print(f"[code-parity] raw leg uses a leased Claude compute token (source={lease.get('source')})")
            fresh = asyncio.run(_raw_leg(args, tasks, out_dir, jobs))
        finally:
            if lease:
                asyncio.run(release_lease(lease))
        raw_attempts = merge_reruns(raw_attempts, fresh) if jobs else fresh
    raw_outcomes = {task: [attempt_outcome(a) for a in attempts] for task, attempts in raw_attempts.items()}

    report = build_report(tasks, rose_outcomes, raw_outcomes, k=args.runs)
    report.update(
        {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "raw_cli": args.cli,
            "raw_model": args.model or default_model(args.cli),
            "raw_transport": (
                "openrouter-gateway"
                if args.openrouter_gateway
                else "leased-compute-token"
                if args.lease_claude_token
                else "caller-env-or-cli-login"
            ),
            "raw_cli_version": _cli_version(args.cli, args.cli_bin),
            "raw_cli_path": shutil.which(args.cli_bin or args.cli),
            "rose_records": [str(p) for p in rose_records],
            "rose_agent_links": {
                t: [verified_links.get(a) or f"{FRONTEND_URL}/?agent-id={a}" for a in ids if a]
                for t, ids in rose_agents.items()
            },
            "rose_links_verified": bool(verified_links),
            "rose_skipped": bool(args.skip_rose or not rose_records),
            "rose_infra_rows": rose_infra_rows(rose_records, tasks),
            "raw_cost_usd": round(
                sum(
                    float((a.get("cli_run") or {}).get("cost_usd") or 0) for runs in raw_attempts.values() for a in runs
                ),
                4,
            ),
            "raw_host_extensions": any(
                (a.get("cli_run") or {}).get("host_extensions") for runs in raw_attempts.values() for a in runs
            ),
            "raw_attempts": raw_attempts,
        }
    )
    (out_dir / "parity.json").write_text(json.dumps(report, indent=2))
    text = render_text(report, rose_agents=rose_agents, raw_cli=args.cli)
    text += f"\nraw {args.cli} {report['raw_cli_version']} cost ${report['raw_cost_usd']:.2f}"
    if report["raw_host_extensions"]:
        text += (
            "\nnote: the raw CLI loaded host hooks/plugins/MCP servers (managed settings); "
            "see raw_attempts[].cli_run in parity.json"
        )
    if report["rose_infra_rows"]:
        text += f"\nRose INFRA rows excluded (rerun; not verdicts): {len(report['rose_infra_rows'])}"
    if report["rose_skipped"]:
        text += "\nnote: Rose leg not run; parity_ok needs --run-rose local or --rose-records"
    (out_dir / "parity.txt").write_text(text + "\n")
    print("\n" + text)
    print(f"\nParity evidence: {out_dir}")
    if report["rose_skipped"]:
        return 0
    return 0 if report["c8_ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
