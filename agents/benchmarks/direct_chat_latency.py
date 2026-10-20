"""Direct chat with a code agent: typed message → first streamed token latency.

Rose-builds-Rose C7 bar: p50 ≤ 3 s from the user's typed turn to the first
streamed token of the code agent's reply. This eval measures both halves:

``--mode sandbox`` (default)
    The production ``e2b-templates/claude-code/ws-server.mjs`` on localhost
    with a CLI on ``PATH``. The turn goes through the real delivery primitive
    (``helpers.code_session_turns.deliver_user_turn_to_code_session``) and the
    clock stops at the first ``code_agent_delta`` an observer socket (the UI's
    view) receives for that turn. The default CLI is the deterministic replay
    stand-in (``tests/fixtures/code_transcript/replay_cli.py``), so the number
    is Rose's own plumbing overhead. ``--cli-bin /path/to/claude`` runs a real
    Claude Code CLI instead; the sandbox HOME is a temp dir, so pass auth via
    ``--oauth-token-env NAME`` (an env var holding a ``claude setup-token``
    token) or ``ANTHROPIC_API_KEY``.

``--mode cli``
    A real ``claude --print --input-format stream-json --output-format
    stream-json --include-partial-messages`` process with the caller's own
    login (no sandbox config is written): user message written to stdin →
    first ``stream_event``. This is the model/CLI share of the latency.

Usage (from ``agents/`` with the venv active)::

    python benchmarks/direct_chat_latency.py                 # plumbing, 10 turns
    python benchmarks/direct_chat_latency.py --mode cli --model claude-sonnet-5
    python benchmarks/direct_chat_latency.py --cli-bin "$(command -v claude)" \\
        --oauth-token-env CLAUDE_CODE_OAUTH_TOKEN            # end to end

Prints one JSON line per turn and a summary with p50/p90/max; exits 1 when the
p50 exceeds ``--budget-s`` (3.0).
"""

import argparse
import asyncio
import contextlib
import json
import os
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import aiohttp

AGENTS_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENTS_ROOT.parent
if str(AGENTS_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENTS_ROOT))

