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
from benchmarks.code_agent_checks import external
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


def test_a_resumed_spawn_keeps_its_session_checkout_but_a_fresh_empty_one_fails():
    """qual1 (be1c90da): the root's second spawn resumed the paused sandbox (checkout "existing")."""
    fresh = ev.build_spawns(ev._worker_entries(_worker_lines()), [_backend()])
    resumed_backend = {**_backend(checkout="existing"), "taskId": "second-task", "resumedFrom": "paused_sandbox",
                       "requestedAt": "2026-11-06T04:30:00+00:00"}
    resumed = [{**fresh[0], "task_id": "second-task", "backend": resumed_backend}]
    ok, reason = startup_time.check({"spawns": fresh + resumed}, {"max_ready_seconds": 600})
    assert ok, reason
    ok, reason = startup_time.check({"spawns": resumed}, {"max_ready_seconds": 600})
    assert not ok and "no spawn created a fresh sandbox" in reason
    empty_fresh = ev.build_spawns(ev._worker_entries(_worker_lines()), [_backend(checkout="empty")])
    ok, reason = startup_time.check({"spawns": empty_fresh + resumed}, {"max_ready_seconds": 600})
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


def test_code_agent_task_earns_its_deploy_slot_from_history_on_code_session_paths(tmp_path):
    """Not on the always-on smoke floor: a deploy_canary that a code-session change selects once it has 3 passes."""
    task = {task.name: task for task in load_tasks(DEFAULT_CATALOG)}[TASK]
    assert task.raw["project"] == "Rose" and task.raw["requires_claude_code"] is True
    assert not task.is_smoke and task.deploy_canary and task.deploy_category == "claude-code"
    assert code_agent_checks.declares_check(task.raw["evaluators"])
    attempts = tmp_path / "attempts.jsonl"

    def selected(changed, rows):
        attempts.write_text("".join(json.dumps(row) + "\n" for row in rows))
        return select_predeploy_benches(
            catalog=DEFAULT_CATALOG, changed_files=changed, surface="local", attempts_file=attempts
        )

    def attempt(passed, hour, counts=True):
        return {"task": TASK, "passed": passed, "counts_for_deploy_eligibility": counts,
                "timestamp": f"2026-11-06T{hour:02d}:00:00+00:00"}

    code_session_change = ["back-end/src/providers/e2bCodeSessionSandbox.ts"]
    cold = selected(code_session_change, [])
    assert TASK in cold.skipped_history and TASK not in cold.selected, (cold.skipped_history, cold.selected)
    broken = selected(code_session_change, [attempt(True, 1), attempt(True, 2), attempt(False, 3), attempt(True, 4)])
    assert TASK in broken.skipped_history and TASK not in broken.selected
    predeploy_only = selected(code_session_change, [attempt(True, h, counts=False) for h in (1, 2, 3)])
    assert TASK in predeploy_only.skipped_history, "predeploy attempts must not earn the slot"
    earned = selected(code_session_change, [attempt(True, h) for h in (1, 2, 3)])
    assert TASK in earned.selected and TASK not in earned.skipped_history
    unrelated = selected(["docs/unrelated.md"], [attempt(True, h) for h in (1, 2, 3)])
    assert TASK not in unrelated.selected


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


CTX = {
    "base_url": "http://localhost:3001",
    "user_id": "user-1",
    "root_agent_id": AGENT,
    "agent_ids": [AGENT, "child-1"],
    "frontend_url": "http://localhost:3002",
}


def _external_data(**evidence) -> dict:
    return {"_benchmark": {code_agent_checks.EVIDENCE_KEY: {"context": CTX, **evidence}}}


def _fake_module(monkeypatch, name, **attrs):
    import sys
    import types

    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    monkeypatch.setitem(sys.modules, name, module)
    return module


def test_every_lane_check_is_registered_with_its_kind():
    kinds = {t: s.kind for t, s in external.EXTERNAL.items()}
    assert kinds == {
        "code_agent_single_code_agent": "python_run",
        "code_agent_message_reached": "python_run",
        "code_agent_thinking_rows": "python_root",
        "code_agent_markdown": "script",
        "code_agent_render": "playwright",
        "code_agent_github_rate_limit": "python_github",
    }
    assert set(external.EXTERNAL) <= code_agent_checks.CHECK_TYPES <= RUNTIME_STATIC_CHECK_TYPES


