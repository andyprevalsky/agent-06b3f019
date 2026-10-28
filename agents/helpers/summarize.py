"""Tool for compressing agent context and generating completion summaries."""

import json
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import structlog
from pydantic import BaseModel, Field
from temporalio import activity

from utils.secret_text_redaction import redact_sensitive_text as _redact_sensitive_text

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


# Minimum number of recent TOOL/ASSISTANT/USER messages kept verbatim in
# head/tail-protected compaction. The primary boundary is token-budget based,
# following OpenClaw's `keepRecentTokens` and Hermes' `_find_tail_cut_by_tokens`.
HEAD_TAIL_PROTECTED_TURNS = 4
KEEP_RECENT_TOKENS = 20_000

# Threshold below which we skip compaction entirely — context is already small.
MIN_CONTEXT_LEN_FOR_COMPACTION = HEAD_TAIL_PROTECTED_TURNS + 2

COMPACTION_SUMMARY_PREFIX = "[CONTEXT SUMMARY]:"

# Serializer limits are intentionally per-field so one giant tool payload cannot
# erase other facts the compactor needs to see.
SUMMARY_MESSAGE_CHAR_BUDGET = 7_500
SUMMARY_FIELD_CHAR_BUDGET = 5_000
SUMMARY_TOOL_ARGS_CHAR_BUDGET = 2_000



NO_TOOLS_PREAMBLE = """CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation below.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

"""

DETAILED_ANALYSIS_INSTRUCTION_PARTIAL = """Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Analyze the recent messages chronologically. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly."""

PARTIAL_COMPACT_PROMPT = f"""Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow earlier retained context. The earlier messages are being kept intact and do NOT need to be summarized. Focus your summary on what was discussed, learned, and accomplished in the recent messages only.

{DETAILED_ANALYSIS_INSTRUCTION_PARTIAL}

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents from the recent messages
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed recently.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages from the recent portion that are not tool results.
7. Pending Tasks: Outline any pending tasks from the recent messages.
8. Current Work: Describe precisely what was being worked on immediately before this summary request.
9. Optional Next Step: List the next step related to the most recent work. Include direct quotes from the most recent conversation.

Also include these continuity sections from the compaction safeguard contract:

## Pending user asks
List active user asks that still matter after the retained recent messages.

## Exact identifiers
Preserve literal values exactly as seen when needed for continuity: IDs, URLs, file paths, ports, hashes, dates, and times.

Please provide your summary based on the RECENT messages only (after the retained earlier context), following this structure and ensuring precision and thoroughness in your response.
"""

NO_TOOLS_TRAILER = "\nRemember: respond with TEXT ONLY. Do NOT call tools.\n"

# Per-tool summarizer threshold (chars). Hermes parity at web_tools.py:613-682.
TOOL_SUMMARIZER_CHAR_THRESHOLD = 5_000
# Hard cap when the LLM summarizer itself fails — matches OpenClaw default
# (firecrawl-client.ts:42).
TOOL_RESULT_HARD_CAP_CHARS = 50_000

