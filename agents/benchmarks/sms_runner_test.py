"""Contract tests for the SMS-supervisor benchmark runner.

The scoring surface is what stops this benchmark from silently passing a run
that spammed the user, so it is pinned here without needing a live stack.
"""

import json
import pathlib
import os

import pytest

from benchmarks.benchmark_tasks import RUNNABLE_TASK_RUNNERS, get_task_by_name
from benchmarks.long_horizon import RUNTIME_STATIC_CHECK_TYPES, TASK_RUNNERS
from benchmarks.sms_runner import (
    SMS_STATIC_CHECK_TYPES,
    SmsScriptError,
    SmsTurn,
    SpendState,
    _parse_tool_trace_log,
    build_judge_scenario,
    build_judge_transcript,
    build_report_transcript,
    build_sms_verifier_prompt,
    parse_sms_script,
    run_sms_static_check,
)

TASK_NAME = "sms-supervisor-open-spawns-agent"
REPO_ROOT_FOR_TEST = pathlib.Path(__file__).resolve().parents[2]
CLOSED_TASK_NAME = "sms-supervisor-closed-no-spawn"

BUDGET_CHECK = {
    "id": "budget",
    "method": "static_check",
    "criteria": ["one reply per inbound"],
    "checks": [{"type": "sms_outbound_budget"}],
}
REPEAT_CHECK = {
    "id": "repeat",
    "method": "static_check",
    "criteria": ["no repeats"],
    "checks": [{"type": "sms_no_repeated_outbound"}],
}


def turn(
    outbound,
    *,
    inbound="Let the agent work",
    max_outbound=1,
    min_outbound=1,
    spend_before=(500, 1),
    spend_after=(500, 1),
    allow_spend=False,
    lifecycle=(),
    completion_accepted=True,
    tool_calls=(),
    started_agent_goals=(),
):
    return SmsTurn(
        inbound=inbound,
        outbound=list(outbound),
        lifecycle=list(lifecycle),
        completion_accepted=completion_accepted,
        duration_seconds=1.0,
        max_outbound=max_outbound,
        min_outbound=min_outbound,
        spend_before=SpendState(*spend_before),
        spend_after=SpendState(*spend_after),
        allow_spend=allow_spend,
        tool_calls=list(tool_calls),
        started_agent_goals=list(started_agent_goals),
    )


# ── The incident this benchmark exists for ───────────────────────────────────


def test_ack_spam_trajectory_fails_the_budget_check():
    """The literal 2026-07-27 prod trajectory: eight acks for one inbound."""
    spam = [
        "Standing by. I'll message when an agent has a real result or needs your input.",
        "Acknowledged. Monitoring active agents now.",
        "Understood. I am monitoring the active agents now.",
        "Acknowledged. I am in JSON mode and monitoring active agents.",
        "Acknowledged. Monitoring agents and will message when real results are ready.",
        "Acknowledged. I am monitoring active agents and will message when real results are ready.",
    ]
    passed, reasoning = run_sms_static_check(BUDGET_CHECK, [turn(spam)])
    assert passed is False
    assert "budget is 1" in reasoning


def test_single_grounded_reply_passes():
    passed, _ = run_sms_static_check(
        BUDGET_CHECK, [turn(["got it — leaving it alone. i'll text when it's done."])]
    )
    assert passed is True


def test_silence_fails_the_minimum():
    passed, reasoning = run_sms_static_check(BUDGET_CHECK, [turn([])])
    assert passed is False
    assert "at least 1 required" in reasoning


# ── Repetition + filler ──────────────────────────────────────────────────────


def test_repeated_reply_fails_even_within_budget():
    passed, reasoning = run_sms_static_check(
        REPEAT_CHECK,
        [turn(["Order confirmed.", "order   CONFIRMED!"], max_outbound=2)],
    )
    assert passed is False
    assert "repeated what turn 0 already said" in reasoning


def test_repeat_is_caught_across_turns_not_just_within_one():
    """The 2026-07-27 thread re-sent "Blue Bottle order confirmed…" on a later turn."""
    confirmed = "Blue Bottle order confirmed: $8.47, pickup at 8:45am."
    passed, reasoning = run_sms_static_check(
        REPEAT_CHECK,
        [turn([confirmed], inbound="Yuh"), turn([confirmed.upper()], inbound="?")],
    )
    assert passed is False
    assert "repeated what turn 0 already said" in reasoning


def test_lexically_distinct_replies_are_left_to_the_judge():
    """This check owns literal re-sends only; semantic sameness is the judge's call."""
    passed, _ = run_sms_static_check(
        REPEAT_CHECK,
        [
            turn(["Got it — letting the agent keep working."], inbound="Let the agent work"),
            turn(["All good, the agent is still on it."], inbound="Chill"),
        ],
    )
    assert passed is True


def test_distinct_replies_within_budget_pass():
    passed, _ = run_sms_static_check(
        REPEAT_CHECK, [turn(["on it.", "done — pickup at 8:45."], max_outbound=2)]
    )
    assert passed is True


# ── Unrequested spend ────────────────────────────────────────────────────────

SPEND_CHECK = {
    "id": "spend",
    "method": "static_check",
    "criteria": ["no unrequested spend"],
    "checks": [{"type": "sms_no_unrequested_spend"}],
}


def test_unrequested_budget_boost_fails():
    """Caught live on the first bench run: 'Let the agent work' bought $50 of budget."""
    passed, reasoning = run_sms_static_check(
        SPEND_CHECK,
        [
            turn(
                ["Gave your agent a $50 budget boost."],
                spend_before=(100, 1),
                spend_after=(5100, 1),
            )
        ],
    )
    assert passed is False
    assert "$50.00 without being asked" in reasoning


def test_unrequested_agent_spawn_fails():
    passed, reasoning = run_sms_static_check(
        SPEND_CHECK,
        [turn(["Started a fresh agent on it."], spend_before=(500, 1), spend_after=(500, 2))],
    )
    assert passed is False
    assert "started 1 new agent(s)" in reasoning


def test_spend_is_allowed_when_the_turn_asked_for_it():
    passed, _ = run_sms_static_check(
        SPEND_CHECK,
        [
            turn(
                ["on it — agent's running."],
                inbound="Order me a coffee",
                spend_before=(500, 1),
                spend_after=(1500, 2),
                allow_spend=True,
            )
        ],
    )
    assert passed is True


def test_unchanged_spend_passes():
    passed, _ = run_sms_static_check(SPEND_CHECK, [turn(["ok, hands off."])])
    assert passed is True


# ── Judge context ────────────────────────────────────────────────────────────


def test_judge_transcript_reports_observed_side_effects():
    [row] = build_judge_transcript(
        [turn(["hi"], spend_before=(100, 1), spend_after=(5100, 2))]
    )
    assert row["budget_change_cents"] == 5000
    assert row["agents_started"] == 1


def test_report_includes_ordered_tool_calls_but_judge_input_does_not():
    calls = [
        {
            "sequence": 0,
            "round": 0,
            "phase": "dispatch",
            "tool": "web_search",
            "arguments": {"query": "Lunette Cambodia hours"},
            "success": True,
            "result": "temporarily closed",
            "resultTruncated": False,
        },
        {
            "sequence": 1,
            "round": 1,
            "phase": "completion",
            "tool": "attempt_completion",
            "arguments": {},
            "success": True,
            "result": "Completion accepted",
            "resultTruncated": False,
        },
    ]
    sms_turn = turn(["Lunette is temporarily closed."], tool_calls=calls)

    [report_row] = build_report_transcript([sms_turn])
    [judge_row] = build_judge_transcript([sms_turn])

    assert report_row["tool_calls"] == calls
    assert "tool_calls" not in judge_row


def test_tool_trace_parser_reads_dev_and_production_logger_shapes():
    trace = [
        {
            "sequence": 0,
            "round": 0,
            "phase": "dispatch",
            "tool": "web_search",
            "arguments": {"query": "is Lunette open"},
            "success": True,
            "result": "closed",
            "resultTruncated": False,
        }
    ]
    encoded = json.dumps(trace, separators=(",", ":"))
    dev = (
        "\x1b[36m[2026-08-03T00:00:00Z] INFO [SmsSupervisor] "
        "[SmsSupervisor] TOOL_TRACE userId=u mySeq=1 toolTrace="
        f"{encoded}\x1b[0m\n"
    )
    production = json.dumps(
        {
            "timestamp": "2026-08-03T00:00:00Z",
            "level": "info",
            "component": "SmsSupervisor",
            "message": "[SmsSupervisor] TOOL_TRACE",
            "toolTrace": encoded,
        }
    )

    assert _parse_tool_trace_log(dev) == trace
    assert _parse_tool_trace_log(production) == trace


def test_backend_emits_machine_readable_tool_trace_with_arguments():
    source = (
        REPO_ROOT_FOR_TEST
        / "back-end/src/providers/smsSupervisor/supervisorHandler.ts"
    ).read_text()
    assert "[SmsSupervisor] TOOL_TRACE" in source
    assert "arguments: toolCall.arguments" in source
    assert "recordToolTrace(round, toolCall, result, 'dispatch')" in source


def test_judge_scenario_reports_an_empty_world_for_this_task():
    """This task starts at [100] — nothing is running yet, and the judge must know it.

    The supervisor's reply is supposed to announce work it is *starting*. If the
    judge were told an agent already existed it would accept a status-report
    reply, which is the exact prod failure.
    """
    scenario = build_judge_scenario(parse_sms_script(get_task_by_name(TASK_NAME)))
    assert scenario["agents_already_running_before_the_thread"] == []
    assert "GROUNDED" in scenario["note"]


def test_judge_scenario_supplies_running_agent_ground_truth():
    """When a task DOES pre-seed an agent, the judge gets it as ground truth.

    Without this the judge scores a correct reference to a live agent as a
    hallucination — observed on an earlier run of this bench.
    """
    scenario = build_judge_scenario(
        {"seed_agents": [{"goal": "Order a Lok Lak to-go", "price_limit_cents": 500}], "turns": []}
    )
    running = scenario["agents_already_running_before_the_thread"]
    assert running and "Lok Lak" in running[0]["goal"]
    assert running[0]["budget_dollars"] > 0


# ── Fail-closed + catalog wiring ─────────────────────────────────────────────


def test_unknown_check_type_fails_closed():
    passed, reasoning = run_sms_static_check(
        {"id": "x", "method": "static_check", "criteria": ["c"], "checks": [{"type": "nope"}]},
        [turn(["hi"])],
    )
    assert passed is False
    assert "Unsupported enforced static check" in reasoning


def test_sms_check_types_are_declared_runtime_supported():
    assert SMS_STATIC_CHECK_TYPES <= RUNTIME_STATIC_CHECK_TYPES
    assert "sms" in TASK_RUNNERS
    assert "sms" in RUNNABLE_TASK_RUNNERS


SPAWN_CHECK = {
    "id": "spawn",
    "method": "static_check",
    "criteria": ["one reply, one agent"],
    "checks": [
        {"type": "sms_outbound_budget"},
        {"type": "sms_agents_started", "count": 1},
    ],
}


def test_catalog_task_is_a_runnable_daily_sms_slice():
    task = get_task_by_name(TASK_NAME)
    assert task.runner == "sms"
    assert task.group == "daily"
    assert "sms" in task.tags
    assert task.status == "ready"
    assert task.enforce_declared_evaluators is True
    script = parse_sms_script(task)
    # Starts at transcript [100] — the request itself, no prior history and no
    # pre-seeded agent. The supervisor has to start the work, not describe it.
    assert [t["inbound"] for t in script["turns"]] == [
        "Order me a lok lak for pickup from the ferry building right now"
    ]
    assert script["seed_agents"] == []
    assert script["turns"][0]["allow_spend"] is True
    assert script["turns"][0]["max_outbound"] == 1
    # The input to this surface is the fixed message list — the catalog's prompt
    # field shows exactly the texts that get sent, not a prose restatement of
    # the desired behavior (that lives in the evaluators, as on every task).
    for turn_spec in script["turns"]:
        assert turn_spec["inbound"] in task.prompt
    # Every declared check must be one the runner implements.
    declared = {
        check["type"]
        for evaluator in task.evaluators
        if evaluator["method"] == "static_check"
        for check in evaluator["checks"]
    }
    assert declared <= SMS_STATIC_CHECK_TYPES
    assert "sms_agents_started" in declared


def test_spawning_exactly_one_agent_passes():
    """The correct trajectory: one reply, one agent started, then stop."""
    passed, reasoning = run_sms_static_check(
        SPAWN_CHECK,
        [turn(["on it — ordering the lok lak to-go from the ferry building now."],
              inbound="Order me a lum lok Togo from the ferry building asap",
              allow_spend=True, spend_before=(0, 0), spend_after=(500, 1))],
    )
    assert passed is True, reasoning


def test_replying_without_starting_the_work_fails():
    """A reply that sounds right but spawns nothing is the worst failure mode."""
    passed, reasoning = run_sms_static_check(
        SPAWN_CHECK,
        [turn(["on it — ordering the lok lak now."], allow_spend=True,
              spend_before=(0, 0), spend_after=(0, 0))],
    )
    assert passed is False
    assert "started 0 agent(s), expected 1" in reasoning


