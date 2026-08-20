"""LLM binary challenge classifier (rose-1-mini).

Replaces heuristic title/body/html marker gating for live-tab / cookie-probe /
post-promote verify decisions. The legacy ``page_looks_challenged`` heuristic
in challenge_recovery.py is deprecated but retained.

Mirrors back-end ``challengeLlmClassifier.ts``:
  settle DOM → screenshot + cleaned DOM + network metadata → rose-1-mini
  structured {challenged, reason}.

Cost routing reuses ``helpers.llm.call_llm`` (same path as web_fetch's
rose-1-mini summarizer). Callers must fold returned ``usage`` into the
browser ``usage_by_model`` ledger so ``AgentWorkflow._track_usage`` prices
and persists ToolUsage rows.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

import structlog
from pydantic import BaseModel, Field

logger = structlog.get_logger()

CHALLENGE_LLM_MODEL = "rose-labs/rose-1-mini"
CHALLENGE_LLM_SETTLE_MS = 60_000
CHALLENGE_LLM_CALL_SITE = "challenge_llm_classifier"
_CLEANED_DOM_CHAR_CAP = 12_000
_NETWORK_ENTRY_CAP = 40

CHALLENGE_LLM_SYSTEM_PROMPT = """You are a binary page-state classifier for a browser agent.

Decide whether the CURRENT page is still blocked by an anti-bot challenge (CAPTCHA, bot check, access denied, blank soft-wall, rate-limit interstitial, "checking your browser", vendor challenge widget, empty shell that is not the real site UI) OR whether the real destination page is usable.

Return challenged=true when:
- A challenge / CAPTCHA / human-verification interstitial is visible or dominating the page
- The document is an empty/blank soft-wall, error gateway, or host-only shell without the real product UI
- Navigation failed into a block page even if some marketing text leaked into the DOM

Return challenged=false ONLY when:
- The real destination site UI for the target URL is visibly present and usable (navigation, primary content, interactive controls for the task)

