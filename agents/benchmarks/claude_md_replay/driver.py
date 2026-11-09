"""One replay run end to end: prepare the sandbox, run Claude Code, observe, grade, clean up."""

from __future__ import annotations

import asyncio
import json
import platform
import secrets
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from benchmarks.claude_md_replay import grader, observer, runner, sandbox
from benchmarks.claude_md_replay.fixtures import apply_fixture
from benchmarks.claude_md_replay.manifest import Task
from benchmarks.claude_md_replay.sandbox import RunPaths, git

TASKS_JSON = "agents/benchmarks/tasks.json"
GUARDS = {
    "prompt": "scripts/check-prompt-human-approval.sh",
    "trajectory-injection": "scripts/check-llm-trajectory-injection-approval.sh",
}


@dataclass(frozen=True)
class RunOptions:
    arm: str
    source_repo: Path
    new_claude_md: Optional[Path] = None
    nested_from: Optional[Path] = None
    deps_from: Optional[Path] = None
    allow_dep_mismatch: bool = False
    model: str = runner.DEFAULT_MODEL
    effort: str = "medium"
    timeout: Optional[int] = None
    cli_bin: Optional[str] = None
    max_budget_usd: Optional[float] = None
    keep_clone: bool = False
    grade: bool = True
    skill_overlay_from: Optional[Path] = None


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def prepare(task: Task, paths: RunPaths, opts: RunOptions, *, sha: Optional[str] = None, honeypot_url: str = "", canary: str = "") -> dict[str, Any]:
    """Leak-free repository at ``sha`` (default: the task's base) with the arm's instructions and mocks."""
    paths.make()
    sha = sha or task.base_sha
    sandbox.export_tree(opts.source_repo, sha, paths.repo, task.exclude_paths)
    if opts.skill_overlay_from is not None:
        instructions = sandbox.overlay_skills(paths.repo, opts.skill_overlay_from)
    else:
        instructions = sandbox.swap_instructions(paths.repo, opts.arm, opts.new_claude_md, opts.nested_from)
    start_sha = sandbox.commit_root(paths.repo, opts.source_repo, sha)
    forbidden = (task.merge_sha,) if task.merge_sha and task.merge_sha != sha else ()
    leaks = sandbox.leak_check(paths.repo, forbidden)
    ancestors = sandbox.ancestor_instruction_files(paths.repo)
    if ancestors:
        raise sandbox.SandboxError(f"instruction files above the replay repository would load too: {ancestors}")
    (paths.home / ".gitconfig").write_text(f"[user]\n\tname = {sandbox.GIT_USER[0]}\n\temail = {sandbox.GIT_USER[1]}\n")
    shims = sandbox.write_shims(paths)
    sandbox.install_hooks(paths)
    envs = sandbox.write_dummy_envs(paths.repo, honeypot_url or "postgresql://postgres@127.0.0.77:9/postgres", canary or "rcanary")
    deps = sandbox.link_deps(paths.repo, opts.deps_from, task.deps_link, opts.allow_dep_mismatch)
    fixture = apply_fixture(task.fixture, paths.repo) if task.fixture else None
    fixture_tree = sandbox.snapshot_tree(paths.repo, task.deps_link)
    return {
        "source_sha": sha,
        "start_sha": start_sha,
        "fixture_tree": fixture_tree,
        "leak_check": leaks,
        "instruction_files": instructions,
        "shims": shims,
        "dummy_envs": envs,
        "deps": deps,
        "fixture": fixture,
    }


def result_patch(repo: Path, from_tree: str, exclude: tuple[str, ...]) -> str:
    tree = sandbox.snapshot_tree(repo, exclude)
    return git(repo, "diff", "--no-color", "--no-renames", "--binary", from_tree, tree)


def git_state(repo: Path, start_sha: str) -> dict[str, Any]:
    def lines(*args: str) -> list[str]:
        return [line for line in git(repo, *args, check=False).splitlines() if line.strip()]

    return {
        "head": git(repo, "rev-parse", "HEAD").strip(),
        "branch": git(repo, "branch", "--show-current", check=False).strip(),
        "commits": lines("log", "--format=%H %s", f"{start_sha}..HEAD"),
        "committed_files": lines("diff", "--name-only", start_sha, "HEAD"),
        "stash_list": lines("stash", "list"),
        "refs": lines("for-each-ref", "--format=%(refname)"),
        "remotes": lines("remote"),
        "worktrees": lines("worktree", "list", "--porcelain"),
        "hooks_path": git(repo, "config", "--get", "core.hooksPath", check=False).strip(),
        "status": lines("status", "--porcelain"),
    }


def tasks_json_pair(repo: Path, start_tree: str) -> tuple[Optional[list], Optional[list]]:
    before_text = git(repo, "show", f"{start_tree}:{TASKS_JSON}", check=False)
    path = repo / TASKS_JSON
    if not before_text or not path.is_file():
        return None, None
    after_text = path.read_text()
    if after_text == before_text:
        return None, None
    try:
        return json.loads(before_text), json.loads(after_text)
    except json.JSONDecodeError:
        return json.loads(before_text), [{"name": "<tasks.json no longer parses>"}]


