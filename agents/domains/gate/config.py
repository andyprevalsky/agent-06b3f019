"""Gate domain constants and defaults."""

from utils.attention_requests import REJECTION_SENTINEL

TOOL_NAME = "gate"
DEFAULT_SUBSCRIBE_URL = "https://roselabs.ai/subscribe"
DEFAULT_KYC_URL = "https://roselabs.ai/kyc/start"

__all__ = [
    "DEFAULT_KYC_URL",
    "DEFAULT_SUBSCRIBE_URL",
    "REJECTION_SENTINEL",
    "TOOL_NAME",
]
