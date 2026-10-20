"""Blackbox tests for persistent code sessions on the agents side.

Covers rose-builds-rose rows C1, C2, C4, C11, C13 and C15 at the activity / sandbox
boundary, for cloud sessions and for local (Mac, C14) runs. Every case runs the production ``ws-server.mjs`` on localhost with a
scripted ``claude`` CLI; the backend session API is recorded. Like a paused E2B
sandbox, the session HOME outlives each ws-server, so "resume" restarts the
ws-server in the same HOME with the stored CLI session id.

  activity ──create(code_session_id?, lease_owner)──► recorder (backend stand-in)
     │                                                   └─ ws-server.mjs + stub CLI in HOME
     ├─ monitors events (virtual clock for the no-timeout case)
     └─ close(reason) ──► recorder stops the ws-server (pause), HOME kept
"""

import asyncio
import contextlib
import dataclasses
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch

from _test_utils import BlackboxResult, setup_mock, teardown_mock

_REPO_ROOT = Path(__file__).resolve().parents[3]
_WS_SERVER = _REPO_ROOT / "e2b-templates" / "claude-code" / "ws-server.mjs"
_SCHEMA = {"fields": [{"name": "answer", "type": "str", "required": True}]}
_CLI_SESSION_ID = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e"

# The scripted CLI. First run: writes an uncommitted file, starts a Bash tool
# and holds it in flight until the test opens the "tool_done" gate, then
# finishes the tool and goes quiet (an idle CLI). With --resume it checks the
# file survived and completes. STUB_MODE=finish completes on the first run.
_STUB_CLI = r"""
import json, os, pathlib, subprocess, sys, time

# stream-json input: the task prompt is the first JSON line; the ws-server
# keeps stdin open until every written turn has its result.
sys.stdin.readline()
gate = pathlib.Path(os.environ["STUB_GATE"])
home = pathlib.Path(os.environ["HOME"])
argv = sys.argv[1:]
cwd = pathlib.Path.cwd()

def git(*args):
    proc = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    return proc.stdout.strip()

with (gate / "runs.jsonl").open("a") as runs:
    runs.write(json.dumps({"argv": argv, "cwd": str(cwd), "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
                           "head": git("rev-parse", "HEAD")}) + "\n")

def emit(message):
    print(json.dumps(message), flush=True)

resume = argv[argv.index("--resume") + 1] if "--resume" in argv else None
session_id = resume or os.environ["STUB_SESSION_ID"]
project = home / ".claude" / "projects" / "-stub"
project.mkdir(parents=True, exist_ok=True)
with (project / f"{session_id}.jsonl").open("a") as transcript:
    transcript.write(json.dumps({"type": "user", "sessionId": session_id}) + "\n")
emit({"type": "system", "subtype": "init", "session_id": session_id, "cwd": str(cwd), "model": "stub",
      "tools": ["Bash"], "permissionMode": "bypassPermissions"})
notes = home / "notes.txt"
if resume is None and os.environ.get("STUB_MODE") == "rate_limit":
    notes.write_text("uncommitted work\n")
    emit({"type": "assistant", "message": {"content": [{"type": "text", "text": "half done"}]}})
    emit({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "rateLimitType": "five_hour",
          "resetsAt": 1790988600, "utilization": 1.0}})
    while True:  # the CLI would now fail its turn; the activity must act on the event
        time.sleep(0.1)
if resume is None and os.environ.get("STUB_MODE") not in ("finish", "rate_limit"):
    notes.write_text("uncommitted work\n")
    emit({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "sleep 99999"}}]}})
    while not (gate / "tool_done").exists():
        time.sleep(0.05)
    emit({"type": "user", "tool_use_result": {"stdout": "done", "stderr": ""},
          "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "done"}]}})
    while True:  # an idle CLI: no exit, no further events
        time.sleep(0.1)
found = notes.read_text().strip() if notes.exists() else "missing"
emit({"type": "assistant", "message": {"content": [{"type": "text", "text": f"notes: {found}"}]}})
emit({"type": "result", "subtype": "success", "result": f"answer is 42 ({found})", "usage": {}})
while sys.stdin.readline():  # later turns are acknowledged; exit on EOF
    emit({"type": "result", "subtype": "success", "result": "turn answered", "usage": {}})
"""


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class _SessionHome:
    """A persistent code-session HOME; each start() is one ws-server (one spawn)."""

    def __init__(self, *, extra_env: dict | None = None, git_config: str | None = None) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="code-session-"))
        self.home = self.tmp / "home"
        self.bin = self.tmp / "bin"
        self.home.mkdir()
        self.bin.mkdir()
        (self.tmp / "stub_claude.py").write_text(_STUB_CLI)
        cli = self.bin / "claude"
        cli.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{self.tmp / "stub_claude.py"}" "$@"\n')
        cli.chmod(0o755)
        if git_config:
            (self.home / ".gitconfig").write_text(git_config)
        self.extra_env = extra_env or {}
        self.process: subprocess.Popen | None = None
        self.port = 0
        self.log_path = self.tmp / "ws-server.log"

    @property
    def ws_url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"

    async def start(self, **env) -> str:
        node = shutil.which("node")
        assert node, "node is required to run the Claude Code ws-server under test"
        self.port = _free_port()
        full_env = {
            "PATH": f"{self.bin}:{os.environ.get('PATH', '')}",
            "HOME": str(self.home),
            "PORT": str(self.port),
            "CLAUDE_CODE_GOAL": "Write answer.txt with the answer",
            "ANTHROPIC_API_KEY": "stub-key",
            "STUB_GATE": str(self.tmp),
            "STUB_SESSION_ID": _CLI_SESSION_ID,
            "GIT_TERMINAL_PROMPT": "0",
            **self.extra_env,
            **{key: str(value) for key, value in env.items()},
        }
        with self.log_path.open("a") as log:
            self.process = subprocess.Popen(
                [node, str(_WS_SERVER)], cwd=self.home, env=full_env, stdout=log, stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        for _ in range(300):
            assert self.process.poll() is None, f"ws-server exited at startup:\n{self.log()}"
            with contextlib.suppress(OSError), socket.create_connection(("127.0.0.1", self.port), timeout=0.2):
                return self.ws_url
            await asyncio.sleep(0.05)
        raise AssertionError(f"ws-server never listened:\n{self.log()}")

    def release(self, gate: str) -> None:
        (self.tmp / gate).touch()

    def runs(self) -> list[dict]:
        path = self.tmp / "runs.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def log(self) -> str:
        return self.log_path.read_text() if self.log_path.exists() else ""

    def pause(self) -> None:
        """Stop this spawn's ws-server + CLI (E2B pause stand-in); HOME is kept."""
        if self.process is not None and self.process.poll() is None:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(self.process.pid, sig)
                with contextlib.suppress(subprocess.TimeoutExpired):
                    self.process.wait(timeout=5)
        self.process = None

    def cleanup(self) -> None:
        self.pause()
        shutil.rmtree(self.tmp, ignore_errors=True)


class _Backend:
    """Records the session API; create/resume start ws-servers in one persistent HOME."""

    def __init__(
        self, session_home: _SessionHome, *, fail_first_persist: bool = False, question_after: int | None = None
    ) -> None:
        self.session_home = session_home
        self.created: list[dict] = []
        self.closed: list[dict] = []
        self.messages: list[dict] = []
        self.keepalives = 0
        self.verified_events: list[list[dict]] = []
        self.fail_first_persist = fail_first_persist
        self._persists = 0
        # Keepalive number after which the backend reports a question the code
        # agent asked its (blocked) spawning agent.
        self.question_after = question_after
        self.usage_reports: list[tuple] = []
        # Credential availability the backend reports to each spawn (C15).
        self.availability: list[dict] = []
        self.availability_own_only: list[bool] = []
        self.local = False
        # What the usage-limit answer says a respawn leases (the backend's stored view).
        self.next_lease = dict(_SHARED_CLAUDE_LEASE)

    async def create_session(self, **kwargs):
        self.created.append(kwargs)
        if kwargs.get("target") == "local":
            # A Mac run (C14): the same ws-server in the user's folder, no code
            # session; a later run in that folder is a fresh CLI conversation.
            self.local = True
            later = {"STUB_MODE": "finish"} if len(self.created) > 1 else {}
            ws_url = await self.session_home.start(**later)
            return {
                "task_id": f"task-{len(self.created)}",
                "sandbox_id": f"local-device:dev-1-task-{len(self.created)}",
                "ws_url": ws_url,
                "uploaded_files": [],
                "github_repo_url": None,
                "device_name": _MAC,
                "folder": _MAC_FOLDER,
            }
        code_session_id = kwargs.get("code_session_id") or "6c1d6f1e-0000-4000-8000-00000000c0de"
        resume_env = {"CLAUDE_CODE_RESUME_SESSION_ID": _CLI_SESSION_ID} if len(self.created) > 1 else {}
        ws_url = await self.session_home.start(**resume_env)
        return {
            "task_id": f"task-{len(self.created)}",
            "sandbox_id": "sb-persistent",
            "ws_url": ws_url,
            "uploaded_files": [],
            "code_session_id": code_session_id,
            "resumed_from": "paused_sandbox" if len(self.created) > 1 else "new",
            "branch": "rose/write-answer-0a1b2c3d",
            "base_branch": None,
            "merge_target": None,
        }

    async def close_session(self, **kwargs):
        self.closed.append(kwargs)
        self.session_home.pause()
        if self.local:
            return {"output_files": []}  # nothing uploaded from the Mac, no code session
        return {
            "output_files": [],
            "usage": None,
            "code_session": {
                "code_session_id": "6c1d6f1e-0000-4000-8000-00000000c0de",
                "state": "PAUSED",
                "checkpoint_seq": len(self.closed),
                "branch": "rose/write-answer-0a1b2c3d",
                "merge_target": "main",
                "repo": {"head": "a" * 40, "localCommits": 1, "pushed": False, "dirtyFiles": 1,
                         "files": [{"path": "notes.txt", "added": 1, "removed": 0}]},
                "merge": {"head": "a" * 40, "local_commits": 1, "pushed": False, "pr": None,
                          "merged": False, "merge_target_contains_head": False},
            },
        }

    async def save_message(self, **kwargs):
        self.messages.append(kwargs)

    async def persist_output(self, *args, **kwargs):
        self._persists += 1
        if self.fail_first_persist and self._persists == 1:
            raise RuntimeError("transcript store unavailable")

    async def keepalive(self, *args, **kwargs):
        self.keepalives += 1
        awaiting = None
        if self.question_after is not None and self.keepalives >= self.question_after:
            awaiting = {"message_id": "q-1", "question": "Which database should I use?", "at": "2026-10-20T00:00:00Z"}
        return {"alive": True, "code_session_id": "6c1d6f1e-0000-4000-8000-00000000c0de", "awaiting_parent": awaiting}

    async def report_usage(self, task_id, code_provider, resets_at):
        self.usage_reports.append((task_id, code_provider, resets_at))
        return {
            "marked": f"{code_provider}_pool:tok-1",
            "resets_at": "2026-10-03T00:50:00.000Z",
            "accounts": [dict(account) for account in _ACCOUNTS],
            "next_lease": dict(self.next_lease),
        }

    async def credential_availability(self, user_id, own_only=False):
        self.availability_own_only.append(own_only)
        return self.availability.pop(0) if self.availability else {"claude": True, "codex": True}

    async def verifier(self, **kwargs):
        self.verified_events.append([dict(event) for event in kwargs["code_events"]])
        return (1.0, "answer recorded", {"answer": "42"}, 0, 0)

    @contextlib.contextmanager
    def patched(self, clock=None):
        from domains.spawn_claude_code_agent import service
        from helpers.activity_generation_drain import reset_live_queue_cache

        reset_live_queue_cache()
        patches = [
            patch.object(service, "create_e2b_session", side_effect=self.create_session),
            patch.object(service, "close_e2b_session", side_effect=self.close_session),
            patch.object(service, "save_claude_code_message", side_effect=self.save_message),
            patch.object(service, "persist_terminal_output", side_effect=self.persist_output),
            patch.object(service, "keepalive_e2b_session", side_effect=self.keepalive),
            patch.object(service, "report_code_usage_limit", side_effect=self.report_usage),
            patch.object(service, "fetch_code_credential_availability", side_effect=self.credential_availability),
            patch.object(service, "_run_verifier", side_effect=self.verifier),
            patch.object(service, "_log_code_agent_event", lambda event, **kw: None),
            patch.object(service, "REATTACH_PROBE_BACKOFF_S", 0.05),
            patch.object(service, "SandboxLogCollector", lambda *a, **kw: AsyncMock()),
            patch.object(service, "_resolve_claude_token_for_activity", AsyncMock(return_value=None)),
            patch(
                "helpers.model_pricing.get_model_pricing_with_fallback",
                AsyncMock(return_value={"input_cents_per_1k": 0, "output_cents_per_1k": 0}),
            ),
            patch(
                "helpers.activity_generation_drain.read_agent_queue_pointer",
                AsyncMock(return_value={"task_queue": "test"}),
            ),
        ]
        if clock is not None:
            patches.append(patch.object(service, "safe_time", clock))
        with contextlib.ExitStack() as stack:
            for item in patches:
                stack.enter_context(item)
            yield
        reset_live_queue_cache()


# The backend's stored view of the user's accounts on a usage limit (no provider calls).
_ACCOUNTS = [
    {"provider": "claude", "label": "me@example.com", "status": "limited",
     "limited_until": "2026-10-03T00:50:00.000Z", "this_run": True},
    {"provider": "codex", "label": "codex@example.com", "status": "available",
     "limited_until": None, "this_run": False},
]
_SHARED_CLAUDE_LEASE = {"provider": "claude", "label": None, "available_now": True, "available_at": None}
_CODEX_LEASE = {"provider": "codex", "label": "codex@example.com", "available_now": True, "available_at": None}
_ACCOUNT_LINES = (
    "Connected accounts:\n"
    "- Claude Code me@example.com: limited until 2026-10-03T00:50:00.000Z (this run)\n"
    "- Codex codex@example.com: available\n"
)

_MAC = "Andy's MacBook"
_MAC_FOLDER = "~/Developer/rose"


def _activity_args(*, code_session_request=None, tool_call_id="tc-code", local=False) -> list:
    return [
        "user-code", "agent-code", "Write answer.txt with the answer", tool_call_id, _SCHEMA, None,
        "rose-labs/rose-1-flash", None, None, "claude", None, None, None, None, False, None,
        code_session_request,
        *(["local", "dev-1", _MAC] if local else []),
    ]


def _virtual_clock(scale: float):
    """safe_time() stand-in: `scale` virtual seconds per real second."""
    t0 = time.monotonic()
    base = time.time()
    return lambda: base + (time.monotonic() - t0) * scale


async def _wait_until(predicate, what: str, timeout: float = 20.0):
    for _ in range(int(timeout / 0.05)):
        if predicate():
            return
        await asyncio.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


async def test_idle_past_every_old_limit_is_paused_not_failed_then_resumes():
    """C11 + C1: no runtime limit; idle → paused (resumable); the next spawn resumes it.

    Virtual clock: 2000 s per real second. The Bash tool stays in flight for
    ~5000 virtual seconds, past every removed limit (MAX_RUNTIME_S 1800,
    SDK_IDLE 180, SDK_WAIT_TOOL_IDLE 900, the 50-minute activity deadline), and
    the session must stay attached. Once the tool finishes and the CLI goes
    quiet, the session is paused — status "paused", never an error — and a
    spawn with that code_session_id resumes the same HOME with ``--resume``.
    """
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service
    from domains.spawn_claude_code_agent.config import CODE_SESSION_IDLE_PAUSE_S

    session_home = _SessionHome()
    backend = _Backend(session_home)
    try:
        with backend.patched(clock=_virtual_clock(2000.0)):
            env = ActivityEnvironment()
            first = asyncio.create_task(env.run(service.spawn_claude_code_activity, *_activity_args()))
            await _wait_until(lambda: session_home.runs(), "the CLI to start")
            await asyncio.sleep(2.5)  # ~5000 virtual seconds with Bash in flight
            assert not first.done(), f"an in-flight tool must keep the session attached: {first.result()}"
            assert backend.closed == [], f"nothing may close a working session: {backend.closed}"
            assert backend.keepalives >= 5, f"attached sessions keep their sandbox alive: {backend.keepalives}"
            session_home.release("tool_done")
            paused = await asyncio.wait_for(first, timeout=30)

        assert paused["status"] == "paused" and paused["success"] is False, paused
        assert "not failed" in paused["message"], paused["message"]
        assert [call.get("reason") for call in backend.closed] == ["idle"], backend.closed
        assert paused["code_session"]["code_session_id"] == "6c1d6f1e-0000-4000-8000-00000000c0de", paused
        assert paused["code_agent"]["state"] == "paused", paused["code_agent"]
        assert any(m.get("action_type") == "session_paused" for m in backend.messages), backend.messages
        assert not any(m.get("title") == "Task Failed" for m in backend.messages), backend.messages
        assert CODE_SESSION_IDLE_PAUSE_S >= 600

        with backend.patched():
            resumed = await asyncio.wait_for(
                ActivityEnvironment().run(
                    service.spawn_claude_code_activity,
                    *_activity_args(code_session_request={"code_session_id": paused["code_session"]["code_session_id"]}),
                ),
                timeout=30,
            )
        assert resumed["status"] == "completed" and resumed["success"] is True, resumed
        assert backend.created[1]["code_session_id"] == "6c1d6f1e-0000-4000-8000-00000000c0de", backend.created
        second_run = session_home.runs()[-1]
        assert second_run["argv"][-2:] == ["--resume", _CLI_SESSION_ID] or (
            "--resume" in second_run["argv"]
            and second_run["argv"][second_run["argv"].index("--resume") + 1] == _CLI_SESSION_ID
        ), second_run
        texts = [e.get("text") for e in backend.verified_events[-1] if e.get("type") == "agent_message"]
        assert "notes: uncommitted work" in texts, f"resumed session must see the earlier file: {texts}"
    finally:
        session_home.cleanup()


async def test_question_to_blocked_spawner_pauses_session_and_returns_it():
    """L-A2A deadlock: a code agent asks its spawning agent, which is blocked in this spawn.

    The question arrives through the keepalive while a tool is still in flight
    (so idle never fires). The session is paused, not failed, and the tool
    result carries the question so the spawner can answer by resuming it.
    """
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    session_home = _SessionHome()
    backend = _Backend(session_home, question_after=3)
    try:
        with backend.patched(clock=_virtual_clock(2000.0)):
            outcome = await asyncio.wait_for(
                ActivityEnvironment().run(service.spawn_claude_code_activity, *_activity_args()), timeout=30
            )
        assert outcome["status"] == "paused" and outcome["success"] is False, outcome
        assert "Which database should I use?" in outcome["message"], outcome["message"]
        assert "code_session_id" in outcome["message"], outcome["message"]
        assert [call.get("reason") for call in backend.closed] == ["awaiting_parent"], backend.closed
        assert outcome["code_agent"]["state"] == "paused", outcome["code_agent"]
        assert backend.keepalives >= 3, backend.keepalives
    finally:
        session_home.cleanup()


async def test_question_while_cli_waits_for_its_answer_is_handed_over_before_idle():
    """L-A2A-ADV 1: the code agent asked and went quiet waiting for its answer.

    Its spawning agent is blocked inside this very spawn, so both would wait.
    The next keepalive (well before the idle pause) must pause the session for
    the question exactly once and hand it to the spawner; resuming the session
    then runs normally with no stale question.
    """
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service
    from domains.spawn_claude_code_agent.config import (
        CODE_SESSION_IDLE_PAUSE_S,
        CODE_SESSION_KEEPALIVE_INTERVAL_S,
    )

    scale = 200.0
    session_home = _SessionHome()
    backend = _Backend(session_home)
    try:
        with backend.patched(clock=_virtual_clock(scale)):
            spawn = asyncio.create_task(
                ActivityEnvironment().run(service.spawn_claude_code_activity, *_activity_args())
            )
            await _wait_until(lambda: session_home.runs(), "the CLI to start")
            session_home.release("tool_done")  # the tool ends; the CLI now waits for the answer
            await asyncio.sleep(0.3)
            assert not spawn.done(), "the session is still attached before the question"
            asked_at = time.monotonic()
            backend.question_after = backend.keepalives + 1  # the CLI asked its blocked spawner
            outcome = await asyncio.wait_for(spawn, timeout=30)
            handoff_virtual_s = (time.monotonic() - asked_at) * scale
        assert outcome["status"] == "paused" and outcome["success"] is False, outcome
        assert "Which database should I use?" in outcome["message"], outcome["message"]
        assert [call.get("reason") for call in backend.closed] == ["awaiting_parent"], backend.closed
        handoff_bound_s = 2 * CODE_SESSION_KEEPALIVE_INTERVAL_S
        assert handoff_bound_s < CODE_SESSION_IDLE_PAUSE_S, (handoff_bound_s, CODE_SESSION_IDLE_PAUSE_S)
        assert handoff_virtual_s <= handoff_bound_s, f"handed over after {handoff_virtual_s:.0f}s, not by a keepalive"
        paused_rows = [m for m in backend.messages if m.get("action_type") == "session_paused"]
        assert len(paused_rows) == 1, paused_rows
        code_session_id = outcome["code_session"]["code_session_id"]

        # The spawner answers by resuming the session; the new task has no question.
        backend.question_after = None
        with backend.patched():
            resumed = await asyncio.wait_for(
                ActivityEnvironment().run(
                    service.spawn_claude_code_activity,
                    *_activity_args(
                        code_session_request={"code_session_id": code_session_id}, tool_call_id="tc-answer"
                    ),
                ),
                timeout=30,
            )
        assert resumed["status"] == "completed" and resumed["success"] is True, resumed
        assert backend.created[-1]["code_session_id"] == code_session_id, backend.created
        assert [call.get("reason") for call in backend.closed] == ["awaiting_parent", "close"], backend.closed
    finally:
        session_home.cleanup()


async def test_cancelled_spawner_unblocks_a_child_waiting_for_its_answer():
    """L-A2A-ADV 10: the spawner is cancelled while its code agent waits for an answer.

    The child asked and is idle; before the keepalive hands the question over,
    the user cancels the spawning agent (the workflow cancels the activity).
    The spawn returns a cancelled outcome promptly, the session is closed once,
    and nothing keeps polling for it afterwards.
    """
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    session_home = _SessionHome()
    backend = _Backend(session_home)
    try:
        with backend.patched(clock=_virtual_clock(200.0)):
            env = ActivityEnvironment()
            spawn = asyncio.create_task(env.run(service.spawn_claude_code_activity, *_activity_args()))
            await _wait_until(lambda: session_home.runs(), "the CLI to start")
            session_home.release("tool_done")
            await asyncio.sleep(0.3)
            assert not spawn.done(), "still attached while the child waits"
            cancelled_at = time.monotonic()
            env.cancel()
            outcome = await asyncio.wait_for(spawn, timeout=15)
            latency = time.monotonic() - cancelled_at
            keepalives_at_return = backend.keepalives
            await asyncio.sleep(0.5)
            keepalives_later = backend.keepalives
        assert outcome["status"] == "cancelled", outcome
        assert latency < 10, f"cancel took {latency:.1f}s"
        assert [call.get("reason") for call in backend.closed] == ["cancel"], backend.closed
        assert keepalives_later == keepalives_at_return, "nothing polls the session after the cancel"
        assert session_home.process is None, "the CLI and its ws-server are stopped"
        cancelled_rows = [m for m in backend.messages if m.get("title") == "Session Cancelled"]
        assert len(cancelled_rows) == 1, backend.messages
    finally:
        session_home.cleanup()


async def _usage_limit_then_retry(availability_on_retry: dict) -> tuple[dict, dict, _Backend, _SessionHome]:
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    session_home = _SessionHome(extra_env={"STUB_MODE": "rate_limit"})
    backend = _Backend(session_home)
    backend.availability = [{"claude": True, "codex": True}, availability_on_retry]
    if not availability_on_retry.get("claude"):
        backend.next_lease = dict(_CODEX_LEASE)
    with backend.patched():
        first = await asyncio.wait_for(
            ActivityEnvironment().run(service.spawn_claude_code_activity, *_activity_args()), timeout=30
        )
        retry_id = (first.get("retry") or {}).get("code_session_id")
        retry = await asyncio.wait_for(
            ActivityEnvironment().run(
                service.spawn_claude_code_activity,
                *_activity_args(code_session_request={"code_session_id": retry_id}, tool_call_id="tc-retry"),
            ),
            timeout=30,
        )
    return first, retry, backend, session_home


async def test_usage_limit_saves_session_and_retry_leases_next_credential():
    """C15: a structured usage limit mid-task → saved session + exact retry; the retry resumes it.

    (a) the parent gets a structured, retryable error naming the retry call;
    (b) the exhausted credential is reported for rate-limiting with its reset;
    (c) the retry keeps the provider while it still has a credential;
    (d) the resumed session sees the work from before the limit.
    """
    first, retry, backend, session_home = await _usage_limit_then_retry({"claude": True, "codex": True})
    try:
        assert first["status"] == "usage_limit" and first["success"] is False, first
        assert first["failure_kind"] == "usage_limit" and first["retryable"] is True, first
        session_id = "6c1d6f1e-0000-4000-8000-00000000c0de"
        assert first["retry"] == {"tool": "spawn_agent", "type": "code", "code_session_id": session_id}, first
        # The parent's tool error: what stopped, every connected account, what a respawn takes.
        assert first["message"] == (
            "Code agent stopped: the Claude Code usage limit was reached on me@example.com "
            "(resets 2026-10-03T00:50:00.000Z). Its work is saved on branch rose/write-answer-0a1b2c3d "
            "(checkpoint 1).\n"
            + _ACCOUNT_LINES
            + f"Respawn with spawn_agent(type='code', code_session_id='{session_id}', "
            "goal=<the same goal>) to continue: the respawn leases an account that is not rate-limited "
            "(now a shared Claude Code account) and resumes from the latest checkpoint."
        ), first["message"]
        assert first["usage_limit"]["resets_at"] == "2026-10-03T00:50:00.000Z", first["usage_limit"]
        assert first["usage_limit"]["accounts"] == _ACCOUNTS, first["usage_limit"]
        assert first["usage_limit"]["next_lease"] == _SHARED_CLAUDE_LEASE, first["usage_limit"]
        assert backend.usage_reports == [("task-1", "claude", 1790988600)], backend.usage_reports
        assert [call.get("reason") for call in backend.closed][0] == "usage_limit", backend.closed
        # The UI reads a resumable pause with plain user text; the parent keeps the retry.
        user_text = "Paused: Claude usage limit reached (resets Oct 3, 12:50 AM UTC). Work is saved."
        assert first["code_agent"]["state"] == "paused", first["code_agent"]
        assert first["code_agent"]["failure_message"] == user_text, first["code_agent"]
        progress = [m for m in backend.messages if m.get("action_type") == "usage_limit"]
        assert [m["message"] for m in progress] == [user_text], progress
        assert progress[0]["code_agent"]["state"] == "paused", progress[0]["code_agent"]

        assert backend.created[1]["code_session_id"] == session_id, backend.created[1]
        assert backend.created[1]["code_provider"] == "claude", backend.created[1]
        assert retry["status"] == "completed" and retry["success"] is True, retry
        texts = [e.get("text") for e in backend.verified_events[-1] if e.get("type") == "agent_message"]
        assert "notes: uncommitted work" in texts, texts
    finally:
        session_home.cleanup()


async def test_usage_limit_retry_switches_provider_when_pool_is_exhausted():
    """C15 (c): no Claude credential left → the retry continues the same session on Codex."""
    first, retry, backend, session_home = await _usage_limit_then_retry({"claude": False, "codex": True})
    try:
        assert first["status"] == "usage_limit", first
        assert backend.created[1]["code_provider"] == "codex", backend.created[1]
        assert backend.created[1]["code_session_id"] == first["retry"]["code_session_id"], backend.created
        assert retry["code_provider"] == "codex" and retry["status"] == "completed", retry
        texts = [e.get("text") for e in backend.verified_events[-1] if e.get("type") == "agent_message"]
        assert "notes: uncommitted work" in texts, texts
    finally:
        session_home.cleanup()


async def test_local_session_idle_pauses_in_the_mac_folder():
    """C11 on a Mac run (C14): no runtime limit, idle → paused, never failed.

    A Mac session cannot be E2B-paused: closing stops its CLI and the work
    stays in the user's folder, so the paused result points the parent at
    target='local' instead of a code_session_id. Keepalives still run (the
    backend has no sandbox idle window to extend for a Mac).
    """
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    session_home = _SessionHome()
    backend = _Backend(session_home)
    try:
        with backend.patched(clock=_virtual_clock(2000.0)):
            run = asyncio.create_task(ActivityEnvironment().run(service.spawn_claude_code_activity, *_activity_args(local=True)))
            await _wait_until(lambda: session_home.runs(), "the CLI to start")
            await asyncio.sleep(1.0)  # ~2000 virtual seconds with Bash in flight
            assert not run.done(), f"an in-flight tool keeps a Mac session attached too: {run.result()}"
            session_home.release("tool_done")
            paused = await asyncio.wait_for(run, timeout=30)

        assert backend.created[0]["target"] == "local" and backend.created[0]["local_device_id"] == "dev-1"
        assert paused["status"] == "paused" and paused["success"] is False, paused
        assert f"stay in {_MAC_FOLDER} on {_MAC}" in paused["message"], paused["message"]
        assert "target='local'" in paused["message"] and "code_session_id" not in paused["message"], paused
        assert [call.get("reason") for call in backend.closed] == ["idle"], backend.closed
        meta = paused["code_agent"]
        assert (meta["target"], meta["device_name"], meta["folder"], meta["state"]) == (
            "local", _MAC, _MAC_FOLDER, "paused"
        ), meta
        assert backend.keepalives >= 1, backend.keepalives
        assert backend.availability_own_only == [True], "a Mac run only counts the user's own logins"
    finally:
        session_home.cleanup()


async def test_local_usage_limit_retries_on_the_mac_with_the_other_login():
    """C15 on a Mac run: structured error with a target='local' retry; the work stays in the folder.

    The retry continues in the same folder on the user's other own login when
    the limited one is still exhausted (own-only availability, no pool token).
    """
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    session_home = _SessionHome(extra_env={"STUB_MODE": "rate_limit"})
    backend = _Backend(session_home)
    backend.availability = [{"claude": True, "codex": True}, {"claude": False, "codex": True}]
    backend.next_lease = dict(_CODEX_LEASE)
    try:
        with backend.patched():
            first = await asyncio.wait_for(
                ActivityEnvironment().run(service.spawn_claude_code_activity, *_activity_args(local=True)), timeout=30
            )
            retry = await asyncio.wait_for(
                ActivityEnvironment().run(
                    service.spawn_claude_code_activity, *_activity_args(tool_call_id="tc-retry", local=True)
                ),
                timeout=30,
            )
        assert first["status"] == "usage_limit" and first["retryable"] is True, first
        assert first["retry"] == {"tool": "spawn_agent", "type": "code", "target": "local"}, first
        assert first["message"] == (
            "Code agent stopped: the usage limit of your own Claude Code login me@example.com was reached "
            f"(resets 2026-10-03T00:50:00.000Z). Its files and commits stay in {_MAC_FOLDER} on {_MAC}.\n"
            + _ACCOUNT_LINES
            + "Respawn with spawn_agent(type='code', target='local', goal=<the same goal>) to continue there: "
            "the respawn uses one of your own logins that is not rate-limited (now Codex codex@example.com) "
            "and continues from the files in that folder."
        ), first["message"]
        assert backend.usage_reports == [("task-1", "claude", 1790988600)], backend.usage_reports
        assert first["code_agent"]["target"] == "local" and first["code_agent"]["state"] == "paused", first
        assert first["code_agent"]["failure_message"] == (
            f"Paused: Claude usage limit reached (resets Oct 3, 12:50 AM UTC). Work stays in {_MAC_FOLDER} on {_MAC}."
        ), first["code_agent"]

        assert backend.availability_own_only == [True, True], backend.availability_own_only
        assert backend.created[1]["target"] == "local" and backend.created[1]["code_provider"] == "codex"
        assert retry["status"] == "completed" and retry["code_provider"] == "codex", retry
        texts = [e.get("text") for e in backend.verified_events[-1] if e.get("type") == "agent_message"]
        assert "notes: uncommitted work" in texts, f"the retry continues in the same folder: {texts}"
    finally:
        session_home.cleanup()


def test_usage_limit_detection_reads_structured_events_only():
    """Only the CLIs' structured limit signals count; printed limit text never does (rule 25b)."""
    from domains.spawn_claude_code_agent.service import usage_limit_from_event

    rejected = {"type": "cli_message", "raw_type": "rate_limit_event",
                "cli_message": {"type": "rate_limit_event",
                                "rate_limit_info": {"status": "rejected", "resetsAt": 5, "rateLimitType": "five_hour"}}}
    assert usage_limit_from_event(rejected) == {"provider": "claude", "resets_at": 5, "limit_type": "five_hour"}
    warning = json.loads(json.dumps(rejected))
    warning["cli_message"]["rate_limit_info"]["status"] = "allowed_warning"
    assert usage_limit_from_event(warning) is None
    codex = {"provider": "codex", "type": "error", "message": "x",
             "usage_limit": {"reached_type": "rate_limit_reached", "resets_at": 9}}
    assert usage_limit_from_event(codex) == {"provider": "codex", "resets_at": 9, "limit_type": "rate_limit_reached"}
    for prose in (
        {"type": "agent_message", "text": "You've hit your limit · resets 5pm (UTC)"},
        {"type": "error", "message": "You've hit your usage limit."},
        {"type": "stdout", "text": "usage_limit_reached"},
    ):
        assert usage_limit_from_event(prose) is None, prose


def test_usage_limit_user_message_names_the_reset_in_utc():
    """The UI's usage-limit text: time only within 24 h of the reset, otherwise date and time (UTC)."""
    from datetime import datetime, timezone

    from domains.spawn_claude_code_agent.service import format_usage_limit_user_message

    now = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc).timestamp()
    soon = format_usage_limit_user_message(code_provider="claude", resets_at_iso="2026-10-20T16:50:00.000Z", now=now)
    assert soon == "Paused: Claude usage limit reached (resets 4:50 PM UTC). Work is saved.", soon
    later = format_usage_limit_user_message(code_provider="codex", resets_at_iso="2026-10-23T00:50:00Z", now=now)
    assert later == "Paused: Codex usage limit reached (resets Oct 23, 12:50 AM UTC). Work is saved.", later
    unknown = format_usage_limit_user_message(
        code_provider="claude", resets_at_iso=None, local_place=f"{_MAC_FOLDER} on {_MAC}", now=now
    )
    assert unknown == f"Paused: Claude usage limit reached. Work stays in {_MAC_FOLDER} on {_MAC}.", unknown