Do not overfit to one vendor. Use the screenshot as ground truth for what a human would see; use cleaned DOM + network metadata as supporting evidence. Prefer challenged=true when uncertain."""


class ChallengePageClassification(BaseModel):
    challenged: bool = Field(
        description=(
            "True when the page is still an anti-bot / CAPTCHA / access wall or "
            "otherwise unusable for the intended site task. False only when the "
            "real destination UI is visible and interactive."
        )
    )
    reason: str = Field(description="One short sentence explaining the challenged/clean decision.")


async def wait_for_dom_settled(page: Any, timeout_ms: float = CHALLENGE_LLM_SETTLE_MS) -> None:
    """Wait for load + network quiet (best-effort) before classifying."""
    started = asyncio.get_running_loop().time()
    with_context = getattr(page, "wait_for_load_state", None)
    if callable(with_context):
        try:
            await page.wait_for_load_state(
                "domcontentloaded",
                timeout=min(15_000, timeout_ms),
            )
        except Exception:
            pass
        remaining = max(0.0, timeout_ms - (asyncio.get_running_loop().time() - started) * 1000)
        if remaining > 0:
            try:
                await page.wait_for_load_state("networkidle", timeout=remaining)
            except Exception:
                pass
    try:
        await page.wait_for_timeout(1_500)
    except Exception:
        await asyncio.sleep(1.5)


async def capture_cleaned_dom(page: Any) -> str:
    try:
        cleaned = await page.evaluate(
            """(charCap) => {
              const body = document.body;
              if (!body) return '';
              const clone = body.cloneNode(true);
              clone.querySelectorAll('script, style, noscript, svg, iframe')
                .forEach((node) => node.remove());
              const lines = [];
              const interesting = clone.querySelectorAll(
                'a, button, input, select, textarea, h1, h2, h3, h4, label, [role="button"], [role="link"]'
              );
              interesting.forEach((el) => {
                const tag = el.tagName.toLowerCase();
                const text = (el.textContent || el.value || el.placeholder || '')
                  .replace(/\\s+/g, ' ')
                  .trim()
                  .slice(0, 200);
                if (text) lines.push(`${tag}: ${text}`);
              });
              const interactive = lines.join('\\n').trim();
              if (interactive.length >= 40) return interactive.slice(0, charCap);
              return (clone.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, charCap);
            }""",
            _CLEANED_DOM_CHAR_CAP,
        )
        return cleaned if isinstance(cleaned, str) else ""
    except Exception:
        return ""


async def capture_network_summary(page: Any) -> str:
    try:
        entries = await page.evaluate(
            """(cap) => {
              const resources = performance.getEntriesByType('resource');
              return resources.slice(-cap).map((entry) => ({
                name: String(entry.name || '').slice(0, 180),
                durationMs: Math.round(entry.duration || 0),
                transferSize: Number(entry.transferSize || 0),
              }));
            }""",
            _NETWORK_ENTRY_CAP,
        )
        if not isinstance(entries, list) or not entries:
            return "(no resource timings)"
        lines = [
            f"{int(e.get('durationMs') or 0)}ms {int(e.get('transferSize') or 0)}B {e.get('name') or ''}"
            for e in entries
            if isinstance(e, dict)
        ]
        return "\n".join(lines)[:4_000]
    except Exception:
        return "(network metadata unavailable)"


async def capture_challenge_classifier_context(
    page: Any,
    response: Any = None,
) -> Dict[str, Any]:
    title_task = page.title()
    cleaned_task = capture_cleaned_dom(page)
    network_task = capture_network_summary(page)
    title, cleaned_dom, network_summary = await asyncio.gather(
        title_task, cleaned_task, network_task, return_exceptions=True
    )
    title_s = title if isinstance(title, str) else ""
    cleaned_s = cleaned_dom if isinstance(cleaned_dom, str) else ""
    network_s = network_summary if isinstance(network_summary, str) else "(network metadata unavailable)"
    screenshot_b64: Optional[str] = None
    try:
        raw = await page.screenshot(type="png", full_page=False)
        if isinstance(raw, (bytes, bytearray)):
            import base64

            screenshot_b64 = base64.b64encode(bytes(raw)).decode("ascii")
    except Exception as exc:
        logger.warning("Challenge LLM classifier screenshot failed", error=str(exc))
    status = None
    if response is not None:
        try:
            status = int(response.status)
        except Exception:
            status = None
    try:
        url = page.url
        if callable(url):
            url = url()
        url = str(url or "")
    except Exception:
        url = ""
    return {
        "url": url,
        "title": title_s,
        "status": status,
        "cleaned_dom": cleaned_s,
        "network_summary": network_s,
        "screenshot_base64_png": screenshot_b64,
    }


def build_challenge_classifier_messages(context: Dict[str, Any]) -> List[Dict[str, Any]]:
    text_block = "\n".join(
        [
            f"Target URL: {context.get('url') or ''}",
            f"Document title: {context.get('title') or '(empty)'}",
            f"Last main-document HTTP status: {context.get('status') if context.get('status') is not None else '(unknown)'}",
            "",
            "Network metadata (recent resource timings):",
            context.get("network_summary") or "(none)",
            "",
            "Cleaned DOM (scripts/styles removed; interactive summary preferred):",
            context.get("cleaned_dom") or "(empty)",
            "",
            "Classify challenged true/false for this page state.",
        ]
    )
    user_content: List[Dict[str, Any]] = [{"type": "text", "text": text_block}]
    screenshot = context.get("screenshot_base64_png")
    if isinstance(screenshot, str) and screenshot:
        user_content.append(
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/png;base64,{screenshot}",
                    "detail": "low",
                },
            }
        )
    return [
        {"role": "system", "content": CHALLENGE_LLM_SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]


def empty_classifier_usage() -> Dict[str, Any]:
    return {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "actual_model": CHALLENGE_LLM_MODEL,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
        "call_site": CHALLENGE_LLM_CALL_SITE,
    }


async def classify_challenge_with_llm(
    context: Dict[str, Any],
    *,
    agent_id: Optional[str] = None,
    user_id: Optional[str] = None,
    claude_token: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Fail closed: errors ⇒ challenged=True so probes cannot promote on outage."""
    from helpers.llm import call_llm

    try:
        result = await call_llm(
            messages=build_challenge_classifier_messages(context),
            model=CHALLENGE_LLM_MODEL,
            temperature=0,
            max_tokens=200,
            response_model=ChallengePageClassification,
            claude_token=claude_token,
            claude_token_source=claude_token_source,
            claude_token_pool_id=claude_token_pool_id,
            claude_token_user_id=user_id,
            gpt_token=gpt_token,
            gpt_account_id=gpt_account_id,
            gpt_token_source=gpt_token_source,
            gpt_token_pool_id=gpt_token_pool_id,
            gpt_token_user_id=user_id,
            call_site=CHALLENGE_LLM_CALL_SITE,
            agent_id=agent_id,
            user_id=user_id,
        )
        content = (result.get("content") or "").strip()
        usage = result.get("usage") or {}
        parsed = ChallengePageClassification.model_validate_json(content)
        usage_out = {
            "prompt_tokens": int(usage.get("prompt_tokens") or 0),
            "completion_tokens": int(usage.get("completion_tokens") or 0),
            "total_tokens": int(usage.get("total_tokens") or 0),
            "actual_model": usage.get("actual_model") or result.get("model") or CHALLENGE_LLM_MODEL,
            "cache_read_input_tokens": int(usage.get("cache_read_input_tokens") or 0),
            "cache_creation_input_tokens": int(usage.get("cache_creation_input_tokens") or 0),
            "from_fast_cache": bool(usage.get("from_fast_cache")),
            "call_site": CHALLENGE_LLM_CALL_SITE,
        }
        logger.info(
            "Challenge LLM classifier result",
            challenged=parsed.challenged,
            reason=(parsed.reason or "")[:200],
            url=str(context.get("url") or "")[:200],
            title=str(context.get("title") or "")[:120],
            actual_model=usage_out["actual_model"],
            prompt_tokens=usage_out["prompt_tokens"],
            completion_tokens=usage_out["completion_tokens"],
            agent_id=agent_id,
        )
        return {
            "challenged": parsed.challenged,
            "reason": parsed.reason,
            "usage": usage_out,
        }
    except Exception as exc:
        logger.warning(
            "Challenge LLM classifier failed closed as challenged",
            error=str(exc),
            url=str(context.get("url") or "")[:200],
            agent_id=agent_id,
        )
        return {
            "challenged": True,
            "reason": f"classifier_error: {exc}",
            "usage": empty_classifier_usage(),
        }


