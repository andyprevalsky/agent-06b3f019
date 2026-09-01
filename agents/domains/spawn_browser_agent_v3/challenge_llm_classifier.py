"""LLM binary challenge classifier (rose-1-mini).

Replaces heuristic title/body/html marker gating for live-tab / cookie-probe /
post-promote verify decisions. The legacy ``page_looks_challenged`` heuristic
in challenge_recovery.py is deprecated but retained.

Mirrors back-end ``challengeLlmClassifier.ts``:
  settle DOM → screenshot + agent DOM tree + network metadata → rose-1-mini
  structured {challenged, reason}.

Cost routing reuses ``helpers.llm.call_llm`` (same path as web_fetch's
rose-1-mini summarizer). Callers must fold returned ``usage`` into the
browser ``usage_by_model`` ledger so ``AgentWorkflow._track_usage`` prices
and persists ToolUsage rows.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import urlparse

import structlog
from pydantic import BaseModel, Field

logger = structlog.get_logger()

CHALLENGE_LLM_MODEL = "rose-labs/rose-1-mini"
CHALLENGE_LLM_SETTLE_MS = 60_000
CHALLENGE_LLM_CALL_SITE = "challenge_llm_classifier"
_DOM_CHAR_CAP = 12_000
_NETWORK_ENTRY_CAP = 40
_NETWORK_BODY_CHAR_CAP = 200
_NETWORK_SUMMARY_CHAR_CAP = 4_000

CHALLENGE_LLM_SYSTEM_PROMPT = """You are a binary page-state classifier for a browser agent.

Decide whether the CURRENT page is still blocked by an anti-bot challenge (CAPTCHA, bot check, access denied, blank soft-wall, rate-limit interstitial, "checking your browser", vendor challenge widget, empty shell that is not the real site UI) OR whether the real destination page is usable.

Return challenged=true when:
- A challenge / CAPTCHA / human-verification interstitial is visible or dominating the page
- The document is an empty/blank soft-wall, error gateway, or host-only shell without the real product UI
- Navigation failed into a block page even if some marketing text leaked into the DOM
- Network metadata still shows the soft-block described in the agent recovery reason (e.g. HTTP 429 / rate-limit on GraphQL or product APIs) even if the HTML shell looks fine
- The agent recovery reason is uncleared (product content still Loading, offers missing, cited endpoint still failing)
- A blocked third-party resource cited in the recovery reason (payment script/CDN, required widget) is still missing or failing in network evidence

Return challenged=false ONLY when:
- The real destination site UI for the target URL is visibly present and usable (navigation, primary content, interactive controls for the task)
- AND if an agent recovery reason is provided, that specific failure mode is cleared (network + DOM evidence)
- AND any cited blocked third-party resource is no longer failing in the provided evidence

