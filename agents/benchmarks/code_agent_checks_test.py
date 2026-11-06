"""Offline proofs for the code-agent benchmark checks (benchmarks/code_agent_checks/).

Registered in the permanent gate by agents/tests/blackbox/benchmark.blackbox.py
(test_code_agent_checks_are_in_permanent_gate). Each new code_agent_* check adds
its pass and fail cases here.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from benchmarks import code_agent_checks
from benchmarks.code_agent_checks import evidence as ev
from benchmarks.code_agent_checks import one_session_per_spawn, startup_time
from benchmarks.long_horizon import RUNTIME_STATIC_CHECK_TYPES
from benchmarks.run_benchmark import _run_declared_static_check
from benchmarks.select_predeploy_benches import DEFAULT_CATALOG, load_tasks, select_predeploy_benches

TASK = "code-agent-rose-repo"
T0 = datetime(2026, 11, 6, 4, 16, 33, tzinfo=timezone.utc)
AGENT = "1a3d495c-826c-4eca-afe0-382fcbf72e82"
TASK_ID = "dd8ef6a8-84cb-4772-bebc-1356535e920d"


def _worker(event: str, seconds: float, **fields) -> str:
    at = (T0 + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")
    return json.dumps({"event": event, "timestamp": at, "agent_id": AGENT, **fields})


# Real prod backend lines of root 1a3d495c's first create (Render, 2026-11-06).
PROD_BACKEND_LINES = [
    '{"timestamp":"2026-11-06T04:16:34.709Z","level":"info","component":"ClaudeCode","message":"Creating session for agent 1a3d495c-826c-4eca-afe0-382fcbf72e82"}',
    '{"timestamp":"2026-11-06T04:16:34.814Z","level":"info","component":"E2B","message":"Creating Claude Code session for agent 1a3d495c-826c-4eca-afe0-382fcbf72e82"}',
    '{"timestamp":"2026-11-06T04:16:35.516Z","level":"info","component":"E2B","message":"Using sandbox: it9575l3txdpk8t8mybo1 (new)"}',
    '{"timestamp":"2026-11-06T04:18:55.117Z","level":"info","component":"ProjectWorkspace","message":"Restored project workspace","sessionId":"dd8ef6a8-84cb-4772-bebc-1356535e920d","projectId":"1ec468d5-95dc-4754-a385-1c9abe784cd4","revision":1,"source":"remote","files":6,"warnings":0}',
    '{"timestamp":"2026-11-06T04:18:55.117Z","level":"info","component":"E2B","message":"Waiting for WebSocket server to start"}',
    '{"timestamp":"2026-11-06T04:18:56.496Z","level":"info","component":"E2B","message":"WebSocket server ready in 1378ms"}',
    '{"timestamp":"2026-11-06T04:19:06.498Z","level":"warn","component":"CodePreviewSandbox","message":"Rose-in-Rose preview autostart failed","sandboxId":"it9575l3txdpk8t8mybo1","error":"[deadline_exceeded] the operation timed out"}',
    '{"timestamp":"2026-11-06T04:19:06.522Z","level":"info","component":"E2B","message":"Session ready: dd8ef6a8-84cb-4772-bebc-1356535e920d, WS: wss://3000-it9575l3txdpk8t8mybo1.e2b.app"}',
]
# A local (dev pretty) create of an empty checkout, run e55d7a42 on 2026-11-06.
DEV_BACKEND_LINES = [
    "\x1b[36m[2026-11-06T04:38:06.018Z] INFO [ClaudeCode] Creating session for agent acad4658-ebe4-4d9f-b26d-f9503b7f29d5 attachments=undefined github_repo=undefined\x1b[0m",
    "\x1b[36m[2026-11-06T04:38:06.050Z] INFO [E2B] Creating Claude Code session for agent acad4658-ebe4-4d9f-b26d-f9503b7f29d5\x1b[0m",
    "\x1b[36m[2026-11-06T04:38:07.513Z] INFO [E2B] Using sandbox: i3ut9z1jq57znq885szur (new)\x1b[0m",
    "\x1b[36m[2026-11-06T04:38:08.675Z] INFO [ProjectWorkspace] Restored project workspace sessionId=5fc86bd6-5820-4270-83c4-7ff02547f684 projectId=9f3e1246-c6ae-4aca-bb45-fcab907b5fab revision=0 source=empty files=0 warnings=0\x1b[0m",
    "\x1b[36m[2026-11-06T04:38:09.993Z] INFO [E2B] WebSocket server ready in 1317ms\x1b[0m",
    "\x1b[36m[2026-11-06T04:38:10.072Z] INFO [CodePreviewSandbox] Started Rose-in-Rose preview sandboxId=i3ut9z1jq57znq885szur\x1b[0m",
    "\x1b[36m[2026-11-06T04:38:10.079Z] INFO [E2B] Session ready: 5fc86bd6-5820-4270-83c4-7ff02547f684, WS: wss://3000-i3ut9z1jq57znq885szur.e2b.app\x1b[0m",
]


def _backend(checkout: str | None = "remote", project: str | None = "proj-rose") -> dict:
    (create,) = ev.backend_creates(PROD_BACKEND_LINES, [AGENT])
    return {**create, "checkoutSource": checkout, "projectId": project}


def _worker_lines(*, ready: bool = True, retries: int = 0) -> list[str]:
    lines = [_worker(ev.WORKER_CREATE, 0.0)]
    lines += [_worker(ev.WORKER_CREATE, 60.0 * (i + 1)) for i in range(retries)]
    lines.append(_worker(ev.WORKER_CREATED, 153.0, task_id=TASK_ID))
    lines.append(_worker(ev.WORKER_EVENT, 300.0, task_id=TASK_ID, event_type="session", status="starting"))
    if ready:
        lines.append(_worker(ev.WORKER_EVENT, 303.5, task_id=TASK_ID, event_type="session", status=None))
        lines.append(_worker(ev.WORKER_EVENT, 312.0, task_id=TASK_ID, event_type="agent_message"))
    return lines


def _evidence(**kwargs) -> dict:
    backend = kwargs.pop("backend", _backend())
    spawns = ev.build_spawns(ev._worker_entries(_worker_lines(**kwargs)), [backend] if backend else [])
    return {"agent_ids": [AGENT], "spawns": spawns, "sources": {}}


def test_backend_creates_split_prod_json_lines_by_phase():
    (create,) = ev.backend_creates(PROD_BACKEND_LINES, [AGENT, "someone-else"])
    assert create["taskId"] == TASK_ID and create["sandboxId"] == "it9575l3txdpk8t8mybo1"
    assert create["checkoutSource"] == "remote" and create["previewStarted"] is False
    assert create["phases_ms"] == {
        "slot_wait": 105.0,
        "sandbox": 702.0,
        "workspace": 139601.0,
        "ws_ready": 1379.0,
        "preview": 10002.0,
        "record": 24.0,
    }
    assert create["total_ms"] == 151813.0
    assert ev.backend_creates(PROD_BACKEND_LINES, ["someone-else"]) == []


def test_backend_creates_parse_dev_pretty_lines():
    (create,) = ev.backend_creates(DEV_BACKEND_LINES, ["acad4658-ebe4-4d9f-b26d-f9503b7f29d5"])
    assert create["checkoutSource"] == "empty" and create["previewStarted"] is True
    assert create["phases_ms"]["workspace"] == 1162.0 and create["total_ms"] == 4061.0


def test_spawn_phases_split_create_project_startup_and_cli_init():
    (spawn,) = _evidence()["spawns"]
    phases = startup_time.spawn_phases(spawn)
    assert phases["create"] == 153000.0
    assert phases["project_startup"] == 147000.0
    assert phases["cli_init"] == 3500.0
    assert phases["ready"] == 303500.0
    assert phases["first_output"] == 8500.0
    assert phases["backend.workspace"] == 139601.0
    assert spawn["create_attempts"] == 1
    json.dumps(spawn)  # run records are JSON


def test_startup_measures_from_the_first_create_attempt():
    (spawn,) = _evidence(retries=2)["spawns"]
    assert spawn["create_attempts"] == 3
    assert startup_time.spawn_phases(spawn)["create"] == 153000.0


def test_startup_check_passes_within_budget_and_reports_every_phase():
    ok, reason = startup_time.check(_evidence(), {"max_ready_seconds": 600})
    assert ok, reason
    for phase in ("create 153.0s", "workspace=139.6s", "sandbox=0.7s", "project_startup 147.0s", "cli_init 3.5s", "checkout=remote"):
        assert phase in reason


def test_startup_check_fails_over_budget():
    ok, reason = startup_time.check(_evidence(), {"max_ready_seconds": 300})
    assert not ok and "ready 303.5s > budget 300s" in reason


def test_startup_check_fails_when_cli_never_ready():
    ok, reason = startup_time.check(_evidence(ready=False), {"max_ready_seconds": 600})
    assert not ok and "never reached CLI ready" in reason


def test_startup_check_fails_outside_a_project_checkout():
    for backend in (None, _backend(checkout="empty"), _backend(project=None)):
        ok, reason = startup_time.check(_evidence(backend=backend), {"max_ready_seconds": 600})
        assert not ok and "did not start in a project checkout" in reason


def test_startup_check_fails_closed_without_spawns_or_budget():
    assert not startup_time.check({"spawns": [], "sources": {}}, {"max_ready_seconds": 600})[0]
    assert not startup_time.check(_evidence(), {})[0]


def test_every_code_agent_check_is_registered_and_dispatched():
    assert code_agent_checks.CHECK_TYPES
    for check_type in code_agent_checks.CHECK_TYPES:
        assert check_type.startswith("code_agent_")
        assert check_type in RUNTIME_STATIC_CHECK_TYPES
    data = {"_benchmark": {code_agent_checks.EVIDENCE_KEY: _evidence()}}
    evaluator = {"method": "static_check", "checks": [{"type": startup_time.CHECK_TYPE, "max_ready_seconds": 600}]}
    assert _run_declared_static_check(evaluator, data) == (True, "All declared static checks passed")
    assert not _run_declared_static_check(evaluator, {"_benchmark": {}})[0]


def test_code_agent_task_declares_startup_check_and_runs_on_every_deploy(tmp_path):
    task = {task.name: task for task in load_tasks(DEFAULT_CATALOG)}[TASK]
    assert task.raw["project"] == "Rose" and task.raw["requires_claude_code"] is True
    assert task.is_smoke and code_agent_checks.declares_check(task.raw["evaluators"])
    no_history = tmp_path / "attempts.jsonl"
    no_history.write_text("")
    for surface in ("local", "cloud"):
        selection = select_predeploy_benches(
            catalog=DEFAULT_CATALOG, changed_files=[], surface=surface, attempts_file=no_history
        )
        assert TASK in selection.floor, (surface, selection.floor)


def _session_evidence(rows: int, calls: int = 1) -> dict:
    return {
        "spawn_calls_by_agent": {AGENT: [f"call-{i}" for i in range(calls)]},
        "sessions_by_agent": {AGENT: [{"id": f"row-{i}"} for i in range(rows)]} if rows else {},
        "backend_creates": [{"agentId": AGENT}] * rows,
        "sources": {},
    }


def test_one_session_per_spawn_flags_the_prod_duplicate_creates():
    assert one_session_per_spawn.check(_session_evidence(rows=1), {})[0]
    assert one_session_per_spawn.check(_session_evidence(rows=2, calls=2), {})[0]
    ok, reason = one_session_per_spawn.check(_session_evidence(rows=3), {})
    assert not ok and "3 ClaudeCodeSession row(s) for 1 spawn call(s)" in reason


def test_one_session_per_spawn_fails_closed_without_evidence():
    assert not one_session_per_spawn.check(_session_evidence(rows=0), {})[0]
    assert not one_session_per_spawn.check(_session_evidence(rows=1, calls=0), {})[0]


def test_spawn_calls_are_distinct_tool_call_ids_of_the_spawn_tool():
    messages = [
        {"metadata": {"toolName": "spawn_claude_code_agent", "toolCallId": "a", "toolStatus": "IN_PROGRESS"}},
        {"metadata": json.dumps({"toolName": "spawn_claude_code_agent", "toolCallId": "a"})},
        {"metadata": {"toolName": "spawn_claude_code_agent", "toolCallId": "b"}},
        {"metadata": {"toolName": "spawn_agent", "toolCallId": "c"}},
    ]
    assert ev.spawn_calls_by_agent({"messages": messages}, [AGENT]) == {AGENT: ["a", "b"]}


def test_external_lane_checks_are_called_by_name_from_their_module(monkeypatch):
    import sys
    import types

    calls = {}

    def check_single_code_agent(run, expected=1):
        calls["single"] = (run, expected)
        return {"passed": run["code_agents"] == ["one"], "detail": f"{len(run['code_agents'])} code agent(s)"}

    fake = types.ModuleType("benchmarks.code_agent_run_checks")
    fake.check_single_code_agent = check_single_code_agent
    monkeypatch.setitem(sys.modules, "benchmarks.code_agent_run_checks", fake)
    module = code_agent_checks.EXTERNAL_CHECKS["code_agent_single_code_agent"][0]
    check = {"type": "code_agent_single_code_agent", "expected": 1}
    data = {"_benchmark": {code_agent_checks.EVIDENCE_KEY: {"run": {module: {"code_agents": ["one"]}}}}}
    assert code_agent_checks.run_check(data, check) == (True, "code_agent_single_code_agent: 1 code agent(s)")
    assert calls["single"] == ({"code_agents": ["one"]}, 1)
    data["_benchmark"][code_agent_checks.EVIDENCE_KEY]["run"][module] = {"code_agents": ["a", "b"]}
    assert not code_agent_checks.run_check(data, check)[0]


def test_external_lane_checks_fail_closed_without_their_module_or_evidence(monkeypatch):
    import sys

    monkeypatch.setitem(sys.modules, "benchmarks.code_agent_run_checks", None)
    module = code_agent_checks.EXTERNAL_CHECKS["code_agent_message_reached"][0]
    check = {"type": "code_agent_message_reached"}
    for run in ({}, {module: {"error": "HTTPStatusError: 404"}}, {module: {"messages": []}}):
        data = {"_benchmark": {code_agent_checks.EVIDENCE_KEY: {"run": run}}}
        assert not code_agent_checks.run_check(data, check)[0]


def test_retried_create_keeps_the_first_create_as_the_spawn_checkout():
    """Run 152dfdf3: the worker's task id came from a retry on the paused sandbox (source=existing)."""
    retry = {**_backend(checkout="existing"), "taskId": "retry-task", "requestedAt": "2026-11-06T04:17:37.125+00:00"}
    spawns = ev.build_spawns(ev._worker_entries(_worker_lines(retries=2)), [_backend(), retry])
    (spawn,) = spawns
    assert spawn["backend_creates"] == 2 and spawn["backend"]["checkoutSource"] == "remote"
    ok, reason = startup_time.check({"spawns": spawns}, {"max_ready_seconds": 600})
    assert ok and "backend_creates 2" in reason, reason


def test_collect_keeps_per_phase_startup_for_the_run_record(monkeypatch):
    import asyncio

    monkeypatch.setattr(ev, "fetch_local_worker_logs", lambda agent_id: _worker_lines())
    monkeypatch.setattr(ev, "fetch_local_backend_log_lines", lambda needles: PROD_BACKEND_LINES)
    monkeypatch.setattr(ev, "record_startup_spans", lambda *a, **k: 0)

    async def no_sessions(data):
        data.setdefault("_benchmark", {})["claude_code_sessions"] = []

    import benchmarks.run_benchmark as rb

    monkeypatch.setattr(rb, "_hydrate_claude_code_sessions", no_sessions)
    data = {"agent": {"agent_id": AGENT}, "messages": []}
    evidence = asyncio.run(ev.collect(data, benchmark=TASK, base_url="http://localhost:1"))
    (phases,) = evidence["startup_phases"]
    assert phases["phases_ms"]["ready"] == 303500.0 and phases["phases_ms"]["backend.workspace"] == 139601.0
    assert phases["checkout_source"] == "remote" and phases["backend_creates"] == 1
    json.dumps(evidence)  # persisted in the run record
