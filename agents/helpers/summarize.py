"""Tool for compressing agent context and generating completion summaries."""

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import structlog
from pydantic import BaseModel, Field
from temporalio import activity

logger = structlog.get_logger()


class WebFetchHaikuResponse(BaseModel):
    """Structured output for the web_fetch Haiku filter pass.

    Returned by ``summarize_and_filter_links`` — one Haiku call that does two
    jobs: (1) produce an objective-focused summary of the page markdown, and
    (2) select which discovered links the caller should actually download.
    """

    summary: str = Field(
        description=(
            "Objective-focused summary of the page (target 1500 tokens, "
            "hard cap 2000). Preserve direct quotes, statistics, dates, "
            "names, URLs, and identifiers relevant to the objective. "
            "Start with the source URL and page title. Omit nav, ads, "
            "related-articles, and boilerplate."
        )
    )
    files_to_download: List[str] = Field(
        default_factory=list,
        description=(
            "URLs from the page's link inventory that the objective explicitly "
            "requires the caller to download. Empty list when no files are "
            "needed. Do NOT download arbitrary files just because they exist."
        ),
    )

# Number of trailing TOOL/ASSISTANT messages kept verbatim in head/tail-protected
# compaction. Matches Hermes `trajectory_compressor.py:482-528`.
HEAD_TAIL_PROTECTED_TURNS = 4

# Threshold below which we skip compaction entirely — context is already small.
MIN_CONTEXT_LEN_FOR_COMPACTION = HEAD_TAIL_PROTECTED_TURNS + 2

COMPACTION_SUMMARY_PREFIX = "[CONTEXT SUMMARY]:"

# Per-tool summarizer threshold (chars). Hermes parity at web_tools.py:613-682.
TOOL_SUMMARIZER_CHAR_THRESHOLD = 5_000
# Hard cap when the LLM summarizer itself fails — matches OpenClaw default
# (firecrawl-client.ts:42).
TOOL_RESULT_HARD_CAP_CHARS = 50_000

# Tool name → Human-readable label mapping for summary display
TOOL_DISPLAY_NAMES = {
    "web_search": "Web Searches",
    "spawn_sub_agent": "Sub Agent Spawned",
    "spawn_browser_agent": "Browser Agents Spawned",
    "spawn_claude_code_agent": "Code Agents Spawned",
    "message_person": "Messages Sent",
    "send_message_to_user": "User Messages",
    "wait_for": "Wait Operations",
    "set_plan": "Plans Set",
}

# Tools to exclude from the summary (internal/meta tools)
# Note: verifier-feedback messages are now tagged as toolName="attempt_completion"
# but flagged with metadata.verifierMessage=True. We filter by that flag in
# _count_tool_usage so the verifier rows don't double-count attempt_completion.
EXCLUDED_TOOLS = {
    "completion_summary",
    "attempt_completion",
    "request_user_approval",
    "request_user_signup",
}


def _count_tool_usage(context: List[Dict[str, Any]]) -> Dict[str, int]:
    """
    Count tool usage from context messages.

    Only counts FINISHED tool messages to avoid double-counting
    IN_PROGRESS and FINISHED for the same tool call.

    Args:
        context: Full message history

    Returns:
        Dict mapping tool_name -> count
    """
    tool_counts: Dict[str, int] = {}
    for msg in context:
        if msg.get("role") == "TOOL":
            metadata = msg.get("metadata", {}) or {}
            # Verifier feedback is tagged toolName="attempt_completion" but has
            # verifierMessage=True. Skip those rows so they don't get counted
            # alongside real tool results.
            if metadata.get("verifierMessage"):
                continue
            tool_name = metadata.get("toolName")
            tool_status = metadata.get("toolStatus")
            if tool_name and tool_name not in EXCLUDED_TOOLS and tool_status == "FINISHED":
                tool_counts[tool_name] = tool_counts.get(tool_name, 0) + 1
    return tool_counts


def _merge_tool_counts(own_counts: Dict[str, int], sub_agent_counts: Dict[str, int]) -> Dict[str, int]:
    """
    Merge tool counts from this agent and sub-agents.

    Args:
        own_counts: Tool counts from this agent's context
        sub_agent_counts: Aggregated tool counts from sub-agents

    Returns:
        Merged dict with total counts per tool
    """
    merged = own_counts.copy()
    for tool_name, count in sub_agent_counts.items():
        merged[tool_name] = merged.get(tool_name, 0) + count
    return merged


