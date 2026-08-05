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
