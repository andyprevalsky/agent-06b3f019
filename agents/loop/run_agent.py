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
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Deque, Dict, List, Optional, Tuple, Type

from pydantic import BaseModel

# All imports at module level - no inline imports to avoid workflow sandbox issues
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError
from temporalio.exceptions import TimeoutError as TemporalTimeoutError

from helpers.attachment_context import attachment_request_overhead
from helpers.attachments import extract_file_pointer_dicts, resolve_attachments_activity
from helpers.background_agents import is_agent_authored_user_metadata
from helpers.context_compaction import is_excluded_from_model
from helpers.context_limits import AUTOCOMPACT_BUFFER_TOKENS, EFFECTIVE_OUTPUT_RESERVATION
from helpers.context_pointers import annotate_with_pointer
from helpers.handle_tool_event import handle_tool_event
from helpers.jev_progress import JEVSession, prefix_events, with_jev_session
from helpers.llm import (
    LLMStructuredOutputError,
    _completed_child_handoff_identity,
    _completed_child_task_structured_handoff,
    _is_from_ancestor_agent,
    _pending_llm_context,
    build_llm_messages,
    call_llm_activity,
    call_llm_structured_streaming,
    check_progress,
    fetch_compute_token_activity,
    llm_generation_metadata,
)
from helpers.messages import CoalescingStreamBroadcaster, schedule_background_broadcast
from helpers.summarize import ESTIMATE_SAFETY_MULTIPLIER as SUMMARIZE_ESTIMATE_SAFETY_MULTIPLIER
from helpers.summarize import (
    TOOL_RESULT_HARD_CAP_CHARS,
    compaction_saved_ratio,
    compress_context,
    estimate_context_tokens,
)
from helpers.tool_output import RetentionError, preview_tool_text, stated_cut
from helpers.tracing import span, traced
from helpers.update_status import update_agent_status
from helpers.workflow_safe import context_logger
from helpers.workflow_safe import safe_now as _safe_now
from helpers.workflow_safe import safe_uuid4 as _safe_uuid4
from loop.activity_helper import call_temporal_activity_from_activity
from loop.context_utils import poll_and_update_context
from providers.rose.errors import RoseRefusalError
from tools.base import EventType, MessageStatus, ToolEvent
from tools.knowledge_base import query_blueprints
from utils.error_utils import error_chain_has_type, excluded_models_from_error, extract_error_message
from utils.llm_timeouts import (
    STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS,
    VERIFIER_ACTIVITY_TIMEOUT_SECONDS,
)
from utils.rose_desktop import is_rose_desktop_user
from utils.tool_schemas import create_agent_action_model, get_tool_models
from utils.user_tool_models import build_user_tool_registry, llm_declarations

logger = context_logger()


class RequiredTurnToolError(LLMStructuredOutputError):
    """A valid structured result called a tool forbidden on this turn."""


def _validate_required_turn_tool(result: Any, required_tool: Optional[str]) -> None:
    """Reject direct-activity responses that violate a required-tool handoff."""
    if not required_tool:
        return
    tool_names = []
    for tool_call in getattr(result, "tool_calls", None) or []:
        if hasattr(tool_call, "model_dump"):
            payload = tool_call.model_dump()
        elif isinstance(tool_call, dict):
            payload = tool_call
        else:
            payload = {}
        tool_names.append(payload.get("tool"))
    if len(tool_names) != 1 or tool_names[0] != required_tool:
        raise RequiredTurnToolError(f"LLM must call exactly one tool, '{required_tool}'. Got: {tool_names}")


# Check credits every N iterations
CREDIT_CHECK_INTERVAL = 5

# Buffer-based compaction trigger (mirrors Claude Code's autoCompact.ts).
# Reserve room for output + a safety buffer before the model's hard limit, so
# the next LLM call still fits inside the window even after the trigger fires.


def compaction_trigger_tokens(max_context_tokens: int) -> int:
    """Estimated context size at which a context overflows ``max_context_tokens``.

    For Sonnet 200k → effective=180k → trigger=167k. The benchmark grader uses
    this same trigger to decide when judge evidence no longer fits one call.
    """
    return max_context_tokens - EFFECTIVE_OUTPUT_RESERVATION - AUTOCOMPACT_BUFFER_TOKENS


# _estimate_tokens is a chars-÷-4 heuristic that under-counts JSON-heavy tool
# results (observed 308k actual Anthropic tokens reported as <80k). Multiply
# by this safety factor so the trigger fires before we hit the real ceiling.
# Owned by helpers.summarize so the loop and the compactor share one value;
# re-exported here for callers that read it off this module.
ESTIMATE_SAFETY_MULTIPLIER = SUMMARIZE_ESTIMATE_SAFETY_MULTIPLIER

# Compactor circuit-breaker: stop attempting compaction after this many
# consecutive failures so a broken compactor doesn't loop forever.
MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

# If compaction succeeds but saves almost nothing, surface an explicit error
# instead of continuing into the same overflow loop.
MIN_AUTOCOMPACT_SAVINGS_RATIO = 0.10

# Paused-wait loop guards. The top-of-loop pause branch waits for the agent to
# be unpaused. If wait_for_messages() ever returns immediately instead of
# blocking — e.g. an orphaned sub-agent whose parent workflow was terminated,
# so the parent-state query resolves instantly — the loop would busy-spin and
# saturate the Temporal worker, starving every other agent (prod incident
# 2026-07-05). PAUSED_WAIT_FLOOR_SECONDS enforces a hard minimum idle interval
# between paused iterations so the loop can never spin. After
# MAX_CONSECUTIVE_PAUSED_ITERATIONS consecutive paused iterations we stop
# hot-looping entirely and return "paused", handing control to the workflow's
# cold pause handler (wait_condition(not is_paused) + continue_as_new on
# resume) — an efficient zero-CPU wait for both user-paused roots and orphans.
PAUSED_WAIT_FLOOR_SECONDS = 1.0
MAX_CONSECUTIVE_PAUSED_ITERATIONS = 20


def _is_grouped_spawn_tool(tool_name: str, tool_args: Dict[str, Any]) -> bool:
    """Return True for spawn calls that should render in a sub-agent tree."""
    return tool_name == "spawn_agent" and tool_args.get("type") in {"general_purpose", "for_each"}


def _is_refusal_error(exc: BaseException) -> bool:
    current: Optional[BaseException] = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        if isinstance(current, RoseRefusalError):
            return True
        name = type(current).__name__
        message = str(current)
        if name == "RoseRefusalError" or "RoseRefusalError" in message or "stream ended with refusal" in message:
            return True
        seen.add(id(current))
        current = current.__cause__ or current.__context__
    return False


def _resolve_cache_sequence_id(
    *,
    agent_id: str,
    task_id: Optional[str],
    call_site: str,
    override: Optional[str] = None,
) -> str:
    """Return the stable identity for one append-only LLM conversation."""
    if override and override.strip():
        return override.strip()
    if task_id and task_id.strip():
        return f"agent:{agent_id}:task:{task_id.strip()}:call:{call_site}"
    return f"agent:{agent_id}:call:{call_site}"


