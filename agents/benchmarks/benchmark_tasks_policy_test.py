from benchmarks.benchmark_tasks import get_smoke_cap, get_task_by_name
from benchmarks.run_benchmark import _benchmark_goal_for_task


def test_background_agent_message_smoke_is_fast_and_proves_consumption():
    task = get_task_by_name("background-agent-message-smoke")

    assert "smoke" in task.tags
    assert task.group == "pre-deploy"
    assert task.deploy_category == "harness"
    assert task.timeout_seconds == 180
    assert get_smoke_cap(task.name) == 180
    assert task.mid_run_feedback["when"] == {"background_task_active": "explore"}

    checks = [
        check
        for evaluator in task.evaluators
        if evaluator["method"] == "static_check"
        for check in evaluator["checks"]
    ]
    routed = next(check for check in checks if check["type"] == "background_task_message_routed")
    assert routed["agent_type"] == "explore"
    assert routed["min_task_rows_after_message"] == 1
    assert routed["allow_resume_after_completion"] is True
    output = next(check for check in checks if check["type"] == "structured_output_signature")
    assert output["field"] == "documents"
    assert output["required"] == "Forwarded marker: HTTP core document"
    assert output["min_items"] == 2


def test_browser_event_ticket_counts_spawn_browser_agent_not_spawn_agent():
    """AMC ticket runtime contract uses one browser session via spawn_browser_agent.

    expected_tool_counts previously required spawn_agent:1 while the root agent
    correctly calls spawn_browser_agent (same as browser-imax-group-tickets).
    That mismatched the authoritative browser_agent_session_count evaluator and
    failed a green AMC payment-approval run (descend H-02, 2026-08-22).
    """
    task = get_task_by_name("browser-event-ticket")
    assert task.expected_tool_counts == {"spawn_browser_agent": 1}
    assert task.tool_count_scope == "root"

    # Owning-boundary shape from the post-H-01 local outcome run:
    # payment reached AMC Theatres; only the spawn_agent count check failed.
    actual = {"agent_init": 1, "spawn_browser_agent": 1, "request_payment_card": 1}
    for tool_name, expected_count in task.expected_tool_counts.items():
        assert actual.get(tool_name, 0) == expected_count, (
            f"{tool_name}: expected {expected_count}, got {actual.get(tool_name, 0)}; "
            f"full={actual}"
        )

    sibling = get_task_by_name("browser-imax-group-tickets")
    assert sibling.expected_tool_counts.get("spawn_browser_agent") == 1


def test_browser_hotel_booking_prompt_requires_single_browser_agent():
    """Hotel bench must name one browser session in the catalog prompt (H-02 pattern)."""
    task = get_task_by_name("browser-hotel-booking")
    assert task.prompt.startswith("Use exactly one browser agent")


def test_oai_demo_requires_readable_files_and_forbids_browser_calls():
    task = get_task_by_name("test-mass-agent-run-0")
    assert "spawn_browser_agent" in task.forbidden_tools

    evaluator = next(item for item in task.evaluators if item["id"] == "t7-readable-report-files")
    checks = evaluator["checks"]
    assert {
        (tuple(check.get("extensions", [])), tuple(check.get("mime_contains", [])), check.get("min_files"))
        for check in checks
    } == {
        ((".html", ".htm"), ("html",), 3),
        ((".csv",), ("csv",), 2),
    }
    goal = _benchmark_goal_for_task(task, "http://localhost:3201")
    assert goal == task.prompt


