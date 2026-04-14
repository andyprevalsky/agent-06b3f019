"""x402 Bazaar domain configuration.

Constants and defaults for the x402 Bazaar domain.
Imports: own types only.
"""

import time

# x402 Bazaar API endpoint
X402_BAZAAR_API = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"

# Timeouts
SEARCH_TIMEOUT_SECONDS = 30.0
PAY_TIMEOUT_SECONDS = 60.0

# Retry configuration
SEARCH_MAX_ATTEMPTS = 3
PAY_MAX_ATTEMPTS = 2
RETRY_BACKOFF_COEFFICIENT = 2.0
RETRY_INITIAL_INTERVAL_SECONDS = 1
RETRY_MAX_INTERVAL_SECONDS = 10
PAY_RETRY_INITIAL_INTERVAL_SECONDS = 2

# Payment token validity (seconds)
PAYMENT_VALIDITY_SECONDS = 3600

# Display truncation
URL_DISPLAY_MAX_LENGTH = 60

# USDC decimal conversion: 6 decimals total, minus 2 for cents = 4
USDC_ATOMIC_TO_CENTS_DIVISOR = 10000

# Chain IDs
BASE_MAINNET_CHAIN_ID = 8453
BASE_SEPOLIA_CHAIN_ID = 84532


def safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0