def test_usage_limit_parent_message_without_a_free_account_names_the_earliest_reset():
    """No account free: the error names the earliest reset; an unknown outlook claims nothing."""
    from domains.spawn_claude_code_agent.service import format_usage_limit_message

    facts = {"code_session_id": "cs-1", "branch": "rose/a-1"}
    blocked = format_usage_limit_message(
        code_provider="codex",
        resets_at_iso="2026-10-20T18:00:00.000Z",
        facts=facts,
        accounts=[{"provider": "codex", "label": "Codex account 1", "status": "limited",
                   "limited_until": "2026-10-20T18:00:00.000Z", "this_run": False},
                  {"provider": "claude", "label": "me@example.com", "status": "reconnect",
                   "limited_until": None, "this_run": False}],
        next_lease={"provider": "codex", "label": "Codex account 1", "available_now": False,
                    "available_at": "2026-10-20T18:00:00.000Z"},
    )
    assert blocked == (
        "Code agent stopped: the Codex usage limit was reached (resets 2026-10-20T18:00:00.000Z). "
        "Its work is saved on branch rose/a-1.\nConnected accounts:\n"
        "- Codex Codex account 1: limited until 2026-10-20T18:00:00.000Z\n"
        "- Claude Code me@example.com: disconnected (the user must reconnect it)\n"
        "Respawn with spawn_agent(type='code', code_session_id='cs-1', goal=<the same goal>) to continue: "
        "no account is free until 2026-10-20T18:00:00.000Z (the earliest reset: Codex Codex account 1); "
        "a respawn after that leases it and resumes from the latest checkpoint."
    ), blocked
    unknown = format_usage_limit_message(code_provider="claude", resets_at_iso=None, facts=facts)
    assert unknown == (
        "Code agent stopped: the Claude Code usage limit was reached. Its work is saved on branch rose/a-1.\n"
        "Respawn with spawn_agent(type='code', code_session_id='cs-1', goal=<the same goal>) to continue: "
        "the respawn leases an account that is not rate-limited and resumes from the latest checkpoint."
    ), unknown
    shared = format_usage_limit_message(
        code_provider="claude", resets_at_iso=None, facts=facts, accounts=[],
        next_lease={"provider": "claude", "label": None, "available_now": True, "available_at": None},
    )
    assert "\nConnected accounts: none.\n" in shared and "(now a shared Claude Code account)" in shared, shared


