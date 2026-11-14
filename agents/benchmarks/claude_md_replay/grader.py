"""Hidden-test grading: apply only the PR's own test files to a result and run its test commands.

Pattern from code_bench.evaluate_repo: minimal environment (no inherited secrets), a timeout per
command, its own process group killed on timeout. Calibration proves the tests discriminate: they
must fail on the base tree and pass on the merge tree, or the task is dropped from the pilot.
"""

from __future__ import annotations

import contextlib
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any, Mapping, Optional

from benchmarks.claude_md_replay.manifest import Task
from benchmarks.claude_md_replay.sandbox import playwright_browsers

PASS_THROUGH_ENV = ("PATH", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME", "SHELL", "ROSE_USE_SYSTEM_PG")
OUTPUT_TAIL = 4000


def apply_test_files(repo: Path, source_repo: Path, merge_sha: str, files: tuple[str, ...]) -> list[dict[str, Any]]:
    receipts = []
    for rel in files:
        target = repo / rel
        proc = subprocess.run(["git", "-C", str(source_repo), "show", f"{merge_sha}:{rel}"], capture_output=True)
        if proc.returncode != 0:
            if target.exists():
                target.unlink()
            receipts.append({"path": rel, "action": "deleted"})
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(proc.stdout)
        receipts.append({"path": rel, "action": "written", "bytes": len(proc.stdout)})
    return receipts


def grade_env(home: Path, tmp: Path, extra: Mapping[str, str], source: Optional[Mapping[str, str]] = None) -> dict[str, str]:
    source = os.environ if source is None else source
    env = {name: source[name] for name in PASS_THROUGH_ENV if name in source}
    env.setdefault("PATH", "/usr/bin:/bin")
    env.update(
        {"HOME": str(home), "TMPDIR": str(tmp), "PYTHONDONTWRITEBYTECODE": "1", "NODE_NO_WARNINGS": "1", "CI": "1"}
    )
    browsers = playwright_browsers(dict(source))
    if browsers:
        env["PLAYWRIGHT_BROWSERS_PATH"] = browsers
    env.update({k: str(v) for k, v in extra.items()})
    return env


def run_command(command: str, cwd: Path, env: dict[str, str], timeout: int) -> dict[str, Any]:
    started = time.monotonic()
    proc = subprocess.Popen(
        ["bash", "-c", command],
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        text=True,
        start_new_session=True,
    )
    try:
        out, _ = proc.communicate(timeout=timeout)
        code = proc.returncode
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGKILL)
        out, _ = proc.communicate()
        code = -9
    return {
        "command": command,
        "exit_code": code,
        "ok": code == 0,
        "seconds": round(time.monotonic() - started, 1),
        "output_tail": (out or "")[-OUTPUT_TAIL:],
    }


def grade(repo: Path, task: Task, source_repo: Path, *, home: Path, tmp: Path, apply_tests: bool = True) -> dict[str, Any]:
    """Run the task's test commands on ``repo`` (mutates it: the PR's test files replace the agent's)."""
    if task.kind != "pr" or not task.merge_sha:
        return {"graded": False, "reason": "temptation tasks have no hidden tests"}
    applied = apply_test_files(repo, source_repo, task.merge_sha, task.test_files) if apply_tests else []
    env = grade_env(home, tmp, task.test_env)
    steps = [run_command(cmd, repo, env, task.test_timeout_seconds) for cmd in task.test_commands]
    return {"graded": True, "passed": all(s["ok"] for s in steps), "applied": applied, "steps": steps}
