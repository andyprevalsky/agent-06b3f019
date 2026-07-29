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
    build_judge_scenario,
    build_judge_transcript,
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
    assert "Open now" in open_world and "TEMPORARILY CLOSED" in closed_world
    # Prod shape: "**Title**\n<excerpts>" blocks joined by blank lines
    # (chatTools.ts:formatSearchResults). A single curated sentence would be an
    # easier input than the model ever gets in production.
    for world in (open_world, closed_world):
        assert world.startswith("**") and "**\n" in world and "\n\n**" in world
        # Adjacent-vendor noise the model has to read past, as in the real run.
        assert "Se\u00f1or Sisig" in world


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
    source = pathlib.Path("benchmarks/run_benchmark.py").read_text()
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
    """The cloud fleet launches run.sh directly and never touches local.py.

    If only local.py exported BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE, an SMS task
    on the cloud box would find it unset. The fail-closed guard would then abort
    the run rather than silently score live search — correct, but the benchmark
    could never run in the fleet. Export it from run.sh so both paths agree.
    """
    run_sh = (REPO_ROOT_FOR_TEST / "scripts" / "run.sh").read_text()
    assert "BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE" in run_sh
    # Same benchmark-only block that fakes Surge, so the two never diverge.
    fixture_at = run_sh.index("BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE")
    surge_at = run_sh.index("BLACKBOX_TEST_FAKE_SURGE")
    assert abs(fixture_at - surge_at) < 1200
