"""Model pricing helper — thin wrapper around the in-process Rose pricing table.

Pricing used to be fetched from the Supabase /cost edge function; that
endpoint has been retired along with the rest of the research stack.
The lookup is now an in-memory table at `providers/rose/pricing.py`.
"""

from typing import Dict, Optional

import structlog
from temporalio import activity

from providers.rose.pricing import (
    ANTHROPIC_MODEL_PRICING,
    get_anthropic_pricing,
)
from providers.rose.pricing import (
    get_model_pricing as _lookup_model_pricing,
)

logger = structlog.get_logger()


__all__ = [
    "ANTHROPIC_MODEL_PRICING",
    "get_anthropic_pricing",
    "get_default_pricing",
    "get_model_pricing",
    "get_model_pricing_with_fallback",
    "fetch_model_pricing",
]


async def get_model_pricing(model: str) -> Optional[Dict[str, float]]:
    """Return cents-per-1k pricing for any Rose pool or Anthropic model."""
    pricing = _lookup_model_pricing(model)
    if pricing is not None:
        logger.info(
            "💰 Resolved model pricing",
            model=model,
            input_cents_per_1k=pricing["input_cents_per_1k"],
            output_cents_per_1k=pricing["output_cents_per_1k"],
        )
    return pricing


def get_default_pricing(model: str) -> Dict[str, float]:
    """Rough fallback estimates when an exact model isn't in the table."""
    normalized = model.lower()
    if "rose-1-ultra" in normalized or "rose-ultra" in normalized:
        return {"input_cents_per_1k": 0.125, "output_cents_per_1k": 0.5}
    if "rose-1-lite" in normalized or "rose-lite" in normalized or "rose-fast" in normalized:
        return {"input_cents_per_1k": 0.05, "output_cents_per_1k": 0.15}
    return {"input_cents_per_1k": 0.1, "output_cents_per_1k": 0.3}


async def get_model_pricing_with_fallback(model: str) -> Dict[str, float]:
    """Resolve pricing, falling back to coarse estimates for unknown models.

    Newly introduced or aliased model ids shouldn't crash the pipeline — fall
    back to `get_default_pricing` so callers still get a plausible number.
    """
    pricing = await get_model_pricing(model)
    if pricing is not None:
        return pricing
    logger.warning(
        "💰 Using default pricing fallback — model not in pricing table",
        model=model,
    )
    return get_default_pricing(model)


@activity.defn
async def fetch_model_pricing(model: str) -> Dict[str, float]:
    """Activity wrapper — kept for workflow compatibility."""
    activity.heartbeat(f"Fetching pricing for {model}")
    return await get_model_pricing_with_fallback(model)