async def test_failed_attempt_retry_keeps_state_and_code_session_id():
    """C2: an attempt fails after writing an uncommitted file; the Temporal retry resumes it.

    The failing attempt closes with reason "failure" (checkpoint + pause), the
    retry discards the unreachable sandbox record but keeps the code_session_id
    and lease owner from the heartbeat, and the resumed CLI finds the file.
    """
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    session_home = _SessionHome(extra_env={"STUB_MODE": "finish"})
    backend = _Backend(session_home, fail_first_persist=True)
    # Phase 1 writes the file through the idle-mode CLI path; finish mode
    # completes the first run immediately, so write the uncommitted file the
    # way the first run's tools would have.
    (session_home.home / "notes.txt").write_text("uncommitted work\n")
    try:
        with backend.patched():
            beats: list = []
            first_env = ActivityEnvironment()
            first_env.on_heartbeat = lambda *details: beats.append(details)
            try:
                await asyncio.wait_for(first_env.run(service.spawn_claude_code_activity, *_activity_args()), 30)
                raise AssertionError("the first attempt must fail")
            except RuntimeError as error:
                assert "transcript store unavailable" in str(error), error
            assert [call.get("reason") for call in backend.closed] == ["failure"], backend.closed
            carried = [
                detail
                for beat in beats
                for detail in beat[1:]
                if isinstance(detail, dict) and isinstance(detail.get("code_session"), dict)
            ]
            assert carried and carried[-1]["code_session"]["code_session_id"], beats[-3:]

            retry = ActivityEnvironment()
            retry.info = dataclasses.replace(retry.info, attempt=2, heartbeat_details=list(beats[-1]))
            outcome = await asyncio.wait_for(retry.run(service.spawn_claude_code_activity, *_activity_args()), 30)
        assert outcome["status"] == "completed" and outcome["success"] is True, outcome
        assert len(backend.created) == 2, backend.created
        assert backend.created[1]["code_session_id"] == "6c1d6f1e-0000-4000-8000-00000000c0de", backend.created[1]
        assert backend.created[0]["lease_owner"] == backend.created[1]["lease_owner"] == "tool:agent-code:tc-code"
        texts = [e.get("text") for e in backend.verified_events[-1] if e.get("type") == "agent_message"]
        assert "notes: uncommitted work" in texts, texts
    finally:
        session_home.cleanup()