@traced("run_agent")
@with_jev_session
async def run_agent(
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
    check_paused_before_turn: Optional[Callable[[], Awaitable[bool]]] = None,
    on_unaccepted_turn_retry: Optional[Callable[[], None]] = None,
    check_aborted: Optional[Callable[[], Awaitable[bool]]] = None,
    wait_for_messages: Optional[Callable[[], Awaitable[bool]]] = None,
    on_context_overflow: Optional[Callable[[List[Dict]], Awaitable[None]]] = None,
    check_credits: Optional[Callable[[], Awaitable[None]]] = None,  # Checks credits, sets pause if depleted
    check_generation_handoff: Optional[Callable[[], Awaitable[Optional[str]]]] = None,  # Live task queue if stale
    # For posting messages and executing tools
    post_message: Optional[Callable[[str, str, Optional[Dict]], Awaitable[None]]] = None,
    poll_messages: Optional[Callable[[datetime], Awaitable[List[Dict]]]] = None,  # Takes last_checked timestamp
    # In-activity agents (explore) have no poll_messages; this returns new
    # agent-to-agent context rows to append before each LLM call.
    poll_inbox: Optional[Callable[[], Awaitable[List[Dict]]]] = None,
    execute_tool: Optional[Callable[[str, Dict, str], Awaitable[Dict]]] = None,
    completion_handoff: Optional[Callable[[], Awaitable[Optional[str]]]] = None,
    # Factual status of this agent's still-running background agents, appended
    # to the completion verifier's evidence (None when nothing is pending).
    get_pending_background_status: Optional[Callable[[], Optional[str]]] = None,
    # The workflow's DAG interrupt hook: a user / agent message cancels a running
    # attempt_completion verifier (None: verify to the end).
    verifier_interrupts: Optional[Any] = None,
    # Execute-loop completion hooks: started(context) when an attempt_completion
    # verifier begins, settled(passed) once its verdict is known. The root
    # workflow overlaps its completion summary with the verifier through them.
    on_verification_started: Optional[Callable[[List[Dict]], Awaitable[None]]] = None,
    on_verification_settled: Optional[Callable[[bool], Awaitable[None]]] = None,
    # Environment context (helpers/environment_context.py). Before each turn's
    # poll: append the persisted <environment> row when it differs from the last
    # one in ``context`` (the poll then loads it). Per LLM call: the seed for the
    # unsaved <environment-status> tail appended after the cached prefix.
    sync_environment_context: Optional[Callable[[List[Dict]], Awaitable[None]]] = None,
    get_environment_tail: Optional[Callable[[], Optional[Dict[str, Any]]]] = None,
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
    # Graceful wind-down: when > 0, inject ONE "synthesize & complete now" message
    # into the conversation tail this many turns before the cap, giving the model a
    # clean final turn instead of a hard cut. 0 = disabled (default). Explore opts in.
    winddown_window: int = 0,
    max_context_tokens: int = 200_000,
    reasoning_max_tokens: int = 256,
    # State tracking (for continue_as_new)
    iteration_offset: int = 0,
    demo_cache_position_offset: Optional[int] = None,
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
    get_requirement_revision: Optional[Callable[[], int]] = None,
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
    compute_token_lineage_key: Optional[str] = None,
    compute_token_demo_cache_affinity_key: Optional[str] = None,
    cache_sequence_id: Optional[str] = None,
    # Override the call_site label used when emitting llm.cache. Defaults to
    # "plan_loop"/"execute_loop" based on is_plan_loop. Sub-agents that share
    # this loop (e.g. explore_agent) set this to surface as their own row in
    # cache reports instead of merging with the parent's execute_loop.
    call_site_override: Optional[str] = None,
    # DEMO cache: when enabled, LLM calls record/replay through the
    # backend store keyed by (goal, call_site, iteration). goal_text is the cache
    # namespace (exact-match). Both flow from the workflow; default off = no-op.
    fast_mode_cache_enabled: bool = False,
    goal_text: Optional[str] = None,
    # Pinned user-authored tools (root agent only; see domains/user_tools). Declared
    # after the built-in tools, sorted by name, so the cached tool prefix is stable.
    user_tools: Optional[List[Dict[str, Any]]] = None,
    jev_goal: Optional[str] = None,
    jev_agent_kind: Optional[str] = None,
    get_jev_response_schema: Optional[Callable[[], Optional[Dict[str, Any]]]] = None,
    require_inline_attachments: bool = False,
    _jev_session: Optional[JEVSession] = None,
) -> Dict[str, Any]:
    """
    Run the unified agent loop.

    Returns:
        Dict with:
        - status: "completed" | "paused" | "needs_user_response" | "max_iterations" | "error" | "generation_handoff"
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
    resolved_cache_sequence_id = _resolve_cache_sequence_id(
        agent_id=agent_id,
        task_id=task_id,
        call_site=cache_call_site,
        override=cache_sequence_id,
    )

    tokens_in = 0
    tokens_out = 0
    token_count = 0
    context_size = 0  # Current context window usage (uncached + cached tokens from last LLM call)
    cache_read_total = 0  # Cumulative cache read tokens (prompt caching hits)
    cache_write_total = 0  # Cumulative cache creation tokens (prompt caching misses)
    # Local direct-token state for callers that run this loop inside a Temporal
    # activity (explore/browser-style agents). Those callers pass token values
    # as static activity args, so workflow-level token rotation cannot mutate
    # them between loop iterations. When Rose rotates and succeeds, its usage
    # names the lease that worked (never the credential); re-read that lease
    # so the next iteration starts from the successful provider/token.
    remembered_claude_token = claude_token
    remembered_claude_token_source: Optional[str] = None
    remembered_claude_token_pool_id: Optional[str] = None
    remembered_gpt_token = gpt_token
    remembered_gpt_account_id = gpt_account_id
    remembered_gpt_token_source: Optional[str] = None
    remembered_gpt_token_pool_id: Optional[str] = None
    iteration = iteration_offset
    # DEMO-cache position tracks committed LLM turns, not attempted loop
    # iterations. A transient transport failure must retry the same cache key.
    demo_cache_llm_position = demo_cache_position_offset if demo_cache_position_offset is not None else iteration_offset
    set_plan_called = False  # Track if set_plan was called (for is_plan_loop)
    set_plan_succeeded = False  # Track if set_plan completed successfully (not just called)
    no_tool_count = 0  # Track consecutive iterations with no tool calls
    consecutive_llm_failures = 0  # Track consecutive LLM call failures for early exit
    exclude_anthropic_family_on_llm_retry = False  # Set after refusal to reroute the immediate retry
    # A semantically invalid structured response is a new model turn, not a
    # resumable transport retry. Replaying the same Fast Mode entry would
    # deterministically return the same rejected tool/schema again.
    bypass_fast_mode_cache_on_llm_retry = False
    # Models the structured-output retry excluded after two invalid replies in a
    # previous attempt of the SAME turn. Carried into the next attempt's
    # `_skip_models` so the remaining attempts go to the next candidate instead
    # of handing the same context back to the model that just failed it twice.
    # Reset together with the other retry flags once a response is accepted:
    # the exclusion answers this context's sampling pathology, not the model's
    # fitness for later turns (browser steps, summaries) on the same pool.
    skip_models_on_llm_retry: frozenset[str] = frozenset()
    consecutive_verifier_errors = 0  # Track consecutive verifier failures for early exit
    compactor_failures = 0  # Circuit-breaker: skip compaction after 3 consecutive failures
    ineffective_compactions = 0  # Circuit-breaker for repeated low-value compactions
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

    # Generate stream_id for this session. _safe_uuid4() (not uuid.uuid4()):
    # run_agent is workflow-scope, so raw uuid4 is regenerated on replay and
    # breaks event/id correlation across a worker migration.
    stream_id = str(_safe_uuid4())
    # Per-LLM-turn identity for the `_pending_llm_context` handoff. Deterministic
    # (stream_id + counter) so a replay on another worker reproduces the same tokens.
    pending_context_seq = 0

    # Set up execute_activity based on context (workflow vs activity)
    execute_activity = (
        call_temporal_activity_from_activity if is_inside_temporal_activity else workflow.execute_activity
    )

    async def preview_result(text: str) -> str:
        try:
            # Retention and marker verification both touch storage; neither may
            # run in deterministic workflow code.
            if not is_inside_temporal_activity:
                from tools.read_tool_output import preview_tool_output_activity

                return await execute_activity(
                    preview_tool_output_activity,
                    args=[user_id, agent_id, task_id or "", text, TOOL_RESULT_HARD_CAP_CHARS],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            return await preview_tool_text(
                text, user_id=user_id, agent_id=agent_id, session_id=task_id or "", limit=TOOL_RESULT_HARD_CAP_CHARS,
            )
        except (RetentionError, ActivityError) as error:
            preview_timeout = isinstance(error, ActivityError) and isinstance(error.cause, TemporalTimeoutError)
            if isinstance(error, ActivityError) and not preview_timeout and getattr(error.cause, "type", None) != RetentionError.__name__:
                raise
            # A storage failure must not turn a tool result into a loop error.
            logger.warning("[run_agent] Tool output retention failed; keeping a stated cut", agent_id=agent_id, error=str(error))
            return stated_cut(text, limit=TOOL_RESULT_HARD_CAP_CHARS,
                              reason=("retained readback unavailable after a preview timeout" if preview_timeout
                                      else "retained readback unavailable after a storage failure"))

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

    # Create dynamic action model for structured output. Custom response_model
    # wins (e.g., browser agent). During PLAN we narrow spawn_agent to the
    # explore-only variant (get_tool_models(phase="plan")) so the LLM can't pick an
    # invalid `type` — runtime validation was burning 4 retries per error.
    # Rose Desktop accounts get their tool schemas (utils.rose_desktop); every
    # other account the stock ones.
    base_registry = get_tool_models(phase="plan" if is_plan_loop else None, rose_desktop=is_rose_desktop_user(user_id))
    user_tool_decls = llm_declarations(user_tools) if not response_model else []
    if user_tool_decls:
        AgentAction = create_agent_action_model(
            [*tools, *(decl["name"] for decl in user_tool_decls)],
            tool_registry={**base_registry, **build_user_tool_registry(user_tool_decls)},
        )
    else:
        AgentAction = (
            response_model if response_model else create_agent_action_model(tools, tool_registry=base_registry)
        )

    async def _adopt_served_compute_lease(attempt_usage: Dict[str, Any]) -> None:
        """Adopt the lease RoseClient rotated to inside a successful call.

        Usage carries only the lease identity (never the credential). Inside a
        workflow, ``on_tokens`` re-reads the lineage lease and the token
        getters observe it. Activity-hosted loops have static token args, so
        they re-read the same lineage-bound lease from the backend here.
        """
        nonlocal remembered_claude_token
        nonlocal remembered_claude_token_source
        nonlocal remembered_claude_token_pool_id
        nonlocal remembered_gpt_token
        nonlocal remembered_gpt_account_id
        nonlocal remembered_gpt_token_source
        nonlocal remembered_gpt_token_pool_id

        identity = attempt_usage.get("compute_token_used")
        if not isinstance(identity, dict) or identity.get("type") not in ("claude", "gpt"):
            return
        rotated = bool(
            attempt_usage.get("compute_token_rotated")
            or attempt_usage.get("claude_token_rotated")
            or attempt_usage.get("gpt_token_rotated")
        )
        if not is_inside_temporal_activity:
            return
        if not rotated:
            # The call used the credential passed to this loop; record its
            # lease identity so a semantic retry keeps lease attribution.
            if identity.get("type") == "claude" and remembered_claude_token:
                remembered_claude_token_source = identity.get("source")
                remembered_claude_token_pool_id = identity.get("poolTokenId")
            elif identity.get("type") == "gpt" and remembered_gpt_token:
                remembered_gpt_token_source = identity.get("source")
                remembered_gpt_token_pool_id = identity.get("poolTokenId")
            return
        lease = (
            await fetch_compute_token_activity(
                user_id,
                lineage_key=identity.get("lineageKey") or compute_token_lineage_key,
                agent_id=agent_id,
                demo_cache_affinity_key=compute_token_demo_cache_affinity_key,
                token_type=identity.get("type"),
            )
            if user_id
            else None
        )
        if not lease or lease.get("type") != identity.get("type") or not lease.get("accessToken"):
            # RoseClient already marked the original credential unavailable
            # before rotating; never retry with it.
            remembered_claude_token = None
            remembered_claude_token_source = None
            remembered_claude_token_pool_id = None
            remembered_gpt_token = None
            remembered_gpt_account_id = None
            remembered_gpt_token_source = None
            remembered_gpt_token_pool_id = None
            logger.warning("run_agent rotated compute lease could not be re-read", agent_id=agent_id)
            return
        if lease.get("type") == "claude":
            remembered_claude_token = lease.get("accessToken")
            remembered_claude_token_source = lease.get("source")
            remembered_claude_token_pool_id = lease.get("poolTokenId")
            remembered_gpt_token = None
            remembered_gpt_account_id = None
            remembered_gpt_token_source = None
            remembered_gpt_token_pool_id = None
        else:
            remembered_gpt_token = lease.get("accessToken")
            remembered_gpt_account_id = lease.get("accountId")
            remembered_gpt_token_source = lease.get("source")
            remembered_gpt_token_pool_id = lease.get("poolTokenId")
            remembered_claude_token = None
            remembered_claude_token_source = None
            remembered_claude_token_pool_id = None
        logger.info(
            "run_agent adopted rotated compute lease",
            agent_id=agent_id,
            type=lease.get("type"),
            source=lease.get("source"),
            pool_token_id=lease.get("poolTokenId"),
        )

    def _resolve_current_compute_credentials(*, prefer_remembered: bool = False):
        """Resolve credentials for the next provider attempt.

        An immediate semantic retry must prefer the token that the rejected
        provider attempt actually used. Workflow getters may not have observed
        that in-call rotation yet.
        """
        if prefer_remembered:
            return (
                remembered_claude_token,
                remembered_claude_token_source,
                remembered_claude_token_pool_id,
                remembered_gpt_token,
                remembered_gpt_account_id,
                remembered_gpt_token_source,
                remembered_gpt_token_pool_id,
            )

        current_claude = get_claude_token() if get_claude_token else remembered_claude_token
        current_gpt = get_gpt_token() if get_gpt_token else remembered_gpt_token
        return (
            current_claude,
            (
                get_claude_token_source()
                if get_claude_token_source and current_claude
                else remembered_claude_token_source
            ),
            (
                get_claude_token_pool_id()
                if get_claude_token_pool_id and current_claude
                else remembered_claude_token_pool_id
            ),
            current_gpt,
            (get_gpt_account_id() if get_gpt_account_id and current_gpt else remembered_gpt_account_id),
            (get_gpt_token_source() if get_gpt_token_source and current_gpt else remembered_gpt_token_source),
            (get_gpt_token_pool_id() if get_gpt_token_pool_id and current_gpt else remembered_gpt_token_pool_id),
        )

    async def _account_llm_usage(attempt_usage: Dict[str, Any], *, label: str) -> bool:
        """Account one provider attempt before another attempt can be issued."""
        nonlocal tokens_in
        nonlocal tokens_out
        nonlocal token_count
        nonlocal context_size
        nonlocal cache_read_total
        nonlocal cache_write_total

        llm_tokens_in = attempt_usage.get("prompt_tokens", 0)
        llm_tokens_out = attempt_usage.get("completion_tokens", 0)
        llm_total = attempt_usage.get("total_tokens", 0)
        tokens_in += llm_tokens_in
        tokens_out += llm_tokens_out
        token_count += llm_total

        iter_cache_read = attempt_usage.get("cache_read_input_tokens", 0)
        iter_cache_write = attempt_usage.get("cache_creation_input_tokens", 0)
        await _adopt_served_compute_lease(attempt_usage)
        context_size = llm_tokens_in + iter_cache_read + iter_cache_write
        cache_read_total += iter_cache_read
        cache_write_total += iter_cache_write
        if iter_cache_read > 0 or iter_cache_write > 0:
            total_input = llm_tokens_in + iter_cache_read + iter_cache_write
            cache_pct = round(iter_cache_read / total_input * 100) if total_input > 0 else 0
            logger.info(
                f"💾 Cache i{iteration} ({label}): read={iter_cache_read} write={iter_cache_write} "
                f"uncached={llm_tokens_in} hit={cache_pct}% | cumulative: "
                f"read={cache_read_total} write={cache_write_total}"
            )

        if on_tokens:
            try:
                await on_tokens(
                    llm_tokens_in,
                    llm_tokens_out,
                    attempt_usage.get("actual_model"),
                    cache_read_input_tokens=iter_cache_read,
                    cache_creation_input_tokens=iter_cache_write,
                    call_site=cache_call_site,
                    claude_token_error=attempt_usage.get("claude_token_error"),
                    gpt_token_error=attempt_usage.get("gpt_token_error"),
                    claude_token_rotated=attempt_usage.get("claude_token_rotated", False),
                    gpt_token_rotated=attempt_usage.get("gpt_token_rotated", False),
                    compute_token_used=attempt_usage.get("compute_token_used"),
                    from_fast_cache=attempt_usage.get("from_fast_cache", False),
                    iteration=iteration,
                    cache_sequence_id=attempt_usage.get("cache_sequence_id") or resolved_cache_sequence_id,
                )
            except Exception as e:
                logger.warning(f"on_tokens callback failed: {e}")

        return bool(check_paused and await check_paused())

    def _paused_after_cost_result() -> Dict[str, Any]:
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

    def _log_cache_summary(status: str):
        """Log cache performance summary at end of run."""
        total_input = tokens_in + cache_read_total + cache_write_total
        if total_input > 0 and (cache_read_total > 0 or cache_write_total > 0):
            hit_pct = round(cache_read_total / total_input * 100)
            logger.info(
                f"💾 Cache summary [{status}]: read={cache_read_total} write={cache_write_total} uncached={tokens_in} "
                f"hit={hit_pct}% iterations={iteration} agent={agent_id}"
            )

    def _plan_fsm_line(state: str) -> str:
        """One-line PLAN FSM state label injected into tool results."""
        if state == "PLAN":
            return (
                'FSM_STATE: current=PLAN; purpose="clarify the user\'s goal; if already clear, call set_plan"; '
                "enabled_tools=send_message_to_user,spawn_agent,set_plan; transitions=set_plan->SET_PLAN."
            )
        if state == "SET_PLAN":
            return (
                'FSM_STATE: current=SET_PLAN; purpose="Route between asking the user a question or starting execution"; '
                "enabled_tools=send_message_to_user,attempt_completion; disabled_tools=spawn_agent; "
                "transitions=send_message_to_user->ASK_QUESTION,attempt_completion->EXIT(EXECUTE)."
            )
        if state == "ASK_QUESTION":
            return (
                'FSM_STATE: current=ASK_QUESTION; purpose="Ask any questions needed before entering the EXECUTE phase"; '
                "enabled_tools=send_message_to_user,attempt_completion,spawn_agent; "
                "transitions=attempt_completion->EXIT(EXECUTE),spawn_agent->PLAN."
            )
        return "FSM_STATE: current=EXIT(EXECUTE); terminal=true."

    def _next_plan_fsm_state(state: str, tool_name: str, status: str) -> str:
        """Advance the PLAN FSM using the transition table in PLAN_PHASE_PROMPT."""
        if status not in ("FINISHED", "ERROR"):
            return state
        if tool_name == "set_plan" and status == "FINISHED":
            return "SET_PLAN"
        if tool_name == "send_message_to_user" and status == "FINISHED":
            return "ASK_QUESTION"
        if tool_name == "spawn_agent" and status == "FINISHED":
            return "PLAN"
        if tool_name == "attempt_completion" and status == "FINISHED":
            return "EXIT(EXECUTE)"
        return state

    def _context_with_plan_fsm_labels(raw_context: List[Dict]) -> List[Dict]:
        """Return a copy of context with PLAN FSM labels appended to terminal tool results."""
        if not is_plan_loop:
            return raw_context

        def _parse_ts(msg: Dict) -> float:
            value = msg.get("timestamp")
            if not value:
                return 0.0
            try:
                if isinstance(value, datetime):
                    parsed = value
                else:
                    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
                return parsed.timestamp()
            except Exception:
                return 0.0

        state = "PLAN"
        labelled_by_id: Dict[int, str] = {}
        for msg in sorted(raw_context, key=_parse_ts):
            metadata = msg.get("metadata", {}) or {}
            if msg.get("role") != "TOOL":
                continue
            tool_name = metadata.get("toolName", "")
            status = metadata.get("toolStatus", "")
            state = _next_plan_fsm_state(state, tool_name, status)
            if status in ("FINISHED", "ERROR"):
                labelled_by_id[id(msg)] = _plan_fsm_line(state)

        labelled_context: List[Dict] = []
        for msg in raw_context:
            fsm_line = labelled_by_id.get(id(msg))
            if not fsm_line:
                labelled_context.append(msg)
                continue
            copied = dict(msg)
            text = copied.get("text") or ""
            if "FSM_STATE:" not in text:
                copied["text"] = f"{text}\n\n{fsm_line}" if text else fsm_line
            labelled_context.append(copied)
        return labelled_context

    logger.info(
        "run_agent starting",
        agent_id=agent_id,
        tools=len(tools),
        task_id=task_id,
        is_inside_temporal_activity=is_inside_temporal_activity,
    )

    # Graceful wind-down state: ensures the "final turn" nudge is injected once.
    winddown_injected = False

    # Count of consecutive iterations spent paused. Reset the moment we run real
    # work. Bounds the paused-wait loop (see PAUSED_WAIT_FLOOR_SECONDS /
    # MAX_CONSECUTIVE_PAUSED_ITERATIONS).
    consecutive_paused = 0

    # Main loop
    while iteration < max_iterations:
        # 1. Pull parent/pause state before incrementing the iteration. A parent
        # disappearance discovered by check_paused is terminal and must win over
        # the normal pause path so the child cannot make another LLM/tool call.
        paused = bool(check_paused and await check_paused())
        if check_aborted and await check_aborted():
            _pending_llm_context.pop(agent_id, None)
            return {
                "status": "aborted",
                "context": context,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "token_count": token_count,
                "context_size": context_size,
                "cache_read_input_tokens": cache_read_total,
                "cache_creation_input_tokens": cache_write_total,
            }

        if paused:
            consecutive_paused += 1
            # Cooperative generation handoff while paused: check periodically so
            # a user-paused agent still moves to the live queue without waiting
            # for the 45m force-migrate SLO.
            if check_generation_handoff and (consecutive_paused == 1 or consecutive_paused % 10 == 0):
                try:
                    handoff_queue = await check_generation_handoff()
                except Exception as e:
                    logger.warning(f"Generation handoff check failed while paused (continuing): {e}")
                    handoff_queue = None
                if handoff_queue:
                    logger.info(
                        "run_agent.generation_handoff_while_paused",
                        agent_id=agent_id,
                        consecutive_paused=consecutive_paused,
                        handoff_task_queue=handoff_queue,
                    )
                    _pending_llm_context.pop(agent_id, None)
                    return {
                        "status": "generation_handoff",
                        "handoff_task_queue": handoff_queue,
                        "context": context,
                        "tokens_in": tokens_in,
                        "tokens_out": tokens_out,
                        "token_count": token_count,
                        "context_size": context_size,
                        "cache_read_input_tokens": cache_read_total,
                        "cache_creation_input_tokens": cache_write_total,
                    }
            # Log on the first pause and then only periodically — never every
            # iteration. If the wait below ever fails to block, an unthrottled
            # log would flood the worker (prod incident 2026-07-05: ~30–100
            # "Agent paused, waiting..." lines/sec across orphaned sub-agents).
            if consecutive_paused == 1 or consecutive_paused % 30 == 0:
                logger.info("Agent paused, waiting...", consecutive_paused=consecutive_paused)
            if wait_for_messages:
                # Wait for unpause (workflow) or poll (activity)
                with contextlib.suppress(asyncio.TimeoutError):
                    await wait_for_messages()
            else:
                await asyncio.sleep(1)
            # Hard floor: guarantee a minimum idle interval between paused
            # iterations. Without this an orphaned sub-agent whose parent
            # workflow was terminated (parent-state query returns instantly
            # instead of blocking) busy-spins this loop and starves the worker.
            # Safe in both contexts: a durable timer in the workflow, a normal
            # sleep in the activity path.
            await asyncio.sleep(PAUSED_WAIT_FLOOR_SECONDS)
            # Escape hatch: after too many consecutive paused iterations, stop
            # hot-looping and return "paused". The workflow's cold pause handler
            # (wait_condition(not is_paused) + continue_as_new on resume) then
            # takes over — a zero-CPU idle wait for user-paused roots and a
            # harmless idle state for orphans, instead of an unbounded hot loop.
            if consecutive_paused >= MAX_CONSECUTIVE_PAUSED_ITERATIONS:
                logger.warning(
                    "Agent paused for too many consecutive iterations — yielding to cold pause handler",
                    agent_id=agent_id,
                    consecutive_paused=consecutive_paused,
                )
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
            continue

        # Reached only when not paused — reset the paused-iteration counter.
        consecutive_paused = 0

        # Only increment iteration when we're actually going to do work
        iteration += 1
        demo_cache_step = demo_cache_llm_position + 1

        # 1.4. Graceful wind-down (opt-in via winddown_window). On the final turn(s)
        # before the cap, inject ONE message into the conversation tail (NOT the
        # cached system prompt) telling the model to synthesize and complete now.
        # Mirrors Hermes' single grace call — no earlier pressure warnings (they make
        # models give up prematurely), injected exactly once.
        if winddown_window > 0 and not winddown_injected and iteration >= max_iterations - winddown_window:
            context.append(
                {
                    "role": "SYSTEM",
                    "text": (
                        "You are on your final turn. Do not search further — synthesize the "
                        "grounded evidence you already have and call attempt_completion_with_result "
                        "now with your best answer, explicitly noting any gaps you could not fill."
                    ),
                    "timestamp": _safe_now().isoformat(),
                }
            )
            winddown_injected = True
            logger.info(
                "run_agent.winddown_injected", agent_id=agent_id, iteration=iteration, max_iterations=max_iterations
            )

        # 1.5. Check credits periodically (callback sets is_paused if depleted)
        if check_credits and (iteration % CREDIT_CHECK_INTERVAL == 0):
            try:
                await check_credits()
                # If callback set is_paused, next iteration will catch it
            except Exception as e:
                logger.warning(f"Credit check failed (continuing): {e}")

        # 1.6. Cooperative generation handoff — only between turns (tools/LLM done).
        # If the live AgentQueuePointer points at a newer generation queue, yield so
        # the workflow can continue_as_new onto that queue before the next LLM call.
        if check_generation_handoff:
            try:
                handoff_queue = await check_generation_handoff()
            except Exception as e:
                logger.warning(f"Generation handoff check failed (continuing): {e}")
                handoff_queue = None
            if handoff_queue:
                logger.info(
                    "run_agent.generation_handoff",
                    agent_id=agent_id,
                    iteration=iteration,
                    handoff_task_queue=handoff_queue,
                )
                _pending_llm_context.pop(agent_id, None)
                return {
                    "status": "generation_handoff",
                    "handoff_task_queue": handoff_queue,
                    "context": context,
                    "tokens_in": tokens_in,
                    "tokens_out": tokens_out,
                    "token_count": token_count,
                    "context_size": context_size,
                    "cache_read_input_tokens": cache_read_total,
                    "cache_creation_input_tokens": cache_write_total,
                }

        # 1.7. Environment block: appended (and polled in below) only when it changed.
        if sync_environment_context and poll_messages:
            try:
                await sync_environment_context(context)
            except Exception as e:
                logger.warning(f"Environment context sync failed (continuing): {e}")

        # 2. Poll for new messages (pass our own last_checked, not workflow's)
        if poll_messages:
            last_checked = await poll_and_update_context(poll_messages, context, last_checked)
        elif poll_inbox:
            # Agent-to-agent messages for in-activity agents. A failed poll must
            # never end the agent; the callback logs its own failures.
            try:
                context.extend(await poll_inbox())
            except Exception as e:
                logger.error("run_agent.poll_inbox_failed", agent_id=agent_id, task_id=task_id, error=str(e)[:200])

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
                                    "timestamp": _safe_now().isoformat(),
                                }
                            )
                        logger.info(f"Added {len(blueprints)} blueprints to context")
                except Exception as e:
                    logger.warning(f"Blueprint query failed (non-fatal): {e}")

        # 5. Check context size - compress if needed.
        #
        # Buffer-based trigger (mirrors Claude Code's autoCompact.ts):
        #   effective_window   = max_context_tokens - EFFECTIVE_OUTPUT_RESERVATION
        #   compaction_trigger = effective_window - AUTOCOMPACT_BUFFER_TOKENS
        # For Sonnet 200k → effective=180k → trigger=167k.
        effective_window = max_context_tokens - EFFECTIVE_OUTPUT_RESERVATION
        compaction_trigger = compaction_trigger_tokens(max_context_tokens)
        async with span(
            "run_loop.context_token_estimate",
            agent_id=agent_id,
            iteration=iteration,
            context_messages=len(context),
            agent_type="explore" if cache_call_site == "explore_agent" else None,
        ):
            context_tokens = _estimate_tokens(context)

        if context_tokens >= compaction_trigger and compactor_failures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES:
            # Breaker open while the context is still over the trigger. Falling
            # through would send an over-window context to the model on every
            # remaining iteration and fail with a provider-side length error
            # that says nothing about compaction. Fail loudly instead.
            message = (
                "Context compression unavailable: compactor failed "
                f"{compactor_failures} consecutive times and the context estimate "
                f"{context_tokens} tokens still exceeds trigger {compaction_trigger}."
            )
            logger.error(
                "Compactor circuit breaker open with context still over trigger",
                context_tokens=context_tokens,
                trigger=compaction_trigger,
                compactor_failures=compactor_failures,
            )
            return {
                "status": "error",
                "context": context,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "token_count": token_count,
                "context_size": context_size,
                "cache_read_input_tokens": cache_read_total,
                "cache_creation_input_tokens": cache_write_total,
                "message": message,
            }

        if context_tokens >= compaction_trigger and compactor_failures < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES:
            logger.info(
                "Context overflow",
                context_tokens=context_tokens,
                trigger=compaction_trigger,
                effective_window=effective_window,
            )
            compression_claude_token = get_claude_token() if get_claude_token else claude_token
            compression_claude_token_source = get_claude_token_source() if get_claude_token_source else None
            compression_claude_token_pool_id = get_claude_token_pool_id() if get_claude_token_pool_id else None
            compression_gpt_token = get_gpt_token() if get_gpt_token else gpt_token
            compression_gpt_account_id = get_gpt_account_id() if get_gpt_account_id else gpt_account_id
            compression_gpt_token_source = get_gpt_token_source() if get_gpt_token_source else None
            compression_gpt_token_pool_id = get_gpt_token_pool_id() if get_gpt_token_pool_id else None
            compressed, success = await _compress_context(
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
                compute_token_lineage_key=compute_token_lineage_key,
                compute_token_demo_cache_affinity_key=compute_token_demo_cache_affinity_key,
            )

            if success:
                compressed_tokens = _estimate_tokens(compressed)
                # Signed on purpose: a compaction that GREW the context must not
                # be indistinguishable from one that saved nothing. The old
                # max(0.0, ...) clamp reported 0.0 for the -0.4% growth in prod
                # agent e14d5abb. Negative values are still < the minimum, so
                # the MIN_AUTOCOMPACT_SAVINGS_RATIO check below is unchanged in
                # direction — it just now sees the real number.
                saved_ratio = compaction_saved_ratio(context_tokens, compressed_tokens)

                if compressed_tokens >= compaction_trigger:
                    message = (
                        "Context compression ineffective: compressed context estimate "
                        f"{compressed_tokens} tokens still exceeds trigger {compaction_trigger} "
                        f"(original estimate {context_tokens})."
                    )
                    logger.error(
                        "Compaction did not get below overflow trigger",
                        context_tokens=context_tokens,
                        compressed_tokens=compressed_tokens,
                        trigger=compaction_trigger,
                        saved_ratio=saved_ratio,
                    )
                    return {
                        "status": "error",
                        "context": context,
                        "tokens_in": tokens_in,
                        "tokens_out": tokens_out,
                        "token_count": token_count,
                        "context_size": context_size,
                        "cache_read_input_tokens": cache_read_total,
                        "cache_creation_input_tokens": cache_write_total,
                        "message": message,
                    }

                if saved_ratio < MIN_AUTOCOMPACT_SAVINGS_RATIO:
                    ineffective_compactions += 1
                    message = (
                        "Context compression ineffective: compressed context saved only "
                        f"{saved_ratio:.1%} of estimated tokens "
                        f"(original {context_tokens}, compressed {compressed_tokens})."
                    )
                    logger.warning(
                        "Compaction saved too little",
                        context_tokens=context_tokens,
                        compressed_tokens=compressed_tokens,
                        saved_ratio=saved_ratio,
                        minimum=MIN_AUTOCOMPACT_SAVINGS_RATIO,
                        ineffective_compactions=ineffective_compactions,
                    )
                    if ineffective_compactions >= 2:
                        return {
                            "status": "error",
                            "context": context,
                            "tokens_in": tokens_in,
                            "tokens_out": tokens_out,
                            "token_count": token_count,
                            "context_size": context_size,
                            "cache_read_input_tokens": cache_read_total,
                            "cache_creation_input_tokens": cache_write_total,
                            "message": message,
                        }
                else:
                    ineffective_compactions = 0

                compactor_failures = 0
                if on_context_overflow:
                    # Workflow: will call continue_as_new (never returns)
                    await on_context_overflow(compressed)
                # Activity: just use compressed context
                context = compressed
            else:
                compactor_failures += 1
                logger.warning(
                    "Compaction failed; keeping original context",
                    failures=compactor_failures,
                    limit=MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
                )

        # Admit a browser completion turn only after handoff and compaction
        # boundaries. A continue-as-new before a model call must preserve it.
        if check_paused_before_turn and await check_paused_before_turn():
            iteration -= 1
            continue

        # Schema and message preparation share the existing pre-acceptance
        # retry owner; no provider response or productive turn exists yet.
        llm_response_accepted = False
        try:
            if get_response_schema:
                response_schema = await get_response_schema()

            # A browser/code child has already run its own verifier before emitting
            # a terminal structured_response. When that response covers every
            # parent output field, the parent verifier has a deterministic fast
            # path for accepting it. Synthesize attempt_completion below so the
            # normal verifier and completion persistence still run without paying
            # for (or depending on) an LLM to repeat an action we already know.
            completed_child_output = None
            completed_child_tool_call_id = ""
            if not is_plan_loop and not skip_verification and "attempt_completion" in tools:
                completed_child_handoff = _completed_child_task_structured_handoff(context, response_schema)
                if completed_child_handoff:
                    completed_child_output, completed_child_tool_call_id = completed_child_handoff
            completion_instruction = None
            # Keep the provider-visible tool schema stable across turns. The
            # completion instruction tells the model what to do and required_tool
            # enforces it at the activity boundary; narrowing this list would move
            # the native tool/schema block at the front of the provider prompt and
            # invalidate the growing-conversation cache prefix.
            turn_tools = tools
            required_turn_tool = None
            if completed_child_output is not None:
                required_turn_tool = "attempt_completion"
                completion_instruction = (
                    "A previously delegated browser or code task already completed and returned verified structured "
                    "output covering every required parent response field. Do not repeat that work or spawn another "
                    "agent. Call attempt_completion now so the parent verifier can accept the completed child result."
                )
                logger.info(
                    "run_agent.completed_child_forces_completion",
                    agent_id=agent_id,
                    iteration=iteration,
                    output_fields=sorted(completed_child_output),
                )

            # Only history visible before this turn; prediction runs beside the decision.
            if _jev_session is not None:
                current_jev_goal = jev_goal or goal_text or next(
                    (m.get("text", "") for m in context if m.get("role", "").upper() == "USER"), ""
                )
                _jev_session.schedule(
                    current_jev_goal, get_jev_response_schema() if get_jev_response_schema else response_schema,
                    prefix_events(context, task_id),
                )

            # 6. Build system prompt (calls API for fresh shared memory each iteration)
            async with span(
                "run_loop.system_prompt",
                agent_id=agent_id,
                iteration=iteration,
                agent_type="explore" if cache_call_site == "explore_agent" else None,
            ):
                current_system_prompt = await system_prompt()

            # 7. Build messages for LLM
            # Use custom builder if provided (e.g., browser uses compress_messages for multimodal)
            async with span(
                "run_loop.prepare_llm_context",
                agent_id=agent_id,
                iteration=iteration,
                context_messages=len(context),
                agent_type="explore" if cache_call_site == "explore_agent" else None,
            ):
                llm_context = _context_with_plan_fsm_labels(context)

            # A slot left on another worker by an earlier turn (this workflow migrated
            # away mid-run) never carries this token, so call_llm_activity cannot build
            # this turn's prompt from that stale conversation.
            pending_context_seq += 1
            pending_context_token = f"{stream_id}:{pending_context_seq}"

            if build_messages:
                async with span(
                    "run_loop.build_messages_custom",
                    agent_id=agent_id,
                    iteration=iteration,
                    context_messages=len(llm_context),
                    agent_type="explore" if cache_call_site == "explore_agent" else None,
                ):
                    messages = build_messages(llm_context, current_system_prompt)
            elif not is_inside_temporal_activity:
                # Workflow context: pre-download files, then defer message building to call_llm_activity
                # so that base64 content never crosses Temporal's 2MB payload boundary.
                # The resolve activity populates _file_cache (shared in-process memory).
                # call_llm_activity reads from _pending_llm_context + _file_cache.
                pre_resolved_ids = None
                file_pointer_dicts = extract_file_pointer_dicts(llm_context)
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
                    llm_context,
                    current_system_prompt,
                    pre_resolved_ids,
                    user_id,
                    pending_context_token,
                )
                messages = None  # Signals to use shared state path below
            else:
                async with span(
                    "run_loop.build_llm_messages",
                    agent_id=agent_id,
                    iteration=iteration,
                    context_messages=len(llm_context),
                    agent_type="explore" if cache_call_site == "explore_agent" else None,
                ):
                    messages = await build_llm_messages(
                        llm_context,
                        current_system_prompt,
                        user_id=user_id,
                        agent_id=agent_id,
                        session_id=task_id or "",
                        max_context_tokens=max_context_tokens,
                        request_overhead=attachment_request_overhead(AgentAction, completion_instruction),
                        require_inline_attachments=require_inline_attachments,
                    )
            if is_inside_temporal_activity and completion_instruction and messages is not None:
                messages.append({"role": "user", "content": completion_instruction})

            # Resolve direct compute tokens dynamically when the workflow provides
            # getters; otherwise use this loop's remembered successful token state.
            (
                current_claude_token,
                current_claude_token_source,
                current_claude_token_pool_id,
                current_gpt_token,
                current_gpt_account_id,
                current_gpt_token_source,
                current_gpt_token_pool_id,
            ) = _resolve_current_compute_credentials()

            # 7. Call LLM with structured streaming
            # Only a failure BEFORE a usable response is a retry of this iteration.
            # Once the provider returns and we accept the response, the turn has
            # really been spent (tokens are charged in _account_llm_usage below), so
            # a later failure in accounting/broadcast must NOT refund the iteration.
            if completed_child_output is not None:
                child_identity = _completed_child_handoff_identity(completed_child_tool_call_id)
                identity_segment = f"{child_identity}-" if child_identity else ""
                synthetic_tool_call_id = f"completed-child-attempt-completion-{identity_segment}{_safe_uuid4()}"
                result = type(
                    "CompletedChildAction",
                    (),
                    {
                        "response": "",
                        "tool_calls": [{"tool": "attempt_completion"}],
                        "codex_reasoning_items": [],
                    },
                )()
                usage = {}
                detected_tools_ordered = [("attempt_completion", synthetic_tool_call_id, _safe_now().timestamp())]
                llm_response_accepted = True
                logger.info(
                    "run_agent.completed_child_dispatches_completion",
                    agent_id=agent_id,
                    iteration=iteration,
                    tool_call_id=synthetic_tool_call_id,
                )
            elif is_inside_temporal_activity:
                # Inside activity (browser agent) - call LLM directly with streaming callback
                sequence = [0]
                last_text = [""]
                llm_started_at_ms = int(_safe_now().timestamp() * 1000)
                last_raw_progress_chars = [0]
                start_event = ToolEvent(
                    type=EventType.STREAM_MESSAGE,
                    stream_id=stream_id,
                    delta="",
                    done=False,
                    sequence=sequence[0],
                    sub_agent_id=task_id,
                    llm_started_at_ms=llm_started_at_ms,
                )

                async def _send_stream_start(_start_event: ToolEvent = start_event) -> None:
                    async with span(
                        "stream.start_event",
                        agent_id=agent_id,
                        stream_id=stream_id,
                        agent_type="explore" if cache_call_site == "explore_agent" else None,
                    ):
                        await handle_tool_event(
                            event=_start_event,
                            agent_id=agent_id,
                            tool_call_id=stream_id,
                            tool_name="llm_call",
                            execute_activity=execute_activity,
                            user_id=user_id,
                            sub_agent_id=task_id,
                        )

                background_stream_start = cache_call_site == "explore_agent" and fast_mode_cache_enabled
                if background_stream_start:
                    schedule_background_broadcast(_send_stream_start(), label="stream.start")
                else:
                    await _send_stream_start()
                sequence[0] += 1

                # Decouple Supabase broadcasting from the token-read loop. Awaiting
                # a broadcast per chunk inline collapsed per-stream throughput under
                # high fan-out (root-caused on da938195); the broadcaster accepts
                # deltas non-blocking and flushes them coalesced in the background.
                broadcaster = CoalescingStreamBroadcaster(
                    agent_id=agent_id,
                    stream_id=stream_id,
                    sub_agent_id=task_id,
                    llm_started_at_ms=llm_started_at_ms,
                )

                async def on_chunk(
                    text_so_far: str,
                    token_count_chunk: int,
                    *,
                    _last_text: List[str] = last_text,
                    _broadcaster: CoalescingStreamBroadcaster = broadcaster,
                    _sequence: List[int] = sequence,
                ):
                    # Heartbeat so Temporal knows the activity is alive during long LLM calls
                    if is_inside_temporal_activity:
                        activity.heartbeat(f"LLM streaming: {token_count_chunk} tokens")

                    # Check if paused mid-stream
                    if check_paused:
                        async with span("stream.check_paused", agent_id=agent_id, stream_id=stream_id):
                            paused = await check_paused()
                        if paused:
                            raise asyncio.CancelledError("Paused")

                    delta = text_so_far[len(_last_text[0]) :]
                    if delta:
                        _broadcaster.update(delta, _sequence[0])
                        _sequence[0] += 1
                        _last_text[0] = text_so_far

                async def on_raw_progress(
                    total_chars: int,
                    *,
                    _broadcaster: CoalescingStreamBroadcaster = broadcaster,
                    _sequence: List[int] = sequence,
                    _last_raw: List[int] = last_raw_progress_chars,
                ):
                    if is_inside_temporal_activity:
                        activity.heartbeat(f"LLM streaming: {total_chars} raw bytes")
                    if total_chars - _last_raw[0] < 50:
                        return
                    _last_raw[0] = total_chars
                    _broadcaster.update_progress(total_chars, _sequence[0])
                    _sequence[0] += 1

                # Fast Mode: the inline path (explore / browser sub-agents that run
                # run_agent INSIDE an activity) bypasses call_llm_activity, so it must
                # set the cache context itself. Keys are canonical request fingerprints;
                # goal+enabled auto-resolve from the agent row when not threaded explicitly.
                # Lazy import — this branch only runs inside an activity (explore/
                # browser), never in the workflow sandbox, so keep demo_cache out of
                # run_agent's module-level import graph.
                from providers.demo_cache.client import ensure_position_context
                from providers.demo_cache.context import (
                    DemoCacheContext,
                    set_context,
                )

                if goal_text and fast_mode_cache_enabled:
                    from providers.demo_cache.client import (
                        resolve_agent_fast_mode,
                        resolve_soft_complete_root_goal,
                    )

                    root_goal = await resolve_soft_complete_root_goal(agent_id, goal_text)
                    _e, _g, _w, _r, _rg, provider_fast_mode = (
                        await resolve_agent_fast_mode(agent_id) if agent_id else (False, None, False, None, None, True)
                    )
                    set_context(
                        DemoCacheContext(
                            enabled=True,
                            goal=goal_text,
                            base_step=demo_cache_step,
                            write_enabled=True,
                            root_goal=root_goal,
                            provider_fast_mode=provider_fast_mode,
                        )
                    )
                else:
                    await ensure_position_context(agent_id, demo_cache_step)

                # Retry up to 3 times on parse failures (matches workflow path's RetryPolicy).
                # The try/finally guarantees the broadcaster's background drainer is
                # always disposed, including on pause or a re-raised parse failure.
                max_llm_attempts = 3
                try:
                    for llm_attempt in range(1, max_llm_attempts + 1):
                        attempt_usage = None
                        try:
                            async with span(
                                "call_llm",
                                agent_id=agent_id,
                                model=model,
                                call_site=cache_call_site,
                                llm_attempt=llm_attempt,
                                agent_type="explore" if cache_call_site == "explore_agent" else None,
                                context_messages=len(llm_context),
                                request_message_count=len(messages) if messages is not None else None,
                                gpt_auth_present=bool(current_gpt_token),
                                claude_auth_present=bool(current_claude_token),
                            ):
                                # Required-tool enforcement is semantic and must
                                # not replace a caller-provided response model
                                # (browser agents use specialized tool schemas).
                                turn_response_model = AgentAction
                                pydantic_result, usage, detected_tools_ordered = await call_llm_structured_streaming(
                                    messages=messages,
                                    model=model,
                                    temperature=1.0,
                                    max_tokens=8192,
                                    response_model=turn_response_model,
                                    on_chunk=on_chunk,
                                    on_raw_progress=on_raw_progress,
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
                                    compute_token_lineage_key=compute_token_lineage_key,
                                    compute_token_demo_cache_affinity_key=compute_token_demo_cache_affinity_key,
                                    cache_sequence_id=resolved_cache_sequence_id,
                                    call_site=cache_call_site,
                                    _exclude_anthropic_family=exclude_anthropic_family_on_llm_retry,
                                    _skip_models=skip_models_on_llm_retry,
                                )
                                attempt_usage = usage
                                _validate_required_turn_tool(pydantic_result, required_turn_tool)
                            break  # Success
                        except Exception as e:
                            error_message = extract_error_message(e)
                            retryable_structured_result = "Failed to parse" in error_message or (
                                required_turn_tool is not None and error_chain_has_type(e, "RequiredTurnToolError")
                            )
                            required_tool_rejected = required_turn_tool is not None and error_chain_has_type(
                                e, "RequiredTurnToolError"
                            )
                            if required_tool_rejected and attempt_usage is not None:
                                if await _account_llm_usage(
                                    attempt_usage,
                                    label=f"rejected semantic attempt {llm_attempt}",
                                ):
                                    logger.info("Agent paused after rejected-attempt cost check")
                                    return _paused_after_cost_result()
                            if llm_attempt < max_llm_attempts and retryable_structured_result:
                                skip_models_on_llm_retry = skip_models_on_llm_retry | excluded_models_from_error(e)
                                logger.warning(
                                    f"[run_agent] LLM structured result rejected (attempt {llm_attempt}/{max_llm_attempts}), retrying",
                                    error=error_message,
                                    skip_models=sorted(skip_models_on_llm_retry),
                                )
                                if required_tool_rejected:
                                    # The live response was structurally valid
                                    # but semantically rejected. An active Fast
                                    # Mode context could replay that same wrong
                                    # tool forever, so only semantic retries
                                    # bypass reads/writes. Transport retries keep
                                    # the original trajectory position.
                                    set_context(
                                        DemoCacheContext(
                                            enabled=False,
                                            goal=goal_text or "",
                                            base_step=demo_cache_step,
                                            write_enabled=False,
                                        )
                                    )
                                    (
                                        current_claude_token,
                                        current_claude_token_source,
                                        current_claude_token_pool_id,
                                        current_gpt_token,
                                        current_gpt_account_id,
                                        current_gpt_token_source,
                                        current_gpt_token_pool_id,
                                    ) = _resolve_current_compute_credentials(
                                        prefer_remembered=bool(
                                            is_inside_temporal_activity
                                            and attempt_usage
                                            and attempt_usage.get("compute_token_used")
                                        )
                                    )
                                # Keep sequence monotonic because this retry reuses
                                # the same stream_id and may follow emitted chunks.
                                last_text[0] = ""
                                broadcaster.reset()
                                continue
                            raise

                    # Validated provider response in hand. Everything below
                    # (tool-call normalization, stream close, drainer dispose)
                    # is post-response bookkeeping, so a failure there must not
                    # refund the turn — its tokens are already spent.
                    llm_response_accepted = True

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

                    # Final stream chunk - done=True. aclose() stops the drainer,
                    # flushes any buffered delta, then sends the done marker.
                    final_delta = ""
                    if pydantic_result.response:
                        final_delta = pydantic_result.response[len(last_text[0]) :]
                    await_done_broadcast = not (cache_call_site == "explore_agent" and fast_mode_cache_enabled)
                    with contextlib.suppress(Exception):
                        await broadcaster.aclose(
                            final_delta=final_delta,
                            final_sequence=sequence[0],
                            await_done_broadcast=await_done_broadcast,
                        )
                finally:
                    # Guarantee the background drainer never leaks, even on error/pause.
                    await broadcaster.adispose()
            else:
                call_site_label = cache_call_site
                llm_result = await workflow.execute_activity(
                    call_llm_activity,
                    args=[
                        agent_id,
                        model,
                        turn_tools,
                        reasoning_max_tokens,
                        agent_id,
                        stream_id,
                        task_id,
                        current_claude_token,
                        call_site_label,
                        current_system_prompt,
                        completion_instruction,
                        required_turn_tool,
                        False,
                        "",
                        current_claude_token_source,
                        current_claude_token_pool_id,
                        user_id,
                        current_gpt_token,
                        current_gpt_account_id,
                        current_gpt_token_source,
                        current_gpt_token_pool_id,
                        user_id,
                        compute_token_lineage_key,
                        compute_token_demo_cache_affinity_key,
                        user_id,
                        fast_mode_cache_enabled and not bypass_fast_mode_cache_on_llm_retry,
                        goal_text,
                        demo_cache_step,
                        False,
                        False,
                        resolved_cache_sequence_id,
                        # Appended LAST on purpose: these args are positional and recorded in
                        # Temporal history, so a new parameter may only be added at the end, where
                        # an older replayed history falls back to the default.
                        exclude_anthropic_family_on_llm_retry,
                        pending_context_token,
                        get_environment_tail() if get_environment_tail else None,
                        max_context_tokens,
                        require_inline_attachments,
                        user_tool_decls or None,
                        sorted(skip_models_on_llm_retry) or None,
                    ],
                    start_to_close_timeout=timedelta(seconds=STANDARD_LLM_ACTIVITY_TIMEOUT_SECONDS),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                    heartbeat_timeout=timedelta(seconds=180),
                )

                # The activity returned a validated payload; the turn is spent.
                llm_response_accepted = True

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

            # Account the successful provider attempt. Semantically rejected
            # attempts were already accounted before their retries above. A
            # deterministic child-completion handoff did not call a provider,
            # so it must not emit a synthetic zero-token billing event.
            exclude_anthropic_family_on_llm_retry = False
            bypass_fast_mode_cache_on_llm_retry = False
            skip_models_on_llm_retry = frozenset()
            paused_after_provider_cost = completed_child_output is None and await _account_llm_usage(
                usage,
                label="accepted attempt",
            )
            if paused_after_provider_cost:
                # External PAUSE between LLM acceptance and tool dispatch must
                # not discard already-returned tool_calls. Dropping a forced
                # attempt_completion here leaves the agent ACTIVE after a
                # successful child handoff (see
                # test_pause_after_forced_completion_llm_still_dispatches_attempt_completion).
                pending_tool_calls = result.tool_calls if hasattr(result, "tool_calls") else []
                if pending_tool_calls:
                    logger.info(
                        "Agent paused after cost check with pending tool_calls; dispatching before pause",
                        tool_count=len(pending_tool_calls),
                    )
                else:
                    logger.info("Agent paused after cost check")
                    return _paused_after_cost_result()

            if completed_child_output is None:
                demo_cache_llm_position = demo_cache_step

            # Persist + broadcast own tokens after each LLM call. Descendant
            # subtree totals have their own durable maps in AgentWorkflow.
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
                                    tokens_in,
                                    tokens_out,
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
                                tokens_in,
                                tokens_out,
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
            if any(
                error_chain_has_type(e, kind)
                for kind in (
                    "CancelledError",
                    "WorkflowGenerationSealed",
                    "GenerationHandoffRequested",
                )
            ):
                _pending_llm_context.pop(agent_id, None)
                raise
            consecutive_llm_failures += 1
            error_message = extract_error_message(e)
            logger.error(f"LLM call failed (consecutive={consecutive_llm_failures}): {error_message}")
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
                    "message": f"LLM call failed {consecutive_llm_failures} consecutive times: {error_message}",
                }
            # A failed LLM call produced no assistant turn, no tool call, and no
            # context growth — it is a retry of this iteration, not a new one.
            # Counting it would let transient provider/schema errors eat the
            # agent's remaining turns: agent 16ae3e8f's explore sub-agent had
            # completed 18 turns of real work, then spent iterations 19 and 20
            # on two failed parses and died on "Reached max iterations (20)"
            # without ever getting another chance to act. The retry budget
            # (consecutive_llm_failures, capped at 3 above) bounds this path;
            # max_iterations bounds productive work.
            #
            # Scoped to pre-acceptance failures only: once the provider returned
            # a usable response the turn really was spent (tokens are charged),
            # so a later accounting/broadcast error must not refund it.
            if not llm_response_accepted:
                iteration -= 1
                if on_unaccepted_turn_retry:
                    on_unaccepted_turn_retry()
            if error_chain_has_type(e, "LLMStructuredOutputError"):
                # call_llm_activity marks schema/required-tool violations
                # non-retryable so Temporal does not multiply requests. The
                # agent loop owns the bounded semantic retry instead. That
                # retry must generate a fresh response rather than resume a
                # cached response that already violated the contract.
                bypass_fast_mode_cache_on_llm_retry = True
                skip_models_on_llm_retry = skip_models_on_llm_retry | excluded_models_from_error(e)
                logger.info(
                    "run_agent.structured_output_retry",
                    agent_id=agent_id,
                    iteration=iteration,
                    consecutive_failures=consecutive_llm_failures,
                    skip_models=sorted(skip_models_on_llm_retry),
                )
            if _is_refusal_error(e):
                exclude_anthropic_family_on_llm_retry = True
                logger.info(
                    "run_agent.llm_retry_excluding_anthropic",
                    agent_id=agent_id,
                    iteration=iteration,
                    consecutive_failures=consecutive_llm_failures,
                )
                continue
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
        turn_spawn_group_id = None

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

            # Fallback to new UUID if no pre-assigned ID found. _safe_uuid4()
            # for replay-stability (raw uuid4 re-mints on replay → split bubbles).
            if not tool_call_id:
                tool_call_id = str(_safe_uuid4())

            # Persist assistant declarations with explicit tool_call_id mapping
            assistant_tool_calls.append(
                {
                    "tool": tool_name,
                    "tool_call_id": tool_call_id,
                    **tool_args,
                }
            )

            if _is_grouped_spawn_tool(tool_name, tool_args):
                if turn_spawn_group_id is None:
                    phase_label = "plan" if is_plan_loop else "execute"
                    turn_spawn_group_id = f"llm-turn:{phase_label}:{iteration}:{tool_call_id}"
                tool_args["_spawn_group_id"] = turn_spawn_group_id

            # Special: set_plan - track that it was called (for is_plan_loop)
            if tool_name == "set_plan":
                set_plan_called = True

            # Special: attempt_completion (verified) and attempt_completion_with_result
            # (skip_verification) - handle separately. They should be alone in the turn
            # due to llm.py filtering.
            if tool_name in ("attempt_completion", "attempt_completion_with_result"):
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
        # The thought row's duration / ↓ tokens / tok/s (UI-only; no message builder reads it).
        generation = llm_generation_metadata(usage) if response_text else None
        if generation:
            assistant_metadata["generation"] = generation
        if not assistant_metadata:
            assistant_metadata = None
        if response_text or assistant_tool_calls:
            if post_message:
                async with span(
                    "run_loop.post_assistant_message",
                    agent_id=agent_id,
                    iteration=iteration,
                    role="ASSISTANT",
                    has_tool_calls=bool(assistant_tool_calls),
                    text_len=len(response_text or ""),
                    context_messages=len(context),
                    agent_type="explore" if cache_call_site == "explore_agent" else None,
                ):
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
                        "timestamp": _safe_now().isoformat(),
                        "metadata": assistant_metadata or {},
                    }
                )

        # 11. Execute tool calls (tool_calls is always List[dict] at this point)
        # Execute regular tools in parallel
        if processed_tools and execute_tool:
            if is_inside_temporal_activity and fast_mode_cache_enabled:
                try:
                    from providers.demo_cache import client as demo_cache_client
                    from providers.demo_cache import normalize as demo_cache_normalize
                    from providers.demo_cache.context import current_context
                    from tools.web_search.config import DEFAULT_MAX_TOKENS as WEB_SEARCH_DEFAULT_MAX_TOKENS

                    ctx = current_context()
                    prewarm_goal = goal_text or (ctx.goal if ctx is not None else None)
                    prewarm_keys = []
                    if prewarm_goal:
                        for tool_name, tool_args, _tool_call_id in processed_tools:
                            if tool_name == "web_search":
                                prewarm_keys.append(
                                    demo_cache_normalize.web_search_key(
                                        prewarm_goal,
                                        str(tool_args.get("query", "")),
                                        tool_args.get("max_tokens", WEB_SEARCH_DEFAULT_MAX_TOKENS),
                                    )
                                )
                            elif tool_name == "web_fetch":
                                prewarm_keys.append(
                                    demo_cache_normalize.web_fetch_key(
                                        prewarm_goal,
                                        str(tool_args.get("url", "")),
                                    )
                                )
                    if prewarm_keys:
                        await demo_cache_client.prefetch_cache_records(prewarm_keys, reason="tool_dispatch")
                except Exception as exc:
                    logger.warning(
                        "demo_cache.tool_prewarm_failed",
                        agent_id=agent_id,
                        iteration=iteration,
                        error=str(exc)[:200],
                    )

            async def execute_single_tool(tool_name: str, tool_args: dict, tool_call_id: str):
                """Execute a single tool and return result with metadata."""
                try:
                    async with span(
                        "tool_dispatch",
                        agent_id=agent_id,
                        tool_name=tool_name,
                        tool_call_id=tool_call_id,
                        span_source="agents.loop.run_agent.run_agent.execute_single_tool",
                        span_key="agents.loop.run_agent.run_agent.execute_single_tool",
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
            in_tool_handoff_queue: Optional[str] = None
            async with span(
                "run_loop.process_tool_results",
                agent_id=agent_id,
                iteration=iteration,
                tool_result_count=len(tool_results),
                context_messages=len(context),
                agent_type="explore" if cache_call_site == "explore_agent" else None,
            ):
                for tool_result in tool_results:
                    tool_name = tool_result["tool_name"]
                    tool_call_id = tool_result["tool_call_id"]
                    result = tool_result["result"]
                    error = tool_result["error"]

                    if error:
                        # Tool failed. Do NOT post an FE chip here: the tool layer
                        # already owns the terminal chip for this tool_call_id and
                        # posts a formatted one (params, elapsed, cost) before it
                        # re-raises — see domains/web_fetch/handler.py,
                        # domains/grep/service.py, tools/web_search/handler.py,
                        # tools/people_search/handler.py. The FE resolves a chip by
                        # toolCallId with last write wins, so a second row here
                        # DELETED the tool's formatted chip and replaced it with a
                        # bare exception string.
                        # docs/rca/cases/2026-08-19-explore-fe-posts-race-into-last-write-wins-chip-id.md
                        #
                        # The model's own error feedback is the context.append below,
                        # which is independent of the FE post.
                        #
                        # When no poll_messages, locally append error so agent sees it
                        # (omit subAgentId so convert_context_to_messages doesn't filter it)
                        if not poll_messages:
                            context.append(
                                {
                                    "role": "TOOL",
                                    "text": await preview_result(f"Error: {error}"),
                                    "timestamp": _safe_now().isoformat(),
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

                    # Activity-mode agents (explore/browser leaves) append
                    # locally. Bound the payload so one grep/email dump cannot
                    # push the protected compaction tail past the overflow
                    # trigger (prod a890a362: 228k→210k still above 167k).
                    if not poll_messages:
                        result_message = await preview_result(result_message or "")
                    if is_error:
                        new_msg = {
                            "role": "TOOL",
                            "text": f"Error: {result_message}",
                            "timestamp": _safe_now().isoformat(),
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
                            "timestamp": _safe_now().isoformat(),
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
                    if isinstance(result, dict) and result.get("pending_tool_resume"):
                        # Parked across the handoff: the next generation re-enters
                        # this call and posts its real result before the next LLM turn.
                        pass
                    elif not poll_messages:
                        context.append(new_msg)
                    elif isinstance(result, dict) and result.get("generation_handoff"):
                        # Cut over this turn; poll will not run again before continue_as_new.
                        context.append(new_msg)

                    if isinstance(result, dict) and result.get("generation_handoff"):
                        handoff_queue = result.get("handoff_task_queue")
                        if isinstance(handoff_queue, str) and handoff_queue.strip():
                            in_tool_handoff_queue = handoff_queue.strip()

                    # Track set_plan success (only if no error)
                    if tool_name == "set_plan" and not is_error:
                        set_plan_succeeded = True
            if in_tool_handoff_queue:
                _pending_llm_context.pop(agent_id, None)
                return {
                    "status": "generation_handoff",
                    "handoff_task_queue": in_tool_handoff_queue,
                    "context": context,
                    "tokens_in": tokens_in,
                    "tokens_out": tokens_out,
                    "token_count": token_count,
                    "context_size": context_size,
                    "cache_read_input_tokens": cache_read_total,
                    "cache_creation_input_tokens": cache_write_total,
                }
        # Repetition detection: if the agent keeps calling the same tools with identical
        # args, it's stuck. Inject a strong nudge after 3 consecutive identical iterations.
        if processed_tools:
            async with span(
                "run_loop.repetition_detection",
                agent_id=agent_id,
                iteration=iteration,
                processed_tool_count=len(processed_tools),
                agent_type="explore" if cache_call_site == "explore_agent" else None,
            ):
                call_sig = hashlib.md5(
                    json.dumps(
                        sorted([(t, json.dumps(a, sort_keys=True, default=str)) for t, a, _ in processed_tools]),
                        sort_keys=True,
                    ).encode()
                ).hexdigest()
                recent_call_hashes.append(call_sig)
                if len(recent_call_hashes) >= 3 and len(set(list(recent_call_hashes)[-3:])) == 1:
                    same_call_streak += 1
                    tool_names = [t for t, _, _ in processed_tools]
                    logger.warning(
                        f"[run_agent] Repetitive tool calls detected (streak={same_call_streak}): {tool_names}"
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
                            "timestamp": _safe_now().isoformat(),
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
                completion_tool_result = None
                completion_tool_error = None
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
                            span_source="agents.loop.run_agent.run_agent.attempt_completion_dispatch",
                            span_key="agents.loop.run_agent.run_agent.attempt_completion_dispatch",
                        ):
                            completion_tool_result = await execute_tool(tool_name, execution_tool_args, tool_call_id)
                    except Exception as e:
                        completion_tool_error = str(e)
                        logger.warning(f"attempt_completion tool error: {e}")

                if isinstance(completion_tool_result, dict) and completion_tool_result.get("error"):
                    completion_tool_error = str(
                        completion_tool_result.get("message") or "Completion was rejected by the tool executor"
                    )

                if skip_verification and completion_handoff and not completion_tool_error:
                    completion_tool_error = await completion_handoff()

                # Completion is a normal tool boundary. If its executor rejects
                # the call, show that error to the same model and continue the
                # loop instead of treating the rejected call as terminal.
                if completion_tool_error:
                    error_metadata = {
                        "toolCallId": tool_call_id,
                        "toolName": tool_name,
                        "toolStatus": "ERROR",
                        "title": f"{tool_name} rejected",
                        "error": True,
                        "subAgentId": task_id,
                    }
                    completion_error_posted = False
                    if post_message:
                        try:
                            await post_message(
                                await preview_result(completion_tool_error),
                                "TOOL",
                                error_metadata,
                            )
                            completion_error_posted = True
                        except Exception as post_error:
                            logger.warning(
                                "Failed to persist rejected completion; keeping it in local context",
                                agent_id=agent_id,
                                tool_name=tool_name,
                                error=str(post_error),
                            )
                    if not poll_messages or not completion_error_posted:
                        context.append(
                            {
                                "role": "TOOL",
                                "text": await preview_result(f"Error: {completion_tool_error}"),
                                "timestamp": _safe_now().isoformat(),
                                "metadata": {
                                    key: value for key, value in error_metadata.items() if key != "subAgentId"
                                },
                            }
                        )
                    logger.info(
                        "run_agent.completion_rejected",
                        agent_id=agent_id,
                        iteration=iteration,
                        tool_name=tool_name,
                        reason=completion_tool_error,
                    )
                    continue

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
                            "timestamp": _safe_now().isoformat(),
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

                verifier_error = None
                speculate_completion = not is_plan_loop and on_verification_started is not None
                if speculate_completion:
                    authored = tool_args.get("result") if isinstance(tool_args, dict) else None
                    try:
                        # The summary sees what the verifier sees, including the
                        # attempt's own authored result.
                        await on_verification_started(_with_authored_result(context, authored, tool_call_id or ""))
                    except Exception as hook_error:
                        if any(
                            error_chain_has_type(hook_error, kind)
                            for kind in ("CancelledError", "WorkflowGenerationSealed", "GenerationHandoffRequested")
                        ):
                            raise
                        # Optional speedup only: verification and the serial summary proceed.
                        logger.warning(
                            "[run_agent] Speculative completion summary did not start",
                            agent_id=agent_id,
                            error=extract_error_message(hook_error),
                        )
                try:
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
                        poll_messages=poll_messages,
                        get_requirement_revision=get_requirement_revision,
                        claude_token=verifier_claude_token,
                        claude_token_source=verifier_claude_token_source,
                        claude_token_pool_id=verifier_claude_token_pool_id,
                        claude_token_user_id=user_id,
                        gpt_token=verifier_gpt_token,
                        gpt_account_id=verifier_gpt_account_id,
                        gpt_token_source=verifier_gpt_token_source,
                        gpt_token_pool_id=verifier_gpt_token_pool_id,
                        gpt_token_user_id=user_id,
                        compute_token_lineage_key=compute_token_lineage_key,
                        compute_token_demo_cache_affinity_key=compute_token_demo_cache_affinity_key,
                        is_plan_loop=is_plan_loop,
                        tool_call_id=tool_call_id,
                        fast_mode_cache_enabled=fast_mode_cache_enabled,
                        fast_mode_goal=goal_text,
                        fast_mode_step=demo_cache_step,
                        pending_background_status=(
                            get_pending_background_status() if get_pending_background_status else None
                        ),
                        authored_result=(tool_args.get("result") if isinstance(tool_args, dict) else None),
                        interrupts=verifier_interrupts,
                    )
                except Exception as error:
                    if any(
                        error_chain_has_type(error, kind)
                        for kind in (
                            "CancelledError",
                            "WorkflowGenerationSealed",
                            "GenerationHandoffRequested",
                        )
                    ):
                        raise
                    verifier_error = error
                else:
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
                                from_fast_cache=v_usage.get("from_fast_cache", False),
                                # Do not label a one-shot verifier as the execute
                                # conversation unless that exact namespace reached
                                # the provider. The benchmark repeatability metric
                                # groups by this identity.
                                cache_sequence_id=v_usage.get("cache_sequence_id"),
                            )
                        except Exception as e:
                            logger.warning(f"on_tokens callback failed for verifier: {e}")

                    score = verifier_result.get("score", 0.0)
                    v_reasoning = verifier_result.get("reasoning", "")
                    structured_response = verifier_result.get("structured_response")

                if speculate_completion and verifier_error is not None and on_verification_settled is not None:
                    await on_verification_settled(False)

                # Track raised verifier errors and existing "Progress check failed" results.
                if verifier_error is not None or v_reasoning.startswith("Progress check failed"):
                    verifier_failure_reason = (
                        extract_error_message(verifier_error) if verifier_error is not None else v_reasoning
                    )
                    consecutive_verifier_errors += 1
                    logger.warning(
                        f"[run_agent] Verifier failed (consecutive={consecutive_verifier_errors}): {verifier_failure_reason[:100]}"
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
                            "message": f"Verifier unavailable after {consecutive_verifier_errors} consecutive failures: {verifier_failure_reason}",
                        }
                else:
                    consecutive_verifier_errors = 0

                if verifier_error is not None:
                    no_tool_count = 0
                    continue

                # Track score history for trend feedback (keep last 5)
                recent_verifier_scores.append(score)
                if len(recent_verifier_scores) > 5:
                    recent_verifier_scores.pop(0)

                # The verifier posted IN_PROGRESS + FINISHED tool_result rows to
                # the DB for this attempt_completion call. Without a refresh, the
                # locally-returned context still only contains the handler's
                # IN_PROGRESS row — and any downstream LLM call serializing
                # context as a Codex Responses API conversation sees an orphan
                # function_call (no matching function_call_output), which 400s
                # with "No tool output found for function call <id>". Pull the
                # verifier's FINISHED row back into context here so the pair is
                # closed on every exit path below.
                if poll_messages:
                    last_checked = await poll_and_update_context(poll_messages, context, last_checked)
                elif tool_call_id and not any(
                    msg.get("role") == "TOOL"
                    and (msg.get("metadata") or {}).get("toolCallId") == tool_call_id
                    and (msg.get("metadata") or {}).get("toolStatus") == "FINISHED"
                    for msg in context
                ):
                    context.append(
                        {
                            "role": "TOOL",
                            "text": v_reasoning or "",
                            "timestamp": _safe_now().isoformat(),
                            "metadata": {
                                "toolCallId": tool_call_id,
                                "toolName": "attempt_completion",
                                "toolStatus": "FINISHED",
                                "title": f"⚖️ Progress: {score * 100:.0f}%",
                                "verifierMessage": True,
                            },
                        }
                    )

                if _verifier_superseded_by_user_feedback(
                    verifier_result,
                    context,
                    get_requirement_revision() if get_requirement_revision else None,
                ):
                    if speculate_completion and on_verification_settled is not None:
                        await on_verification_settled(False)
                    recent_verifier_scores.pop()
                    continue

                if speculate_completion and on_verification_settled is not None:
                    await on_verification_settled(score >= 1.0)

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
                        "_verified_user_requirement_keys": verifier_result.get("_verified_user_requirement_keys"),
                        "_verified_requirement_revision": verifier_result.get("_verified_requirement_revision"),
                    }

                # Not complete - add feedback to context, including score trend
                feedback_text = f"Verifier: {score * 100:.0f}% - {v_reasoning}"
                if len(recent_verifier_scores) > 1:
                    trend = " → ".join(f"{s * 100:.0f}%" for s in recent_verifier_scores)
                    feedback_text += f"\nScore trend: {trend}"
                # Soft-fail score=0.5 from Rose deadline/timeout is infrastructure,
                # not a judgment that the deliverable is missing. The old nudge to
                # spawn_claude_code_agent caused finished ranking agents to burn
                # the rest of the budget re-spawning CC (cuda-kernel top100).
                reasoning_l = (v_reasoning or "").lower()
                infra_soft_fail = v_reasoning.startswith("Progress check failed") or any(
                    token in reasoning_l for token in ("deadline", "timeout", "timed out", "rose deadline")
                )
                if infra_soft_fail:
                    feedback_text += (
                        "\n\nNOTE: The progress verifier failed due to an infrastructure "
                        "timeout/error — this is NOT a judgment that your deliverable is "
                        "incomplete. If the final artifact already exists (files / structured "
                        "result), call attempt_completion again immediately with that same "
                        "result. Do NOT spawn additional sub-agents unless the deliverable "
                        "is actually missing."
                    )
                else:
                    feedback_text += (
                        "\n\nIMPORTANT: Your ASSISTANT text responses are NOT visible to the "
                        "verifier. Only TOOL results (tool call outputs, files, structured "
                        "responses) are evaluated. If you have completed work but scored low, "
                        "you must produce visible output through tool calls — e.g., use "
                        "spawn_claude_code_agent to write results to files, or use other tools "
                        "that produce visible TOOL messages."
                    )
                if not poll_messages:
                    context.append(
                        {
                            "role": "TOOL",
                            "text": feedback_text,
                            "timestamp": _safe_now().isoformat(),
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

            available = ", ".join(tools) if tools else "(none registered)"
            if is_plan_loop:
                nudge = (
                    f"You MUST call tools to make progress. Available tools: {available}. "
                    "Start by calling set_plan with your execution plan, then call attempt_completion."
                )
            else:
                nudge = (
                    f"You MUST call tools to make progress. Available tools: {available}. "
                    "Call one of the listed tools — do not respond with text only."
                )
            context.append(
                {
                    "role": "SYSTEM",
                    "text": nudge,
                    "timestamp": _safe_now().isoformat(),
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
    final_verifier_superseded = False
    final_verifier_requirement_keys = None
    final_verifier_requirement_revision = None

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
                poll_messages=poll_messages,
                get_requirement_revision=get_requirement_revision,
                claude_token=final_verifier_claude_token,
                claude_token_source=final_verifier_claude_token_source,
                claude_token_pool_id=final_verifier_claude_token_pool_id,
                claude_token_user_id=user_id,
                gpt_token=final_verifier_gpt_token,
                gpt_account_id=final_verifier_gpt_account_id,
                gpt_token_source=final_verifier_gpt_token_source,
                gpt_token_pool_id=final_verifier_gpt_token_pool_id,
                gpt_token_user_id=user_id,
                compute_token_lineage_key=compute_token_lineage_key,
                compute_token_demo_cache_affinity_key=compute_token_demo_cache_affinity_key,
                is_plan_loop=is_plan_loop,
                fast_mode_cache_enabled=fast_mode_cache_enabled,
                fast_mode_goal=goal_text,
                # Distinct step so the final (max-iterations) verifier never collides
                # with the per-iteration verifier cache entry.
                fast_mode_step=999_999,
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
                        from_fast_cache=v_usage.get("from_fast_cache", False),
                        cache_sequence_id=v_usage.get("cache_sequence_id"),
                    )
                except Exception as e:
                    logger.warning(f"on_tokens callback failed for final verifier: {e}")

            if poll_messages:
                last_checked = await poll_and_update_context(poll_messages, context, last_checked)
            final_verifier_superseded = _verifier_superseded_by_user_feedback(
                final_verifier_result,
                context,
                get_requirement_revision() if get_requirement_revision else None,
            )
            final_verifier_requirement_keys = final_verifier_result.get("_verified_user_requirement_keys")
            final_verifier_requirement_revision = final_verifier_result.get("_verified_requirement_revision")
            if final_verifier_superseded:
                final_verifier_progress = None
            else:
                final_verifier_progress = final_verifier_result.get("score", 0.0)
                final_verifier_reasoning = final_verifier_result.get("reasoning", "")
                final_partial_structured_response = final_verifier_result.get("structured_response")
                logger.info(
                    f"Final verifier: {final_verifier_progress * 100:.0f}% - {final_verifier_reasoning[:100]}..."
                )
        except Exception as e:
            if any(
                error_chain_has_type(e, kind)
                for kind in (
                    "CancelledError",
                    "WorkflowGenerationSealed",
                    "GenerationHandoffRequested",
                )
            ):
                raise
            logger.error(f"Final verifier call failed: {e}")

    # Best-effort answer: the model's last synthesized assistant text, so a runaway
    # that never called attempt_completion still returns usable output (the user's
    # requirement). Callers (e.g. explore) use this when there's no clean result.
    best_effort_response = ""
    for _m in reversed(context):
        if _m.get("role") == "ASSISTANT" and (_m.get("text") or "").strip():
            best_effort_response = _m["text"]
            break

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
        # Best-effort synthesis surfaced so callers never get an empty payload.
        "final_response": best_effort_response,
        "best_effort_response": best_effort_response,
        # Final verifier results for failure context
        "verifier_progress": final_verifier_progress,
        "verifier_reasoning": final_verifier_reasoning,
        "partial_structured_response": final_partial_structured_response,
        "_verified_user_requirement_keys": final_verifier_requirement_keys,
        "_verified_requirement_revision": final_verifier_requirement_revision,
        **({"verifier_superseded_by_user_feedback": True} if final_verifier_superseded else {}),
    }


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================


def _estimate_tokens(context: List[Dict]) -> int:
    """Rough token estimation: ~4 chars per token × safety multiplier.

    Thin alias for the canonical ``helpers.summarize.estimate_context_tokens``
    so the overflow trigger and the compactor measure the SAME thing. This used
    to join only ``m["text"]``, which scored production tool-call rows (empty
    text, payload in ``metadata.tool_calls``) at ~0 while the compactor counted
    them in full — compaction then removed ~0 measured tokens and added a
    measured summary, i.e. it GREW the context it was asked to shrink
    (prod agent e14d5abb, 2026-08-03).

    Excludes sub-agent internal messages (tagged with subAgentId) since these
    are filtered out before sending to the LLM. The chars/4 heuristic severely
    under-counts JSON-heavy content (observed 308k actual Anthropic tokens
    reported as <80k); ESTIMATE_SAFETY_MULTIPLIER pads for that.
    """
    return estimate_context_tokens(context)


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
    compute_token_lineage_key: Optional[str] = None,
    compute_token_demo_cache_affinity_key: Optional[str] = None,
) -> Tuple[List[Dict], bool]:
    """Compress context using the head/tail-protected compactor.

    Returns (new_context, success). On any failure (activity raised, LLM
    error, output empty) returns (original_context, False) — caller is
    responsible for circuit-breaking after repeated failures.
    """
    try:
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
                compute_token_lineage_key,
                compute_token_demo_cache_affinity_key,
            ],
            start_to_close_timeout=timedelta(seconds=180),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )
    except Exception as e:
        logger.warning(f"Compactor activity raised: {e}")
        return context, False

    if not isinstance(result, dict):
        return context, False

    success = bool(result.get("success", False))
    new_context = result.get("context") if success else None
    usage = result.get("usage") or {}

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
                    from_fast_cache=usage.get("from_fast_cache", False),
                    cache_sequence_id=usage.get("cache_sequence_id"),
                )
            except Exception as e:
                logger.warning(f"on_tokens callback failed for context_compression: {e}")

    if not success or not new_context:
        return context, False

    # Defense in depth: the compactor activity runs out-of-process and can be a
    # different code version, so re-verify here that it actually shrank the
    # context. Adopting a larger context guarantees the caller's overflow
    # trigger fires again on the very next check (prod agent e14d5abb).
    original_tokens = _estimate_tokens(context)
    compressed_tokens = _estimate_tokens(new_context)
    if compressed_tokens >= original_tokens:
        logger.warning(
            "Compactor returned a context that is not smaller; keeping original",
            original_tokens=original_tokens,
            compressed_tokens=compressed_tokens,
            saved_ratio=compaction_saved_ratio(original_tokens, compressed_tokens),
        )
        return context, False

    return new_context, True


def _real_user_requirement_keys(context: List[Dict]) -> set:
    keys = set()
    for message in context:
        if (message.get("role") or "").upper() != "USER" or (message.get("metadata") or {}).get("hidden"):
            continue
        metadata = message.get("metadata") or {}
        # Rows hidden from this agent's model (e.g. a Browser-composer message
        # addressed to one browser task) are not this agent's requirements.
        if is_agent_authored_user_metadata(metadata) or is_excluded_from_model(message):
            continue
        request_id = metadata.get("attentionRequestId")
        if metadata.get("source") == "attention_response" and isinstance(request_id, str) and request_id:
            keys.add(("attention_response", request_id))
            continue
        message_id = message.get("message_id") or message.get("id")
        keys.add(
            ("id", str(message_id))
            if message_id
            else ("legacy", str(message.get("timestamp") or ""), str(message.get("text") or ""))
        )
    return keys


def _is_requirement_agent_row(message: Dict) -> bool:
    """A task update from an agent above this one that this agent's model sees.

    The verifier reads it as ``TASK_UPDATE_FROM_PARENT_AGENT`` (helpers.llm) and
    it refreshes the output schema like a user correction. Sibling chatter,
    child notifications and task-addressed inbox rows are not requirements.
    """
    metadata = message.get("metadata") or {}
    return (
        (message.get("role") or "").upper() == "USER"
        and isinstance(metadata, dict)
        and not metadata.get("hidden")
        and metadata.get("agentMessage") is True
        and not is_excluded_from_model(message)
        and _is_from_ancestor_agent(metadata)
    )


def _requirement_keys(context: List[Dict]) -> set:
    """Rows that change what this agent must deliver: real user rows plus ancestor task updates."""
    keys = _real_user_requirement_keys(context)
    for message in context:
        if _is_requirement_agent_row(message):
            message_id = message.get("message_id") or message.get("id")
            keys.add(
                ("id", str(message_id))
                if message_id
                else ("legacy", str(message.get("timestamp") or ""), str(message.get("text") or ""))
            )
    return keys


def _verifier_superseded_by_user_feedback(
    result: Dict, context: List[Dict], requirement_revision: Optional[int] = None
) -> bool:
    """Version the verdict without rewriting the provider's judgment or usage."""
    judged_keys = result.get("_verified_user_requirement_keys")
    if judged_keys is not None and (_requirement_keys(context) - set(map(tuple, judged_keys))):
        result["superseded_by_user_feedback"] = True
    judged_revision = result.get("_verified_requirement_revision")
    if judged_revision is not None and requirement_revision is not None and judged_revision != requirement_revision:
        result["superseded_by_user_feedback"] = True
    return result.get("superseded_by_user_feedback") is True


