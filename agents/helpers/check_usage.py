"""
Activity for checking user's credit usage and pausing agents if depleted.
"""

import asyncio

import httpx
from temporalio import activity

from config import load_config

config = load_config()


@activity.defn
async def check_user_usage(user_id: str) -> dict:
    """
    Check if a user has remaining credits.
    Retries with exponential backoff on failure.

    Args:
        user_id: The Supabase user ID

    Returns:
        dict with:
            - has_credits: bool (True if user has credits remaining)
            - remaining: float (remaining credit balance)
            - used: float (total usage)
            - total: float (total credits available)
        Returns None on complete failure to preserve cached value in workflow
    """
    activity.logger.info(f"💰 Checking usage for user {user_id}")

    backend_url = config.backend.api_url.rstrip("/")
    backend_api_key = config.backend.api_key

    if not backend_api_key:
        activity.logger.error("❌ BACKEND_API_KEY not configured")
        return None  # Don't override cache

    # Retry logic with exponential backoff
    max_retries = 3
    base_delay = 1.0

    for attempt in range(max_retries):
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{backend_url}/api/credits/usage",
                    headers={"X-API-Key": backend_api_key, "Content-Type": "application/json"},
                    params={"userId": user_id},
                )

                if response.status_code == 200:
                    usage_data = response.json()

                    remaining = usage_data.get("remaining", 0)
                    # Admins (ADMIN_USER_IDS) carry an `unlimited` flag from the backend and are
                    # never blocked by the free-credit / subscription gate, regardless of balance.
                    unlimited = bool(usage_data.get("unlimited", False))
                    has_credits = unlimited or remaining > 0

                    activity.logger.info(
                        f"💰 Usage check complete: ${remaining:.2f} remaining "
                        f"(has_credits: {has_credits}, unlimited: {unlimited})"
                    )

                    return {
                        "has_credits": has_credits,
                        "remaining": remaining,
                        "used": usage_data.get("used", 0),
                        "total": usage_data.get("total", 0),
                        "tier": usage_data.get("tier"),
                    }
                else:
                    activity.logger.warning(
                        f"⚠️ Backend returned {response.status_code} (attempt {attempt + 1}/{max_retries})"
                    )

                    if attempt == max_retries - 1:
                        activity.logger.error("❌ All retries exhausted")
                        return None  # Don't override cache

                    # Exponential backoff
                    delay = base_delay * (2**attempt)
                    await asyncio.sleep(delay)

        except Exception as e:
            activity.logger.warning(f"⚠️ Error checking usage (attempt {attempt + 1}/{max_retries}): {str(e)}")

            if attempt == max_retries - 1:
                activity.logger.error("❌ All retries exhausted")
                return None  # Don't override cache

            # Exponential backoff
            delay = base_delay * (2**attempt)
            await asyncio.sleep(delay)

    return None  # Shouldn't reach here, but be safe