# Tool name → Human-readable label mapping for summary display
TOOL_DISPLAY_NAMES = {
    "web_search": "Web Searches",
    "people_search": "People Searches",
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


def _durable_child_tool_counts(context: List[Dict[str, Any]]) -> Dict[str, int]:
    """Recover child usage from terminal spawn rows, deduplicated by tool call."""
    by_call: Dict[str, Dict[str, int]] = {}
    for msg in context:
        metadata = msg.get("metadata", {}) or {}
        counts = metadata.get("childToolCounts")
        tool_call_id = metadata.get("toolCallId")
        if (
            msg.get("role") != "TOOL"
            or metadata.get("toolStatus") != "FINISHED"
            or not isinstance(tool_call_id, str)
            or not isinstance(counts, dict)
        ):
            continue
        by_call[tool_call_id] = {
            str(tool_name): int(count)
            for tool_name, count in counts.items()
            if isinstance(count, int) and not isinstance(count, bool) and count >= 0
        }
    totals: Dict[str, int] = {}
    for counts in by_call.values():
        for tool_name, count in counts.items():
            totals[tool_name] = totals.get(tool_name, 0) + count
    return totals


def _restart_safe_child_tool_counts(context: List[Dict[str, Any]], in_memory_counts: Dict[str, int]) -> Dict[str, int]:
    """Use the larger durable/runtime total so a restart cannot lose or double-count usage."""
    durable = _durable_child_tool_counts(context)
    return {
        tool_name: max(durable.get(tool_name, 0), in_memory_counts.get(tool_name, 0))
        for tool_name in durable.keys() | in_memory_counts.keys()
    }


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




def _truncate_middle(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    head = max(1, int(limit * 0.7))
    tail = max(1, limit - head)
    omitted = len(value) - head - tail
    return f"{value[:head]}\n...[truncated {omitted} chars]...\n{value[-tail:]}"


def hard_cap_tool_result_text(
    tool_result_text: str,
    *,
    limit: int = TOOL_RESULT_HARD_CAP_CHARS,
) -> str:
    """Bound a tool result before it enters an agent context.

    Explore/activity agents append tool results locally (no poll_messages path).
    Unbounded grep/email dumps have pushed those contexts past the compaction
    trigger with a protected tail that cannot shrink (prod a890a362: 228k→210k
    still above 167k). Same hard cap the tool-result summarizer uses on LLM failure.
    """
    if not isinstance(tool_result_text, str):
        tool_result_text = str(tool_result_text)
    if limit <= 0 or len(tool_result_text) <= limit:
        return tool_result_text
    return tool_result_text[:limit] + f"\n\n...[truncated, original_len={len(tool_result_text)}]"


def _json_dumps_safe(value: Any, *, limit: int = SUMMARY_FIELD_CHAR_BUDGET) -> str:
    try:
        rendered = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, default=str)
    except Exception:
        rendered = str(value)
    return _truncate_middle(_redact_sensitive_text(rendered), limit)


def _message_text(msg: Dict[str, Any]) -> str:
    text = msg.get("text")
    if text is None:
        text = msg.get("content", "")
    if isinstance(text, str):
        return text
    return _json_dumps_safe(text)


# The chars-÷-4 heuristic under-counts JSON-heavy tool payloads (observed 308k
# actual Anthropic tokens reported as <80k), so every estimate is padded by this
# factor. Single definition — loop.run_agent re-exports it.
ESTIMATE_SAFETY_MULTIPLIER = 1.4


def _estimate_tokens_for_compaction(value: str) -> int:
    return max(1, int(len(value) / 4 * ESTIMATE_SAFETY_MULTIPLIER))


def _message_summary_weight(msg: Dict[str, Any]) -> int:
    """Estimated tokens one message costs, counting everything that is rendered.

    A message's payload frequently lives entirely in metadata: production
    ASSISTANT tool-call rows carry an empty ``text`` with the whole call under
    ``metadata.tool_calls``, and TOOL rows carry results under
    ``metadata.structured_response``. Anything counted here must therefore
    include those fields, or such rows score ~0 while still costing real tokens.
    """
    meta = msg.get("metadata") or {}
    rendered_parts = [_message_text(msg)]
    if meta.get("structured_response") is not None:
        rendered_parts.append(_json_dumps_safe(meta.get("structured_response")))
    if meta.get("tool_calls"):
        rendered_parts.append(_json_dumps_safe(meta.get("tool_calls")))
    if meta.get("attachments"):
        rendered_parts.append(_json_dumps_safe(meta.get("attachments")))
    if meta.get("file_pointer") or msg.get("file_pointer"):
        rendered_parts.append(_json_dumps_safe(meta.get("file_pointer") or msg.get("file_pointer")))
    return _estimate_tokens_for_compaction("\n".join(rendered_parts))


def estimate_context_tokens(context: List[Dict[str, Any]]) -> int:
    """THE estimator for "how big is this context?".

    Used by the agent loop's overflow trigger (``run_agent._estimate_tokens``
    delegates here), by the compactor's tail budget
    (``split_head_middle_tail``), and by the compaction-effectiveness guard.
    One function so those three can never disagree.

    Prod agent e14d5abb (2026-08-03) is why: the loop counted only ``m["text"]``
    while the compactor counted text plus metadata payloads. Discarding 60
    text-empty tool rows removed ~0 tokens by the loop's books but the added
    summary was fully counted, so compaction *grew* the measured context by
    1698 tokens and the agent hard-failed.

    Sub-agent internal rows (``metadata.subAgentId``) are excluded because
    ``loop.context_utils.filter_internal_subagent_messages`` strips them before
    the context is ever sent to the model.
    """
    return sum(_message_summary_weight(msg) for msg in context if not (msg.get("metadata") or {}).get("subAgentId"))


def compaction_saved_ratio(original_tokens: int, compressed_tokens: int) -> float:
    """Signed fraction of the context that compaction removed.

    NEGATIVE when compaction grew the context — never clamped to 0.0. A clamp
    makes "compaction added 1698 tokens" look identical to "compaction saved
    nothing" in logs and in the MIN_AUTOCOMPACT_SAVINGS_RATIO comparison.
    """
    if original_tokens <= 0:
        return 0.0
    return (original_tokens - compressed_tokens) / original_tokens


def _expand_tool_pairs(
    context: List[Dict[str, Any]],
    tail_indices: set[int],
    head_set: set[int],
) -> set[int]:
    asst_by_id, tools_by_id = _build_tool_pair_maps(context)

    # Expand tail until every tool_use <-> tool_result pair is fully inside
    # head union tail (no orphans crossing the summary boundary).
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
    return tail_indices


def split_head_middle_tail(
    context: List[Dict[str, Any]],
    n_tail: int = HEAD_TAIL_PROTECTED_TURNS,
    keep_recent_tokens: Optional[int] = None,
) -> Optional[Tuple[List[int], List[int], List[int]]]:
    """Pick (head, middle, tail) message indices for head/tail-protected compaction.

    Head: first SYSTEM message (if any) + first USER message (the goal).
    Tail: recent TOOL/ASSISTANT/USER messages within a token budget, expanded
          to preserve every ASSISTANT tool_use <-> TOOL tool_result pair.
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

    if keep_recent_tokens is None:
        keep_recent_tokens = KEEP_RECENT_TOKENS

    tail_indices: set[int] = set()
    count = 0
    token_count = 0
    for i in range(len(context) - 1, -1, -1):
        if i in head_set:
            break
        role = context[i].get("role")
        if role in ("USER", "ASSISTANT", "TOOL"):
            token_count += _message_summary_weight(context[i])
            tail_indices.add(i)
            count += 1
            if count >= n_tail and token_count >= keep_recent_tokens:
                break

    # Keep the latest user/assistant turns verbatim when possible. That mirrors
    # Hermes' guard against losing the active ask at the compaction boundary.
    for target_role in ("USER", "ASSISTANT"):
        for i in range(len(context) - 1, -1, -1):
            if i in head_set:
                break
            if context[i].get("role") == target_role:
                tail_indices.add(i)
                break

    tail_indices = _expand_tool_pairs(context, tail_indices, head_set)

    middle_indices = [i for i in range(len(context)) if i not in head_set and i not in tail_indices]
    if not middle_indices:
        return None

    return head_indices, middle_indices, sorted(tail_indices)


def _format_tool_call_for_prompt(tool_call: Dict[str, Any]) -> str:
    call_copy = dict(tool_call)
    args = call_copy.get("arguments")
    if args is None:
        args = {k: v for k, v in call_copy.items() if k not in {"tool", "tool_call_id", "id", "name"}}
    return _json_dumps_safe(
        {
            "tool": call_copy.get("tool") or call_copy.get("name"),
            "tool_call_id": call_copy.get("tool_call_id") or call_copy.get("id"),
            "arguments": args,
        },
        limit=SUMMARY_TOOL_ARGS_CHAR_BUDGET,
    )


def _format_file_metadata_for_prompt(msg: Dict[str, Any], meta: Dict[str, Any]) -> List[str]:
    lines: List[str] = []
    file_pointer = meta.get("file_pointer") or msg.get("file_pointer")
    if file_pointer:
        lines.append(f"file_pointer: {_json_dumps_safe(file_pointer, limit=SUMMARY_TOOL_ARGS_CHAR_BUDGET)}")
    attachments = meta.get("attachments") or msg.get("attachments")
    if attachments:
        lines.append(f"attachments: {_json_dumps_safe(attachments, limit=SUMMARY_TOOL_ARGS_CHAR_BUDGET)}")
    return lines


def _format_middle_for_prompt(context: List[Dict[str, Any]], middle_indices: List[int]) -> str:
    """Render middle messages with model-relevant text and metadata.

    The compactor is the only reader of this representation. Human UI can show
    formatted chips, but the next LLM turn depends on structured_response and
    tool-call arguments being preserved in this summary input.
    """
    parts: List[str] = []
    for i in middle_indices:
        msg = context[i]
        role = msg.get("role", "unknown")
        meta = msg.get("metadata") or {}
        tool_name = meta.get("toolName")
        prefix = f"message_index={i} role={role}"
        if tool_name:
            prefix += f" tool={tool_name}"
        if meta.get("toolStatus"):
            prefix += f" status={meta.get('toolStatus')}"
        if meta.get("toolCallId"):
            prefix += f" tool_call_id={meta.get('toolCallId')}"
        if meta.get("title"):
            prefix += f" title={meta.get('title')}"

        lines = [f"--- {prefix} ---"]
        text = _truncate_middle(_redact_sensitive_text(_message_text(msg)), SUMMARY_FIELD_CHAR_BUDGET)
        if text:
            lines.append(f"text:\n{text}")

        if role == "ASSISTANT" and meta.get("tool_calls"):
            lines.append("assistant_tool_calls:")
            for tool_call in meta.get("tool_calls") or []:
                lines.append(_format_tool_call_for_prompt(tool_call))

        if meta.get("structured_response") is not None:
            lines.append("structured_response:")
            lines.append(_json_dumps_safe(meta.get("structured_response"), limit=SUMMARY_FIELD_CHAR_BUDGET))

        lines.extend(_format_file_metadata_for_prompt(msg, meta))
        parts.append(_truncate_middle("\n".join(lines), SUMMARY_MESSAGE_CHAR_BUDGET))
    return "\n\n".join(parts)


def _strip_compact_analysis(summary: str) -> str:
    match = re.search(r"<summary>(.*?)</summary>", summary, flags=re.IGNORECASE | re.DOTALL)
    if match:
        return match.group(1).strip()
    return re.sub(r"<analysis>.*?</analysis>", "", summary, flags=re.IGNORECASE | re.DOTALL).strip()


@activity.defn
async def compress_context(
    context: List[Dict],
    iteration_count: int,
    model: str = "rose-labs/rose-1-flash",
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
    compute_token_lineage_key: Optional[str] = None,
    compute_token_demo_cache_affinity_key: Optional[str] = None,
) -> Dict:
    """Head/tail-protected context compaction.

    Keeps first SYSTEM + first USER + recent tail turns verbatim, selected by
    token budget. Replaces the middle range with one synthetic USER turn
    containing an LLM-generated summary. ASSISTANT.tool_calls and TOOL.toolCallId
    pairs that straddle the boundary are pulled into the tail so the Anthropic
    API never sees an orphan tool_use.

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

        prompt = f"""{NO_TOOLS_PREAMBLE}{PARTIAL_COMPACT_PROMPT}

TURNS TO SUMMARIZE:
{middle_text}

Write only the summary, starting with "{COMPACTION_SUMMARY_PREFIX}" prefix.
{NO_TOOLS_TRAILER}"""

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
            compute_token_lineage_key=compute_token_lineage_key,
            compute_token_demo_cache_affinity_key=compute_token_demo_cache_affinity_key,
            skip_cache_write=True,
            call_site="context_compression",
            agent_id=agent_id,
            user_id=claude_token_user_id or gpt_token_user_id,
        )

        summary = _strip_compact_analysis((result.get("content") or "").strip())
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

        new_context = [context[i] for i in head_indices] + [synthetic_summary_msg] + [context[i] for i in tail_indices]

        # A compaction that does not shrink the context is a failed compaction.
        # Handing it back would replace the context with a LARGER one and then
        # trip the caller's overflow trigger anyway (prod agent e14d5abb).
        original_tokens = estimate_context_tokens(context)
        compressed_tokens = estimate_context_tokens(new_context)
        if compressed_tokens >= original_tokens:
            logger.error(
                "Compaction did not reduce context; rejecting result",
                original_messages=len(context),
                compressed_messages=len(new_context),
                original_tokens=original_tokens,
                compressed_tokens=compressed_tokens,
                saved_ratio=compaction_saved_ratio(original_tokens, compressed_tokens),
                summary_length=len(summary),
            )
            return {
                "context": None,
                "usage": usage,
                "success": False,
                "error": f"compaction did not reduce context ({original_tokens} -> {compressed_tokens} estimated tokens)",
                "original_tokens": original_tokens,
                "compressed_tokens": compressed_tokens,
            }

        logger.info(
            "Context compacted",
            original_messages=len(context),
            head=len(head_indices),
            middle=len(middle_indices),
            tail=len(tail_indices),
            summary_length=len(summary),
            original_tokens=original_tokens,
            compressed_tokens=compressed_tokens,
            tokens_used=usage.get("total_tokens", 0),
        )

        return {
            "context": new_context,
            "usage": usage,
            "success": True,
            "original_tokens": original_tokens,
            "compressed_tokens": compressed_tokens,
        }

    except Exception as e:
        logger.error("Failed to compress context", error=str(e))
        return {"context": None, "usage": {}, "success": False, "error": str(e)}


