"""Blackbox tests for persistent code sessions on the agents side.

Covers rose-builds-rose rows C1, C2, C4, C11, C13, C15 and C16 at the activity / sandbox
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

first_start_delay = float(os.environ.get("STUB_FIRST_START_DELAY_S", "0"))
if first_start_delay and not os.environ.get("CLAUDE_CODE_RESUME_SESSION_ID"):
    time.sleep(first_start_delay)

# stream-json input: the task prompt is the first JSON line; the ws-server
# keeps stdin open until every written turn has its result.
for line in sys.stdin:
    incoming = json.loads(line)
    if incoming.get("type") == "control_request":
        print(json.dumps({"type": "control_response", "response": {
            "request_id": incoming["request_id"], "subtype": "success", "response": {"models": []}
        }}), flush=True)
        continue
    break
else:
    sys.exit(0)
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
if resume is None and os.environ.get("STUB_MODE") == "billing":
    # Out of credits: the SDK marks the assistant message with error=billing_error.
    notes.write_text("uncommitted work\n")
    emit({"type": "assistant", "error": "billing_error", "message": {"content": [
        {"type": "text", "text": "Credit balance is too low"}]}})
    while True:
        time.sleep(0.1)
if resume is None and os.environ.get("STUB_MODE") == "login_unusable":
    # The Codex ws-server's structured unusable-login error (app-server.test.mjs
    # asserts this exact shape), carried through this stub as a CLI line.
    notes.write_text("uncommitted work\n")
    emit({"type": "codex_fixture", "event": {"type": "error", "provider": "codex",
          "message": "Your access token could not be refreshed: refresh_token_invalidated",
          "usage_limit": None, "login_unusable": {"reason": "oauth_refresh_invalid"}}})
    while True:
        time.sleep(0.1)
if resume is None and os.environ.get("STUB_MODE") == "auth_expired":
    # The sandbox's access token expired mid-run: the SDK marks the assistant
    # message error=authentication_failed and prints the non-interactive 401 banner.
    notes.write_text("uncommitted work\n")
    banner = ('Failed to authenticate. API Error: 401 {"type":"error","error":'
              '{"type":"authentication_error","message":"OAuth token has expired."}}')
    emit({"type": "assistant", "error": "authentication_failed", "message": {"content": [
        {"type": "text", "text": banner}]}})
    emit({"type": "result", "subtype": "success", "is_error": True, "result": banner, "usage": {}})
    while True:
        time.sleep(0.1)
if resume is None and os.environ.get("STUB_MODE") == "mentions_auth_text":
    # A healthy session whose own tool call, tool output and prose mention every
    # credential-failure string (e.g. an agent working on the Rose repo).
    mentions = ("authentication_error | Invalid authentication credentials | API Error: 401 | "
                "Please run /login | Not logged in | You've hit your limit | /rate-limit-options | "
                "Credit balance is too low | Credit balance too low | "
                "Add funds: https://platform.claude.com/settings/billing")
    # The live repro on 28a7bfc99 (local stack): this exact command aborted the
    # session non-retryably as CLAUDE_CODE_FATAL, and the parent retried into it.
    note = "debug note: our log viewer shows the literal text API Error: 401 and Please run /login in old entries"
    notes.write_text("uncommitted work\n")
    emit({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "toolu_e", "name": "Bash",
          "input": {"command": f"echo '{note}'"}}]}})
    emit({"type": "user", "tool_use_result": {"stdout": note + "\n", "stderr": ""},
          "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_e", "content": note}]}})
    emit({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "toolu_g", "name": "Bash",
          "input": {"command": 'grep -rn "API Error: 401\\|Please run /login" agents/'}}]}})
    emit({"type": "user", "tool_use_result": {"stdout": mentions, "stderr": ""},
          "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_g", "content": mentions}]}})
    emit({"type": "assistant", "message": {"content": [{"type": "text", "text": f"Found: {mentions}"}]}})
if resume is None and os.environ.get("STUB_MODE") not in (
    "finish", "rate_limit", "billing", "login_unusable", "auth_expired", "mentions_auth_text"
):
    notes.write_text("uncommitted work\n")
    emit({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "sleep 99999"}}]}})
    (gate / "tool_started").touch()
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
                [node, str(_WS_SERVER)],
                cwd=self.home,
                env=full_env,
                stdout=log,
                stderr=subprocess.STDOUT,
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
        self,
        session_home: _SessionHome,
        *,
        fail_first_persist: bool = False,
        resize_after: int | None = None,
    ) -> None:
        self.session_home = session_home
        self.created: list[dict] = []
        self.closed: list[dict] = []
        self.messages: list[dict] = []
        self.keepalives = 0
        self.verified_events: list[list[dict]] = []
        self.fail_first_persist = fail_first_persist
        self._persists = 0
        self.credential_feedback: list = []
        self.usage_reports: list[tuple] = []
        # Credential availability the backend reports to each spawn (C15).
        self.availability: list[dict] = []
        self.availability_own_only: list[bool] = []
        self.availability_calls: list[dict] = []
        # The Claude credential the activity resolves (a secret; never in any output).
        self.claude_token: str | None = None
        # Shared credential paths the usage-limit answer reports (C15).
        self.paths: list[dict] | None = None
        self.local = False
        # What the usage-limit answer says a respawn leases (the backend's stored view).
        self.next_lease = dict(_SHARED_CLAUDE_LEASE)
        # Keepalive number after which the code agent's resize request is pending (C16).
        self.resize_after = resize_after
        self.resize_calls: list[tuple] = []
        self.resized_ws_url: str | None = None

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
        if self.resize_after is not None and len(self.created) == 1:
            # This fixture injects a CLI-originated request: the conversation
            # and its in-flight tool must exist before attachment can report it.
            await _wait_until(
                lambda: (self.session_home.tmp / "tool_started").exists(),
                "the initial CLI tool to start",
            )
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
                "repo": {
                    "head": "a" * 40,
                    "localCommits": 1,
                    "pushed": False,
                    "dirtyFiles": 1,
                    "files": [{"path": "notes.txt", "added": 1, "removed": 0}],
                },
                "merge": {
                    "head": "a" * 40,
                    "local_commits": 1,
                    "pushed": False,
                    "pr": None,
                    "merged": False,
                    "merge_target_contains_head": False,
                },
            },
        }

    async def save_message(self, **kwargs):
        self.messages.append(kwargs)

    async def persist_output(self, *args, **kwargs):
        self._persists += 1
        self.credential_feedback.append(kwargs.get("credential_feedback"))
        if self.fail_first_persist and self._persists == 1:
            raise RuntimeError("transcript store unavailable")

    async def keepalive(self, *args, **kwargs):
        self.keepalives += 1
        reply = {"alive": True, "code_session_id": "6c1d6f1e-0000-4000-8000-00000000c0de"}
        if self.resize_after is not None and self.keepalives >= self.resize_after and not self.resize_calls:
            reply["resize_requested"] = {
                "request_id": _RESIZE_REQUEST_ID,
                "from": {"cpu": 2, "memory_gb": 4},
                "to": {"cpu": 2, "memory_gb": 8},
            }
        return reply

    async def resize(self, task_id, request_id, code_provider="claude"):
        """The backend's resize: the held sandbox stops; a new one resumes the CLI with the resize turn."""
        self.resize_calls.append((task_id, request_id, code_provider))
        self.session_home.pause()
        self.resized_ws_url = await self.session_home.start(
            CLAUDE_CODE_RESUME_SESSION_ID=_CLI_SESSION_ID,
            CLAUDE_CODE_GOAL="Your environment was resized from 2 vCPU, 4 GB RAM to 2 vCPU, 8 GB RAM.",
        )
        return {
            "task_id": "task-resized",
            "sandbox_id": "sb-resized",
            "ws_url": self.resized_ws_url,
            "code_session_id": "6c1d6f1e-0000-4000-8000-00000000c0de",
            "sandbox_size": {"cpu": 2, "memory_gb": 8},
            "resized": True,
            "request": {
                "request_id": request_id,
                "status": "done",
                "from": {"cpu": 2, "memory_gb": 4},
                "to": {"cpu": 2, "memory_gb": 8},
                "reason": "jest workers OOM-killed at 4 GB",
            },
        }

    async def report_usage(self, task_id, code_provider, resets_at):
        self.usage_reports.append((task_id, code_provider, resets_at))
        return {
            "marked": f"{code_provider}_pool:tok-1",
            "resets_at": "2026-10-03T00:50:00.000Z" if resets_at is not None else None,
            "accounts": [dict(account) for account in _ACCOUNTS],
            **({"paths": [dict(path) for path in self.paths]} if self.paths is not None else {}),
            "next_lease": dict(self.next_lease),
        }

    async def credential_availability(self, user_id, own_only=False, code_session_id=None, prefer=None):
        self.availability_own_only.append(own_only)
        self.availability_calls.append({"code_session_id": code_session_id, "prefer": prefer})
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
            patch.object(service, "save_code_transcript_batch", AsyncMock(return_value=True)),
            patch.object(service, "keepalive_e2b_session", side_effect=self.keepalive),
            patch.object(service, "report_code_usage_limit", side_effect=self.report_usage),
            patch.object(service, "resize_e2b_session", side_effect=self.resize),
            patch.object(service, "fetch_code_credential_availability", side_effect=self.credential_availability),
            patch.object(service, "_run_verifier", side_effect=self.verifier),
            patch.object(service, "_log_code_agent_event", lambda event, **kw: None),
            patch.object(service, "REATTACH_PROBE_BACKOFF_S", 0.05),
            patch.object(service, "SandboxLogCollector", lambda *a, **kw: AsyncMock()),
            patch.object(service, "_resolve_claude_token_for_activity", AsyncMock(return_value=self.claude_token)),
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
    {
        "provider": "claude",
        "label": "me@example.com",
        "status": "limited",
        "limited_until": "2026-10-03T00:50:00.000Z",
        "this_run": True,
    },
    {
        "provider": "codex",
        "label": "codex@example.com",
        "status": "available",
        "limited_until": None,
        "this_run": False,
    },
]
_SHARED_CLAUDE_LEASE = {"provider": "claude", "label": None, "available_now": True, "available_at": None}
_CODEX_LEASE = {"provider": "codex", "label": "codex@example.com", "available_now": True, "available_at": None}
_ACCOUNT_LINES = (
    "Connected accounts:\n"
    "- Claude Code me@example.com: limited until 2026-10-03T00:50:00.000Z (this run)\n"
    "- Codex codex@example.com: available\n"
)