def test_google_oauth_demo_uses_cached_fixture_without_subagents_or_google_io():
    from benchmarks.long_horizon import (
        RUNTIME_STATIC_CHECK_TYPES,
        load_raw_catalog,
        validate_task_contract,
    )
    from providers.fast_cache.google_oauth_demo_fixture import (
        matches_demo_goal,
        run_fixture,
    )
    from providers.fast_cache.normalize import (
        demo_cache_allowed,
        goal_hash,
        google_oauth_demo_goal_hash,
    )
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS, PLAN_PHASE_TOOLS

    task = get_task_by_name("google-oauth")
    assert task.title == "Google OAuth"
    assert task.tags == ["DEMO"]
    assert task.production_only is False
    assert task.fast_cache == "on"
    demo_evaluator = next(item for item in task.evaluators if item["id"] == "google-demo-tool-sequence")
    assert demo_evaluator["method"] == "static_check"
    assert [check["type"] for check in demo_evaluator["checks"]] == [
        "google_oauth_demo_trace", "fully_cached_agent"
    ]
    assert {check["type"] for check in demo_evaluator["checks"]} <= RUNTIME_STATIC_CHECK_TYPES
    raw_task = next(raw for raw in load_raw_catalog() if raw["name"] == "google-oauth")
    validate_task_contract(raw_task)
    assert task.requires_browser_agent is False
    assert task.requires_claude_code is False
    assert task.expected_tool_counts == {"google_workspace_run": 1}
    assert "google_workspace_run" not in EXECUTE_PHASE_TOOLS
    assert "google_workspace_run" not in PLAN_PHASE_TOOLS
    assert "spawn_agent" in task.forbidden_tools
    assert "spawn_browser_agent" in task.forbidden_tools
    assert "spawn_claude_code_agent" in task.forbidden_tools
    assert task.environment["mode"] == "synthetic"
    assert task.environment["db_fixtures"] == []
    assert task.environment["live_targets"] == []
    assert "another agent" in task.prompt
    assert all(f"{number}. " in task.prompt for number in range(1, 9))
    assert "Open Drive" in task.prompt
    assert "DEMO" not in task.prompt.upper()
    assert {field["name"] for field in task.response_schema["fields"]} >= {
        "unread_email_summary", "final_disconnected"
    }
    goal = _benchmark_goal_for_task(task, "https://navi-j9a9.onrender.com")
    assert goal == task.prompt
    assert google_oauth_demo_goal_hash() == goal_hash(goal)
    assert demo_cache_allowed(goal)
    assert matches_demo_goal(goal)
    rows = run_fixture()["rows"]
    assert len(rows) == 12
    assert rows[1]["result"]["summary"] == "Sam asks whether Thursday works; Acme sent a newsletter."
    assert rows[7]["result"]["event"]["date"] == "2026-10-02"
    assert rows[-1]["result"]["connected"] is False


def test_google_oauth_demo_cache_is_available_without_catalog_in_worker_image():
    from unittest.mock import patch

    from providers.fast_cache.google_oauth_demo_fixture import matches_demo_goal
    from providers.fast_cache.normalize import demo_cache_goal_hashes, google_oauth_demo_goal_hash

    goal = get_task_by_name("google-oauth").prompt
    demo_cache_goal_hashes.cache_clear()
    try:
        with patch("providers.fast_cache.normalize.Path.open", side_effect=FileNotFoundError):
            assert google_oauth_demo_goal_hash() in demo_cache_goal_hashes()
            assert matches_demo_goal(goal)
    finally:
        demo_cache_goal_hashes.cache_clear()


def test_google_oauth_root_tool_emits_twelve_cards_without_external_activity():
    import asyncio

    from tools.google_oauth_demo import google_oauth_demo

    class WorkflowStub:
        goal = get_task_by_name("google-oauth").prompt

        def __init__(self):
            self.events = []

        async def _handle_tool_event(self, event, tool_call_id, tool_name):
            self.events.append((event, tool_call_id, tool_name))

    workflow = WorkflowStub()
    result = asyncio.run(google_oauth_demo(workflow, {"tool": "google_workspace_run"}, "tc-workspace"))
    assert len(result["result"]["rows"]) == 12
    cards = [(event, call_id, tool_name) for event, call_id, tool_name in workflow.events if (event.metadata or {}).get("fixtureRow")]
    progress = [event for event, _, _ in workflow.events if (event.metadata or {}).get("fixtureProgress")]
    assert len(cards) == 12 and len(progress) == 5
    assert all(event.metadata["isUserAttentionMessage"] is True for event in progress)
    assert all(event.metadata["attentionMessage"] == event.message for event in progress)
    assert all(event.metadata["sendMessageToUser"]["attentionKind"] == "info" for event in progress)
    assert all(event.metadata["sendMessageToUser"]["isWaitingForUser"] is False for event in progress)
    assert [tool_name for _, _, tool_name in cards] == [
        row["tool"] for row in result["result"]["rows"]
    ]
    assert all("demo" not in f"{event.title} {event.message} {tool_name}".lower() for event, _, tool_name in workflow.events)
    assert workflow.events[0][1] == "tc-workspace"
    assert workflow.events[-1][1] == "tc-workspace"

    other = WorkflowStub()
    other.goal = "unrelated task"
    try:
        asyncio.run(google_oauth_demo(other, {"tool": "google_workspace_run"}, "tc-other"))
    except ValueError as exc:
        assert "exact benchmark goal" in str(exc)
    else:
        raise AssertionError("non-demo goal unexpectedly ran the fixture")
    assert other.events == []