def test_python_run_lane_check_is_called_by_name_with_its_hydrated_run(monkeypatch):
    calls = {}

    def check_single_code_agent(run, expected=1):
        calls["args"] = (run, expected)
        return {"passed": run["code_agents"] == ["one"], "detail": f"{len(run['code_agents'])} code agent(s)"}

    _fake_module(monkeypatch, "benchmarks.code_agent_run_checks", check_single_code_agent=check_single_code_agent)
    check = {"type": "code_agent_single_code_agent", "expected": 1}
    module = external.EXTERNAL[check["type"]].module
    data = _external_data(run={module: {"code_agents": ["one"]}})
    assert code_agent_checks.run_check(data, check) == (True, "code_agent_single_code_agent: 1 code agent(s)")
    assert calls["args"] == ({"code_agents": ["one"]}, 1)
    data = _external_data(run={module: {"code_agents": ["a", "b"]}})
    assert not code_agent_checks.run_check(data, check)[0]


def test_python_run_hydration_uses_the_lane_modules_own_hydrate(monkeypatch):
    import asyncio

    seen = {}

    async def hydrate_code_agent_run(base_url, api_key, user_id, root_agent_id):
        seen["args"] = (base_url, user_id, root_agent_id)
        return {"messages": [], "code_agents": []}

    _fake_module(monkeypatch, "benchmarks.code_agent_run_checks", hydrate_code_agent_run=hydrate_code_agent_run)
    monkeypatch.setattr(external, "_api_key", lambda: "secret-key")
    runs = asyncio.run(external.hydrate_runs({"benchmarks.code_agent_run_checks"}, CTX))
    assert runs == {"benchmarks.code_agent_run_checks": {"messages": [], "code_agents": []}}
    assert seen["args"] == (CTX["base_url"], "user-1", AGENT)


def test_python_root_lane_check_gets_the_root_and_the_run_context(monkeypatch):
    seen = {}

    def check_thinking_rows(root_agent_id, *, base_url, api_key, user_id, **config):
        seen.update(root=root_agent_id, base_url=base_url, user_id=user_id, key=api_key, config=config)
        ok = config.get("ok", True)
        return {"passed": ok, "report": {"tok_s": 42}, "failures": [] if ok else ["root has no generation"]}

    _fake_module(monkeypatch, "benchmarks.thinking_rows_check", check_thinking_rows=check_thinking_rows)
    monkeypatch.setattr(external, "_api_key", lambda: "k")
    ok, reason = code_agent_checks.run_check(_external_data(), {"type": "code_agent_thinking_rows"})
    assert ok and '"tok_s": 42' in reason
    assert seen == {"root": AGENT, "base_url": CTX["base_url"], "user_id": "user-1", "key": "k", "config": {}}
    ok, reason = code_agent_checks.run_check(_external_data(), {"type": "code_agent_thinking_rows", "ok": False})
    assert not ok and "root has no generation" in reason


def test_python_root_lane_check_reports_the_per_agent_verdict_lines_and_forwards_evidence(monkeypatch):
    seen = {}

    def check_thinking_rows(root_agent_id, *, base_url, api_key, user_id, evidence=None, **config):
        seen["evidence"] = evidence
        return {"passed": True, "report": {"ok": True}, "failures": [], "notes": ["no thinking recorded for code (N/A)"],
                "detail": ["root: 4 thoughts, 230.8 tok/s", "code a1b2: no thinking recorded (N/A)"]}

    _fake_module(monkeypatch, "benchmarks.thinking_rows_check", check_thinking_rows=check_thinking_rows)
    monkeypatch.setattr(external, "_api_key", lambda: "k")
    check = {"type": "code_agent_thinking_rows", "evidence": {AGENT: {"reasoningTokens": 120}}}
    ok, reason = code_agent_checks.run_check(_external_data(), check)
    assert ok and reason == "code_agent_thinking_rows: root: 4 thoughts, 230.8 tok/s | code a1b2: no thinking recorded (N/A)"
    assert seen["evidence"] == {AGENT: {"reasoningTokens": 120}}