_MAC = "Andy's MacBook"
_RESIZE_REQUEST_ID = "7d2e3f40-0000-4000-8000-00000000c16a"
_MAC_FOLDER = "~/Developer/rose"


def _activity_args(
    *, code_session_request=None, tool_call_id="tc-code", local=False, code_provider="claude", gpt_token=None
) -> list:
    return [
        "user-code",
        "agent-code",
        "Write answer.txt with the answer",
        tool_call_id,
        _SCHEMA,
        None,
        "rose-labs/rose-1-flash",
        None,
        None,
        code_provider,
        gpt_token,
        None,
        None,
        None,
        False,
        None,
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
            try:
                await _wait_until(lambda: session_home.runs(), "the CLI to start")
                await _wait_until(lambda: backend.keepalives > 0, "the first attached-session keepalive")
                await asyncio.sleep(2.5)  # ~5000 virtual seconds with Bash in flight
                assert not first.done(), f"an in-flight tool must keep the session attached: {first.result()}"
                assert backend.closed == [], f"nothing may close a working session: {backend.closed}"
                assert backend.keepalives >= 5, f"attached sessions keep their sandbox alive: {backend.keepalives}"
                session_home.release("tool_done")
                paused = await asyncio.wait_for(first, timeout=30)
            finally:
                if not first.done():
                    first.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await first

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
                    *_activity_args(
                        code_session_request={"code_session_id": paused["code_session"]["code_session_id"]}
                    ),
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


async def test_cancelled_spawner_unblocks_a_child_waiting_for_its_answer():
    """L-A2A-ADV 10: the spawner is cancelled while its code agent waits for an answer.

    The child is idle waiting on its spawner; the user cancels the spawning agent (the workflow cancels the activity).
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


async def test_resize_request_moves_session_and_next_attempt_reattaches(*, first_start_delay_s: float = 0):
    """C16: the CLI's `rose env size` reaches the activity on a keepalive while a tool is in flight.

    The activity detaches (no close: the backend's resize owns the old sandbox),
    the backend moves the session into the new-size sandbox and resumes the CLI
    conversation there, an `environment_resized` row names the new task and size,
    and the attempt the workflow schedules next reattaches to that task (no
    second create) and completes on the resumed conversation.
    """
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service
    from domains.spawn_claude_code_agent.config import CODE_AGENT_DRAIN_YIELD_STATUS

    session_home = _SessionHome(extra_env={"STUB_FIRST_START_DELAY_S": str(first_start_delay_s)})
    backend = _Backend(session_home, resize_after=2)
    try:
        with backend.patched(clock=_virtual_clock(2000.0)):
            first = await asyncio.wait_for(
                ActivityEnvironment().run(service.spawn_claude_code_activity, *_activity_args()), timeout=30
            )
        assert first["status"] == CODE_AGENT_DRAIN_YIELD_STATUS, first
        assert first["yield_reason"] == "environment_resize", first
        moved = first["code_session"]
        assert moved["task_id"] == "task-resized" and moved["ws_url"] == backend.resized_ws_url, moved
        assert moved["sandbox_size"] == {"cpu": 2, "memory_gb": 8}, moved
        assert moved["code_session_id"] == "6c1d6f1e-0000-4000-8000-00000000c0de", moved
        assert backend.resize_calls == [("task-1", _RESIZE_REQUEST_ID, "claude")], backend.resize_calls
        assert backend.closed == [], f"the backend's resize owns the old sandbox: {backend.closed}"
        rows = [m for m in backend.messages if m.get("action_type") == "environment_resized"]
        assert len(rows) == 1, backend.messages
        row = rows[0]
        assert row["task_id"] == "task-resized" and row["ws_url"] == backend.resized_ws_url, row
        assert row["title"] == "Environment resized to 2 vCPU, 8 GB RAM", row["title"]
        assert row["code_agent"]["sandbox_size"] == {"cpu": 2, "memory_gb": 8}, row["code_agent"]
        resize_meta = row["code_agent"]["environment_resize"]
        assert resize_meta["from_task_id"] == "task-1" and resize_meta["status"] == "done", resize_meta
        assert resize_meta["to"] == {"cpu": 2, "memory_gb": 8}, resize_meta
        await _wait_until(lambda: len(session_home.runs()) >= 2, "the resumed CLI to start")
        resumed_run = session_home.runs()[-1]
        assert "--resume" in resumed_run["argv"], resumed_run
        assert resumed_run["argv"][resumed_run["argv"].index("--resume") + 1] == _CLI_SESSION_ID, resumed_run

        args = _activity_args()
        args[15] = moved  # what the workflow schedules after a yield
        with backend.patched():
            second = await asyncio.wait_for(
                ActivityEnvironment().run(service.spawn_claude_code_activity, *args), timeout=30
            )
        assert second["status"] == "completed" and second["success"] is True, second
        assert len(backend.created) == 1, f"the next attempt reattaches, it does not create: {backend.created}"
        assert [call.get("task_id") for call in backend.closed] == ["task-resized"], backend.closed
        assert second["code_agent"]["sandbox_size"] == {"cpu": 2, "memory_gb": 8}, second["code_agent"]
        texts = [e.get("text") for e in backend.verified_events[-1] if e.get("type") == "agent_message"]
        assert "notes: uncommitted work" in texts, f"the resumed session keeps its files: {texts}"
    finally:
        session_home.cleanup()


async def test_resize_request_waits_for_initial_cli_tool_start():
    """A CLI-originated resize cannot precede its conversation and in-flight tool."""
    await test_resize_request_moves_session_and_next_attempt_reattaches(first_start_delay_s=2.2)


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
            "(checkpoint 1); the sandbox is paused, not killed.\n"
            + _ACCOUNT_LINES
            + f"Retry with spawn_agent(type='code', code_session_id='{session_id}', "
            "goal=<the same goal>) to continue: the retry leases an account that is not rate-limited "
            "(now a shared Claude Code account), resumes the paused sandbox and continues the same "
            "Claude Code conversation."
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
            run = asyncio.create_task(
                ActivityEnvironment().run(service.spawn_claude_code_activity, *_activity_args(local=True))
            )
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
            "local",
            _MAC,
            _MAC_FOLDER,
            "paused",
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

    rejected = {
        "type": "cli_message",
        "raw_type": "rate_limit_event",
        "cli_message": {
            "type": "rate_limit_event",
            "rate_limit_info": {"status": "rejected", "resetsAt": 5, "rateLimitType": "five_hour"},
        },
    }
    assert usage_limit_from_event(rejected) == {"provider": "claude", "resets_at": 5, "limit_type": "five_hour"}
    warning = json.loads(json.dumps(rejected))
    warning["cli_message"]["rate_limit_info"]["status"] = "allowed_warning"
    assert usage_limit_from_event(warning) is None
    codex = {
        "provider": "codex",
        "type": "error",
        "message": "x",
        "usage_limit": {"reached_type": "rate_limit_reached", "resets_at": 9},
    }
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
        accounts=[
            {
                "provider": "codex",
                "label": "Codex account 1",
                "status": "limited",
                "limited_until": "2026-10-20T18:00:00.000Z",
                "this_run": False,
            },
            {
                "provider": "claude",
                "label": "me@example.com",
                "status": "reconnect",
                "limited_until": None,
                "this_run": False,
            },
        ],
        next_lease={
            "provider": "codex",
            "label": "Codex account 1",
            "available_now": False,
            "available_at": "2026-10-20T18:00:00.000Z",
        },
    )
    assert blocked == (
        "Code agent stopped: the Codex usage limit was reached (resets 2026-10-20T18:00:00.000Z). "
        "Its work is saved on branch rose/a-1; the sandbox is paused, not killed.\nConnected accounts:\n"
        "- Codex Codex account 1: limited until 2026-10-20T18:00:00.000Z\n"
        "- Claude Code me@example.com: disconnected (the user must reconnect it)\n"
        "Retry with spawn_agent(type='code', code_session_id='cs-1', goal=<the same goal>) to continue: "
        "no credential is free until 2026-10-20T18:00:00.000Z (the earliest reset: Codex Codex account 1); "
        "a retry before that stays paused and starts nothing, so wait with wait_for(until_timestamp=<that time>) first."
    ), blocked
    unknown = format_usage_limit_message(code_provider="claude", resets_at_iso=None, facts=facts)
    assert unknown == (
        "Code agent stopped: the Claude Code usage limit was reached. Its work is saved on branch rose/a-1; "
        "the sandbox is paused, not killed.\n"
        "Retry with spawn_agent(type='code', code_session_id='cs-1', goal=<the same goal>) to continue: "
        "the retry leases an account that is not rate-limited and resumes the paused session."
    ), unknown
    shared = format_usage_limit_message(
        code_provider="claude",
        resets_at_iso=None,
        facts=facts,
        accounts=[],
        next_lease={"provider": "claude", "label": None, "available_now": True, "available_at": None},
    )
    assert "\nConnected accounts: none.\n" in shared and "(now a shared Claude Code account)" in shared, shared


async def test_failed_attempt_retry_keeps_state_and_code_session_id():
    """C2: an attempt fails after writing an uncommitted file; the Temporal retry resumes it.

    A retryable failure leaves the sandbox live (no close) and carries the
    session (code_session_id, lease owner) on its heartbeat; the retry
    reattaches to the same sandbox and the CLI still finds the file.
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
            # A retryable error leaves the live sandbox for the retry to reattach
            # (2026-11-04-code-agent-retryable-error-closed-live-sandbox); only a
            # final error checkpoints and pauses it.
            assert backend.closed == [], backend.closed
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
        # The retry reattached to the still-live sandbox: no second create.
        assert len(backend.created) == 1, backend.created
        assert backend.created[0]["lease_owner"] == "tool:agent-code:tc-code", backend.created[0]
        assert outcome["code_session"]["code_session_id"] == carried[-1]["code_session"]["code_session_id"], outcome
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
            "code_session_id": "cs-1",
            "state": "PAUSED",
            "checkpoint_seq": 3,
            "branch": "rose/a--b-123456",
            "merge_target": "rose/a",
            "repo": {"head": "b" * 40, "dirtyFiles": 0, "files": []},
            "merge": {
                "head": "b" * 40,
                "local_commits": 0,
                "pushed": True,
                "pr": {"number": 7, "state": "open", "url": "https://github.com/o/r/pull/7", "merged": False},
                "merged": False,
                "merge_target_contains_head": False,
            },
        }
    }
    facts = service._merge_close_code_session_facts(spawn, open_pr)
    text = service.format_code_session_summary(facts)
    assert "Branch: rose/a--b-123456 (merges into rose/a)" in text, text
    assert "PR: #7 open" in text and "Merged: no" in text, text
    meta = service.build_code_agent_metadata(
        task_id="t", provider="claude", state="completed", started_at=0, facts=facts
    )
    assert meta["branch"] == "rose/a--b-123456" and "merged_into" not in meta["summary"], meta
    assert meta["base_branch"] == "rose/a", meta

    merged = json.loads(json.dumps(open_pr))
    merged["code_session"]["merge"].update(
        {
            "merged": True,
            "merge_target_contains_head": True,
            "pr": {**open_pr["code_session"]["merge"]["pr"], "merged": True},
        }
    )
    facts = service._merge_close_code_session_facts(spawn, merged)
    assert "Merged: yes" in service.format_code_session_summary(facts)
    meta = service.build_code_agent_metadata(
        task_id="t", provider="claude", state="completed", started_at=0, facts=facts
    )
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
                {
                    "CODE_AGENT_BRANCH": "rose/parent-aaaa--speed-cccc",
                    "CODE_AGENT_BASE_BRANCH": "rose/parent-aaaa",
                    "CODE_AGENT_MERGE_TARGET": "rose/parent-aaaa",
                },
                "rose/parent-aaaa--speed-cccc",
                parent_sha,
            ),
            # Resume of a pushed branch: the existing remote branch wins over its base.
            (
                {"CODE_AGENT_BRANCH": "rose/parent-aaaa", "CODE_AGENT_BASE_BRANCH": "main"},
                "rose/parent-aaaa",
                parent_sha,
            ),
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


