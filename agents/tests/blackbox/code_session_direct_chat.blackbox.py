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
    turn_ids = {}
    for event in events:
        turn_id = event.get("turn_id")
        if isinstance(turn_id, str) and turn_id not in turn_ids:
            turn_ids[turn_id] = f"native-turn-{len(turn_ids) + 1}"
    timeless = []
    for event in events:
        item = {key: value for key, value in event.items() if key not in ("timestamp", "turn_started_at", "turn_ended_at")}
        if item.get("turn_id") in turn_ids:
            item["turn_id"] = turn_ids[item["turn_id"]]
        timeless.append(item)
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


# The viewer socket of a loaded or instrumented test process attaches this long
# after the ws-server listens. A stand-in CLI that streams meanwhile hands that
# viewer the bounded replay instead of the live frames (see
# test_late_viewer_replay_drops_only_superseded_partial_text), so the fixture
# comparison below must not depend on how fast the viewer attaches.
VIEWER_ATTACH_LAG_S = 0.5


async def _claude_session_with_direct_turn(sandbox: LocalCodeSessionSandbox) -> SessionObserver:
    """Turn 1 replays while gated; the user's turn lands mid-turn; hand back ends the run."""
    await sandbox.start()
    await asyncio.sleep(VIEWER_ATTACH_LAG_S)
    observer = SessionObserver(sandbox.ws_url)
    await observer.start()
    # Attached: the server now registers this socket for live frames, so the
    # held stand-in CLI may start streaming. Every recorded event reaches the
    # viewer live, whatever the attach lag was.
    sandbox.release_first_turn_output()
    # The stand-in CLI holds turn 1's `result` at the gate; wait until every
    # event before it is out so the user's turn lands at a fixed position.
    # Streamed text now creates many partial upserts. Wait for the final
    # native usage snapshot before injecting the external user turn, otherwise
    # its order races the remaining recorded CLI events on a busy host.
    expected_usage = 0
    for line in CLAUDE_RAW.read_text().splitlines():
        raw = json.loads(line)
        if raw.get("type") == "result":
            break
        event = raw.get("event") or {}
        if raw.get("type") == "stream_event" and (
            isinstance(event.get("usage"), dict) or
            (event.get("type") == "message_start" and isinstance((event.get("message") or {}).get("usage"), dict))
        ):
            expected_usage += 1
    await observer.wait_for(lambda: observer.count("tool_result") >= 4 and observer.count("usage") >= expected_usage)
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
    sandbox = LocalCodeSessionSandbox(
        "claude", fixture=CLAUDE_RAW, gate_first_turn=True, hold_first_turn_output=True, goal=CLAUDE_GOAL
    )
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


async def test_late_viewer_replay_drops_only_superseded_partial_text():
    """The two views of one session differ in exactly one documented way.

    A viewer attached from the start receives every cumulative partial snapshot
    live (the committed event fixture). A viewer that attaches later is served
    the bounded replay, where each streamed item keeps only its latest
    snapshot's ``text``; superseded snapshots keep their ``delta``, so history
    grows with the output rather than its square. Nothing else may differ.
    """
    sandbox = LocalCodeSessionSandbox(
        "claude", fixture=CLAUDE_RAW, gate_first_turn=True, hold_first_turn_output=True, goal=CLAUDE_GOAL
    )
    live: Optional[SessionObserver] = None
    late: Optional[SessionObserver] = None
    try:
        live = await _claude_session_with_direct_turn(sandbox)
        assert live.exit_code == 0, sandbox.log()
        late = SessionObserver(sandbox.ws_url)
        await late.start()
        await late.wait_for(lambda: late.exit_code is not None)
        assert len(late.events) == len(live.events), (len(late.events), len(live.events))
        snapshots = [e for e in live.events if e.get("partial") is True and e.get("text")]
        assert len(snapshots) >= 4, "the recording must stream several text snapshots"
        compacted = 0
        for seen_live, replayed in zip(live.events, late.events):
            if seen_live == replayed:
                continue
            assert seen_live.get("partial") is True and seen_live.get("text"), (seen_live, replayed)
            assert replayed == {key: value for key, value in seen_live.items() if key != "text"}, (seen_live, replayed)
            assert replayed.get("delta") == seen_live.get("delta")
            compacted += 1
        # Every recorded item ends in a final block, so every snapshot was superseded.
        assert compacted == len(snapshots), (compacted, len(snapshots))
    finally:
        for observer in (live, late):
            if observer is not None:
                await observer.close()
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
    assert users[1]["client_message_id"] == "fixture-turn-2"
    assert users[1]["turn_id"] == "native-turn-1"

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
    assert all(t["id"].startswith("tool:toolu_") and t["rev"] >= 2 for t in tools)

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
    assert {r["type"] for r in ui} == {"message", "thinking", "tool", "result", "control", "turn", "metrics", "session"}
    # The code-agent view's query box: the CLI's model and speed (its init) and the
    # latest model call's context over the model's window (its nub).
    session = next(r for r in ui if r["type"] == "session")
    assert (session["model"], session["speed"]) == ("claude-sonnet-5", "standard")
    contexts = [r for r in ui if r["type"] == "metrics" and "context_tokens" in r]
    assert contexts and all(0 < r["context_tokens"] < r.get("context_window", 10**9) for r in contexts)
    assert any(r.get("context_window") == 1_000_000 for r in ui if r["type"] == "metrics")
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