def test_agentcard_idempotency_task_terminates_after_reporting_results():
    """The root must grade its result instead of looping on progress messages."""
    task = get_task_by_name("agent-payment-idempotent-abandonment")
    assert "call attempt_completion exactly once" in task.prompt
    assert "send_message_to_user_execute_phase" in task.forbidden_tools
    assert task.timeout_seconds == 900


def test_browser_event_ticket_omits_standard_format_from_prompt_and_judge():
    """H-03 edit: do not require standard-format / reject LASER-at-AMC labels.

    Andy: remove standard-format from task.prompt and movie-ticket-seat-selection-
    semantics so projection-format labels are not a pass/fail axis.
    """
    import json
    from pathlib import Path

    tasks = json.loads(Path(__file__).resolve().parent.joinpath("tasks.json").read_text())
    task = next(t for t in tasks if t["name"] == "browser-event-ticket")
    prompt = task["prompt"]
    assert "standard-format" not in prompt
    assert "standard format" not in prompt.lower()

    semantics = next(
        e for e in task["evaluators"] if e["id"] == "movie-ticket-seat-selection-semantics"
    )
    criteria_blob = " ".join(semantics["criteria"])
    assert "standard-format" not in criteria_blob
    assert "standard format" not in criteria_blob.lower()
    assert "specific projection format" in semantics["judge_prompt"]


def test_browser_event_ticket_omits_genre_earliest_and_seat_center():
    """H-04 edit: drop genre, earliest-show, and seat-map center proof.

    Andy: remove non-horror / earliest / horizontal-vertical-center from
    prompt + movie-ticket-seat-selection-semantics. Keep venue, Friday,
    7–9pm window, price cap, no-add-ons, unresolved AMC payment.
    """
    import json
    from pathlib import Path

    tasks = json.loads(Path(__file__).resolve().parent.joinpath("tasks.json").read_text())
    task = next(t for t in tasks if t["name"] == "browser-event-ticket")
    prompt = task["prompt"].lower()
    notes = task["environment"]["context_notes"].lower()
    for forbidden in (
        "non-horror",
        "horror",
        "earliest",
        "horizontal and vertical center",
        "genre exclusion",
        "seating heuristic",
    ):
        assert forbidden not in prompt, f"prompt still has {forbidden!r}"
        assert forbidden not in notes, f"context_notes still has {forbidden!r}"

    semantics = next(
        e for e in task["evaluators"] if e["id"] == "movie-ticket-seat-selection-semantics"
    )
    criteria_blob = " ".join(semantics["criteria"]).lower()
    judge = semantics["judge_prompt"].lower()
    for forbidden in ("non-horror", "horror", "earliest", "horizontal and vertical center"):
        assert forbidden not in criteria_blob, f"criteria still has {forbidden!r}"
    assert "genre/non-horror" in judge or "genre" in judge
    assert "earliest-showtime" in judge or "earliest" in judge
    assert "seat-map center" in judge
    assert "7:00 pm" in prompt and "9:00 pm" in prompt
    assert "under $30" in prompt


def test_browser_event_ticket_accepts_url_grounded_metreon_venue():
    """H-05/H-06: soft Metreon venue; do not require Metreon in approval or hard URL proof.

    Andy: relax semantic rubric so AMC Theatres / amctheatres.com consistent with
    the Metreon goal passes; do not force theatre URL / page chrome.
    """
    import json
    from pathlib import Path

    tasks = json.loads(Path(__file__).resolve().parent.joinpath("tasks.json").read_text())
    task = next(t for t in tasks if t["name"] == "browser-event-ticket")
    assert "AMC Metreon 16" in task["prompt"]

    semantics = next(
        e for e in task["evaluators"] if e["id"] == "movie-ticket-seat-selection-semantics"
    )
    criteria_blob = " ".join(semantics["criteria"])
    judge = semantics["judge_prompt"]
    assert "Do not force hard Metreon theatre proof" in judge
    assert "without the Metreon substring" in judge or "without Metreon" in judge
    assert "grounded by theatre URL" not in criteria_blob
    assert "approval identifies the movie, venue, date" not in criteria_blob
    assert "one adult at AMC Metreon 16 this Friday" not in criteria_blob


