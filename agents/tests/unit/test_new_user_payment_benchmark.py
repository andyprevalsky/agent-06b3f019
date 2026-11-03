"""Fail-closed checks for the daily new-user subscription-to-payment journey."""

import copy
import uuid

import pytest


def test_new_user_payment_identity_is_fresh_for_each_isolated_run(monkeypatch):
    from benchmarks.run_benchmark import _new_user_payment_journey_user_id

    monkeypatch.setenv("BENCHMARK_RUN_ID", "daily-run-a")
    first = _new_user_payment_journey_user_id()
    assert str(uuid.UUID(first)) == first
    assert _new_user_payment_journey_user_id() == first

    monkeypatch.setenv("BENCHMARK_RUN_ID", "daily-run-b")
    assert _new_user_payment_journey_user_id() != first


def test_new_user_payment_gate_must_arrive_before_approval():
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _attention_request_matches_task

    task = get_task_by_name("agent-payment-new-user-journey")
    gate = {"metadata": {"gate": {"type": "subscription", "gateKey": "subscription", "severity": "blocking"}}}
    approval = {"metadata": {"attentionKind": "payment_approval"}}
    assert _attention_request_matches_task(task, gate, 0)
    assert not _attention_request_matches_task(task, approval, 0)
    assert _attention_request_matches_task(task, approval, 1)
    assert not _attention_request_matches_task(task, gate, 1)
    assert not _attention_request_matches_task(task, approval, 2)


def test_new_user_payment_static_contract_rejects_missing_checkout_and_transfer():
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import _run_declared_static_check

    task = get_task_by_name("agent-payment-new-user-journey")
    evaluator = {"checks": [
        {"type": "attention_kind_sequence", "value": task.expected_attention_kinds},
        {"type": "subscription_checkout_completed"},
        {"type": "expected_payment_lifecycle"},
    ]}
    state = {
        "expected_attention_kinds_seen": list(task.expected_attention_kinds),
        "subscription_checkout": {"status": "complete", "payment_status": "paid", "webhook_delivered": True},
        "payment_lifecycle": copy.deepcopy(task.expected_payment_lifecycle),
    }
    assert _run_declared_static_check(task, evaluator, {"_benchmark": state})[0]

    wrong_order = copy.deepcopy(state)
    wrong_order["expected_attention_kinds_seen"].reverse()
    assert "sequence mismatch" in _run_declared_static_check(task, evaluator, {"_benchmark": wrong_order})[1]

    unpaid = copy.deepcopy(state)
    unpaid["subscription_checkout"]["payment_status"] = "unpaid"
    assert "Paid Stripe Checkout" in _run_declared_static_check(task, evaluator, {"_benchmark": unpaid})[1]

    missing_transfer = copy.deepcopy(state)
    missing_transfer["payment_lifecycle"]["orgTransfer"]["transferredCents"] = 0
    assert "orgTransfer.transferredCents" in _run_declared_static_check(
        task, evaluator, {"_benchmark": missing_transfer}
    )[1]


def test_new_user_payment_checkout_rejects_non_test_destination():
    from benchmarks.subscription_checkout import _sandbox_session_id

    with pytest.raises(RuntimeError, match="Stripe Checkout URL"):
        _sandbox_session_id("https://example.com/c/pay/cs_test_abcd", "sk_test_example")
    with pytest.raises(RuntimeError, match="test-mode"):
        _sandbox_session_id("https://checkout.stripe.com/c/pay/cs_test_abcd", "sk_live_example")


@pytest.mark.parametrize("mode", ["missing", "hidden", "fill-error"])
@pytest.mark.asyncio
async def test_checkout_field_failure_reports_only_actual_probe_counts_and_exception_type(monkeypatch, mode):
    import json
    from types import SimpleNamespace
    from benchmarks import subscription_checkout as checkout

    clock = [0.0]
    sleeps, fills = [], []
    private_value = "fake-value-email@example.test"
    private_selector = 'input[data-private="fake-selector-secret"]'

    class Locator:
        @property
        def first(self):
            return self

        async def count(self):
            return int(mode != "missing")

        async def is_visible(self):
            return mode != "hidden"

        async def fill(self, value, *, timeout):
            fills.append((value, timeout))
            raise TimeoutError("fake-session/path?key=fake-secret " + value)

    async def sleep(seconds):
        sleeps.append(seconds)
        clock[0] += seconds

    page = SimpleNamespace(frames=[SimpleNamespace(
        locator=lambda selector: Locator(),
        url="https://fake-user:fake-password@checkout.stripe.com/private-session?key=fake-query",
    )])
    monkeypatch.setattr(checkout.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(checkout.asyncio, "sleep", sleep)
    prefix = "Stripe Checkout ZIP field was not available"
    with pytest.raises(RuntimeError, match="^" + prefix) as caught:
        await checkout._fill_checkout_field(page, (private_selector,), private_value, "ZIP")
    message = str(caught.value)
    assert message.startswith(prefix + "; selector_diagnostics="), "missing actual fill-attempt diagnostics"
    probes = json.loads(message.split("; selector_diagnostics=", 1)[1])
    assert probes == [{
        "probes": 60,
        "matched_probes": 0 if mode == "missing" else 60,
        "visible_probes": 60 if mode == "fill-error" else 0,
        "fill_attempts": 60 if mode == "fill-error" else 0,
        "last_exception_type": "TimeoutError" if mode == "fill-error" else None,
    }]
    assert clock[0] == 30 and sleeps == [0.5] * 60
    assert fills == ([(private_value, 5000)] * 60 if mode == "fill-error" else [])
    for private in (private_value, private_selector, "fake-secret", "fake-session", "fake-user",
                    "fake-password", "checkout.stripe.com", "private-session", "fake-query"):
        assert private not in message


@pytest.mark.asyncio
async def test_checkout_field_success_keeps_original_fill_and_does_not_emit_diagnostics(monkeypatch):
    from types import SimpleNamespace
    from benchmarks import subscription_checkout as checkout

    calls = []

    class Locator:
        @property
        def first(self):
            return self

        async def count(self):
            calls.append("count")
            return 1

        async def is_visible(self):
            calls.append("visible")
            return True

        async def fill(self, value, *, timeout):
            calls.append((value, timeout))

    def unexpected(*args, **kwargs):
        raise AssertionError("successful fill must not produce failure diagnostics or retry")

    monkeypatch.setattr(checkout.json, "dumps", unexpected)
    monkeypatch.setattr(checkout.asyncio, "sleep", unexpected)
    page = SimpleNamespace(frames=[SimpleNamespace(locator=lambda selector: Locator())])
    await checkout._fill_checkout_field(page, ('input[name="billingPostalCode"]',), "fake-ZIP", "ZIP")
    assert calls == ["count", "visible", ("fake-ZIP", 5000)]