def _with_authored_result(context: List[Dict], authored_result: Optional[str], call_id: str) -> List[Dict]:
    """The verifier's view: context plus this attempt's own authored result, if any.

    attempt_completion(result=...) carries content the agent wrote itself (a
    draft, message, summary). Its pending row is replaced by verifier feedback,
    so the text reaches the verifier as one last TOOL row for this call only.
    """
    if not isinstance(authored_result, str) or not authored_result.strip():
        return context
    timestamps = [str(m.get("timestamp")) for m in context if isinstance(m, dict) and m.get("timestamp")]
    return [
        *context,
        {
            "role": "TOOL",
            "text": authored_result,
            "timestamp": max(timestamps) if timestamps else "1970-01-01T00:00:00Z",
            "metadata": {
                "toolName": "attempt_completion",
                "toolStatus": "FINISHED",
                "toolCallId": f"{call_id}:result",
                "title": "Authored result",
            },
        },
    ]


# Model-visible result of an attempt_completion whose check a new message cancelled.
VERIFIER_INTERRUPTED_MESSAGE = (
    "Verification interrupted: a new message arrived. Read it, then call attempt_completion again "
    "when the task is done."
)


class _VerifierInterrupted(Exception):
    """A user or agent message arrived while the verifier was judging."""


async def _await_unless_new_message(awaitable: Awaitable[Any], interrupts: Optional[Any]) -> Any:
    """Await ``awaitable``; cancel it when a user / agent message arrives.

    ``interrupts`` is the workflow's DAG interrupt hook (loop.dag_executor.DagInterrupts):
    the same wake counter and user/agent-message filter that hand a running plan
    back to the loop. None (explore activities, Fast Mode, simulate) waits normally.
    """
    if interrupts is None:
        return await awaitable
    if interrupts.message_pending():
        if asyncio.iscoroutine(awaitable):
            awaitable.close()
        raise _VerifierInterrupted()
    task = asyncio.ensure_future(awaitable)
    waiter: Optional["asyncio.Future[Any]"] = None
    try:
        seq = interrupts.seq()
        while True:
            waiter = asyncio.ensure_future(interrupts.wait(seq))
            done, _ = await asyncio.wait({task, waiter}, return_when=asyncio.FIRST_COMPLETED)
            if task in done:
                return task.result()
            seq = interrupts.seq()
            if interrupts.message_pending():
                raise _VerifierInterrupted()
    finally:
        for pending in (waiter, task):
            if pending is not None and not pending.done():
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)


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
    compute_token_lineage_key: Optional[str] = None,
    compute_token_demo_cache_affinity_key: Optional[str] = None,
    is_plan_loop: bool = False,
    tool_call_id: Optional[str] = None,
    fast_mode_cache_enabled: bool = False,
    fast_mode_goal: Optional[str] = None,
    fast_mode_step: int = 0,
    poll_messages: Optional[Callable[[datetime], Awaitable[List[Dict]]]] = None,
    get_requirement_revision: Optional[Callable[[], int]] = None,
    pending_background_status: Optional[str] = None,
    authored_result: Optional[str] = None,
    interrupts: Optional[Any] = None,
) -> Dict:
    """Run verifier to check completion.

    With ``interrupts`` a user or agent message arriving mid-verification cancels
    the check: the attempt is closed as superseded and the caller continues.
    """
    verifier_call_id = tool_call_id or str(_safe_uuid4())

    # Post IN_PROGRESS
    # Post the in-progress verifier row as the active attempt_completion tool
    # result. The finished feedback row below is that call's terminal result.
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

    try:
        # Resolve the prompt and schema under the same accepted requirement revision.
        while True:
            judged_revision = get_requirement_revision() if get_requirement_revision else None
            verifier_prompt = await verifier_prompt_generator()
            current_response_schema = await get_response_schema() if get_response_schema else response_schema
            if not get_requirement_revision or judged_revision == get_requirement_revision():
                break
    except Exception as error:
        if any(
            error_chain_has_type(error, kind)
            for kind in (
                "CancelledError",
                "WorkflowGenerationSealed",
                "GenerationHandoffRequested",
            )
        ):
            raise
        if post_message:
            try:
                await post_message(
                    str(error),
                    "TOOL",
                    {
                        "toolCallId": verifier_call_id,
                        "toolName": "attempt_completion",
                        "toolStatus": "ERROR",
                        "title": "⚖️ Verification error",
                        "subAgentId": task_id,
                        "error": True,
                        "excludeFromModel": True,
                    },
                )
            except Exception as post_error:
                if any(
                    error_chain_has_type(post_error, kind)
                    for kind in (
                        "CancelledError",
                        "WorkflowGenerationSealed",
                        "GenerationHandoffRequested",
                    )
                ):
                    raise
                logger.warning(
                    "Failed to close verifier attempt after prerequisite error",
                    agent_id=agent_id,
                    tool_call_id=verifier_call_id,
                    error=extract_error_message(post_error),
                )
        raise
    judged_user_keys = _requirement_keys(context)
    verification_cursor = datetime.fromtimestamp(0, tz=timezone.utc)
    for message in context:
        try:
            timestamp = datetime.fromisoformat(str(message.get("timestamp") or "").replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            verification_cursor = max(verification_cursor, timestamp)
        except ValueError:
            continue
    verification_cursor = max(
        datetime.fromtimestamp(0, tz=timezone.utc), verification_cursor - timedelta(milliseconds=1)
    )

    # C7: dead `phase` positional arg has been removed from check_progress;
    # callers no longer pass it. `model` is kept as a positional but ignored
    # internally (verifier forces Ultra except for Rose Local). All other args are
    # passed positionally because Temporal activities only accept `args=`.
    # C14: context is already agent-scoped — `context` here is the calling
    # agent's own visible conversation, accumulated from `poll_messages`
    # after dropping spawned-agent work rows tagged with singular
    # metadata.subAgentId, plus locally-appended tool results.
    check_progress_args = [
        _with_authored_result(context, authored_result, verifier_call_id),
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
        compute_token_lineage_key,
        compute_token_demo_cache_affinity_key,
        None,  # dump_extra
        fast_mode_cache_enabled,
        fast_mode_goal,
        fast_mode_step,
    ]
    if pending_background_status:
        # Appended only when background agents are still running, so every
        # other verifier call keeps its exact arguments and cached prefix.
        check_progress_args.append(pending_background_status)
    try:
        result = await _await_unless_new_message(
            execute_activity(
                check_progress,
                args=check_progress_args,
                start_to_close_timeout=timedelta(seconds=VERIFIER_ACTIVITY_TIMEOUT_SECONDS),
                retry_policy=RetryPolicy(maximum_attempts=3),
            ),
            interrupts,
        )
    except _VerifierInterrupted:
        logger.info(
            "Verifier interrupted by a new user/agent message", agent_id=agent_id, tool_call_id=verifier_call_id
        )
        if post_message:
            await post_message(
                VERIFIER_INTERRUPTED_MESSAGE,
                "TOOL",
                {
                    "toolCallId": verifier_call_id,
                    "toolName": "attempt_completion",
                    "toolStatus": "FINISHED",
                    "title": "⚖️ Verification interrupted by a new message",
                    "subAgentId": task_id,
                    "verifierMessage": True,
                    "supersededByUserFeedback": True,
                    "interrupted": True,
                },
            )
        if poll_messages:
            await poll_and_update_context(poll_messages, context, verification_cursor)
        return {
            "score": 0.0,
            "reasoning": VERIFIER_INTERRUPTED_MESSAGE,
            "usage": {},
            "structured_response": None,
            "superseded_by_user_feedback": True,
            "interrupted_by_message": True,
            "_verified_user_requirement_keys": sorted(judged_user_keys),
            "_verified_requirement_revision": judged_revision,
            "resolved_response_schema": current_response_schema,
        }

    result["_verified_user_requirement_keys"] = sorted(judged_user_keys)
    result["_verified_requirement_revision"] = judged_revision
    if poll_messages:
        await poll_and_update_context(poll_messages, context, verification_cursor)
    _verifier_superseded_by_user_feedback(
        result, context, get_requirement_revision() if get_requirement_revision else None
    )
    score = result.get("score", 0.0)
    reasoning = result.get("reasoning", "")
    structured_response = result.get("structured_response")

    # Format message with structured output if present.
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

    if score < 1.0:
        # Persist infrastructure-specific guidance here so the poll_messages
        # path (which reads the posted verifierMessage, not local feedback_text)
        # does not keep telling the agent to spawn new work after a soft fail.
        reasoning_l = (reasoning or "").lower()
        infra_soft_fail = reasoning.startswith("Progress check failed") or any(
            token in reasoning_l for token in ("deadline", "timeout", "timed out", "rose deadline")
        )
        if infra_soft_fail:
            guidance = (
                "NOTE: The progress verifier failed due to an infrastructure "
                "timeout/error — this is NOT a judgment that your deliverable is "
                "incomplete. If the final artifact already exists (files / structured "
                "result), call attempt_completion again immediately with that same "
                "result. Do NOT spawn additional sub-agents unless the deliverable "
                "is actually missing."
            )
        else:
            guidance = (
                "Take a NEW action that produces fresh tool evidence matching the goal, "
                "then call attempt_completion again."
            )
        message_text = f"Verifier score: {score:.0%}\n\nReasoning: {message_text}\n\n{guidance}"

    # Post FINISHED. The verifier feedback is the attempt_completion call's
    # tool result: both converters pair it with the declared tool_use.
    # verifierMessage marks it for UI and tool-count filtering.
    if post_message:
        await post_message(
            message_text,
            "TOOL",
            {
                "toolCallId": verifier_call_id,
                "toolName": "attempt_completion",
                "toolStatus": "FINISHED",
                "title": (
                    f"⚖️ Verifier rejected ({score:.0%}) — continue task"
                    if score < 1.0
                    else f"⚖️ Progress: {score * 100:.0f}%"
                ),
                "subAgentId": task_id,
                "verifierMessage": True,
                **({"supersededByUserFeedback": True} if result.get("superseded_by_user_feedback") else {}),
            },
        )

    logger.info(f"Verifier score: {score * 100:.1f}%")
    if poll_messages:
        await poll_and_update_context(poll_messages, context, verification_cursor)
    _verifier_superseded_by_user_feedback(
        result, context, get_requirement_revision() if get_requirement_revision else None
    )
    # Surface the schema the verifier actually judged against so soft-accept
    # does not re-validate against a stale static response_schema when
    # get_response_schema resolved a different field set (CodeRabbit #1260).
    if isinstance(result, dict):
        result["resolved_response_schema"] = current_response_schema
    return result
