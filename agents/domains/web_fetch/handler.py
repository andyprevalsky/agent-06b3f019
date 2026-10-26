"""Web fetch domain handler — tool entry point and Temporal activities.

Three-activity flow (kept separate so claude/gpt token rotation signals can
flow through the workflow rather than being swallowed inside one combined
activity):

  1. ``web_fetch_activity``           — Firecrawl scrape, returns
                                        ``{markdown, links, metadata}``.
  2. ``summarize_and_filter_links``    — Haiku call (structured output via
                                        Pydantic ``WebFetchHaikuResponse``);
                                        returns ``{summary, files_to_download}``.
  3. ``web_fetch_download_activity``   — download Haiku-curated file URLs,
                                        upload to Supabase, return file
                                        pointers.

Mirrors Claude Code's WebFetchTool pattern (small fast model on top of a
fetch). PDFs and other binary files are downloaded as bytes, not inline-
extracted by Firecrawl's ``parsers`` option — agents expect file_pointer
attachments, not inlined text.
"""

import time
from datetime import timedelta
from typing import Any, Dict, List, Optional

import structlog
from temporalio import activity
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError

from domains.web_fetch.config import FIRECRAWL_COST_CENTS, MAX_MARKDOWN_LENGTH, PARALLEL_EXTRACT_COST_CENTS
from domains.web_fetch.service import (
    WebFetchProvidersFailed,
    assert_fetchable_url,
    download_and_attach,
    scrape_url,
)
from domains.web_fetch.types import ExecuteActivityCallable
from helpers.handle_tool_event import handle_tool_event
from helpers.summarize import select_page_metadata, summarize_and_filter_links
from helpers.tracing import traced
from helpers.world_model_runtime import (
    WorldModelToolExecutionAdapter,
    wmh_fallback_on_unavailable_enabled,
    wmh_result_unavailable,
)
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager, format_error_message, format_tool_message


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


logger = structlog.get_logger()
DEMO_CACHE_HIT_FIELD = "_fast_cache_hit"


def _truncate_display(value: str, max_len: int = 100) -> str:
    if len(value) <= max_len:
        return value
    return value[: max_len - 3] + "..."


def _format_fetch_title(prefix: str, url: str, objective: str) -> str:
    display_url = _truncate_display(url, 80) if url else "URL"
    display_objective = _truncate_display(objective, 70)
    if display_objective:
        return f"{prefix} {display_url} for {display_objective}"
    return f"{prefix} {display_url}"


def _format_attachment_note(file_pointers: List[Dict[str, Any]]) -> str:
    """Mirror Claude Code's '[Binary content (mime, size) also saved to {path}]' note.

    Appended to the Haiku summary so the parent agent sees the file_pointers
    inline in the conversation and can pass `attachments=[original_filename]`
    when spawning a sub-agent.
    """
    if not file_pointers:
        return ""
    lines = ["[Downloaded {} file(s):".format(len(file_pointers))]
    for fp in file_pointers:
        name = fp.get("original_filename") or fp.get("filename") or "file"
        mime = fp.get("mime_type") or "application/octet-stream"
        size = fp.get("size_bytes")
        size_str = f", {size} bytes" if isinstance(size, int) else ""
        lines.append(f" - {name} ({mime}{size_str})")
    lines[-1] += "]"
    return "\n\n" + "\n".join(lines)