# ── C15 credential rotation end to end: one case per branch (a)–(g) ──────────
#
#   spawn ─► CLI hits a structured limit (rate_limit_event rejected / billing_error)
#     └─► close(reason=usage_limit): checkpoint + pause (sandbox kept) ─► report ─► tool error
#   retry(code_session_id) ─► availability(code_session_id, prefer)
#     ├─ same provider leasable ──► create(same session) ─► paused sandbox, `--resume <cli id>`  (b)
#     ├─ only the other provider ─► create(provider switch) ─► backend handoff + trajectory     (c)
#     └─ nothing leasable ────────► no create, session stays paused, earliest reset            (d)
#   root resume(code_session_id) ─► the session's own provider first                          (e)
#   duplicate concurrent retry ─► backend lease / conditional switch (code-session-usage-limit) (f)
#   secrets never reach a result, a message, a log or the sandbox ws-server log                (g)

_SESSION_ID = "6c1d6f1e-0000-4000-8000-00000000c0de"
_SHARED_PATHS = [
    {
        "provider": "claude",
        "kind": "pool",
        "label": "shared Claude Code subscriptions",
        "status": "available",
        "limited_until": None,
        "available_count": 2,
        "total_count": 3,
    },
    {
        "provider": "codex",
        "kind": "pool",
        "label": "shared Codex subscriptions",
        "status": "unconfigured",
        "limited_until": None,
        "available_count": 0,
        "total_count": 0,
    },
    {
        "provider": "claude",
        "kind": "funded",
        "label": "funded Anthropic API key",
        "status": "limited",
        "limited_until": "2026-10-03T01:20:00.000Z",
    },
    {
        "provider": "codex",
        "kind": "funded",
        "label": "funded Azure OpenAI deployment",
        "status": "available",
        "limited_until": None,
    },
]
_PATH_LINES = (
    "Shared credential paths:\n"
    "- shared Claude Code subscriptions: 2 of 3 available\n"
    "- shared Codex subscriptions: none connected\n"
    "- funded Anthropic API key: limited until 2026-10-03T01:20:00.000Z\n"
    "- funded Azure OpenAI deployment: available\n"
)
_SECRET_GPT = "sk-proj-SENTINEL-gpt-7f3a9c"
_SECRET_CLAUDE = "sk-ant-oat01-SENTINEL-claude-7f3a9c"