def _format_tool_stats_footer(tool_counts: Dict[str, int]) -> str:
    """
    Format tool usage statistics as a markdown footer.

    Args:
        tool_counts: Dict mapping tool_name -> count

    Returns:
        Formatted markdown string
    """
    if not tool_counts:
        return ""

    total_calls = sum(tool_counts.values())
    footer = f"\n\n---\n### Tool Usage Statistics\n**Total:** {total_calls}\n\n"

    # Sort by count descending
    for tool_name, count in sorted(tool_counts.items(), key=lambda x: -x[1]):
        display_name = TOOL_DISPLAY_NAMES.get(tool_name, tool_name.replace("_", " ").title())
        footer += f"**{display_name}:** {count}\n"

    return footer


def _build_tool_pair_maps(
    context: List[Dict[str, Any]],
) -> Tuple[Dict[str, int], Dict[str, List[int]]]:
    """Map tool_call_id → ASSISTANT idx and tool_call_id → [TOOL idxs].

    Used by the head/tail compactor to keep ASSISTANT tool_use blocks paired
    with their TOOL result blocks. An orphan tool_use without its tool_result
    hard-errors at the Anthropic API boundary.
    """
    asst_by_id: Dict[str, int] = {}
    tools_by_id: Dict[str, List[int]] = {}
    for i, msg in enumerate(context):
        meta = msg.get("metadata") or {}
        role = msg.get("role")
        if role == "ASSISTANT":
            for tc in meta.get("tool_calls") or []:
                tc_id = tc.get("tool_call_id")
                if tc_id:
                    asst_by_id[str(tc_id)] = i
        elif role == "TOOL":
            tc_id = meta.get("toolCallId")
            if tc_id:
                tools_by_id.setdefault(str(tc_id), []).append(i)
    return asst_by_id, tools_by_id


def split_head_middle_tail(
    context: List[Dict[str, Any]],
    n_tail: int = HEAD_TAIL_PROTECTED_TURNS,
) -> Optional[Tuple[List[int], List[int], List[int]]]:
    """Pick (head, middle, tail) message indices for head/tail-protected compaction.

    Head: first SYSTEM message (if any) + first USER message (the goal).
    Tail: last `n_tail` messages of role TOOL/ASSISTANT/USER, expanded to
          preserve every ASSISTANT tool_use ↔ TOOL tool_result pair.
    Middle: everything else.

    Returns None when the context is already small enough that compaction
    would be pointless.
    """
    if len(context) < MIN_CONTEXT_LEN_FOR_COMPACTION:
        return None

    head_indices: List[int] = []
    seen_first_user = False
    for i, msg in enumerate(context):
        role = msg.get("role")
        if role == "SYSTEM" and not head_indices:
            head_indices.append(i)
        elif role == "USER" and not seen_first_user:
            head_indices.append(i)
            seen_first_user = True
            break

    head_set = set(head_indices)

    tail_indices: set[int] = set()
    count = 0
    for i in range(len(context) - 1, -1, -1):
        if i in head_set:
            break
        role = context[i].get("role")
        if role in ("USER", "ASSISTANT", "TOOL"):
            tail_indices.add(i)
            count += 1
            if count >= n_tail:
                break

    asst_by_id, tools_by_id = _build_tool_pair_maps(context)

    # Expand tail until every tool_use ↔ tool_result pair is fully inside
    # head ∪ tail (no orphans crossing the summary boundary).
    changed = True
    while changed:
        changed = False
        for idx in list(tail_indices):
            msg = context[idx]
            meta = msg.get("metadata") or {}
            role = msg.get("role")
            if role == "TOOL":
                tc_id = meta.get("toolCallId")
                if tc_id is not None:
                    a_idx = asst_by_id.get(str(tc_id))
                    if a_idx is not None and a_idx not in tail_indices and a_idx not in head_set:
                        tail_indices.add(a_idx)
                        changed = True
            elif role == "ASSISTANT":
                for tc in meta.get("tool_calls") or []:
                    tc_id = tc.get("tool_call_id")
                    if tc_id is None:
                        continue
                    for t_idx in tools_by_id.get(str(tc_id), []):
                        if t_idx not in tail_indices and t_idx not in head_set:
                            tail_indices.add(t_idx)
                            changed = True

    middle_indices = [i for i in range(len(context)) if i not in head_set and i not in tail_indices]
    if not middle_indices:
        return None

    return head_indices, middle_indices, sorted(tail_indices)