Do not overfit to one vendor. Use the screenshot as ground truth for what a human would see; use the agent DOM tree + network metadata (including HTTP status and truncated response bodies) as supporting evidence. Prefer challenged=true when uncertain."""


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


async def capture_agent_stripped_dom(page: Any) -> str:
    """Capture stripped page text closest to the main browser agent's DOM view.

    Prefer full visible body text after removing script/style (so soft-block
    markers like Offers/Loading survive). Cap length for the classifier prompt.
    Callers that already have DOMService ``dom_tree`` should pass that instead
    via ``agent_dom_tree`` so the classifier sees the exact agent snapshot.
    """
    try:
        cleaned = await page.evaluate(
            """(charCap) => {
              const body = document.body;
              if (!body) return '';
              const clone = body.cloneNode(true);
              clone.querySelectorAll('script, style, noscript, svg, iframe')
                .forEach((node) => node.remove());
              return (clone.innerText || clone.textContent || '')
                .replace(/\\s+/g, ' ')
                .trim()
                .slice(0, charCap);
            }""",
            _DOM_CHAR_CAP,
        )
        return cleaned if isinstance(cleaned, str) else ""
    except Exception:
        return ""


# Back-compat alias used by older imports/tests.
capture_cleaned_dom = capture_agent_stripped_dom


def _truncate_body(text: str, cap: int = _NETWORK_BODY_CHAR_CAP) -> tuple[str, bool]:
    raw = text if isinstance(text, str) else str(text or "")
    if len(raw) <= cap:
        return raw, False
    return raw[:cap], True


def format_network_summary_lines(entries: Sequence[Dict[str, Any]]) -> str:
    """Format network rows with HTTP status and clearly-marked truncated bodies."""
    lines: List[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        url = str(entry.get("url") or entry.get("name") or "")[:180]
        duration = entry.get("duration_ms")
        if duration is None:
            duration = entry.get("durationMs")
        size = entry.get("size_bytes")
        if size is None:
            size = entry.get("transferSize")
        status = entry.get("status")
        status_text = str(entry.get("status_text") or entry.get("statusText") or "").strip()
        parts: List[str] = []
        if status is not None and str(status).strip() != "":
            parts.append(f"status={status}")
            if status_text:
                parts.append(status_text)
        if duration is not None:
            try:
                parts.append(f"{int(duration)}ms")
            except Exception:
                parts.append(f"{duration}ms")
        if size is not None:
            try:
                parts.append(f"{int(size)}B")
            except Exception:
                parts.append(f"{size}B")
        if url:
            parts.append(url)
        if not parts:
            continue
        line = " ".join(parts)
        body = entry.get("response_body")
        if body is None:
            body = entry.get("body")
        if isinstance(body, str) and body:
            snippet, capped_here = _truncate_body(body)
            truncated = bool(entry.get("response_body_truncated")) or capped_here
            if truncated:
                line += f"\n  response_body (truncated): {snippet}"
            else:
                line += f"\n  response_body: {snippet}"
        lines.append(line)
        if len("\n".join(lines)) >= _NETWORK_SUMMARY_CHAR_CAP:
            break
    if not lines:
        return "(no resource timings)"
    return "\n".join(lines)[:_NETWORK_SUMMARY_CHAR_CAP]


def network_entries_from_recorder(
    network_recorder: Any,
    *,
    limit: int = _NETWORK_ENTRY_CAP,
    max_body_chars: int = _NETWORK_BODY_CHAR_CAP,
) -> List[Dict[str, Any]]:
    """Pull recent CDP recorder rows (status + truncated bodies) when available."""
    if network_recorder is None:
        return []
    query = getattr(network_recorder, "query_requests", None)
    if not callable(query):
        return []
    try:
        rows = query(
            limit=limit,
            include_bodies=True,
            max_body_chars=max_body_chars,
        )
    except Exception as exc:
        logger.warning("Challenge classifier network recorder query failed", error=str(exc))
        return []
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


async def capture_network_summary(
    page: Any,
    *,
    network_recorder: Any = None,
    network_entries: Sequence[Dict[str, Any]] | None = None,
) -> str:
    """Build classifier network summary with HTTP status when available.

    Preference order:
    1. Explicit ``network_entries`` (e.g. Playwright responses collected during goto)
    2. Live ``BrowserNetworkRecorder.query_requests`` (status + truncated bodies)
    3. Performance Resource Timing fallback (may omit status — probes without CDP)
    """
    if network_entries:
        return format_network_summary_lines(list(network_entries)[-_NETWORK_ENTRY_CAP:])

    recorder_rows = network_entries_from_recorder(network_recorder)
    if recorder_rows:
        return format_network_summary_lines(recorder_rows)

    try:
        entries = await page.evaluate(
            """(cap) => {
              const resources = performance.getEntriesByType('resource');
              return resources.slice(-cap).map((entry) => {
                const row = {
                  name: String(entry.name || '').slice(0, 180),
                  durationMs: Math.round(entry.duration || 0),
                  transferSize: Number(entry.transferSize || 0),
                };
                // Some runtimes expose responseStatus on resource timing.
                if (typeof entry.responseStatus === 'number' && entry.responseStatus > 0) {
                  row.status = entry.responseStatus;
                }
                return row;
              });
            }""",
            _NETWORK_ENTRY_CAP,
        )
        if not isinstance(entries, list) or not entries:
            return "(no resource timings)"
        normalized: List[Dict[str, Any]] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            row = {
                "url": entry.get("name") or entry.get("url"),
                "duration_ms": entry.get("durationMs"),
                "size_bytes": entry.get("transferSize"),
            }
            if entry.get("status") is not None:
                row["status"] = entry.get("status")
            if entry.get("statusText") is not None:
                row["status_text"] = entry.get("statusText")
            # Tests / CDP-backed evaluate may pass status on the raw entry.
            if "status" in entry and row.get("status") is None:
                row["status"] = entry.get("status")
            if entry.get("response_body") is not None:
                row["response_body"] = entry.get("response_body")
                row["response_body_truncated"] = bool(entry.get("response_body_truncated"))
            normalized.append(row)
        return format_network_summary_lines(normalized)
    except Exception:
        return "(network metadata unavailable)"


def recovery_soft_block_still_present(
    network_summary: str,
    recovery_reason: str | None,
) -> bool:
    """Deterministic gate: cited soft-block still visible in network summary."""
    reason = (recovery_reason or "").lower()
    summary = (network_summary or "").lower()
    if not reason or not summary:
        return False
    reason_mentions_soft_block = any(
        token in reason
        for token in (
            "429",
            "rate limit",
            "rate-limit",
            "ratelimit",
            "provisioned",
            "graphql",
            "too many requests",
            "offers loading",
            "soft-block",
            "soft block",
        )
    )
    if not reason_mentions_soft_block:
        return False
    return (
        "status=429" in summary
        or "too many requests" in summary
        or "provisioned request rate" in summary
    )


_CITED_BLOCKED_RESOURCE_RE = re.compile(
    r"Blocked third-party resource that must become reachable/usable:\s*(\S+)",
    re.IGNORECASE,
)


def extract_cited_blocked_resource_url(recovery_reason: str | None) -> str | None:
    """Parse the folded blocked-resource URL from a recovery reason (backend parity)."""
    reason = str(recovery_reason or "")
    match = _CITED_BLOCKED_RESOURCE_RE.search(reason)
    if not match:
        return None
    raw = match.group(1).strip().rstrip(".,;)")
    try:
        parsed = urlparse(raw)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return None
        return raw
    except Exception:
        return None


def cited_blocked_resource_uncleared(
    network_summary: str,
    recovery_reason: str | None,
) -> bool:
    """Fail closed when a cited payment/CDN URL is still missing or failing.

    Matches the backend hard-gate: UI-looking-fine with the cited third-party
    resource absent/failing must stay challenged (the LLM sometimes ignores
    the system-prompt rule when the screenshot looks like the real site).
    """
    cited = extract_cited_blocked_resource_url(recovery_reason)
    if not cited:
        return False
    summary = network_summary or ""
    if not summary.strip():
        return True
    try:
        parsed = urlparse(cited)
        host = (parsed.hostname or "").lower()
        path = parsed.path or ""
    except Exception:
        return True
    if not host:
        return True
    saw_host = False
    saw_success = False
    saw_failure = False
    failure_re = re.compile(
        r"err[_:]|blocked|orb|failed|status=0\b|status=4\d\d|status=5\d\d|\b4\d\d\b|\b5\d\d\b"
    )
    success_re = re.compile(r"status=2\d\d|\b2\d\d\s*ok\b|\b200\b")
    for line in summary.splitlines():
        lower = line.lower()
        if host not in lower:
            continue
        saw_host = True
        if failure_re.search(lower):
            saw_failure = True
            continue
        if success_re.search(lower):
            if not path or path == "/" or path.lower() in lower or host in lower:
                saw_success = True
    if saw_failure and not saw_success:
        return True
    if not saw_host:
        return True
    if not saw_success:
        return True
    return False


async def capture_challenge_classifier_context(
    page: Any,
    response: Any = None,
    *,
    agent_dom_tree: str | None = None,
    network_recorder: Any = None,
    network_entries: Sequence[Dict[str, Any]] | None = None,
    recovery_reason: str | None = None,
) -> Dict[str, Any]:
    title_task = page.title()
    if isinstance(agent_dom_tree, str) and agent_dom_tree.strip():
        fixed_dom = agent_dom_tree.strip()[:_DOM_CHAR_CAP]

        async def _fixed_dom() -> str:
            return fixed_dom

        cleaned_task = _fixed_dom()
    else:
        cleaned_task = capture_agent_stripped_dom(page)
    network_task = capture_network_summary(
        page,
        network_recorder=network_recorder,
        network_entries=network_entries,
    )
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
        "recovery_reason": (recovery_reason or "").strip() or None,
    }


def build_challenge_classifier_messages(context: Dict[str, Any]) -> List[Dict[str, Any]]:
    recovery_reason = context.get("recovery_reason")
    recovery_lines: List[str] = []
    if recovery_reason:
        recovery_lines = [
            f"Agent recover_from_challenge reason: {recovery_reason}",
            (
                "Return challenged=false only if this specific failure mode is cleared "
                "in DOM + network evidence (not merely because the HTML shell looks fine)."
            ),
            "",
        ]
    text_block = "\n".join(
        [
            f"Target URL: {context.get('url') or ''}",
            f"Document title: {context.get('title') or '(empty)'}",
            f"Last main-document HTTP status: {context.get('status') if context.get('status') is not None else '(unknown)'}",
            "",
            *recovery_lines,
            "Network metadata (recent requests; includes HTTP status when known; "
            "response bodies are truncated and labeled when truncated):",
            context.get("network_summary") or "(none)",
            "",
            "DOM tree (same stripped page text the browser agent uses; scripts/styles removed):",
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

    recovery_reason = (
        context.get("recovery_reason")
        if isinstance(context.get("recovery_reason"), str)
        else None
    )
    network_summary = str(context.get("network_summary") or "")
    if recovery_soft_block_still_present(network_summary, recovery_reason):
        logger.info(
            "Challenge LLM classifier forced challenged — recovery soft-block still in network",
            url=str(context.get("url") or "")[:200],
            recovery_reason=str(recovery_reason or "")[:200],
            agent_id=agent_id,
        )
        return {
            "challenged": True,
            "reason": (
                "recovery_reason soft-block still present in network summary "
                "(HTTP 429 / rate-limit evidence uncleared)"
            ),
            "usage": empty_classifier_usage(),
        }
    if cited_blocked_resource_uncleared(network_summary, recovery_reason):
        cited = extract_cited_blocked_resource_url(recovery_reason)
        logger.info(
            "Challenge LLM classifier forced challenged — cited blocked resource uncleared",
            url=str(context.get("url") or "")[:200],
            cited_blocked_resource=cited,
            recovery_reason=str(recovery_reason or "")[:200],
            agent_id=agent_id,
        )
        return {
            "challenged": True,
            "reason": (
                "cited blocked third-party resource still missing or failing in "
                f"network evidence: {cited}"
            ),
            "usage": empty_classifier_usage(),
        }

    usage_out = empty_classifier_usage()
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
        parsed = ChallengePageClassification.model_validate_json(content)
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
            "usage": usage_out,
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
    agent_dom_tree: str | None = None,
    network_recorder: Any = None,
    network_entries: Sequence[Dict[str, Any]] | None = None,
    recovery_reason: str | None = None,
) -> Dict[str, Any]:
    """Settle DOM, capture context, run binary LLM classifier.

    Returns ``{clean, reason, title, usage}``. When ``usage_collector`` is
    provided, appends the usage dict for the caller to fold into cost tracking.
    """
    await wait_for_dom_settled(page, settle_timeout_ms)
    context = await capture_challenge_classifier_context(
        page,
        response,
        agent_dom_tree=agent_dom_tree,
        network_recorder=network_recorder,
        network_entries=network_entries,
        recovery_reason=recovery_reason,
    )
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