async def classify_page_after_settle(
    page: Any,
    response: Any = None,
    *,
    settle_timeout_ms: float = CHALLENGE_LLM_SETTLE_MS,
    agent_id: Optional[str] = None,
    user_id: Optional[str] = None,
    claude_token: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    usage_collector: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Settle DOM, capture context, run binary LLM classifier.

    Returns ``{clean, reason, title, usage}``. When ``usage_collector`` is
    provided, appends the usage dict for the caller to fold into cost tracking.
    """
    await wait_for_dom_settled(page, settle_timeout_ms)
    context = await capture_challenge_classifier_context(page, response)
    result = await classify_challenge_with_llm(
        context,
        agent_id=agent_id,
        user_id=user_id,
        claude_token=claude_token,
        claude_token_source=claude_token_source,
        claude_token_pool_id=claude_token_pool_id,
        gpt_token=gpt_token,
        gpt_account_id=gpt_account_id,
        gpt_token_source=gpt_token_source,
        gpt_token_pool_id=gpt_token_pool_id,
    )
    usage = result.get("usage") or empty_classifier_usage()
    if usage_collector is not None:
        usage_collector.append(usage)
    return {
        "clean": not bool(result.get("challenged")),
        "reason": str(result.get("reason") or ""),
        "title": str(context.get("title") or ""),
        "usage": usage,
    }