def test_browser_event_ticket_uses_next_week_friday():
    """Andy edit: prompt + semantics use next week's Friday (not this Friday)."""
    import json
    from pathlib import Path

    tasks = json.loads(Path(__file__).resolve().parent.joinpath("tasks.json").read_text())
    task = next(t for t in tasks if t["name"] == "browser-event-ticket")
    assert "next week's Friday" in task["prompt"]
    assert "this Friday" not in task["prompt"]

    semantics = next(
        e for e in task["evaluators"] if e["id"] == "movie-ticket-seat-selection-semantics"
    )
    criteria_blob = " ".join(semantics["criteria"]).lower()
    judge = semantics["judge_prompt"].lower()
    assert "next week's friday" in criteria_blob
    assert "this friday" not in criteria_blob
    assert "next week's friday" in judge


def test_no_anthropic_smoke_price_limit_is_route_aware(monkeypatch):
    task = get_task_by_name("spawn-sub-agents")

    monkeypatch.delenv("ROSE_EXCLUDE_ANTHROPIC_FAMILY", raising=False)
    assert task.effective_price_limit_cents() == 100

    monkeypatch.setenv("ROSE_EXCLUDE_ANTHROPIC_FAMILY", "1")
    assert task.effective_price_limit_cents() == 200


def test_production_agentcard_lifecycle_matches_non_admin_stripe_hold_contract():
    """Prod Step 13c must use the non-admin payer so a live Stripe hold exists.

    Admin/company_flow never creates a payment intent; after 085e998cd the harness
    runs this task as BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID and abandon must
    leave a succeeded hold + refund footprint (same shape as sandbox abandonment).
    """
    task = get_task_by_name("agent-payment-production-abandonment")
    lifecycle = task.expected_payment_lifecycle

    assert lifecycle["integrity"]["stripePaymentIntentCount"] == 1
    assert lifecycle["integrity"]["stripeProviderPaymentIntentCount"] == 1
    assert lifecycle["stripeHold"]["status"] == "succeeded"
    assert lifecycle["stripeHold"]["amountCents"] == 100
    assert lifecycle["stripeRefund"]["status"] == "succeeded"
    assert lifecycle["stripeRefund"]["amountCents"] == 100
    assert lifecycle["orgTransfer"]["livemode"] is True
    assert lifecycle["orgTransfer"]["status"] == "reclaimed"


def test_wait_for_trigger_ignores_phone_call_write_lock_without_completing():
    """wait-for-trigger passes on wait_for + unresolved phone write_lock.

    Do not auto-approve: approving would place a real outbound call. Mirror
    Amazon-style ignore benches — observe write_lock, leave it open, and do not
    require agent COMPLETED (the agent stalls waiting for approval by design).
    """
    from benchmarks.run_benchmark import evaluate_task

    task = get_task_by_name("wait-for-trigger")
    assert task.approval_handling == "ignore"
    assert task.expected_attention_kind == "write_lock"
    assert task.expected_approval_count == 1
    assert "wait_for" in (task.expected_tools or [])

    # ACTIVE + write_lock observed → pass (no COMPLETED, no auto-approve).
    data = {
        "agent": {"status": "ACTIVE", "progress": 0.5},
        "messages": [
            {"role": "USER", "message": task.prompt},
            {
                "role": "TOOL",
                "message": "Condition met",
                "metadata": {"toolName": "wait_for", "toolStatus": "success"},
            },
        ],
        "_benchmark": {
            "expected_attention_kind_seen": "write_lock",
            "attention_request_kind_seen": "write_lock",
            "approvals_triggered": 1,
        },
    }
    passed, reason = evaluate_task(task, data, approvals_triggered=1)
    assert passed is True, reason
    assert reason is None

    # No write_lock → fail even if wait_for ran.
    data_no_lock = {
        "agent": {"status": "ACTIVE", "progress": 0.5},
        "messages": data["messages"],
        "_benchmark": {},
    }
    passed, reason = evaluate_task(task, data_no_lock, approvals_triggered=0)
    assert passed is False
    assert reason and "write_lock" in reason


