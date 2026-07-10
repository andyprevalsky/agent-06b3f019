from .service import build_payment_fingerprint, build_payment_question, normalize_payment_payload

__all__ = [
    "build_payment_fingerprint",
    "build_payment_question",
    "lookup_purchase_activity",
    "mint_purchase_card_activity",
    "normalize_payment_payload",
]


def __getattr__(name):
    if name in {"lookup_purchase_activity", "mint_purchase_card_activity"}:
        from .repo import lookup_purchase_activity, mint_purchase_card_activity

        return {
            "lookup_purchase_activity": lookup_purchase_activity,
            "mint_purchase_card_activity": mint_purchase_card_activity,
        }[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