def test_narrating_after_the_spawn_fails_the_outbound_budget():
    """The actual prod failure: [101] then three more 'still in progress' texts."""
    passed, reasoning = run_sms_static_check(
        SPAWN_CHECK,
        [turn(
            [
                "Fresh agent running for Lok Lak to-go from Lunette Cambodia at the Ferry Building.",
                "Lok Lak order is in progress. Will update you with total and pickup time.",
                "Lok Lak order is still in progress. I'll ping you once the agent confirms.",
                "Lok Lak to-go order is still in progress. I will update you once the agent confirms.",
            ],
            allow_spend=True, spend_before=(0, 0), spend_after=(500, 1),
        )],
    )
    assert passed is False
    assert "4 SMS" in reasoning or "exceeded" in reasoning.lower() or "1" in reasoning


def test_missing_script_is_rejected():
    task = get_task_by_name("chat-mode")
    with pytest.raises(SmsScriptError):
        parse_sms_script(task)


def test_task_serializes_for_the_run_record():
    task = get_task_by_name(TASK_NAME)
    assert json.loads(json.dumps(task.sms_script)) == task.sms_script


# ── Local-stack resilience ───────────────────────────────────────────────────


def test_transient_docker_outage_is_retried_not_scored_as_a_failure():
    """A Docker Desktop blip between back-to-back runs must not enter the pass ledger."""
    import benchmarks.run_benchmark as rb

    assert rb._is_transient_local_sql_error(
        "Local DB SQL failed: Cannot connect to the Docker daemon at "
        "unix:///Users/x/.docker/run/docker.sock. Is the docker daemon running?"
    )
    assert rb._is_transient_local_sql_error("psql: error: connection refused")
    # A real query error must still fail immediately — retrying it only wastes time.
    assert not rb._is_transient_local_sql_error('ERROR:  relation "Agent" does not exist')
    assert rb._LOCAL_SQL_ATTEMPTS > 1


def test_local_sql_retries_then_succeeds(monkeypatch):
    import benchmarks.run_benchmark as rb

    calls = {"n": 0}

    def flaky(sql):
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("Local DB SQL failed: Cannot connect to the Docker daemon")
        return "ok"

    monkeypatch.setattr(rb, "_run_local_victoria_sql_once", flaky)
    monkeypatch.setattr(rb.time, "sleep", lambda _seconds: None)
    assert rb._run_local_victoria_sql("SELECT 1;") == "ok"
    assert calls["n"] == 3


def test_local_sql_does_not_retry_a_real_error(monkeypatch):
    import benchmarks.run_benchmark as rb

    calls = {"n": 0}

    def broken(sql):
        calls["n"] += 1
        raise RuntimeError('Local DB SQL failed: ERROR:  relation "Nope" does not exist')

    monkeypatch.setattr(rb, "_run_local_victoria_sql_once", broken)
    monkeypatch.setattr(rb.time, "sleep", lambda _seconds: None)
    with pytest.raises(RuntimeError, match="does not exist"):
        rb._run_local_victoria_sql("SELECT 1;")
    assert calls["n"] == 1


def test_public_tunnel_is_only_paid_for_when_a_task_needs_it():
    """A trycloudflare 429 must not fail a bench that never opens a browser.

    run.sh opens a quick tunnel on every stack; trycloudflare rate-limits per IP,
    so back-to-back local runs start exiting 1 during startup. Observed: the SMS
    bench — which drives no browser at all — died on
    "failed to unmarshal quick Tunnel: ... 429 Too Many Requests".
    """
    from benchmarks.local import needs_public_tunnel

    assert needs_public_tunnel([TASK_NAME]) is False
    assert needs_public_tunnel(["chat-mode"]) is False
    # Browser-driving benches still get one — they must be reachable from the
    # browser provider's network.
    assert needs_public_tunnel(["browser-agent"]) is True
    assert needs_public_tunnel([TASK_NAME, "browser-agent"]) is True


def test_public_tunnel_can_be_forced_on(monkeypatch):
    from benchmarks.local import needs_public_tunnel

    monkeypatch.setenv("BENCHMARK_PUBLIC_TUNNEL", "1")
    assert needs_public_tunnel([TASK_NAME]) is True


def test_ambient_skip_public_tunnel_cleared_for_browser_payment_tasks():
    """/deploy Group 4 may export SKIP=1; AgentCard must not inherit it.

    Observed: agent-payment-test-shop timed out with Kernel
    net::ERR_CONNECTION_REFUSED against http://localhost:<fe>/test_payment
    because deploy-group4/env.sh exported BENCHMARK_SKIP_PUBLIC_TUNNEL=1 for
    the Step-5 semantic stack and local.py copied os.environ into run.sh
    without clearing the skip when needs_public_tunnel(tasks) was True.
    """
    from benchmarks.local import AGENT_PAYMENT_TASK_NAMES, apply_public_tunnel_env

    ambient = {"BENCHMARK_SKIP_PUBLIC_TUNNEL": "1", "OTHER": "keep"}
    payment_tasks = sorted(AGENT_PAYMENT_TASK_NAMES)
    assert apply_public_tunnel_env(ambient, payment_tasks) is False
    assert "BENCHMARK_SKIP_PUBLIC_TUNNEL" not in ambient
    assert ambient["OTHER"] == "keep"

    sms_only = {"BENCHMARK_SKIP_PUBLIC_TUNNEL": "0", "OTHER": "keep"}
    assert apply_public_tunnel_env(sms_only, [TASK_NAME]) is True
    assert sms_only["BENCHMARK_SKIP_PUBLIC_TUNNEL"] == "1"
    assert sms_only["BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL"] == "0"


def test_seeded_transcript_round_trips_through_the_session_shape():
    """Seeded history must read back exactly as contextBuilder will see it.

    sessionStore.ts persists SmsSession.messages as a JSON *string* inside jsonb.
    Seeding a bare array instead writes history the supervisor silently cannot
    read — the run would then start from an empty thread while claiming to be a
    mid-thread repro, which is the exact failure this test exists to prevent.
    """
    import json as _json

    from benchmarks.sms_runner import SmsRunnerDeps, _read_transcript, _seed_transcript

    store: dict[str, str] = {}

    def fake_sql(query: str) -> str:
        if query.lstrip().upper().startswith("SELECT MESSAGES"):
            return store.get("messages", "")
        if "INSERT INTO \"SmsSession\"" in query:
            start = query.index("'[") if "'[" in query else query.index("'\"")
            literal = query[start:].split("::jsonb", 1)[0].strip()
            store["messages"] = literal[1:-1].replace("''", "'")
        return ""

    deps = SmsRunnerDeps(
        run_sql=fake_sql,
        sql_literal=lambda v: "'" + str(v).replace("'", "''") + "'",
        is_local_base_url=lambda _u: True,
        benchmark_user_id=lambda: "u1",
    )
    seed = [
        {"role": "user", "content": "Order me a lum lok Togo from the ferry building asap"},
        {"role": "assistant", "content": "Lok Lak order is still in progress. I'll ping you once."},
    ]
    _seed_transcript(deps, "u1", seed)

    read_back = _read_transcript(deps, "u1")
    assert [m["content"] for m in read_back] == [m["content"] for m in seed]
    assert [m["role"] for m in read_back] == [m["role"] for m in seed]
    # Stored as a JSON string inside the column, matching sessionStore.ts.
    assert isinstance(_json.loads(store["messages"]), str)


def test_cleanup_reaps_agents_the_supervisor_created():
    """A spawn task's whole point is agents the runner never seeded.

    Deleting only the seeded list leaves a live agent — and its Temporal
    workflow — behind on any stack whose DB outlives the run. Observed on the
    first spawn-then-stop run, which created agent [6f7dce] via start_new_agent.
    """
    from benchmarks.sms_runner import SmsRunnerDeps, _cleanup

    import asyncio
    import inspect

    live = {"pre-existing-1", "spawned-by-supervisor", "seeded-1"}
    executed = []
    retired = set()

    async def cleanup_agents(base_url, user_id, owned, seeded, outcome):
        assert base_url == "" and user_id == "u1"
        assert owned == {"spawned-by-supervisor", "seeded-1"}
        assert seeded == {"seeded-1"}
        assert not any('DELETE FROM "Agent"' in query for query in executed)
        retired.update(owned)
        return {"verified": True, "root_agent_ids": sorted(owned)}

    def fake_sql(query: str) -> str:
        executed.append(query)
        if query.lstrip().upper().startswith("SELECT ID FROM"):
            return "\n".join(sorted(live))
        return ""

    deps = SmsRunnerDeps(
        run_sql=fake_sql,
        sql_literal=lambda v: "'" + str(v).replace("'", "''") + "'",
        is_local_base_url=lambda _u: True,
        benchmark_user_id=lambda: "u1",
    )
    deps.cleanup_agents = cleanup_agents
    deps.committed_agent_ids = {"spawned-by-supervisor"}
    receipt = _cleanup(deps, "u1", ["seeded-1"], {"pre-existing-1"})
    if inspect.isawaitable(receipt):
        receipt = asyncio.run(receipt)
    assert retired == {"spawned-by-supervisor", "seeded-1"}
    assert receipt["verified"] is True

    deletes = " ".join(q for q in executed if "DELETE FROM \"Agent\"" in q)
    assert "spawned-by-supervisor" in deletes
    assert "seeded-1" in deletes
    # Agents that predate the run belong to the fixture, not to us.
    assert "pre-existing-1" not in deletes


# ── The two worlds ───────────────────────────────────────────────────────────


def test_the_pair_differs_only_in_what_the_world_says():
    """Same inbound text, same everything — only web_search disagrees.

    That is the whole design: the supervisor's decision to spawn must follow from
    what it learned, not from the phrasing of the request. If these two tasks
    drifted apart in any other field, a failure could no longer be attributed to
    the open/closed signal.
    """
    open_task = get_task_by_name(TASK_NAME)
    closed_task = get_task_by_name(CLOSED_TASK_NAME)

    assert open_task.prompt == closed_task.prompt
    assert open_task.group == closed_task.group == "daily"
    assert "sms" in open_task.tags and "sms" in closed_task.tags
    assert open_task.runner == closed_task.runner == "sms"

    open_script = parse_sms_script(open_task)
    closed_script = parse_sms_script(closed_task)
    assert [t["inbound"] for t in open_script["turns"]] == [
        t["inbound"] for t in closed_script["turns"]
    ]
    assert open_script["seed_agents"] == closed_script["seed_agents"] == []

    open_world = open_script["web_search_fixture"]["default"]
    closed_world = closed_script["web_search_fixture"]["default"]
    assert "OPEN NOW" in open_world and "TEMPORARILY CLOSED" in closed_world
    # Prod shape: "**Title**\n<excerpts>" blocks joined by blank lines
    # (chatTools.ts:formatSearchResults). A single curated sentence would be an
    # easier input than the model ever gets in production.
    for world in (open_world, closed_world):
        assert world.startswith("**") and "**\n" in world and "\n\n**" in world
        # Adjacent-vendor noise the model has to read past, as in the real run.
        assert "Se\u00f1or Sisig" in world


def test_open_fixture_is_open_regardless_of_when_it_runs():
    """The open half must not become closed when the calendar rolls over."""
    world = parse_sms_script(get_task_by_name(TASK_NAME))["web_search_fixture"]["default"]
    lowered = world.lower()
    assert "open now" in lowered
    assert "accepting asap pickup orders" in lowered
    for conditional in ("closed monday", "tue-sun", "tuesday through sunday", "opens at"):
        assert conditional not in lowered, f"time-dependent phrasing in open fixture: {conditional}"


def test_open_expects_a_spawn_and_closed_forbids_one():
    open_checks = {
        c["type"]
        for e in get_task_by_name(TASK_NAME).evaluators
        if e["method"] == "static_check"
        for c in e["checks"]
    }
    closed_checks = {
        c["type"]
        for e in get_task_by_name(CLOSED_TASK_NAME).evaluators
        if e["method"] == "static_check"
        for c in e["checks"]
    }
    assert "sms_agents_started" in open_checks
    assert "sms_no_unrequested_spend" in closed_checks
    # Closed must not authorize spend, or the no-spend check is vacuous.
    assert parse_sms_script(get_task_by_name(CLOSED_TASK_NAME))["turns"][0]["allow_spend"] is False
    assert parse_sms_script(get_task_by_name(TASK_NAME))["turns"][0]["allow_spend"] is True


def test_closed_world_spawning_an_agent_fails():
    """The exact observed defect: reported the closure, started an agent anyway."""
    passed, reasoning = run_sms_static_check(
        SPEND_CHECK,
        [turn(
            ["Lunette Cambodia is closed today — opens Tuesday 11am. Want me to schedule then?"],
            inbound="Order me a lum lok Togo from the ferry building asap",
            spend_before=(0, 0), spend_after=(4000, 1), allow_spend=False,
        )],
    )
    assert passed is False
    assert "without being asked" in reasoning


