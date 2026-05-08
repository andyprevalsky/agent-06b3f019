"""
Unified Agent Loop - Core loop for both main workflow and browser agent.

CALLBACKS (abstracted for workflow vs activity context):
- check_paused: Returns True if agent should pause
- wait_for_messages: Waits for new messages (workflow uses wait_condition, activity polls DB)
- on_context_overflow: Called when context needs compression (workflow calls continue_as_new)
- check_credits: Checks credits and sets pause if depleted (called every N iterations)

USAGE:
- Main workflow: Calls run_agent twice (PLAN phase, then EXECUTE phase)
- Browser agent: Calls run_agent once (EXECUTE only)
"""

import asyncio
import contextlib
import hashlib
import json
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Deque, Dict, List, Optional, Tuple, Type

import structlog
from pydantic import BaseModel

# All imports at module level - no inline imports to avoid workflow sandbox issues
from temporalio import activity, workflow
from temporalio.common import RetryPolicy

from helpers.attachments import extract_file_pointer_dicts, resolve_attachments_activity
from helpers.context_pointers import annotate_with_pointer
from helpers.handle_tool_event import handle_tool_event
from helpers.llm import (
    _pending_llm_context,
    build_llm_messages,
    call_llm_activity,
    call_llm_structured_streaming,
    check_progress,
    inject_llm_only_user_preamble,
)
from helpers.summarize import compress_context
from helpers.tracing import span, traced
from helpers.update_status import update_agent_status
from loop.activity_helper import call_temporal_activity_from_activity
from loop.context_utils import poll_and_update_context
from tools.base import EventType, MessageStatus, ToolEvent
from tools.knowledge_base import query_blueprints
from utils.prompts import format_required_output_schema_user_message
from utils.tool_schemas import create_agent_action_model

logger = structlog.get_logger()

# Check credits every N iterations
CREDIT_CHECK_INTERVAL = 5


