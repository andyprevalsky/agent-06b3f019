"""Deterministic grounded confirmation-id gate for agent-payment-test-shop."""

from __future__ import annotations

from benchmarks.run_benchmark import agent_payment_blob_has_grounded_confirmation_id


def test_accepts_tp_id_under_any_key() -> None:
    blob = '[{"purchased_products": ["Aurora Notebook"], "order_confirmation_id": "tp_2f824b8f"}]'
    assert agent_payment_blob_has_grounded_confirmation_id(blob)


def test_accepts_tp_id_under_order_id_alias() -> None:
    blob = '{"order_id": "tp_c9123127", "items": ["Ceramic Mug"]}'
    assert agent_payment_blob_has_grounded_confirmation_id(blob)


def test_rejects_missing_or_malformed_ids() -> None:
    assert not agent_payment_blob_has_grounded_confirmation_id("")
    assert not agent_payment_blob_has_grounded_confirmation_id('{"order_id": "ORDER-123"}')
    assert not agent_payment_blob_has_grounded_confirmation_id('{"order_id": "tp_2f824b8"}')  # 7 hex
    assert not agent_payment_blob_has_grounded_confirmation_id('{"order_id": "tp_2F824B8F"}')  # upper
    assert not agent_payment_blob_has_grounded_confirmation_id('{"order_id": "tp_2f824b8f0"}')  # 9 hex