async def _rotation(
    *,
    retry_availability: dict,
    next_lease: dict,
    stub_mode: str = "rate_limit",
    secrets: bool = False,
):
    """First spawn hits the limit; the retry passes the reported code_session_id."""
    from structlog.testing import capture_logs
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    session_home = _SessionHome(extra_env={"STUB_MODE": stub_mode})
    backend = _Backend(session_home)
    backend.paths = [dict(path) for path in _SHARED_PATHS]
    backend.next_lease = dict(next_lease)
    backend.availability = [{"claude": True, "codex": True}, retry_availability]
    gpt_token = _SECRET_GPT if secrets else None
    if secrets:
        backend.claude_token = _SECRET_CLAUDE
    with capture_logs() as logs, backend.patched():
        first = await asyncio.wait_for(
            ActivityEnvironment().run(service.spawn_claude_code_activity, *_activity_args(gpt_token=gpt_token)),
            timeout=30,
        )
        retry = await asyncio.wait_for(
            ActivityEnvironment().run(
                service.spawn_claude_code_activity,
                *_activity_args(
                    code_session_request={"code_session_id": (first.get("retry") or {}).get("code_session_id")},
                    tool_call_id="tc-retry",
                    gpt_token=gpt_token,
                ),
            ),
            timeout=30,
        )
    return first, retry, backend, session_home, logs


def _retry_line(clause: str) -> str:
    return (
        f"Retry with spawn_agent(type='code', code_session_id='{_SESSION_ID}', goal=<the same goal>) "
        f"to continue: {clause}"
    )


async def test_rotation_a_exhaustion_pauses_sandbox_and_lists_every_path():
    """(a) A usage limit → truthful tool error, sandbox paused (not killed), retry text with every path.

    Also (g): the leased Claude token and the workflow's GPT token never reach
    the tool result, any saved message, a log record or the sandbox log.
    """
    first, retry, backend, session_home, logs = await _rotation(
        retry_availability={"claude": True, "codex": True, "session_provider": "claude"},
        next_lease=_SHARED_CLAUDE_LEASE,
        secrets=True,
    )
    try:
        assert first["status"] == "usage_limit" and first["success"] is False and first["retryable"] is True, first
        assert first["retry"] == {"tool": "spawn_agent", "type": "code", "code_session_id": _SESSION_ID}, first
        assert [call.get("reason") for call in backend.closed][0] == "usage_limit", backend.closed
        assert backend.usage_reports == [("task-1", "claude", 1790988600)], backend.usage_reports
        assert first["message"] == (
            "Code agent stopped: the Claude Code usage limit was reached on me@example.com "
            "(resets 2026-10-03T00:50:00.000Z). Its work is saved on branch rose/write-answer-0a1b2c3d "
            "(checkpoint 1); the sandbox is paused, not killed.\n"
            + _ACCOUNT_LINES
            + _PATH_LINES
            + _retry_line(
                "the retry leases an account that is not rate-limited (now a shared Claude Code account), "
                "resumes the paused sandbox and continues the same Claude Code conversation."
            )
        ), first["message"]
        assert first["usage_limit"]["paths"] == _SHARED_PATHS, first["usage_limit"]
        assert first["code_agent"]["state"] == "paused", first["code_agent"]
        assert retry["status"] == "completed", retry

        # (g) no secret anywhere the model, the user or an operator can read.
        assert any("usage limit" in str(entry.get("event", "")).lower() for entry in logs), "logs were not captured"
        surfaces = {
            "results": json.dumps([first, retry], default=str),
            "messages": json.dumps(backend.messages, default=str),
            "creates": json.dumps(backend.created, default=str),
            "logs": json.dumps(logs, default=str),
            "sandbox log": session_home.log(),
        }
        for name, text in surfaces.items():
            for secret in (_SECRET_GPT, _SECRET_CLAUDE):
                assert secret not in text, f"{name} leaks a credential"
    finally:
        session_home.cleanup()


async def test_rotation_a_out_of_credits_is_a_usage_limit_not_a_crash():
    """(a) Out of credits (the SDK's structured billing_error): same paused, retryable result, never fatal."""
    first, retry, backend, session_home, _ = await _rotation(
        retry_availability={"claude": True, "codex": True, "session_provider": "claude"},
        next_lease=_SHARED_CLAUDE_LEASE,
        stub_mode="billing",
    )
    try:
        assert first["status"] == "usage_limit" and first["retryable"] is True, first
        assert first["usage_limit"]["limit_type"] == "billing", first["usage_limit"]
        assert backend.usage_reports == [("task-1", "claude", None)], backend.usage_reports
        assert [call.get("reason") for call in backend.closed][0] == "usage_limit", backend.closed
        assert first["message"].startswith(
            "Code agent stopped: the Claude Code credential me@example.com ran out of credits. Its work is saved "
            "on branch rose/write-answer-0a1b2c3d (checkpoint 1); the sandbox is paused, not killed.\n"
        ), first["message"]
        assert retry["status"] == "completed", retry
    finally:
        session_home.cleanup()