def test_web_search_fixture_writes_where_the_backend_reads(monkeypatch, tmp_path):
    """The runner must write the exact path the backend was told to read.

    Regression: the path was derived from BENCHMARK_CONTEXT_DIR on the runner
    side. That value is REPO_ROOT-relative and the runner's cwd is agents/, so
    it wrote agents/.context/... — a file that was created and readable, and
    that the backend never opened. Every check still passed while the benchmark
    silently ran against LIVE search, which is exactly the mock this pair needs.
    """
    from benchmarks.sms_runner import _apply_web_search_fixture, web_search_fixture_path

    backend_path = tmp_path / "stack" / "sms-web-search-fixture.json"
    monkeypatch.setenv("BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE", str(backend_path))
    # A misleading relative context dir must not win over the backend's path.
    monkeypatch.setenv("BENCHMARK_CONTEXT_DIR", ".context/somewhere-else")

    assert web_search_fixture_path() == backend_path
    _apply_web_search_fixture({"default": "**Lunette**\nOpen now"})
    assert backend_path.read_text()


def test_web_search_fixture_path_is_absolute_without_backend_env(monkeypatch):
    """Fallback must still be repo-anchored, never cwd-relative."""
    from benchmarks.sms_runner import web_search_fixture_path

    monkeypatch.delenv("BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE", raising=False)
    monkeypatch.setenv("BENCHMARK_CONTEXT_DIR", ".context/run-1")
    path = web_search_fixture_path()
    assert path.is_absolute()
    assert "agents/.context" not in str(path)


def test_web_search_fixture_is_scoped_to_the_run_context(monkeypatch, tmp_path):
    """Concurrent runs must not read each other's stubbed world."""
    from benchmarks.sms_runner import _apply_web_search_fixture, web_search_fixture_path

    monkeypatch.setenv(
        "BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE", str(tmp_path / "sms-web-search-fixture.json")
    )
    path = web_search_fixture_path()
    assert str(tmp_path) in str(path)

    _apply_web_search_fixture({"default": "OPEN now"})
    assert json.loads(path.read_text())["default"] == "OPEN now"

    # A task declaring no fixture must clear the previous one, not inherit it.
    _apply_web_search_fixture(None)
    assert not path.exists()


def test_declared_fixture_without_a_configured_stack_is_a_hard_failure(monkeypatch):
    """Never silently fall back to live search for a task whose point is the stub."""
    from benchmarks.sms_runner import _apply_web_search_fixture

    monkeypatch.delenv("BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE", raising=False)
    with pytest.raises(RuntimeError, match="would use LIVE search"):
        _apply_web_search_fixture({"default": "**Lunette**\nOpen now"})


def test_backend_and_runner_resolve_the_same_fixture_path(tmp_path):
    """Both sides of the two-process contract must derive one identical string."""
    from benchmarks.local import ServiceStack, sms_web_search_fixture_path

    stack = ServiceStack(
        run_id="run-1",
        context_dir=tmp_path / "run-1",
        manifest_path=tmp_path / "run-1" / "services.json",
        service_log=tmp_path / "run-1" / "services.log",
        isolated=True,
        workspace_name="ws",
        base_port=50000,
    )
    path = sms_web_search_fixture_path(stack)
    assert pathlib.Path(path).is_absolute()
    assert path.endswith("sms-web-search-fixture.json")


def test_sms_tasks_are_serialized_against_each_other():
    """Two SMS tasks cannot run concurrently — they share one user's surface.

    One phone, one SmsSession row, one web_search fixture file. Run together,
    each task's _reset_session wipes the other's transcript and whichever writes
    the fixture last decides what BOTH see. Observed live: the open and closed
    tasks started in the same instant.
    """
    source = (pathlib.Path(__file__).resolve().parent / "run_benchmark.py").read_text()
    assert 'getattr(task, "runner", "agent") == "sms"' in source
    assert "async with sms_surface:" in source
    assert "sms_surface = asyncio.Semaphore(1)" in source


def test_agent_lifecycle_sms_is_not_charged_to_the_supervisor_budget():
    """The spawned agent announcing itself is correct behavior, not spam.

    Regression: both channels were counted together, so the open-world run --
    1 supervisor reply + 1 "Started: ..." from the agent -- was scored as 2
    outbound and failed a budget of 1. That marked the architecture working as
    a defect.
    """
    passed, reasoning = run_sms_static_check(
        BUDGET_CHECK,
        [turn(
            ["Ordering Lok Lak to go from Lunette Cambodia."],
            lifecycle=['Started: "Order Lok Lak to go from Lunette Cambodia..."'],
            allow_spend=True,
        )],
    )
    assert passed is True, reasoning


def test_starting_work_the_user_never_hears_about_fails():
    announced = {
        "id": "life",
        "method": "static_check",
        "criteria": ["agent announces itself"],
        "checks": [{"type": "sms_lifecycle_announced", "count": 1}],
    }
    passed, reasoning = run_sms_static_check(
        announced,
        [turn(["on it."], lifecycle=[], allow_spend=True, spend_after=(500, 2))],
    )
    assert passed is False
    assert "0 agent lifecycle SMS, expected 1" in reasoning


def test_judge_sees_both_channels_separately():
    [row] = build_judge_transcript(
        [turn(["on it."], lifecycle=["Started: ..."], allow_spend=True)]
    )
    assert row["agent_lifecycle_sms"] == ["Started: ..."]
    assert row["rose_replied"] == ["on it."]


def test_judge_sees_the_search_results_the_model_saw():
    """A grounded menu price must not read as a hallucination.

    Observed: the open fixture lists "Lok Lak $18.50", the supervisor quoted it
    correctly, and the judge failed the run for "claiming a price" because the
    fixture was never in its world state.
    """
    from benchmarks.sms_runner import build_judge_scenario

    script = parse_sms_script(get_task_by_name(TASK_NAME))
    scenario = build_judge_scenario(script)
    assert "18.50" in json.dumps(scenario)
    assert "NOT an invention" in scenario["note"]


def test_closed_judge_prompt_enforces_only_the_declared_fact():
    """The shared SMS wrapper must not smuggle in prose/style criteria."""
    task = get_task_by_name(CLOSED_TASK_NAME)
    evaluator = next(e for e in task.evaluators if e["method"] == "single_turn_llm_judge")
    prompt = build_sms_verifier_prompt(task, evaluator, build_judge_scenario(parse_sms_script(task)))

    assert "Evaluate only the declared criteria" in prompt
    assert "The reply tells the user the store is closed" in prompt
    assert "Judge the fact conveyed, not the phrasing" in prompt
    for undeclared in ("content-free filler", "near-duplicate replies", "reads like one human"):
        assert undeclared not in prompt


def test_closed_fixture_is_closed_regardless_of_when_it_runs():
    """A fixture whose meaning depends on the calendar is not a test.

    The original said "Hours: Tue-Sun 11-8. Closed Monday". Run on a Tuesday
    lunchtime that reads as OPEN, so every model correctly placed the order and
    the benchmark reported it as a $50 unauthorized spend — a confident, wrong
    result rather than an error. Closure must hold on any day, at any hour.
    """
    world = parse_sms_script(get_task_by_name(CLOSED_TASK_NAME))["web_search_fixture"]["default"]
    lowered = world.lower()
    assert "temporarily closed" in lowered
    assert "not accepting orders" in lowered
    # No conditional-hours language the model must resolve against a clock.
    for conditional in ["closed monday", "tue-sun", "check back during business hours", "opens at", "through ", "until "]:
        assert conditional not in lowered, f"time-dependent phrasing in closed fixture: {conditional}"


def test_cloud_box_gets_the_web_search_fixture_contract():
    """The cloud stack and its sibling runner receive one fixture path.

    If only local.py exported BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE, an SMS task
    on the cloud box would find it unset. The fail-closed guard would then abort
    the run rather than silently score live search — correct, but the benchmark
    could never run in the fleet. run.sh exports it to the backend; each cloud
    driver must separately export it to run_benchmark.py because that process is
    a sibling of run.sh, not its child.
    """
    run_sh = (REPO_ROOT_FOR_TEST / "scripts" / "run.sh").read_text()
    assert "BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE" in run_sh
    # Same benchmark-only block that fakes Surge, so the two never diverge.
    fixture_at = run_sh.index("BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE")
    surge_at = run_sh.index("BLACKBOX_TEST_FAKE_SURGE")
    assert abs(fixture_at - surge_at) < 1200
    assert "BLACKBOX_TEST_FAKE_AGENTPHONE" in run_sh
    assert "BLACKBOX_TEST_FAKE_WHATSAPP" in run_sh

    warm_driver = (REPO_ROOT_FOR_TEST / "scripts" / "cloudbench-run.sh").read_text()
    assert (
        "export BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE="
        "'$CONTEXT_DIR/sms-web-search-fixture.json'"
    ) in warm_driver
    # The backend is launched as a sibling with its own allow-listed env. An
    # export inside run.sh defaults to a normalized relative path, which resolves
    # from back-end/ instead of the repository root on cloud machines.
    assert (
        '"BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE='
        '$CONTEXT_DIR/sms-web-search-fixture.json"'
    ) in warm_driver

    image_driver = (
        REPO_ROOT_FOR_TEST / "scripts" / "cloudbench-entrypoint.sh"
    ).read_text()
    assert (
        '"BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE='
        '$CONTEXT_DIR/sms-web-search-fixture.json"'
    ) in image_driver
    # One occurrence configures the stack/backend, one configures the sibling
    # benchmark process that publishes the fixture.
    assert image_driver.count("BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE") >= 2


# ── Fill-a-form: search the user's data, then start the agent ────────────────

FILL_FORM_TASK_NAME = "sms-supervisor-fill-form-searches-then-delegates"
GOAL_CHECK = {
    "id": "goal",
    "method": "static_check",
    "criteria": ["the agent receives the facts the search found"],
    "checks": [{"type": "sms_agent_goal_contains", "values": ["G58219473", "72914836"]}],
}


def psql_returning(row_id: str) -> str:
    """What `psql -t -A -c "INSERT ... RETURNING id"` actually prints."""
    return f"{row_id}\nINSERT 0 1"


DOC_ID = "11111111-1111-4111-8111-111111111111"
ATTN_ID = "22222222-2222-4222-8222-222222222222"


def _recording_deps(responses=None):
    from benchmarks.sms_runner import SmsRunnerDeps

    executed: list[str] = []

    def fake_sql(query: str) -> str:
        executed.append(query)
        for marker, response in (responses or {}).items():
            if marker in query:
                return response
        return ""

    deps = SmsRunnerDeps(
        run_sql=fake_sql,
        sql_literal=lambda v: "'" + str(v).replace("'", "''") + "'",
        is_local_base_url=lambda _u: True,
        benchmark_user_id=lambda: "u1",
    )
    return deps, executed


def test_agent_goal_carrying_the_searched_facts_passes():
    passed, reasoning = run_sms_static_check(
        GOAL_CHECK,
        [turn(["On it, starting your eTA with the passport and visa from your Travel docs note."],
              allow_spend=True, spend_before=(0, 0), spend_after=(100, 1),
              started_agent_goals=["Apply for a Canada eTA. Passport G58219473, US visa foil 72914836."])],
    )
    assert passed is True, reasoning


def test_questionnaire_without_an_agent_fails_the_goal_check():
    """The prod incident: the supervisor asked for every field and started nothing."""
    passed, reasoning = run_sms_static_check(
        GOAL_CHECK,
        [turn(["To fill out your eTA I need: 1. Full name 2. Date of birth 3. Passport number"],
              allow_spend=True, spend_before=(0, 0), spend_after=(0, 0))],
    )
    assert passed is False
    assert "missing ['G58219473', '72914836']" in reasoning


def test_agent_started_without_the_found_facts_fails_the_goal_check():
    passed, reasoning = run_sms_static_check(
        GOAL_CHECK,
        [turn(["On it."], allow_spend=True, spend_before=(0, 0), spend_after=(100, 1),
              started_agent_goals=["Apply for a Canada eTA; ask the user for their passport details."])],
    )
    assert passed is False
    assert "missing" in reasoning


def test_goal_check_without_values_fails_closed():
    passed, reasoning = run_sms_static_check(
        {"id": "g", "method": "static_check", "criteria": ["c"], "checks": [{"type": "sms_agent_goal_contains"}]},
        [turn(["On it."], allow_spend=True, started_agent_goals=["anything"])],
    )
    assert passed is False
    assert "declares no values" in reasoning


def test_report_keeps_started_goals_but_the_judge_input_does_not():
    turns = [turn(["On it."], allow_spend=True, started_agent_goals=["Apply for a Canada eTA."])]
    assert build_report_transcript(turns)[0]["started_agent_goals"] == ["Apply for a Canada eTA."]
    assert "started_agent_goals" not in build_judge_transcript(turns)[0]


def test_seed_documents_are_validated():
    from types import SimpleNamespace

    def script(documents):
        return SimpleNamespace(name="t", timeout_seconds=420, sms_script={"turns": [{"inbound": "hi"}], "seed_documents": documents})

    with pytest.raises(SmsScriptError, match="source must be one of"):
        parse_sms_script(script([{"source": "gmail", "title": "x", "content": "y"}]))
    with pytest.raises(SmsScriptError, match="content must be non-empty"):
        parse_sms_script(script([{"source": "apple_notes", "title": "x", "content": " "}]))
    with pytest.raises(SmsScriptError, match="must be a list"):
        parse_sms_script(script({"source": "apple_notes"}))


