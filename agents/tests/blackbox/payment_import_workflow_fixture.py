from temporalio import workflow


@workflow.defn
class PaymentImportWorkflow:
    @workflow.run
    async def run(self):
        from domains.request_payment_card import (
            build_payment_question as build_domain_payment_question,
            normalize_payment_payload as normalize_domain_payment_payload,
        )
        from tools.request_payment_card import (
            MINT_PURCHASE_CARD_ACTIVITY_TIMEOUT_SECONDS,
            build_payment_question,
            mint_purchase_card_activity,
            normalize_payment_payload,
        )

        payload = normalize_payment_payload(
            {
                "merchant": "Blick Art Materials",
                "line_items": [
                    {
                        "name": "Brush",
                        "product_url": "https://www.dickblick.com/products/brush/",
                        "rating": "4.7 stars",
                        "review_count": "84 reviews",
                        "quantity": 1,
                        "line_total_cents": 636,
                    }
                ],
                "subtotal_cents": 636,
                "total_cents": 636,
            },
            "user-1",
        )
        domain_payload = normalize_domain_payment_payload(
            {
                "merchant": "Blick Art Materials",
                "line_items": [
                    {
                        "name": "Brush",
                        "product_url": "https://www.dickblick.com/products/brush/",
                        "rating": "4.7 stars",
                        "review_count": "84 reviews",
                        "quantity": 1,
                        "line_total_cents": 636,
                    }
                ],
                "subtotal_cents": 636,
                "total_cents": 636,
            },
            "user-1",
        )
        return {
            "tool_question": build_payment_question(payload),
            "domain_question": build_domain_payment_question(domain_payload),
            "same_fingerprint": payload["fingerprint"] == domain_payload["fingerprint"],
            "mint_activity_timeout_seconds": MINT_PURCHASE_CARD_ACTIVITY_TIMEOUT_SECONDS,
            "mint_activity_imported": callable(mint_purchase_card_activity),
        }
