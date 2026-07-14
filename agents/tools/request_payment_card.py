"""Backward-compatible exports for request_payment_card helpers."""

from typing import TYPE_CHECKING

from domains.request_payment_card.service import (
    build_payment_fingerprint,
    build_payment_question,
    normalize_payment_payload,
)

if TYPE_CHECKING:
    from domains.request_payment_card.repo import (
        agentcard_status_activity,
        lookup_purchase_activity,
        mint_purchase_card_activity,
    )

__all__ = [
    "build_payment_fingerprint",
    "build_payment_question",
    "agentcard_status_activity",
    "lookup_purchase_activity",
    "mint_purchase_card_activity",
    "normalize_payment_payload",
]


def __getattr__(name):
    if name in {"agentcard_status_activity", "lookup_purchase_activity", "mint_purchase_card_activity"}:
        from domains.request_payment_card.repo import (
            agentcard_status_activity,
            lookup_purchase_activity,
            mint_purchase_card_activity,
        )

        return {
            "agentcard_status_activity": agentcard_status_activity,
            "lookup_purchase_activity": lookup_purchase_activity,
            "mint_purchase_card_activity": mint_purchase_card_activity,
        }[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
