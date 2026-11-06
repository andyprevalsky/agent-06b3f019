"""Checks owned by other lanes, invoked by name from their own module or script.

A lane ships its check where it lives (a Python module, a front-end script, a Playwright
spec); this registry says how to call it with the run's context. A lane's file that is not
on the branch FAILS its check closed with an actionable reason: never a crash, never a pass.

    kind          target                              how it is called
    python_run    module:function                     module.hydrate_code_agent_run(base_url, api_key, user_id,
                                                      root_agent_id) -> run; function(run, **config) -> {passed, detail}
    python_root   module:function                     function(root_agent_id, base_url=, api_key=, user_id=, **config)
                                                      -> {passed, failures, report}
    python_github module:function                     async function(base_url, headers, agent_ids, expectation)
                                                      -> CheckResult; config = the expectation's fields
    script        repo-relative .sh                   bash script --backend URL --user-id ID --agent-id ID ...
                                                      [--require-root-reply] [--require-code-reply]; exit 0 = pass,
                                                      1 = findings (JSON on stdout), else not a verdict
    playwright    front-end-relative spec             CODE_AGENT_CHECK_ROOT_ID=<root> FRONTEND_URL=<fe> npx playwright
                                                      test <spec>; needs "1 passed" (a skipped spec is not a pass)

The run's context (base URL, user, root, tree agents, front-end URL) is evidence["context"]; the API key is
read from the environment at call time and is never stored in the run record.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import importlib
import json
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

REPO_ROOT = Path(__file__).resolve().parents[3]
FRONT_END = REPO_ROOT / "front-end"
PLAYWRIGHT_CMD = ("npx", "playwright", "test")
HYDRATE = "hydrate_code_agent_run"
NOT_CONFIG = {"type", "timeout_s"}


@dataclass(frozen=True)
class External:
    kind: str
    target: str

    @property
    def module(self) -> str:
        return self.target.partition(":")[0]

    @property
    def function(self) -> str:
        return self.target.partition(":")[2]


EXTERNAL: dict[str, External] = {
    # Lane A (spawn/messaging): one code agent per spawn; send_message_to_agent reaches its CLI.
    "code_agent_single_code_agent": External("python_run", "benchmarks.code_agent_run_checks:check_single_code_agent"),
    "code_agent_message_reached": External("python_run", "benchmarks.code_agent_run_checks:check_message_reached_code_agent"),
    # Lane C: thinking is a normal row with tok/s for the root and every code agent.
    "code_agent_thinking_rows": External("python_root", "benchmarks.thinking_rows_check:check_thinking_rows"),
    # Lane D: agent replies and code-agent command output render as markdown structure.
    "code_agent_markdown": External("script", "front-end/scripts/check-agent-markdown.sh"),
    # Lane B: the code-agent transcript renders in the folded work drawer (no duplicate rows, no branch rows).
    "code_agent_render": External("playwright", "front-end/tests-e2e/code-agent-render-check.spec.ts"),
    # Lane F: truthful behaviour under an injected GitHub rate limit. Needs the fake GitHub injected into the
    # backend, so it is declared only by a variant that injects it, never by the primary task.
    "code_agent_github_rate_limit": External("python_github", "benchmarks.github_rate_limit_check:check_github_rate_limit"),
}


class Absent(Exception):
    """The lane's module or script is not on this branch."""


def _api_key() -> str:
    from benchmarks.run_benchmark import API_KEY

    return API_KEY or os.environ.get("BACKEND_API_KEY", "")


def frontend_url(base_url: str) -> str:
    """The run's front end: the stack manifest's url, else the backend port + 1 (dev convention)."""
    manifest = Path(os.environ.get("BENCHMARK_CONTEXT_DIR", "") or "/nonexistent") / "services.json"
    try:
        url = json.loads(manifest.read_text()).get("urls", {}).get("frontend")
    except (OSError, ValueError):
        url = None
    if isinstance(url, str) and url:
        return url
    parsed = urlparse(base_url)
    return f"{parsed.scheme}://{parsed.hostname}:{(parsed.port or 80) + 1}"


def context(data: dict, base_url: str | None, agent_ids: list[str]) -> dict:
    from benchmarks.run_benchmark import _current_benchmark_user_id

    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    return {
        "base_url": (base_url or "").rstrip("/"),
        "user_id": _current_benchmark_user_id(),
        "root_agent_id": str(agent.get("agent_id") or agent.get("id") or ""),
        "agent_ids": agent_ids,
        "frontend_url": frontend_url(base_url or ""),
    }


def _load(spec: External):
    try:
        module = importlib.import_module(spec.module)
        return module, getattr(module, spec.function)
    except (ImportError, AttributeError) as exc:
        raise Absent(f"{spec.target} is not on this branch ({exc}); integrate the lane that owns it") from exc


async def hydrate_runs(modules: set[str], ctx: dict) -> dict[str, Any]:
    """Each python_run module's own hydration of this run (an error is kept, not raised)."""
    runs: dict[str, Any] = {}
    for name in sorted(modules):
        try:
            hydrate = getattr(importlib.import_module(name), HYDRATE)
            runs[name] = await hydrate(ctx["base_url"], _api_key(), ctx["user_id"], ctx["root_agent_id"])
        except Exception as exc:  # the dependent checks fail closed with this reason
            runs[name] = {"error": f"{type(exc).__name__}: {exc}"[:300]}
    return runs