async def test_tool_result_reports_branch_and_merged_only_when_confirmed():
    """C4 + C13: every result reports the branch; merged=yes only when GitHub confirmed it."""
    from domains.spawn_claude_code_agent import service

    spawn = service._spawn_code_session_facts(
        {"code_session_id": "cs-1", "branch": "rose/a--b-123456", "merge_target": "rose/a", "resumed_from": "new"}
    )
    open_pr = {
        "code_session": {
            "code_session_id": "cs-1", "state": "PAUSED", "checkpoint_seq": 3, "branch": "rose/a--b-123456",
            "merge_target": "rose/a", "repo": {"head": "b" * 40, "dirtyFiles": 0, "files": []},
            "merge": {"head": "b" * 40, "local_commits": 0, "pushed": True,
                      "pr": {"number": 7, "state": "open", "url": "https://github.com/o/r/pull/7", "merged": False},
                      "merged": False, "merge_target_contains_head": False},
        }
    }
    facts = service._merge_close_code_session_facts(spawn, open_pr)
    text = service.format_code_session_summary(facts)
    assert "Branch: rose/a--b-123456 (merges into rose/a)" in text, text
    assert "PR: #7 open" in text and "Merged: no" in text, text
    meta = service.build_code_agent_metadata(task_id="t", provider="claude", state="completed", started_at=0, facts=facts)
    assert meta["branch"] == "rose/a--b-123456" and "merged_into" not in meta["summary"], meta
    assert meta["base_branch"] == "rose/a", meta

    merged = json.loads(json.dumps(open_pr))
    merged["code_session"]["merge"].update(
        {"merged": True, "merge_target_contains_head": True, "pr": {**open_pr["code_session"]["merge"]["pr"], "merged": True}}
    )
    facts = service._merge_close_code_session_facts(spawn, merged)
    assert "Merged: yes" in service.format_code_session_summary(facts)
    meta = service.build_code_agent_metadata(task_id="t", provider="claude", state="completed", started_at=0, facts=facts)
    assert meta["summary"]["merged_into"] == "rose/a", meta
    assert meta["state"] == "completed" and meta["target"] == "cloud" and meta["started_at"].endswith("Z"), meta
    assert "failure_message" not in meta, meta
    failed = service.build_code_agent_metadata(
        task_id="t", provider="codex", state="failed", started_at=0, ended_at=5, failure_message="sandbox lost"
    )
    assert failed["failure_message"] == "sandbox lost" and failed["provider"] == "codex", failed
    assert failed["ended_at"].endswith("Z") and "summary" not in failed, failed


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def _origin_with_parent_branch(root: Path) -> tuple[Path, str, str]:
    """A bare 'GitHub' repo with main and a pushed parent branch rose/parent-aaaa."""
    origin = root / "github" / "rose-test" / "repo.git"
    seed = root / "seed"
    origin.parent.mkdir(parents=True)
    _git(root, "init", "-q", "--bare", "-b", "main", str(origin))
    _git(root, "init", "-q", "-b", "main", str(seed))
    for key, value in (("user.name", "t"), ("user.email", "t@example.com")):
        _git(seed, "config", key, value)
    (seed / "README.md").write_text("main\n")
    _git(seed, "add", "-A")
    _git(seed, "commit", "-q", "-m", "main")
    main_sha = _git(seed, "rev-parse", "HEAD")
    _git(seed, "checkout", "-q", "-b", "rose/parent-aaaa")
    (seed / "parent.txt").write_text("parent work\n")
    _git(seed, "add", "-A")
    _git(seed, "commit", "-q", "-m", "parent")
    parent_sha = _git(seed, "rev-parse", "HEAD")
    _git(seed, "remote", "add", "origin", str(origin))
    _git(seed, "push", "-q", "origin", "main", "rose/parent-aaaa")
    _git(origin, "symbolic-ref", "HEAD", "refs/heads/main")
    return origin, main_sha, parent_sha


