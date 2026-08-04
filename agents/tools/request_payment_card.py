"""Backward-compatible exports for request_payment_card helpers."""

from typing import TYPE_CHECKING

from domains.request_payment_card.contracts import (
    MINT_PURCHASE_CARD_ACTIVITY_TIMEOUT_SECONDS,
    MINT_PURCHASE_CARD_BACKEND_RETRY_BUDGET_SECONDS,
    MINT_PURCHASE_CARD_HTTP_TIMEOUT_SECONDS,
)
from domains.request_payment_card.handler import (
    build_payment_fingerprint,
    build_payment_question,
    normalize_payment_payload,
)

if TYPE_CHECKING:
    from domains.request_payment_card.repo import (
        agentcard_status_activity,
        lookup_purchase_activity,
        mint_purchase_card_activity,
        record_facilitated_gmv_activity,
    )

__all__ = [
    "build_payment_fingerprint",
    "build_payment_question",
    "MINT_PURCHASE_CARD_ACTIVITY_TIMEOUT_SECONDS",
    "MINT_PURCHASE_CARD_BACKEND_RETRY_BUDGET_SECONDS",
    "MINT_PURCHASE_CARD_HTTP_TIMEOUT_SECONDS",
    "agentcard_status_activity",
    "lookup_purchase_activity",
    "mint_purchase_card_activity",
    "record_facilitated_gmv_activity",
    "normalize_payment_payload",
]


def __getattr__(name):
    if name in {
        "agentcard_status_activity",
        "lookup_purchase_activity",
        "mint_purchase_card_activity",
        "record_facilitated_gmv_activity",
    }:
        from domains.request_payment_card.repo import (
            agentcard_status_activity,
            lookup_purchase_activity,
            mint_purchase_card_activity,
            record_facilitated_gmv_activity,
        )

        return {
            "agentcard_status_activity": agentcard_status_activity,
            "lookup_purchase_activity": lookup_purchase_activity,
            "mint_purchase_card_activity": mint_purchase_card_activity,
            "record_facilitated_gmv_activity": record_facilitated_gmv_activity,
        }[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
