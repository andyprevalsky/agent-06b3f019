"""Agent speed: the create-agent ``speed`` param forwarded to every provider leg.

    create-agent {speed} -> Agent.speed -> agent-flag endpoint -> Rose leg body
      standard   -> nothing (no speed / service_tier anywhere)
      fast       -> Claude ``speed: fast`` (fast-mode models only),
                    GPT OAuth / OpenAI key ``service_tier: priority``,
                    Azure Foundry ``service_tier: priority``, OpenRouter ``speed: fast``
      ultrafast  -> as fast, except GPT OAuth / OpenAI key send
                    ``service_tier: ultrafast`` on models whose catalog lists it.
                    Claude has no ultrafast: it gets fast mode. Azure has no
                    ultrafast: it gets priority.

Speed never gates a cache. Mirror: back-end/src/providers/rose/speed.ts.
"""

from __future__ import annotations

from contextvars import ContextVar, Token
from typing import Any, Literal, Optional, cast

AgentSpeed = Literal["standard", "fast", "ultrafast"]
AGENT_SPEEDS: tuple[str, ...] = ("standard", "fast", "ultrafast")

# Claude API fast mode (``speed: "fast"`` + ``fast-mode-2026-02-01`` beta).
# Claude API reference 2026-10-06: Claude Opus 5, Claude Opus 5.5 and Opus 4.8
# only; Opus 4.7 fast mode was removed and now errors.
ANTHROPIC_FAST_MODE_MODELS = frozenset({"claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"})

# Models whose ChatGPT/Codex catalog lists the ``ultrafast`` service tier
# (live catalog fetched 2026-10-28: gpt-6.1-sol and gpt-6-astra list
# priority + ultrafast; every other GPT model lists priority only).
OPENAI_ULTRAFAST_MODELS = frozenset({"gpt-6.1-sol", "gpt-6-astra"})


# Speed bound for the current activity (browser agents bind it once at task
# start), so per-step browser LLM calls never look it up again.
_CURRENT_AGENT_SPEED: ContextVar[Optional[str]] = ContextVar("rose_agent_speed", default=None)


def current_agent_speed() -> Optional[str]:
    return _CURRENT_AGENT_SPEED.get()


def bind_agent_speed(speed: Optional[str]) -> Token[Optional[str]]:
    return _CURRENT_AGENT_SPEED.set(normalize_agent_speed(speed))


def normalize_agent_speed(value: Any) -> AgentSpeed:
    """Unknown/absent values are standard; a legacy boolean button maps True -> fast."""
    if value is True:
        return "fast"
    if isinstance(value, str) and value in AGENT_SPEEDS:
        return cast(AgentSpeed, value)
    return "standard"


def _fast_or_ultrafast(speed: Optional[str]) -> bool:
    return speed in ("fast", "ultrafast")


def supports_anthropic_fast_mode(model: str) -> bool:
    return model in ANTHROPIC_FAST_MODE_MODELS


def anthropic_speed_for(speed: Optional[str], model: str) -> Optional[str]:
    """Claude legs (OAuth and API key): ``fast`` for fast or ultrafast."""
    return "fast" if _fast_or_ultrafast(speed) and supports_anthropic_fast_mode(model) else None


def openai_service_tier_for(speed: Optional[str], model: str) -> Optional[str]:
    """GPT OAuth (Codex) and OpenAI API key legs."""
    if speed == "ultrafast":
        return "ultrafast" if model in OPENAI_ULTRAFAST_MODELS else "priority"
    return "priority" if speed == "fast" else None


def foundry_service_tier_for(speed: Optional[str]) -> Optional[str]:
    """Azure Foundry has no ultrafast tier: fast and ultrafast both send priority."""
    return "priority" if _fast_or_ultrafast(speed) else None


def openrouter_speed_for(speed: Optional[str]) -> Optional[str]:
    """OpenRouter waterfall keeps its existing ``speed: fast`` hint for fast/ultrafast."""
    return "fast" if _fast_or_ultrafast(speed) else None