REPLAY_CLI = AGENTS_ROOT / "tests" / "fixtures" / "code_transcript" / "replay_cli.py"
WS_SERVERS = {
    "claude": REPO_ROOT / "e2b-templates" / "claude-code" / "ws-server.mjs",
    "codex": REPO_ROOT / "e2b-templates" / "codex-code" / "ws-server.mjs",
}
TEST_TURN_TOKEN = "direct-chat-test-token"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class LocalCodeSessionSandbox:
    """The production ws-server.mjs on localhost with a stand-in (or real) CLI.

    Like an E2B sandbox it owns its own HOME, PATH and port; ``stop()`` signals
    the whole process group so the CLI dies with the server.
    """

    def __init__(
        self,
        provider: str = "claude",
        *,
        fixture: Optional[Path] = None,
        gate_first_turn: bool = False,
        cli_bin: Optional[str] = None,
        extra_env: Optional[dict[str, str]] = None,
        goal: str = "Fix the bug in calc.py so test_calc.py passes",
    ) -> None:
        self.provider = provider
        self.fixture = fixture
        self.gate_first_turn = gate_first_turn
        self.cli_bin = cli_bin
        self.extra_env = dict(extra_env or {})
        self.goal = goal
        self.tmp = Path(tempfile.mkdtemp(prefix=f"direct-chat-{provider}-"))
        self.port = free_port()
        self.ws_url = f"ws://127.0.0.1:{self.port}"
        self.stdin_log = self.tmp / "cli-stdin.jsonl"
        self.log_path = self.tmp / "ws-server.log"
        self.process: Optional[subprocess.Popen[bytes]] = None

    def env(self) -> dict[str, str]:
        bin_dir = self.tmp / "bin"
        home = self.tmp / "home"
        bin_dir.mkdir(exist_ok=True)
        home.mkdir(exist_ok=True)
        name = "codex" if self.provider == "codex" else "claude"
        wrapper = bin_dir / name
        if self.cli_bin:
            wrapper.write_text(f'#!/bin/sh\nexec "{self.cli_bin}" "$@"\n')
        else:
            wrapper.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{REPLAY_CLI}" "$@"\n')
        wrapper.chmod(0o755)
        env = {
            "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
            "HOME": str(home),
            "PORT": str(self.port),
            "CODE_SESSION_TURN_TOKEN": TEST_TURN_TOKEN,
            "REPLAY_CLI_MODE": self.provider,
            "REPLAY_CLI_STDIN_LOG": str(self.stdin_log),
        }
        if self.fixture is not None:
            env["REPLAY_CLI_FIXTURE"] = str(self.fixture)
        if self.gate_first_turn:
            env["REPLAY_CLI_GATE"] = str(self.tmp)
        if self.provider == "codex":
            env.update({"CODEX_GOAL": self.goal, "CODEX_AUTH_JSON": "{}"})
        else:
            env["CLAUDE_CODE_GOAL"] = self.goal
            if not any(key in self.extra_env for key in ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN")):
                env["ANTHROPIC_API_KEY"] = "replay-cli-key"
        env.update(self.extra_env)
        return env

    async def start(self) -> None:
        node = shutil.which("node")
        if not node:
            raise RuntimeError("node is required to run the sandbox ws-server")
        with self.log_path.open("w") as log:
            self.process = subprocess.Popen(
                [node, str(WS_SERVERS[self.provider])],
                cwd=self.tmp,
                env=self.env(),
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        for _ in range(400):
            if self.process.poll() is not None:
                raise RuntimeError(f"ws-server exited at startup:\n{self.log()}")
            with contextlib.suppress(OSError), socket.create_connection(("127.0.0.1", self.port), timeout=0.2):
                return
            await asyncio.sleep(0.025)
        raise RuntimeError(f"ws-server never listened on {self.port}:\n{self.log()}")

    def finish_first_turn(self) -> None:
        (self.tmp / "finish-turn-1").touch()

    def cli_stdin_lines(self) -> list[dict[str, Any]]:
        if not self.stdin_log.exists():
            return []
        return [json.loads(line) for line in self.stdin_log.read_text().splitlines() if line.strip()]

    def log(self) -> str:
        return self.log_path.read_text() if self.log_path.exists() else ""

    def stop(self) -> None:
        if self.process is not None:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(self.process.pid, sig)
                with contextlib.suppress(subprocess.TimeoutExpired):
                    self.process.wait(timeout=5)
                if self.process.poll() is not None:
                    break
        shutil.rmtree(self.tmp, ignore_errors=True)


class SessionObserver:
    """A read-only viewer socket (what the UI holds): events, deltas, exit."""

    def __init__(self, ws_url: str) -> None:
        self.ws_url = ws_url
        self.events: list[dict[str, Any]] = []
        self.deltas: list[tuple[float, dict[str, Any]]] = []
        self.exit_code: Optional[int] = None
        self._task: Optional[asyncio.Task[None]] = None
        self._session: Optional[aiohttp.ClientSession] = None
        self.changed = asyncio.Event()

    async def start(self) -> None:
        self._session = aiohttp.ClientSession()
        ws = await self._session.ws_connect(self.ws_url)
        self._task = asyncio.create_task(self._read(ws))

    async def _read(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                break
            data = json.loads(msg.data)
            kind = data.get("type")
            if kind == "code_agent_events":
                self.events = [event for event in data.get("data") or [] if isinstance(event, dict)]
            elif kind == "code_agent_event" and isinstance(data.get("data"), dict):
                self.events.append(data["data"])
            elif kind == "code_agent_delta" and isinstance(data.get("data"), dict):
                self.deltas.append((time.perf_counter(), data["data"]))
            elif kind == "exit":
                self.exit_code = int(data.get("code") or 0)
            self.changed.set()

    async def wait_for(self, predicate: Any, timeout: float = 20.0) -> None:
        deadline = time.monotonic() + timeout
        while not predicate():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"timed out waiting; events={[e.get('type') for e in self.events][-12:]}")
            self.changed.clear()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.changed.wait(), timeout=min(remaining, 0.5))

    def count(self, event_type: str) -> int:
        return sum(1 for event in self.events if event.get("type") == event_type)

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        if self._session is not None:
            await self._session.close()


def first_token_index(deltas: list[tuple[float, dict[str, Any]]], start: int) -> Optional[int]:
    """Index of the first content token (block start or text/thinking delta) at or after ``start``."""
    for index in range(start, len(deltas)):
        if deltas[index][1].get("kind") in ("block_start", "text", "thinking"):
            return index
    return None


def summarize(samples_s: list[float], budget_s: float) -> dict[str, Any]:
    ordered = sorted(samples_s)
    p90_index = max(0, min(len(ordered) - 1, int(round(0.9 * (len(ordered) - 1)))))
    return {
        "turns": len(ordered),
        "p50_s": round(statistics.median(ordered), 4),
        "p90_s": round(ordered[p90_index], 4),
        "max_s": round(ordered[-1], 4),
        "budget_s": budget_s,
        "pass": statistics.median(ordered) <= budget_s,
    }


async def measure_sandbox(
    turns: int,
    *,
    cli_bin: Optional[str] = None,
    extra_env: Optional[dict[str, str]] = None,
    first_token_timeout_s: float = 60.0,
) -> list[float]:
    """Latency of ``turns`` direct user turns, each to its first streamed token."""
    # The helpers package loads worker config on import; the eval talks only
    # to the local sandbox, so placeholder credentials are enough.
    from tests.env_defaults import apply_test_env_defaults

    apply_test_env_defaults()
    from helpers.code_session_turns import deliver_user_turn_to_code_session, hand_back_code_session

    sandbox = LocalCodeSessionSandbox(
        "claude",
        gate_first_turn=cli_bin is None,
        cli_bin=cli_bin,
        extra_env=extra_env,
        goal="Reply with the single word READY.",
    )
    await sandbox.start()
    observer = SessionObserver(sandbox.ws_url)
    samples: list[float] = []
    try:
        await observer.start()
        # The first user turn takes the session (direct hold) so stdin stays
        # open past the autonomous turn's result.
        hold = await deliver_user_turn_to_code_session(
            sandbox.ws_url,
            task_id="latency",
            text="Reply with the single word OK.",
            turn_id=f"warmup-{uuid.uuid4().hex}",
            token=TEST_TURN_TOKEN,
        )
        if not hold.reached_cli:
            raise RuntimeError(f"warm-up turn not delivered: {hold}")
        if cli_bin is None:
            sandbox.finish_first_turn()
        await observer.wait_for(lambda: observer.count("result") >= 2, timeout=first_token_timeout_s * 2)
        for index in range(turns):
            seen = len(observer.deltas)
            results = observer.count("result")
            started = time.perf_counter()
            delivery = await deliver_user_turn_to_code_session(
                sandbox.ws_url,
                task_id="latency",
                text=f"Reply with the number {index + 1} and nothing else.",
                turn_id=f"turn-{index}-{uuid.uuid4().hex}",
                token=TEST_TURN_TOKEN,
            )
            if not delivery.reached_cli:
                raise RuntimeError(f"turn {index} not delivered: {delivery}")
            await observer.wait_for(
                lambda: first_token_index(observer.deltas, seen) is not None, timeout=first_token_timeout_s
            )
            first_at = observer.deltas[first_token_index(observer.deltas, seen) or seen][0]
            samples.append(first_at - started)
            print(json.dumps({"turn": index + 1, "first_token_s": round(first_at - started, 4)}), flush=True)
            await observer.wait_for(lambda: observer.count("result") > results, timeout=first_token_timeout_s * 4)
        await hand_back_code_session(sandbox.ws_url, task_id="latency", token=TEST_TURN_TOKEN)
        await observer.wait_for(lambda: observer.exit_code is not None, timeout=30)
    finally:
        await observer.close()
        sandbox.stop()
    return samples


async def measure_cli(turns: int, model: str) -> list[float]:
    """Real CLI share: stdin user message → first stream_event, per turn."""
    claude = shutil.which("claude")
    if not claude:
        raise RuntimeError("claude CLI not on PATH")
    workdir = Path(tempfile.mkdtemp(prefix="direct-chat-cli-"))
    proc = await asyncio.create_subprocess_exec(
        claude,
        "--print",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--model",
        model,
        "--setting-sources",
        "project,local",
        cwd=workdir,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    assert proc.stdin is not None and proc.stdout is not None
    samples: list[float] = []

    def line(text: str) -> bytes:
        return (
            json.dumps({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}})
            + "\n"
        ).encode()

    async def until(kind: str) -> float:
        assert proc.stdout is not None
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                raise RuntimeError("claude exited early")
            with contextlib.suppress(ValueError):
                message = json.loads(raw)
                if kind == "first_token":
                    event = message.get("event") if message.get("type") == "stream_event" else None
                    if isinstance(event, dict) and event.get("type") in ("content_block_start", "content_block_delta"):
                        return time.perf_counter()
                elif message.get("type") == kind:
                    return time.perf_counter()

    try:
        proc.stdin.write(line("Reply with the single word READY."))
        await proc.stdin.drain()
        await until("result")
        for index in range(turns):
            started = time.perf_counter()
            proc.stdin.write(line(f"Reply with the number {index + 1} and nothing else."))
            await proc.stdin.drain()
            first = await until("first_token")
            samples.append(first - started)
            print(json.dumps({"turn": index + 1, "first_token_s": round(first - started, 4)}), flush=True)
            await until("result")
    finally:
        with contextlib.suppress(Exception):
            proc.stdin.close()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(proc.wait(), timeout=15)
        if proc.returncode is None:
            proc.kill()
        shutil.rmtree(workdir, ignore_errors=True)
    return samples


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mode", choices=("sandbox", "cli"), default="sandbox")
    parser.add_argument("--turns", type=int, default=10)
    parser.add_argument("--budget-s", type=float, default=3.0)
    parser.add_argument("--cli-bin", default=None, help="real claude binary for --mode sandbox")
    parser.add_argument("--oauth-token-env", default=None, help="env var holding CLAUDE_CODE_OAUTH_TOKEN")
    parser.add_argument("--model", default="claude-sonnet-5")
    args = parser.parse_args()

    if args.mode == "cli":
        samples = asyncio.run(measure_cli(args.turns, args.model))
    else:
        extra: dict[str, str] = {}
        if args.cli_bin:
            extra["CLAUDE_CODE_MODEL"] = args.model
            if args.oauth_token_env:
                extra["CLAUDE_CODE_OAUTH_TOKEN"] = os.environ[args.oauth_token_env]
            elif os.environ.get("ANTHROPIC_API_KEY"):
                extra["ANTHROPIC_API_KEY"] = os.environ["ANTHROPIC_API_KEY"]
        samples = asyncio.run(measure_sandbox(args.turns, cli_bin=args.cli_bin, extra_env=extra))
    summary = {
        "mode": args.mode,
        "cli": args.cli_bin or ("claude" if args.mode == "cli" else "replay"),
        **summarize(samples, args.budget_s),
    }
    print(json.dumps(summary), flush=True)
    return 0 if summary["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