async def test_rotation_b_same_provider_retry_resumes_natively_in_the_same_sandbox():
    """(b) A same-provider credential left → same session, same sandbox, `claude --resume <cli id>`."""
    first, retry, backend, session_home, _ = await _rotation(
        retry_availability={"claude": True, "codex": True, "session_provider": "claude"},
        next_lease=_SHARED_CLAUDE_LEASE,
    )
    try:
        assert backend.availability_calls[1] == {"code_session_id": _SESSION_ID, "prefer": "claude"}, (
            "the retry asks for the credentials of the session it resumes",
            backend.availability_calls,
        )
        assert backend.created[1]["code_session_id"] == _SESSION_ID, backend.created[1]
        assert backend.created[1]["code_provider"] == "claude", backend.created[1]
        runs = session_home.runs()
        assert len(runs) == 2 and "--resume" in runs[1]["argv"], runs
        assert runs[1]["argv"][runs[1]["argv"].index("--resume") + 1] == _CLI_SESSION_ID, runs[1]
        assert runs[0]["cwd"] == runs[1]["cwd"], "the same sandbox HOME continues"
        assert retry["status"] == "completed" and retry["code_provider"] == "claude", retry
        texts = [e.get("text") for e in backend.verified_events[-1] if e.get("type") == "agent_message"]
        assert "notes: uncommitted work" in texts, texts
    finally:
        session_home.cleanup()


async def test_rotation_c_only_other_provider_switches_with_a_handoff():
    """(c) No Claude credential left, Codex is → the retry continues the same session on Codex.

    The backend half (handoff prompt with the trajectory path, the file in the
    new sandbox) is asserted in the code-session-usage-limit backend blackbox.
    """
    first, retry, backend, session_home, _ = await _rotation(
        retry_availability={"claude": False, "codex": True, "session_provider": "claude"},
        next_lease=_CODEX_LEASE,
    )
    try:
        assert first["message"].endswith(
            _retry_line(
                "no Claude Code credential is left, so the retry continues this session on Codex "
                "(now Codex codex@example.com) from the latest checkpoint, with a handoff prompt that points it "
                "at the previous agent's trajectory."
            )
        ), first["message"]
        assert backend.created[1]["code_provider"] == "codex", backend.created[1]
        assert backend.created[1]["code_session_id"] == _SESSION_ID, backend.created[1]
        assert retry["code_provider"] == "codex" and retry["status"] == "completed", retry
    finally:
        session_home.cleanup()


async def test_rotation_h_another_providers_subscription_beats_the_funded_key():
    """(h) Subscriptions first (C15): the Claude subscriptions are limited, the funded Anthropic
    key and a Codex subscription are both left → the retry continues on the Codex subscription
    with the handoff, as the backend's next_credential says (not on the funded key, which the
    old "same provider while it has any credential" choice took)."""
    first, retry, backend, session_home, _ = await _rotation(
        retry_availability={
            "claude": True,
            "codex": True,
            "session_provider": "claude",
            "next_credential": {"provider": "codex", "tier": "subscription"},
        },
        next_lease={**_CODEX_LEASE, "kind": "own"},
    )
    try:
        assert first["message"].endswith(
            _retry_line(
                "no Claude Code subscription is left, so the retry continues this session on Codex "
                "(now Codex codex@example.com) from the latest checkpoint, with a handoff prompt that points it "
                "at the previous agent's trajectory."
            )
        ), first["message"]
        assert backend.created[1]["code_provider"] == "codex", backend.created[1]
        assert backend.created[1]["code_session_id"] == _SESSION_ID, backend.created[1]
        assert retry["code_provider"] == "codex" and retry["status"] == "completed", retry
    finally:
        session_home.cleanup()


async def test_rotation_i_only_the_funded_key_left_resumes_the_same_provider():
    """(i) Every subscription limited: the session's own funded key, same harness, native resume."""
    funded_lease = {
        "provider": "claude",
        "label": "funded Anthropic API key",
        "available_now": True,
        "available_at": None,
        "kind": "funded",
    }
    first, retry, backend, session_home, _ = await _rotation(
        retry_availability={
            "claude": True,
            "codex": True,
            "session_provider": "claude",
            "next_credential": {"provider": "claude", "tier": "funded"},
        },
        next_lease=funded_lease,
    )
    try:
        assert first["message"].endswith(
            _retry_line(
                "no Claude Code subscription is left, so the retry uses the funded Anthropic API key, resumes "
                "the paused sandbox and continues the same Claude Code conversation."
            )
        ), first["message"]
        assert backend.created[1]["code_provider"] == "claude", backend.created[1]
        runs = session_home.runs()
        assert len(runs) == 2 and "--resume" in runs[1]["argv"], runs
        assert retry["code_provider"] == "claude" and retry["status"] == "completed", retry
    finally:
        session_home.cleanup()


async def test_fresh_spawn_follows_the_backends_subscription_first_choice():
    """A fresh spawn asking for Claude takes a Codex subscription before the funded Anthropic key."""
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    session_home = _SessionHome(extra_env={"STUB_MODE": "finish"})
    backend = _Backend(session_home)
    backend.availability = [
        {"claude": True, "codex": True, "next_credential": {"provider": "codex", "tier": "subscription"}}
    ]
    try:
        with backend.patched():
            result = await asyncio.wait_for(
                ActivityEnvironment().run(service.spawn_claude_code_activity, *_activity_args(code_provider="claude")),
                timeout=30,
            )
        assert backend.availability_calls == [{"code_session_id": None, "prefer": "claude"}], backend.availability_calls
        assert backend.created[0]["code_provider"] == "codex", backend.created[0]
        assert result["code_provider"] == "codex" and result["status"] == "completed", result
    finally:
        session_home.cleanup()


def test_usage_limit_clause_names_a_funded_key_on_the_other_provider():
    """Every subscription and this provider's funded key gone: the other provider's funded key, named."""
    from domains.spawn_claude_code_agent.service import format_usage_limit_message

    message = format_usage_limit_message(
        code_provider="codex",
        resets_at_iso=None,
        facts={"code_session_id": "cs-1"},
        next_lease={
            "provider": "claude",
            "label": "funded Anthropic API key",
            "available_now": True,
            "available_at": None,
            "kind": "funded",
        },
    )
    assert message.endswith(
        "to continue: no Codex credential is left, so the retry continues this session on Claude Code "
        "(now the funded Anthropic API key) from the latest checkpoint, with a handoff prompt that points it "
        "at the previous agent's trajectory."
    ), message


def _codex_wire(event):
    """The Codex ws-server event a ``codex_fixture`` stub line carries; any other event unchanged."""
    if event.get("type") == "cli_message" and event.get("raw_type") == "codex_fixture":
        return event["cli_message"]["event"]
    return event


@contextlib.contextmanager
def _codex_events():
    """Read ``codex_fixture`` stub lines as the Codex ws-server's events, through the real parsers."""
    from domains.spawn_claude_code_agent import service

    real_unusable, real_feedback = service.login_unusable_from_event, service.build_codex_credential_feedback
    with (
        patch.object(service, "login_unusable_from_event", lambda event: real_unusable(_codex_wire(event))),
        patch.object(
            service, "build_codex_credential_feedback", lambda events: real_feedback([_codex_wire(e) for e in events])
        ),
    ):
        yield


def test_unusable_login_event_is_structured_and_marks_the_login_for_reconnect():
    """The ws-server's ``login_unusable`` error: parsed without prose matching, fed back as a rejected login
    (the backend disables it only when the stored login is still the held one and not expired)."""
    from domains.spawn_claude_code_agent.service import build_codex_credential_feedback, login_unusable_from_event

    event = {
        "type": "error",
        "provider": "codex",
        "message": "Your access token could not be refreshed: refresh_token_invalidated",
        "usage_limit": None,
        "login_unusable": {"reason": "oauth_refresh_invalid"},
    }
    assert login_unusable_from_event(event) == {"provider": "codex", "reason": "oauth_refresh_invalid"}
    assert login_unusable_from_event({**event, "login_unusable": None}) is None, "the switch path is not a pause"
    # Never a rate limit; code-agent-login-rejection.blackbox.ts owns revoked vs expired vs replaced.
    assert build_codex_credential_feedback([event]) == [{"source": "initial", "reason": "oauth_refresh_invalid"}]


