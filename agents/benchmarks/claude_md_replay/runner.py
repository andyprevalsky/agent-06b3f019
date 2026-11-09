"""Headless Claude Code for one replay, through the code_bench_parity helpers.

Differences from the parity raw leg, on purpose: the default toolset is allowed (parity's narrow
--allowedTools would hide Task, WebSearch and TodoWrite behavior), HOME is the run's own empty home
(no ~/.claude/CLAUDE.md, no project memory), and PATH starts with the refusing shims.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Mapping, Optional

from benchmarks import code_bench_parity as parity
from benchmarks.claude_md_replay.sandbox import RunPaths, playwright_browsers

DEFAULT_MODEL = parity.DEFAULT_MODELS["claude"]
CREDENTIAL_MODES = ("env", "lease", "openrouter")
INIT_KEYS = ("cwd", "model", "tools", "permissionMode", "claude_code_version", "memory_paths", "slash_commands", "agents", "skills", "output_style")



USAGE_KEYS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")


def cumulative_usage(summary: dict[str, Any], transcript: str) -> dict[str, Any]:
    """Sum turns and tokens over every `result` event.

    A session that resumes after a background-task notification emits one result per resume; the shared
    parity summary keeps only the last one, which undercounts usage. Cost is already cumulative.
    """
    results = []
    for line in transcript.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == "result":
            results.append(event)
    if len(results) < 2:
        return summary
    merged = dict(summary)
    merged["num_turns"] = sum(int(e.get("num_turns") or 0) for e in results)
    for key in USAGE_KEYS:
        merged[key] = sum(int((e.get("usage") or {}).get(key) or 0) for e in results)
    merged["result_events"] = len(results)
    return merged

def claude_argv(cli_bin: str, model: str, effort: str, repo: Path, prompt: str, max_budget_usd: Optional[float]) -> parity.CliCommand:
    command = parity.cli_command("claude", model, repo, prompt, cli_bin=cli_bin, effort=effort)
    argv = list(command.argv)
    if "--allowedTools" in argv:
        index = argv.index("--allowedTools")
        del argv[index : index + 2]
    if max_budget_usd:
        argv += ["--max-budget-usd", f"{max_budget_usd:g}"]
    return parity.CliCommand(argv=argv, stdin=command.stdin)


def replay_env(paths: RunPaths, source_env: Mapping[str, str]) -> dict[str, str]:
    env = parity.cli_env("claude", paths.root, source_env=source_env)
    env["HOME"] = str(paths.home)
    env["TMPDIR"] = str(paths.tmp)
    env["PATH"] = f"{paths.bin}:{env.get('PATH', '/usr/bin:/bin')}"
    env["GIT_CONFIG_GLOBAL"] = str(paths.home / ".gitconfig")
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_TERMINAL_PROMPT"] = "0"
    browsers = playwright_browsers(dict(source_env))
    if browsers:
        env["PLAYWRIGHT_BROWSERS_PATH"] = browsers
    for name in ("GITHUB_TOKEN", "GH_TOKEN", "FLY_API_TOKEN", "RENDER_API_KEY", "VERCEL_TOKEN"):
        env.pop(name, None)
    return env


@asynccontextmanager
async def credentials(mode: str, *, env_file: Optional[Path], lease_backend: str, lease_user_id: str) -> AsyncIterator[dict[str, str]]:
    """Caller-environment credentials, or a Claude compute token leased (and released) via the backend."""
    base = dict(parity._CALLER_ENV)
    if mode == "env":
        if not any(base.get(name) for name in parity.CREDENTIAL_ENV["claude"][:3]):
            raise RuntimeError("--credential env needs CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the environment")
        yield base
        return
    if mode not in CREDENTIAL_MODES:
        raise ValueError(f"credential mode must be one of {CREDENTIAL_MODES}")
    if env_file is not None:
        # The lease helpers import agents config, which needs the full agents env in THIS process.
        # The CLI never sees it: its environment is built from parity._CALLER_ENV, captured at import.
        from dotenv import load_dotenv

        load_dotenv(env_file, override=False)
    if mode == "openrouter":
        # The gateway the Rose sandbox uses when no Claude credential is leasable (claudeCodeSandboxAuth.ts).
        yield parity.openrouter_gateway_env({**base, "OPENROUTER_API_KEY": os.environ.get("OPENROUTER_API_KEY", "")})
        return
    lease = await parity.lease_claude_token(lease_backend, lease_user_id)
    try:
        source = {k: v for k, v in base.items() if k not in parity.CREDENTIAL_ENV["claude"]}
        source["CLAUDE_CODE_OAUTH_TOKEN"] = str(lease["accessToken"])
        yield source
    finally:
        await parity.release_lease(lease)


USER_SKILL_PREFIX = "boxes-"


def install_user_skills(config_dir: Path, skills_from: Path) -> list[str]:
    """Copy the platform's boxes-* user skills (only those: no global CLAUDE.md or memory) into the run's config."""
    target = config_dir / "skills"
    target.mkdir(parents=True, exist_ok=True)
    copied = []
    for skill in sorted(skills_from.iterdir()):
        if skill.is_dir() and skill.name.startswith(USER_SKILL_PREFIX) and (skill / "SKILL.md").is_file():
            shutil.copytree(skill, target / skill.name, symlinks=True, dirs_exist_ok=True)
            copied.append(skill.name)
    return copied


def init_event(transcript: str) -> dict[str, Any]:
    for event in parity._json_lines(transcript):
        if event.get("type") == "system" and event.get("subtype") == "init":
            return {key: event.get(key) for key in INIT_KEYS if key in event}
    return {}


async def run_claude(
    paths: RunPaths,
    prompt: str,
    *,
    source_env: Mapping[str, str],
    model: str = DEFAULT_MODEL,
    effort: str = parity.DEFAULT_EFFORT,
    timeout: int,
    cli_bin: Optional[str] = None,
    max_budget_usd: Optional[float] = None,
    user_skills_from: Optional[Path] = None,
) -> dict[str, Any]:
    resolved = cli_bin or shutil.which("claude", path=source_env.get("PATH")) or "claude"
    command = claude_argv(resolved, model, effort, paths.repo, prompt, max_budget_usd)
    env = replay_env(paths, source_env)
    skills = install_user_skills(Path(env["CLAUDE_CONFIG_DIR"]), user_skills_from) if user_skills_from else []
    started = time.monotonic()
    exit_code, transcript = await asyncio.to_thread(
        parity._run_cli, command.argv, cwd=paths.repo, stdin=command.stdin, timeout=timeout, env=env
    )
    duration = round(time.monotonic() - started, 1)
    (paths.root / "trace.jsonl").write_text(transcript)
    summary = cumulative_usage(parity.summarize_transcript("claude", transcript), transcript)
    return {
        "argv": [a if a != prompt else "<prompt>" for a in command.argv],
        "cli_bin": resolved,
        "transport": parity.describe_transport(env),
        "config_dir": env.get("CLAUDE_CONFIG_DIR"),
        "home": env["HOME"],
        "exit_code": exit_code,
        "duration_seconds": duration,
        "timed_out": exit_code == -9,
        "summary": summary,
        "init": init_event(transcript),
        "user_skills": skills,
        "infra": parity.infra_failure(summary, exit_code)
        or (None if "result" in summary else f"CLI exited {exit_code} without a result event: {transcript.strip()[-300:]}"),
    }
