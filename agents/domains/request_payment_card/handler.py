"""Temporal activity entry points for request-payment-card."""

from temporalio import activity

from .service import lookup_purchase, mint_purchase_card
from .types import PaymentPayload, PurchaseResult


@activity.defn
async def lookup_purchase_activity(user_id: str, fingerprint: str) -> PurchaseResult:
    return await lookup_purchase(user_id, fingerprint)


@activity.defn
async def mint_purchase_card_activity(user_id: str, payload: PaymentPayload) -> PurchaseResult:
    return await mint_purchase_card(user_id, payload)