def _format_middle_for_prompt(context: List[Dict[str, Any]], middle_indices: List[int]) -> str:
    """Render middle messages as plain text for the summarizer LLM."""
    parts: List[str] = []
    for i in middle_indices:
        msg = context[i]
        role = msg.get("role", "unknown")
        text = msg.get("text", "")
        meta = msg.get("metadata") or {}
        tool_name = meta.get("toolName")
        prefix = f"[{role}]"
        if tool_name:
            prefix += f"[{tool_name}]"
        parts.append(f"{prefix} {text}")
    return "\n".join(parts)


@activity.defn
async def compress_context(
    context: List[Dict],
    iteration_count: int,
    model: str = "rose-labs/rose-1-lite",
    claude_token: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    claude_token_user_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
) -> Dict:
    """Head/tail-protected context compaction.

    Keeps first SYSTEM + first USER + last 4 turns verbatim. Replaces the
    middle range with one synthetic USER turn containing an LLM-generated
    summary. ASSISTANT.tool_calls and TOOL.toolCallId pairs that straddle
    the boundary are pulled into the tail so the Anthropic API never sees
    an orphan tool_use.

    Returns:
        Dict with:
          - context: new context list (head + synthetic summary USER + tail)
          - usage:   token usage from the summarizer call
          - success: True iff the LLM call returned non-empty text
        On any failure: {"context": None, "usage": {}, "success": False, "error": str}
    """
    try:
        activity.heartbeat(f"Compacting {len(context)} messages (head/tail-protected)")

        split = split_head_middle_tail(context)
        if split is None:
            logger.info("Context too small to compact; skipping", messages=len(context))
            return {"context": context, "usage": {}, "success": True}
        head_indices, middle_indices, tail_indices = split

        # Import here to avoid circular dependency
        from helpers.llm import call_llm

        middle_text = _format_middle_for_prompt(context, middle_indices)

        prompt = f"""You are summarizing a portion of an autonomous agent's execution history.
Write the summary from a neutral perspective describing what the agent did.

MUST PRESERVE:
1. Per-source evidence: every URL fetched, every claim cited with its source,
   key quoted snippets, file names, identifiers.
2. Active tasks and their current status (in-progress, blocked, pending).
3. The last user/parent request and what the agent was doing about it.
4. Decisions made and their rationale.
5. Open questions and constraints.

PRIORITIZE recent context over older history. The agent needs to know what
it was doing, not just what was discussed.

Preserve all opaque identifiers exactly as written (no shortening or
reconstruction), including UUIDs, hashes, IDs, URLs, and file names.

TURNS TO SUMMARIZE:
{middle_text}

Write only the summary, starting with "{COMPACTION_SUMMARY_PREFIX}" prefix."""

        result = await call_llm(
            messages=[{"role": "user", "content": prompt}],
            model=model,
            temperature=0.3,
            max_tokens=8000,
            claude_token=claude_token,
            claude_token_source=claude_token_source,
            claude_token_pool_id=claude_token_pool_id,
            claude_token_user_id=claude_token_user_id,
            gpt_token=gpt_token,
            gpt_account_id=gpt_account_id,
            gpt_token_source=gpt_token_source,
            gpt_token_pool_id=gpt_token_pool_id,
            gpt_token_user_id=gpt_token_user_id,
            skip_cache_write=True,
            call_site="context_compression",
            agent_id=agent_id,
            user_id=claude_token_user_id or gpt_token_user_id,
        )

        summary = (result.get("content") or "").strip()
        usage = result.get("usage", {})

        if not summary:
            logger.warning("Compactor returned empty summary; treating as failure")
            return {"context": None, "usage": usage, "success": False, "error": "empty summary"}

        if not summary.startswith(COMPACTION_SUMMARY_PREFIX):
            summary = f"{COMPACTION_SUMMARY_PREFIX} {summary}"

        synthetic_summary_msg = {
            "role": "USER",
            "text": summary,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "metadata": {"compactionSummary": True},
        }

        new_context = (
            [context[i] for i in head_indices]
            + [synthetic_summary_msg]
            + [context[i] for i in tail_indices]
        )

        logger.info(
            "Context compacted",
            original_messages=len(context),
            head=len(head_indices),
            middle=len(middle_indices),
            tail=len(tail_indices),
            summary_length=len(summary),
            tokens_used=usage.get("total_tokens", 0),
        )

        return {"context": new_context, "usage": usage, "success": True}

    except Exception as e:
        logger.error("Failed to compress context", error=str(e))
        return {"context": None, "usage": {}, "success": False, "error": str(e)}