async def _unusable_login_then_retry(availability: list):
    """A Codex run whose login proves unusable (no Azure switch armed), then the parent's retry."""
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    session_home = _SessionHome(extra_env={"STUB_MODE": "login_unusable"})
    backend = _Backend(session_home)
    backend.paths = [dict(path) for path in _SHARED_PATHS]
    backend.availability = availability
    with backend.patched(), _codex_events():
        first = await asyncio.wait_for(
            ActivityEnvironment().run(service.spawn_claude_code_activity, *_activity_args(code_provider="codex")),
            timeout=30,
        )
        retry = await asyncio.wait_for(
            ActivityEnvironment().run(
                service.spawn_claude_code_activity,
                *_activity_args(
                    code_session_request={"code_session_id": (first.get("retry") or {}).get("code_session_id")},
                    tool_call_id="tc-retry",
                    code_provider="codex",
                ),
            ),
            timeout=30,
        )
    return first, retry, backend, session_home


_REVOKED_CODEX = {
    "provider": "codex",
    "label": "codex@example.com",
    "status": "reconnect",
    "limited_until": None,
    "this_run": False,
}


async def test_unusable_login_pauses_and_the_retry_switches_to_a_claude_subscription():
    """Revoked Codex login, a Claude subscription left: paused (not fatal), the login marked for
    reconnect (not rate-limited), and the retry continues the session on Claude with the handoff."""
    claude_lease = {
        "provider": "claude",
        "label": "me@example.com",
        "available_now": True,
        "available_at": None,
        "kind": "own",
    }
    accounts = [{**_ACCOUNTS[0], "status": "available", "limited_until": None, "this_run": False}, _REVOKED_CODEX]
    after_mark = {
        "claude": True,
        "codex": False,
        "session_provider": "codex",
        "next_credential": {"provider": "claude", "tier": "subscription"},
        "outlook": {"accounts": accounts, "next_lease": claude_lease},
    }
    first, retry, backend, session_home = await _unusable_login_then_retry(
        [{"claude": True, "codex": True}, after_mark, after_mark]
    )
    try:
        assert first["status"] == "usage_limit" and first["failure_kind"] == "login_unusable", first
        assert first["retryable"] is True and first["success"] is False, first
        assert first["retry"] == {"tool": "spawn_agent", "type": "code", "code_session_id": _SESSION_ID}, first
        assert [call.get("reason") for call in backend.closed][0] == "usage_limit", "checkpoint + pause"
        assert backend.usage_reports == [], "an unusable login is never put on a rate-limit cooldown"
        assert {"source": "initial", "reason": "oauth_refresh_invalid"} in (backend.credential_feedback[0] or []), (
            "the persisted feedback marks exactly that login for reconnect",
            backend.credential_feedback,
        )
        assert first["usage_limit"]["credential_marked"] == "login_rejected", first["usage_limit"]
        assert first["message"] == (
            "Code agent stopped: the Codex login was rejected (its access token expired or was revoked). "
            "Its work is saved on branch rose/write-answer-0a1b2c3d (checkpoint 1); the sandbox is paused, "
            "not killed.\nConnected accounts:\n"
            "- Claude Code me@example.com: available\n"
            "- Codex codex@example.com: disconnected (the user must reconnect it)\n"
            + _retry_line(
                "no Codex subscription is left, so the retry continues this session on Claude Code "
                "(now Claude Code me@example.com) from the latest checkpoint, with a handoff prompt that points "
                "it at the previous agent's trajectory."
            )
        ), first["message"]
        assert "rate-limited" not in first["message"] and "out of quota" not in first["message"]
        assert first["code_agent"]["state"] == "paused", first["code_agent"]
        assert first["code_agent"]["failure_message"] == (
            "Paused: the Codex login was rejected (expired or revoked). Work is saved."
        ), first["code_agent"]
        assert backend.created[1]["code_provider"] == "claude", backend.created[1]
        assert backend.created[1]["code_session_id"] == _SESSION_ID, backend.created[1]
        assert retry["code_provider"] == "claude" and retry["status"] == "completed", retry
    finally:
        session_home.cleanup()


async def test_unusable_login_with_nothing_else_stays_paused_with_the_reconnect_wording():
    """Revoked Codex login and nothing else leasable: paused with the reconnect wording; the retry starts nothing."""
    nothing = {
        "claude": False,
        "codex": False,
        "session_provider": "codex",
        "next_credential": None,
        "outlook": {"accounts": [_REVOKED_CODEX], "next_lease": None},
    }
    first, retry, backend, session_home = await _unusable_login_then_retry(
        [{"claude": True, "codex": True}, nothing, nothing]
    )
    try:
        assert first["status"] == "usage_limit" and first["failure_kind"] == "login_unusable", first
        assert first["message"].startswith(
            "Code agent stopped: the Codex login was rejected (its access token expired or was revoked). "
        ), first["message"]
        assert first["message"].endswith(
            _retry_line(
                "no other credential can be leased right now, so a retry stays paused and starts nothing until "
                "the credential is re-synced, reconnected or replaced, or another account is connected."
            )
        ), first["message"]
        assert len(backend.created) == 1, f"no agent may start without a credential: {backend.created}"
        assert retry["status"] == "usage_limit" and retry["failure_kind"] == "no_credentials", retry
    finally:
        session_home.cleanup()


_STUB_OAUTH_TOKEN = "sk-ant-oat01-stub-expiring-access-token"
# What the ws-server reports as the credential it held: a digest, never the token.
_STUB_OAUTH_FINGERPRINT = __import__("hashlib").sha256(_STUB_OAUTH_TOKEN.encode()).hexdigest()[:16]


def test_claude_auth_failure_is_structured_and_text_alone_is_ignored():
    """Claude's structured ``authentication_failed`` is an unusable login; the printed banner alone is not."""
    from domains.spawn_claude_code_agent.service import build_credential_feedback, login_unusable_from_event

    event = {
        "type": "cli_message",
        "raw_type": "assistant.api_error",
        "cli_message": {"type": "assistant_api_error", "error": "authentication_failed"},
        "credential": _STUB_OAUTH_FINGERPRINT,
    }
    assert login_unusable_from_event(event) == {
        "provider": "claude",
        "reason": "authentication_failed",
        "credential": _STUB_OAUTH_FINGERPRINT,
    }
    assert build_credential_feedback([event], "claude") == [
        {"source": "initial", "reason": "authentication_failed", "credential": _STUB_OAUTH_FINGERPRINT}
    ]
    banner_only = [
        {"type": "assistant", "text": "Failed to authenticate. API Error: 401 authentication_error"},
        {"type": "tool_result", "text": "Please run /login · Not logged in · Credit balance is too low"},
    ]
    assert [login_unusable_from_event(e) for e in banner_only] == [None, None]
    assert build_credential_feedback(banner_only, "claude") == []


