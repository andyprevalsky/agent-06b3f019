from benchmarks.benchmark_tasks import get_task_by_name


def test_no_anthropic_smoke_price_limit_is_route_aware(monkeypatch):
    task = get_task_by_name("spawn-sub-agents")

    monkeypatch.delenv("ROSE_EXCLUDE_ANTHROPIC_FAMILY", raising=False)
    assert task.effective_price_limit_cents() == 100

    monkeypatch.setenv("ROSE_EXCLUDE_ANTHROPIC_FAMILY", "1")
    assert task.effective_price_limit_cents() == 200
