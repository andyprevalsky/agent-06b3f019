from benchmarks.benchmark_tasks import get_task_by_name


def test_no_anthropic_smoke_price_limit_is_route_aware(monkeypatch):
    task = get_task_by_name("spawn-sub-agents")

    monkeypatch.delenv("ROSE_EXCLUDE_ANTHROPIC_FAMILY", raising=False)
    assert task.effective_price_limit_cents() == 100

    monkeypatch.setenv("ROSE_EXCLUDE_ANTHROPIC_FAMILY", "1")
    assert task.effective_price_limit_cents() == 200


def test_production_agentcard_lifecycle_matches_admin_no_charge_contract():
    task = get_task_by_name("agent-payment-production-abandonment")
    lifecycle = task.expected_payment_lifecycle

    assert lifecycle["integrity"]["stripePaymentIntentCount"] == 0
    assert lifecycle["integrity"]["stripeProviderPaymentIntentCount"] == 0
    assert lifecycle["stripeHold"] is None
    assert lifecycle["stripeRefund"] is None