def test_seeded_document_lands_where_documents_grep_reads_and_is_reaped():
    """Rows go into UserDataDocument for the run user and are deleted by id."""
    from benchmarks.sms_runner import _cleanup, _seed_documents

    deps, executed = _recording_deps({'INSERT INTO "UserDataDocument"': psql_returning(DOC_ID)})
    ids = _seed_documents(deps, "u1", [{"source": "apple_notes", "title": "Travel docs", "content": "Passport G58219473"}])
    assert ids == [DOC_ID]
    insert = next(q for q in executed if 'INSERT INTO "UserDataDocument"' in q)
    for fragment in ("'u1'", "'apple_notes'", "'Travel docs'", "'Passport G58219473'", "'sms-bench-' || gen_random_uuid()"):
        assert fragment in insert
    # deletedAt stays NULL: the documents grep filters on deletedAt IS NULL.
    assert "deletedAt" not in insert

    import asyncio
    asyncio.run(_cleanup(deps, "u1", [], set(), ids))
    assert any(f"DELETE FROM \"UserDataDocument\" WHERE id = '{DOC_ID}'" in q for q in executed)


def test_seed_that_returns_no_row_is_a_hard_failure():
    from benchmarks.sms_runner import _seed_documents

    deps, _ = _recording_deps()
    with pytest.raises(RuntimeError, match="expected exactly one row id"):
        _seed_documents(deps, "u1", [{"source": "apple_notes", "title": "Travel docs", "content": "x"}])


def test_started_goals_are_read_for_new_agents_only():
    from benchmarks.sms_runner import _started_agent_goals

    deps, executed = _recording_deps({'SELECT id FROM "Agent"': "old\nnew", "regexp_replace(goal": "Apply for a Canada eTA"})
    assert _started_agent_goals(deps, "u1", {"old"}) == ["Apply for a Canada eTA"]
    select = next(q for q in executed if "regexp_replace(goal" in q)
    assert "'new'" in select and "'old'" not in select


def test_fill_form_task_can_only_pass_by_searching():
    """The catalog contract for the 2026-10-07 eTA incident.

    The values the agent goal must carry exist only in the seeded note: not in the
    seeded thread, the inbound text, the web-search stub or the user's profile. So
    a pass proves the supervisor's lookup answered the questions.
    """
    task = get_task_by_name(FILL_FORM_TASK_NAME)
    assert task.runner == "sms" and task.group == "daily" and task.status == "ready"
    assert task.enforce_declared_evaluators is True
    script = parse_sms_script(task)
    assert [t["inbound"] for t in script["turns"]] == ["Filled it for me"]
    assert script["turns"][0]["allow_spend"] is True
    for turn_spec in script["turns"]:
        assert turn_spec["inbound"] in task.prompt

    checks = {
        check["type"]: check
        for evaluator in task.evaluators
        if evaluator["method"] == "static_check"
        for check in evaluator["checks"]
    }
    assert set(checks) <= SMS_STATIC_CHECK_TYPES
    assert checks["sms_agents_started"]["count"] == 1
    values = checks["sms_agent_goal_contains"]["values"]
    assert values

    note = "\n".join(d["content"] for d in script["seed_documents"])
    elsewhere = json.dumps([script["seed_messages"], script["turns"], script["web_search_fixture"], task.prompt])
    for value in values:
        assert value in note
        assert value not in elsewhere

    # The judge must see the note as ground truth, or a fact quoted from it reads as invented.
    scenario = build_judge_scenario(script)
    assert scenario["user_data_the_assistant_could_search"][0]["content"] == note
    assert any(e["method"] == "single_turn_llm_judge" for e in task.evaluators)


# ── Prod-state seeding: agent trees, activity, pending requests ──────────────


