"""x402 Bazaar tools - backward-compatible re-exports.

All logic has moved to domains/x402_bazaar/. This shim exists so that
existing callers (tests, workflow sandbox imports) continue to work.
"""

from domains.x402_bazaar.handler import (
    pay_for_x402_bazaar_service,
    search_x402_bazaar,
)
from domains.x402_bazaar.repo import (
    pay_for_x402_service_activity,
    search_x402_bazaar_activity,
)
from domains.x402_bazaar.service import (
    PayForX402BazaarServiceManager,
    SearchX402BazaarManager,
    get_pay_manager,
    get_search_manager,
)

__all__ = [
    "PayForX402BazaarServiceManager",
    "SearchX402BazaarManager",
    "get_pay_manager",
    "get_search_manager",
    "pay_for_x402_bazaar_service",
    "pay_for_x402_service_activity",
    "search_x402_bazaar",
    "search_x402_bazaar_activity",
]
