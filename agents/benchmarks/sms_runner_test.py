"""Contract tests for the SMS-supervisor benchmark runner.

The scoring surface is what stops this benchmark from silently passing a run
that spammed the user, so it is pinned here without needing a live stack.
"""

import json
import pathlib

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
        "Order me a lum lok Togo from the ferry building asap"
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

    live = {"pre-existing-1", "spawned-by-supervisor", "seeded-1"}
    executed = []

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
    _cleanup(deps, "u1", ["seeded-1"], {"pre-existing-1"})

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
    for conditional in ["closed monday", "tue-sun", "check back during business hours", "opens at"]:
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
        return SimpleNamespace(name="t", sms_script={"turns": [{"inbound": "hi"}], "seed_documents": documents})

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

    _cleanup(deps, "u1", [], set(), ids)
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
    _cleanup(deps, "u1", [], set(), [], ids)
    assert any(f"DELETE FROM \"AgentAttentionRequest\" WHERE id = '{ATTN_ID}'" in q for q in executed)


def test_seed_shapes_are_validated():
    from types import SimpleNamespace

    def script(**extra):
        return SimpleNamespace(name="t", sms_script={"turns": [{"inbound": "hi"}], **extra})

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
