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
import json
import re
from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import urlparse

import structlog
from pydantic import BaseModel, Field

from domains.spawn_browser_agent_v3.challenge_urls import urls_cited_in_recovery_reason

logger = structlog.get_logger()

CHALLENGE_LLM_MODEL = "rose-labs/rose-1-mini"
CHALLENGE_LLM_SETTLE_MS = 60_000
CHALLENGE_LLM_CALL_SITE = "challenge_llm_classifier"
_DOM_CHAR_CAP = 12_000
_NETWORK_ENTRY_CAP = 40
_NETWORK_BODY_CHAR_CAP = 200
_NETWORK_SUMMARY_CHAR_CAP = 4_000

_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", re.IGNORECASE)
_JSON_OBJECT_RE = re.compile(r"\{[\s\S]*\}")

CHALLENGE_LLM_SYSTEM_PROMPT = """You are a binary page-state classifier for a browser agent.

Decide whether the CURRENT page is still blocked by an anti-bot challenge (CAPTCHA, bot check, access denied, blank soft-wall, rate-limit interstitial, "checking your browser", vendor challenge widget, empty shell that is not the real site UI) OR whether the real destination page is usable.

Return challenged=true when:
- A challenge / CAPTCHA / human-verification interstitial is visible or dominating the page
- The document is an empty/blank soft-wall, error gateway, or host-only shell without the real product UI
- Navigation failed into a block page even if some marketing text leaked into the DOM
- Network metadata still shows the soft-block described in the agent recovery reason (e.g. HTTP 429 / rate-limit on GraphQL or product APIs) even if the HTML shell looks fine
- The agent recovery reason is uncleared (product content still Loading, offers missing, cited endpoint still failing)

Return challenged=false ONLY when:
- The real destination site UI for the target URL is visibly present and usable (navigation, primary content, interactive controls for the task)
- AND if an agent recovery reason is provided, that specific failure mode is cleared (network + DOM evidence)

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


def _parse_challenge_classification(content: str) -> ChallengePageClassification:
    """Parse classifier JSON, tolerating markdown fences and leading prose."""
    text = (content or "").strip()
    if not text:
        raise ValueError("empty classifier response")

    candidates = [text]
    fence_match = _JSON_FENCE_RE.search(text)
    if fence_match:
        candidates.insert(0, fence_match.group(1).strip())
    for match in _JSON_OBJECT_RE.finditer(text):
        candidates.append(match.group(0).strip())

    seen: set[str] = set()
    last_error: Exception | None = None
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            return ChallengePageClassification.model_validate_json(candidate)
        except Exception as exc:
            last_error = exc
            try:
                payload = json.loads(candidate)
            except Exception:
                continue
            if isinstance(payload, dict) and "challenged" in payload:
                return ChallengePageClassification.model_validate(payload)

    lowered = text.lower()
    if '"challenged": false' in lowered or "'challenged': false" in lowered:
        return ChallengePageClassification(
            challenged=False, reason="parsed from partial classifier text"
        )
    if '"challenged": true' in lowered or "'challenged': true" in lowered:
        return ChallengePageClassification(
            challenged=True, reason="parsed from partial classifier text"
        )

    raise ValueError(f"unable to parse classifier JSON: {last_error}")


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


def cited_network_hosts(recovery_reason: str | None) -> tuple[str, ...]:
    hosts: List[str] = []
    seen: set[str] = set()
    for url in urls_cited_in_recovery_reason(recovery_reason):
        host = (urlparse(url).hostname or "").lower()
        if not host or host in seen:
            continue
        seen.add(host)
        hosts.append(host)
    return tuple(hosts)


def _entry_matches_cited(
    entry: Dict[str, Any],
    cited_urls: Sequence[str],
    cited_hosts: Sequence[str],
) -> bool:
    url = str(entry.get("url") or entry.get("name") or "").lower()
    if not url:
        return False
    for host in cited_hosts:
        if host in url:
            return True
    for cited in cited_urls:
        needle = str(cited).lower()
        if needle in url or url in needle:
            return True
    return False


def select_network_entries_for_classifier(
    entries: Sequence[Dict[str, Any]],
    *,
    recovery_reason: str | None = None,
    cap: int = _NETWORK_ENTRY_CAP,
) -> List[Dict[str, Any]]:
    """Prefer network rows that match hosts/URLs cited in the recovery reason."""
    if not entries:
        return []
    cited_urls = urls_cited_in_recovery_reason(recovery_reason)
    cited_host_list = cited_network_hosts(recovery_reason)
    pinned: List[Dict[str, Any]] = []
    rest: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        key = str(entry.get("url") or entry.get("name") or "").lower()
        if not key or key in seen:
            continue
        seen.add(key)
        if _entry_matches_cited(entry, cited_urls, cited_host_list):
            pinned.append(entry)
        else:
            rest.append(entry)
    return (pinned + rest)[: max(1, int(cap))]


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
    recovery_reason: str | None = None,
) -> List[Dict[str, Any]]:
    """Pull recent CDP recorder rows (status + truncated bodies) when available."""
    if network_recorder is None:
        return []
    query = getattr(network_recorder, "query_requests", None)
    if not callable(query):
        return []
    try:
        rows = query(
            limit=max(limit * 2, limit),
            include_bodies=True,
            max_body_chars=max_body_chars,
        )
    except Exception as exc:
        logger.warning("Challenge classifier network recorder query failed", error=str(exc))
        return []
    if not isinstance(rows, list):
        return []
    typed = [row for row in rows if isinstance(row, dict)]
    return select_network_entries_for_classifier(
        typed, recovery_reason=recovery_reason, cap=limit
    )


async def capture_network_summary(
    page: Any,
    *,
    network_recorder: Any = None,
    network_entries: Sequence[Dict[str, Any]] | None = None,
    recovery_reason: str | None = None,
) -> str:
    """Build classifier network summary with HTTP status when available.

    Preference order:
    1. Explicit ``network_entries`` (e.g. Playwright responses collected during goto)
    2. Live ``BrowserNetworkRecorder.query_requests`` (status + truncated bodies)
    3. Performance Resource Timing fallback (may omit status - probes without CDP)
    """
    if network_entries:
        return format_network_summary_lines(
            select_network_entries_for_classifier(
                list(network_entries),
                recovery_reason=recovery_reason,
            )
        )

    recorder_rows = network_entries_from_recorder(
        network_recorder,
        recovery_reason=recovery_reason,
    )
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
            max(_NETWORK_ENTRY_CAP * 2, _NETWORK_ENTRY_CAP),
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
        return format_network_summary_lines(
            select_network_entries_for_classifier(
                normalized,
                recovery_reason=recovery_reason,
            )
        )
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


CHALLENGE_CONTEXT_READ_SECONDS = 10.0


async def _gather_within(awaitables: Sequence[Any], timeout: float) -> List[Any]:
    """Like gather(return_exceptions=True), but returns by ``timeout`` even if a read
    never answers or holds its cancellation; such reads come back as TimeoutError."""
    tasks = [asyncio.ensure_future(item) for item in awaitables]
    done, pending = await asyncio.wait(tasks, timeout=timeout)
    for task in pending:
        task.cancel()
        task.add_done_callback(lambda finished: finished.cancelled() or finished.exception())
    results: List[Any] = []
    for task in tasks:
        if task not in done:
            results.append(asyncio.TimeoutError(f"challenge context read did not answer within {timeout:g}s"))
        elif task.cancelled():
            results.append(asyncio.CancelledError())
        else:
            results.append(task.exception() or task.result())
    return results


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
        recovery_reason=recovery_reason,
    )
    # Each read is bounded: a renderer busy on challenge JS never answers
    # Runtime.evaluate / Page.captureScreenshot (T83), and an unbounded read held
    # the challenge patience wait 15 min (kokkari 0addd068). A read that does not
    # answer is left behind; the classifier runs on what did answer.
    title, cleaned_dom, network_summary = await _gather_within(
        (title_task, cleaned_task, network_task), CHALLENGE_CONTEXT_READ_SECONDS
    )
    title_s = title if isinstance(title, str) else ""
    cleaned_s = cleaned_dom if isinstance(cleaned_dom, str) else ""
    network_s = network_summary if isinstance(network_summary, str) else "(network metadata unavailable)"
    screenshot_b64: Optional[str] = None
    try:
        raw = await page.screenshot(type="png", full_page=False, timeout=CHALLENGE_CONTEXT_READ_SECONDS * 1000)
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

    if recovery_soft_block_still_present(
        str(context.get("network_summary") or ""),
        context.get("recovery_reason") if isinstance(context.get("recovery_reason"), str) else None,
    ):
        logger.info(
            "Challenge LLM classifier forced challenged — recovery soft-block still in network",
            url=str(context.get("url") or "")[:200],
            recovery_reason=str(context.get("recovery_reason") or "")[:200],
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
        parsed = _parse_challenge_classification(content)
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
