"""Gate domain constants and defaults."""

from utils.attention_requests import REJECTION_SENTINEL

TOOL_NAME = "gate"
DEFAULT_SUBSCRIBE_URL = "https://roselabs.ai/subscribe"
DEFAULT_KYC_URL = "https://roselabs.ai/kyc/start"

# Purchase-related gate types that ALWAYS block — they gate real money (card
# issuing / billing / per-charge consent) and must stay live. Every OTHER gate
# type (currently only `source_connect`, e.g. "connect your Gmail") is a
# connection gate that the non-purchase kill-switch can temporarily suppress.
# See `service._should_suppress_gate` and the NON_PURCHASE_GATES_ENABLED env flag.
PURCHASE_GATE_TYPES = frozenset({"subscription", "kyc", "approval"})

__all__ = [
    "DEFAULT_KYC_URL",
    "DEFAULT_SUBSCRIBE_URL",
    "PURCHASE_GATE_TYPES",
    "REJECTION_SENTINEL",
    "TOOL_NAME",
]
