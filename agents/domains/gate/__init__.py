"""Gate domain — organic gate raising (LLM/code-driven, not injected).

A gate is raised from a real block site via `raise_gate_direct`, which reuses the
approval pause/resume machinery. The backend owns the gate object, dedup, fan-in
resume, minimal-SMS, and the in-stream card.
"""

from .repo import (
    create_gate_request_activity,
    has_message_corpus_activity,
    mint_gmail_connect_activity,
    mint_subscription_checkout_activity,
    source_status_activity,
)
from .handler import (
    build_kyc_gate,
    build_source_connect_gate,
    build_subscription_gate,
    raise_gate_direct,
)
from .types import GateRejectedError

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
