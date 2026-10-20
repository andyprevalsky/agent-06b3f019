"""Stand-in ``claude`` / ``codex`` CLI for the sandbox ws-server under test.

The production ws-server.mjs spawns ``claude`` (stream-json in/out) or
``codex exec --json``. Tests put a wrapper named after the CLI on ``PATH`` that
runs this script with ``REPLAY_CLI_MODE`` set:

claude
    Reads stream-json user messages from stdin, one per line, exactly like
    ``claude --print --input-format stream-json``. For the n-th message it
    replays the n-th recorded turn of ``REPLAY_CLI_FIXTURE`` (a real
    ``--output-format stream-json`` recording, split at each ``result``). With
    no fixture, or once the recorded turns run out, it streams an echo turn
    (``message_start`` → text delta → assistant text → ``result``). Exits 0 when
    stdin closes, as the real CLI does.

    ``REPLAY_CLI_STDIN_LOG``: append every received stdin line (proves a turn
    reached the CLI exactly once). ``REPLAY_CLI_GATE``: before the first
    turn's ``result``, wait until the file ``<gate>/finish-turn-1`` exists, so a
    test can deliver a turn while that turn is still running.

codex
    Prints every line of ``REPLAY_CLI_FIXTURE`` (a real ``codex exec --json``
    recording) and exits 0. ``codex login`` exits 0 immediately.
"""

import json
import os
import sys
import time
from typing import Any, Optional


def _emit(line: str) -> None:
    sys.stdout.write(line.rstrip("\n") + "\n")
    sys.stdout.flush()


def _emit_json(message: dict[str, Any]) -> None:
    _emit(json.dumps(message))


def _recorded_turns(path: Optional[str]) -> list[list[str]]:
    if not path:
        return []
    turns: list[list[str]] = [[]]
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            turns[-1].append(line)
            if json.loads(line).get("type") == "result":
                turns.append([])
    return [turn for turn in turns if turn]


def _message_text(line: str) -> str:
    try:
        message = json.loads(line)
    except ValueError:
        return line.strip()
    content = (message.get("message") or {}).get("content") or []
    return "\n".join(part.get("text", "") for part in content if isinstance(part, dict))


def _wait_for_gate(name: str) -> None:
    gate = os.environ.get("REPLAY_CLI_GATE")
    if not gate:
        return
    path = os.path.join(gate, name)
    while not os.path.exists(path):
        time.sleep(0.02)


def _echo_turn(text: str, turn: int) -> list[str]:
    reply = f"echo: {text}"
    return [
        json.dumps({"type": "stream_event", "event": {"type": "message_start", "message": {"id": f"msg_{turn}"}}}),
        json.dumps(
            {
                "type": "stream_event",
                "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            }
        ),
        json.dumps(
            {
                "type": "stream_event",
                "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": reply}},
            }
        ),
        json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": reply}]}}),
        json.dumps({"type": "result", "subtype": "success", "result": reply, "usage": {}}),
    ]


def run_claude() -> int:
    turns = _recorded_turns(os.environ.get("REPLAY_CLI_FIXTURE"))
    stdin_log = os.environ.get("REPLAY_CLI_STDIN_LOG")
    if not turns:
        _emit_json(
            {
                "type": "system",
                "subtype": "init",
                "session_id": "replay",
                "cwd": os.getcwd(),
                "model": "replay",
                "tools": ["Bash", "Read", "Edit"],
                "permissionMode": "bypassPermissions",
            }
        )
    turn = 0
    for line in sys.stdin:
        if not line.strip():
            continue
        if stdin_log:
            with open(stdin_log, "a", encoding="utf-8") as handle:
                handle.write(line if line.endswith("\n") else line + "\n")
        turn += 1
        lines = turns[turn - 1] if turn <= len(turns) else _echo_turn(_message_text(line), turn)
        for out in lines:
            if turn == 1 and json.loads(out).get("type") == "result":
                _wait_for_gate("finish-turn-1")
            _emit(out)
    return 0


def run_codex(argv: list[str]) -> int:
    if argv[:1] == ["login"]:
        sys.stdin.read()
        return 0
    path = os.environ.get("REPLAY_CLI_FIXTURE")
    if path:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    _emit(line)
    return 0


if __name__ == "__main__":
    mode = os.environ.get("REPLAY_CLI_MODE", "claude")
    sys.exit(run_codex(sys.argv[1:]) if mode == "codex" else run_claude())
