from benchmarks.benchmark_tasks import get_task_by_name
from benchmarks.run_benchmark import _benchmark_goal_for_task


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