class WebFetchManager(ToolManager):
    """Manager for the web_fetch tool: Firecrawl scrape + Haiku filter + file download."""

    tool_name = "web_fetch"
    read_only = True  # Research-phase tool

    async def execute_tool(
        self,
        execute_activity: ExecuteActivityCallable,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        agent_id: str,
        user_id: Optional[str] = None,
        claude_token: Optional[str] = None,
        claude_token_source: Optional[str] = None,
        claude_token_pool_id: Optional[str] = None,
        gpt_token: Optional[str] = None,
        gpt_account_id: Optional[str] = None,
        gpt_token_source: Optional[str] = None,
        gpt_token_pool_id: Optional[str] = None,
        fast_mode_cache_enabled: bool = False,
        fast_mode_goal: Optional[str] = None,
        fast_mode_cache_write_enabled: bool = False,
        world_model_mode: str = "real",
        compute_token_lineage_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute web fetch and post events via handle_tool_event."""
        url = tool_call.get("url", "")
        objective = tool_call.get("objective", "")

        start_time = _safe_time()
        display_objective = _truncate_display(objective)
        progress_title = _format_fetch_title("Fetching", url, objective)
        completed_title = _format_fetch_title("Fetched", url, objective)
        failed_title = _format_fetch_title("\u274c Web fetch failed for", url, objective)

        # Pre-execution status
        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=progress_title,
                message=f"Extracting from {url}: {display_objective}",
                status=MessageStatus.IN_PROGRESS,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="web_fetch",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        try:
            # Reject non-fetchable URLs at the tool boundary, before scheduling
            # the scrape activity (Firecrawl + Parallel Extract), the Haiku
            # summarize call, or the download activity. Raises a non-retryable
            # ApplicationError so the agent sees a real tool error.
            assert_fetchable_url(url)

            logger.info("Calling web_fetch_activity", url=url, objective_len=len(objective))

            # 1) Firecrawl scrape (DEMO caches the scrape by normalized URL)
            scrape_args = [
                url,
                fast_mode_cache_enabled,
                fast_mode_goal,
                fast_mode_cache_write_enabled,
            ]
            if world_model_mode != "real":
                scrape_args.extend([agent_id, world_model_mode])
            else:
                scrape_args.extend([None, None])
            # The cache write gate resolves this agent's tree root (a child under
            # a frozen DEMO root never writes) without changing world-model routing.
            scrape_args.append(agent_id)
            scrape_result = await execute_activity(
                web_fetch_activity,
                args=scrape_args,
                start_to_close_timeout=timedelta(seconds=180),
                retry_policy=RetryPolicy(
                    maximum_attempts=2,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10),
                ),
            )
            markdown: str = scrape_result.get("markdown", "") if isinstance(scrape_result, dict) else ""
            links: List[str] = scrape_result.get("links", []) if isinstance(scrape_result, dict) else []
            scrape_metadata: Dict[str, Any] = (
                scrape_result.get("metadata", {}) if isinstance(scrape_result, dict) else {}
            )
            scrape_cache_hit = isinstance(scrape_result, dict) and bool(scrape_result.get(DEMO_CACHE_HIT_FIELD))
            scrape_simulated = isinstance(scrape_result, dict) and bool(scrape_result.get("world_model_simulated"))
            service_provider = scrape_metadata.get("provider") or "Firecrawl scrape"
            service_cost_cents = (
                0
                if scrape_cache_hit or scrape_simulated
                else (PARALLEL_EXTRACT_COST_CENTS if service_provider == "Parallel Extract" else FIRECRAWL_COST_CENTS)
            )

            # 2) Haiku filter — structured output via WebFetchHaikuResponse
            haiku_result = await execute_activity(
                summarize_and_filter_links,
                args=[
                    url,
                    objective,
                    markdown,
                    links,
                    MAX_MARKDOWN_LENGTH,
                    "rose-labs/rose-1-mini",
                    claude_token,
                    claude_token_source,
                    claude_token_pool_id,
                    user_id,  # claude_token_user_id
                    gpt_token,
                    gpt_account_id,
                    gpt_token_source,
                    gpt_token_pool_id,
                    user_id,  # gpt_token_user_id
                    agent_id,
                    f"agent:{agent_id}:tool:{tool_call_id}:call:summarize_web_fetch",
                    compute_token_lineage_key,
                    # Allowlisted head-only facts (title, publication and
                    # modified dates) that main-content markdown can drop.
                    select_page_metadata(scrape_metadata),
                ],
                start_to_close_timeout=timedelta(seconds=90),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            summary_text: str = haiku_result.get("summary", "") if isinstance(haiku_result, dict) else ""
            files_to_download: List[str] = (
                haiku_result.get("files_to_download", []) if isinstance(haiku_result, dict) else []
            )

            # 3) Download Haiku-curated files (no-op when list is empty)
            file_pointers: List[Dict[str, Any]] = []
            if files_to_download:
                download_args = [
                    files_to_download,
                    user_id,
                    fast_mode_cache_enabled,
                    fast_mode_goal,
                    fast_mode_cache_write_enabled,
                ]
                if world_model_mode != "real":
                    download_args.extend([agent_id, world_model_mode])
                else:
                    download_args.extend([None, None])
                download_args.append(agent_id)
                file_pointers = await execute_activity(
                    web_fetch_download_activity,
                    args=download_args,
                    start_to_close_timeout=timedelta(seconds=180),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )

            # Assemble the tool-message body. Append the attachment note
            # (Claude Code pattern) so the agent sees the files inline.
            content_text = summary_text + _format_attachment_note(file_pointers)
            result: Dict[str, Any] = {
                "content": content_text,
                "url": url,
                "objective": objective,
                "summarized": haiku_result.get("summarized", False) if isinstance(haiku_result, dict) else False,
                "downloaded_files": file_pointers,
                "links_discovered": len(links),
                "links_downloaded": len(file_pointers),
            }

            # Cost-accounting LLM item for the Haiku call.
            haiku_usage: Optional[Dict[str, Any]] = (
                haiku_result.get("usage") if isinstance(haiku_result, dict) else None
            )
            summarizer_llm_item: Optional[Dict[str, Any]] = None
            if isinstance(haiku_usage, dict) and haiku_usage:
                summarizer_llm_item = {
                    "tokens_in": haiku_usage.get("prompt_tokens", 0),
                    "tokens_out": haiku_usage.get("completion_tokens", 0),
                    "model": haiku_usage.get("actual_model", "rose-labs/rose-1-flash"),
                    "provider": "Rose (summarize_web_fetch)",
                    "cache_read_input_tokens": haiku_usage.get("cache_read_input_tokens", 0),
                    "cache_creation_input_tokens": haiku_usage.get("cache_creation_input_tokens", 0),
                    # Propagate demo-cache replay so the workflow cost aggregator
                    # zeroes a replayed summarize call instead of billing the
                    # replayed output tokens (mirrors the planner fix).
                    "from_fast_cache": haiku_usage.get("from_fast_cache", False),
                    "cache_sequence_id": haiku_usage.get("cache_sequence_id"),
                }

            elapsed_time = _safe_time() - start_time

            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=service_cost_cents,
            )

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=completed_title,
                    message=message,
                    status=MessageStatus.FINISHED,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="web_fetch",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            usage_dict: Dict[str, Any] = {
                "llm": [summarizer_llm_item] if summarizer_llm_item else [],
                "service": []
                if scrape_cache_hit or scrape_simulated
                else [{"cost_cents": service_cost_cents, "provider": service_provider}],
            }
            # Surface raw Haiku usage so the workflow can route claude_token_error /
            # claude_token_rotated / compute_token_used signals through _on_tokens
            # for pool-token rotation.
            return {
                "result": result,
                "usage": usage_dict,
                "summarizer_rotation_signal": haiku_usage,
            }

        except Exception as e:
            elapsed_time = _safe_time() - start_time

            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=0,
            )

            await handle_tool_event(
                event=ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=failed_title,
                    message=error_message,
                    status=MessageStatus.ERROR,
                ),
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="web_fetch",
                execute_activity=execute_activity,
                user_id=user_id,
            )

            raise


# ── Singleton ──

_manager: Optional[WebFetchManager] = None


def get_manager() -> WebFetchManager:
    """Get or create web fetch manager singleton."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = WebFetchManager()
    return _manager


# ── Tool entry point ──


async def web_fetch(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
    claude_token: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    fast_mode_cache_enabled: bool = False,
    fast_mode_goal: Optional[str] = None,
    fast_mode_cache_write_enabled: bool = False,
    world_model_mode: str = "real",
    compute_token_lineage_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute web fetch tool."""
    manager = get_manager()
    return await manager.execute_tool(
        execute_activity=execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=agent_id,
        user_id=user_id,
        claude_token=claude_token,
        claude_token_source=claude_token_source,
        claude_token_pool_id=claude_token_pool_id,
        gpt_token=gpt_token,
        gpt_account_id=gpt_account_id,
        gpt_token_source=gpt_token_source,
        gpt_token_pool_id=gpt_token_pool_id,
        fast_mode_cache_enabled=fast_mode_cache_enabled,
        fast_mode_goal=fast_mode_goal,
        fast_mode_cache_write_enabled=fast_mode_cache_write_enabled,
        world_model_mode=world_model_mode,
        compute_token_lineage_key=compute_token_lineage_key,
    )


# A DEMO web_fetch row holding this field records a scrape that failed; its
# value is the WebFetchProvidersFailed message the agent saw.
CACHED_PROVIDER_ERROR_FIELD = "provider_error"


# ── Temporal activities ──


@activity.defn
@traced("web_fetch_activity")
async def web_fetch_activity(
    url: str,
    fast_mode_cache_enabled: bool = False,
    fast_mode_goal: Optional[str] = None,
    fast_mode_cache_write_enabled: bool = False,
    agent_id: Optional[str] = None,
    world_model_mode: Optional[str] = None,
    demo_cache_agent_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Activity: Firecrawl scrape (JS rendering, main-content extraction).

    Returns ``{markdown, links, metadata}``. Raises on Firecrawl HTTP errors —
    the caller surfaces the error to the agent rather than silently degrading.

    Fast Mode: when read-enabled, the scrape is replayed by normalized URL.
    Allowlisted write-through mode stores live Firecrawl responses without first
    reading from cache.
    """
    from providers.demo_cache import client as demo_cache_client
    from providers.demo_cache import normalize as demo_cache_normalize

    read_cache = fast_mode_cache_enabled and bool(fast_mode_goal)
    write_cache = (fast_mode_cache_enabled or fast_mode_cache_write_enabled) and bool(fast_mode_goal)
    cache_key = demo_cache_normalize.web_fetch_key(fast_mode_goal, url) if write_cache else None
    if cache_key is not None and read_cache:
        stored = await demo_cache_client.cache_get(cache_key)
        if isinstance(stored, dict) and CACHED_PROVIDER_ERROR_FIELD in stored:
            # A recorded failed fetch replays as the same tool error, not a live retry.
            logger.info("demo_cache.web_fetch_error_hit", key=cache_key, url=url)
            raise ApplicationError(
                str(stored[CACHED_PROVIDER_ERROR_FIELD]), type="WebFetchProvidersFailed", non_retryable=True
            )
        if stored is not None:
            if wmh_fallback_on_unavailable_enabled() and wmh_result_unavailable(stored):
                logger.info("demo_cache.web_fetch_unavailable_ignored", key=cache_key, url=url)
            else:
                logger.info("demo_cache.web_fetch_hit", key=cache_key, url=url)
                if isinstance(stored, dict):
                    return {**stored, DEMO_CACHE_HIT_FIELD: True}
                return stored
        if stored is None:
            # Fast Mode read miss: soft-complete instead of live Firecrawl /
            # Parallel Extract. Restricted to exact-match demo_cache:on benches.
            if not await demo_cache_client.soft_complete_allowed_for_agent(agent_id, fast_mode_goal):
                logger.info(
                    "demo_cache.web_fetch_miss_live",
                    key=cache_key,
                    url=url[:120],
                    reason="soft_complete_not_allowlisted",
                )
            else:
                logger.info("demo_cache.web_fetch_soft_complete", key=cache_key, url=url[:120])
                return {
                    "markdown": ("Fast Mode cache miss for this web fetch. Returning without a live scrape."),
                    "links": [],
                    "metadata": {"provider": "fast-mode-soft-complete"},
                    DEMO_CACHE_HIT_FIELD: True,
                }
    elif cache_key is not None:
        logger.info("demo_cache.web_fetch_write_only", key=cache_key, url=url)

    async def real_executor(_tool_name: str, _tool_args: Dict[str, Any], _tool_call_id: str) -> Dict[str, Any]:
        return await scrape_url(url)

    try:
        result = await WorldModelToolExecutionAdapter.from_env(
            agent_id=agent_id,
            mode=world_model_mode,
        ).execute(
            "web_fetch",
            {"url": url},
            "web_fetch_activity",
            real_executor,
            allow_real_fallback=world_model_mode is None,
        )
    except WebFetchProvidersFailed as e:
        logger.error("Web fetch scrape failed", error=str(e), url=url, retryable=e.retryable)
        if not e.retryable:
            raise ApplicationError(str(e), type="WebFetchProvidersFailed", non_retryable=True) from e
        raise
    except Exception as e:
        logger.error("Web fetch scrape failed", error=str(e), url=url)
        raise

    # A frozen DEMO namespace (goal or tree root) gains no entries from a live miss.
    if (
        cache_key is not None
        and write_cache
        and await demo_cache_client.cache_write_allowed_for_agent(demo_cache_agent_id or agent_id, fast_mode_goal)
    ):
        await demo_cache_client.cache_set(
            cache_key, "web_fetch", demo_cache_normalize.goal_hash(fast_mode_goal), result, goal=fast_mode_goal
        )
        logger.info("demo_cache.web_fetch_stored", key=cache_key, url=url)
    return result


@activity.defn
@traced("web_fetch_download_activity")
async def web_fetch_download_activity(
    file_urls: List[str],
    user_id: Optional[str] = None,
    fast_mode_cache_enabled: bool = False,
    fast_mode_goal: Optional[str] = None,
    fast_mode_cache_write_enabled: bool = False,
    agent_id: Optional[str] = None,
    world_model_mode: Optional[str] = None,
    demo_cache_agent_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Activity: download Haiku-curated file URLs and upload to Supabase storage.

    Returns file_pointer dicts. Best-effort — individual download failures are
    logged and skipped, not raised.
    """

    async def real_executor(
        _tool_name: str,
        _tool_args: Dict[str, Any],
        _tool_call_id: str,
    ) -> Dict[str, Any]:
        files = await download_and_attach(
            file_urls=file_urls,
            user_id=user_id,
            fast_mode_cache_enabled=fast_mode_cache_enabled,
            fast_mode_goal=fast_mode_goal,
            fast_mode_cache_write_enabled=fast_mode_cache_write_enabled,
            agent_id=demo_cache_agent_id or agent_id,
        )
        return {"files": files}

    result = await WorldModelToolExecutionAdapter.from_env(
        agent_id=agent_id,
        mode=world_model_mode,
    ).execute(
        "web_fetch_download",
        {"file_urls": file_urls, "user_id": user_id},
        "web_fetch_download_activity",
        real_executor,
        allow_real_fallback=world_model_mode is None,
    )
    files = result.get("files") if isinstance(result, dict) else None
    return files if isinstance(files, list) else []