def _config(check: dict) -> dict:
    return {k: v for k, v in check.items() if k not in NOT_CONFIG}


def _python_run(spec: External, check: dict, evidence: dict) -> tuple[bool, str]:
    run = (evidence.get("run") or {}).get(spec.module)
    if not isinstance(run, dict) or "error" in run:
        return False, f"{check['type']}: {spec.module} evidence unavailable ({(run or {}).get('error')})"
    result = _load(spec)[1](run, **_config(check))
    return bool(result.get("passed")), f"{check['type']}: {result.get('detail')}"


def _python_root(spec: External, check: dict, ctx: dict) -> tuple[bool, str]:
    result = _load(spec)[1](
        ctx["root_agent_id"], base_url=ctx["base_url"], api_key=_api_key(), user_id=ctx["user_id"], **_config(check)
    )
    failures = [str(f) for f in result.get("failures") or []]
    detail = "; ".join(failures[:4])[:900] if failures else json.dumps(result.get("report"), default=str)[:300]
    return bool(result.get("passed")), f"{check['type']}: {detail}"


def _python_github(spec: External, check: dict, ctx: dict) -> tuple[bool, str]:
    module, function = _load(spec)
    config = _config(check)
    reset = datetime.fromisoformat(str(config.pop("injected_reset_at")).replace("Z", "+00:00"))
    expectation = module.GithubRateLimitExpectation(
        injected_reset_at=reset, phase=config.pop("phase"), **{k: v for k, v in config.items()}
    )
    headers = {"X-API-Key": _api_key(), "X-User-Id": ctx["user_id"]}
    coro = function(ctx["base_url"], headers, ctx["agent_ids"], expectation)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:  # the caller already runs a loop
        result = pool.submit(asyncio.run, coro).result()
    return bool(result.passed), f"{check['type']}: {result.outcome}; {'; '.join(result.failures[:3])}"[:900]


def _subprocess(cmd: list[str], *, cwd: Path, env: dict, timeout_s: float, label: str):
    try:
        return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout_s, check=False)
    except FileNotFoundError as exc:
        raise Absent(f"{label} needs {cmd[0]!r} on PATH ({exc})") from exc
    except subprocess.TimeoutExpired:
        return None


def _script(spec: External, check: dict, ctx: dict) -> tuple[bool, str]:
    path = REPO_ROOT / spec.target
    if not path.is_file():
        raise Absent(f"{spec.target} is not on this branch; integrate the lane that owns it")
    cmd = ["bash", str(path), "--backend", ctx["base_url"], "--user-id", ctx["user_id"]]
    for agent_id in ctx["agent_ids"]:
        cmd += ["--agent-id", agent_id]
    cmd += [f"--require-{name}-reply" for name in ("root", "code") if check.get(f"require_{name}_reply")]
    timeout_s = float(check.get("timeout_s", 300))
    done = _subprocess(cmd, cwd=REPO_ROOT, env={**os.environ, "BACKEND_API_KEY": _api_key()}, timeout_s=timeout_s, label=spec.target)
    if done is None:
        return False, f"{check['type']}: {spec.target} timed out after {timeout_s:.0f}s"
    if done.returncode in (0, 1):
        try:
            report = json.loads(done.stdout)
        except ValueError:
            report = None
        if isinstance(report, dict):
            findings = report.get("violations") or []
            return done.returncode == 0, f"{check['type']}: checked {report.get('checked')}; {json.dumps(findings)[:700]}"
    return False, f"{check['type']}: {spec.target} exited {done.returncode}: {done.stderr.strip()[-600:]}"


def _playwright(spec: External, check: dict, ctx: dict) -> tuple[bool, str]:
    if not (REPO_ROOT / spec.target).is_file():
        raise Absent(f"{spec.target} is not on this branch; integrate the lane that owns it")
    env = {**os.environ, "CODE_AGENT_CHECK_ROOT_ID": ctx["root_agent_id"], "FRONTEND_URL": ctx["frontend_url"]}
    cmd = [*PLAYWRIGHT_CMD, spec.target.removeprefix("front-end/"), "--reporter=line"]
    timeout_s = float(check.get("timeout_s", 600))
    done = _subprocess(cmd, cwd=FRONT_END, env=env, timeout_s=timeout_s, label=spec.target)
    if done is None:
        return False, f"{check['type']}: {spec.target} timed out after {timeout_s:.0f}s"
    output = (done.stdout + done.stderr).strip()
    passed = done.returncode == 0 and re.search(r"\b1 passed\b", output) is not None
    return passed, f"{check['type']}: {'1 passed' if passed else output[-700:]}"


def run(check: dict, evidence: dict) -> tuple[bool, str]:
    spec = EXTERNAL[str(check["type"])]
    ctx = evidence.get("context") or {}
    try:
        if spec.kind == "python_run":
            return _python_run(spec, check, evidence)
        if spec.kind == "python_root":
            return _python_root(spec, check, ctx)
        if spec.kind == "python_github":
            return _python_github(spec, check, ctx)
        if spec.kind == "script":
            return _script(spec, check, ctx)
        return _playwright(spec, check, ctx)
    except Absent as exc:
        return False, f"{check['type']}: {exc}"