def test_github_rate_limit_lane_check_builds_the_expectation_from_config(monkeypatch):
    from types import SimpleNamespace

    seen = {}

    class Expectation:
        def __init__(self, *, injected_reset_at, phase, **rest):
            seen["expectation"] = (injected_reset_at.isoformat(), phase, rest)

    async def check_github_rate_limit(base_url, headers, agent_ids, expectation):
        seen["call"] = (base_url, headers["X-User-Id"], list(agent_ids))
        return SimpleNamespace(passed=True, outcome="failed truthfully", failures=[])

    _fake_module(
        monkeypatch,
        "benchmarks.github_rate_limit_check",
        GithubRateLimitExpectation=Expectation,
        check_github_rate_limit=check_github_rate_limit,
    )
    monkeypatch.setattr(external, "_api_key", lambda: "k")
    check = {"type": "code_agent_github_rate_limit", "injected_reset_at": "2026-11-06T06:18:42Z", "phase": "startup",
             "max_sessions": 1}
    assert code_agent_checks.run_check(_external_data(), check) == (True, "code_agent_github_rate_limit: failed truthfully; ")
    assert seen["expectation"] == ("2026-11-06T06:18:42+00:00", "startup", {"max_sessions": 1})
    assert seen["call"] == (CTX["base_url"], "user-1", [AGENT, "child-1"])


def _stub(tmp_path, body: str):
    path = tmp_path / "stub.sh"
    path.write_text("#!/usr/bin/env bash\n" + body)
    return path


def test_script_lane_check_passes_context_flags_and_maps_exit_codes(monkeypatch, tmp_path):
    out = tmp_path / "args.txt"
    stub = _stub(tmp_path, f'echo "$@ key=$BACKEND_API_KEY" > {out}\necho \'{{"ok":true,"checked":3,"violations":[]}}\'\nexit ${{STUB_EXIT:-0}}\n')
    monkeypatch.setattr(external, "REPO_ROOT", tmp_path)
    monkeypatch.setitem(external.EXTERNAL, "code_agent_markdown", external.External("script", "stub.sh"))
    monkeypatch.setattr(external, "_api_key", lambda: "k")
    check = {"type": "code_agent_markdown", "require_root_reply": True, "require_code_reply": True}
    ok, reason = code_agent_checks.run_check(_external_data(), check)
    assert ok and "checked 3" in reason
    assert out.read_text().split() == [
        "--backend", CTX["base_url"], "--user-id", "user-1", "--agent-id", AGENT, "--agent-id", "child-1",
        "--require-root-reply", "--require-code-reply", "key=k"]
    monkeypatch.setenv("STUB_EXIT", "1")
    assert not code_agent_checks.run_check(_external_data(), check)[0]
    monkeypatch.setenv("STUB_EXIT", "2")  # bad input is not a verdict
    ok, reason = code_agent_checks.run_check(_external_data(), check)
    assert not ok and "exited 2" in reason
    assert stub.exists()


