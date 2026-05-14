"""Tool for fetching model metadata from OpenRouter."""

import httpx
import structlog
from temporalio import activity

from config import load_config

logger = structlog.get_logger()

# Pool strings the workflow may emit. OpenRouter does not list these IDs
# (they route in-process via Rose), so we seed them with the underlying
# Anthropic Sonnet 4.6 window (200k, no `context-1m-2025-08-07` beta).
_ROSE_POOL_CONTEXT_WINDOWS = {
    "rose-labs/rose-1-lite": 200_000,
    "rose-labs/rose-1-ultra": 200_000,
    "rose-labs/rose-1-browser-use": 200_000,
    "rose": 200_000,
    "rose-ultra": 200_000,
    "rose-lite": 200_000,
}

# In-memory cache for model context windows (avoid repeated API calls)
_model_context_cache: dict[str, int] = dict(_ROSE_POOL_CONTEXT_WINDOWS)

# Default fallback when a model is unknown. Every model we currently route to
# is at least 200k (Sonnet 4.6 default, no 1M beta header).
_DEFAULT_CONTEXT_WINDOW = 200_000


@activity.defn
async def get_model_context_window(model: str) -> int:
    """
    Fetch the context window size for a model from OpenRouter API.

    Args:
        model: Model identifier (e.g., "anthropic/claude-sonnet-4.5")

    Returns:
        Context window size in tokens (defaults to 100,000 if not found)
    """
    try:
        # Check cache first
        if model in _model_context_cache:
            logger.info(
                "Model context window retrieved from cache", model=model, context_length=_model_context_cache[model]
            )
            return _model_context_cache[model]

        activity.heartbeat(f"Fetching context window for {model}")

        config = load_config()

        # Fetch from OpenRouter API
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{config.openrouter.base_url}/models",
                headers={
                    "Authorization": f"Bearer {config.openrouter.api_key}",
                },
                timeout=30.0,
            )
            response.raise_for_status()

            data = response.json()
            models = data.get("data", [])

            # Find the specific model
            for model_data in models:
                if model_data.get("id") == model:
                    context_length = model_data.get("context_length", _DEFAULT_CONTEXT_WINDOW)

                    # Cache it
                    _model_context_cache[model] = context_length

                    logger.info(
                        "Model context window fetched from OpenRouter", model=model, context_length=context_length
                    )

                    return context_length

        # Model not found, use default
        _model_context_cache[model] = _DEFAULT_CONTEXT_WINDOW

        logger.warning(
            "Model not found in OpenRouter, using default context window",
            model=model,
            default_context=_DEFAULT_CONTEXT_WINDOW,
        )

        return _DEFAULT_CONTEXT_WINDOW

    except Exception as e:
        logger.error("Failed to fetch model context window", model=model, error=str(e))
        # Return safe default on error
        _model_context_cache[model] = _DEFAULT_CONTEXT_WINDOW
        return _DEFAULT_CONTEXT_WINDOW