async def test_expired_claude_token_pauses_and_the_retry_resumes_on_a_fresh_lease():
    """The sandbox's Claude access token expires mid-run (structured 401): the session is checkpointed and
    paused (not a fatal non-retryable abort), the held credential is reported by fingerprint, and the
    parent's retry re-leases and resumes the same CLI conversation."""
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    session_home = _SessionHome(extra_env={"STUB_MODE": "auth_expired", "CLAUDE_CODE_OAUTH_TOKEN": _STUB_OAUTH_TOKEN})
    backend = _Backend(session_home)
    available = {"claude": True, "codex": False, "session_provider": "claude"}
    backend.availability = [available, {**available, "outlook": {"next_lease": dict(_SHARED_CLAUDE_LEASE)}}, available]
    try:
        with backend.patched():
            first = await asyncio.wait_for(
                ActivityEnvironment().run(service.spawn_claude_code_activity, *_activity_args()), timeout=30
            )
            retry = await asyncio.wait_for(
                ActivityEnvironment().run(
                    service.spawn_claude_code_activity,
                    *_activity_args(
                        code_session_request={"code_session_id": (first.get("retry") or {}).get("code_session_id")},
                        tool_call_id="tc-retry",
                    ),
                ),
                timeout=30,
            )
        assert first["status"] == "usage_limit" and first["failure_kind"] == "login_unusable", first
        assert first["retryable"] is True and first["success"] is False, first
        assert first["retry"] == {"tool": "spawn_agent", "type": "code", "code_session_id": _SESSION_ID}, first
        assert [call.get("reason") for call in backend.closed][0] == "usage_limit", "checkpoint + pause"
        assert backend.usage_reports == [], "an expired token is never put on a rate-limit cooldown"
        assert backend.credential_feedback[0] == [
            {"source": "initial", "reason": "authentication_failed", "credential": _STUB_OAUTH_FINGERPRINT}
        ], backend.credential_feedback
        assert first["message"].startswith(
            "Code agent stopped: the Claude Code credential was rejected by the provider (authentication failed). "
            "Its work is saved on branch rose/write-answer-0a1b2c3d (checkpoint 1); the sandbox is paused, not killed."
        ), first["message"]
        assert _STUB_OAUTH_TOKEN not in json.dumps(first), "the token never reaches the parent"
        assert first["code_agent"]["state"] == "paused", first["code_agent"]
        assert backend.created[1]["code_session_id"] == _SESSION_ID, backend.created[1]
        runs = session_home.runs()
        assert len(runs) == 2 and "--resume" in runs[1]["argv"], runs
        assert retry["code_provider"] == "claude" and retry["status"] == "completed", retry
        texts = [e.get("text") for e in backend.verified_events[-1] if e.get("type") == "agent_message"]
        assert "notes: uncommitted work" in texts, f"the resumed run kept the paused work: {texts}"
    finally:
        session_home.cleanup()


async def test_auth_strings_in_tool_output_and_prose_never_abort_a_healthy_session():
    """An agent grepping for "API Error: 401" (and reading every banner string) finishes normally:
    only structured CLI signals classify credential failures."""
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    session_home = _SessionHome(extra_env={"STUB_MODE": "mentions_auth_text"})
    backend = _Backend(session_home)
    backend.availability = [{"claude": True, "codex": True}]
    try:
        with backend.patched():
            result = await asyncio.wait_for(
                ActivityEnvironment().run(service.spawn_claude_code_activity, *_activity_args()), timeout=30
            )
        assert result["status"] == "completed", result
        assert not [m for m in backend.messages if m.get("title") == "Authentication Error"], backend.messages
        assert all(feedback in (None, []) for feedback in backend.credential_feedback), backend.credential_feedback
    finally:
        session_home.cleanup()


async def test_rotation_d_no_credential_keeps_the_session_paused_and_starts_nothing():
    """(d) Nothing leasable anywhere → no create, no resume, the earliest reset named."""
    limited_paths = [
        {**_SHARED_PATHS[0], "status": "limited", "available_count": 0, "limited_until": "2026-10-03T02:00:00.000Z"},
        _SHARED_PATHS[1],
        _SHARED_PATHS[2],
        {**_SHARED_PATHS[3], "status": "unconfigured"},
    ]
    accounts = [
        _ACCOUNTS[0],
        {**_ACCOUNTS[1], "status": "limited", "limited_until": "2026-10-03T03:00:00.000Z"},
    ]
    earliest = {
        "provider": "claude",
        "label": "me@example.com",
        "available_now": False,
        "available_at": "2026-10-03T00:50:00.000Z",
        "kind": "own",
    }
    first, retry, backend, session_home, _ = await _rotation(
        retry_availability={
            "claude": False,
            "codex": False,
            "session_provider": "claude",
            "outlook": {"accounts": accounts, "paths": limited_paths, "next_lease": earliest},
        },
        next_lease=earliest,
    )
    try:
        assert first["status"] == "usage_limit", first
        assert len(backend.created) == 1, f"no agent may start without a credential: {backend.created}"
        assert len(backend.closed) == 1 and len(backend.usage_reports) == 1, (backend.closed, backend.usage_reports)
        assert len(session_home.runs()) == 1 and session_home.process is None, "the sandbox stays paused"
        assert retry["status"] == "usage_limit" and retry["failure_kind"] == "no_credentials", retry
        assert retry["retryable"] is True and retry["success"] is False, retry
        assert retry["retry"] == {"tool": "spawn_agent", "type": "code", "code_session_id": _SESSION_ID}, retry
        assert retry["message"] == (
            "Code agent not resumed: no Claude Code or Codex credential can be leased right now, so no agent was "
            f"started. Code session {_SESSION_ID} stays paused with its work saved.\n"
            "Connected accounts:\n"
            "- Claude Code me@example.com: limited until 2026-10-03T00:50:00.000Z (this run)\n"
            "- Codex codex@example.com: limited until 2026-10-03T03:00:00.000Z\n"
            "Shared credential paths:\n"
            "- shared Claude Code subscriptions: all 3 limited until 2026-10-03T02:00:00.000Z\n"
            "- shared Codex subscriptions: none connected\n"
            "- funded Anthropic API key: limited until 2026-10-03T01:20:00.000Z\n"
            "- funded Azure OpenAI deployment: not configured\n"
            "The earliest reset is 2026-10-03T00:50:00.000Z (Claude Code me@example.com). "
            "Wait with wait_for(until_timestamp=<that time>), then retry with "
            f"spawn_agent(type='code', code_session_id='{_SESSION_ID}', goal=<the same goal>)."
        ), retry["message"]
        assert retry["code_agent"]["state"] == "paused", retry["code_agent"]
        assert retry["code_agent"]["failure_message"] == (
            "Paused: no Claude or Codex credential is available (earliest reset Oct 3, 12:50 AM UTC). Work is saved."
        ), retry["code_agent"]
    finally:
        session_home.cleanup()


async def test_rotation_e_resume_from_root_prefers_the_sessions_own_harness():
    """(e) The root resumes a session last run on Codex: it stays on Codex even though Claude is the default."""
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    session_home = _SessionHome(extra_env={"STUB_MODE": "finish"})
    backend = _Backend(session_home)
    backend.availability = [{"claude": True, "codex": True, "session_provider": "codex"}]
    try:
        with backend.patched():
            result = await asyncio.wait_for(
                ActivityEnvironment().run(
                    service.spawn_claude_code_activity,
                    *_activity_args(code_session_request={"code_session_id": _SESSION_ID}, code_provider="claude"),
                ),
                timeout=30,
            )
        assert backend.availability_calls == [{"code_session_id": _SESSION_ID, "prefer": "claude"}], (
            backend.availability_calls
        )
        assert backend.created[0]["code_provider"] == "codex", "no needless provider switch on a resume"
        assert backend.created[0]["code_session_id"] == _SESSION_ID, backend.created[0]
        assert result["code_provider"] == "codex" and result["status"] == "completed", result
    finally:
        session_home.cleanup()