async def test_ws_server_checks_out_the_code_session_branch():
    """C13: root branch cut from the default; sub-agent branch cut from the parent's.

    The real ws-server clones "https://github.com/rose-test/repo" (rewritten to
    a local bare repo), prepares CODE_AGENT_BRANCH before the CLI starts, and
    reports it as a code_session_branch event. A base that is not on the
    remote is reported, never silently replaced.
    """
    root = Path(tempfile.mkdtemp(prefix="code-branch-"))
    homes: list[_SessionHome] = []
    try:
        _origin, main_sha, parent_sha = _origin_with_parent_branch(root)
        git_config = f'[url "file://{root}/github/"]\n\tinsteadOf = https://github.com/\n'
        cases = [
            ({"CODE_AGENT_BRANCH": "rose/child-bbbb", "CODE_AGENT_BASE_BRANCH": ""}, "rose/child-bbbb", main_sha),
            (
                {"CODE_AGENT_BRANCH": "rose/parent-aaaa--speed-cccc", "CODE_AGENT_BASE_BRANCH": "rose/parent-aaaa",
                 "CODE_AGENT_MERGE_TARGET": "rose/parent-aaaa"},
                "rose/parent-aaaa--speed-cccc",
                parent_sha,
            ),
            # Resume of a pushed branch: the existing remote branch wins over its base.
            ({"CODE_AGENT_BRANCH": "rose/parent-aaaa", "CODE_AGENT_BASE_BRANCH": "main"}, "rose/parent-aaaa", parent_sha),
        ]
        for env, branch, head in cases:
            session_home = _SessionHome(extra_env={"STUB_MODE": "finish"}, git_config=git_config)
            homes.append(session_home)
            await session_home.start(GITHUB_REPO_URL="https://github.com/rose-test/repo.git", **env)
            await _wait_until(lambda h=session_home: h.runs(), f"the CLI on {branch}")
            run = session_home.runs()[-1]
            assert run["cwd"].endswith("/workspace"), run
            assert (run["branch"], run["head"]) == (branch, head), (env, run, session_home.log()[-2000:])
            assert "Code session branch prepared" in session_home.log(), session_home.log()[-2000:]
            session_home.pause()

        missing = _SessionHome(extra_env={"STUB_MODE": "finish"}, git_config=git_config)
        homes.append(missing)
        await missing.start(
            GITHUB_REPO_URL="https://github.com/rose-test/repo.git",
            CODE_AGENT_BRANCH="rose/orphan--x-dddd",
            CODE_AGENT_BASE_BRANCH="rose/never-pushed",
        )
        await _wait_until(lambda: missing.runs(), "the CLI with a missing base")
        assert "base branch rose/never-pushed is not on the remote" in missing.log(), missing.log()[-2000:]
        assert missing.runs()[-1]["branch"] == "main", missing.runs()
    finally:
        for session_home in homes:
            session_home.cleanup()
        shutil.rmtree(root, ignore_errors=True)


