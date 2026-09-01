"""Unit tests for tree-aware semantic evaluator evidence."""

from __future__ import annotations

import json
from pathlib import Path

from benchmarks.semantic_evaluator_evidence import (
    SINGLE_TURN_CHAR_BUDGET,
    build_agentic_evidence,
    build_single_turn_evidence,
    single_turn_evidence_char_count,
    single_turn_evidence_exceeds_budget,
)


def _load_tree_proof_fixture() -> dict:
    fixture_path = Path(__file__).resolve().parent / "fixtures/blue_bottle_k5/trial_tree_proof.json"
    return json.loads(fixture_path.read_text())


def test_root_only_evidence_misses_subagent_payment_metadata():
    fixture = _load_tree_proof_fixture()
    data = {
        "agent": {"agent_id": fixture["agent_id"], "status": fixture["status"]},
        "messages": fixture["messages"],
        "_benchmark": fixture["benchmark_state"],
    }
    evidence = build_single_turn_evidence(data)
    payment_rows = [
        item
        for item in evidence
        if item.get("metadata", {}).get("action_type") == "request_payment_card"
    ]
    assert payment_rows == []


def test_tree_evidence_includes_subagent_payment_metadata():
    fixture = _load_tree_proof_fixture()
    data = {
        "agent": {"agent_id": fixture["agent_id"], "status": fixture["status"]},
        "messages": fixture["messages"],
        "_benchmark": fixture["benchmark_state"],
        "_semantic_evaluator_tree": fixture["tree"],
    }
    evidence = build_single_turn_evidence(data)
    payment_rows = [
        item
        for item in evidence
        if item.get("metadata", {}).get("action_type") == "request_payment_card"
    ]
    assert len(payment_rows) == 1
    assert payment_rows[0]["metadata"]["source_agent_id"] == "browser-sub-001"
    approval = payment_rows[0]["metadata"]["requestUserApproval"]["requestPaymentCard"]
    assert approval["pickupLocation"] == "Blue Bottle Coffee Ferry Building"
    assert approval["pickupTime"] == "Today, 4:15 PM"
    guest_rows = [
        item for item in evidence if item.get("metadata", {}).get("action_type") == "guest_checkout"
    ]
    assert len(guest_rows) == 1


def test_agentic_evidence_lists_tree_agents():
    fixture = _load_tree_proof_fixture()
    data = {
        "agent": {"agent_id": fixture["agent_id"], "status": fixture["status"]},
        "messages": fixture["messages"],
        "_benchmark": fixture["benchmark_state"],
        "_semantic_evaluator_tree": fixture["tree"],
    }
    bundle = build_agentic_evidence(data)
    assert len(bundle["tree_agents"]) == 2
    assert bundle["tree_agents"][0]["agent_id"] == fixture["agent_id"]


def test_single_turn_budget_routes_to_agentic_when_exceeded():
    oversized = [{"text": "x" * (SINGLE_TURN_CHAR_BUDGET + 1)}]
    assert single_turn_evidence_exceeds_budget(oversized) is True
    assert single_turn_evidence_exceeds_budget([{"text": "small"}]) is False
    assert single_turn_evidence_char_count([{"text": "abc"}]) == len(json.dumps([{"text": "abc"}]))