@traced("run_agent")
async def run_agent(  # noqa: C901
    # Identity
    agent_id: str,
    user_id: str,
    # Configuration
    system_prompt: Callable[[], Awaitable[str]],  # Called each iteration to build prompt with fresh shared memory
    verifier_prompt_generator: Callable[
        [], Awaitable[str]
    ],  # Called at verification time to build prompt (allows schema polling)
    model: str,
    tools: List[str],  # Tool names (schemas from Pydantic models)
    # Context (optional - will poll from DB if not provided)
    initial_context: Optional[List[Dict]] = None,
    task_id: Optional[str] = None,  # For browser sub-agent message isolation
    # Execution context
    is_inside_temporal_activity: bool = False,
    # Callbacks - abstract workflow vs activity differences
    check_paused: Optional[Callable[[], bool]] = None,
    wait_for_messages: Optional[Callable[[], Awaitable[bool]]] = None,
    on_context_overflow: Optional[Callable[[List[Dict]], Awaitable[None]]] = None,
    check_credits: Optional[Callable[[], Awaitable[None]]] = None,  # Checks credits, sets pause if depleted
    # For posting messages and executing tools
    post_message: Optional[Callable[[str, str, Optional[Dict]], Awaitable[None]]] = None,
    poll_messages: Optional[Callable[[datetime], Awaitable[List[Dict]]]] = None,  # Takes last_checked timestamp
    execute_tool: Optional[Callable[[str, Dict, str], Awaitable[Dict]]] = None,
    # For tree state updates (sub-agent UI)
    update_tree_state: Optional[Callable[[], Awaitable[None]]] = None,
    # For tree token aggregation - returns (children_tokens_in, children_tokens_out)
    get_children_tokens: Optional[Callable[[], Tuple[int, int]]] = None,
    # For cost tracking - called after each LLM call with token deltas + actual_model + cache tokens
    # Workflow uses this to calculate cost and check price limit in real-time
    on_tokens: Optional[Callable[..., Awaitable[None]]] = None,
    # Custom response model (for browser agent with different tool schemas)
    # If None, uses create_agent_action_model(tools)
    response_model: Optional[Type[BaseModel]] = None,
    # Custom message builder for multimodal content (browser uses compress_messages)
    # If None, uses default _build_llm_messages
    build_messages: Optional[Callable[[List[Dict], str], List[Dict]]] = None,
    # Limits
    max_iterations: int = 200,
    max_context_tokens: int = 100_000,
    context_threshold_percentage: float = 0.8,
    reasoning_max_tokens: int = 256,
    # State tracking (for continue_as_new)
    iteration_offset: int = 0,
    # Blueprint control (skip for EXECUTE phase since PLAN already queried)
    skip_blueprint_query: bool = True,
    # Skip LLM verification call
    skip_verification: bool = False,
    # Skip update_agent_status broadcasts (used by explore agent to avoid overwriting parent's context_size)
    skip_status_updates: bool = False,
    # PLAN phase mode - requires set_plan before completion
    is_plan_loop: bool = False,
    # Response schema for structured output extraction
    # Static schema (use get_response_schema for dynamic fetching)
    response_schema: Optional[Dict[str, Any]] = None,
    # Dynamic schema getter - called at verification time (handles race condition with async schema generation)
    get_response_schema: Optional[Callable[[], Awaitable[Optional[Dict[str, Any]]]]] = None,
    # Claude OAuth token for direct Anthropic calls via Rose endpoint
    claude_token: Optional[str] = None,
    # Dynamic token getter - called before each LLM call to get latest token
    # (workflow invalidates cached token on fallback, so getter returns None after that)
    get_claude_token: Optional[Callable[[], Optional[str]]] = None,
    get_claude_token_source: Optional[Callable[[], Optional[str]]] = None,
    get_claude_token_pool_id: Optional[Callable[[], Optional[str]]] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    get_gpt_token: Optional[Callable[[], Optional[str]]] = None,
    get_gpt_account_id: Optional[Callable[[], Optional[str]]] = None,
    get_gpt_token_source: Optional[Callable[[], Optional[str]]] = None,
    get_gpt_token_pool_id: Optional[Callable[[], Optional[str]]] = None,
    # Override the call_site label used when emitting llm.cache. Defaults to
    # "plan_loop"/"execute_loop" based on is_plan_loop. Sub-agents that share
    # this loop (e.g. explore_agent) set this to surface as their own row in
    # cache reports instead of merging with the parent's execute_loop.
    call_site_override: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Run the unified agent loop.

    Returns:
        Dict with:
        - status: "completed" | "paused" | "needs_user_response" | "max_iterations" | "error"
        - context: Final context (for passing to next phase or continue_as_new)
        - tokens_in/out/count: Token usage
        - message: Final message/summary
    """
    # Initialize state
    context: List[Dict] = initial_context.copy() if initial_context else []
    for msg in context:
        annotate_with_pointer(msg)
    # Resolve the cache call_site once. Override wins when set, otherwise
    # the standard PLAN/EXECUTE loop labels.
    cache_call_site = call_site_override or ("plan_loop" if is_plan_loop else "execute_loop")

    tokens_in = 0
    tokens_out = 0
    token_count = 0
    context_size = 0  # Current context window usage (uncached + cached tokens from last LLM call)
    cache_read_total = 0  # Cumulative cache read tokens (prompt caching hits)
    cache_write_total = 0  # Cumulative cache creation tokens (prompt caching misses)
    iteration = iteration_offset
    set_plan_called = False  # Track if set_plan was called (for is_plan_loop)
    set_plan_succeeded = False  # Track if set_plan completed successfully (not just called)
    no_tool_count = 0  # Track consecutive iterations with no tool calls
    consecutive_llm_failures = 0  # Track consecutive LLM call failures for early exit
    consecutive_verifier_errors = 0  # Track consecutive verifier failures for early exit
    recent_verifier_scores: List[float] = []  # Track last N scores for trend feedback
    recent_call_hashes: Deque[str] = deque(maxlen=6)  # Track last N tool-call signatures for repetition detection
    same_call_streak = 0  # Consecutive iterations where all tool calls were identical

    # Track last_checked timestamp FOR THIS RUN - start with epoch if no context
    # This ensures we get ALL messages on first poll, not just recent ones
    last_checked = datetime.fromtimestamp(0, tz=timezone.utc)
    if context:
        # If we have initial context, find the latest timestamp
        for msg in context:
            ts_str = msg.get("timestamp", "")
            if ts_str:
                try:
                    msg_ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    if msg_ts > last_checked:
                        last_checked = msg_ts
                except Exception:
                    pass

    logger.debug(
        "Initial context",
        context_len=len(context),
        last_checked=last_checked.isoformat(),
    )

    # Generate stream_id for this session
    stream_id = str(uuid.uuid4())

    # Set up execute_activity based on context (workflow vs activity)
    execute_activity = (
        call_temporal_activity_from_activity if is_inside_temporal_activity else workflow.execute_activity
    )

    # Handle tool event wrapper - used by all tools
    async def _handle_tool_event(event, tool_call_id: str, tool_name: str):
        await handle_tool_event(
            event=event,
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            execute_activity=execute_activity,
            user_id=user_id,
        )

    # Create dynamic action model for structured output
    # Use custom response_model if provided (e.g., browser agent), otherwise create from tools
    AgentAction = (
        response_model
        if response_model
        else create_agent_action_model(
            tools,
            include_attempt_completion_result=skip_verification,
        )
    )

    def _log_cache_summary(status: str):
        """Log cache performance summary at end of run."""
        total_input = tokens_in + cache_read_total + cache_write_total
        if total_input > 0 and (cache_read_total > 0 or cache_write_total > 0):
            hit_pct = round(cache_read_total / total_input * 100)
            logger.info(
                f"💾 Cache summary [{status}]: read={cache_read_total} write={cache_write_total} uncached={tokens_in} "
                f"hit={hit_pct}% iterations={iteration} agent={agent_id}"
            )

    logger.info(
        "run_agent starting",
        agent_id=agent_id,
        tools=len(tools),
        task_id=task_id,
        is_inside_temporal_activity=is_inside_temporal_activity,
    )

    # Main loop
    while iteration < max_iterations:
        # 1. Check if paused (BEFORE incrementing iteration - don't count paused loops as steps)
        if check_paused and await check_paused():
            logger.info("Agent paused, waiting...")
            if wait_for_messages:
                # Wait for unpause (workflow) or poll (activity)
                with contextlib.suppress(asyncio.TimeoutError):
                    await wait_for_messages()
            else:
                await asyncio.sleep(1)
            continue

        # Only increment iteration when we're actually going to do work
        iteration += 1

        # 1.5. Check credits periodically (callback sets is_paused if depleted)
        if check_credits and (iteration % CREDIT_CHECK_INTERVAL == 0):
            try:
                await check_credits()
                # If callback set is_paused, next iteration will catch it
            except Exception as e:
                logger.warning(f"Credit check failed (continuing): {e}")

        # 2. Poll for new messages (pass our own last_checked, not workflow's)
        if poll_messages:
            last_checked = await poll_and_update_context(poll_messages, context, last_checked)

        # 3. Query blueprints after first iteration (only in PLAN phase, not EXECUTE)
        if False:
            # Check if we have any user messages
            user_messages = [m.get("text", "") for m in context if m.get("role") == "USER"]
            if user_messages:
                try:
                    # Update tree state before blueprint query
                    if update_tree_state:
                        await update_tree_state()

                    blueprints = await query_blueprints(
                        handle_tool_event_callback=_handle_tool_event,
                        execute_activity=execute_activity,
                        context=context,
                        user_id=user_id,
                        limit=3,
                    )

                    # Update tree state after blueprint query
                    if update_tree_state:
                        await update_tree_state()

                    # Add blueprints to context
                    if blueprints:
                        for idx, bp in enumerate(blueprints, 1):
                            blueprint_text = bp.get("blueprint", "")
                            formatted = (
                                f"━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
                                f"REFERENCE BLUEPRINT #{idx}\n"
                                f"Goal: {bp.get('title', '')}\n"
                                f"━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
                                f"{blueprint_text}\n"
                                f"━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                            )
                            context.append(
                                {
                                    "role": "SYSTEM",
                                    "text": formatted,
                                    "timestamp": datetime.now(timezone.utc).isoformat(),
                                }
                            )
                        logger.info(f"Added {len(blueprints)} blueprints to context")
                except Exception as e:
                    logger.warning(f"Blueprint query failed (non-fatal): {e}")

        # 5. Check context size - compress if needed
        context_tokens = _estimate_tokens(context)
        threshold = int(max_context_tokens * context_threshold_percentage)

        if context_tokens >= threshold:
            logger.info(f"Context overflow: {context_tokens} >= {threshold}")
            compression_claude_token = get_claude_token() if get_claude_token else claude_token
            compression_claude_token_source = get_claude_token_source() if get_claude_token_source else None
            compression_claude_token_pool_id = get_claude_token_pool_id() if get_claude_token_pool_id else None
            compression_gpt_token = get_gpt_token() if get_gpt_token else gpt_token
            compression_gpt_account_id = get_gpt_account_id() if get_gpt_account_id else gpt_account_id
            compression_gpt_token_source = get_gpt_token_source() if get_gpt_token_source else None
            compression_gpt_token_pool_id = get_gpt_token_pool_id() if get_gpt_token_pool_id else None
            compressed = await _compress_context(
                execute_activity=execute_activity,
                context=context,
                model=model,
                on_tokens=on_tokens,
                agent_id=agent_id,
                user_id=user_id,
                claude_token=compression_claude_token,
                claude_token_source=compression_claude_token_source,
                claude_token_pool_id=compression_claude_token_pool_id,
                gpt_token=compression_gpt_token,
                gpt_account_id=compression_gpt_account_id,
                gpt_token_source=compression_gpt_token_source,
                gpt_token_pool_id=compression_gpt_token_pool_id,
            )

            if on_context_overflow:
                # Workflow: will call continue_as_new (never returns)
                await on_context_overflow(compressed)

            # Activity: just use compressed context
            context = compressed

        # 6. Build system prompt (calls API for fresh shared memory each iteration)
        current_system_prompt = await system_prompt()
        current_response_schema = response_schema
        if get_response_schema:
            try:
                current_response_schema = await get_response_schema()
            except Exception as e:
                logger.warning(f"Failed to fetch response schema for LLM preamble: {e}")
        schema_preamble = format_required_output_schema_user_message(current_response_schema)

        # 7. Build messages for LLM
        # Use custom builder if provided (e.g., browser uses compress_messages for multimodal)
        if build_messages:
            messages = build_messages(context, current_system_prompt)
            if schema_preamble:
                messages = inject_llm_only_user_preamble(messages, schema_preamble)
        elif not is_inside_temporal_activity:
            # Workflow context: pre-download files, then defer message building to call_llm_activity
            # so that base64 content never crosses Temporal's 2MB payload boundary.
            # The resolve activity populates _file_cache (shared in-process memory).
            # call_llm_activity reads from _pending_llm_context + _file_cache.
            pre_resolved_ids = None
            file_pointer_dicts = extract_file_pointer_dicts(context)
            if file_pointer_dicts:
                try:
                    resolved_list = await execute_activity(
                        resolve_attachments_activity,
                        args=[file_pointer_dicts],
                        start_to_close_timeout=timedelta(seconds=60),
                        retry_policy=RetryPolicy(maximum_attempts=2),
                    )
                    pre_resolved_ids = set(resolved_list) if resolved_list else None
                except Exception as e:
                    logger.warning(f"File resolution failed (continuing without pre-resolved files): {e}")
            # Store context in shared memory — call_llm_activity will build messages inside
            _pending_llm_context[agent_id] = (
                context,
                current_system_prompt,
                pre_resolved_ids,
                user_id,
            )
            messages = None  # Signals to use shared state path below
        else:
            messages = await build_llm_messages(
                context,
                current_system_prompt,
                llm_only_user_preamble=schema_preamble,
                user_id=user_id,
            )

        # Resolve Claude token dynamically (getter returns latest; may be None after fallback)
        current_claude_token = get_claude_token() if get_claude_token else claude_token
        current_claude_token_source = get_claude_token_source() if get_claude_token_source else None
        current_claude_token_pool_id = get_claude_token_pool_id() if get_claude_token_pool_id else None
        current_gpt_token = get_gpt_token() if get_gpt_token else gpt_token
        current_gpt_account_id = get_gpt_account_id() if get_gpt_account_id else gpt_account_id
        current_gpt_token_source = get_gpt_token_source() if get_gpt_token_source else None
        current_gpt_token_pool_id = get_gpt_token_pool_id() if get_gpt_token_pool_id else None

        # 7. Call LLM with structured streaming
        try:
            if is_inside_temporal_activity:
                # Inside activity (browser agent) - call LLM directly with streaming callback
                sequence = [0]
                last_text = [""]

                async def on_chunk(text_so_far: str, token_count_chunk: int):  # noqa: B023
                    # Heartbeat so Temporal knows the activity is alive during long LLM calls
                    if is_inside_temporal_activity:
                        activity.heartbeat(f"LLM streaming: {token_count_chunk} tokens")

                    # Check if paused mid-stream
                    if check_paused and await check_paused():
                        raise asyncio.CancelledError("Paused")

                    delta = text_so_far[len(last_text[0]) :]  # noqa: B023
                    if delta:
                        stream_event = ToolEvent(
                            type=EventType.STREAM_MESSAGE,
                            stream_id=stream_id,
                            delta=delta,
                            done=False,
                            sequence=sequence[0],  # noqa: B023
                            sub_agent_id=task_id,
                        )
                        await handle_tool_event(
                            event=stream_event,
                            agent_id=agent_id,
                            tool_call_id=stream_id,
                            tool_name="llm_call",
                            execute_activity=execute_activity,
                            user_id=user_id,
                            sub_agent_id=task_id,
                        )
                        sequence[0] += 1  # noqa: B023
                        last_text[0] = text_so_far  # noqa: B023

                # Retry up to 3 times on parse failures (matches workflow path's RetryPolicy)
                max_llm_attempts = 3
                for llm_attempt in range(1, max_llm_attempts + 1):
                    try:
                        pydantic_result, usage, detected_tools_ordered = await call_llm_structured_streaming(
                            messages=messages,
                            model=model,
                            temperature=1.0,
                            max_tokens=8192,
                            response_model=AgentAction,
                            on_chunk=on_chunk,
                            reasoning_max_tokens=reasoning_max_tokens,
                            agent_id=agent_id,
                            claude_token=current_claude_token,
                            claude_token_source=current_claude_token_source,
                            claude_token_pool_id=current_claude_token_pool_id,
                            claude_token_user_id=user_id,
                            gpt_token=current_gpt_token,
                            gpt_account_id=current_gpt_account_id,
                            gpt_token_source=current_gpt_token_source,
                            gpt_token_pool_id=current_gpt_token_pool_id,
                            gpt_token_user_id=user_id,
                            call_site=cache_call_site,
                        )
                        break  # Success
                    except (ValueError, Exception) as e:
                        if llm_attempt < max_llm_attempts and "Failed to parse" in str(e):
                            logger.warning(
                                f"[run_agent] LLM parse failed (attempt {llm_attempt}/{max_llm_attempts}), retrying",
                                error=str(e),
                            )
                            # Reset streaming state for retry
                            sequence[0] = 0
                            last_text[0] = ""
                            continue
                        raise

                # Convert Pydantic tool_calls to dicts (same as call_llm_activity does)
                tool_calls_as_dicts = []
                if pydantic_result.tool_calls:
                    for tc in pydantic_result.tool_calls:
                        if tc is not None:
                            tool_calls_as_dicts.append(tc.model_dump())

                # Normalize to same structure as activity path
                result = type(
                    "LLMResult",
                    (),
                    {
                        "response": pydantic_result.response or "",
                        "tool_calls": tool_calls_as_dicts,  # List[dict]
                        "codex_reasoning_items": getattr(pydantic_result, "codex_reasoning_items", []),
                    },
                )()

                # Final stream chunk - done=True
                try:
                    final_delta = ""
                    if pydantic_result.response:
                        final_delta = pydantic_result.response[len(last_text[0]) :]
                    final_event = ToolEvent(
                        type=EventType.STREAM_MESSAGE,
                        stream_id=stream_id,
                        delta=final_delta,
                        done=True,
                        sequence=sequence[0],
                        sub_agent_id=task_id,
                    )
                    await handle_tool_event(
                        event=final_event,
                        agent_id=agent_id,
                        tool_call_id=stream_id,
                        tool_name="llm_call",
                        execute_activity=execute_activity,
                        user_id=user_id,
                        sub_agent_id=task_id,
                    )
                except Exception:
                    pass
            else:
                call_site_label = cache_call_site
                llm_result = await workflow.execute_activity(
                    call_llm_activity,
                    args=[
                        agent_id,
                        model,
                        tools,
                        reasoning_max_tokens,
                        agent_id,
                        stream_id,
                        task_id,
                        current_claude_token,
                        call_site_label,
                        current_system_prompt,
                        None,
                        None,
                        False,
                        skip_verification,
                        schema_preamble,
                        current_claude_token_source,
                        current_claude_token_pool_id,
                        user_id,
                        current_gpt_token,
                        current_gpt_account_id,
                        current_gpt_token_source,
                        current_gpt_token_pool_id,
                        user_id,
                        user_id,
                    ],
                    start_to_close_timeout=timedelta(seconds=180),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                    heartbeat_timeout=timedelta(seconds=60),
                )

                # Reconstruct result object from activity response
                class ActivityResult:
                    def __init__(self, response: str, tool_calls: list, codex_reasoning_items: list):
                        self.response = response
                        self.tool_calls = tool_calls
                        self.codex_reasoning_items = codex_reasoning_items

                # Keep tool_calls as dicts - they'll be processed directly
                tool_calls_list = llm_result.get("tool_calls", [])

                result = ActivityResult(
                    response=llm_result.get("response", ""),
                    tool_calls=tool_calls_list,  # Keep as dicts, not objects
                    codex_reasoning_items=llm_result.get("codex_reasoning_items", []),
                )
                usage = llm_result.get("usage", {})

                # Get detected tools for ID matching (from activity)
                detected_tools_ordered = llm_result.get("detected_tools_ordered", [])

            # Track tokens locally
            llm_tokens_in = usage.get("prompt_tokens", 0)
            llm_tokens_out = usage.get("completion_tokens", 0)
            llm_total = usage.get("total_tokens", 0)

            tokens_in += llm_tokens_in
            tokens_out += llm_tokens_out
            token_count += llm_total

            # Track cache metrics
            iter_cache_read = usage.get("cache_read_input_tokens", 0)
            iter_cache_write = usage.get("cache_creation_input_tokens", 0)

            # Context size = full prompt (uncached + cached) to reflect actual context window usage
            context_size = llm_tokens_in + iter_cache_read + iter_cache_write
            cache_read_total += iter_cache_read
            cache_write_total += iter_cache_write
            if iter_cache_read > 0 or iter_cache_write > 0:
                total_input = llm_tokens_in + iter_cache_read + iter_cache_write
                cache_pct = round(iter_cache_read / total_input * 100) if total_input > 0 else 0
                logger.info(
                    f"💾 Cache i{iteration}: read={iter_cache_read} write={iter_cache_write} uncached={llm_tokens_in} hit={cache_pct}% | cumulative: read={cache_read_total} write={cache_write_total}"
                )

            # Notify workflow of token usage for cost tracking and limit checking
            # This happens BEFORE tree token broadcast so cost limit can pause before more work
            if on_tokens:
                try:
                    await on_tokens(
                        llm_tokens_in,
                        llm_tokens_out,
                        usage.get("actual_model"),
                        cache_read_input_tokens=iter_cache_read,
                        cache_creation_input_tokens=iter_cache_write,
                        call_site=cache_call_site,
                        claude_token_error=usage.get("claude_token_error"),
                        gpt_token_error=usage.get("gpt_token_error"),
                        claude_token_rotated=usage.get("claude_token_rotated", False),
                        gpt_token_rotated=usage.get("gpt_token_rotated", False),
                        compute_token_used=usage.get("compute_token_used"),
                    )
                except Exception as e:
                    logger.warning(f"on_tokens callback failed: {e}")

            # Check if paused (cost limit may have been triggered by on_tokens)
            if check_paused and await check_paused():
                logger.info("Agent paused after cost check")
                _pending_llm_context.pop(agent_id, None)
                return {
                    "status": "paused",
                    "context": context,
                    "tokens_in": tokens_in,
                    "tokens_out": tokens_out,
                    "token_count": token_count,
                    "context_size": context_size,
                    "cache_read_input_tokens": cache_read_total,
                    "cache_creation_input_tokens": cache_write_total,
                }

            # Calculate tree tokens (own + children's accumulated tokens)
            children_tokens_in, children_tokens_out = (0, 0)
            if get_children_tokens:
                children_tokens_in, children_tokens_out = get_children_tokens()
            tree_tokens_in = tokens_in + children_tokens_in
            tree_tokens_out = tokens_out + children_tokens_out

            # Persist + broadcast tree tokens after each LLM call.
            # Fire-and-forget: this is a UI progress broadcast — it doesn't gate
            # the loop's correctness, and awaiting it adds ~80–120ms to every LLM
            # iteration (PATCH /status RTT). With 10+ iterations per task that's
            # ~1s of pure latency tax that can push smoke runs past their cap.
            # Skip when running as explore agent — its context_size would overwrite the parent's.
            if not skip_status_updates:
                try:
                    if is_inside_temporal_activity:
                        # Activity context: use asyncio.create_task so it runs in background
                        asyncio.create_task(
                            execute_activity(
                                update_agent_status,
                                args=[
                                    agent_id,
                                    "ACTIVE",
                                    iteration / max_iterations,
                                    "Processing",
                                    token_count,
                                    context_size,
                                    len(context),
                                    tree_tokens_in,
                                    tree_tokens_out,
                                ],
                                start_to_close_timeout=timedelta(seconds=15),
                                retry_policy=RetryPolicy(maximum_attempts=2),
                            )
                        )
                    else:
                        # Workflow context: workflow.start_activity returns a handle without
                        # blocking the workflow. We intentionally drop the handle — Temporal
                        # tracks it, and we don't care about the result.
                        workflow.start_activity(
                            update_agent_status,
                            args=[
                                agent_id,
                                "ACTIVE",
                                iteration / max_iterations,
                                "Processing",
                                token_count,
                                context_size,
                                len(context),
                                tree_tokens_in,
                                tree_tokens_out,
                            ],
                            start_to_close_timeout=timedelta(seconds=15),
                            retry_policy=RetryPolicy(maximum_attempts=2),
                        )
                except Exception as e:
                    logger.warning(f"Failed to schedule agent status update: {e}")
                # Non-fatal - continue execution

        except asyncio.CancelledError:
            logger.info("LLM call cancelled (paused)")
            _pending_llm_context.pop(agent_id, None)
            return {
                "status": "paused",
                "context": context,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "token_count": token_count,
                "context_size": context_size,
                "cache_read_input_tokens": cache_read_total,
                "cache_creation_input_tokens": cache_write_total,
            }
        except Exception as e:
            consecutive_llm_failures += 1
            logger.error(f"LLM call failed (consecutive={consecutive_llm_failures}): {e}")
            if consecutive_llm_failures >= 3:
                _pending_llm_context.pop(agent_id, None)
                return {
                    "status": "error",
                    "context": context,
                    "tokens_in": tokens_in,
                    "tokens_out": tokens_out,
                    "token_count": token_count,
                    "context_size": context_size,
                    "cache_read_input_tokens": cache_read_total,
                    "cache_creation_input_tokens": cache_write_total,
                    "message": f"LLM call failed {consecutive_llm_failures} consecutive times: {e}",
                }
            backoff = min(2 * (2 ** (consecutive_llm_failures - 1)), 30)
            await asyncio.sleep(backoff)
            continue

        # 8. Extract response and tool calls
        consecutive_llm_failures = 0  # Reset on successful LLM call
        response_text = result.response if hasattr(result, "response") else ""
        tool_calls = result.tool_calls if hasattr(result, "tool_calls") else []

        # 9. Pre-process tool calls to assign stable IDs (used for both
        # assistant metadata persistence and tool execution/results).
        # Track which detected tools have been used (for matching multiple same-name tools in order)
        detected_tool_usage_count: Dict[str, int] = {}
        processed_tools = []
        attempt_completion_tool = None
        assistant_tool_calls = []

        for tc_dict in tool_calls:
            tc_dict = tc_dict.copy()  # Don't mutate original
            tool_name = tc_dict.pop("tool", "")
            tool_args = tc_dict

            if not tool_name:
                continue

            # Try to get pre-assigned tool_call_id from detected_tools_ordered
            # This ensures early IN_PROGRESS broadcast matches actual execution
            tool_call_id = None
            if detected_tools_ordered:
                # Find the Nth occurrence of this tool_name in detected_tools_ordered
                current_usage = detected_tool_usage_count.get(tool_name, 0)
                matches = [(name, tid, ts) for name, tid, ts in detected_tools_ordered if name == tool_name]
                if current_usage < len(matches):
                    tool_call_id = matches[current_usage][1]  # Get the tool_call_id
                    detected_tool_usage_count[tool_name] = current_usage + 1

            # Fallback to new UUID if no pre-assigned ID found
            if not tool_call_id:
                tool_call_id = str(uuid.uuid4())

            # Persist assistant declarations with explicit tool_call_id mapping
            assistant_tool_calls.append(
                {
                    "tool": tool_name,
                    "tool_call_id": tool_call_id,
                    **tool_args,
                }
            )

            # Special: set_plan - track that it was called (for is_plan_loop)
            if tool_name == "set_plan":
                set_plan_called = True

            # Special: attempt_completion - handle separately (should be alone due to llm.py filtering)
            if tool_name == "attempt_completion":
                attempt_completion_tool = (tool_name, tool_args, tool_call_id)
                continue

            processed_tools.append((tool_name, tool_args, tool_call_id))

        # 10. Persist assistant message (including tool-only declaration turns)
        assistant_metadata = {}
        if assistant_tool_calls:
            assistant_metadata["tool_calls"] = assistant_tool_calls
        codex_reasoning_items = getattr(result, "codex_reasoning_items", [])
        if codex_reasoning_items:
            assistant_metadata["codex_reasoning_items"] = codex_reasoning_items
        if not assistant_metadata:
            assistant_metadata = None
        if response_text or assistant_tool_calls:
            if post_message:
                await post_message(response_text, "ASSISTANT", assistant_metadata)
            # When no poll_messages (explore/browser agents in activities, or
            # fully in-memory callers with no post_message), locally append so
            # subsequent TOOL results have their declaring assistant row and
            # the LLM sees its own prior responses.
            if not poll_messages:
                context.append(
                    {
                        "role": "ASSISTANT",
                        "text": response_text or "",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "metadata": assistant_metadata or {},
                    }
                )

        # 11. Execute tool calls (tool_calls is always List[dict] at this point)
        # Execute regular tools in parallel
        if processed_tools and execute_tool:

            async def execute_single_tool(tool_name: str, tool_args: dict, tool_call_id: str):
                """Execute a single tool and return result with metadata."""
                try:
                    async with span(
                        "tool_dispatch",
                        agent_id=agent_id,
                        tool_name=tool_name,
                        tool_call_id=tool_call_id,
                    ):
                        result = await execute_tool(tool_name, tool_args, tool_call_id)
                    return {"tool_name": tool_name, "tool_call_id": tool_call_id, "result": result, "error": None}
                except Exception as e:
                    logger.error(f"Tool {tool_name} failed: {e}")
                    return {"tool_name": tool_name, "tool_call_id": tool_call_id, "result": None, "error": e}

            # Execute all tools in parallel
            tasks = [
                execute_single_tool(tool_name, tool_args, tool_call_id)
                for tool_name, tool_args, tool_call_id in processed_tools
            ]
            tool_results = await asyncio.gather(*tasks)

            # Process results in order (for determinism)
            for tool_result in tool_results:
                tool_name = tool_result["tool_name"]
                tool_call_id = tool_result["tool_call_id"]
                result = tool_result["result"]
                error = tool_result["error"]

                if error:
                    # Tool failed - add error to context
                    if is_inside_temporal_activity and post_message:
                        await post_message(
                            str(error),
                            "TOOL",
                            {
                                "toolCallId": tool_call_id,
                                "toolName": tool_name,
                                "toolStatus": "ERROR",
                                "title": f"{tool_name} failed",
                                "error": True,
                                "subAgentId": task_id,
                            },
                        )
                    # When no poll_messages, locally append error so agent sees it
                    # (omit subAgentId so convert_context_to_messages doesn't filter it)
                    if not poll_messages:
                        context.append(
                            {
                                "role": "TOOL",
                                "text": f"Error: {error}",
                                "timestamp": datetime.now(timezone.utc).isoformat(),
                                "metadata": {
                                    "toolCallId": tool_call_id,
                                    "toolName": tool_name,
                                    "toolStatus": "ERROR",
                                    "error": True,
                                },
                            }
                        )
                    continue

                # Check for special status returns (used by browser agent)
                if isinstance(result, dict):
                    result_status = result.get("status", "").lower()

                    if result_status == "needs_user_help":
                        return {
                            "status": "needs_user_help",
                            "context": context,
                            "tokens_in": tokens_in,
                            "tokens_out": tokens_out,
                            "token_count": token_count,
                            "context_size": context_size,
                            "cache_read_input_tokens": cache_read_total,
                            "cache_creation_input_tokens": cache_write_total,
                            **result,
                        }

                    if result_status == "completed":
                        return {
                            "status": "completed",
                            "context": context,
                            "tokens_in": tokens_in,
                            "tokens_out": tokens_out,
                            "token_count": token_count,
                            "context_size": context_size,
                            "cache_read_input_tokens": cache_read_total,
                            "cache_creation_input_tokens": cache_write_total,
                            **result,
                        }

                # Add successful result to context
                is_error = isinstance(result, dict) and result.get("error", False)
                # Check for nested result with its own message (from NEW_SIGNATURE_TOOLS)
                if isinstance(result, dict) and isinstance(result.get("result"), dict):
                    nested_result = result["result"]
                    result_message = nested_result.get("message", result.get("message", ""))
                else:
                    result_message = result.get("message", "") if isinstance(result, dict) else str(result)

                if is_error:
                    new_msg = {
                        "role": "TOOL",
                        "text": f"Error: {result_message}",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "metadata": {
                            "toolCallId": tool_call_id,
                            "toolName": tool_name,
                            "toolStatus": "ERROR",
                            "error": True,
                        },
                    }
                else:
                    new_msg = {
                        "role": "TOOL",
                        "text": result_message,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "metadata": {
                            "toolCallId": tool_call_id,
                            "toolName": tool_name,
                            "toolStatus": "FINISHED",
                        },
                    }
                logger.debug(
                    "Tool result posted to DB (will be picked up by poll)",
                    tool_name=tool_name,
                    context_len=len(context),
                )
                # When no poll_messages, locally append so agent sees tool results
                if not poll_messages:
                    context.append(new_msg)

                # Track set_plan success (only if no error)
                if tool_name == "set_plan" and not is_error:
                    set_plan_succeeded = True

        # Repetition detection: if the agent keeps calling the same tools with identical
        # args, it's stuck. Inject a strong nudge after 3 consecutive identical iterations.
        if processed_tools:
            call_sig = hashlib.md5(
                json.dumps(
                    sorted([(t, json.dumps(a, sort_keys=True, default=str)) for t, a, _ in processed_tools]),
                    sort_keys=True,
                ).encode()
            ).hexdigest()
            recent_call_hashes.append(call_sig)
            if len(recent_call_hashes) >= 3 and len(set(list(recent_call_hashes)[-3:])) == 1:
                same_call_streak += 1
                logger.warning(
                    f"[run_agent] Repetitive tool calls detected (streak={same_call_streak}): "
                    f"{[t for t, _, _ in processed_tools]}"
                )
                context.append(
                    {
                        "role": "SYSTEM",
                        "text": (
                            f"WARNING: You have called the same tool(s) with identical arguments "
                            f"{same_call_streak + 2} times in a row without making progress. "
                            "The previous approach is not working. You MUST try a fundamentally different strategy: "
                            "use different arguments, a different tool, or decompose the problem differently. "
                            "Do not repeat the same call again."
                        ),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                )
            else:
                same_call_streak = 0

        # Handle attempt_completion separately (should be alone due to llm.py filtering)
        if attempt_completion_tool:
            tool_name, tool_args, tool_call_id = attempt_completion_tool

            # PLAN phase: require set_plan to have succeeded (not just called)
            if is_plan_loop and not set_plan_succeeded:
                error_msg = (
                    "set_plan must succeed before attempt_completion in PLAN phase. If set_plan failed, retry it."
                    if set_plan_called
                    else "You must call set_plan before attempt_completion in PLAN phase"
                )
                logger.warning(error_msg)

                # Emit error via handle_tool_event (poll_messages will pick it up next iteration)
                await handle_tool_event(
                    event=ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title="❌ Plan required",
                        message=error_msg,
                        status=MessageStatus.ERROR,
                    ),
                    agent_id=agent_id,
                    tool_call_id=tool_call_id,
                    tool_name=tool_name,
                    execute_activity=execute_activity,
                    user_id=user_id,
                )
                # Continue to next iteration (don't process attempt_completion)
            else:
                # Execute the tool first (it posts its own IN_PROGRESS/FINISHED)
                if execute_tool:
                    try:
                        execution_tool_args = dict(tool_args)
                        if not skip_verification and not is_plan_loop:
                            execution_tool_args["_verification_pending"] = True
                        async with span(
                            "tool_dispatch",
                            agent_id=agent_id,
                            tool_name=tool_name,
                            tool_call_id=tool_call_id,
                        ):
                            await execute_tool(tool_name, execution_tool_args, tool_call_id)
                    except Exception as e:
                        logger.warning(f"attempt_completion tool error (non-fatal): {e}")

                # When no poll_messages, locally append the attempt_completion
                # result so the verifier sees the current iteration's artifact.
                # Uses "text"/"timestamp" — build_llm_messages and check_progress
                # both read "text" and depend on "timestamp" for ordering.
                # The verifier reads prior tool results, not
                # attempt_completion.result. Preserve the assistant narration
                # here for verified flows and legacy unverified fallbacks.
                if not poll_messages:
                    context.append(
                        {
                            "role": "TOOL",
                            "text": response_text or "",
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "metadata": {
                                "toolCallId": tool_call_id,
                                "toolName": tool_name,
                                "toolStatus": "FINISHED",
                            },
                        }
                    )

                # PLAN phase: complete immediately after attempt_completion
                if is_plan_loop:
                    logger.info("✅ PLAN phase complete")

                    _log_cache_summary("completed")
                    return {
                        "status": "completed",
                        "context": context,
                        "tokens_in": tokens_in,
                        "tokens_out": tokens_out,
                        "token_count": token_count,
                        "context_size": context_size,
                        "cache_read_input_tokens": cache_read_total,
                        "cache_creation_input_tokens": cache_write_total,
                        "message": "",
                    }

                # Skip LLM verification if requested
                if skip_verification:
                    logger.info("⏭️ Skipping LLM verification")
                    # Sub-agent → parent handoff: prefer the explicit
                    # attempt_completion.result payload. Fall back to the
                    # assistant narration for older callers/models.
                    completion_result = response_text or ""
                    if isinstance(tool_args, dict):
                        result_arg = tool_args.get("result")
                        if isinstance(result_arg, str) and result_arg.strip():
                            completion_result = result_arg
                        elif result_arg is not None:
                            completion_result = str(result_arg)
                    _log_cache_summary("completed-no-verify")
                    return {
                        "status": "completed",
                        "context": context,
                        "tokens_in": tokens_in,
                        "tokens_out": tokens_out,
                        "token_count": token_count,
                        "context_size": context_size,
                        "cache_read_input_tokens": cache_read_total,
                        "cache_creation_input_tokens": cache_write_total,
                        "message": "",
                        "final_response": completion_result,
                    }

                # Poll DB to pick up messages posted this iteration (ASSISTANT + TOOL results)
                # before the verifier reads context. Without this, the verifier would see
                # stale context missing the current iteration's tool results.
                if poll_messages:
                    last_checked = await poll_and_update_context(poll_messages, context, last_checked)

                # Run verifier

                # Use response_schema passed from caller (already fetched with agent config)
                # Resolve Claude token for verifier (same as main LLM call)
                verifier_claude_token = get_claude_token() if get_claude_token else claude_token
                verifier_claude_token_source = get_claude_token_source() if get_claude_token_source else None
                verifier_claude_token_pool_id = get_claude_token_pool_id() if get_claude_token_pool_id else None
                verifier_gpt_token = get_gpt_token() if get_gpt_token else gpt_token
                verifier_gpt_account_id = get_gpt_account_id() if get_gpt_account_id else gpt_account_id
                verifier_gpt_token_source = get_gpt_token_source() if get_gpt_token_source else None
                verifier_gpt_token_pool_id = get_gpt_token_pool_id() if get_gpt_token_pool_id else None

                verifier_result = await _run_verifier(
                    execute_activity=execute_activity,
                    context=context,
                    verifier_prompt_generator=verifier_prompt_generator,
                    model=model,
                    agent_id=agent_id,
                    task_id=task_id,
                    post_message=post_message,
                    response_schema=response_schema,
                    get_response_schema=get_response_schema,
                    claude_token=verifier_claude_token,
                    claude_token_source=verifier_claude_token_source,
                    claude_token_pool_id=verifier_claude_token_pool_id,
                    claude_token_user_id=user_id,
                    gpt_token=verifier_gpt_token,
                    gpt_account_id=verifier_gpt_account_id,
                    gpt_token_source=verifier_gpt_token_source,
                    gpt_token_pool_id=verifier_gpt_token_pool_id,
                    gpt_token_user_id=user_id,
                    is_plan_loop=is_plan_loop,
                    tool_call_id=tool_call_id,
                )

                # Track verifier tokens
                v_usage = verifier_result.get("usage", {})
                v_tokens_in = v_usage.get("prompt_tokens", 0)
                v_tokens_out = v_usage.get("completion_tokens", 0)
                tokens_in += v_tokens_in
                tokens_out += v_tokens_out
                token_count += v_usage.get("total_tokens", 0)

                # Route verifier cost through on_tokens for proper cost tracking
                if on_tokens and (v_tokens_in > 0 or v_tokens_out > 0):
                    try:
                        await on_tokens(
                            v_tokens_in,
                            v_tokens_out,
                            v_usage.get("actual_model"),
                            cache_read_input_tokens=v_usage.get("cache_read_input_tokens", 0),
                            cache_creation_input_tokens=v_usage.get("cache_creation_input_tokens", 0),
                            call_site="verifier_plan" if is_plan_loop else "verifier_execute",
                            claude_token_error=v_usage.get("claude_token_error"),
                            gpt_token_error=v_usage.get("gpt_token_error"),
                            claude_token_rotated=v_usage.get("claude_token_rotated", False),
                            gpt_token_rotated=v_usage.get("gpt_token_rotated", False),
                            compute_token_used=v_usage.get("compute_token_used"),
                        )
                    except Exception as e:
                        logger.warning(f"on_tokens callback failed for verifier: {e}")

                score = verifier_result.get("score", 0.0)
                v_reasoning = verifier_result.get("reasoning", "")
                structured_response = verifier_result.get("structured_response")

                # Track consecutive verifier errors (score=0.5 with "Progress check failed" reasoning)
                if v_reasoning.startswith("Progress check failed"):
                    consecutive_verifier_errors += 1
                    logger.warning(
                        f"[run_agent] Verifier failed (consecutive={consecutive_verifier_errors}): {v_reasoning[:100]}"
                    )
                    if consecutive_verifier_errors >= 3:
                        return {
                            "status": "error",
                            "context": context,
                            "tokens_in": tokens_in,
                            "tokens_out": tokens_out,
                            "token_count": token_count,
                            "context_size": context_size,
                            "cache_read_input_tokens": cache_read_total,
                            "cache_creation_input_tokens": cache_write_total,
                            "message": f"Verifier unavailable after {consecutive_verifier_errors} consecutive failures: {v_reasoning}",
                        }
                else:
                    consecutive_verifier_errors = 0

                # Track score history for trend feedback (keep last 5)
                recent_verifier_scores.append(score)
                if len(recent_verifier_scores) > 5:
                    recent_verifier_scores.pop(0)

                # If complete, exit (blueprint saved in workflow._mark_complete)
                if score >= 1.0:
                    _log_cache_summary("completed-verified")
                    return {
                        "status": "completed",
                        "context": context,
                        "tokens_in": tokens_in,
                        "tokens_out": tokens_out,
                        "token_count": token_count,
                        "context_size": context_size,
                        "cache_read_input_tokens": cache_read_total,
                        "cache_creation_input_tokens": cache_write_total,
                        "message": v_reasoning,
                        "score": score,
                        "structured_response": structured_response,
                    }

                # Not complete - add feedback to context, including score trend
                feedback_text = f"Verifier: {score * 100:.0f}% - {v_reasoning}"
                if len(recent_verifier_scores) > 1:
                    trend = " → ".join(f"{s * 100:.0f}%" for s in recent_verifier_scores)
                    feedback_text += f"\nScore trend: {trend}"
                feedback_text += "\n\nIMPORTANT: Your ASSISTANT text responses are NOT visible to the verifier. Only TOOL results (tool call outputs, files, structured responses) are evaluated. If you have completed work but scored low, you must produce visible output through tool calls — e.g., use spawn_claude_code_agent to write results to files, or use other tools that produce visible TOOL messages."
                if not poll_messages:
                    context.append(
                        {
                            "role": "TOOL",
                            "text": feedback_text,
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "metadata": {
                                "toolCallId": tool_call_id,
                                "toolName": "attempt_completion",
                                "toolStatus": "FINISHED",
                                "title": f"Progress: {score * 100:.0f}%",
                            },
                        }
                    )

        # Handle no-tool-calls: if LLM returned text but no tools, nudge it
        if not tool_calls and not attempt_completion_tool:
            no_tool_count += 1
            logger.warning(f"LLM returned no tool calls (iteration {iteration}, count={no_tool_count})")

            if no_tool_count >= 3:
                logger.error(f"LLM failed to call tools {no_tool_count} times — returning error")
                return {
                    "status": "error",
                    "context": context,
                    "tokens_in": tokens_in,
                    "tokens_out": tokens_out,
                    "token_count": token_count,
                    "context_size": context_size,
                    "cache_read_input_tokens": cache_read_total,
                    "cache_creation_input_tokens": cache_write_total,
                    "message": f"LLM returned no tool calls {no_tool_count} consecutive times",
                }

            if is_plan_loop:
                nudge = (
                    "You MUST call tools to make progress. Available tools: set_plan, attempt_completion, spawn_agent (explore), send_message_to_user. "
                    "Start by calling set_plan with your execution plan, then call attempt_completion."
                )
            else:
                nudge = "You MUST call tools to make progress. Review the plan and call the appropriate tool to continue execution."
            context.append(
                {
                    "role": "SYSTEM",
                    "text": nudge,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
            )
        else:
            # Reset no-tool counter on successful tool call
            no_tool_count = 0

    # Clean up shared state before exiting loop
    _pending_llm_context.pop(agent_id, None)

    # Max iterations reached - run final verifier to capture current state
    logger.warning(f"Max iterations reached: {max_iterations}")

    # Run verifier one final time to get accurate progress and partial structured data
    final_verifier_progress = 0.0
    final_verifier_reasoning = ""
    final_partial_structured_response = None

    if verifier_prompt_generator and not skip_verification:
        try:
            # Final poll to ensure context has all messages before verifier
            if poll_messages:
                last_checked = await poll_and_update_context(poll_messages, context, last_checked)
            logger.info("Running final verifier to capture failure context...")
            final_verifier_claude_token = get_claude_token() if get_claude_token else claude_token
            final_verifier_claude_token_source = get_claude_token_source() if get_claude_token_source else None
            final_verifier_claude_token_pool_id = get_claude_token_pool_id() if get_claude_token_pool_id else None
            final_verifier_gpt_token = get_gpt_token() if get_gpt_token else gpt_token
            final_verifier_gpt_account_id = get_gpt_account_id() if get_gpt_account_id else gpt_account_id
            final_verifier_gpt_token_source = get_gpt_token_source() if get_gpt_token_source else None
            final_verifier_gpt_token_pool_id = get_gpt_token_pool_id() if get_gpt_token_pool_id else None
            final_verifier_result = await _run_verifier(
                execute_activity=execute_activity,
                context=context,
                verifier_prompt_generator=verifier_prompt_generator,
                model=model,
                agent_id=agent_id,
                task_id=task_id,
                post_message=post_message,
                response_schema=response_schema,
                get_response_schema=get_response_schema,
                claude_token=final_verifier_claude_token,
                claude_token_source=final_verifier_claude_token_source,
                claude_token_pool_id=final_verifier_claude_token_pool_id,
                claude_token_user_id=user_id,
                gpt_token=final_verifier_gpt_token,
                gpt_account_id=final_verifier_gpt_account_id,
                gpt_token_source=final_verifier_gpt_token_source,
                gpt_token_pool_id=final_verifier_gpt_token_pool_id,
                gpt_token_user_id=user_id,
                is_plan_loop=is_plan_loop,
            )

            # Track final verifier tokens
            v_usage = final_verifier_result.get("usage", {})
            v_tokens_in = v_usage.get("prompt_tokens", 0)
            v_tokens_out = v_usage.get("completion_tokens", 0)
            tokens_in += v_tokens_in
            tokens_out += v_tokens_out
            token_count += v_usage.get("total_tokens", 0)

            # Route final verifier cost through on_tokens for proper cost tracking
            if on_tokens and (v_tokens_in > 0 or v_tokens_out > 0):
                try:
                    await on_tokens(
                        v_tokens_in,
                        v_tokens_out,
                        v_usage.get("actual_model"),
                        cache_read_input_tokens=v_usage.get("cache_read_input_tokens", 0),
                        cache_creation_input_tokens=v_usage.get("cache_creation_input_tokens", 0),
                        call_site="verifier_plan" if is_plan_loop else "verifier_execute",
                        claude_token_error=v_usage.get("claude_token_error"),
                        gpt_token_error=v_usage.get("gpt_token_error"),
                        claude_token_rotated=v_usage.get("claude_token_rotated", False),
                        gpt_token_rotated=v_usage.get("gpt_token_rotated", False),
                        compute_token_used=v_usage.get("compute_token_used"),
                    )
                except Exception as e:
                    logger.warning(f"on_tokens callback failed for final verifier: {e}")

            final_verifier_progress = final_verifier_result.get("score", 0.0)
            final_verifier_reasoning = final_verifier_result.get("reasoning", "")
            final_partial_structured_response = final_verifier_result.get("structured_response")

            logger.info(f"Final verifier: {final_verifier_progress * 100:.0f}% - {final_verifier_reasoning[:100]}...")
        except Exception as e:
            logger.error(f"Final verifier call failed: {e}")

    _log_cache_summary("max_iterations")
    return {
        "status": "max_iterations",
        "context": context,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "token_count": token_count,
        "context_size": context_size,
        "cache_read_input_tokens": cache_read_total,
        "cache_creation_input_tokens": cache_write_total,
        "message": f"Reached max iterations ({max_iterations})",
        # Final verifier results for failure context
        "verifier_progress": final_verifier_progress,
        "verifier_reasoning": final_verifier_reasoning,
        "partial_structured_response": final_partial_structured_response,
    }


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================


def _estimate_tokens(context: List[Dict]) -> int:
    """Rough token estimation: ~4 chars per token.

    Excludes sub-agent internal messages (tagged with subAgentId) since
    these are filtered out before sending to the LLM.
    """
    text = "\n".join([m.get("text", "") for m in context if not (m.get("metadata") or {}).get("subAgentId")])
    return len(text) // 4


async def _compress_context(
    execute_activity,
    context: List[Dict],
    model: str,
    on_tokens: Optional[Callable[..., Awaitable[None]]] = None,
    agent_id: Optional[str] = None,
    user_id: Optional[str] = None,
    claude_token: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
) -> List[Dict]:
    """Compress context using LLM."""
    result = await execute_activity(
        compress_context,
        args=[
            context,
            len(context),
            model,
            claude_token,
            claude_token_source,
            claude_token_pool_id,
            user_id,
            gpt_token,
            gpt_account_id,
            gpt_token_source,
            gpt_token_pool_id,
            user_id,
            agent_id,
        ],
        start_to_close_timeout=timedelta(seconds=60),
        retry_policy=RetryPolicy(maximum_attempts=3),
    )

    # Unpack result (compress_context returns {"learnings": str, "usage": dict})
    learnings = result.get("learnings", "") if isinstance(result, dict) else result
    usage = result.get("usage", {}) if isinstance(result, dict) else {}

    # Route cost through on_tokens for proper tracking
    if on_tokens and usage:
        tokens_in = usage.get("prompt_tokens", 0)
        tokens_out = usage.get("completion_tokens", 0)
        if tokens_in > 0 or tokens_out > 0:
            try:
                await on_tokens(
                    tokens_in,
                    tokens_out,
                    usage.get("actual_model"),
                    cache_read_input_tokens=usage.get("cache_read_input_tokens", 0),
                    cache_creation_input_tokens=usage.get("cache_creation_input_tokens", 0),
                    call_site="context_compression",
                    claude_token_error=usage.get("claude_token_error"),
                    claude_token_rotated=usage.get("claude_token_rotated", False),
                    gpt_token_error=usage.get("gpt_token_error"),
                    gpt_token_rotated=usage.get("gpt_token_rotated", False),
                    compute_token_used=usage.get("compute_token_used"),
                )
            except Exception as e:
                logger.warning(f"on_tokens callback failed for context_compression: {e}")

    return [{"role": "SYSTEM", "text": learnings, "timestamp": datetime.now(timezone.utc).isoformat()}]


async def _run_verifier(
    execute_activity,
    context: List[Dict],
    verifier_prompt_generator: Callable[[], Awaitable[str]],
    model: str,
    agent_id: str,
    task_id: Optional[str],
    post_message: Optional[Callable],
    response_schema: Optional[Dict] = None,
    get_response_schema: Optional[Callable[[], Awaitable[Optional[Dict]]]] = None,
    claude_token: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    claude_token_user_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
    is_plan_loop: bool = False,
    tool_call_id: Optional[str] = None,
) -> Dict:
    """Run verifier to check completion."""
    verifier_call_id = tool_call_id or str(uuid.uuid4())

    # Post IN_PROGRESS
    # C5: Tag the verifier message as the TOOL result of `attempt_completion`
    # so the agent reads the verifier feedback as the natural result of its
    # own tool call. The `verifierMessage` flag is the canonical filter.
    if post_message:
        await post_message(
            "",
            "TOOL",
            {
                "toolCallId": verifier_call_id,
                "toolName": "attempt_completion",
                "toolStatus": "IN_PROGRESS",
                "title": "⚖️ Verifying completion",
                "subAgentId": task_id,
            },
        )

    # Generate verifier prompt at verification time (allows schema polling)
    verifier_prompt = await verifier_prompt_generator()

    # Get response schema dynamically if getter provided (handles race condition with async schema generation)
    current_response_schema = response_schema
    if get_response_schema:
        current_response_schema = await get_response_schema()

    # C7: dead `phase` positional arg has been removed from check_progress;
    # callers no longer pass it. `model` is kept as a positional but ignored
    # internally (verifier always forces rose-1-ultra). All other args are
    # passed positionally because Temporal activities only accept `args=`.
    # C14: context is already agent-scoped — `context` here is the calling
    # agent's own conversation, accumulated from `poll_messages` (filtered
    # by agent_id) and locally-appended tool results. Sub-agents run in
    # separate workflows and never share this list.
    result = await execute_activity(
        check_progress,
        args=[
            context,
            verifier_prompt,
            model,
            current_response_schema,
            claude_token,
            "verifier_plan" if is_plan_loop else "verifier_execute",
            agent_id,
            claude_token_source,
            claude_token_pool_id,
            claude_token_user_id,
            gpt_token,
            gpt_account_id,
            gpt_token_source,
            gpt_token_pool_id,
            gpt_token_user_id,
        ],
        start_to_close_timeout=timedelta(seconds=60),
        retry_policy=RetryPolicy(maximum_attempts=3),
    )

    score = result.get("score", 0.0)
    reasoning = result.get("reasoning", "")
    structured_response = result.get("structured_response")

    # Format message with structured output if present
    message_text = reasoning
    if structured_response and isinstance(structured_response, dict) and len(structured_response) > 0:
        output_lines = ["\n\n**Extracted Output:**"]
        for key, value in structured_response.items():
            # Convert snake_case to Title Case
            formatted_key = key.replace("_", " ").title()
            # Format value (handle arrays)
            if isinstance(value, list):
                formatted_value = ", ".join(str(v) for v in value)
            else:
                formatted_value = str(value) if value is not None else ""
            output_lines.append(f"- **{formatted_key}:** {formatted_value}")
        message_text = reasoning + "\n".join(output_lines)

    # Post FINISHED — same C5 reasoning: surface as the TOOL result of
    # attempt_completion, identified by the verifierMessage flag.
    if post_message:
        await post_message(
            message_text,
            "TOOL",
            {
                "toolCallId": verifier_call_id,
                "toolName": "attempt_completion",
                "toolStatus": "FINISHED",
                "title": f"⚖️ Progress: {score * 100:.0f}%",
                "subAgentId": task_id,
            },
        )

    logger.info(f"Verifier score: {score * 100:.1f}%")
    return result