async def test_preview_url_rides_every_code_agent_block():
    """A1: the create response's preview_url is on every chip message and the result's code_agent."""
    from domains.spawn_claude_code_agent import service

    async def run(create_response):
        saved = []

        async def fake_save(**kwargs):
            saved.append(kwargs)

        collector = AsyncMock()
        with (
            patch.object(service, "SandboxLogCollector", lambda *a, **kw: collector),
            patch.object(service, "create_e2b_session", AsyncMock(return_value=create_response)),
            patch.object(service, "save_claude_code_message", side_effect=fake_save),
            patch.object(service, "_run_agentic_loop", AsyncMock(return_value=(0, False, [], 0, 0, []))),
            patch.object(service, "_run_verifier", AsyncMock(return_value=(1.0, "ok", {"answer": "x"}, 0, 0))),
            patch.object(service, "persist_terminal_output", AsyncMock()),
            patch.object(service, "close_e2b_session", AsyncMock(return_value={"output_files": []})),
            patch.object(service, "_resolve_claude_token_for_activity", AsyncMock(return_value=None)),
            patch("helpers.model_pricing.get_model_pricing_with_fallback", AsyncMock(return_value={})),
            patch("temporalio.activity.heartbeat"),
        ):
            result = await service.spawn_claude_code_activity(
                user_id="u", agent_id="a", goal="edit the header", tool_call_id="tc", output_schema=_SCHEMA
            )
        return saved, result

    base = {"task_id": "t-1", "sandbox_id": "sbx1", "ws_url": "wss://3000-sbx1.e2b.app", "uploaded_files": []}
    url = "https://5173-sbx1.e2b.app/"
    saved, result = await run({**base, "preview_url": url})
    blocks = [s["code_agent"] for s in saved if s.get("code_agent")]
    assert blocks and all(block.get("preview_url") == url for block in blocks), blocks
    assert result["code_agent"]["preview_url"] == url, result["code_agent"]
    saved, result = await run({**base, "preview_url": None})
    assert all("preview_url" not in (s.get("code_agent") or {}) for s in saved), saved
    assert "preview_url" not in result["code_agent"], result["code_agent"]


