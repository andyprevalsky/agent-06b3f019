"""Direct chat with a running code agent + its structured transcript (Rose-builds-Rose C7, C12).

Everything runs against the production sandbox server
(``e2b-templates/{claude,codex}-code/ws-server.mjs``) on localhost with a
stand-in CLI (``tests/fixtures/code_transcript/replay_cli.py``) that replays
real recordings of ``claude --output-format stream-json`` and
``codex exec --json`` (``*.raw.jsonl``, captured 2026-10-20 with Claude Code
2.1.284 / codex-cli 0.159.0, paths scrubbed).

Covered:
  * a typed turn reaches the CLI exactly once across a delivery retry
    (``deliver_user_turn_to_code_session`` + ws-server dedupe by turn id);
  * turns need the per-session token;
  * while the user holds the session, Rose's ``sender="agent"`` turns are
    rejected with ``relay_paused`` until the hand back, and the monitoring
    activity neither writes to the CLI nor ends the session;
  * typed turn → first streamed token stays far under the 3 s p50 bar;
  * ws-server output for the recordings matches the committed event fixtures
    (``*.events.json``; regenerate with ``CODE_TRANSCRIPT_WRITE_FIXTURES=1``);
  * transcript records parsed from those events (thinking, assistant, Read
    lines, Edit +/−, Run exit status, results, user turns);
  * transcript batches are persisted once across an activity reattach.
"""

import asyncio
import contextlib
import json
import os
import statistics
import time
from pathlib import Path
from typing import Any, Optional
from unittest.mock import AsyncMock, patch

from _test_utils import BlackboxResult, teardown_mock