def test_playwright_lane_check_needs_a_real_pass_and_the_root_in_its_env(monkeypatch, tmp_path):
    out = tmp_path / "env.txt"
    stub = _stub(tmp_path, f'echo "$CODE_AGENT_CHECK_ROOT_ID $FRONTEND_URL" > {out}\necho "${{STUB_OUT:-  1 passed (3s)}}"\nexit ${{STUB_EXIT:-0}}\n')
    (tmp_path / "front-end/tests-e2e").mkdir(parents=True)
    (tmp_path / "front-end/tests-e2e/code-agent-render-check.spec.ts").write_text("")
    monkeypatch.setattr(external, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(external, "FRONT_END", tmp_path / "front-end")
    monkeypatch.setattr(external, "PLAYWRIGHT_CMD", ("bash", str(stub)))
    monkeypatch.setattr(external, "_approved_session", lambda ctx: "")
    check = {"type": "code_agent_render"}
    assert code_agent_checks.run_check(_external_data(), check) == (True, "code_agent_render: 1 passed")
    assert out.read_text().split() == [AGENT, CTX["frontend_url"]]
    monkeypatch.setenv("STUB_OUT", "  1 skipped")  # a skipped spec is not a pass
    assert not code_agent_checks.run_check(_external_data(), check)[0]
    monkeypatch.setenv("STUB_EXIT", "1")
    monkeypatch.setenv("STUB_OUT", "  1 failed: C8 rendered below the history")
    ok, reason = code_agent_checks.run_check(_external_data(), check)
    assert not ok and "C8 rendered below the history" in reason


def test_absent_lane_files_fail_closed_with_an_actionable_reason(monkeypatch, tmp_path):
    import sys

    for name in ("benchmarks.code_agent_run_checks", "benchmarks.thinking_rows_check", "benchmarks.github_rate_limit_check"):
        monkeypatch.setitem(sys.modules, name, None)
    monkeypatch.setattr(external, "REPO_ROOT", tmp_path)
    run = {"benchmarks.code_agent_run_checks": {"messages": []}}
    for check in (
        {"type": "code_agent_single_code_agent"},
        {"type": "code_agent_thinking_rows"},
        {"type": "code_agent_markdown"},
        {"type": "code_agent_render"},
        {"type": "code_agent_github_rate_limit", "injected_reset_at": "2026-11-06T06:18:42Z", "phase": "startup"},
    ):
        ok, reason = code_agent_checks.run_check(_external_data(run=run), check)
        assert not ok and "is not on this branch" in reason, (check, reason)
    ok, reason = code_agent_checks.run_check(
        _external_data(run={"benchmarks.code_agent_run_checks": {"error": "HTTPStatusError: 404"}}),
        {"type": "code_agent_message_reached"},
    )
    assert not ok and "evidence unavailable" in reason


def test_run_context_has_no_secret_and_the_frontend_follows_the_backend_port(monkeypatch, tmp_path):
    import json as _json

    monkeypatch.delenv("BENCHMARK_CONTEXT_DIR", raising=False)
    assert external.frontend_url("http://localhost:24420") == "http://localhost:24421"
    (tmp_path / "services.json").write_text(_json.dumps({"urls": {"frontend": "http://localhost:9999"}}))
    monkeypatch.setenv("BENCHMARK_CONTEXT_DIR", str(tmp_path))
    assert external.frontend_url("http://localhost:24420") == "http://localhost:9999"
    monkeypatch.setattr(external, "_api_key", lambda: "super-secret-key")
    context = external.context({"agent": {"agent_id": AGENT}}, "http://localhost:24420/", [AGENT])
    assert "super-secret-key" not in _json.dumps(context) and context["root_agent_id"] == AGENT


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


def test_failed_run_still_records_code_agent_evidence_and_never_raises(monkeypatch):
    import asyncio

    async def boom(data, *, benchmark, base_url):
        raise RuntimeError("log read failed")

    async def fine(data, *, benchmark, base_url):
        return {"startup_phases": []}

    data: dict = {}
    monkeypatch.setattr(ev, "collect", boom)
    asyncio.run(code_agent_checks.record_evidence(data, benchmark=TASK, base_url=None))
    assert data["_benchmark"][code_agent_checks.EVIDENCE_KEY] == {"collect_error": "RuntimeError: log read failed"}
    monkeypatch.setattr(ev, "collect", fine)
    asyncio.run(code_agent_checks.record_evidence(data, benchmark=TASK, base_url=None))
    assert data["_benchmark"][code_agent_checks.EVIDENCE_KEY] == {"startup_phases": []}


def test_playwright_lane_check_runs_as_an_approved_user_on_a_loopback_stack_only(monkeypatch, tmp_path):
    out = tmp_path / "session.txt"
    stub = _stub(tmp_path, f'echo "$SEMANTIC_SESSION" > {out}\necho "  1 passed (3s)"\n')
    (tmp_path / "front-end/tests-e2e").mkdir(parents=True)
    (tmp_path / "front-end/tests-e2e/code-agent-render-check.spec.ts").write_text("")
    monkeypatch.setattr(external, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(external, "FRONT_END", tmp_path / "front-end")
    monkeypatch.setattr(external, "PLAYWRIGHT_CMD", ("bash", str(stub)))
    redeemed = []

    real_run = external.subprocess.run

    def subprocess_run(cmd, **kwargs):
        from types import SimpleNamespace

        if cmd[:2] != ["npx", "tsx"]:
            return real_run(cmd, **kwargs)
        redeemed.append(("session", cmd[-1], kwargs["env"]["TEST_USER_ID"]))
        return SimpleNamespace(returncode=0, stdout='{"access_token": "tok", "user": {}}\n', stderr="")

    class Response:
        def close(self):
            pass

    def urlopen(request, timeout):
        redeemed.append(("redeem", request.full_url, request.get_header("Authorization"), request.data))
        return Response()

    monkeypatch.setattr(external.subprocess, "run", subprocess_run)
    monkeypatch.setattr(external.urllib.request, "urlopen", urlopen)
    ok, reason = code_agent_checks.run_check(_external_data(), {"type": "code_agent_render"})
    assert ok, reason
    assert redeemed[0] == ("session", "scripts/generate-test-session.ts", "user-1")
    assert redeemed[1][:3] == ("redeem", f"{CTX['base_url']}/api/invite-codes/use", "Bearer tok")
    assert b"181818" in redeemed[1][3]
    assert out.read_text().strip().startswith('{"access_token"')
    # Off loopback nothing is signed or redeemed: the run's own session is used.
    redeemed.clear()
    remote = {**CTX, "base_url": "https://api.example.com"}
    assert external._approved_session(remote) == "" and redeemed == []
