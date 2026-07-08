"""Backward-compatible exports for gate helpers."""

from domains.gate.repo import (
    create_gate_request_activity,
    has_message_corpus_activity,
    mint_gmail_connect_activity,
    mint_subscription_checkout_activity,
)
from domains.gate.service import (
    GateRejectedError,
    build_source_connect_gate,
    build_subscription_gate,
    raise_gate_direct,
)

__all__ = [
    "create_gate_request_activity",
    "has_message_corpus_activity",
    "mint_subscription_checkout_activity",
    "mint_gmail_connect_activity",
    "raise_gate_direct",
    "build_subscription_gate",
    "build_source_connect_gate",
    "GateRejectedError",
]
