"""Unit contract for generation-scoped production queue resolution.

Guards the invariant that makes zero-downtime kill-and-respawn correct: a worker
polls `<base>@<surfaceHash>`, never a plain shared queue that could hand it a
foreign generation's history — while staying backward-compatible (plain queue
when no surface hash is supplied).
"""

import pytest

from helpers.worker_generation import (
    generation_of_queue,
    resolve_production_task_queue,
)


def test_surface_hash_yields_generation_queue():
    assert (
        resolve_production_task_queue("navi-agent-tasks", "abc123")
        == "navi-agent-tasks@abc123"
    )


def test_absent_surface_hash_is_backward_compatible_plain_queue():
    assert resolve_production_task_queue("navi-agent-tasks", None) == "navi-agent-tasks"
    assert resolve_production_task_queue("navi-agent-tasks", "") == "navi-agent-tasks"
    assert resolve_production_task_queue("navi-agent-tasks", "   ") == "navi-agent-tasks"


def test_surface_hash_is_trimmed():
    assert (
        resolve_production_task_queue("navi-agent-tasks", "  abc123  ")
        == "navi-agent-tasks@abc123"
    )


def test_separator_in_hash_is_rejected():
    # A hash containing the separator would create an ambiguous queue name and
    # break generation parsing — fail loud rather than mis-route.
    with pytest.raises(ValueError):
        resolve_production_task_queue("navi-agent-tasks", "abc@def")


def test_empty_base_queue_is_rejected():
    with pytest.raises(ValueError):
        resolve_production_task_queue("", "abc123")


def test_generation_of_queue_inverts_resolution():
    assert generation_of_queue("navi-agent-tasks@abc123") == "abc123"
    assert generation_of_queue("navi-agent-tasks") is None
    assert generation_of_queue("navi-agent-tasks@") is None


@pytest.mark.parametrize("base,gen", [("navi-agent-tasks", "deadbeef0001"), ("q", "x")])
def test_round_trip(base, gen):
    queue = resolve_production_task_queue(base, gen)
    assert generation_of_queue(queue) == gen