from benchmarks.direct_chat_latency import (
    TEST_TURN_TOKEN,
    LocalCodeSessionSandbox,
    SessionObserver,
    first_token_index,
    measure_sandbox,
)
from utils.code_transcript import (
    CodeTranscriptBuilder,
    build_code_transcript,
    render_transcript_text,
    to_ui_record,
)
from helpers.code_session_turns import (
    code_session_turn_token,
    control_ws_url,
    deliver_user_turn_to_code_session,
    hand_back_code_session,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "code_transcript"
CLAUDE_RAW = FIXTURES / "claude_stream_json.raw.jsonl"
CODEX_RAW = FIXTURES / "codex_exec_json.raw.jsonl"
CLAUDE_EVENTS = FIXTURES / "claude_stream_json.events.json"
CODEX_EVENTS = FIXTURES / "codex_exec_json.events.json"
CLAUDE_GOAL = (
    "Think step by step about the bug in calc.py before acting. Read calc.py, fix add with the Edit tool, "
    "then run python3 test_calc.py. Then run exactly this command on its own (no chaining): "
    'python3 -c "import sys; print(42); sys.exit(3)" and report what happened.'
)
CLAUDE_TURN_2 = "Reply with one short sentence: what did you change?"


def _stable(events: list[dict[str, Any]], home: str) -> list[dict[str, Any]]:
    """Events minus wall-clock fields, with the temp sandbox HOME shown as E2B's /home/user."""
    timeless = [{key: value for key, value in event.items() if key != "timestamp"} for event in events]
    return json.loads(json.dumps(timeless).replace(home, "/home/user"))


def _check_or_write_fixture(path: Path, events: list[dict[str, Any]], home: str) -> None:
    stable = _stable(events, home)
    if os.environ.get("CODE_TRANSCRIPT_WRITE_FIXTURES") == "1":
        path.write_text(json.dumps(stable, indent=1, ensure_ascii=False) + "\n")
    expected = json.loads(path.read_text())
    first = next((i for i, (a, b) in enumerate(zip(stable, expected)) if a != b), min(len(stable), len(expected)))
    assert stable == expected, (
        f"ws-server output for {path.name} drifted from the committed fixture "
        f"({len(stable)} vs {len(expected)} events; first difference at {first}: "
        f"{json.dumps(stable[first:first + 1])[:400]} != {json.dumps(expected[first:first + 1])[:400]}); "
        "rerun with CODE_TRANSCRIPT_WRITE_FIXTURES=1 after reviewing the change"
    )


async def _claude_session_with_direct_turn(sandbox: LocalCodeSessionSandbox) -> SessionObserver:
    """Turn 1 replays while gated; the user's turn lands mid-turn; hand back ends the run."""
    await sandbox.start()
    observer = SessionObserver(sandbox.ws_url)
    await observer.start()
    # The stand-in CLI holds turn 1's `result` at the gate; wait until every
    # event before it is out so the user's turn lands at a fixed position.
    await observer.wait_for(lambda: observer.count("tool_result") >= 4 and observer.count("agent_message") >= 4)
    delivery = await deliver_user_turn_to_code_session(
        sandbox.ws_url, task_id="fixture", text=CLAUDE_TURN_2, turn_id="fixture-turn-2", token=TEST_TURN_TOKEN
    )
    assert delivery.status == "delivered", delivery
    sandbox.finish_first_turn()
    await observer.wait_for(lambda: observer.count("result") >= 2)
    assert await hand_back_code_session(sandbox.ws_url, task_id="fixture", token=TEST_TURN_TOKEN) == "released"
    await observer.wait_for(lambda: observer.exit_code is not None)
    return observer


# ── Fixtures: real recordings through the real ws-servers ───────────────────


async def test_claude_recording_through_ws_server_matches_event_fixture():
    sandbox = LocalCodeSessionSandbox("claude", fixture=CLAUDE_RAW, gate_first_turn=True, goal=CLAUDE_GOAL)
    try:
        observer = await _claude_session_with_direct_turn(sandbox)
        assert observer.exit_code == 0, sandbox.log()
        _check_or_write_fixture(CLAUDE_EVENTS, observer.events, str(sandbox.tmp / "home"))
        kinds = {delta.get("kind") for _, delta in observer.deltas}
        # Partial messages stream live but never enter the replayable history.
        assert {"message_start", "block_start", "text"} <= kinds, kinds
        assert not any(
            event.get("type") == "cli_message" and (event.get("cli_message") or {}).get("type") == "stream_event"
            for event in observer.events
        )
        await observer.close()
    finally:
        sandbox.stop()


async def test_codex_recording_through_ws_server_matches_event_fixture():
    sandbox = LocalCodeSessionSandbox("codex", fixture=CODEX_RAW, goal="Fix the bug in calc.py")
    try:
        await sandbox.start()
        observer = SessionObserver(sandbox.ws_url)
        await observer.start()
        await observer.wait_for(lambda: observer.exit_code is not None)
        assert observer.exit_code == 0, sandbox.log()
        _check_or_write_fixture(CODEX_EVENTS, observer.events, str(sandbox.tmp / "home"))
        turn = await deliver_user_turn_to_code_session(
            sandbox.ws_url, task_id="fixture", text="hi", turn_id="codex-turn", token=TEST_TURN_TOKEN, attempts=1
        )
        assert turn.status == "rejected" and turn.reason in ("provider_unsupported", "session_ended"), turn
        await observer.close()
    finally:
        sandbox.stop()


# ── Transcript parsing ───────────────────────────────────────────────────────


def _by_kind(records: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    return [record for record in records if record.get("kind") == kind]


def test_claude_transcript_records_from_fixture():
    events = json.loads(CLAUDE_EVENTS.read_text())
    records = build_code_transcript(events, "claude", goal=CLAUDE_GOAL)
    assert [r["seq"] for r in records] == sorted(r["seq"] for r in records)
    assert len({r["id"] for r in records}) == len(records)

    users = _by_kind(records, "user")
    assert [(u["sender"], u["text"]) for u in users] == [("agent", CLAUDE_GOAL), ("user", CLAUDE_TURN_2)]
    assert users[1]["turn_id"] == "fixture-turn-2"

    thinking = _by_kind(records, "thinking")
    assert len(thinking) == 1 and thinking[0]["redacted"] is True and thinking[0]["text"] == ""

    tools = _by_kind(records, "tool")
    assert [(t["category"], t["name"], t["status"]) for t in tools] == [
        ("read", "Read", "ok"),
        ("edit", "Edit", "ok"),
        ("run", "Bash", "ok"),
        ("run", "Bash", "error"),
    ]
    read, edit, run_ok, run_fail = tools
    assert read["lines"] == 7 and read["title"] == "calc.py"
    assert (edit["added"], edit["removed"]) == (1, 1)
    assert (
        run_ok["exit_code"] == 0
        and run_ok["command"] == "python3 test_calc.py"
        and run_ok["output"] == "all tests passed"
    )
    assert run_fail["exit_code"] == 3 and "42" in run_fail["output"]
    assert all(t["id"].startswith("tool:toolu_") and t["rev"] == 2 for t in tools)

    assistant = [r["text"] for r in _by_kind(records, "assistant")]
    assert assistant[0].startswith("I'll read calc.py") and len(assistant) >= 4
    results = _by_kind(records, "result")
    assert [r["status"] for r in results] == ["completed", "completed"]
    controls = [(r["event"], r.get("reason")) for r in _by_kind(records, "control")]
    assert controls == [("held", None), ("released", "handed_back")]

    text = render_transcript_text(records)
    assert "[Read ✓] calc.py (7 lines)" in text
    assert "[Edit ✓] calc.py +1 −1" in text
    assert '[Bash ✗] python3 -c "import sys; print(42); sys.exit(3)" exit 3' in text
    assert f"[You → Claude] {CLAUDE_TURN_2}" in text


def test_ui_records_follow_the_transcript_tab_contract():
    events = json.loads(CLAUDE_EVENTS.read_text())
    ui = [to_ui_record(record) for record in build_code_transcript(events, "claude", goal=CLAUDE_GOAL)]
    assert {r["type"] for r in ui} == {"message", "thinking", "tool", "result", "control"}
    tools = [r["tool"] for r in ui if r["type"] == "tool"]
    assert [(t["name"], t["target"]) for t in tools] == [
        ("Read", "calc.py"),
        ("Edit", "calc.py"),
        ("Run", "python3 test_calc.py"),
        ("Run", 'python3 -c "import sys; print(42); sys.exit(3)"'),
    ]
    assert tools[0]["result"] == {"status": "ok", "lines": 7}
    assert (tools[1]["added"], tools[1]["removed"], tools[1]["result"]["status"]) == (1, 1, "ok")
    assert tools[3]["result"]["status"] == "error" and tools[3]["result"]["exit_code"] == 3
    first = ui[0]
    assert (first["type"], first["role"], first["sender"]) == ("message", "user", "agent")
    assert all(set(r) >= {"id", "rev", "seq", "ts", "type", "provider"} for r in ui)
    assert json.loads(json.dumps(ui)) == ui  # plain JSON for message metadata


def test_codex_transcript_records_from_fixture():
    events = json.loads(CODEX_EVENTS.read_text())
    records = build_code_transcript(events, "codex", goal="Fix the bug in calc.py")
    tools = _by_kind(records, "tool")
    runs = [t for t in tools if t["category"] == "run"]
    assert [(t["exit_code"], t["status"]) for t in runs] == [
        (1, "error"),
        (0, "ok"),
        (0, "ok"),
        (0, "ok"),
        (3, "error"),
    ]
    assert all(t["id"].startswith("item:item_") and t["rev"] == 2 for t in runs)
    assert runs[-1]["output"] == "42\n"
    edits = [t for t in tools if t["category"] == "edit"]
    assert len(edits) == 1 and edits[0]["paths"] == ["/home/user/workspace/calc.py"]
    assert edits[0]["added"] is None  # Codex reports files, not line counts
    assert edits[0]["title"] == "update calc.py"
    assistant = _by_kind(records, "assistant")
    assert len(assistant) == 2 and assistant[-1]["text"].startswith("Fixed `add()`")
    assert [r["status"] for r in _by_kind(records, "result")] == ["completed"]


def test_transcript_builder_handles_legacy_and_codex_reasoning_events():
    builder = CodeTranscriptBuilder("claude")
    # Sandboxes predating tool_use_id on results pair FIFO.
    builder.feed(
        {"type": "tool_use", "tool": "Write", "tool_use_id": "t1", "input": {"file_path": "/home/user/a.py"}}, 0
    )
    out = builder.feed(
        {
            "type": "tool_result",
            "tool_use_result": {"type": "create", "content": "a\nb\nc\n", "filePath": "/home/user/a.py"},
        },
        1,
    )
    assert out[0]["id"] == "tool:t1" and (out[0]["added"], out[0]["removed"]) == (3, 0) and out[0]["title"] == "a.py"
    codex = CodeTranscriptBuilder("codex")
    rec = codex.feed({"type": "thinking", "text": "Look at add()", "item_id": "item_9"}, 0)
    assert rec[0]["kind"] == "thinking" and rec[0]["redacted"] is False and rec[0]["id"] == "item:item_9"
    # Codex commands without item ids pair by command text.
    codex.feed({"type": "command", "status": "started", "command": "ls"}, 1)
    done = codex.feed({"type": "command", "status": "completed", "command": "ls", "exit_code": 0, "output": "a"}, 2)
    assert done[0]["id"] == "command:1" and done[0]["rev"] == 2 and done[0]["status"] == "ok"


# ── Direct chat delivery ─────────────────────────────────────────────────────


async def test_direct_turn_reaches_cli_once_across_delivery_retry():
    sandbox = LocalCodeSessionSandbox("claude", gate_first_turn=True)
    try:
        await sandbox.start()
        observer = SessionObserver(sandbox.ws_url)
        await observer.start()
        first = await deliver_user_turn_to_code_session(
            sandbox.ws_url, task_id="t", text="also add a docstring", turn_id="client-msg-1", token=TEST_TURN_TOKEN
        )
        # A Temporal retry (or the backend route retried by the browser) reuses the id.
        retry = await deliver_user_turn_to_code_session(
            sandbox.ws_url, task_id="t", text="also add a docstring", turn_id="client-msg-1", token=TEST_TURN_TOKEN
        )
        assert (first.status, retry.status) == ("delivered", "duplicate"), (first, retry)
        assert first.reached_cli and retry.reached_cli
        sandbox.finish_first_turn()
        await observer.wait_for(lambda: observer.count("result") >= 2)
        texts = [line["message"]["content"][0]["text"] for line in sandbox.cli_stdin_lines()]
        assert texts.count("also add a docstring") == 1, texts
        assert observer.count("user_turn") == 1
        await hand_back_code_session(sandbox.ws_url, task_id="t", token=TEST_TURN_TOKEN)
        await observer.wait_for(lambda: observer.exit_code is not None)
        await observer.close()
    finally:
        sandbox.stop()


async def test_direct_turn_requires_the_session_token():
    sandbox = LocalCodeSessionSandbox("claude", gate_first_turn=True)
    try:
        await sandbox.start()
        missing = await deliver_user_turn_to_code_session(
            sandbox.ws_url, task_id="t", text="hi", turn_id="no-token", token="", attempts=1
        )
        wrong = await deliver_user_turn_to_code_session(
            sandbox.ws_url,
            task_id="t",
            text="hi",
            turn_id="bad-token",
            token=code_session_turn_token("t", "other"),
            attempts=1,
        )
        assert (missing.status, missing.reason) == ("rejected", "unauthorized")
        assert (wrong.status, wrong.reason) == ("rejected", "unauthorized")
        await asyncio.sleep(0.2)
        texts = [line["message"]["content"][0]["text"] for line in sandbox.cli_stdin_lines()]
        assert "hi" not in texts and len(texts) <= 1, texts  # at most the goal
        assert control_ws_url("wss://3000-sb.e2b.app/?x=1") == "wss://3000-sb.e2b.app/?x=1&replay=0"
    finally:
        sandbox.stop()


async def test_agent_relay_paused_while_user_holds_session():
    sandbox = LocalCodeSessionSandbox("claude", gate_first_turn=True)
    try:
        await sandbox.start()
        observer = SessionObserver(sandbox.ws_url)
        await observer.start()
        user = await deliver_user_turn_to_code_session(
            sandbox.ws_url, task_id="t", text="use tabs not spaces", turn_id="u1", token=TEST_TURN_TOKEN
        )
        relayed = await deliver_user_turn_to_code_session(
            sandbox.ws_url,
            task_id="t",
            text="ROSE: also bump the version",
            turn_id="a1",
            sender="agent",
            token=TEST_TURN_TOKEN,
        )
        assert user.status == "delivered" and (relayed.status, relayed.reason) == ("rejected", "relay_paused")
        assert await hand_back_code_session(sandbox.ws_url, task_id="t", token=TEST_TURN_TOKEN) == "released"
        # After the hand back the same relayed turn goes through (the turn is still running).
        resumed = await deliver_user_turn_to_code_session(
            sandbox.ws_url,
            task_id="t",
            text="ROSE: also bump the version",
            turn_id="a1",
            sender="agent",
            token=TEST_TURN_TOKEN,
        )
        assert resumed.status == "delivered", resumed
        sandbox.finish_first_turn()
        await observer.wait_for(lambda: observer.exit_code is not None)
        texts = [line["message"]["content"][0]["text"] for line in sandbox.cli_stdin_lines()]
        assert texts[1:] == ["use tabs not spaces", "ROSE: also bump the version"], texts
        assert [e.get("sender") for e in observer.events if e.get("type") == "user_turn"] == ["user", "agent"]
        await observer.close()
    finally:
        sandbox.stop()


async def test_turn_merged_into_running_turn_still_ends_the_session():
    """Claude Code folds a turn written mid-turn into the running turn: one result, empty queue.

    Counting one result per written turn left stdin open forever after that
    single result (the CLI never exits, the session hangs). The ws-server must
    follow the CLI's `queued_turn_count` instead.
    """
    sandbox = LocalCodeSessionSandbox("claude", gate_first_turn=True, extra_env={"REPLAY_CLI_MERGE": "1"})
    try:
        await sandbox.start()
        observer = SessionObserver(sandbox.ws_url)
        await observer.start()
        await observer.wait_for(lambda: observer.count("session") >= 1)
        relayed = await deliver_user_turn_to_code_session(
            sandbox.ws_url,
            task_id="t",
            text="ROSE: use port 4242",
            turn_id="a-merge",
            sender="agent",
            token=TEST_TURN_TOKEN,
        )
        assert relayed.status == "delivered", relayed
        sandbox.finish_first_turn()
        await observer.wait_for(lambda: observer.exit_code is not None, timeout=10)
        assert observer.exit_code == 0, sandbox.log()
        results = [e for e in observer.events if e.get("type") == "result"]
        assert [r.get("pending_turns") for r in results] == [0], results
        texts = [line["message"]["content"][0]["text"] for line in sandbox.cli_stdin_lines()]
        assert texts[1:] == ["ROSE: use port 4242"], texts
        await observer.close()
    finally:
        sandbox.stop()


async def test_direct_turn_first_token_latency_local_sandbox():
    """Typed turn → first streamed token, 10 turns, real ws-server (plumbing share of the 3 s bar)."""
    samples = await measure_sandbox(10)
    assert len(samples) == 10
    assert statistics.median(samples) < 0.5, samples
    assert first_token_index([(0.0, {"kind": "message_start"}), (1.0, {"kind": "text"})], 0) == 1


# ── The monitoring activity during direct chat ───────────────────────────────


class _TranscriptSink:
    def __init__(self) -> None:
        self.batches: list[dict[str, Any]] = []

    async def save(self, **kwargs: Any) -> bool:
        self.batches.append(kwargs)
        return True

    def revisions(self) -> list[tuple[str, int]]:
        return [(r["id"], r["rev"]) for batch in self.batches for r in batch["records"]]


async def _run_loop(service: Any, ws_url: str, sink: _TranscriptSink, code_session: Optional[dict[str, Any]] = None):
    from utils.terminal_filter import TerminalFilter

    return await service._run_agentic_loop(
        agent_id="agent-1",
        task_id="task-1",
        sandbox_id="sb-1",
        goal="Fix the bug",
        ws_url=ws_url,
        terminal=TerminalFilter(cols=120, rows=40),
        model="rose-labs/rose-1-flash",
        claude_token=None,
        action_summary=[],
        tool_call_id="tc-1",
        code_session=code_session,
    )


async def test_monitor_keeps_held_session_open_and_never_writes_to_cli():
    from domains.spawn_claude_code_agent import service

    sandbox = LocalCodeSessionSandbox("claude", gate_first_turn=True)
    sink = _TranscriptSink()
    try:
        await sandbox.start()
        with (
            patch.object(service, "SDK_POST_RESULT_EXIT_GRACE_S", 0.3),
            patch.object(service, "SDK_IDLE_TIMEOUT_S", 0.3),
            patch.object(service, "TRANSCRIPT_FLUSH_INTERVAL_S", 0.0),
            patch.object(service, "save_claude_code_message", AsyncMock()),
            patch.object(service, "save_code_transcript_batch", side_effect=sink.save),
            patch.object(service, "_log_code_agent_event", lambda event, **kw: None),
            patch.object(service, "activity_drain_reason", AsyncMock(return_value=None)),
            patch("temporalio.activity.heartbeat"),
        ):
            loop = asyncio.create_task(_run_loop(service, sandbox.ws_url, sink))
            await asyncio.sleep(0.3)
            held = await deliver_user_turn_to_code_session(
                sandbox.ws_url, task_id="task-1", text="rename add to plus", turn_id="u1", token=TEST_TURN_TOKEN
            )
            assert held.status == "delivered"
            sandbox.finish_first_turn()
            # Both results land, then several post-result grace / idle windows pass.
            await asyncio.sleep(2.0)
            assert not loop.done(), "the monitor ended a session the user is still chatting with"
            assert await hand_back_code_session(sandbox.ws_url, task_id="task-1", token=TEST_TURN_TOKEN) == "released"
            exit_code, _attempt, _history, _in, _out, events = await asyncio.wait_for(loop, timeout=15)
        assert exit_code == 0
        assert [e["type"] for e in events if e["type"] in ("direct_chat", "user_turn", "result")] == [
            "direct_chat",
            "user_turn",
            "result",
            "result",
            "direct_chat",
        ]
        # Only the goal and the user's turn ever reached the CLI: no relay.
        texts = [line["message"]["content"][0]["text"] for line in sandbox.cli_stdin_lines()]
        assert texts == ["Task:\nFix the bug in calc.py so test_calc.py passes", "rename add to plus"], texts
        revisions = sink.revisions()
        assert len(revisions) == len(set(revisions)), revisions  # each record revision persisted once
        persisted = {r["id"]: r for batch in sink.batches for r in batch["records"]}
        users = [r for r in persisted.values() if r["type"] == "message" and r["role"] == "user"]
        assert [(u["sender"], u["text"]) for u in users] == [("agent", "Fix the bug"), ("user", "rename add to plus")]
        assert any(
            r["type"] == "message" and r["role"] == "assistant" and r["text"] == "echo: rename add to plus"
            for r in persisted.values()
        )
        ranges = [(b["events_from"], b["events_to"]) for b in sink.batches]
        assert all(a < b for a, b in ranges) and all(ranges[i][1] == ranges[i + 1][0] for i in range(len(ranges) - 1))
    finally:
        sandbox.stop()


class _ReplayWsClient:
    """Stand-in ws client that replays a fixed event history, then exits."""

    history: list[dict[str, Any]] = []

    def __init__(
        self,
        ws_url,
        on_output,
        on_exit,
        on_connection_change,
        on_stdin_error,
        on_event=None,
        heartbeat_fn=None,
        on_events_replay=None,
    ):
        self.on_exit = on_exit
        self.on_events_replay = on_events_replay
        self.reconnects_exhausted = False

    async def connect(self):
        return True

    async def disconnect(self):
        return None

    async def listen(self):
        await self.on_events_replay(list(self.history))
        await self.on_exit(0)


async def test_transcript_batches_persist_once_across_reattach():
    from domains.spawn_claude_code_agent import service

    events = json.loads(CLAUDE_EVENTS.read_text())
    cut = next(i for i, e in enumerate(events) if e["type"] == "tool_use" and e.get("tool") == "Edit")
    code_session: dict[str, Any] = {}
    sink = _TranscriptSink()
    with (
        patch.object(service, "ClaudeCodeWsClient", _ReplayWsClient),
        patch.object(service, "save_claude_code_message", AsyncMock()),
        patch.object(service, "save_code_transcript_batch", side_effect=sink.save),
        patch.object(service, "_log_code_agent_event", lambda event, **kw: None),
        patch.object(service, "activity_drain_reason", AsyncMock(return_value=None)),
        patch("temporalio.activity.heartbeat"),
    ):
        _ReplayWsClient.history = events[: cut + 1]
        await _run_loop(service, "ws://replay", sink, code_session)
        assert code_session["transcript_events"] == cut + 1
        first_pass = len(sink.batches)
        # The next attempt reattaches to the same sandbox and gets its whole history again.
        _ReplayWsClient.history = events
        await _run_loop(service, "ws://replay", sink, code_session)
    assert code_session["transcript_events"] == len(events)
    later = sink.batches[first_pass:]
    assert later and later[0]["events_from"] == cut + 1
    revisions = sink.revisions()
    assert len(revisions) == len(set(revisions)), "a reattach re-persisted records already saved"
    persisted: dict[str, dict[str, Any]] = {}
    for batch in sink.batches:
        for record in batch["records"]:
            if record["rev"] >= persisted.get(record["id"], {}).get("rev", 0):
                persisted[record["id"]] = record
    expected = {r["id"]: r for r in build_code_transcript(events, "claude", goal="Fix the bug")}
    assert persisted.keys() == expected.keys()
    assert all(persisted[k]["rev"] == expected[k]["rev"] for k in expected)
    # The Edit tool row was first saved running, then its result in the second pass.
    edit_id = next(k for k, r in expected.items() if r.get("name") == "Edit")
    assert [r["tool"]["result"]["status"] for b in sink.batches for r in b["records"] if r["id"] == edit_id] == [
        "running",
        "ok",
    ]


async def run_all_tests():
    print("code-session-direct-chat blackbox tests:")
    r = BlackboxResult()
    await r.record_async(
        "claude_recording_through_ws_server_matches_event_fixture",
        test_claude_recording_through_ws_server_matches_event_fixture,
    )
    await r.record_async(
        "codex_recording_through_ws_server_matches_event_fixture",
        test_codex_recording_through_ws_server_matches_event_fixture,
    )
    r.record("claude_transcript_records_from_fixture", test_claude_transcript_records_from_fixture)
    r.record("ui_records_follow_the_transcript_tab_contract", test_ui_records_follow_the_transcript_tab_contract)
    r.record("codex_transcript_records_from_fixture", test_codex_transcript_records_from_fixture)
    r.record(
        "transcript_builder_handles_legacy_and_codex_reasoning_events",
        test_transcript_builder_handles_legacy_and_codex_reasoning_events,
    )
    await r.record_async(
        "direct_turn_reaches_cli_once_across_delivery_retry", test_direct_turn_reaches_cli_once_across_delivery_retry
    )
    await r.record_async("direct_turn_requires_the_session_token", test_direct_turn_requires_the_session_token)
    await r.record_async(
        "agent_relay_paused_while_user_holds_session", test_agent_relay_paused_while_user_holds_session
    )
    await r.record_async(
        "turn_merged_into_running_turn_still_ends_the_session",
        test_turn_merged_into_running_turn_still_ends_the_session,
    )
    await r.record_async(
        "direct_turn_first_token_latency_local_sandbox", test_direct_turn_first_token_latency_local_sandbox
    )
    await r.record_async(
        "monitor_keeps_held_session_open_and_never_writes_to_cli",
        test_monitor_keeps_held_session_open_and_never_writes_to_cli,
    )
    await r.record_async(
        "transcript_batches_persist_once_across_reattach", test_transcript_batches_persist_once_across_reattach
    )
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(run_all_tests())