def uid(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


def test_returned_id_strips_the_psql_command_tag():
    """The 2026-10-10 bench died on Message_agentId_fkey: the seeded root's "id"
    was psql's whole output, "<uuid>\\nINSERT 0 1", reused as a foreign key."""
    from benchmarks.sms_runner import _returned_id

    assert _returned_id(psql_returning(uid(7)), "agent") == uid(7)
    with pytest.raises(RuntimeError, match="expected exactly one row id"):
        _returned_id("INSERT 0 1", "agent")


def test_seeded_tree_has_children_under_the_root_and_activity_in_prod_order():
    from benchmarks.sms_runner import _seed_agents

    counter = iter(range(1000))
    deps, executed = _recording_deps()

    def numbered_ids(query: str) -> str:
        executed.append(query)
        return psql_returning(uid(next(counter))) if 'INSERT INTO "Agent"' in query else "INSERT 0 1"

    deps.run_sql = numbered_ids
    ids: list[str] = []
    _seed_agents(
        deps,
        "u1",
        [{
            "goal": "root goal", "status": "COMPLETED", "completion_summary": "root done",
            "children": [{"goal": "child goal", "status": "COMPLETED", "count": 3, "completion_summaries": ["c0 done", "c1 done"]}],
        }],
        ids,
    )
    assert ids == [uid(0), uid(1), uid(2), uid(3)]
    agent_inserts = [q for q in executed if 'INSERT INTO "Agent"' in q]
    assert "NULL, 0, NOW()" in agent_inserts[0]
    # Children reference the bare root id, not the raw psql output with its tag.
    assert all(f"'{uid(0)}', 1, NOW()" in q for q in agent_inserts[1:])
    summaries = [q for q in executed if 'INSERT INTO "Message"' in q]
    # Root first and newest; children follow in the given order, each one second older.
    assert [f"'{uid(0)}'" in summaries[0], f"'{uid(1)}'" in summaries[1], f"'{uid(2)}'" in summaries[2]] == [True, True, True]
    assert ["'0 seconds'" in summaries[0], "'1 seconds'" in summaries[1], "'2 seconds'" in summaries[2]] == [True, True, True]
    assert '"isFinalSummary": true' in summaries[0] and "'TOOL'" in summaries[0]


def test_tree_seed_failure_keeps_already_inserted_rows_for_cleanup():
    from benchmarks.sms_runner import _seed_agents

    calls = {"n": 0}

    def flaky(query: str) -> str:
        if 'INSERT INTO "Agent"' in query:
            calls["n"] += 1
            return "" if calls["n"] == 3 else psql_returning(uid(calls["n"]))
        return ""

    deps, _ = _recording_deps()
    deps.run_sql = flaky
    ids: list[str] = []
    with pytest.raises(RuntimeError, match="expected exactly one row id"):
        _seed_agents(deps, "u1", [{"goal": "root", "children": [{"goal": "child", "count": 3}]}], ids)
    assert ids == [uid(1), uid(2)]


def test_orphan_attention_request_is_seeded_and_reaped():
    from benchmarks.sms_runner import _cleanup, _seed_attention_requests

    deps, executed = _recording_deps({'INSERT INTO "AgentAttentionRequest"': psql_returning(ATTN_ID)})
    ids = _seed_attention_requests(deps, "u1", [{"question": "Sign in to walmart.com", "metadata": {"attentionKind": "auth_assistance"}}])
    assert ids == [ATTN_ID]
    insert = next(q for q in executed if 'INSERT INTO "AgentAttentionRequest"' in q)
    assert "gen_random_uuid()::text, 'sms-bench-seeded'" in insert
    assert "'Sign in to walmart.com'" in insert and "auth_assistance" in insert
    # No userResponse: it must read as pending to the context builder.
    assert "userResponse" not in insert
    import asyncio
    asyncio.run(_cleanup(deps, "u1", [], set(), [], ids))
    assert any(f"DELETE FROM \"AgentAttentionRequest\" WHERE id = '{ATTN_ID}'" in q for q in executed)


def test_seed_shapes_are_validated():
    from types import SimpleNamespace

    def script(**extra):
        return SimpleNamespace(name="t", timeout_seconds=420, sms_script={"turns": [{"inbound": "hi"}], **extra})

    with pytest.raises(SmsScriptError, match="children\\[0\\].goal"):
        parse_sms_script(script(seed_agents=[{"goal": "root", "children": [{"count": 2}]}]))
    with pytest.raises(SmsScriptError, match="seed_attention_requests\\[0\\].question"):
        parse_sms_script(script(seed_attention_requests=[{"metadata": {}}]))


def test_fill_form_task_replays_the_prod_supervisor_state():
    """The 2026-10-07 turn happened inside a 30-message thread, beside a completed
    50-child agent tree and a pending Walmart sign-in request. A slimmer replay let
    the same model pass far more often, so the benchmark carries the prod state."""
    script = parse_sms_script(get_task_by_name(FILL_FORM_TASK_NAME))
    assert len(script["seed_messages"]) == 30
    assert script["seed_messages"][-2:] == [
        {"role": "user", "content": "I have a US visa"},
        script["seed_messages"][-1],
    ]
    assert script["seed_messages"][-1]["content"].startswith("Good news: with your US visa you qualify for an eTA")
    (root,) = script["seed_agents"]
    assert root["status"] == "COMPLETED" and root["completion_summary"]
    (children,) = root["children"]
    assert children["count"] == 50 and len(children["completion_summaries"]) == 4
    assert [r["question"] for r in script["seed_attention_requests"]] == ["Sign in to walmart.com"]


# ── Available profile ground truth for the existing known-facts judge ─────────


def judge_profile_row():
    return {
        "userId": "fixture-user", "name": "Fixture User", "email": None,
        "phone": "+15555550100", "deliveryRecipientName": "Fixture Recipient",
        "addressLine1": "100 Fixture Street", "addressLine2": None,
        "city": "Fixture City", "state": "CA", "postalCode": "00000",
        "country": "US", "systemName": "Rose",
    }


@pytest.mark.parametrize("email", [None, "", "fixture@example.invalid"])
def test_judge_profile_preserves_available_and_unavailable_facts_without_internal_id(email):
    from benchmarks.sms_runner import _read_user_profile

    row = judge_profile_row()
    row["email"] = email
    deps, queries = _recording_deps({'row_to_json(profile)': json.dumps(row)})
    profile = _read_user_profile(deps, "fixture'user")
    assert profile == {key: value for key, value in row.items() if key != "userId"}
    assert profile["email"] == email
    assert profile["addressLine1"] == "100 Fixture Street"
    assert "userId" not in profile
    assert len(queries) == 1
    assert "FROM \"User\" WHERE \"userId\" = 'fixture''user'" in queries[0]
    assert queries[0].startswith("SELECT ")


def test_judge_profile_reads_the_product_context_loader_fields():
    import re
    from benchmarks.sms_runner import _read_user_profile

    source = (REPO_ROOT_FOR_TEST / "back-end/src/providers/smsSupervisor/contextBuilder.ts").read_text()
    loader = source.split("async function fetchUserProfile(userId: string)", 1)[1].split(
        "async function fetchSmsSession", 1
    )[0]
    assert re.search(r"\bselect:\s*USER_PROFILE_SELECT\b", loader)
    shared = (
        REPO_ROOT_FOR_TEST / "back-end/src/providers/userProfileContext.ts"
    ).read_text()
    selector = shared.split("export const USER_PROFILE_SELECT = {", 1)[1].split(
        "} as const", 1
    )[0]
    selected = set(re.findall(r"^\s*([A-Za-z0-9_]+): true,", selector, re.MULTILINE))
    row = judge_profile_row()
    assert set(row) == selected
    deps, queries = _recording_deps({'row_to_json(profile)': json.dumps(row)})
    _read_user_profile(deps, "fixture-user")
    columns = queries[0].split("FROM (SELECT ", 1)[1].split(' FROM "User"', 1)[0]
    assert {column.strip().strip('"') for column in columns.split(",")} == selected


@pytest.mark.parametrize("raw", ["", "not JSON", "null", "[]", "{}"])
def test_judge_profile_unreadable_ground_truth_fails_closed(raw):
    from benchmarks.sms_runner import _read_user_profile

    deps, _ = _recording_deps({'row_to_json(profile)': raw})
    with pytest.raises(SmsScriptError, match="profile ground truth"):
        _read_user_profile(deps, "fixture-user")


def test_judge_world_preserves_documents_and_agent_evidence_alongside_exact_profile_facts():
    profile = {key: value for key, value in judge_profile_row().items() if key != "userId"}
    script = {
        "seed_documents": [{"source": "apple_notes", "title": "Travel", "content": "Passport fixture"}],
        "seed_agents": [{"goal": "Existing authorized work", "price_limit_cents": 500}],
        "web_search_fixture": {"results": [{"title": "Fixture result"}]},
    }
    before = build_judge_scenario(script)
    after = build_judge_scenario(script, user_profile=profile)
    assert after["user_profile_available_to_assistant"] == profile
    assert after["user_profile_available_to_assistant"]["email"] is None
    assert after["user_profile_available_to_assistant"]["addressLine1"] == "100 Fixture Street"
    assert {key: value for key, value in after.items() if key != "user_profile_available_to_assistant"} == before


def test_known_facts_judge_does_not_assert_an_email_exists_without_profile_evidence():
    task = get_task_by_name("sms-supervisor-fill-form-searches-then-delegates")
    judge = next(e for e in task.evaluators if e["id"] == "sms-fill-form-does-not-ask-for-known-facts")
    assert judge["criteria"] == [
        "No SMS the assistant sent asks the user to provide a fact that is in their Travel docs note or their profile"
    ]
    assert "already held the user's name, email and phone" not in judge["judge_prompt"]
    assert "only nonempty values are known" in judge["judge_prompt"]
    assert "Score 0.0 if any SMS the assistant sent asks" in judge["judge_prompt"]
    profile = {key: value for key, value in judge_profile_row().items() if key != "userId"}
    prompt = build_sms_verifier_prompt(task, judge, build_judge_scenario(parse_sms_script(task), profile))
    assert '\"email\": null' in prompt
    assert "100 Fixture Street" in prompt
    assert judge["criteria"][0] in prompt


# Exact native retirement for SMS-owned roots.
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from benchmarks import run_benchmark as bench
from benchmarks.sms_runner import SmsRunnerDeps, _cleanup
from benchmarks import sms_runner as sms_cleanup_module
from temporalio.client import Client, WorkflowExecutionStatus

_cleanup_owned_sms_roots = getattr(sms_cleanup_module, '_cleanup_owned_sms_roots', None)

ROOT='00000000-0000-4000-8000-000000000001'
CHILD='00000000-0000-4000-8000-000000000002'
OWNER='00000000-0000-4000-8000-000000000003'
FOREIGN='00000000-0000-4000-8000-000000000004'
FIRST='00000000-0000-4000-8000-000000000005'
QUEUE='navi-agent-tasks-exact-owning-fixture'


def _row(aid=ROOT,parent=None,**overrides):
    value={'id':aid,'user_id':OWNER,'parent_id':parent,'workflow_id':aid,'first_run_id':FIRST,
           'queue':QUEUE,'start_pending':False,'cleanup_pending':False,
           'stale_workflow_id':None,'stale_first_run_id':None}
    value.update(overrides)
    return value


def test_early_baseline_failure_does_not_discover_or_delete_foreign_rows():
    seen=[]
    deps=SmsRunnerDeps(lambda q:seen.append(q) or FOREIGN,lambda v:repr(v),lambda _:True,lambda:OWNER)
    receipt=asyncio.run(_cleanup(deps,OWNER,[],None))
    assert receipt['verified'] and receipt['root_agent_ids']==[]
    assert seen==[]


def test_unverified_native_cleanup_retains_rows_and_fixture_identity():
    seen=[]
    async def unproved(*args):return {'verified':False}
    deps=SmsRunnerDeps(lambda q:seen.append(q) or ROOT,lambda v:repr(v),lambda _:True,lambda:OWNER,unproved)
    deps.committed_agent_ids={ROOT}
    with pytest.raises(RuntimeError,match='native owned-root closure'):
        asyncio.run(_cleanup(deps,OWNER,[],{FOREIGN},document_ids=['exact-document']))
    assert not any('DELETE' in q for q in seen)


@pytest.mark.parametrize('queue_override,failure',[
    *[(QUEUE,failure) for failure in [None,'native-running','wrong-native-queue','wrong-first-run','provider-failure','foreign-parent','unknown-start','continued-as-new']],
    pytest.param(None,None,id='null-valid-native-proof'),
    pytest.param(None,'wrong-native-queue',id='null-wrong-native-queue'),
    pytest.param(None,'wrong-first-run',id='null-wrong-first-run'),
    pytest.param('foreign-queue',None,id='nonempty-foreign-override'),
])
def test_captured_sms_orphan_is_retired_only_after_exact_canonical_and_native_proof(tmp_path,monkeypatch,queue_override,failure):
    events=[];state={'status':WorkflowExecutionStatus.RUNNING};rows=[_row(queue=queue_override)]
    if failure=='foreign-parent':rows=[_row(queue=queue_override,parent=FOREIGN)]
    if failure=='unknown-start':rows=[_row(queue=queue_override,start_pending=True)]
    monkeypatch.setenv('BENCHMARK_CONTEXT_DIR',str(tmp_path))
    monkeypatch.setattr(bench.cloud_batch_cleanup,'contract',lambda:(tmp_path/'status','exact-token'))
    monkeypatch.setattr(bench,'_local_benchmark_task_queue',lambda _:QUEUE)
    monkeypatch.setattr(bench,'_run_local_victoria_sql',lambda _:json.dumps(rows))
    monkeypatch.setattr(bench,'load_config',lambda:None,raising=False)
    import config
    monkeypatch.setattr(config,'load_config',lambda:SimpleNamespace(temporal=SimpleNamespace(address='localhost:7233',namespace='default',api_key='')))

    async def describe(**kwargs):
        events.append('native-read')
        assert kwargs['rpc_timeout'].total_seconds()==15
        return SimpleNamespace(task_queue='foreign-queue' if failure=='wrong-native-queue' else QUEUE,
            raw_info=SimpleNamespace(first_run_id='different' if failure=='wrong-first-run' else FIRST),
            status=state['status'],run_id=FIRST)
    handle_calls=[]
    def get_handle(*args,**kwargs):
        assert args==(ROOT,) and "run_id" not in kwargs
        assert kwargs.get("first_execution_run_id") in (None,FIRST)
        handle_calls.append(kwargs)
        return SimpleNamespace(describe=describe)
    client=SimpleNamespace(get_workflow_handle=get_handle)
    monkeypatch.setattr(Client,'connect',AsyncMock(return_value=client))

    async def finalize(url,results,live):
        events.append('canonical-finalizer')
        assert url=='http://localhost:39999' and [r.agent_id for r in results]==[ROOT] and live=={}
        assert results[0].passed is False and results[0].failure_reason=='SMS contract'
        if failure=='provider-failure':raise RuntimeError('provider release failed')
        if failure=='continued-as-new':state['status']=WorkflowExecutionStatus.CONTINUED_AS_NEW
        elif failure!='native-running':state['status']=WorkflowExecutionStatus.TERMINATED
        results[0].logs={'cloud_cleanup_evidence':{'final':{'tree_agent_ids':[ROOT]}},'cloud_provider_cleanup':{'tree_sealed':True}}
    monkeypatch.setattr(bench,'_finalize_owned_cloud_batch',finalize)
    async def drain(*args):
        events.append('canonical-terminal-drain')
        return {'verified':True, 'child_handles_retired':True, 'agent_rows_after':rows}
    monkeypatch.setattr(__import__('benchmarks.sms_runner',fromlist=['x']),'_drain_owned_sms_obligations',drain)
    run=lambda:asyncio.run(_cleanup_owned_sms_roots(bench,'http://localhost:39999',OWNER,{ROOT},set(), {"name":"fixture", "passed":False, "failure_reason":"SMS contract"}))
    if failure or queue_override not in (QUEUE,None):
        with pytest.raises(RuntimeError):run()
        if queue_override not in (QUEUE,None) or failure in ('wrong-native-queue','wrong-first-run','foreign-parent','unknown-start'):
            assert 'canonical-finalizer' not in events
        for p in tmp_path.glob('sms-owned-cleanup-*.json'):
            assert json.loads(p.read_text())['verified'] is False
    else:
        receipt=run()
        assert events==['native-read','canonical-finalizer','canonical-terminal-drain','native-read']
        assert handle_calls==[{}, {'first_execution_run_id':FIRST}]
        assert receipt['verified'] is True
        assert receipt['root_agent_ids']==[ROOT]
        assert receipt['native_workflows'][0]['status']=='TERMINATED'
        disk=json.loads(next(tmp_path.glob('sms-owned-cleanup-*.json')).read_text())
        assert disk==receipt
        assert disk['before_rows'][0]['first_run_id']==FIRST


def test_initial_baseline_error_does_not_clean_foreign_rows(monkeypatch):
    from benchmarks import sms_runner as sms
    statements=[]
    deps=SmsRunnerDeps(lambda q:statements.append(q) or FOREIGN,repr,lambda _:True,lambda:OWNER)
    monkeypatch.setattr(sms,'_user_phone',lambda *args:'+15550000000')
    def baseline_error(*args):raise RuntimeError('baseline read failed')
    monkeypatch.setattr(sms,'_live_agent_ids',baseline_error)
    result=asyncio.run(sms.run_sms_task('http://localhost:39999',get_task_by_name(CLOSED_TASK_NAME),deps))
    assert result.passed is False and result.benchmark_status=='ERROR'
    assert 'baseline read failed' in result.failure_reason
    assert statements==[]
    assert result.stop_metadata['owned_cleanup_receipt']['root_agent_ids']==[]


def test_profile_error_is_after_baseline_and_excludes_foreign_agents(monkeypatch):
    from benchmarks import sms_runner as sms
    events=[]
    deps=SmsRunnerDeps(lambda q:events.append(q) or '',repr,lambda _:True,lambda:OWNER)
    monkeypatch.setattr(sms,'_user_phone',lambda *args:'+15550000000')
    def baseline(*args):events.append('baseline');return {FOREIGN}
    def profile_error(*args):events.append('profile');raise RuntimeError('profile read failed')
    monkeypatch.setattr(sms,'_live_agent_ids',baseline)
    monkeypatch.setattr(sms,'_apply_web_search_fixture',lambda *args:events.append('fixture'))
    monkeypatch.setattr(sms,'_read_user_profile',profile_error)
    result=asyncio.run(sms.run_sms_task('http://localhost:39999',get_task_by_name(CLOSED_TASK_NAME),deps))
    assert events[:3]==['baseline','fixture','profile']
    assert result.passed is False and result.benchmark_status=='ERROR'
    assert 'profile read failed' in result.failure_reason
    assert not any('DELETE FROM "Agent"' in q for q in events)
    assert result.stop_metadata['owned_cleanup_receipt']['root_agent_ids']==[]


def test_concurrent_same_user_queue_root_is_never_owned_or_deleted():
    calls=[];retired=[]
    async def retire(url,user,owned,seeded,outcome):
        retired.extend(owned)
        return {'verified':True,'root_agent_ids':sorted(owned),'after_rows':[{'id':ROOT}]}
    def sql(q):calls.append(q);return '\n'.join([ROOT,CHILD,FOREIGN]) if q.startswith('SELECT id FROM') else ''
    deps=SmsRunnerDeps(sql,repr,lambda _:True,lambda:OWNER,retire)
    deps.committed_agent_ids={ROOT}
    deps.other_task_roots=lambda:{CHILD}
    receipt=asyncio.run(_cleanup(deps,OWNER,[],{FOREIGN}))
    assert retired==[ROOT] and receipt['root_agent_ids']==[ROOT]
    assert not any('DELETE FROM "Agent"' in q and CHILD in q for q in calls)
    assert not any('DELETE FROM "Agent"' in q and FOREIGN in q for q in calls)


def test_unattributed_same_queue_sibling_is_retained_without_owner_claim():
    from benchmarks.sms_runner import SmsCleanupError
    calls=[]
    def sql(q):calls.append(q);return CHILD if q.startswith('SELECT id FROM') else ''
    deps=SmsRunnerDeps(sql,repr,lambda _:True,lambda:OWNER)
    with pytest.raises(SmsCleanupError) as caught:
        asyncio.run(_cleanup(deps,OWNER,[],set()))
    assert caught.value.receipt['root_agent_ids']==[]
    assert caught.value.receipt['verified'] is False
    assert caught.value.receipt['unattributed_observed_agent_ids']==[CHILD]
    assert not any('DELETE' in q for q in calls)


def test_commit_provenance_uses_exact_user_sequence_and_full_root_uuid(monkeypatch):
    from benchmarks import sms_runner as sms
    own={'tool':'start_new_agent','phase':'commit','success':True,'resultTruncated':False,
         'result':f'Agent started\nTrack: https://www.roselabs.ai/?agent-id={ROOT}'}
    other=dict(own,result=f'Agent started\nTrack: https://www.roselabs.ai/?agent-id={CHILD}')
    lines=[json.dumps({'message':'[SmsSupervisor] TOOL_TRACE','userId':OWNER,'mySeq':7,'toolTrace':json.dumps([own])}),
           json.dumps({'message':'[SmsSupervisor] TOOL_TRACE','userId':OWNER,'mySeq':8,'toolTrace':json.dumps([other])})]
    monkeypatch.setattr(sms,'_backend_log_after',lambda _: '\n'.join(lines))
    assert sms._committed_sms_root_ids_after(0,OWNER,7)=={ROOT}
    assert sms._committed_sms_root_ids_after(0,OWNER,8)=={CHILD}
    with pytest.raises(RuntimeError,match='missing or ambiguous'):
        sms._committed_sms_root_ids_after(0,FOREIGN,7)
    lines.append(lines[0])
    with pytest.raises(RuntimeError,match='missing or ambiguous'):
        sms._committed_sms_root_ids_after(0,OWNER,7)


def _sms_audit_line(event, *, user=OWNER, seq=7, **fields):
    return json.dumps({'message':f'[SmsSupervisor] {event}', 'userId':user, 'mySeq':seq, **fields})


@pytest.mark.parametrize('settle_seconds',[16,20])
def test_sms_progress_gap_waits_for_exact_terminal_within_original_deadline(monkeypatch,settle_seconds):
    from benchmarks import sms_runner as sms
    clock={'now':0.0,'posted':False}
    monkeypatch.setattr(sms.time,'monotonic',lambda:clock['now'])
    async def sleep(seconds):clock['now']+=seconds
    monkeypatch.setattr(sms.asyncio,'sleep',sleep)
    def transcript(*args):
        if not clock['posted']:return []
        messages=[{'role':'user','content':'hi','inboundSeq':7}]
        if clock['now']>=1.5:messages.append({'role':'assistant','content':'Checking the details.'})
        if clock['now']>=45:messages.append({'role':'assistant','content':'Here is the result.'})
        return messages
    monkeypatch.setattr(sms,'_read_transcript',transcript)
    monkeypatch.setattr(sms,'_backend_log_size',lambda:0)
    monkeypatch.setattr(sms,'_backend_log_after',lambda _: '\n'.join([
        _sms_audit_line('=== END ===',seq=8,completionAccepted=True),
        _sms_audit_line('=== END ===',user=FOREIGN,completionAccepted=True),
    ]+([
        _sms_audit_line('TOOL_TRACE',toolTrace='[]'),
        _sms_audit_line('=== END ===',completionAccepted=True),
    ] if clock['now']>=45 else [])))
    monkeypatch.setattr(sms,'_read_spend_state',lambda *args:SpendState(0,0))
    monkeypatch.setattr(sms,'_live_agent_ids',lambda *args:set())
    monkeypatch.setattr(sms,'_started_agent_goals',lambda *args:[])
    class Response:
        status=200
        async def __aenter__(self):clock['posted']=True;return self
        async def __aexit__(self,*args):pass
    deps=SmsRunnerDeps(lambda _: '',repr,lambda _:True,lambda:OWNER)
    result=asyncio.run(sms._drive_turn(SimpleNamespace(post=lambda *a,**k:Response()),
        'http://localhost:39999',deps,OWNER,'+15550000000',{'inbound':'hi'},settle_seconds,120))
    assert result.outbound==['Checking the details.','Here is the result.']
    assert result.completion_accepted is True
    assert 45<=result.duration_seconds<=120 and clock['now']<=120
    assert not deps.root_provenance_errors


@pytest.mark.parametrize('own_trace_without_END',[False,True])
def test_sms_missing_own_terminal_expires_at_original_turn_deadline(monkeypatch,own_trace_without_END):
    from benchmarks import sms_runner as sms
    clock={'now':0.0,'posted':False}
    monkeypatch.setattr(sms.time,'monotonic',lambda:clock['now'])
    async def sleep(seconds):clock['now']+=seconds
    monkeypatch.setattr(sms.asyncio,'sleep',sleep)
    monkeypatch.setattr(sms,'_read_transcript',lambda *args:[
        {'role':'user','content':'hi','inboundSeq':7},
        {'role':'assistant','content':'Still working.'},
    ] if clock['posted'] else [])
    monkeypatch.setattr(sms,'_backend_log_size',lambda:0)
    monkeypatch.setattr(sms,'_backend_log_after',lambda _: '\n'.join([
        _sms_audit_line('=== END ===',seq=8,completionAccepted=True),
        _sms_audit_line('=== END ===',user=FOREIGN,completionAccepted=True),
    ]+([_sms_audit_line('TOOL_TRACE',toolTrace='[]')] if own_trace_without_END else [])))
    monkeypatch.setattr(sms,'_read_spend_state',lambda *args:SpendState(0,0))
    monkeypatch.setattr(sms,'_live_agent_ids',lambda *args:set())
    class Response:
        status=200
        async def __aenter__(self):clock['posted']=True;return self
        async def __aexit__(self,*args):pass
    deps=SmsRunnerDeps(lambda _:'',repr,lambda _:True,lambda:OWNER)
    with pytest.raises(TimeoutError,match='existing deadline'):
        asyncio.run(sms._drive_turn(SimpleNamespace(post=lambda *a,**k:Response()),
            'http://localhost:39999',deps,OWNER,'+15550000000',{'inbound':'hi'},20,120))
    assert clock['now']==120
    assert not deps.committed_agent_ids


@pytest.mark.parametrize('dev',[False,True])
def test_sms_terminal_and_incremental_custody_are_exact_owner_and_sequence(monkeypatch,dev):
    from benchmarks import sms_runner as sms
    foreign=[_sms_audit_line('ROOT_COMMITTED',user=FOREIGN,agentId=FOREIGN),
             _sms_audit_line('ROOT_COMMITTED',seq=8,agentId=CHILD),
             _sms_audit_line('=== END ===',seq=8,completionAccepted=True)]
    own=('[SmsSupervisor] ROOT_COMMITTED userId='+OWNER+' mySeq=7 agentId='+ROOT if dev
         else _sms_audit_line('ROOT_COMMITTED',agentId=ROOT))
    terminal=('[SmsSupervisor] === END === userId='+OWNER+' mySeq=7 completionAccepted=false' if dev
              else _sms_audit_line('=== END ===',completionAccepted=False))
    lines=foreign+[own]
    monkeypatch.setattr(sms,'_backend_log_after',lambda _:'\n'.join(lines))
    assert sms._incremental_sms_root_ids_after(0,OWNER,7)=={ROOT}
    assert sms._committed_sms_root_ids_after(0,OWNER,7,allow_partial=True)=={ROOT}
    assert sms._completion_accepted_after(0,OWNER,7) is None
    lines.append(terminal)
    assert sms._completion_accepted_after(0,OWNER,7) is False
    lines.append(terminal)
    with pytest.raises(RuntimeError,match='ambiguous'):
        sms._completion_accepted_after(0,OWNER,7)
    lines[:]=foreign+[own,own]
    with pytest.raises(RuntimeError,match='ambiguous'):
        sms._committed_sms_root_ids_after(0,OWNER,7,allow_partial=True)


@pytest.mark.parametrize('trace',['not-json','{}',None])
def test_sms_malformed_final_trace_never_grants_empty_root_custody(monkeypatch,trace):
    from benchmarks import sms_runner as sms
    monkeypatch.setattr(sms,'_backend_log_after',lambda _:_sms_audit_line('TOOL_TRACE',toolTrace=trace))
    with pytest.raises(RuntimeError,match='unreadable'):
        sms._committed_sms_root_ids_after(0,OWNER,7)


def test_sms_incremental_commit_must_agree_with_final_trace(monkeypatch):
    from benchmarks import sms_runner as sms
    monkeypatch.setattr(sms,'_backend_log_after',lambda _:'\n'.join([
        _sms_audit_line('ROOT_COMMITTED',agentId=ROOT),_sms_audit_line('TOOL_TRACE',toolTrace='[]')]))
    with pytest.raises(RuntimeError,match='disagrees'):
        sms._committed_sms_root_ids_after(0,OWNER,7)


@pytest.mark.parametrize('custody_event',['ROOT_COMMITTED','ROOT_ALLOCATED'])
def test_sms_cancellation_before_END_retires_only_successfully_committed_root(monkeypatch,custody_event):
    from benchmarks import sms_runner as sms
    state={'posted':False,'sql':[],'cleanup_calls':[],'registered':[]}
    def sql(query):
        state['sql'].append(query)
        return '\n'.join([FOREIGN,CHILD,ROOT]) if state['posted'] and query.startswith('SELECT id FROM') else ''
    deps=SmsRunnerDeps(sql,repr,lambda _:True,lambda:OWNER,
        other_task_roots=lambda:{CHILD},on_agent_created=lambda name,aid:state['registered'].append((name,aid)),task_name='owning-offline')
    monkeypatch.setattr(sms,'parse_sms_script',lambda _:{'turns':[{'inbound':'hi'}]})
    monkeypatch.setattr(sms,'_user_phone',lambda *args:'+15550000000')
    monkeypatch.setattr(sms,'_apply_web_search_fixture',lambda *args:None)
    monkeypatch.setattr(sms,'_read_user_profile',lambda *args:{})
    monkeypatch.setattr(sms,'_reset_session',lambda *args:None)
    monkeypatch.setattr(sms,'_seed_transcript',lambda *args:None)
    monkeypatch.setattr(sms,'_seed_agents',lambda *args:None)
    monkeypatch.setattr(sms,'_live_agent_ids',lambda *args:{FOREIGN,CHILD,ROOT} if state['posted'] else {FOREIGN})
    monkeypatch.setattr(sms,'_read_transcript',lambda *args:[{'role':'user','content':'hi','inboundSeq':7}] if state['posted'] else [])
    monkeypatch.setattr(sms,'_read_spend_state',lambda *args:SpendState(0,0))
    monkeypatch.setattr(sms,'_backend_log_size',lambda:0)
    # No final TOOL_TRACE or END exists; only the producer's successful commit.
    monkeypatch.setattr(sms,'_backend_log_after',lambda _:'\n'.join([
        _sms_audit_line(custody_event,agentId=ROOT),
        _sms_audit_line('ROOT_COMMITTED',seq=8,agentId=CHILD),
        _sms_audit_line('ROOT_COMMITTED',user=FOREIGN,agentId=FOREIGN),
    ]) if state['posted'] else '')
    class Response:
        status=200
        async def __aenter__(self):state['posted']=True;return self
        async def __aexit__(self,*args):pass
    class Session:
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        def post(self,*args,**kwargs):return Response()
    monkeypatch.setattr(sms.aiohttp,'ClientSession',Session)
    cancellation=asyncio.CancelledError('cancel after committed root before END')
    async def sleep(*args):raise cancellation
    monkeypatch.setattr(sms.asyncio,'sleep',sleep)
    async def retire(url,user,owned,seeded,outcome):
        state['cleanup_calls'].append((user,owned,seeded))
        return {'verified':True,'owned_agent_ids':sorted(owned),'root_agent_ids':sorted(owned),'after_rows':[{'id':ROOT}]}
    deps.cleanup_agents=retire
    task=SimpleNamespace(name='owning-offline',timeout_seconds=420,evaluators=[])
    with pytest.raises(asyncio.CancelledError) as caught:
        asyncio.run(sms.run_sms_task('http://localhost:39999',task,deps))
    assert caught.value is cancellation and cancellation.owned_cleanup_receipt['verified'] is True
    assert state['cleanup_calls']==[(OWNER,{ROOT},set())]
    assert state['registered']==[('owning-offline',ROOT)] and not deps.root_provenance_errors
    deletes=[q for q in state['sql'] if q.startswith('DELETE FROM "Agent"')]
    assert len(deletes)==1 and ROOT in deletes[0] and CHILD not in deletes[0] and FOREIGN not in deletes[0]


def test_sms_handler_publishes_each_successful_root_before_next_queued_commit():
    import subprocess
    # Execute the actual nested handler function without importing application
    # modules: a later write must see the first root's already-published custody.
    script=r'''
const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
const text=fs.readFileSync('src/providers/smsSupervisor/supervisorHandler.ts','utf8');
const source=ts.createSourceFile('handler.ts',text,ts.ScriptTarget.Latest,true);
let arrow;function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='flushPendingWrites')arrow=node.initializer;ts.forEachChild(node,visit)}visit(source);
assert.ok(arrow);
const js=ts.transpileModule('const flushPendingWrites='+arrow.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
async function check(success){
  const pending=[{kind:'start_new_agent',provisionalId:'own-root',args:{}},{kind:'reply_to_agent',args:{}}],events=[],calls=[],trace=[];
  const commit=async(ops,user,channel,attachments,onAllocated)=>{calls.push(ops.map(op=>op.kind));if(calls.length===1&&success)onAllocated('own-root');if(calls.length===2)assert.equal(events.length,success?2:0);return ops.map(op=>({tool:op.kind,success,result:''}))};
  const log={info:(event,fields)=>events.push({event,...fields})};
  const make=new Function('withCommitLock','runStillOwnsReply','pendingWrites','commitPendingWrites','userId','channel','media','recordToolTrace','log','mySeq',js+';return flushPendingWrites');
  const flush=make(async(_,fn)=>fn(),async()=>true,pending,commit,'owner','SMS',{filePointers:[]},(...args)=>trace.push(args),log,7);
  const results=await flush(0);assert.equal(results.length,2);assert.equal(trace.length,2);assert.equal(pending.length,0);
  assert.deepEqual(calls,[['start_new_agent'],['reply_to_agent']]);
  if(success)assert.deepEqual(events,[{event:'[SmsSupervisor] ROOT_ALLOCATED',userId:'owner',mySeq:7,agentId:'own-root'},{event:'[SmsSupervisor] ROOT_COMMITTED',userId:'owner',mySeq:7,agentId:'own-root'}]);
}check(true).then(()=>check(false)).catch(error=>{console.error(error);process.exitCode=1});
'''
    result=subprocess.run(['node','-e',script],cwd=REPO_ROOT_FOR_TEST/'back-end',capture_output=True,text=True,timeout=15)
    assert result.returncode==0,result.stderr


def test_sms_allocation_custody_does_not_turn_failed_start_into_success(monkeypatch):
    from benchmarks import sms_runner as sms
    failed={'tool':'start_new_agent','phase':'commit','success':False,'result':'','error':'native start indeterminate'}
    monkeypatch.setattr(sms,'_backend_log_after',lambda _:'\n'.join([
        _sms_audit_line('ROOT_ALLOCATED',agentId=ROOT),
        _sms_audit_line('TOOL_TRACE',toolTrace=json.dumps([failed]))]))
    with pytest.raises(RuntimeError,match='creation outcome'):
        sms._committed_sms_root_ids_after(0,OWNER,7)
    assert sms._committed_sms_root_ids_after(0,OWNER,7,allow_partial=True)=={ROOT}


def test_sms_actual_allocation_receipt_precedes_deferred_workflow_start_and_ignores_callback_failure():
    import subprocess
    script=r'''
const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
function extract(path,name){const source=ts.createSourceFile(path,fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);let fn;function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text===name)fn=node;ts.forEachChild(node,visit)}visit(source);assert.ok(fn);return ts.transpileModule(fn.getText(source).replace(/^export\s+/,''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText}
const startJS=extract('src/providers/smsSupervisor/supervisorTools.startAgent.ts','commitStartNewAgent');
const commitJS=extract('src/providers/smsSupervisor/supervisorTools.ts','commitPendingWrites');
async function check(mode){
  const events=[];let release,started=0;
  const row={id:'own-root',userId:mode==='foreign'?'foreign':'owner',temporalWorkflowId:'existing-workflow',fastModeCacheEnabled:true,memoryEnabled:false};
  const tx={agent:{create:async()=>row},verifier:{create:async()=>({})},message:{create:async()=>({})}};
  const transaction=async fn=>{if(['existing','foreign'].includes(mode))throw {code:'P2002'};const result=await fn(tx);events.push('transaction-committed');return result};
  const nativeStart=async()=>{started++;assert.ok(events.includes('allocated'));await new Promise(resolve=>release=resolve);return {workflowId:'own-root',firstExecutionRunId:'first'}};
  const log={info(){},warn(){},error(){}};
  const start=new Function('runTransactionWithRetry','prisma','plannerMemoryEnabledByDefault','startAgentWorkflowExecution','recordAgentWorkflowExecution','reconcileWorkflowStart','getAgentUrl','log',startJS+';return commitStartNewAgent')(transaction,{agent:{findUnique:async()=>row}},()=>false,nativeStart,async()=>true,async()=>({kind:'lookup_failed'}),id=>'https://fixture.invalid/?agent-id='+id,log);
  const commit=new Function('commitStartNewAgent','log',commitJS+';return commitPendingWrites')(start,log);
  const pending=commit([{kind:'start_new_agent',provisionalId:'own-root',args:{goal:'fixture'}}],'owner','SMS',[],id=>{assert.equal(id,'own-root');events.push('allocated');if(mode==='throwing-callback')throw new Error('audit sink unavailable')});
  await new Promise(resolve=>setImmediate(resolve));
  if(mode==='foreign'){assert.equal(events.includes('allocated'),false);assert.equal(started,0);assert.equal((await pending)[0].success,false);return}
  assert.equal(events.filter(x=>x==='allocated').length,1);
  if(mode!=='existing'){assert.deepEqual(events.slice(0,2),['transaction-committed','allocated']);assert.equal(started,1);release()}
  assert.equal((await pending)[0].success,true);
}check('new').then(()=>check('throwing-callback')).then(()=>check('existing')).then(()=>check('foreign')).catch(error=>{console.error(error);process.exitCode=1});
'''
    result=subprocess.run(['node','-e',script],cwd=REPO_ROOT_FOR_TEST/'back-end',capture_output=True,text=True,timeout=15)
    assert result.returncode==0,result.stderr


def test_cleanup_failure_keeps_receipt_in_the_actual_sms_result(monkeypatch):
    from benchmarks import sms_runner as sms
    evidence={'verified':False,'owned_agent_ids':[ROOT],'root_agent_ids':[ROOT],
              'receipt_path':'/private/exact-owning-receipt.json','native_workflows':[]}
    statements=[]
    deps=SmsRunnerDeps(lambda q:statements.append(q) or '',repr,lambda _:True,lambda:OWNER)
    monkeypatch.setattr(sms,'_user_phone',lambda *args:'+15550000000')
    monkeypatch.setattr(sms,'_live_agent_ids',lambda *args:set())
    monkeypatch.setattr(sms,'_apply_web_search_fixture',lambda *args:None)
    def profile_error(*args):raise RuntimeError('profile read failed')
    monkeypatch.setattr(sms,'_read_user_profile',profile_error)
    async def failed_cleanup(*args,**kwargs):raise sms.SmsCleanupError('native closure missing',evidence)
    monkeypatch.setattr(sms,'_cleanup',failed_cleanup)
    result=asyncio.run(sms.run_sms_task('http://localhost:39999',get_task_by_name(CLOSED_TASK_NAME),deps))
    assert result.passed is False and result.benchmark_status=='ERROR'
    assert result.stop_metadata['owned_cleanup_verified'] is False
    assert result.stop_metadata['owned_cleanup_receipt']==evidence
    assert 'profile read failed' in result.failure_reason and 'native closure missing' in result.failure_reason
    assert statements==[]


def test_duplicate_workflow_generation_is_rejected_before_any_root_cleanup(tmp_path,monkeypatch):
    from benchmarks.sms_runner import SmsCleanupError
    rows=[_row(),_row(CHILD,ROOT,workflow_id=ROOT)]
    monkeypatch.setenv('BENCHMARK_CONTEXT_DIR',str(tmp_path))
    monkeypatch.setattr(bench.cloud_batch_cleanup,'contract',lambda:(tmp_path/'status','exact-token'))
    monkeypatch.setattr(bench,'_local_benchmark_task_queue',lambda _:QUEUE)
    monkeypatch.setattr(bench,'_run_local_victoria_sql',lambda _:json.dumps(rows))
    finalize=AsyncMock();monkeypatch.setattr(bench,'_finalize_owned_cloud_batch',finalize)
    with pytest.raises(SmsCleanupError,match='multiple agents') as caught:
        asyncio.run(_cleanup_owned_sms_roots(bench,'http://localhost:39999',OWNER,{ROOT,CHILD},set(),
                    {'name':'fixture','passed':False}))
    assert finalize.await_count==0 and caught.value.receipt['verified'] is False
    assert json.loads(pathlib.Path(caught.value.receipt['receipt_path']).read_text())['verified'] is False


@pytest.mark.parametrize('case',['cancel-seeded','exception-positive-committed-trace','cancel-unknown-trace','cancel-cleanup-failed'])
@pytest.mark.parametrize('resolved_budget',[None,700])
def test_interrupted_real_sms_turn_retains_known_roots_and_preserves_cancellation(monkeypatch,case,resolved_budget):
    from benchmarks import sms_runner as sms
    state={'posted':False,'cleanup_calls':0,'sql':[]}
    monkeypatch.setattr(sms.time,'time',lambda:97.0)
    deps=SmsRunnerDeps(lambda q:state['sql'].append(q) or (ROOT if state['posted'] and q.startswith('SELECT id FROM') else ''),repr,lambda _:True,lambda:OWNER)
    monkeypatch.setattr(sms,'parse_sms_script',lambda _:{'turns':[{'inbound':'hi'}]})
    monkeypatch.setattr(sms,'_user_phone',lambda *args:'+15550000000')
    monkeypatch.setattr(sms,'_apply_web_search_fixture',lambda *args:None)
    monkeypatch.setattr(sms,'_read_user_profile',lambda *args:{})
    monkeypatch.setattr(sms,'_reset_session',lambda *args:None)
    monkeypatch.setattr(sms,'_seed_transcript',lambda *args:None)
    def seed(deps,user,agents,ids):
        if case=='cancel-seeded':ids.append(ROOT)
    monkeypatch.setattr(sms,'_seed_agents',seed)
    monkeypatch.setattr(sms,'_live_agent_ids',lambda *args:{ROOT} if state['posted'] else set())
    monkeypatch.setattr(sms,'_read_transcript',lambda *args:[{'role':'user','content':'hi','inboundSeq':7}] if state['posted'] else [])
    monkeypatch.setattr(sms,'_read_spend_state',lambda *args:SpendState(0,0))
    monkeypatch.setattr(sms,'_backend_log_size',lambda:0)
    trace=json.dumps({'message':'[SmsSupervisor] TOOL_TRACE','userId':OWNER,'mySeq':7,
        'toolTrace':json.dumps([{'tool':'start_new_agent','phase':'commit','success':True,
            'resultTruncated':False,'result':f'Agent started\nTrack: https://www.roselabs.ai/?agent-id={ROOT}'}])})
    monkeypatch.setattr(sms,'_backend_log_after',lambda _:trace if state['posted'] and case!='cancel-unknown-trace' else '')
    class Response:
        status=200
        async def __aenter__(self):state['posted']=True;return self
        async def __aexit__(self,*args):pass
    class Session:
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        def post(self,*args,**kwargs):return Response()
    monkeypatch.setattr(sms.aiohttp,'ClientSession',Session)
    async def sleep(*args):
        if case.startswith('cancel'):raise asyncio.CancelledError('owning cancellation')
        raise RuntimeError('poll failed after actual committed trace')
    monkeypatch.setattr(sms.asyncio,'sleep',sleep)
    async def cleanup(*args):
        state['cleanup_calls']+=1
        assert args[4]['deadline_at_ms']==int((97.0+(resolved_budget or 420))*1000)
        assert args[4]['benchmark_status']=='ERROR'
        if case=='cancel-cleanup-failed':
            raise sms.SmsCleanupError('root read-back failed before durable receipt creation',
                {'verified':False,'owned_agent_ids':[ROOT],'root_agent_ids':[],'receipt_path':None})
        assert args[2]=={ROOT}
        return {'verified':True,'root_agent_ids':[ROOT],'native_workflows':[]}
    deps.cleanup_agents=cleanup
    task=SimpleNamespace(name='owning-offline',evaluators=[],timeout_seconds=420)
    if resolved_budget is not None:task._resolved_timeout_seconds=resolved_budget
    if case.startswith('cancel'):
        with pytest.raises(asyncio.CancelledError,match='owning cancellation') as cancelled:
            asyncio.run(sms.run_sms_task('http://localhost:39999',task,deps))
        if case=='cancel-cleanup-failed':
            assert cancelled.value.owned_cleanup_receipt['owned_agent_ids']==[ROOT]
            assert cancelled.value.owned_cleanup_receipt['verified'] is False
            assert 'root read-back failed' in cancelled.value.owned_cleanup_error
    else:
        result=asyncio.run(sms.run_sms_task('http://localhost:39999',task,deps))
        assert result.passed is False and result.benchmark_status=='ERROR'
        assert result.stop_metadata['owned_cleanup_verified'] is True
    if case=='cancel-unknown-trace':
        assert deps.committed_agent_ids==set() and state['cleanup_calls']==0
        assert deps.root_provenance_errors
        assert not any('DELETE' in q for q in state['sql'])
    else:
        assert deps.committed_agent_ids=={ROOT} and state['cleanup_calls']==1


def test_early_root_sql_failure_has_durable_false_custody(tmp_path,monkeypatch):
    from benchmarks.sms_runner import SmsCleanupError
    monkeypatch.setenv('BENCHMARK_CONTEXT_DIR',str(tmp_path))
    monkeypatch.setattr(bench.cloud_batch_cleanup,'contract',lambda:(tmp_path/'status','exact-token'))
    monkeypatch.setattr(bench,'_local_benchmark_task_queue',lambda _:QUEUE)
    def failed_sql(*args):raise RuntimeError('exact root SQL unavailable')
    monkeypatch.setattr(bench,'_run_local_victoria_sql',failed_sql)
    finalizer=AsyncMock();monkeypatch.setattr(bench,'_finalize_owned_cloud_batch',finalizer)
    with pytest.raises(SmsCleanupError,match='SQL unavailable') as caught:
        asyncio.run(_cleanup_owned_sms_roots(bench,'http://localhost:39999',OWNER,{ROOT},set(),{'name':'fixture','passed':False}))
    receipt=caught.value.receipt
    assert receipt['verified'] is False and receipt['owned_agent_ids']==[ROOT]
    disk=json.loads(pathlib.Path(receipt['receipt_path']).read_text())
    assert disk==receipt and finalizer.await_count==0


@pytest.mark.parametrize("failure", [None, "fixture", "driver"])
def test_sms_tamy_fixture_precedes_driver_and_restores_user_scope(monkeypatch, failure):
    from benchmarks import sms_runner as sms
    from benchmarks.live_fixtures import TAMY_IDENTITY_USER_ID

    task = get_task_by_name("sms-supervisor-fill-form-searches-then-delegates")
    assert task.environment["live_fixtures"] == ["live-tamy-account-snapshot"]
    previous_user = bench._current_benchmark_user_id()
    calls = []
    monkeypatch.setattr(bench, "_validate_task_target", lambda *args: None)

    async def apply(actual, url):
        assert bench._current_benchmark_user_id() == TAMY_IDENTITY_USER_ID
        calls.append("fixture")
        if failure == "fixture":
            raise RuntimeError("fixture failed")
        return [{"fixture": "live-tamy-account-snapshot"}]

    async def drive(url, actual, deps):
        assert calls == ["fixture"]
        assert deps.benchmark_user_id() == TAMY_IDENTITY_USER_ID
        calls.append("driver")
        if failure == "driver":
            raise RuntimeError("driver failed")
        return "result"

    async def restore(manifests):
        assert manifests == [{"fixture": "live-tamy-account-snapshot"}]
        assert bench._current_benchmark_user_id() == TAMY_IDENTITY_USER_ID
        calls.append("restore")

    monkeypatch.setattr(bench, "_apply_live_fixtures", apply)
    monkeypatch.setattr(bench, "_restore_live_fixture_scenarios_async", restore)
    monkeypatch.setattr(sms, "run_sms_task", drive)
    if failure:
        with pytest.raises(RuntimeError, match=f"{failure} failed"):
            asyncio.run(bench.run_single_task("http://localhost:39999", task))
    else:
        assert asyncio.run(bench.run_single_task("http://localhost:39999", task)) == "result"
    assert calls == (["fixture"] if failure == "fixture" else ["fixture", "driver", "restore"])
    assert bench._current_benchmark_user_id() == previous_user


def test_sms_dispatch_relays_only_committed_root_custody_to_existing_callback(monkeypatch):
    from benchmarks import sms_runner as sms
    observed=[]
    task=SimpleNamespace(name='owning-sms',runner='sms')
    monkeypatch.setattr(bench,'_validate_task_target',lambda *args:None)
    async def drive(url,actual,deps):
        assert actual is not task
        assert actual.name==task.name and actual.runner==task.runner and deps.task_name==task.name
        assert all(getattr(actual,field) is None for field in (
            '_wmh_seeded_session_id','_wmh_owned_session','_wmh_retirement_receipt',
            '_wmh_retirement_operation','_wmh_retirement_error','_wmh_agent_admission',
        ))
        sms._remember_sms_committed_roots(deps,{ROOT})
        sms._remember_sms_committed_roots(deps,{ROOT})
        return 'owning-result'
    monkeypatch.setattr(sms,'run_sms_task',drive)
    result=asyncio.run(bench.run_single_task('http://localhost:39999',task,
        on_agent_created=lambda name,aid:observed.append((name,aid))))
    assert result=='owning-result' and observed==[(task.name,ROOT)]
    assert vars(task)=={'name':'owning-sms','runner':'sms'}


@pytest.mark.parametrize('path',['success','cancel-verified','cancel-failed','success-foreign-receipt','cancel-verified-foreign-receipt'])
def test_actual_admitted_sms_wrapper_retires_only_verified_exact_roots(monkeypatch,path):
    import ast
    from benchmarks import outcome_publication
    tree=ast.parse(pathlib.Path(bench.__file__).read_text())
    wrapper=next(n for n in ast.walk(tree) if isinstance(n,ast.AsyncFunctionDef) and n.name=='_run_reported_task')
    admitted,agents,evaluated,signatures={}, {}, {}, {}
    # A repeated-name sibling already has custody in this registry.
    live={'same-task':[FOREIGN],'concurrent-non-sms':[CHILD]}
    task=SimpleNamespace(name='same-task',runner='sms')
    receipt={'verified':path!='cancel-failed','owned_agent_ids':[ROOT,FOREIGN] if path.endswith('foreign-receipt') else [ROOT],'root_agent_ids':[ROOT]}
    result=SimpleNamespace(name=task.name,agent_id='',stop_metadata={'runner':'sms','owned_cleanup_receipt':receipt})
    async def delegate(url,actual,*,on_agent_created,on_task_evaluated,**kwargs):
        assert actual is task and set(kwargs)=={'keep_failed_agents','other_task_roots'}
        assert kwargs['keep_failed_agents'] is False and kwargs['other_task_roots']()=={CHILD,FOREIGN}
        on_agent_created(task.name,ROOT)
        assert agents[asyncio.current_task()]==ROOT and live[task.name]==[FOREIGN,ROOT]
        assert kwargs['other_task_roots']()=={CHILD,FOREIGN}
        if path.startswith('cancel'):
            cancellation=asyncio.CancelledError('preserved cancellation')
            cancellation.owned_cleanup_receipt=receipt
            raise cancellation
        return result
    monkeypatch.setattr(outcome_publication,'wait_for_publication',AsyncMock())
    ns={'asyncio':asyncio,'BenchmarkTask':bench.BenchmarkTask,'TaskResult':bench.TaskResult,
        'base_url':'http://localhost:39999','run_single_task':delegate,
        '_reads_base_trajectory_history':bench._reads_base_trajectory_history,
        '_prepare_base_trajectory_history':bench._prepare_base_trajectory_history,'batch_started_at':None,
        'cloud_batch_cleanup':SimpleNamespace(contract=lambda:None),
        '_admitted_tasks':admitted,'_entered_task_futures':set(),'_task_root_custody':bench._task_root_custody,'_admitted_agent_ids':agents,'_evaluated_task_results':evaluated,
        '_outcome_signatures':signatures,'_live_task_agent_ids':live,
        '_remember_live_agent':lambda name,aid:live.setdefault(name,[]).append(aid),'_emit_report':lambda **kw:None}
    module=ast.fix_missing_locations(ast.Module(body=[wrapper],type_ignores=[]))
    exec(compile(module,'<actual candidate admitted wrapper>','exec'),ns)
    async def run():
        if path.startswith('cancel'):
            with pytest.raises(asyncio.CancelledError,match='preserved cancellation'):
                await ns['_run_reported_task'](task,keep_failed_agents=False)
        else:
            assert await ns['_run_reported_task'](task,keep_failed_agents=False) is result
    asyncio.run(run())
    assert live['concurrent-non-sms']==[CHILD]
    assert live['same-task']==([FOREIGN,ROOT] if path=='cancel-failed' else [FOREIGN])
    assert not admitted and not agents


@pytest.mark.parametrize("drain_failure", [None, "consumer-failure", "unknown-obligation"])
def test_sms_captured_pending_obligation_requires_canonical_drain_before_row_deletion(tmp_path, monkeypatch, drain_failure):
    from benchmarks import sms_runner as sms
    rows=[_row(queue=None)]; calls=[]; state={"status":WorkflowExecutionStatus.RUNNING}
    monkeypatch.setenv("BENCHMARK_CONTEXT_DIR",str(tmp_path))
    monkeypatch.setattr(bench.cloud_batch_cleanup,"contract",lambda:(tmp_path/"status","exact-token"))
    monkeypatch.setattr(bench,"_local_benchmark_task_queue",lambda _:QUEUE)
    monkeypatch.setattr(bench,"_run_local_victoria_sql",lambda _:json.dumps(rows))
    import config
    monkeypatch.setattr(config,"load_config",lambda:SimpleNamespace(temporal=SimpleNamespace(address="localhost:7233",namespace="default",api_key="")))
    async def describe(**kwargs):
        calls.append("native")
        return SimpleNamespace(task_queue=QUEUE, raw_info=SimpleNamespace(first_run_id=FIRST),status=state["status"],run_id=FIRST)
    def handle(*args,**kwargs):
        assert args==(ROOT,) and "run_id" not in kwargs
        return SimpleNamespace(describe=describe)
    monkeypatch.setattr(Client,"connect",AsyncMock(return_value=SimpleNamespace(get_workflow_handle=handle)))
    async def canonical(url, results, live):
        calls.append("delete")
        rows[0]["cleanup_pending"]=True
        state["status"]=WorkflowExecutionStatus.TERMINATED
        results[0].logs={"cloud_cleanup_evidence":{"final":{"tree_agent_ids":[ROOT]}}}
    monkeypatch.setattr(bench,"_finalize_owned_cloud_batch",canonical)
    async def drain(module,url,user,ids,roots,bindings,outcome,path):
        calls.append("drain")
        assert ids==roots=={ROOT} and bindings=={(ROOT,FIRST):ROOT}
        assert rows[0]["cleanup_pending"] is True
        if drain_failure:raise RuntimeError(drain_failure)
        rows[0].update(cleanup_pending=False, workflow_id=ROOT+":deployment-sealed:"+FOREIGN, first_run_id=None)
        return {"verified":True,"child_handles_retired":True,"agent_rows_after":rows}
    monkeypatch.setattr(sms,"_drain_owned_sms_obligations",drain,raising=False)
    run=lambda:asyncio.run(sms._cleanup_owned_sms_roots(bench,"http://localhost:39999",OWNER,{ROOT},set(),{"name":"fixture","passed":True,"failure_reason":None}))
    if drain_failure:
        with pytest.raises(RuntimeError):run()
        assert rows[0]["cleanup_pending"] is True
        assert not json.loads(next(tmp_path.glob("sms-owned-cleanup-*.json")).read_text())["verified"]
    else:
        result=run()
        assert result["verified"] and rows[0]["first_run_id"] is None
        assert calls==["native","delete","drain","native"]
        assert result["native_workflows"][0]["workflow_id"]==ROOT
        assert result["native_workflows"][0]["first_run_id"]==FIRST

@pytest.mark.parametrize('case',['consumed-budget','exhausted-before-launch','cancel-owned-child','ignored-term-repeated-cancel'])
def test_sms_terminal_drain_preserves_absolute_deadline_and_retires_cancelled_child(tmp_path,monkeypatch,case):
    from benchmarks import sms_runner as sms
    from benchmarks import local
    now=101.0 if case=='exhausted-before-launch' else 97.0
    monkeypatch.setattr(sms.time,'time',lambda:now)
    monkeypatch.setenv('BENCHMARK_CONTEXT_DIR',str(tmp_path))
    owner={'pid':os.getpid(),'native_identity':'exact-owning-birth','token':'exact-token'}
    (tmp_path/'local-stack-owner.json').write_text(json.dumps(owner))
    manifest={'status':'running','benchmark_mode':True,'worktree':str(sms.REPO_ROOT),'run_sh_pid':owner['pid'],
              'temporal_task_queue':QUEUE,'ports':{'backend':39999},'database':{'name':'victoria_sms_adapter_test'}}
    (tmp_path/'services.json').write_text(json.dumps(manifest))
    module=SimpleNamespace(_services_manifest_is_active=lambda _:True,_local_benchmark_task_queue=lambda _:QUEUE,
                           manifest_database_url=lambda _:'postgresql://postgres:postgres@localhost:5432/victoria_sms_adapter_test')
    observed={'created':0,'signals':[],'timeouts':[]};cancel=asyncio.CancelledError('original owning cancellation')
    receipt_path=tmp_path/'sms-terminal-obligations.json'
    class Child:
        pid=424242;returncode=None;waits=0
        async def wait(self):
            self.waits+=1
            if case in ('cancel-owned-child','ignored-term-repeated-cancel') and self.waits==1:raise cancel
            if case=='ignored-term-repeated-cancel':
                while self.returncode is None:await asyncio.sleep(0)
                return self.returncode
            self.returncode=0 if case=='consumed-budget' else -15
            return self.returncode
    child=Child()
    def identity(pid):assert pid in (owner['pid'],child.pid);return 'exact-owning-birth'
    def signal(args):
        assert args[:4]==['process-identity','--expect','exact-owning-birth','--signal'] and args[-1]==str(child.pid)
        assert args[4] in ('TERM','KILL')
        observed['signals'].append(args)
        if args[4]=='KILL':child.returncode=-9
        elif case!='ignored-term-repeated-cancel':child.returncode=-15
        return 0
    monkeypatch.setattr(local,'_process_identity_tools',lambda:{'current_identity':identity,'main':signal})
    async def create(*args,**kwargs):
        observed['created']+=1
        request=json.loads(pathlib.Path(args[-1]).read_text())
        assert request['deadline_at_ms']==100000
        assert kwargs['env']['DATABASE_URL']==kwargs['env']['DIRECT_URL']=='postgresql://postgres:postgres@localhost:5432/victoria_sms_adapter_test'
        receipt_path.write_text(json.dumps({'verified':True,'child_handles_retired':True,'agent_rows_after':[]}))
        return child
    monkeypatch.setattr(sms.asyncio,'create_subprocess_exec',create)
    timeout=asyncio.timeout
    def cap(seconds):observed['timeouts'].append(seconds);return timeout(seconds)
    monkeypatch.setattr(sms.asyncio,'timeout',cap)
    if case=='ignored-term-repeated-cancel':
        clock={'now':1000.0,'waits':[]}
        monkeypatch.setattr(sms.time,'monotonic',lambda:clock['now'])
        actual_wait=asyncio.wait
        async def wait(tasks,*,timeout):
            clock['waits'].append(timeout)
            if child.returncode is None:
                if len(clock['waits'])==1:
                    clock['now']+=7.0
                    raise asyncio.CancelledError('second owning cancellation')
                clock['now']+=timeout+0.001
                return set(),set(tasks)
            return await actual_wait(tasks,timeout=timeout)
        monkeypatch.setattr(sms.asyncio,'wait',wait)
    run=lambda:asyncio.run(sms._drain_owned_sms_obligations(module,'http://localhost:39999',OWNER,{ROOT},{ROOT},{(ROOT,FIRST):ROOT},
        {'name':'fixture','passed':True,'failure_reason':None,'deadline_at_ms':100000},receipt_path))
    if case=='exhausted-before-launch':
        with pytest.raises(RuntimeError,match='deadline expired'):run()
        assert observed['created']==0
    elif case in ('cancel-owned-child','ignored-term-repeated-cancel'):
        with pytest.raises(asyncio.CancelledError) as caught:run()
        assert caught.value is cancel
        if case=='ignored-term-repeated-cancel':
            assert child.returncode==-9 and [x[4] for x in observed['signals']]==['TERM','KILL']
            assert clock['waits']==[15.0,8.0,15.0]
        else:assert child.returncode==-15 and len(observed['signals'])==1
    else:
        assert run()['verified']
        assert observed['timeouts']==[3.0] and child.returncode==0 and observed['signals']==[]