async def _retained_or_stated_cut(text: str, *, user_id: str, agent_id: str, session_id: str, limit: int, tool_name: str) -> str:
    """Bounded summarizer input; a retention storage failure keeps the hard-cap fallback."""
    from helpers.tool_output import RetentionError, preview_tool_text, stated_cut

    try:
        return await preview_tool_text(text, user_id=user_id, agent_id=agent_id, session_id=session_id, limit=limit)
    except RetentionError as error:
        logger.warning("Tool-result retention failed; summarizing a stated cut", tool_name=tool_name, error=str(error))
        return stated_cut(text, limit=limit, reason="retained readback unavailable after a storage failure")


@activity.defn
async def summarize_tool_result(
    tool_name: str,
    tool_result_text: str,
    parent_objective: str,
    model: str = "rose-labs/rose-1-flash",
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
    cache_sequence_id: Optional[str] = None,
    session_id: str = "",
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
    from helpers.tool_output import retained_marker

    retained = await _retained_or_stated_cut(
        tool_result_text, user_id=claude_token_user_id or gpt_token_user_id or "", agent_id=agent_id or "",
        session_id=session_id, limit=TOOL_RESULT_HARD_CAP_CHARS, tool_name=tool_name,
    )
    marker = retained_marker(retained)
    try:
        activity.heartbeat(f"Summarizing {tool_name} result ({len(tool_result_text)} chars)")

        from helpers.llm import call_llm

        prompt = f"""You are summarizing a web page so an autonomous agent can use its contents
without holding the full body in its conversation.

The agent is trying to: {parent_objective}

Web page contents:
---
{retained}
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
            cache_sequence_id=cache_sequence_id,
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

        return {"summary": summary + marker, "usage": usage, "summarized": True}

    except Exception as e:
        logger.warning(
            "Tool-result summarizer failed; falling back to hard-cap truncation",
            tool_name=tool_name,
            error=str(e),
        )
        truncated = retained
        return {"summary": truncated, "usage": {}, "summarized": False, "error": str(e)}


# Named page facts the web_fetch summarizer receives from scrape metadata.
# Main-content markdown can omit facts a page declares only in its <head>
# (the RFC Editor states a publication date only in citation_publication_date).
# Like Hermes and OpenClaw, keep an explicit allowlist: the title, then one
# validated publication date. Every other provider key (og:*, citation_reference
# lists, extract/session IDs) is dropped.
# Lookups are case-insensitive because HTML meta names are; earlier names win.
_PAGE_TITLE_KEYS = ("title",)
_PAGE_PUBLISHED_KEYS = (
    "citation_publication_date",
    "citation_date",
    "article:published_time",
    "datePublished",
    "dc.date",
    "DC.date.issued",
    "publishedTime",
    "publish_date",  # Parallel Extract
)
# OpenClaw web_fetch bounds (src/agents/tools/web-fetch.ts:75-76): 256 chars
# per field, 512 for all metadata.
_PAGE_METADATA_VALUE_CHARS = 256
_PAGE_METADATA_BLOCK_CHARS = 512
# ISO dates plus slash dates: citation_publication_date uses YYYY/MM/DD (or YYYY).
_PAGE_DATE_RE = re.compile(
    r"^(?P<year>\d{4})(?:(?P<sep>[-/])(?P<month>\d{1,2})(?:(?P=sep)(?P<day>\d{1,2})(?P<time>[T ][\d:.+Z-]{1,20})?)?)?$"
)


def _clean_page_metadata_text(value: Any) -> str:
    """One line of untrusted page text: no control characters, collapsed spaces."""
    if not isinstance(value, str):
        return ""
    printable = "".join(" " if unicodedata.category(ch) == "Cc" else ch for ch in value)
    return " ".join(printable.split())


def _is_page_metadata_date(value: str) -> bool:
    match = _PAGE_DATE_RE.match(value)
    if match is None:
        return False
    try:
        if match.group("time"):
            # Hyphenate and zero-pad slash dates (2024/3/1 12:00) so ISO parsing accepts them.
            month, day = int(match.group("month")), int(match.group("day"))
            datetime.fromisoformat(f"{match.group('year')}-{month:02d}-{day:02d}{match.group('time')}")
        else:
            datetime(int(match.group("year")), int(match.group("month") or 1), int(match.group("day") or 1))
    except ValueError:
        return False
    return True


def select_page_metadata(metadata: Any) -> Dict[str, str]:
    """The allowlisted page facts from scrape metadata, title first.

    Returns at most ``title`` and one publication date, keyed by the
    matching allowlist name. Dates must parse; values are
    sanitized to one line and bounded to the OpenClaw-like caps.
    """
    if not isinstance(metadata, dict):
        return {}
    by_name: Dict[str, List[Any]] = {}
    for key in sorted(k for k in metadata if isinstance(k, str)):
        raw = metadata[key]
        by_name.setdefault(key.lower(), []).extend(raw if isinstance(raw, list) else [raw])

    def first(names: Tuple[str, ...], accept) -> Optional[Tuple[str, str]]:
        for name in names:
            for raw in by_name.get(name.lower(), []):
                value = _clean_page_metadata_text(raw)
                if value and accept(value):
                    return name, value[:_PAGE_METADATA_VALUE_CHARS]
        return None

    selected: Dict[str, str] = {}
    size = 0
    for found in (
        first(_PAGE_TITLE_KEYS, lambda _value: True),
        first(_PAGE_PUBLISHED_KEYS, _is_page_metadata_date),
    ):
        if found is None:
            continue
        name, value = found
        line_chars = len(name) + 2 + len(value) + 1
        if size + line_chars > _PAGE_METADATA_BLOCK_CHARS:
            continue
        selected[name] = value
        size += line_chars
    return selected


def format_page_metadata(metadata: Any) -> str:
    """The allowlisted page facts as ``key: value`` lines (empty when none)."""
    return "\n".join(f"{key}: {value}" for key, value in select_page_metadata(metadata).items())


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
    cache_sequence_id: Optional[str] = None,
    compute_token_lineage_key: Optional[str] = None,
    page_metadata: Optional[Dict[str, Any]] = None,
    session_id: str = "",
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

    from helpers.tool_output import retained_marker

    retained = await _retained_or_stated_cut(
        markdown, user_id=claude_token_user_id or gpt_token_user_id or "", agent_id=agent_id or "",
        session_id=session_id, limit=max_markdown_length, tool_name="web_fetch",
    )
    marker = retained_marker(retained)
    try:
        activity.heartbeat(f"Summarizing web_fetch result ({len(markdown)} chars, {len(links)} links)")

        from helpers.llm import call_llm

        markdown_for_prompt = retained

        metadata_text = format_page_metadata(page_metadata)
        metadata_section = (
            f"PAGE METADATA (declared by the page, e.g. <meta> tags):\n---\n{metadata_text}\n---\n\n"
            if metadata_text
            else ""
        )

        prompt = f"""You are filtering a fetched web page for an autonomous agent.

The agent is trying to: {objective}

PAGE URL: {url}
{metadata_section}PAGE CONTENT (markdown):
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
- If the input contains a retained-output marker, note that this is a preview.

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
            skip_cache_write=False,
            call_site="summarize_web_fetch",
            agent_id=agent_id,
            user_id=claude_token_user_id or gpt_token_user_id,
            cache_sequence_id=cache_sequence_id,
            compute_token_lineage_key=compute_token_lineage_key,
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
            "summary": summary + marker,
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
        truncated = retained
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
    model: str = "rose-labs/rose-1-flash",
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
    compute_token_lineage_key: Optional[str] = None,
    compute_token_demo_cache_affinity_key: Optional[str] = None,
    fast_mode_cache_enabled: bool = False,
    fast_mode_step: int = 0,
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
    # The Fast Cache context is task-scoped state: restore it on every exit so
    # a summary never leaks its cache identity into later work on this task.
    demo_cache_token = None
    try:
        activity.heartbeat("Generating completion summary")

        # Import here to avoid circular dependency
        from helpers.llm import call_llm, convert_context_to_messages, resolve_context_attachments
        from providers.demo_cache.context import (
            DemoCacheContext,
            write_through_enabled_for_user,
        )
        from providers.demo_cache.context import (
            reset_context as reset_demo_cache_context,
        )
        from providers.demo_cache.context import (
            set_context as set_demo_cache_context,
        )
        from utils.user_facing_writing_prompt import USER_FACING_WRITING_STYLE

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

{USER_FACING_WRITING_STYLE}

ORIGINAL GOAL: {goal}
{structured_output_context}

Write a BRIEF 1-2 sentence summary of what was accomplished. Focus on the outcome and key result.
Do NOT use markdown formatting, bullet points, or section headers.
Do NOT list the structured output values - they are displayed separately in the UI.
Just write plain text describing what was done."""

        # Convert context to messages (exclude system messages like blueprints)
        # Summarization needs assistant messages to see what the agent accomplished
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(
            convert_context_to_messages(
                context,
                include_system=False,
                include_assistant=True,
                attachments=await resolve_context_attachments(context),
            )
        )
        messages.append(
            {
                "role": "user",
                "content": "Provide a brief 1-2 sentence summary of what was accomplished. Plain text only, no markdown.",
            }
        )

        cache_user_id = claude_token_user_id or gpt_token_user_id
        write_through_enabled = write_through_enabled_for_user(cache_user_id)
        if goal and (fast_mode_cache_enabled or write_through_enabled):
            from providers.demo_cache.client import resolve_soft_complete_root_goal

            root_goal = await resolve_soft_complete_root_goal(agent_id, goal)
            demo_cache_token = set_demo_cache_context(
                DemoCacheContext(
                    enabled=fast_mode_cache_enabled,
                    goal=goal,
                    base_step=fast_mode_step,
                    write_enabled=fast_mode_cache_enabled or write_through_enabled,
                    root_goal=root_goal,
                )
            )

        # Reasoning models count hidden thinking against max_tokens. A 200-token
        # ceiling produced 196 reasoning tokens + the visible fragment
        # "Your order for a 1" in production. Give the short answer ample room,
        # and retry once when the provider explicitly reports truncation.
        result: Dict[str, Any] = {}
        aggregate_usage: Dict[str, Any] = {}
        for max_tokens in (1024, 4096):
            result = await call_llm(
                messages=messages,
                model=model,
                temperature=0.3,
                max_tokens=max_tokens,
                claude_token=claude_token,
                claude_token_source=claude_token_source,
                claude_token_pool_id=claude_token_pool_id,
                claude_token_user_id=claude_token_user_id,
                gpt_token=gpt_token,
                gpt_account_id=gpt_account_id,
                gpt_token_source=gpt_token_source,
                gpt_token_pool_id=gpt_token_pool_id,
                gpt_token_user_id=gpt_token_user_id,
                compute_token_lineage_key=compute_token_lineage_key,
                compute_token_demo_cache_affinity_key=compute_token_demo_cache_affinity_key,
                skip_cache_write=True,  # One-shot call — no cache reuse
                call_site="completion_summary",
                agent_id=agent_id,
                user_id=claude_token_user_id or gpt_token_user_id,
                local_context=context,
            )
            attempt_usage = result.get("usage", {})
            if isinstance(attempt_usage, dict):
                for key, value in attempt_usage.items():
                    if isinstance(value, (int, float)) and not isinstance(value, bool):
                        aggregate_usage[key] = aggregate_usage.get(key, 0) + value
                    else:
                        aggregate_usage[key] = value
            if result.get("finish_reason") != "length":
                break
            logger.warning(
                "Completion summary hit max_tokens; retrying",
                agent_id=agent_id,
                max_tokens=max_tokens,
                visible_chars=len(result.get("content", "")),
            )

        if result.get("finish_reason") == "length":
            # Never persist a known partial sentence or the T7-forbidden
            # "verified results are included below" stub. Workflow recovery
            # fills the card from replayed research evidence.
            summary = ""
        else:
            summary = result.get("content", "")
        usage = {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            **aggregate_usage,
        }

        # Count this agent's tool usage and merge with sub-agent counts
        # (returned as structured data, not appended as text)
        own_tool_counts = _count_tool_usage(context)
        child_tool_counts = _restart_safe_child_tool_counts(context, sub_agent_tool_counts or {})
        total_tool_counts = _merge_tool_counts(own_tool_counts, child_tool_counts)

        logger.info(
            "Summary generated",
            goal=goal[:50],
            summary_length=len(summary),
            tokens=usage.get("total_tokens", 0),
            has_structured_output=bool(structured_response),
            tool_count=sum(total_tool_counts.values()) if total_tool_counts else 0,
        )

        _summary_result = {
            "summary": summary,
            "usage": usage,
            "tool_counts": total_tool_counts,
        }
        return _summary_result

    except Exception as e:
        logger.error("Failed to generate summary", error=str(e), goal=goal)
        # Return empty summary with zero usage on error
        return {
            "summary": f"Agent completed goal: {goal}",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            "tool_counts": {},
        }
    finally:
        if demo_cache_token is not None:
            reset_demo_cache_context(demo_cache_token)