@activity.defn
async def summarize_tool_result(
    tool_name: str,
    tool_result_text: str,
    parent_objective: str,
    model: str = "rose-labs/rose-1-lite",
    claude_token: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    claude_token_user_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Summarize a verbose tool result (e.g. web_fetch body) before it lands in context.

    Callers should only invoke this when len(tool_result_text) exceeds
    TOOL_SUMMARIZER_CHAR_THRESHOLD; below that the raw body is small enough
    to keep verbatim.

    Returns:
        Dict with:
          - summary:    str (final text to substitute into context)
          - usage:      LLM usage dict
          - summarized: True iff the LLM summarizer ran successfully
        On failure: summary is the raw text hard-capped to TOOL_RESULT_HARD_CAP_CHARS
        with a marker, and summarized=False.
    """
    try:
        activity.heartbeat(f"Summarizing {tool_name} result ({len(tool_result_text)} chars)")

        from helpers.llm import call_llm

        prompt = f"""You are summarizing a web page so an autonomous agent can use its contents
without holding the full body in its conversation.

The agent is trying to: {parent_objective}

Web page contents:
---
{tool_result_text}
---

Produce a concise summary (target 1,500 tokens, hard cap 2,000) that:
- Preserves every direct quote, statistic, date, name, URL, and identifier
  relevant to the agent's objective.
- States the source URL and page title at the top.
- Captures any claims that contradict or qualify common knowledge.
- Omits navigation, ads, related-articles sidebars, and boilerplate.

Output the summary only — no preamble."""

        result = await call_llm(
            messages=[{"role": "user", "content": prompt}],
            model=model,
            temperature=0.3,
            max_tokens=2000,
            claude_token=claude_token,
            claude_token_source=claude_token_source,
            claude_token_pool_id=claude_token_pool_id,
            claude_token_user_id=claude_token_user_id,
            gpt_token=gpt_token,
            gpt_account_id=gpt_account_id,
            gpt_token_source=gpt_token_source,
            gpt_token_pool_id=gpt_token_pool_id,
            gpt_token_user_id=gpt_token_user_id,
            skip_cache_write=True,
            call_site=f"summarize_{tool_name}",
            agent_id=agent_id,
            user_id=claude_token_user_id or gpt_token_user_id,
        )

        summary = (result.get("content") or "").strip()
        usage = result.get("usage", {})

        if not summary:
            raise ValueError("summarizer returned empty content")

        logger.info(
            "Tool result summarized",
            tool_name=tool_name,
            original_length=len(tool_result_text),
            summary_length=len(summary),
            tokens_used=usage.get("total_tokens", 0),
        )

        return {"summary": summary, "usage": usage, "summarized": True}

    except Exception as e:
        logger.warning(
            "Tool-result summarizer failed; falling back to hard-cap truncation",
            tool_name=tool_name,
            error=str(e),
        )
        original_len = len(tool_result_text)
        if original_len > TOOL_RESULT_HARD_CAP_CHARS:
            truncated = (
                tool_result_text[:TOOL_RESULT_HARD_CAP_CHARS]
                + f"\n\n...[truncated, original_len={original_len}]"
            )
        else:
            truncated = tool_result_text
        return {"summary": truncated, "usage": {}, "summarized": False, "error": str(e)}


@activity.defn
async def summarize_and_filter_links(
    url: str,
    objective: str,
    markdown: str,
    links: List[str],
    max_markdown_length: int = 40_000,
    model: str = "rose-labs/rose-1-mini",
    claude_token: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    claude_token_user_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Run one Haiku call that summarizes a fetched web page and curates which
    of the page's links are worth downloading.

    Used by the ``web_fetch`` tool after Firecrawl returns ``{markdown, links}``.
    Structured output is enforced via the ``WebFetchHaikuResponse`` Pydantic
    schema (Rose route → ``response_model=WebFetchHaikuResponse``), mirroring
    the same pattern we use for blueprint compression. The Haiku prompt shape
    mirrors Claude Code's ``WebFetchTool/prompt.ts:makeSecondaryModelPrompt``.

    Returns
        Dict with:
          - summary:           str — objective-focused summary text
          - files_to_download: List[str] — URLs the caller should download
          - usage:             dict — LLM usage stats (for cost accounting)
          - summarized:        bool — True if Haiku call succeeded
        On failure: ``summary`` is the raw markdown hard-capped to
        ``TOOL_RESULT_HARD_CAP_CHARS`` with no files selected and
        ``summarized=False``.
    """
    import json

    try:
        activity.heartbeat(f"Summarizing web_fetch result ({len(markdown)} chars, {len(links)} links)")

        from helpers.llm import call_llm

        truncation_marker = "\n\n[Content truncated due to length...]"
        if len(markdown) > max_markdown_length:
            markdown_for_prompt = markdown[: max_markdown_length - len(truncation_marker)] + truncation_marker
        else:
            markdown_for_prompt = markdown

        prompt = f"""You are filtering a fetched web page for an autonomous agent.

The agent is trying to: {objective}

PAGE URL: {url}
PAGE CONTENT (markdown):
---
{markdown_for_prompt}
---

LINKS DISCOVERED ON THE PAGE:
{json.dumps(links)}

Return JSON matching the WebFetchHaikuResponse schema.

Rules for summary:
- Preserve direct quotes, statistics, dates, names, URLs, and identifiers
  relevant to the objective.
- Start with the source URL and page title (if known).
- Omit nav, ads, related-articles, and boilerplate.
- If the input ended with "[Content truncated due to length...]", note that
  the page was truncated.

Rules for files_to_download:
- Only URLs the objective explicitly requires. Empty list is the default.
- Do NOT download arbitrary files just because they exist on the page.
- One URL per entry; deduplicate."""

        result = await call_llm(
            messages=[{"role": "user", "content": prompt}],
            model=model,
            temperature=0.3,
            max_tokens=2500,
            response_model=WebFetchHaikuResponse,
            claude_token=claude_token,
            claude_token_source=claude_token_source,
            claude_token_pool_id=claude_token_pool_id,
            claude_token_user_id=claude_token_user_id,
            gpt_token=gpt_token,
            gpt_account_id=gpt_account_id,
            gpt_token_source=gpt_token_source,
            gpt_token_pool_id=gpt_token_pool_id,
            gpt_token_user_id=gpt_token_user_id,
            skip_cache_write=True,
            call_site="summarize_web_fetch",
            agent_id=agent_id,
            user_id=claude_token_user_id or gpt_token_user_id,
        )

        content_str = (result.get("content") or "").strip()
        usage = result.get("usage", {})

        if not content_str:
            raise ValueError("Haiku returned empty content")

        parsed = WebFetchHaikuResponse.model_validate_json(content_str)
        summary = parsed.summary.strip()
        files_to_download = [u for u in parsed.files_to_download if isinstance(u, str) and u.strip()]

        if not summary:
            raise ValueError("Haiku returned empty summary")

        logger.info(
            "web_fetch Haiku filter completed",
            url=url,
            markdown_chars=len(markdown),
            summary_chars=len(summary),
            links_in=len(links),
            files_selected=len(files_to_download),
            tokens_used=usage.get("total_tokens", 0),
        )

        return {
            "summary": summary,
            "files_to_download": files_to_download,
            "usage": usage,
            "summarized": True,
        }

    except Exception as e:
        logger.warning(
            "web_fetch Haiku filter failed; falling back to truncated markdown",
            url=url,
            error=str(e),
        )
        original_len = len(markdown)
        if original_len > TOOL_RESULT_HARD_CAP_CHARS:
            truncated = (
                markdown[:TOOL_RESULT_HARD_CAP_CHARS]
                + f"\n\n...[truncated, original_len={original_len}]"
            )
        else:
            truncated = markdown
        return {
            "summary": truncated,
            "files_to_download": [],
            "usage": {},
            "summarized": False,
            "error": str(e),
        }


@activity.defn
async def generate_completion_summary(
    context: List[Dict[str, Any]],
    goal: str,
    model: str = "rose-labs/rose-1-lite",
    structured_response: Dict[str, Any] = None,
    output_schema: Dict[str, Any] = None,
    sub_agent_tool_counts: Dict[str, int] = None,
    claude_token: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    claude_token_user_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Generate a summary of what the agent accomplished.

    Called when agent reaches 100% completion to create a comprehensive
    summary of the work done, findings, and results.

    Args:
        context: Full message history
        goal: Original agent goal
        model: LLM model to use
        structured_response: Extracted structured output values from verifier
        output_schema: Schema definition with field descriptions
        sub_agent_tool_counts: Aggregated tool counts from sub-agents

    Returns:
        Dict with:
            - summary: Text summary of work completed (up to 1000 tokens) + tool stats footer
            - usage: Token usage stats
            - tool_counts: Merged tool counts (for parent aggregation)
    """
    try:
        activity.heartbeat("Generating completion summary")

        # Import here to avoid circular dependency
        from helpers.llm import call_llm, convert_context_to_messages

        # Build context about structured output (for LLM awareness, not for formatting)
        structured_output_context = ""
        if structured_response and isinstance(structured_response, dict) and len(structured_response) > 0:
            structured_output_context = "\n\nSTRUCTURED OUTPUT DELIVERED:\n"
            for key, value in structured_response.items():
                formatted_key = key.replace("_", " ").title()
                if isinstance(value, list):
                    formatted_value = ", ".join(str(v) for v in value)
                else:
                    formatted_value = str(value) if value is not None else ""
                structured_output_context += f"- {formatted_key}: {formatted_value}\n"

        system_prompt = f"""You are summarizing the work completed by an AI agent.

ORIGINAL GOAL: {goal}
{structured_output_context}

Write a BRIEF 1-2 sentence summary of what was accomplished. Focus on the outcome and key result.
Do NOT use markdown formatting, bullet points, or section headers.
Do NOT list the structured output values - they are displayed separately in the UI.
Just write plain text describing what was done."""

        # Convert context to messages (exclude system messages like blueprints)
        # Summarization needs assistant messages to see what the agent accomplished
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(convert_context_to_messages(context, include_system=False, include_assistant=True))
        messages.append(
            {
                "role": "user",
                "content": "Provide a brief 1-2 sentence summary of what was accomplished. Plain text only, no markdown.",
            }
        )

        # Use call_llm which handles Rose model routing automatically
        result = await call_llm(
            messages=messages,
            model=model,
            temperature=0.3,
            max_tokens=200,  # Brief summary only needs ~50-100 tokens
            claude_token=claude_token,
            claude_token_source=claude_token_source,
            claude_token_pool_id=claude_token_pool_id,
            claude_token_user_id=claude_token_user_id,
            gpt_token=gpt_token,
            gpt_account_id=gpt_account_id,
            gpt_token_source=gpt_token_source,
            gpt_token_pool_id=gpt_token_pool_id,
            gpt_token_user_id=gpt_token_user_id,
            skip_cache_write=True,  # One-shot call — no cache reuse
            call_site="completion_summary",
            agent_id=agent_id,
            user_id=claude_token_user_id or gpt_token_user_id,
            local_context=context,
        )

        summary = result.get("content", "")
        usage = result.get("usage", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})

        # Count this agent's tool usage and merge with sub-agent counts
        # (returned as structured data, not appended as text)
        own_tool_counts = _count_tool_usage(context)
        total_tool_counts = _merge_tool_counts(own_tool_counts, sub_agent_tool_counts or {})

        logger.info(
            "Summary generated",
            goal=goal[:50],
            summary_length=len(summary),
            tokens=usage.get("total_tokens", 0),
            has_structured_output=bool(structured_response),
            tool_count=sum(total_tool_counts.values()) if total_tool_counts else 0,
        )

        return {
            "summary": summary,
            "usage": usage,
            "tool_counts": total_tool_counts,
        }

    except Exception as e:
        logger.error("Failed to generate summary", error=str(e), goal=goal)
        # Return empty summary with zero usage on error
        return {
            "summary": f"Agent completed goal: {goal}",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            "tool_counts": {},
        }