async def test_rotation_f_duplicate_concurrent_retry_starts_one_agent():
    """(f) Two concurrent retries of one session: one resumes it, the other gets the backend's busy error.

    The backend lease (and its conditional provider switch) is asserted in the
    code-session-usage-limit backend blackbox; here the stand-in answers like
    it, and the activity must not start, close or re-report anything for the loser.
    """
    from temporalio.exceptions import ApplicationError
    from temporalio.testing import ActivityEnvironment

    from domains.spawn_claude_code_agent import service

    session_home = _SessionHome(extra_env={"STUB_MODE": "rate_limit"})
    backend = _Backend(session_home)
    backend.availability = [{"claude": True, "codex": True}] + [
        {"claude": True, "codex": True, "session_provider": "claude"}
    ] * 2
    held: set[str] = set()
    attempts: list[str] = []
    create, close = backend.create_session, backend.close_session

    async def leased_create(**kwargs):
        attempts.append(kwargs.get("lease_owner") or "")
        session_id = kwargs.get("code_session_id")
        if session_id in held:
            raise ApplicationError(
                "Failed to create code session (provider=claude): HTTP 409: "
                '{"error":"Code session is busy","code":"CODE_SESSION_BUSY"}',
                type="CodeSessionUnavailable",
                non_retryable=True,
            )
        if session_id:
            held.add(session_id)
        return await create(**kwargs)

    async def releasing_close(**kwargs):
        held.discard(_SESSION_ID)
        return await close(**kwargs)

    backend.create_session = leased_create
    backend.close_session = releasing_close
    try:
        with backend.patched():
            first = await asyncio.wait_for(
                ActivityEnvironment().run(service.spawn_claude_code_activity, *_activity_args()), timeout=30
            )
            retry_args = [
                _activity_args(code_session_request={"code_session_id": _SESSION_ID}, tool_call_id=tool_call_id)
                for tool_call_id in ("tc-retry-1", "tc-retry-2")
            ]
            outcomes = await asyncio.wait_for(
                asyncio.gather(
                    *(ActivityEnvironment().run(service.spawn_claude_code_activity, *args) for args in retry_args),
                    return_exceptions=True,
                ),
                timeout=30,
            )
        assert first["status"] == "usage_limit", first
        completed = [o for o in outcomes if isinstance(o, dict) and o.get("status") == "completed"]
        busy = [o for o in outcomes if isinstance(o, ApplicationError) and o.type == "CodeSessionUnavailable"]
        assert len(completed) == 1 and len(busy) == 1, outcomes
        assert len(attempts) == 3 and len(session_home.runs()) == 2, "one agent resumed, the duplicate started none"
        assert backend.usage_reports == [("task-1", "claude", 1790988600)], "no second rotation"
        assert [call.get("reason") for call in backend.closed] == ["usage_limit", "close"], backend.closed
    finally:
        session_home.cleanup()


async def _run_all_tests():
    print("code-sessions blackbox tests:")
    r = BlackboxResult()
    setup_mock({"/api/agents/": {"status": 200, "json": {"saved": True}}})
    await r.record_async(
        "idle_past_every_old_limit_paused_then_resumes",
        test_idle_past_every_old_limit_is_paused_not_failed_then_resumes,
    )
    await r.record_async(
        "cancelled_spawner_unblocks_waiting_child",
        test_cancelled_spawner_unblocks_a_child_waiting_for_its_answer,
    )
    await r.record_async("failed_attempt_retry_keeps_state", test_failed_attempt_retry_keeps_state_and_code_session_id)
    await r.record_async(
        "resize_request_moves_session_and_reattaches",
        test_resize_request_moves_session_and_next_attempt_reattaches,
    )
    await r.record_async(
        "resize_waits_for_initial_cli_tool_start",
        test_resize_request_waits_for_initial_cli_tool_start,
    )
    await r.record_async(
        "usage_limit_saves_session_and_retry_leases_next",
        test_usage_limit_saves_session_and_retry_leases_next_credential,
    )
    await r.record_async(
        "usage_limit_retry_switches_provider",
        test_usage_limit_retry_switches_provider_when_pool_is_exhausted,
    )
    r.record("usage_limit_detection_structured_only", test_usage_limit_detection_reads_structured_events_only)
    r.record("claude_auth_failure_structured_only", test_claude_auth_failure_is_structured_and_text_alone_is_ignored)
    await r.record_async(
        "expired_claude_token_pauses_and_retry_resumes",
        test_expired_claude_token_pauses_and_the_retry_resumes_on_a_fresh_lease,
    )
    await r.record_async(
        "auth_strings_in_output_never_abort", test_auth_strings_in_tool_output_and_prose_never_abort_a_healthy_session
    )
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
    await r.record_async(
        "tool_result_reports_branch_and_merge", test_tool_result_reports_branch_and_merged_only_when_confirmed
    )
    await r.record_async("ws_server_checks_out_session_branch", test_ws_server_checks_out_the_code_session_branch)
    await r.record_async("preview_url_rides_every_code_agent_block", test_preview_url_rides_every_code_agent_block)
    # C15 credential rotation end to end, one case per branch.
    await r.record_async(
        "rotation_a_exhaustion_pauses_and_lists_paths", test_rotation_a_exhaustion_pauses_sandbox_and_lists_every_path
    )
    await r.record_async(
        "rotation_a_out_of_credits_is_usage_limit", test_rotation_a_out_of_credits_is_a_usage_limit_not_a_crash
    )
    await r.record_async(
        "rotation_b_same_provider_native_resume",
        test_rotation_b_same_provider_retry_resumes_natively_in_the_same_sandbox,
    )
    await r.record_async(
        "rotation_c_other_provider_handoff", test_rotation_c_only_other_provider_switches_with_a_handoff
    )
    await r.record_async(
        "rotation_d_no_credential_stays_paused",
        test_rotation_d_no_credential_keeps_the_session_paused_and_starts_nothing,
    )
    await r.record_async(
        "rotation_e_root_resume_prefers_same_harness", test_rotation_e_resume_from_root_prefers_the_sessions_own_harness
    )
    await r.record_async(
        "rotation_f_duplicate_retry_starts_one_agent", test_rotation_f_duplicate_concurrent_retry_starts_one_agent
    )
    # Subscriptions before funded keys (C15 order; the backend half is code-session-credential-order.cases.ts).
    await r.record_async(
        "rotation_h_other_subscription_beats_funded_key",
        test_rotation_h_another_providers_subscription_beats_the_funded_key,
    )
    await r.record_async(
        "rotation_i_funded_key_resumes_same_provider",
        test_rotation_i_only_the_funded_key_left_resumes_the_same_provider,
    )
    await r.record_async(
        "fresh_spawn_follows_subscription_first_choice", test_fresh_spawn_follows_the_backends_subscription_first_choice
    )
    r.record(
        "usage_limit_clause_names_other_funded_key", test_usage_limit_clause_names_a_funded_key_on_the_other_provider
    )
    # An unusable Codex login with no Azure switch armed pauses like a usage limit (C15).
    r.record(
        "unusable_login_event_marks_login_for_reconnect",
        test_unusable_login_event_is_structured_and_marks_the_login_for_reconnect,
    )
    await r.record_async(
        "unusable_login_pauses_retry_switches_to_claude",
        test_unusable_login_pauses_and_the_retry_switches_to_a_claude_subscription,
    )
    await r.record_async(
        "unusable_login_nothing_else_stays_paused",
        test_unusable_login_with_nothing_else_stays_paused_with_the_reconnect_wording,
    )
    teardown_mock()
    return r.all_passed


async def run_all_tests():
    # Production default: the code-agent verifier is off unless opted in.
    with patch.dict(os.environ, {}):
        os.environ.pop("ROSE_ENABLE_CODE_AGENT_VERIFIER", None)
        return await _run_all_tests()