async def _run_all_tests():
    print("code-sessions blackbox tests:")
    r = BlackboxResult()
    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    await r.record_async(
        "idle_past_every_old_limit_paused_then_resumes",
        test_idle_past_every_old_limit_is_paused_not_failed_then_resumes,
    )
    await r.record_async(
        "question_to_blocked_spawner_pauses_session",
        test_question_to_blocked_spawner_pauses_session_and_returns_it,
    )
    await r.record_async(
        "question_while_cli_waits_handed_over_before_idle",
        test_question_while_cli_waits_for_its_answer_is_handed_over_before_idle,
    )
    await r.record_async(
        "cancelled_spawner_unblocks_waiting_child",
        test_cancelled_spawner_unblocks_a_child_waiting_for_its_answer,
    )
    await r.record_async("failed_attempt_retry_keeps_state", test_failed_attempt_retry_keeps_state_and_code_session_id)
    await r.record_async(
        "usage_limit_saves_session_and_retry_leases_next",
        test_usage_limit_saves_session_and_retry_leases_next_credential,
    )
    await r.record_async(
        "usage_limit_retry_switches_provider",
        test_usage_limit_retry_switches_provider_when_pool_is_exhausted,
    )
    r.record("usage_limit_detection_structured_only", test_usage_limit_detection_reads_structured_events_only)
    r.record("usage_limit_user_message_names_reset_utc", test_usage_limit_user_message_names_the_reset_in_utc)
    r.record(
        "usage_limit_parent_message_names_earliest_reset",
        test_usage_limit_parent_message_without_a_free_account_names_the_earliest_reset,
    )
    await r.record_async("local_session_idle_pauses_in_mac_folder", test_local_session_idle_pauses_in_the_mac_folder)
    await r.record_async(
        "local_usage_limit_retries_on_the_mac",
        test_local_usage_limit_retries_on_the_mac_with_the_other_login,
    )
    await r.record_async("tool_result_reports_branch_and_merge", test_tool_result_reports_branch_and_merged_only_when_confirmed)
    await r.record_async("ws_server_checks_out_session_branch", test_ws_server_checks_out_the_code_session_branch)
    await r.record_async("preview_url_rides_every_code_agent_block", test_preview_url_rides_every_code_agent_block)
    teardown_mock()
    return r.all_passed


async def run_all_tests():
    with patch.dict(os.environ, {"ROSE_DISABLE_CODE_AGENT_VERIFIER": "0"}):
        return await _run_all_tests()
