"""Types for normalized browser payment-card requests."""

from typing import Any, Dict, TypeAlias

PaymentPayload: TypeAlias = Dict[str, Any]
PaymentToolCall: TypeAlias = Dict[str, Any]

__all__ = ["PaymentPayload", "PaymentToolCall"]