async def _send_turn(sandbox: LocalCodeSessionSandbox, turn_id: str, text: str, sender: str = "agent"):
    return await deliver_user_turn_to_code_session(
        sandbox.ws_url, task_id="t", text=text, turn_id=turn_id, sender=sender, token=TEST_TURN_TOKEN
    )


async def test_agent_turns_before_the_cli_has_its_task_are_queued_and_follow_it_in_order_once():
    """C20: the ws-server is up but the CLI is not launched yet (a held project startup): an agent turn is
    acked queued (not refused), a retry stays queued, and once the CLI starts the turns follow the task
    prompt in arrival order, each written once."""
    # The CLI holds its first turn (gate_first_turn) so the session is alive when the late retry below is sent: the
    # fake CLI otherwise finishes and ends the session first under host load ("rejected: session_ended").
    sandbox = LocalCodeSessionSandbox("claude", gate_startup=True, gate_first_turn=True)
    try:
        await sandbox.start()
        observer = SessionObserver(sandbox.ws_url)
        await observer.start()
        first = await _send_turn(sandbox, "a-1", "ROSE: first")
        retry = await _send_turn(sandbox, "a-1", "ROSE: first")
        second = await _send_turn(sandbox, "a-2", "ROSE: second")
        assert (first.status, retry.status, second.status) == ("queued", "queued", "queued"), (first, retry, second)
        assert not first.reached_cli, "queued has not reached the CLI yet"
        # A user's direct turn carries settings that must be confirmed at once: told to retry, never queued.
        user = await _send_turn(sandbox, "u-1", "typed by the user", sender="user")
        assert (user.status, user.reason) == ("rejected", "session_starting"), user
        assert sandbox.cli_stdin_lines() == [], "nothing is written to a CLI that has no task yet"

        sandbox.start_cli()
        # The server has flushed both queued turns once it reports them; the held CLI logs a turn only when it reads it.
        await observer.wait_for(lambda: observer.count("user_turn") >= 2)
        # After the flush a retry of a queued id is a duplicate, not a second turn.
        late = await _send_turn(sandbox, "a-1", "ROSE: first")
        assert late.status == "duplicate", late
        sandbox.finish_first_turn()
        await observer.wait_for(lambda: len(sandbox.cli_stdin_lines()) >= 3)
        texts = [line["message"]["content"][0]["text"] for line in sandbox.cli_stdin_lines()]
        assert "Task:\n" in texts[0] and texts[1:] == ["ROSE: first", "ROSE: second"], texts
        await observer.wait_for(lambda: observer.exit_code is not None)
        texts = [line["message"]["content"][0]["text"] for line in sandbox.cli_stdin_lines()]
        assert texts.count("ROSE: first") == 1 and len(texts) == 3, texts
        assert observer.count("user_turn_queued") == 2 and observer.count("user_turn") == 2, observer.events
        assert observer.count("user_turn_undelivered") == 0
        await observer.close()
    finally:
        sandbox.stop()


async def test_startup_queue_is_bounded_and_a_session_that_ends_first_reports_the_loss():
    """C20: the startup queue holds at most 20 turns (the 21st is refused with a reason). A session that
    ends before its CLI is launched never delivers them: the server says which turns were lost
    (user_turn_undelivered), and later sends are refused or unreachable, never "queued"."""
    sandbox = LocalCodeSessionSandbox("claude", gate_startup=True)
    try:
        await sandbox.start()
        observer = SessionObserver(sandbox.ws_url)
        await observer.start()
        for index in range(20):
            sent = await _send_turn(sandbox, f"q-{index}", f"ROSE: waiting {index}")
            assert sent.status == "queued", (index, sent)
        over = await _send_turn(sandbox, "q-20", "ROSE: one too many")
        assert (over.status, over.reason) == ("rejected", "startup_queue_full"), over
        kept = await _send_turn(sandbox, "q-0", "ROSE: waiting 0")
        assert kept.status == "queued", "a retry of a queued id is still accepted"

        sandbox.end_session()
        await observer.wait_for(lambda: observer.exit_code is not None)
        lost = [event for event in observer.events if event.get("type") == "user_turn_undelivered"]
        assert len(lost) == 1 and lost[0]["turn_ids"] == [f"q-{index}" for index in range(20)], lost
        assert lost[0]["reason"] == "session_ended", lost
        for turn_id in ("q-3", "q-new"):
            # The server is gone: the sender is told so (rejected or unreachable), never "queued".
            after = await _send_turn(sandbox, turn_id, "ROSE: after the end")
            assert after.status in ("rejected", "unreachable"), (turn_id, after)
        assert sandbox.cli_stdin_lines() == [], "the CLI never got a turn"
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
            patch.object(service, "CODE_SESSION_IDLE_PAUSE_S", 0.3),
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


