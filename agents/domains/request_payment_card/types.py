"""Type definitions for the request-payment-card domain."""

from typing import Any, TypedDict


class PaymentPayload(TypedDict):
    """Normalized purchase data passed across the approval boundary."""

    userId: str
    merchant: str
    currency: str
    lineItems: list[dict[str, Any]]
    fees: list[dict[str, Any]]
    subtotalCents: int
    totalCents: int
    fingerprint: str
