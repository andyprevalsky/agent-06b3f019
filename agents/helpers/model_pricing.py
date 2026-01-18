"""Model pricing helper - fetches and caches model pricing from Supabase."""

from typing import Optional, Dict, Any
from datetime import datetime, timedelta
import structlog
import httpx

from config import load_config

logger = structlog.get_logger()

# In-memory cache for model pricing (avoid repeated API calls)
# Format: {model_id: {"input_cents_per_1k": float, "output_cents_per_1k": float, "expires_at": datetime}}
_model_pricing_cache: Dict[str, Dict[str, Any]] = {}

# Cache duration: 1 hour (pricing doesn't change often)
CACHE_DURATION_SECONDS = 3600


async def get_model_pricing(model: str) -> Optional[Dict[str, float]]:
    """
    Fetch model pricing from Supabase cost endpoint.
    
    Args:
        model: Model identifier (e.g., "rose-1-ultra", "rose-labs/rose-1-ultra")
        
    Returns:
        Dict with 'input_cents_per_1k' and 'output_cents_per_1k', or None if fetch fails
    """
    # Normalize model name
    normalized_model = model.lower()
    if normalized_model.startswith('rose-labs/'):
        normalized_model = normalized_model.replace('rose-labs/', '')
    
    # Check cache first
    now = datetime.now()
    if normalized_model in _model_pricing_cache:
        cached = _model_pricing_cache[normalized_model]
        if cached.get("expires_at") and cached["expires_at"] > now:
            logger.info(
                "💾 Using cached pricing",
                model=model,
                input_cents_per_1k=cached["input_cents_per_1k"],
                output_cents_per_1k=cached["output_cents_per_1k"]
            )
            return {
                "input_cents_per_1k": cached["input_cents_per_1k"],
                "output_cents_per_1k": cached["output_cents_per_1k"]
            }
    
    # Fetch from Supabase cost endpoint
    try:
        config = load_config()

        # Build URL for cost endpoint - derive from rose.api_url to respect dev/prod environment
        # config.rose.api_url is "http://localhost:54321/functions/v1/completions" in dev
        # and "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions" in prod
        cost_url = config.rose.api_url.replace("/completions", f"/cost?model={normalized_model}")
        
        logger.info("🔄 Fetching fresh pricing from Supabase", model=model, url=cost_url)
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                cost_url,
                headers={
                    "Authorization": f"Bearer {config.supabase.anon_key}",
                }
            )
            
            if response.status_code != 200:
                logger.warning(
                    "Failed to fetch pricing from Supabase",
                    model=model,
                    status_code=response.status_code,
                    response_text=response.text[:200]
                )
                return None
            
            data = response.json()
            
            # Extract pricing (USD per million tokens)
            pricing = data.get("pricing", {})
            cost_per_million_input = pricing.get("costPerMillionInputTokens", 0)
            cost_per_million_output = pricing.get("costPerMillionOutputTokens", 0)
            
            # Convert to cents per 1k tokens
            # USD per million = X
            # Cents per million = X * 100
            # Cents per 1k = X * 100 / 1000 = X / 10
            input_cents_per_1k = cost_per_million_input / 10
            output_cents_per_1k = cost_per_million_output / 10
            
            # Cache the result
            _model_pricing_cache[normalized_model] = {
                "input_cents_per_1k": input_cents_per_1k,
                "output_cents_per_1k": output_cents_per_1k,
                "expires_at": now + timedelta(seconds=CACHE_DURATION_SECONDS)
            }
            
            logger.info(
                "✅ Fetched and cached pricing",
                model=model,
                cost_per_million_input_usd=cost_per_million_input,
                cost_per_million_output_usd=cost_per_million_output,
                input_cents_per_1k=input_cents_per_1k,
                output_cents_per_1k=output_cents_per_1k
            )
            
            return {
                "input_cents_per_1k": input_cents_per_1k,
                "output_cents_per_1k": output_cents_per_1k
            }
            
    except Exception as e:
        logger.error("Error fetching model pricing", model=model, error=str(e))
        return None


def get_default_pricing(model: str) -> Dict[str, float]:
    """
    Get default/fallback pricing for a model if dynamic fetch fails.
    
    These are rough estimates - actual pricing should be fetched dynamically.
    
    Args:
        model: Model identifier
        
    Returns:
        Dict with 'input_cents_per_1k' and 'output_cents_per_1k'
    """
    # Normalize
    normalized = model.lower()
    if "rose-1-ultra" in normalized or "rose-ultra" in normalized:
        # Rose 1 Ultra - higher quality tier
        return {
            "input_cents_per_1k": 0.125,
            "output_cents_per_1k": 0.5
        }
    elif "rose-1-lite" in normalized or "rose-lite" in normalized or "rose-fast" in normalized:
        # Rose 1 Lite - faster/cheaper tier
        return {
            "input_cents_per_1k": 0.05,
            "output_cents_per_1k": 0.15
        }
    else:
        # Default fallback
        return {
            "input_cents_per_1k": 0.1,
            "output_cents_per_1k": 0.3
        }


async def get_model_pricing_with_fallback(model: str) -> Dict[str, float]:
    """
    Get model pricing from API. Raises error if pricing cannot be fetched.

    This function intentionally does NOT use fallback pricing to ensure
    pricing configuration issues are surfaced as errors rather than silently
    using incorrect values.

    Args:
        model: Model identifier

    Returns:
        Dict with 'input_cents_per_1k' and 'output_cents_per_1k'

    Raises:
        RuntimeError: If pricing cannot be fetched from API
    """
    pricing = await get_model_pricing(model)

    if pricing is None:
        raise RuntimeError(
            f"Failed to fetch pricing for model '{model}'. "
            f"Ensure the model is configured in the cost endpoint (research/supabase/functions/cost/index.ts MODEL_POOLS)."
        )

    return pricing


