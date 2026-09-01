"""Unit tests for cooperative generation handoff helpers."""

from helpers.generation_handoff import parse_shutdown_grace_seconds, should_handoff_to_generation


def test_should_handoff_when_queues_differ():
    assert should_handoff_to_generation("navi-agent-tasks@aaa", "navi-agent-tasks@bbb") is True


def test_should_not_handoff_when_queues_match():
    assert should_handoff_to_generation("navi-agent-tasks@aaa", "navi-agent-tasks@aaa") is False


def test_should_not_handoff_when_either_queue_missing():
    assert should_handoff_to_generation(None, "navi-agent-tasks@bbb") is False
    assert should_handoff_to_generation("navi-agent-tasks@aaa", None) is False
    assert should_handoff_to_generation("", "navi-agent-tasks@bbb") is False
    assert should_handoff_to_generation("navi-agent-tasks@aaa", "  ") is False


def test_parse_shutdown_grace_seconds_supports_units():
    assert parse_shutdown_grace_seconds("35m") == 2100
    assert parse_shutdown_grace_seconds("2100s") == 2100
    assert parse_shutdown_grace_seconds("2100") == 2100
    assert parse_shutdown_grace_seconds("30s") == 30
    assert parse_shutdown_grace_seconds(None) == 2100
    assert parse_shutdown_grace_seconds("nope") == 2100
