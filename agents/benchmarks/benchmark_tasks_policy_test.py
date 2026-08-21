from benchmarks.benchmark_tasks import get_task_by_name


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
