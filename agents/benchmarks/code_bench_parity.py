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
from typing import Any, Iterable, Optional

from benchmarks import code_bench as cb

AGENTS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENTS_DIR.parent
TASKS_JSON = Path(__file__).resolve().parent / "tasks.json"
DEFAULT_OUT_ROOT = REPO_ROOT / ".context" / "code-bench-parity"
FRONTEND_URL = "https://roselabs.ai"

# Mirror back-end/src/providers/e2b.ts (CLAUDE_CODE_MODEL / CODEX_CODE_MODEL defaults)
# and e2b-templates/*/ws-server.mjs so both legs run the same model and flags.
DEFAULT_MODELS = {"claude": "claude-sonnet-5", "codex": "gpt-5.6-terra"}
MODEL_ENV = {"claude": "CLAUDE_CODE_MODEL", "codex": "CODEX_CODE_MODEL"}
CLAUDE_ALLOWED_TOOLS = "Bash,Read,Write,Edit,MultiEdit,Glob,Grep,LS,TodoWrite"
CREDENTIAL_ENV = {
    "claude": ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"),
    "codex": ("OPENAI_API_KEY",),
}
_BASE_ENV = ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR")
TOLERANCE_FRACTION = 0.05


@dataclass(frozen=True)
class CliCommand:
    argv: list[str]
    stdin: Optional[str]


def cli_command(cli: str, model: str, workdir: Path, prompt: str, *, cli_bin: Optional[str] = None) -> CliCommand:
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
            "-m",
            model,
            prompt,
        ]
        return CliCommand(argv=argv, stdin=None)
    raise ValueError(f"unsupported cli {cli!r}; expected claude or codex")


def default_model(cli: str) -> str:
    return os.environ.get(MODEL_ENV[cli], "").strip() or DEFAULT_MODELS[cli]


