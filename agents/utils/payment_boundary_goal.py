"""Shared payment-boundary benchmark goal markers and helpers."""

from __future__ import annotations

PAYMENT_BOUNDARY_GOAL_MARKER = (
    "Operational constraints for this payment-boundary benchmark:"
)

_PAYMENT_BOUNDARY_SUFFIX = (
    f"\n\n{PAYMENT_BOUNDARY_GOAL_MARKER} "
    "Use exactly one browser agent for the entire task. Do not spawn a second browser agent "
    "if the first fails — report the failure instead. Direct the browser to reach merchant "
    "checkout and request a one-time payment card via request_payment_card. Do not instruct "
    "the browser to submit payment, complete the purchase, or return a booking or order "
    "confirmation ID."
)


def payment_boundary_operational_suffix() -> str:
    """Harness-only goal suffix for success_on_payment_card_request benchmarks."""
    return _PAYMENT_BOUNDARY_SUFFIX


def goal_has_payment_boundary_operational_constraints(goal: str) -> bool:
    return PAYMENT_BOUNDARY_GOAL_MARKER in (goal or "")
