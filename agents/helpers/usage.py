"""
Standardized usage tracking helpers.

All LLM and service costs flow through these helpers for consistent tracking.

Usage Pattern:
    # In activities - return usage with result:
    return {
        "result": actual_result,
        "usage": make_usage(
            llm=[llm_usage(tokens_in=100, tokens_out=50, model="rose-ultra")],
            service=[service_usage(cost_cents=5, provider="Perplexity")]
        )
    }

    # In workflow - process after activity:
    result = await workflow.execute_activity(...)
    await self._track_usage(result.get("usage"))
    actual = result.get("result", result)
"""

from typing import Any, Dict, List, Optional


def llm_usage(
    tokens_in: int, tokens_out: int, model: Optional[str] = None, provider: Optional[str] = None
) -> Dict[str, Any]:
    """
    Create an LLM usage item.

    Args:
        tokens_in: Input/prompt tokens
        tokens_out: Output/completion tokens
        model: Model used (for pricing lookup). If None, uses workflow's model.
        provider: Human-readable provider name (e.g., "Rose Planner", "Perplexity")
    """
    return {
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "model": model,
        "provider": provider,
    }


def service_usage(cost_cents: int, provider: str) -> Dict[str, Any]:
    """
    Create a service usage item (non-LLM costs).

    Args:
        cost_cents: Pre-calculated cost in cents
        provider: Human-readable provider name (e.g., "Steel Session", "Perplexity Search")
    """
    return {
        "cost_cents": cost_cents,
        "provider": provider,
    }


def make_usage(
    llm: Optional[List[Dict[str, Any]]] = None, service: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, List]:
    """
    Create a usage dict to include in activity results.

    Args:
        llm: List of llm_usage() items
        service: List of service_usage() items
    """
    return {
        "llm": llm or [],
        "service": service or [],
    }


def with_usage(
    result: Any, llm: Optional[List[Dict[str, Any]]] = None, service: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """
    Wrap an activity result with usage info.

    This is the standard return format for activities with usage:
        return with_usage(
            result={"success": True, "data": ...},
            llm=[llm_usage(100, 50, model="rose-ultra")],
            service=[service_usage(5, "Perplexity")]
        )

    Workflow extracts usage via:
        result = await workflow.execute_activity(...)
        await self._track_usage(result.get("usage"))
        actual = result.get("result", result)
    """
    return {
        "result": result,
        "usage": make_usage(llm, service),
    }
