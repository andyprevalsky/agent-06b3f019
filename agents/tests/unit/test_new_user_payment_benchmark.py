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
