"""CLI: ``python -m benchmarks.claude_md_replay <command>`` (run from ``agents/``)."""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
from pathlib import Path
from typing import Optional

from benchmarks.claude_md_replay import driver, observer, report, runner
from benchmarks.claude_md_replay.manifest import PILOT_MANIFEST, ManifestError, load_manifest
from benchmarks.claude_md_replay.sandbox import ARMS, RunPaths, SandboxError

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUT = Path("/var/tmp/claude-md-replay/runs")


def _parse(argv: Optional[list[str]]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python -m benchmarks.claude_md_replay", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    def manifest_args(p: argparse.ArgumentParser) -> None:
        p.add_argument("--manifest", type=Path, default=PILOT_MANIFEST)
        p.add_argument("--task", action="append", default=[], help="Task id (repeatable; default: every task)")
        p.add_argument("--source-repo", type=Path, help="Checkout holding the base/merge commits (default: manifest source_repo or this repo)")
        p.add_argument("--deps-from", type=Path, help="Installed checkout whose node_modules/venv are linked when lockfiles match")
        p.add_argument("--allow-dep-mismatch", action="store_true")

    validate = sub.add_parser("validate", help="Load and print the manifest")
    validate.add_argument("--manifest", type=Path, default=PILOT_MANIFEST)

    run = sub.add_parser("run", help="Replay tasks under one arm")
    manifest_args(run)
    run.add_argument("--arm", choices=ARMS, required=True)
    run.add_argument("--out", type=Path, default=DEFAULT_OUT)
    run.add_argument("--reps", type=int, help="Repetitions per task (default: the task's reps)")
    run.add_argument("--rep-offset", type=int, default=0, help="First repetition number (to add reps later)")
    run.add_argument("--new-claude-md", type=Path, help="Rewritten root CLAUDE.md for --arm new")
    run.add_argument("--nested-from", type=Path, help="Tree whose front-end/back-end/agents CLAUDE.md files join --arm new")
    run.add_argument("--credential", choices=runner.CREDENTIAL_MODES, default="lease")
    run.add_argument("--env-file", type=Path, help="agents/.env holding BACKEND_API_KEY for --credential lease")
    run.add_argument("--lease-backend", default=runner.parity.PROD_BACKEND_URL)
    run.add_argument("--lease-user-id", default=runner.parity.BENCH_USER_ID)
    run.add_argument("--model", default=runner.DEFAULT_MODEL)
    run.add_argument("--effort", default="medium")
    run.add_argument("--timeout", type=int, help="Seconds per Claude Code run (default: the task's)")
    run.add_argument("--max-budget-usd", type=float, help="Claude Code --max-budget-usd per run")
    run.add_argument("--cli-bin", help="Claude Code executable (default: claude on PATH)")
    run.add_argument("--keep-clone", action="store_true", help="Keep the replay repository after grading")
    run.add_argument("--no-grade", action="store_true")
    run.add_argument("--force", action="store_true", help="Replace an existing run directory")

    calibrate = sub.add_parser("calibrate", help="PR tests fail at base and pass at merge")
    manifest_args(calibrate)
    calibrate.add_argument("--out", type=Path, default=DEFAULT_OUT.parent / "calibration")

    observe = sub.add_parser("observe", help="Re-run the observer on a finished run directory")
    observe.add_argument("run_dir", type=Path)

    rep = sub.add_parser("report", help="Compare arms over result.json files")
    rep.add_argument("roots", type=Path, nargs="+")
    rep.add_argument("--json", type=Path, help="Write the JSON report here")
    return parser.parse_args(argv)


def _source_repo(args: argparse.Namespace, manifest_source: Optional[str]) -> Path:
    return (args.source_repo or (Path(manifest_source) if manifest_source else REPO_ROOT)).resolve()


def _run(args: argparse.Namespace) -> int:
    manifest = load_manifest(args.manifest)
    tasks = [manifest.task(t) for t in args.task] if args.task else list(manifest.tasks)
    opts = driver.RunOptions(
        arm=args.arm,
        source_repo=_source_repo(args, manifest.source_repo),
        new_claude_md=args.new_claude_md.resolve() if args.new_claude_md else None,
        nested_from=args.nested_from.resolve() if args.nested_from else None,
        deps_from=args.deps_from.resolve() if args.deps_from else None,
        allow_dep_mismatch=args.allow_dep_mismatch,
        model=args.model,
        effort=args.effort,
        timeout=args.timeout,
        cli_bin=args.cli_bin,
        max_budget_usd=args.max_budget_usd,
        keep_clone=args.keep_clone,
        grade=not args.no_grade,
    )
    if opts.arm == "new" and opts.new_claude_md is None:
        print("--arm new needs --new-claude-md", file=sys.stderr)
        return 2
    out = args.out.resolve()
    if out.is_relative_to(REPO_ROOT) or out.is_relative_to(opts.source_repo):
        print(f"--out {out} is inside a checkout; Claude Code would load its CLAUDE.md. Use /var/tmp/...", file=sys.stderr)
        return 2

    async def all_runs() -> list[dict]:
        rows = []
        async with runner.credentials(args.credential, env_file=args.env_file, lease_backend=args.lease_backend, lease_user_id=args.lease_user_id) as source_env:
            for task in tasks:
                for rep in range(args.rep_offset, args.rep_offset + (args.reps or task.reps)):
                    paths = RunPaths(out / task.id / opts.arm / f"rep{rep}")
                    if paths.root.exists():
                        if not args.force:
                            raise SandboxError(f"{paths.root} exists; pass --force or --rep-offset")
                        shutil.rmtree(paths.root)
                    print(f"[claude-md-replay] {task.id} arm={opts.arm} rep={rep} -> {paths.root}", flush=True)
                    row = await driver.execute(task, paths, opts, source_env=source_env, rep=rep)
                    summary = (row.get("claude") or {}).get("summary") or {}
                    print(
                        f"[claude-md-replay] done {task.id} arm={opts.arm} rep={rep}: exit={row.get('claude', {}).get('exit_code')} "
                        f"cost=${summary.get('cost_usd')} breaks={row.get('observation', {}).get('breaks')} "
                        f"tests={row.get('grade', {}).get('passed')}",
                        flush=True,
                    )
                    rows.append(row)
        return rows

    asyncio.run(all_runs())
    print(report.render(report.compare(report.load_results([out]))))
    return 0


def _calibrate(args: argparse.Namespace) -> int:
    manifest = load_manifest(args.manifest)
    tasks = [manifest.task(t) for t in args.task] if args.task else [t for t in manifest.tasks if t.kind == "pr"]
    opts = driver.RunOptions(arm="old", source_repo=_source_repo(args, manifest.source_repo), deps_from=args.deps_from, allow_dep_mismatch=args.allow_dep_mismatch)
    args.out.mkdir(parents=True, exist_ok=True)
    ok = True
    for task in tasks:
        receipt = driver.calibrate(task, args.out, opts)
        (args.out / f"{task.id}.json").write_text(json.dumps(receipt, indent=2))
        ok = ok and receipt.get("ok") is not False
        print(f"[calibrate] {task.id}: ok={receipt.get('ok')} base_passed={receipt.get('base', {}).get('passed')} merge_passed={receipt.get('merge', {}).get('passed')}")
    return 0 if ok else 1


def _observe(args: argparse.Namespace) -> int:
    root = args.run_dir
    result = json.loads((root / "result.json").read_text())
    pair = json.loads((root / "tasks_json_pair.json").read_text()) if (root / "tasks_json_pair.json").is_file() else {}

    def read(name: str) -> Optional[dict]:
        return json.loads((root / name).read_text()) if (root / name).is_file() else None

    observation = observer.observe(
        (root / "trace.jsonl").read_text(),
        (root / "diff.patch").read_text(),
        mocks_dir=root / "mocks",
        canary=result.get("canary", ""),
        tasks_before=pair.get("before"),
        tasks_after=pair.get("after"),
        git_state=read("git_state.json"),
        guards=read("guards.json"),
    )
    (root / "observation.json").write_text(json.dumps(observation, indent=2))
    result["observation"] = {k: observation[k] for k in ("breaks", "break_counts", "warnings", "conflicts", "diff", "tool_calls")}
    (root / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps({k: observation[k] for k in ("breaks", "break_counts", "warnings", "conflicts", "diff")}, indent=2))
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    args = _parse(argv)
    try:
        if args.command == "validate":
            manifest = load_manifest(args.manifest)
            for task in manifest.tasks:
                print(f"{task.id:<24} {task.kind:<10} base={task.base_sha[:10]} reps={task.reps} tests={len(task.test_commands)}")
            return 0
        if args.command == "run":
            return _run(args)
        if args.command == "calibrate":
            return _calibrate(args)
        if args.command == "observe":
            return _observe(args)
        rendered = report.compare(report.load_results(args.roots))
        if args.json:
            args.json.write_text(json.dumps(rendered, indent=2))
        print(report.render(rendered))
        return 0
    except (ManifestError, SandboxError) as exc:
        print(f"claude-md-replay: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
