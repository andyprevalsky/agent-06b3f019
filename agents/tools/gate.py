"""Backward-compatible exports for gate helpers."""

from domains.gate.handler import (
    GateRejectedError,
    build_kyc_gate,
    build_source_connect_gate,
    build_subscription_gate,
    raise_gate_direct,
)
from domains.gate.repo import (
    create_gate_request_activity,
    has_message_corpus_activity,
    mint_gmail_connect_activity,
    mint_subscription_checkout_activity,
    source_status_activity,
)

__all__ = [
    "create_gate_request_activity",
    "has_message_corpus_activity",
    "source_status_activity",
    "mint_subscription_checkout_activity",
    "mint_gmail_connect_activity",
    "raise_gate_direct",
    "build_subscription_gate",
    "build_kyc_gate",
    "build_source_connect_gate",
    "GateRejectedError",
]