def test_raise_5m_brex_long_horizon_runs_simulated_on_tamy_account_snapshot():
    """Long-horizon fundraise bench: sim ON, Tamy account snapshot, current cap, Brex $5M judge.

    The prompt is the user-approved guided fundraise ask with the pre-seed materials
    attached; hold the benchmark at the user-approved 10-minute block.
    """
    from pathlib import Path

    from benchmarks.live_fixtures import TAMY_IDENTITY_USER_ID
    from benchmarks.local import resolve_simulate_mode
    from benchmarks.run_benchmark import EXCLUSIVE_SHARED_DB_TASK_NAMES, _live_fixture_run_user_id

    task = get_task_by_name("raise-5m-rose-labs-brex")
    assert task.prompt.startswith("Raise $5M for my company Rose Labs. No questions asked")
    assert "rose_labs_primary_usd" in task.prompt
    materials = [
        "rose-labs-preseed/pitch-deck.md",
        "rose-labs-preseed/one-pager.md",
        "rose-labs-preseed/metrics-fact-sheet.md",
        "rose-labs-preseed/data-room-index.md",
        "rose-labs-preseed/safe-terms.md",
    ]
    # The catalog lists the materials under "attachment"; the runner uploads
    # them through attachments (a list joined as one path failed on the cloud).
    assert task.attachments == materials and task.attachment is None
    test_assets = Path(__file__).resolve().parents[2] / "front-end/public/test-assets"
    assert all((test_assets / name).is_file() for name in materials)
    assert task.tags == ["DEMO", "long-horizon"]
    assert task.timeout_seconds == 600
    assert task.world_model_mode == "simulate"
    assert task.fast_cache == "on"
    assert task.world_surface == "simulated"
    assert task.approval_handling == "auto_approve"
    assert task.start_phase == "plan"
    assert task.bench == "rose-bench"
    assert task.status == "ready"
    # Simulated browser needs no public tunnel; the local stack must not open one.
    assert task.requires_browser_agent is False

    env = task.environment
    assert env["mode"] == "hybrid"
    assert env["live_fixtures"] == ["live-tamy-account-snapshot"]
    assert env["db_fixtures"] == []
    assert "world_model_initial_state" not in env
    # The account snapshot selects Tamy as the run user and must not overlap siblings
    # (it retargets BENCHMARK_RUN_USER_ID process-wide).
    assert _live_fixture_run_user_id(task) == TAMY_IDENTITY_USER_ID
    assert task.name in EXCLUSIVE_SHARED_DB_TASK_NAMES

    schema_fields = {field["name"]: field for field in task.response_schema["fields"]}
    assert set(schema_fields) == {
        "total_raised_usd",
        "investor_commitments",
        "brex_balance_usd",
        "brex_incoming_funds",
    }
    assert all(field["required"] is True for field in schema_fields.values())
    assert "at least 5000000" in schema_fields["brex_balance_usd"]["description"]
    assert "written commitments alone do not satisfy" in schema_fields["brex_incoming_funds"]["description"]

    assert task.enforce_declared_evaluators is True
    by_id = {evaluator["id"]: evaluator for evaluator in task.evaluators}
    assert by_id["raise-5m-root-completes"]["checks"] == [{"type": "agent_status", "value": "COMPLETED"}]
    judge = by_id["brex-shows-5m-raised"]
    assert judge["method"] == "single_turn_llm_judge"
    blob = " ".join(judge["criteria"]) + " " + judge["judge_prompt"]
    assert "Brex" in blob
    assert "5,000,000" in blob

    # The no-questions instruction does not weaken the harness approval gate.
    from benchmarks.run_benchmark import evaluate_task

    passed, reason = evaluate_task(
        task,
        {
            "agent": {"status": "COMPLETED", "progress": 1.0},
            "messages": [{"role": "USER", "message": task.prompt}],
            "_benchmark": {},
        },
        approvals_triggered=0,
    )
    assert passed is False
    assert reason == "Expected approval requests but none were triggered"

    # The catalog declaration alone must switch the local runner into simulate.
    assert resolve_simulate_mode(False, ["raise-5m-rose-labs-brex"]) is True