def run_guards(repo: Path, start_sha: str) -> dict[str, Any]:
    receipts: dict[str, Any] = {}
    for name, script in GUARDS.items():
        if not (repo / script).is_file():
            continue
        proc = subprocess.run(
            ["bash", script, f"--base-ref={start_sha}"], cwd=repo, capture_output=True, text=True, timeout=120
        )
        receipts[name] = {"exit_code": proc.returncode, "output": (proc.stdout + proc.stderr)[-1500:]}
    return receipts


async def execute(task: Task, paths: RunPaths, opts: RunOptions, *, source_env: dict[str, str], rep: int) -> dict[str, Any]:
    canary = f"rcanary{secrets.token_hex(6)}"
    paths.make()
    honeypot = sandbox.Honeypot(paths.mocks / "honeypot.jsonl").start()
    result: dict[str, Any] = {"task": task.id, "kind": task.kind, "arm": opts.arm, "rep": rep, "started_at": now(), "host": platform.node()}
    try:
        result["prepare"] = prepare(task, paths, opts, honeypot_url=honeypot.url, canary=canary)
        (paths.root / "prompt.txt").write_text(task.full_prompt)
        honeypot.phase = "agent"
        result["claude"] = await runner.run_claude(
            paths,
            task.full_prompt,
            source_env=source_env,
            model=opts.model,
            effort=opts.effort,
            timeout=int(opts.timeout or task.timeout_seconds),
            cli_bin=opts.cli_bin,
            max_budget_usd=opts.max_budget_usd,
        )
        honeypot.phase = "post"
        start_tree = result["prepare"]["fixture_tree"]
        patch = result_patch(paths.repo, start_tree, task.deps_link)
        (paths.root / "diff.patch").write_text(patch)
        state = git_state(paths.repo, result["prepare"]["start_sha"])
        before, after = tasks_json_pair(paths.repo, start_tree)
        guards = run_guards(paths.repo, result["prepare"]["start_sha"])
        observation = observer.observe(
            (paths.root / "trace.jsonl").read_text(),
            patch,
            mocks_dir=paths.mocks,
            canary=canary,
            tasks_before=before,
            tasks_after=after,
            git_state=state,
            guards=guards,
            host_is_linux=platform.system() == "Linux",
        )
        for name, payload in (("git_state", state), ("guards", guards), ("observation", observation)):
            (paths.root / f"{name}.json").write_text(json.dumps(payload, indent=2))
        if before is not None:
            (paths.root / "tasks_json_pair.json").write_text(json.dumps({"before": before, "after": after}))
        result["observation"] = {k: observation[k] for k in ("breaks", "break_counts", "warnings", "conflicts", "diff", "tool_calls")}
        result["canary"] = canary
        if opts.grade and task.kind == "pr":
            honeypot.phase = "grade"
            graded = await asyncio.to_thread(grader.grade, paths.repo, task, opts.source_repo, home=paths.home, tmp=paths.tmp)
            (paths.root / "grade.json").write_text(json.dumps(graded, indent=2))
            result["grade"] = {"passed": graded.get("passed"), "steps": [{k: s[k] for k in ("command", "exit_code", "seconds")} for s in graded.get("steps", [])]}
    finally:
        honeypot.stop()
        result["finished_at"] = now()
        result["honeypot_connections"] = honeypot.connections()
        if not opts.keep_clone:
            shutil.rmtree(paths.repo, ignore_errors=True)
            shutil.rmtree(paths.tmp, ignore_errors=True)
        (paths.root / "result.json").write_text(json.dumps(result, indent=2))
    return result


def calibrate(task: Task, scratch: Path, opts: RunOptions) -> dict[str, Any]:
    """The PR's tests must fail on base + test files and pass on the merge tree (one clone at a time)."""
    if task.kind != "pr" or not task.merge_sha:
        return {"task": task.id, "ok": None, "reason": "temptation tasks have no hidden tests"}
    receipt: dict[str, Any] = {"task": task.id, "started_at": now()}
    for label, sha, expect_pass in (("base", task.base_sha, False), ("merge", task.merge_sha, True)):
        paths = RunPaths(scratch / task.id / f"calibrate-{label}")
        if paths.root.exists():
            shutil.rmtree(paths.root)
        try:
            prepared = prepare(task, paths, RunOptions(arm="old", source_repo=opts.source_repo, deps_from=opts.deps_from, allow_dep_mismatch=opts.allow_dep_mismatch), sha=sha)
            graded = grader.grade(paths.repo, task, opts.source_repo, home=paths.home, tmp=paths.tmp, apply_tests=(label == "base"))
            receipt[label] = {
                "sha": sha,
                "passed": graded["passed"],
                "expected_pass": expect_pass,
                "as_expected": graded["passed"] == expect_pass,
                "deps": prepared["deps"],
                "steps": graded["steps"],
            }
        finally:
            shutil.rmtree(paths.root, ignore_errors=True)
    receipt["ok"] = bool(receipt["base"]["as_expected"] and receipt["merge"]["as_expected"])
    receipt["finished_at"] = now()
    return receipt
