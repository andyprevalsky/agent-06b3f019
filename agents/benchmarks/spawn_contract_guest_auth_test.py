"""Tests for guest-checkout saved-auth kill-switch propagation."""

from __future__ import annotations

from benchmarks.spawn_contract import (
    should_disable_saved_browser_auth,
    tasks_require_disabled_saved_browser_auth,
)
from benchmarks.benchmark_tasks import get_task_by_name


def test_blue_bottle_requires_disabled_saved_browser_auth():
    task = get_task_by_name("browser-blue-bottle-challenge-recovery")
    assert should_disable_saved_browser_auth(task) is True
    assert tasks_require_disabled_saved_browser_auth(["browser-blue-bottle-challenge-recovery"]) is True
    assert tasks_require_disabled_saved_browser_auth(
        ["browser-blue-bottle-challenge-recovery"] * 5
    ) is True


def test_non_guest_task_does_not_require_disabled_saved_browser_auth():
    assert tasks_require_disabled_saved_browser_auth(["whatsapp-history-recall"]) is False
    assert tasks_require_disabled_saved_browser_auth([]) is False
    assert tasks_require_disabled_saved_browser_auth(["not-a-real-task"]) is False


def test_doordash_grocery_cart_reauth_requires_disabled_saved_browser_auth():
    """Cart-reauth sibling uses the existing guest kill-switch (no new harness wire)."""
    task = get_task_by_name("browser-doordash-food-plan-grocery-cart-reauth")
    assert should_disable_saved_browser_auth(task) is True
    assert tasks_require_disabled_saved_browser_auth([task.name]) is True
    # Full-order sibling keeps cookie sync on.
    assert should_disable_saved_browser_auth(
        get_task_by_name("browser-doordash-food-plan-grocery-order")
    ) is False