async def test_transcript_batch_row_carries_code_agent_events():
    """The persisted row the UI reads: child-scoped, idempotent, events under `code_agent_events`."""
    from _test_utils import get_captured_requests, setup_mock

    from domains.spawn_claude_code_agent.repo import save_code_transcript_batch

    events = json.loads(CODEX_EVENTS.read_text())
    records = [to_ui_record(r) for r in build_code_transcript(events, "codex", goal="Fix the bug")]
    setup_mock({"/api/agents/": {"status": 201, "json": {"id": "m1"}}})
    saved = await save_code_transcript_batch(
        agent_id="agent-1",
        task_id="task-9",
        tool_call_id="tc-9",
        code_provider="codex",
        records=records,
        events_from=0,
        events_to=len(events),
        text=render_transcript_text(build_code_transcript(events, "codex")),
    )
    assert saved is True
    posts = [
        c for c in get_captured_requests() if c.get("method") == "POST" and "/api/agents/agent-1/messages" in c["url"]
    ]
    assert len(posts) == 1, posts
    body = json.loads(posts[0]["requestBody"])
    meta = body["metadata"]
    assert body["role"] == "TOOL" and "[command ✗]" in body["message"]
    assert meta["action_type"] == "code_transcript" and meta["subAgentId"] == "task-9" and meta["toolCallId"] == "tc-9"
    assert meta["code_provider"] == "codex" and "toolStatus" not in meta
    assert meta["isCodeTranscript"] is True and meta["idempotencyKey"] == f"code-transcript:task-9:0-{len(events)}"
    assert meta["code_agent_events"] == records
    assert {r["type"] for r in meta["code_agent_events"]} >= {"message", "tool"}
    assert meta["transcript"] == {"version": 1, "task_id": "task-9", "provider": "codex", "events": [0, len(events)]}