def cli_env(cli: str, sandbox: Path, *, pass_env: Iterable[str] = ()) -> dict[str, str]:
    """Allowlisted environment with a fresh CLI config dir inside the sandbox."""
    env = {name: os.environ[name] for name in (*_BASE_ENV, *CREDENTIAL_ENV[cli], *pass_env) if name in os.environ}
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
        auth_json = os.environ.get("CODEX_AUTH_JSON")
        if auth_json:
            json.loads(auth_json)
            auth_path = codex_home / "auth.json"
            auth_path.write_text(auth_json)
            auth_path.chmod(0o600)
    return env


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
    command = cli_command(cli, model, sandbox, prompt, cli_bin=cli_bin)
    result: dict[str, Any] = {
        "task": task_name,
        "fixture": fixture.id,
        "cli": cli,
        "model": model,
        "input_archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        env = cli_env(cli, sandbox, pass_env=pass_env)
        started = time.monotonic()
        exit_code, transcript = await asyncio.to_thread(
            _run_cli, command.argv, cwd=sandbox, stdin=command.stdin, timeout=timeout, env=env
        )
        result["duration_seconds"] = round(time.monotonic() - started, 1)
        result["exit_code"] = exit_code
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


def rose_outcomes_from_records(
    paths: Iterable[Path], task_names: Iterable[str]
) -> tuple[dict[str, list[bool]], dict[str, list[str]]]:
    """Per-task outcomes in record order. SKIPPED rows are not attempts."""
    wanted = list(task_names)
    outcomes: dict[str, list[bool]] = {}
    agents: dict[str, list[str]] = {}
    for path in paths:
        record = json.loads(Path(path).read_text())
        for row in record.get("tasks") or []:
            name = row.get("name")
            if name not in wanted or row.get("status") == "SKIPPED":
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


def run_rose_local(task_names: list[str], k: int, log_dir: Path) -> list[Path]:
    """K sequential ``scripts/run-bench --local`` runs (one isolated stack at a time)."""
    records: list[Path] = []
    for index in range(k):
        log_path = log_dir / f"rose-local-run-{index + 1}.log"
        print(f"\n[code-parity] Rose leg run {index + 1}/{k}: scripts/run-bench --local {' '.join(task_names)}")
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
        path = _extract_results_path("".join(captured))
        if path is None or not path.is_file():
            raise RuntimeError(f"Rose leg run {index + 1} (exit {code}) wrote no run record; see {log_path}")
        records.append(path)
    return records


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


def tolerance_tasks(task_count: int) -> float:
    return max(1.0, TOLERANCE_FRACTION * task_count)


def _leg_stats(tasks: list[str], outcomes: dict[str, list[bool]], k: int) -> dict[str, Any]:
    per_run = [sum(1 for t in tasks if len(outcomes.get(t, [])) > i and outcomes[t][i]) for i in range(k)]
    complete = all(len(outcomes.get(t, [])) >= k for t in tasks)
    mean = statistics.fmean(per_run) if per_run else 0.0
    return {
        "per_run_passes": per_run,
        "mean_passes": round(mean, 3),
        "stdev_passes": round(statistics.pstdev(per_run), 3) if per_run else 0.0,
        "pass_rate": round(mean / len(tasks), 3) if tasks else 0.0,
        "spread": (max(per_run) - min(per_run)) if per_run else 0,
        "task_passes": {t: f"{sum(outcomes.get(t, [])[:k])}/{min(len(outcomes.get(t, [])), k)}" for t in tasks},
        "flaky_tasks": [t for t in tasks if 0 < sum(outcomes.get(t, [])[:k]) < len(outcomes.get(t, [])[:k])],
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
    parity_ok = rose_stats["mean_passes"] >= raw_stats["mean_passes"] - tolerance
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
            f"stdev {stats['stdev_passes']} flaky {stats['flaky_tasks'] or 'none'} "
            f"complete={stats['complete']} reproducible={stats['reproducible']}"
        )
    lines.append(f"parity_ok={report['parity_ok']} c8_ok={report['c8_ok']}")
    for task, ids in rose_agents.items():
        for agent_id in ids:
            if agent_id:
                lines.append(f"Rose {task}: {FRONTEND_URL}/?agent-id={agent_id}")
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
    rose.add_argument("--skip-rose", action="store_true", help="Raw leg only")
    parser.add_argument("--raw-results", type=Path, help="Reuse a previous raw-leg results JSON instead of rerunning")
    parser.add_argument("--no-judge", action="store_true", help="Skip the screenshot judge on the raw leg")
    parser.add_argument("--out-dir", type=Path, help="Evidence directory (default .context/code-bench-parity/<ts>)")
    args = parser.parse_args(argv)
    if args.runs < 1:
        parser.error("-k must be >= 1")
    return args


async def _raw_leg(args: argparse.Namespace, tasks: list[str], out_dir: Path) -> dict[str, list[dict]]:
    model = args.model or default_model(args.cli)
    attempts: dict[str, list[dict]] = {}
    for run in range(args.runs):
        for task in tasks:
            print(f"[code-parity] raw {args.cli} ({model}) run {run + 1}/{args.runs}: {task}", flush=True)
            attempt = await run_raw_attempt(
                task,
                cli=args.cli,
                model=model,
                judge=not args.no_judge,
                cli_bin=args.cli_bin,
                pass_env=args.pass_env,
                evidence_dir=out_dir / "raw" / task / f"run-{run + 1}",
            )
            print(f"    -> {'PASS' if attempt['passed'] else 'FAIL'} {attempt.get('reason', '')[:300]}", flush=True)
            attempts.setdefault(task, []).append(attempt)
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
    out_dir = args.out_dir or DEFAULT_OUT_ROOT / stamp
    out_dir.mkdir(parents=True, exist_ok=True)

    rose_records: list[Path] = []
    if args.rose_records:
        rose_records = list(args.rose_records)
    elif args.run_rose == "local":
        rose_records = run_rose_local(tasks, args.runs, out_dir)
    rose_outcomes, rose_agents = rose_outcomes_from_records(rose_records, tasks)

    if args.raw_results:
        raw_attempts = json.loads(args.raw_results.read_text())["raw_attempts"]
    else:
        raw_attempts = asyncio.run(_raw_leg(args, tasks, out_dir))
    raw_outcomes = {task: [bool(a["passed"]) for a in attempts] for task, attempts in raw_attempts.items()}

    report = build_report(tasks, rose_outcomes, raw_outcomes, k=args.runs)
    report.update(
        {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "raw_cli": args.cli,
            "raw_model": args.model or default_model(args.cli),
            "raw_cli_version": _cli_version(args.cli, args.cli_bin),
            "raw_cli_path": shutil.which(args.cli_bin or args.cli),
            "rose_records": [str(p) for p in rose_records],
            "rose_agent_links": {
                t: [f"{FRONTEND_URL}/?agent-id={a}" for a in ids if a] for t, ids in rose_agents.items()
            },
            "rose_skipped": bool(args.skip_rose or not rose_records),
            "raw_attempts": raw_attempts,
        }
    )
    (out_dir / "parity.json").write_text(json.dumps(report, indent=2))
    text = render_text(report, rose_agents=rose_agents, raw_cli=args.cli)
    (out_dir / "parity.txt").write_text(text + "\n")
    print("\n" + text)
    print(f"\nParity evidence: {out_dir}")
    if report["rose_skipped"]:
        return 0
    return 0 if report["c8_ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