async def test_claude_native_direct_chat_contract():
    process = await asyncio.create_subprocess_exec(
        "node", "--test", str(Path(__file__).resolve().parents[3] / "e2b-templates/claude-code/direct-chat.test.mjs"),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    output, _ = await process.communicate()
    assert process.returncode == 0, output.decode(errors="replace")


async def test_codex_native_app_server_contract():
    process = await asyncio.create_subprocess_exec(
        "node", "--test", str(Path(__file__).resolve().parents[3] / "e2b-templates/codex-code/app-server.test.mjs"),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    output, _ = await process.communicate()
    assert process.returncode == 0, output.decode(errors="replace")

def test_attachment_only_turn_and_distinct_steers_remain_visible():
    builder = CodeTranscriptBuilder("claude")
    builder.feed({"type":"turn_started", "turn_id":"native", "turn_started_at":"2026-10-20T00:00:00Z"}, 0)
    builder.feed({"type":"user_turn", "turn_id":"native", "client_message_id":"one", "text":"", "attachments":[{"name":"notes.txt"}]}, 1)
    builder.feed({"type":"user_turn", "turn_id":"native", "client_message_id":"two", "text":"steer"}, 2)
    builder.feed({"type":"usage", "turn_id":"native", "usage_scope":"turn", "output_tokens":12, "cached_input_tokens":0}, 3)
    builder.feed({"type":"usage", "turn_id":"native", "usage_scope":"turn", "output_tokens":16}, 4)
    builder.feed({"type":"turn_ended", "turn_id":"native", "turn_ended_at":"2026-10-20T00:00:02Z", "turn_outcome":"interrupted"}, 5)
    users = [to_ui_record(r) for r in builder.records if r.get("kind") == "user"]
    assert len(users) == 2 and users[0]["text"] == "Attached: notes.txt"
    assert [r["client_message_id"] for r in users] == ["one", "two"]
    assert {r["turn_id"] for r in users} == {"native"}
    assert users[0]["attachments"] == [{"name":"notes.txt"}]
    metrics = [to_ui_record(r) for r in builder.records if r.get("kind") == "metrics"]
    assert len(metrics) == 2 and metrics[0]["id"] != metrics[1]["id"]
    assert [m["output_tokens"] for m in metrics] == [12,16]
    assert metrics[0]["cached_input_tokens"] == 0
    assert "input_tokens" not in metrics[0] and metrics[0]["usage_scope"] == "turn"
    ended = next(to_ui_record(r) for r in builder.records if r.get("kind") == "turn")
    assert ended["turn_outcome"] == "interrupted" and ended["turn_ended_at"] == "2026-10-20T00:00:02Z"


def test_background_sub_agent_tool_row_stays_running_until_its_notification():
    """A Claude sub-agent launched in the background (Task/Agent run_in_background)
    returns `async_launched` at once; its row stays running (the code-agent view's
    agents drawer lists it) until the CLI's task_notification names its outcome."""
    builder = CodeTranscriptBuilder("claude")
    builder.feed({"type": "turn_started", "turn_id": "t", "turn_started_at": "2026-11-06T00:00:00Z"}, 0)
    for index, (tool_id, description) in enumerate((("toolu_bg", "Audit the open PRs"), ("toolu_fg", "Read the CI log")), 1):
        builder.feed({"type": "tool_use", "turn_id": "t", "tool": "Task", "tool_use_id": tool_id,
                      "input": {"description": description, "prompt": "go", "run_in_background": tool_id == "toolu_bg"}}, index)
    builder.feed({"type": "tool_result", "turn_id": "t", "tool_use_id": "toolu_bg", "is_error": False,
                  "tool_use_result": {"status": "async_launched", "agentId": "a1", "description": "Audit the open PRs"}}, 3)
    builder.feed({"type": "tool_result", "turn_id": "t", "tool_use_id": "toolu_fg", "is_error": False,
                  "tool_use_result": {"status": "completed", "content": []}}, 4)

    def status(tool_id: str) -> tuple[str, str]:
        record = to_ui_record(next(r for r in builder.records if r["id"] == f"tool:{tool_id}"))
        return record["tool"]["name"], record["tool"]["result"]["status"]

    assert status("toolu_bg") == ("Task", "running")
    assert status("toolu_fg") == ("Task", "ok")
    assert to_ui_record(next(r for r in builder.records if r["id"] == "tool:toolu_bg"))["tool"]["target"] == "Audit the open PRs"
    out = builder.feed({"type": "cli_message", "cli_message": {"type": "system", "subtype": "task_notification",
                        "task_id": "a1", "tool_use_id": "toolu_bg", "status": "failed"}}, 5)
    assert [r["id"] for r in out] == ["tool:toolu_bg"]
    assert status("toolu_bg") == ("Task", "error")
    # A notification for an already-finished or unknown tool changes nothing.
    assert builder.feed({"type": "cli_message", "cli_message": {"type": "system", "subtype": "task_notification",
                         "task_id": "a2", "tool_use_id": "toolu_fg", "status": "failed"}}, 6) == []
    assert status("toolu_fg") == ("Task", "ok")


async def run_all_tests():
    print("code-session-direct-chat blackbox tests:")
    r = BlackboxResult()
    r.record("attachment_only_turn_and_distinct_steers_remain_visible", test_attachment_only_turn_and_distinct_steers_remain_visible)
    r.record("background_sub_agent_tool_row_stays_running_until_its_notification", test_background_sub_agent_tool_row_stays_running_until_its_notification)
    await r.record_async("codex_native_app_server_contract", test_codex_native_app_server_contract)
    await r.record_async("claude_native_direct_chat_contract", test_claude_native_direct_chat_contract)
    await r.record_async(
        "claude_recording_through_ws_server_matches_event_fixture",
        test_claude_recording_through_ws_server_matches_event_fixture,
    )
    await r.record_async(
        "late_viewer_replay_drops_only_superseded_partial_text",
        test_late_viewer_replay_drops_only_superseded_partial_text,
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
    await r.record_async(
        "agent_turns_before_the_cli_has_its_task_are_queued_and_follow_it_in_order_once",
        test_agent_turns_before_the_cli_has_its_task_are_queued_and_follow_it_in_order_once,
    )
    await r.record_async(
        "startup_queue_is_bounded_and_a_session_that_ends_first_reports_the_loss",
        test_startup_queue_is_bounded_and_a_session_that_ends_first_reports_the_loss,
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
    await r.record_async(
        "transcript_batch_row_carries_code_agent_events", test_transcript_batch_row_carries_code_agent_events
    )
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(run_all_tests())
