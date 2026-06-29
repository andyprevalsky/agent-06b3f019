"""Main agent workflow for executing autonomous tasks.

Uses run_agent for the core loop. Workflow handles:
- Signals (pause, resume, user response, sub-agent progress)
- Sub-agent orchestration
- continue_as_new for context overflow
"""

import asyncio
import contextlib
import json as _json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

import structlog
import structlog.contextvars
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import TimeoutError as TemporalTimeoutError

# Import pass-through for workflow context:
# - Our own modules are safe (config.py has no import-time side effects)
# - Third-party libraries (httpx, instructor) may have import-time issues
# - This is a safety net, not strictly required for our code
with workflow.unsafe.imports_passed_through():
    from domains.spawn_agent.handler import spawn_agent  # Unified: browser/code/general_purpose/explore
    from helpers import (
        check_user_usage,
        fetch_agent_config,
        generate_completion_summary,
        get_model_context_window,
        get_user_context,
        get_user_custom_system_prompt,
        get_user_system_name,
        mark_finished,
        poll_new_messages,
        post_agent_message,
        update_agent_status,
    )
    from helpers.context_scope import filter_internal_subagent_messages
    from helpers.handle_tool_event import handle_tool_event
    from helpers.llm import (
        check_progress,
        fetch_compute_token_activity,
        mark_compute_token_rate_limited_activity,
        set_response_schema_activity,
    )
    from helpers.messages import update_agent_tree_state
    from helpers.model_pricing import get_anthropic_pricing, get_default_pricing
    from helpers.query_parent_state import query_parent_state_activity
    from helpers.save_tool_usage import save_tool_usage
    from helpers.sms_activities import get_agent_source, notify_sms_event_activity
    from loop.dag_executor import TaskDAG, execute_dag, extract_plan_from_context
    from loop.run_agent import run_agent
    from providers.rose.pricing import get_model_pricing as get_in_process_model_pricing
    from tools.attempt_completion import attempt_completion
    from tools.base import AssistantEvent, EventType, MessageStatus, ToolEvent
    from tools.call_phone_number import call_phone_number
    from tools.call_phone_number import get_manager as get_call_phone_manager

    # Tool executors (map tool name → workflow helper)
    from tools.grep import grep
    from tools.knowledge_base import save_blueprint_activity
    from tools.message_person import message_person
    from tools.prompts import TOOL_PROMPTS
    from tools.request_user_approval import UserRejectedError, request_user_approval_direct
    from tools.request_user_signup import request_user_signup
    from tools.send_message_to_user import send_message_to_user
    from tools.set_plan import set_plan
    from tools.wait_for import wait_for
    from tools.web_fetch import web_fetch
    from tools.web_search import web_search
    from utils.error_utils import extract_error_message
    from utils.format_tool_display import format_tool_display
    from utils.prompts import build_system_prompt, build_verifier_prompt
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS, PLAN_PHASE_TOOLS

logger = structlog.get_logger()

CLOUD_AGENT_TOOL_NAME = "cloud_agent"
CREATING_CLOUD_AGENT_TITLE = "Creating Cloud Agent"
PREPARING_CLOUD_AGENT_TITLE = "Preparing Cloud Agent"
STARTING_REASONING_TITLE = "Starting Reasoning"
CLOUD_AGENT_READY_TITLE = "Cloud Agent Ready"
CLOUD_AGENT_IN_PROGRESS_TITLES = {
    CREATING_CLOUD_AGENT_TITLE,
    PREPARING_CLOUD_AGENT_TITLE,
    STARTING_REASONING_TITLE,
}
FAST_MODE_WRITE_THROUGH_USER_IDS = {"1f85ff25-6e29-4c1b-8739-f917bd101a30"}

# =============================================================================
# TOOL CONFIGURATION
# =============================================================================

# Tool name → executor function mapping
TOOL_EXECUTORS = {
    "spawn_agent": spawn_agent,  # Unified: browser/code/general_purpose/explore
    "wait_for": wait_for,
    "send_message_to_user": send_message_to_user,
    "send_message_to_user_execute_phase": send_message_to_user,  # Same handler, forces is_question=False
    "web_search": web_search,
    "web_fetch": web_fetch,
    "message_person": message_person,
    "set_plan": set_plan,
    "attempt_completion": attempt_completion,
    "request_user_signup": request_user_signup,
    "call_phone_number": call_phone_number,
    "grep": grep,
}

# Tools requiring user approval before execution
# NOTE: message_person handles approval internally (after message generation, not before)
APPROVAL_REQUIRED_TOOLS = {
    "call_phone_number": get_call_phone_manager,
}


@workflow.defn
class AgentWorkflow:
    """
    Main workflow for autonomous agent task execution.

    Two-phase execution:
    1. PLAN: Research, ask questions, create execution plan
    2. EXECUTE: Run the plan with full tool access
    """

    def __init__(self):
        self.agent_id: Optional[str] = None
        self.user_id: Optional[str] = None
        self.goal: Optional[str] = None
        self.fast_mode_cache_enabled: bool = False
        self.model: str = "anthropic/claude-sonnet-4.6"
        self.reasoning_max_tokens: int = 256
        self.verifier: Optional[Dict] = None
        self.last_message_check: Optional[datetime] = datetime(1970, 1, 1).replace(tzinfo=timezone.utc)
        self.max_context_tokens: Optional[int] = None
        self.token_count: int = 0
        self.tokens_in: int = 0
        self.tokens_out: int = 0
        self.context_size: int = 0  # Current context window usage (from last LLM call)
        self.is_paused: bool = False
        self._paused_by_parent: bool = False  # Track if pause was inherited from parent
        self._has_new_messages: bool = False
        self._last_signal_response: Optional[str] = None  # Stores response from receive_user_response signal
        self._signal_responses: dict = {}  # Per-request responses keyed by attention request ID
        self._has_credits: bool = True  # Cached credit status
        self._last_credit_check: int = 0  # Iteration count at last check
        self.write_lock_enabled: bool = True  # Write lock for browser agent actions

        # Signup request state (for request_user_signup tool)
        self._signup_completed: bool = False
        self._signup_dismissed: bool = False

        # Context - kept in sync with run_agent for tools that check it
        self.context: List[Dict] = []
        self._cloud_agent_lifecycle_tool_call_id: Optional[str] = None
        self._cloud_agent_lifecycle_updates_sent: Set[str] = set()
        self._cloud_agent_lifecycle_finished: bool = False

        # Sub-agent tracking
        self.parent_workflow_id: Optional[str] = None
        self.parent_agent_id: Optional[str] = None  # Parent agent ID for tree structure
        self.pending_children: Set[str] = set()
        self.child_tool_ids: Dict[str, str] = {}
        self.child_last_tokens: Dict[str, Dict[str, int]] = {}
        self.child_tool_counts: Dict[str, int] = {}  # Aggregated tool counts from sub-agents
        self.child_results: Dict[str, Dict] = {}  # Store child results for file extraction after wait_condition
        self.depth: int = 0

        # Tree state tracking (for sub-agent tree UI)
        self.bus_id: Optional[str] = None  # Shared bus channel ID for tree updates
        self.tools_in_use: Set[str] = set()  # Currently executing tools (display strings)
        self.message_count: int = 0  # Total message count for this agent
        self.output_schema: Optional[Dict] = None  # Structured output schema (for prompts, verifier, tree, completion)
        self.start_time: Optional[datetime] = None  # Workflow start time for duration tracking

        # System prompt building state (for build_system_prompt callback)
        self._current_tools: List[str] = []  # Tools enabled for current phase
        self._disabled_tools: List[str] = []  # Tools disabled for current phase (shown in PLAN)

        # Cost limit tracking (hierarchical relay: child → parent → root)
        # Uses float to avoid int truncation losing sub-cent costs on cheap models
        self.own_cost_cents: float = 0.0  # This agent's direct cost (LLM + tools)
        self.children_cost_cents: Dict[str, float] = {}  # child_agent_id -> subtree_cost
        self.subtree_cost_cents: float = 0.0  # own + sum(children) - what we report to parent
        self.price_limit_cents: int = 100  # Default price limit (100 cents = $1.00)
        self._cost_limit_reached: bool = False  # Flag for cost limit status
        self._is_finished: bool = False  # Latched True after _mark_complete/_mark_failed runs
        self.child_workflow_ids: Dict[str, str] = {}  # child_agent_id -> child_temporal_workflow_id

        # Tree token tracking (hierarchical relay: child → parent → root)
        # Own tokens are in self.tokens_in/out (used for cost calc)
        # Children's tokens aggregated here for tree totals
        self.children_tokens_in: Dict[str, int] = {}  # child_agent_id -> subtree_tokens_in
        self.children_tokens_out: Dict[str, int] = {}  # child_agent_id -> subtree_tokens_out
        self.tree_tokens_in: int = 0  # own + sum(children) - for display
        self.tree_tokens_out: int = 0  # own + sum(children) - for display

        # Selected compute token (passed to Rose for direct provider calls)
        self.compute_token_provider: Optional[str] = None  # "claude" | "gpt"
        self.claude_max_token: Optional[str] = None
        self.claude_max_token_fetched_at: Optional[datetime] = None  # Legacy alias for tests/callers
        self.claude_max_token_source: Optional[str] = None  # 'user' or 'pool' — used for rotation on rate_limit
        self.claude_max_token_pool_id: Optional[str] = None  # Integration ID when source='pool'
        self.gpt_code_token: Optional[str] = None
        self.gpt_code_account_id: Optional[str] = None
        self.gpt_code_token_source: Optional[str] = None
        self.gpt_code_token_pool_id: Optional[str] = None
        self.compute_token_fetched_at: Optional[datetime] = None  # For 5-min TTL refresh

        # Model pricing (fetched at workflow start for cost calculation)
        self.input_cents_per_1k: float = 0.0  # Price per 1k input tokens in cents
        self.output_cents_per_1k: float = 0.0  # Price per 1k output tokens in cents
        self.model_pricing_cache: Dict[str, Dict[str, float]] = {}  # model -> {input_cents_per_1k, output_cents_per_1k}
        self.actual_model: Optional[str] = None  # The model that actually served requests (from Rose response)

        # User customization (fetched at workflow start for dynamic name in approvals/SMS)
        self.system_name: str = "Rose"  # Default to "Rose", fetched from user settings
        self.custom_system_prompt: Optional[str] = None  # Custom personality prompt to inject

        # Agent source (WEB, MAC_APP, SMS) — cached at startup for SMS notification gating
        self.agent_source: str = "WEB"

    # =========================================================================
    # SIGNALS
    # =========================================================================

    @workflow.signal
    async def pause(self):
        """Pause workflow execution."""
        workflow.logger.info("🔴 Received PAUSE signal")
        self.is_paused = True
        await self._update_tree_state(status="PAUSED")

        # Cascade to children (pull-based checks cover spawn race conditions)
        for child_wf_id in self._get_pending_child_workflow_ids():
            try:
                handle = workflow.get_external_workflow_handle(child_wf_id)
                await handle.signal("pause")
            except Exception as e:
                workflow.logger.warning(f"Failed to cascade pause to child: {e}")

    @workflow.signal
    async def resume(self):
        """Resume workflow execution. Blocked if parent is still paused/cost-limited."""
        if self.parent_workflow_id:
            state = await self._query_parent_state()
            if state.get("is_cost_limit_reached") or state.get("is_paused"):
                workflow.logger.warning("Cannot resume — parent is still paused/cost-limited")
                return
        workflow.logger.info("🟢 Received RESUME signal")
        self.is_paused = False
        self._paused_by_parent = False
        await self._update_tree_state(status="ACTIVE")

        # Cascade to children (pull-based checks cover spawn race conditions)
        for child_wf_id in self._get_pending_child_workflow_ids():
            try:
                handle = workflow.get_external_workflow_handle(child_wf_id)
                await handle.signal("resume")
            except Exception as e:
                workflow.logger.warning(f"Failed to cascade resume to child: {e}")

    @workflow.signal
    async def receive_user_response(self, response: str):
        """Receive user response - sets flag and stores response for approval checks."""
        workflow.logger.info(f"💬 Received user response (length={len(response)})")
        # Try to parse as JSON with request_id (from attention request endpoints)
        try:
            data = _json.loads(response)
            if isinstance(data, dict) and "request_id" in data:
                req_id = data["request_id"]
                actual_response = data.get("response", "")
                self._signal_responses[req_id] = actual_response
                workflow.logger.info(f"💬 Stored response for request {req_id}")
                return
        except (ValueError, TypeError, KeyError):
            pass
        # Legacy: plain string (from chat messages, SMS, etc.)
        self._last_signal_response = response
        self._has_new_messages = True

    @workflow.signal
    async def child_progress(self, data: dict):
        """Receive progress update from child agent."""
        child_agent_id = data.get("child_agent_id", "")
        progress = data.get("progress", 0.0)
        tokens_in = data.get("tokens_in", 0)
        tokens_out = data.get("tokens_out", 0)
        token_count = data.get("token_count", 0)
        goal = data.get("goal", "")

        # Calculate token delta
        last = self.child_last_tokens.get(child_agent_id, {"tokens_in": 0, "tokens_out": 0, "token_count": 0})
        self.tokens_in += tokens_in - last["tokens_in"]
        self.tokens_out += tokens_out - last["tokens_out"]
        self.token_count += token_count - last["token_count"]
        self.child_last_tokens[child_agent_id] = {
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "token_count": token_count,
        }

        # Post progress update
        child_tool_id = self.child_tool_ids.get(child_agent_id)
        if child_tool_id:
            await self._post_message(
                f"Progress: {int(progress * 100)}%",
                "TOOL",
                metadata={
                    "toolCallId": child_tool_id,
                    "toolName": "spawn_general_purpose_agent",
                    "toolStatus": "IN_PROGRESS",
                    "title": goal[:30] if goal else "Sub-agent",
                    "subAgentId": child_agent_id,
                    "progress": progress,
                },
            )

    @workflow.signal
    async def child_completed(self, data: dict):
        """Receive completion signal from child agent (success or failure)."""
        child_agent_id = data.get("child_agent_id", "")
        result = data.get("result", {})
        child_status = result.get("status", "completed")

        child_tool_id = self.child_tool_ids.get(child_agent_id)
        goal_text = result.get("goal", "")

        if child_status == "failed":
            # Child agent failed
            workflow.logger.warning(f"❌ Child {child_agent_id[:8]} failed: {result.get('error_reason', 'unknown')}")

            if child_tool_id:
                await self._post_message(
                    result.get("summary", "Sub-agent failed"),
                    "TOOL",
                    metadata={
                        "toolCallId": child_tool_id,
                        "toolName": "spawn_general_purpose_agent",
                        "toolStatus": "ERROR",
                        "title": f"❌ Sub-agent failed: {goal_text[:30]}",
                        "subAgentId": child_agent_id,
                        "error": True,
                    },
                )
        else:
            # Child agent succeeded
            workflow.logger.info(f"✅ Child {child_agent_id[:8]} completed")

            # Aggregate tool counts from child
            child_counts = result.get("tool_counts", {})
            for tool_name, count in child_counts.items():
                self.child_tool_counts[tool_name] = self.child_tool_counts.get(tool_name, 0) + count

            if child_tool_id:
                summary = result.get("summary", "")
                structured_response = result.get("structured_response")
                await self._post_message(
                    summary if summary else f"Completed: {goal_text}",
                    "TOOL",
                    metadata={
                        "toolCallId": child_tool_id,
                        "toolName": "spawn_general_purpose_agent",
                        "toolStatus": "FINISHED",
                        "title": f"Sub-agent completed: {goal_text[:30]}",
                        "subAgentId": child_agent_id,
                        "progress": 1.0,
                        "structuredResponse": structured_response,
                    },
                )

        # Store result for file extraction in spawn_sub_agents after wait_condition
        self.child_results[child_agent_id] = result

        self.pending_children.discard(child_agent_id)

    @workflow.signal
    async def signup_completed(self):
        """Signal that user has completed signup (from request_user_signup tool)."""
        workflow.logger.info("✅ Received signup_completed signal")
        self._signup_completed = True

    @workflow.signal
    async def signup_dismissed(self):
        """Signal that user dismissed the signup prompt (continuing as anonymous)."""
        workflow.logger.info("⏭️ Received signup_dismissed signal")
        self._signup_dismissed = True

    @workflow.signal
    async def child_cost_update(self, data: dict):
        """Receive cost and token update from a child agent (hierarchical relay upward)."""
        child_agent_id = data.get("child_agent_id", "")
        subtree_cost = data.get("subtree_cost_cents", 0)
        subtree_tokens_in = data.get("subtree_tokens_in", 0)
        subtree_tokens_out = data.get("subtree_tokens_out", 0)

        # Update this child's cost and tokens in our tracking
        self.children_cost_cents[child_agent_id] = subtree_cost
        self.children_tokens_in[child_agent_id] = subtree_tokens_in
        self.children_tokens_out[child_agent_id] = subtree_tokens_out

        # Recalculate our subtree and propagate upward
        await self._update_cost_and_signal_parent()

    @workflow.signal
    async def cost_limit_reached(self):
        """Received from parent when cost limit exceeded."""
        workflow.logger.warning("⚠️ Cost limit reached signal received - pausing")
        self.is_paused = True
        self._cost_limit_reached = True
        self._paused_by_parent = True
        await self._update_tree_state(status="COST_LIMIT_REACHED")

        # Cascade to children (pull-based checks cover spawn race conditions)
        for child_wf_id in self._get_pending_child_workflow_ids():
            try:
                handle = workflow.get_external_workflow_handle(child_wf_id)
                await handle.signal("cost_limit_reached")
            except Exception as e:
                workflow.logger.warning(f"Failed to cascade cost_limit_reached to child: {e}")

    @workflow.signal
    async def price_limit_increased(self, data: dict):
        """Price limit increased. Cascades to children."""
        if self.parent_workflow_id:
            state = await self._query_parent_state()
            if state.get("is_cost_limit_reached"):
                workflow.logger.warning("Cannot accept price_limit_increased — parent still cost-limited")
                return

        new_limit = data.get("new_limit_cents", 25)
        workflow.logger.info(f"💰 Price limit increased to {new_limit} cents")

        self.price_limit_cents = new_limit
        self._cost_limit_reached = False
        self.is_paused = False
        self._paused_by_parent = False
        await self._update_tree_state(status="ACTIVE")

        # Cascade to children (pull-based checks cover spawn race conditions)
        for child_wf_id in self._get_pending_child_workflow_ids():
            try:
                handle = workflow.get_external_workflow_handle(child_wf_id)
                await handle.signal("price_limit_increased", data)
            except Exception as e:
                workflow.logger.warning(f"Failed to cascade price_limit_increased to child: {e}")

    # =========================================================================
    # MAIN RUN
    # =========================================================================

    @workflow.run
    async def run(  # noqa: C901
        self,
        agent_id: str,
        user_id: str,
        goal: str,
        model: str,
        reasoning_max_tokens: int,
        verifier: Dict,
        context: Optional[List[Dict]] = None,
        parent_workflow_id: Optional[str] = None,
        parent_agent_id: Optional[str] = None,
        depth: int = 0,
        bus_id: Optional[str] = None,
        start_phase: str = "plan",  # "plan" runs PLAN→EXECUTE, "execute" skips PLAN
        max_iterations: Optional[int] = None,  # Step limit for execute phase (sub-agents use 25)
        price_limit_cents: int = 100,  # Price limit in cents (default $1.00)
        context_gates: Optional[Dict[str, bool]] = None,  # Control which user context sections to include
        fast_mode_cache_enabled: bool = False,  # Fast Mode aggressive cache (own flag, NOT a context gate)
    ) -> Dict:
        """Execute agent task: optionally PLAN phase → EXECUTE phase."""
        # Bind agent_id to structlog context so ALL downstream structlog calls
        # (tools, helpers, activities) automatically include agent_id in JSON output
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(agent_id=agent_id)

        self.agent_id = agent_id
        self.user_id = user_id
        self.goal = goal
        self.model = model
        self.current_phase = "PLAN"
        self.reasoning_max_tokens = reasoning_max_tokens
        self.verifier = verifier
        self.parent_workflow_id = parent_workflow_id
        self.parent_agent_id = parent_agent_id
        self.depth = depth
        self.bus_id = bus_id
        self.context_gates = context_gates or {}  # Empty dict = all gates open (default)
        self.fast_mode_cache_enabled = fast_mode_cache_enabled  # Record/replay third-party responses
        self.max_iterations = max_iterations
        self.price_limit_cents = price_limit_cents  # Use passed value instead of hardcoded default
        self.start_time = workflow.now()  # Track start time for duration calculation

        workflow.logger.info(f"Agent starting: agent={agent_id}, goal='{goal[:50]}', depth={depth}")

        await self._advance_cloud_agent_lifecycle(PREPARING_CLOUD_AGENT_TITLE, "IN_PROGRESS")

        # Post an early heartbeat so external monitors (FE tree, benchmark
        # stall detector) see the agent is alive while init activities run.
        # Init is several short serialized activities and under parallel
        # benchmark load the round trips can stack to >60 s before the first
        # ASSISTANT/TOOL row lands. Without this row the agent looks silent
        # from message-creation time onward and the benchmark fires
        # `tree stalled` before any LLM call has happened. The row is purely
        # a liveness signal — UI renders it as a thin "Initializing" chip
        # and the row becomes irrelevant once a real tool message arrives.
        init_message_posted = False
        with contextlib.suppress(Exception):
            await workflow.execute_activity(
                post_agent_message,
                args=[
                    agent_id,
                    "Agent initializing — fetching context, system prompt, and tool config.",
                    "TOOL",
                    {
                        "toolCallId": "tc-agent-init",
                        "toolName": "agent_init",
                        "toolStatus": "IN_PROGRESS",
                        "title": "Initializing",
                    },
                    None,
                ],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            init_message_posted = True

        # Fetch model context window
        if self.max_context_tokens is None:
            try:
                self.max_context_tokens = await workflow.execute_activity(
                    get_model_context_window,
                    args=[model],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
            except Exception:
                self.max_context_tokens = 200_000

        # Update status
        with contextlib.suppress(Exception):
            await workflow.execute_activity(
                update_agent_status,
                args=[agent_id, "ACTIVE", 0.0, "Agent started", 0, 0, 0, 0, 0],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

        # Fetch and cache agent source (WEB, MAC_APP, SMS) for notification gating
        try:
            self.agent_source = await workflow.execute_activity(
                get_agent_source,
                args=[agent_id],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            workflow.logger.info(f"Agent source: {self.agent_source}")
        except Exception as e:
            workflow.logger.warning(f"Failed to fetch agent source, defaulting to WEB: {e}")

        # Send SMS notification for agent_started (root + SMS-source only)
        if not parent_workflow_id and self.agent_source == "SMS":
            try:
                await workflow.execute_activity(
                    notify_sms_event_activity,
                    args=[user_id, "agent_started", agent_id, {"goal": goal}],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                workflow.logger.info("Sent agent_started SMS notification")
            except Exception as e:
                workflow.logger.warning(f"Failed to send agent_started SMS notification: {e}")

        # Fetch user context once (for both phases), respecting context_gates
        user_context_section = ""

        # Helper: gate is open unless explicitly set to False
        def _gate_open(name: str) -> bool:
            return self.context_gates.get(name, True)

        try:
            user_context_section = await workflow.execute_activity(
                get_user_context,
                args=[user_id, self.context_gates],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
        except Exception as e:
            workflow.logger.warning(f"Failed to fetch user context: {e}")
        self.user_context_section = user_context_section

        if self.context_gates:
            workflow.logger.info(f"Context gates applied: {self.context_gates}")

        # Fetch user's custom system name (for approval messages and SMS)
        try:
            self.system_name = await workflow.execute_activity(
                get_user_system_name,
                args=[user_id],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            workflow.logger.info(f"Using system name: {self.system_name}")
        except Exception as e:
            workflow.logger.warning(f"Failed to fetch system name, using default 'Rose': {e}")

        # Fetch user's custom system prompt (for personality injection)
        # Skip if custom_system_prompt gate is closed
        if _gate_open("custom_system_prompt"):
            try:
                self.custom_system_prompt = await workflow.execute_activity(
                    get_user_custom_system_prompt,
                    args=[user_id],
                    start_to_close_timeout=timedelta(seconds=15),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                if self.custom_system_prompt:
                    workflow.logger.info(f"Custom system prompt loaded: {len(self.custom_system_prompt)} chars")
            except Exception as e:
                workflow.logger.warning(f"Failed to fetch custom system prompt: {e}")
        else:
            workflow.logger.info("Skipping custom system prompt (gate closed)")

        # Fetch one direct compute token for Rose. Claude is preferred when
        # available; otherwise GPT/Codex is used. Each LLM call receives only
        # the selected token family.
        await self._refresh_compute_token(user_id)

        # Inject custom system prompt as hidden USER message for new agents
        # Only inject if: 1) custom prompt exists, 2) this is not a resume (no context passed)
        if self.custom_system_prompt and not context:
            try:
                await self._post_message(
                    f"Personality instructions: {self.custom_system_prompt}",
                    "USER",
                    metadata={
                        "hidden": True,
                        "isCustomSystemPrompt": True,
                    },
                )
                workflow.logger.info("Injected custom system prompt as hidden USER message")
            except Exception as e:
                workflow.logger.warning(f"Failed to inject custom system prompt: {e}")

        # Fetch response schema and write_lock_enabled from agent config
        response_schema = None
        fetched_parent_agent_id = None
        try:
            agent_config = await workflow.execute_activity(
                fetch_agent_config,
                args=[agent_id],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
            response_schema = agent_config.get("response_schema")
            fetched_parent_agent_id = agent_config.get("parent_agent_id")
            self.output_schema = response_schema  # Single source of truth for output schema
            self.write_lock_enabled = agent_config.get("write_lock_enabled", True)  # Default to True (locked)
            workflow.logger.info(
                f"Fetched output_schema: {response_schema is not None}, write_lock_enabled: {self.write_lock_enabled}"
            )
        except Exception as e:
            workflow.logger.warning(f"Failed to fetch agent config for response_schema: {e}")

        # If no schema was provided at create time, generate one synchronously NOW.
        # The schema is injected into the first user message at LLM-call time
        # and also appears in the verifier system prompt; if it arrives lazily
        # mid-run, every LLM call before generation has different context than
        # every call after. Awaiting it here keeps the run stable from the first
        # model call.
        is_sub_agent = bool(parent_workflow_id or parent_agent_id or fetched_parent_agent_id)
        if response_schema is None and self.goal and not is_sub_agent:
            try:
                generated = await workflow.execute_activity(
                    set_response_schema_activity,
                    args=[
                        agent_id,
                        [self.goal],
                        self._active_compute_token_payload(),
                        self.fast_mode_cache_enabled,
                    ],
                    start_to_close_timeout=timedelta(seconds=90),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
                if isinstance(generated, dict) and generated.get("schema"):
                    self.output_schema = generated["schema"]
                    response_schema = self.output_schema
                    workflow.logger.info(
                        f"Generated output_schema synchronously with "
                        f"{len(self.output_schema.get('fields', []))} field(s)"
                    )
            except Exception as e:
                workflow.logger.warning(f"Failed to generate response_schema at startup: {e}")
        elif response_schema is None and is_sub_agent:
            workflow.logger.info("Skipping response_schema generation for sub-agent")

        # Resolve model pricing in-process so startup is not blocked by the activity queue.
        pricing = get_in_process_model_pricing(model) or get_default_pricing(model)
        if pricing:
            self.input_cents_per_1k = pricing["input_cents_per_1k"]
            self.output_cents_per_1k = pricing["output_cents_per_1k"]
            workflow.logger.info(
                f"💰 Resolved model pricing: input={self.input_cents_per_1k}c/1k, output={self.output_cents_per_1k}c/1k"
            )

        # Broadcast initial tree state with schema (only for sub-agents with bus_id)
        if self.bus_id:
            await self._update_tree_state(progress=0.0, status="ACTIVE")

        # If sub-agent, check parent's pause/cost-limit state before starting work
        # (covers race condition where signal arrived after spawn but before we're ready)
        if self.parent_workflow_id:
            state = await self._query_parent_state()
            if state.get("is_paused"):
                workflow.logger.info("Parent is paused - inheriting pause state")
                self.is_paused = True
                self._paused_by_parent = True
            if state.get("is_cost_limit_reached"):
                workflow.logger.info("Parent hit cost limit - inheriting cost limit state")
                self._cost_limit_reached = True
                self.is_paused = True
                self._paused_by_parent = True

        # =====================================================================
        # Tool lists from centralized source of truth
        # =====================================================================
        plan_tools = PLAN_PHASE_TOOLS
        execute_tools = EXECUTE_PHASE_TOOLS

        # Determine whether to skip PLAN phase and/or DAG
        skip_plan = start_phase in ("execute", "execute_continued")
        skip_dag = start_phase == "execute_continued"  # After continue_as_new, DAG already ran

        if init_message_posted:
            with contextlib.suppress(Exception):
                await workflow.execute_activity(
                    post_agent_message,
                    args=[
                        agent_id,
                        "Agent initialization complete.",
                        "TOOL",
                        {
                            "toolCallId": "tc-agent-init",
                            "toolName": "agent_init",
                            "toolStatus": "FINISHED",
                            "title": "Initialized",
                        },
                        None,
                    ],
                    start_to_close_timeout=timedelta(seconds=15),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )

        # =====================================================================
        # PHASE 1: PLAN (research + create execution plan)
        # =====================================================================
        if not skip_plan:
            self.current_phase = "PLAN"
            self._current_tools = plan_tools
            self._disabled_tools = execute_tools
            workflow.logger.info(f"▶ PLAN phase: {len(plan_tools)} tools")

            plan_result = await run_agent(
                agent_id=agent_id,
                user_id=user_id,
                system_prompt=self.build_system_prompt,
                verifier_prompt_generator=self._make_verifier_prompt_generator(),
                model=model,
                tools=plan_tools,
                is_inside_temporal_activity=False,
                check_paused=self._check_paused,
                wait_for_messages=self._wait_for_messages,
                on_context_overflow=self._handle_context_overflow,
                check_credits=self._check_credits,
                post_message=self._post_message,
                poll_messages=self._poll_messages,
                execute_tool=self._execute_tool,
                update_tree_state=self._update_tree_state,
                get_children_tokens=self._get_children_tokens,
                on_tokens=self._on_tokens,  # Real-time cost tracking and limit checking
                max_context_tokens=self.max_context_tokens,
                reasoning_max_tokens=reasoning_max_tokens,
                is_plan_loop=True,  # PLAN phase: requires set_plan, posts "sit back" message
                response_schema=response_schema,
                get_response_schema=self._make_response_schema_getter(),
                claude_token=self._active_claude_token(),
                get_claude_token=self._active_claude_token,
                get_claude_token_source=self._active_claude_source,
                get_claude_token_pool_id=self._active_claude_pool_id,
                gpt_token=self._active_gpt_token(),
                gpt_account_id=self._active_gpt_account_id(),
                get_gpt_token=self._active_gpt_token,
                get_gpt_account_id=self._active_gpt_account_id,
                get_gpt_token_source=self._active_gpt_source,
                get_gpt_token_pool_id=self._active_gpt_pool_id,
                fast_mode_cache_enabled=self.fast_mode_cache_enabled,
                goal_text=self.goal,
            )

            await self._track_tokens_and_cost(plan_result)

            if plan_result["status"] != "completed":
                return await self._handle_incomplete(plan_result, "PLAN")

            workflow.logger.info("✓ PLAN complete, starting EXECUTE")
        else:
            workflow.logger.info("⏭️ Skipping PLAN phase, starting EXECUTE directly")

        # =====================================================================
        # PHASE 2: EXECUTE (run the plan with full tool access)
        # =====================================================================
        self.current_phase = "EXECUTE"
        self._current_tools = execute_tools
        self._disabled_tools = []  # No disabled tools in EXECUTE phase
        workflow.logger.info(f"▶ EXECUTE phase: {len(execute_tools)} tools")

        # Get context from PLAN phase (or poll if skipped)
        if not skip_plan:
            execute_context = plan_result.get("context", [])
        else:
            # Poll messages to get context if we skipped PLAN
            # Use epoch timestamp to get ALL messages (not None - that crashes poll_new_messages)
            execute_context = await workflow.execute_activity(
                poll_new_messages,
                args=[agent_id, datetime.fromtimestamp(0, tz=timezone.utc)],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
            execute_context = filter_internal_subagent_messages(execute_context)

        # Try DAG execution if a plan exists (skip after continue_as_new — DAG already ran)
        if skip_dag:
            workflow.logger.info("[DAG] Skipping DAG (continued after context reset)")
        else:
            plan_data = extract_plan_from_context(execute_context)
            if plan_data:
                workflow.logger.info("[DAG] Found plan, attempting DAG execution")
                dag = TaskDAG(plan_data)

                execute_system_prompt = await self.build_system_prompt()

                dag_result = await execute_dag(
                    dag=dag,
                    agent_id=agent_id,
                    user_id=user_id,
                    model=model,
                    context=execute_context,
                    execute_activity=workflow.execute_activity,
                    post_message=self._post_message,
                    execute_tool=self._execute_tool,
                    handle_tool_event_fn=self._handle_tool_event,
                    poll_messages=self._poll_messages,
                    claude_token=self._active_claude_token(),
                    claude_token_source=self._active_claude_source(),
                    claude_token_pool_id=self._active_claude_pool_id(),
                    gpt_token=self._active_gpt_token(),
                    gpt_account_id=self._active_gpt_account_id(),
                    gpt_token_source=self._active_gpt_source(),
                    gpt_token_pool_id=self._active_gpt_pool_id(),
                    on_tokens=self._on_tokens,
                    system_prompt_text=execute_system_prompt,
                    tool_names=execute_tools,
                )

                # DAG completed or failed - both hand off to run_agent
                # run_agent polls from DB (DAG already posted results there)
                if dag_result["status"] == "completed":
                    workflow.logger.info("[DAG] Tasks completed, running verifier directly (skip LLM detour)")
                    # Force-attempt completion: run the verifier on the post-DAG
                    # context. If it scores 1.0, mark the agent complete and
                    # skip run_agent entirely — saves the LLM detour where
                    # agents otherwise spawn redundant claude_code/explore
                    # agents to "double-check" the DAG result.
                    post_dag_result = await self._run_post_dag_verifier(
                        agent_id=agent_id,
                        user_id=user_id,
                        model=model,
                    )
                    if post_dag_result and post_dag_result.get("score", 0.0) >= 1.0:
                        workflow.logger.info(
                            f"✓ Post-DAG verifier passed (score={post_dag_result['score']}) — marking complete"
                        )
                        await self._mark_complete(
                            execute_context,
                            post_dag_result.get("structured_response"),
                        )
                        return {"status": "completed", "goal": goal}
                    workflow.logger.info(
                        f"[DAG] Post-DAG verifier did not pass "
                        f"(score={post_dag_result.get('score', 0.0) if post_dag_result else 'n/a'}) "
                        "— falling through to run_agent for recovery"
                    )
                else:
                    workflow.logger.info("[DAG] Execution needs LLM recovery, falling through to run_agent")
            else:
                workflow.logger.info("[DAG] No plan found, using LLM-driven execution")

        # LLM-driven execution (after DAG, or if no plan)
        # Note: Don't pass initial_context - run_agent polls from DB each step
        # DAG already posted all results to DB via post_message callback

        # Refresh compute token before execute phase (may have expired during PLAN)
        await self._refresh_compute_token(user_id)

        execute_result = await run_agent(
            agent_id=agent_id,
            user_id=user_id,
            system_prompt=self.build_system_prompt,
            verifier_prompt_generator=self._make_verifier_prompt_generator(),
            model=model,
            tools=execute_tools,
            initial_context=None,  # Don't pass - run_agent polls from DB
            is_inside_temporal_activity=False,
            check_paused=self._check_paused,
            wait_for_messages=self._wait_for_messages,
            on_context_overflow=self._handle_context_overflow,
            check_credits=self._check_credits,
            post_message=self._post_message,
            poll_messages=self._poll_messages,
            execute_tool=self._execute_tool,
            update_tree_state=self._update_tree_state,
            get_children_tokens=self._get_children_tokens,
            on_tokens=self._on_tokens,  # Real-time cost tracking and limit checking
            max_context_tokens=self.max_context_tokens,
            reasoning_max_tokens=reasoning_max_tokens,
            skip_blueprint_query=True,
            response_schema=response_schema,
            get_response_schema=self._make_response_schema_getter(),
            claude_token=self._active_claude_token(),
            get_claude_token=self._active_claude_token,
            get_claude_token_source=self._active_claude_source,
            get_claude_token_pool_id=self._active_claude_pool_id,
            gpt_token=self._active_gpt_token(),
            gpt_account_id=self._active_gpt_account_id(),
            get_gpt_token=self._active_gpt_token,
            get_gpt_account_id=self._active_gpt_account_id,
            get_gpt_token_source=self._active_gpt_source,
            get_gpt_token_pool_id=self._active_gpt_pool_id,
            fast_mode_cache_enabled=self.fast_mode_cache_enabled,
            goal_text=self.goal,
            **({"max_iterations": self.max_iterations} if self.max_iterations else {}),
        )

        await self._track_tokens_and_cost(execute_result)

        if execute_result["status"] == "completed":
            await self._mark_complete(execute_result.get("context", []), execute_result.get("structured_response"))
            return {"status": "completed", "goal": goal}

        return await self._handle_incomplete(execute_result, "EXECUTE")

    # =========================================================================
    # CALLBACKS FOR run_agent
    # =========================================================================

    async def _run_post_dag_verifier(
        self,
        agent_id: str,
        user_id: str,
        model: str,
    ) -> Optional[Dict]:
        """Run the verifier directly after a successful DAG to short-circuit
        the LLM detour.

        After the DAG finishes, the agent's TOOL messages already contain
        every tool result needed to populate the goal's output schema. The
        verifier can transform those results into the schema in a single
        reasoning call. Letting the LLM iterate again invites it to spawn
        redundant claude_code/explore sub-agents to "double-check" the DAG
        result, burning the bench budget.

        Returns the verifier result dict (with `score`, `reasoning`,
        `structured_response`) or None if the call failed.
        """
        try:
            # Poll fresh context — DAG has been posting tool results to the DB.
            context = await workflow.execute_activity(
                poll_new_messages,
                args=[agent_id, datetime.fromtimestamp(0, tz=timezone.utc)],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
            context = filter_internal_subagent_messages(context)

            # Build verifier prompt (schema-driven only).
            prompt_gen = self._make_verifier_prompt_generator()
            verifier_prompt = await prompt_gen()

            # Refresh compute token in case it expired during DAG.
            await self._refresh_compute_token(user_id)

            # C7: dead `phase` positional arg has been removed from
            # check_progress; callers no longer pass it.
            # C14: `context` is already agent-scoped — poll_new_messages
            # queries the backend by `agent_id`, so sub-agent rows never
            # appear here.
            result = await workflow.execute_activity(
                check_progress,
                args=[
                    context,
                    verifier_prompt,
                    model,
                    self.output_schema,
                    self._active_claude_token(),
                    "verifier_post_dag",
                    agent_id,
                    self._active_claude_source(),
                    self._active_claude_pool_id(),
                    user_id,
                    self._active_gpt_token(),
                    self._active_gpt_account_id(),
                    self._active_gpt_source(),
                    self._active_gpt_pool_id(),
                    user_id,
                    None,  # dump_extra
                    # Fast Mode: verifier keys by canonical request fingerprint;
                    # fast_mode_step is retained only for activity signature compatibility.
                    self.fast_mode_cache_enabled,
                    self.goal,
                    0,
                ],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

            # C6: route post-DAG verifier cost through _on_tokens so this LLM
            # call doesn't drop off the cost ledger. _on_tokens is the canonical
            # entry-point for any LLM usage outside run_agent's own loop.
            v_usage = result.get("usage", {}) if result else {}
            v_tokens_in = v_usage.get("prompt_tokens", 0)
            v_tokens_out = v_usage.get("completion_tokens", 0)
            if v_tokens_in > 0 or v_tokens_out > 0:
                try:
                    await self._on_tokens(
                        v_tokens_in,
                        v_tokens_out,
                        v_usage.get("actual_model"),
                        cache_read_input_tokens=v_usage.get("cache_read_input_tokens", 0),
                        cache_creation_input_tokens=v_usage.get("cache_creation_input_tokens", 0),
                        call_site="verifier_post_dag",
                        claude_token_error=v_usage.get("claude_token_error"),
                        gpt_token_error=v_usage.get("gpt_token_error"),
                        claude_token_rotated=v_usage.get("claude_token_rotated", False),
                        gpt_token_rotated=v_usage.get("gpt_token_rotated", False),
                        compute_token_used=v_usage.get("compute_token_used"),
                    )
                except Exception as e:
                    workflow.logger.warning(f"[DAG] _on_tokens failed for post-DAG verifier: {e}")

            return result
        except Exception as e:
            workflow.logger.warning(f"[DAG] Post-DAG verifier failed: {e}")
            return None

    def _make_verifier_prompt_generator(self):
        """Create a generator function that builds the verifier prompt at verification time.

        The verifier prompt is now schema-driven only — no per-agent custom
        judge prompt. Schema is set synchronously during workflow setup
        (no lazy population, no schema polling), so this just returns the
        already-resolved schema-bound prompt.
        """

        async def generate() -> str:
            return build_verifier_prompt(response_schema=self.output_schema)

        return generate

    def _make_response_schema_getter(self):
        """Create a getter that returns the current output_schema.

        Called at verification time, after verifier_prompt_generator has polled for schema.
        This ensures check_progress receives the dynamically-fetched schema for structured output extraction.
        """

        async def get_schema() -> Optional[Dict]:
            return self.output_schema

        return get_schema

    async def build_system_prompt(self) -> str:
        """Build system prompt for the current phase.

        Called by run_agent before each LLM call.
        """
        await self._advance_cloud_agent_lifecycle(STARTING_REASONING_TITLE, "IN_PROGRESS")
        return build_system_prompt(
            phase=self.current_phase,
            enabled_tools=self._current_tools,
            disabled_tools=self._disabled_tools,
            user_context_section=self.user_context_section,
            response_schema=self.output_schema,
            tool_prompts=TOOL_PROMPTS,
        )

    async def _wait_for_messages(self) -> bool:
        """Wait for new messages."""
        try:
            await workflow.wait_condition(
                lambda: self._has_new_messages or not self.is_paused, timeout=timedelta(seconds=30)
            )
            result = self._has_new_messages
            self._has_new_messages = False
            return result
        except (asyncio.TimeoutError, TemporalTimeoutError):
            return False

    async def _handle_context_overflow(self, compressed_context: List[Dict]) -> None:
        """Handle context overflow via continue_as_new."""
        workflow.logger.info("Context overflow → continue_as_new")

        # Post a visible tool message so the user sees the context reset
        with contextlib.suppress(Exception):
            await workflow.execute_activity(
                post_agent_message,
                args=[
                    self.agent_id,
                    "Context compressed — continuing with summarized history.",
                    "TOOL",
                    {
                        "toolCallId": str(workflow.uuid4()),
                        "toolName": "context_reset",
                        "toolStatus": "FINISHED",
                        "title": "Context Reset",
                    },
                ],
                start_to_close_timeout=timedelta(seconds=10),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

        # Temporal SDK requires args=[] for multi-param workflows
        # Use "execute_continued" to skip DAG re-execution (DAG already ran)
        workflow.continue_as_new(
            args=[
                self.agent_id,
                self.user_id,
                self.goal,
                self.model,
                self.reasoning_max_tokens,
                self.verifier,
                compressed_context,
                self.parent_workflow_id,
                self.parent_agent_id,
                self.depth,
                self.bus_id,
                "execute_continued",  # Skip both PLAN and DAG — go straight to LLM
                self.max_iterations,
                self.price_limit_cents,
                self.context_gates or None,  # Preserve context gates across continue_as_new
                self.fast_mode_cache_enabled,  # Preserve Fast Mode cache flag
            ]
        )

    async def _check_paused(self) -> bool:
        """Check if paused, querying parent state first (non-root only)."""
        await self._check_parent_state()
        # Yield to event loop so Temporal processes any pending signals before we read is_paused
        await asyncio.sleep(0)
        return self.is_paused

    async def _check_credits(self) -> None:
        """Check user credits. Sets is_paused=True if depleted."""
        try:
            result = await workflow.execute_activity(
                check_user_usage,
                args=[self.user_id],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            if result and not result.get("has_credits", True):
                workflow.logger.warning("💰 Credits depleted - pausing agent")
                self.is_paused = True
                self._has_credits = False
            else:
                self._has_credits = True
        except Exception as e:
            workflow.logger.warning(f"Credit check failed (continuing): {e}")

    # Direct compute token TTL: 5 minutes
    COMPUTE_TOKEN_TTL = timedelta(minutes=5)

    def _clear_compute_token(self) -> None:
        self.compute_token_provider = None
        self.claude_max_token = None
        self.claude_max_token_source = None
        self.claude_max_token_pool_id = None
        self.gpt_code_token = None
        self.gpt_code_account_id = None
        self.gpt_code_token_source = None
        self.gpt_code_token_pool_id = None
        self.compute_token_fetched_at = None
        self.claude_max_token_fetched_at = None

    def _remember_compute_token(self, token: Optional[Dict[str, Any]]) -> bool:
        if not token or token.get("type") not in ("claude", "gpt") or not token.get("accessToken"):
            return False
        now = workflow.now()
        self._clear_compute_token()
        self.compute_token_provider = token.get("type")
        if self.compute_token_provider == "claude":
            self.claude_max_token = token.get("accessToken")
            self.claude_max_token_source = token.get("source")
            self.claude_max_token_pool_id = token.get("poolTokenId")
            self.claude_max_token_fetched_at = now
        else:
            self.gpt_code_token = token.get("accessToken")
            self.gpt_code_account_id = token.get("accountId")
            self.gpt_code_token_source = token.get("source")
            self.gpt_code_token_pool_id = token.get("poolTokenId")
        self.compute_token_fetched_at = now
        return True

    async def _refresh_compute_token(self, user_id: str) -> None:
        """Fetch or refresh the selected direct compute token if missing or expired."""
        now = workflow.now()
        fetched_at = self.compute_token_fetched_at or self.claude_max_token_fetched_at
        if fetched_at:
            age = now - fetched_at
            if age < self.COMPUTE_TOKEN_TTL:
                return  # Still fresh
            workflow.logger.info(
                f"🔑 Compute token expired ({age.total_seconds():.0f}s old), refreshing"
            )

        try:
            result = await workflow.execute_activity(
                fetch_compute_token_activity,
                args=[user_id],
                start_to_close_timeout=timedelta(seconds=20),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            if result and result.get("accessToken") and result.get("type") in ("claude", "gpt"):
                self._remember_compute_token(result)
                workflow.logger.info(
                    f"🔑 Compute token selected (type={self.compute_token_provider}, source={result.get('source')})"
                )
                return
        except Exception as e:
            workflow.logger.warning(f"Failed to fetch compute token: {e}")

        self._clear_compute_token()

    def _active_claude_token(self) -> Optional[str]:
        return self.claude_max_token if self.compute_token_provider == "claude" else None

    def _active_gpt_token(self) -> Optional[str]:
        return self.gpt_code_token if self.compute_token_provider == "gpt" else None

    def _active_gpt_account_id(self) -> Optional[str]:
        return self.gpt_code_account_id if self.compute_token_provider == "gpt" else None

    def _active_claude_source(self) -> Optional[str]:
        return self.claude_max_token_source if self.compute_token_provider == "claude" else None

    def _active_claude_pool_id(self) -> Optional[str]:
        return self.claude_max_token_pool_id if self.compute_token_provider == "claude" else None

    def _active_gpt_source(self) -> Optional[str]:
        return self.gpt_code_token_source if self.compute_token_provider == "gpt" else None

    def _active_gpt_pool_id(self) -> Optional[str]:
        return self.gpt_code_token_pool_id if self.compute_token_provider == "gpt" else None

    def _active_compute_token_payload(self) -> Optional[Dict[str, Any]]:
        if self.compute_token_provider == "claude" and self.claude_max_token:
            return {
                "type": "claude",
                "accessToken": self.claude_max_token,
                "userId": self.user_id,
                "source": self.claude_max_token_source,
                "poolTokenId": self.claude_max_token_pool_id,
            }
        if self.compute_token_provider == "gpt" and self.gpt_code_token:
            return {
                "type": "gpt",
                "accessToken": self.gpt_code_token,
                "userId": self.user_id,
                "accountId": self.gpt_code_account_id,
                "source": self.gpt_code_token_source,
                "poolTokenId": self.gpt_code_token_pool_id,
            }
        return None

    async def _refresh_claude_token(self, user_id: str) -> None:
        """Compatibility wrapper for older tests/callers."""
        await self._refresh_compute_token(user_id)

    async def _post_message(self, text: str, role: str = "ASSISTANT", metadata: Optional[Dict] = None) -> None:
        """Post message to database."""
        try:
            await workflow.execute_activity(
                post_agent_message,
                args=[self.agent_id, text, role, metadata],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
            # Track message count and broadcast tree state
            self.message_count += 1
            await self._update_tree_state()
        except Exception as e:
            workflow.logger.error(f"Failed to post message: {e}")

    async def _find_cloud_agent_lifecycle_tool_call_id(self) -> Optional[str]:
        """Find the chat-mode cloud-agent tool call that this workflow should update."""
        if self._cloud_agent_lifecycle_tool_call_id:
            return self._cloud_agent_lifecycle_tool_call_id

        messages = await workflow.execute_activity(
            poll_new_messages,
            args=[self.agent_id, datetime.fromtimestamp(0, tz=timezone.utc)],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )

        terminal_tool_call_ids = set()
        pending_tool_call_id = None

        for msg in messages or []:
            if (msg.get("role") or "").upper() != "TOOL":
                continue
            metadata = msg.get("metadata") or {}
            if metadata.get("toolName") != CLOUD_AGENT_TOOL_NAME:
                continue

            tool_call_id = metadata.get("toolCallId")
            if metadata.get("toolStatus") in {"FINISHED", "ERROR"} and tool_call_id:
                terminal_tool_call_ids.add(tool_call_id)
            elif (
                metadata.get("toolStatus") == "IN_PROGRESS"
                and metadata.get("title") in CLOUD_AGENT_IN_PROGRESS_TITLES
                and tool_call_id
            ):
                pending_tool_call_id = tool_call_id

        if pending_tool_call_id and pending_tool_call_id not in terminal_tool_call_ids:
            self._cloud_agent_lifecycle_tool_call_id = pending_tool_call_id
            return pending_tool_call_id

        if pending_tool_call_id in terminal_tool_call_ids:
            self._cloud_agent_lifecycle_finished = True
        elif pending_tool_call_id is None:
            # Most agent-mode workflows are created directly and never receive
            # the chat-mode cloud_agent lifecycle row. Cache that absence after
            # the first scan so later token callbacks do not keep scheduling
            # message-poll activities before user-visible tool execution.
            self._cloud_agent_lifecycle_finished = True

        return None

    async def _advance_cloud_agent_lifecycle(self, title: str, tool_status: str) -> None:
        """Advance the chat-mode cloud-agent chip without exposing it to LLM context."""
        if self._cloud_agent_lifecycle_finished:
            return

        update_key = f"{tool_status}:{title}"
        if update_key in self._cloud_agent_lifecycle_updates_sent:
            return

        try:
            tool_call_id = await self._find_cloud_agent_lifecycle_tool_call_id()
            if not tool_call_id:
                return

            await self._post_message(
                "",
                "TOOL",
                {
                    "toolCallId": tool_call_id,
                    "toolName": CLOUD_AGENT_TOOL_NAME,
                    "toolStatus": tool_status,
                    "title": title,
                },
            )
            self._cloud_agent_lifecycle_updates_sent.add(update_key)
            if tool_status in {"FINISHED", "ERROR"}:
                self._cloud_agent_lifecycle_finished = True
        except Exception as e:
            workflow.logger.warning(f"Failed to advance cloud agent lifecycle tool: {e}")

    async def _poll_messages(self, last_checked: datetime) -> List[Dict]:
        """Poll for new messages using the timestamp provided by run_agent.

        Args:
            last_checked: The timestamp to poll from (managed by run_agent, not workflow state)
        """
        try:
            messages = await workflow.execute_activity(
                poll_new_messages,
                args=[self.agent_id, last_checked],  # Use run_agent's timestamp, not self.last_message_check
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

            # Update workflow context for tools that check it. Return the raw
            # poll result so run_agent can still advance last_checked past
            # filtered sub-agent rows and avoid re-polling them forever.
            if messages:
                for msg in filter_internal_subagent_messages(messages):
                    if msg not in self.context:
                        self.context.append(msg)
                self.context.sort(key=lambda x: x.get("timestamp", ""))

            return messages
        except Exception as e:
            workflow.logger.error(f"Failed to poll messages for {self.agent_id}: {e}")
            raise

    async def _execute_tool(self, tool_name: str, tool_args: Dict, tool_call_id: str) -> Dict:  # noqa: C901
        """Execute a tool - supports both new and legacy signatures during migration.

        Every error return path MUST first emit a paired TOOL event via
        _handle_tool_event so the next iteration's LLM call sees alternating
        USER/ASSISTANT/TOOL turns. Returning an error dict without posting a
        tool_result leaves the prior ASSISTANT tool_use unpaired, which trips
        role_alternation and causes the LLM to re-emit the same tool_calls
        (regression: smoke task `parallel-tool-calls`).
        """
        if tool_name not in TOOL_EXECUTORS:
            error_msg = f"Unknown tool: {tool_name}"
            await self._handle_tool_event(
                ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"❌ {tool_name.replace('_', ' ').title()} failed",
                    message=error_msg,
                    status=MessageStatus.ERROR,
                ),
                tool_call_id,
                tool_name,
            )
            return {"error": True, "message": error_msg}

        # Semantic validation: validate tool args against Pydantic model_validators
        from utils.tool_schemas import TOOL_MODELS

        if tool_name in TOOL_MODELS:
            try:
                TOOL_MODELS[tool_name](**{"tool": tool_name, **tool_args})
            except Exception as e:
                error_msg = f"Invalid parameters for {tool_name}: {e}"
                await self._handle_tool_event(
                    ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title=f"❌ {tool_name.replace('_', ' ').title()} failed",
                        message=error_msg,
                        status=MessageStatus.ERROR,
                    ),
                    tool_call_id,
                    tool_name,
                )
                return {"error": True, "message": error_msg}

        # Track tool as in-use with human-readable display string
        tool_display = format_tool_display(tool_name, tool_args)
        self.tools_in_use.add(tool_display)
        await self._update_tree_state()

        try:
            # Check approval requirement
            if tool_name in APPROVAL_REQUIRED_TOOLS:
                manager = APPROVAL_REQUIRED_TOOLS[tool_name]()
                if manager.requires_approval:
                    # Pass system_name for dynamic name in approval messages
                    question = manager.get_approval_question(
                        {"tool": tool_name, "system_name": self.system_name, **tool_args}
                    )
                    # Let UserRejectedError bubble up to outer Exception handler
                    # which posts ERROR for tool_call_id_A
                    await request_user_approval_direct(self, question=question, metadata={"toolApproval": True})

            executor = TOOL_EXECUTORS[tool_name]

            # Tools migrated to new signature: (execute_activity, tool_call, tool_call_id, agent_id, user_id)
            # These return results and call handle_tool_event internally
            NEW_SIGNATURE_TOOLS = {
                "web_search",
                "web_fetch",
                "attempt_completion",
                "call_phone_number",
                "grep",
            }

            if tool_name in NEW_SIGNATURE_TOOLS:
                tool_call_dict = {"tool": tool_name, **tool_args}
                if tool_name in ("attempt_completion", "spawn_agent"):
                    tool_call_dict["_phase"] = self.current_phase

                # web_fetch's WebFetchManager invokes summarize_tool_result on
                # large bodies; pass auth so the summarizer can use claudeAuth
                # ($0) instead of falling through OpenRouter waterfall.
                extra_executor_kwargs: Dict[str, Any] = {}
                # Fast Mode: pass the goal so web_search/web_fetch can either
                # read+write (Fast Mode on) or write-only for allowlisted accounts.
                fast_mode_write_through = self.user_id in FAST_MODE_WRITE_THROUGH_USER_IDS
                if tool_name in ("web_search", "web_fetch") and (
                    self.fast_mode_cache_enabled or fast_mode_write_through
                ):
                    extra_executor_kwargs["fast_mode_cache_enabled"] = self.fast_mode_cache_enabled
                    extra_executor_kwargs["fast_mode_goal"] = self.goal
                    extra_executor_kwargs["fast_mode_cache_write_enabled"] = (
                        self.fast_mode_cache_enabled or fast_mode_write_through
                    )
                if tool_name == "web_fetch":
                    extra_executor_kwargs.update(
                        {
                            "claude_token": self._active_claude_token(),
                            "claude_token_source": self._active_claude_source(),
                            "claude_token_pool_id": self._active_claude_pool_id(),
                            "gpt_token": self._active_gpt_token(),
                            "gpt_account_id": self._active_gpt_account_id(),
                            "gpt_token_source": self._active_gpt_source(),
                            "gpt_token_pool_id": self._active_gpt_pool_id(),
                        }
                    )

                result = await executor(
                    execute_activity=workflow.execute_activity,
                    tool_call=tool_call_dict,
                    tool_call_id=tool_call_id,
                    agent_id=self.agent_id,
                    user_id=self.user_id,
                    **extra_executor_kwargs,
                )
                # Track usage if returned by tool (standardized format)
                original_usage = {}
                rotation_signal: Optional[Dict[str, Any]] = None
                if isinstance(result, dict) and "usage" in result:
                    original_usage = result.get("usage", {})
                    await self._track_usage(original_usage, tool_name=tool_name)
                    rotation_signal = result.get("summarizer_rotation_signal")
                    # Extract actual result for caller
                    result = result.get("result", result)

                # Route rotation signals from the per-tool summarizer through
                # _on_tokens so pool-token rotation kicks in on 401/429/stall
                # the same way it would for the main LLM call.
                if rotation_signal:
                    try:
                        await self._on_tokens(
                            tokens_in_delta=rotation_signal.get("prompt_tokens", 0),
                            tokens_out_delta=rotation_signal.get("completion_tokens", 0),
                            actual_model=rotation_signal.get("actual_model", "unknown"),
                            cache_read_input_tokens=rotation_signal.get("cache_read_input_tokens", 0),
                            cache_creation_input_tokens=rotation_signal.get("cache_creation_input_tokens", 0),
                            call_site=f"summarize_{tool_name}",
                            claude_token_error=rotation_signal.get("claude_token_error"),
                            claude_token_rotated=rotation_signal.get("claude_token_rotated", False),
                            gpt_token_error=rotation_signal.get("gpt_token_error"),
                            gpt_token_rotated=rotation_signal.get("gpt_token_rotated", False),
                            compute_token_used=rotation_signal.get("compute_token_used"),
                        )
                    except Exception as e:
                        workflow.logger.warning(f"_on_tokens failed for {tool_name} summarizer: {e}")

                # Post downloaded files as ASSISTANT messages (like browser/code agents do)
                # This makes FilePointers visible in the frontend and agent context
                downloaded_files = (
                    (result.get("original", {}) or {}).get("downloaded_files", []) if isinstance(result, dict) else []
                )
                if not downloaded_files and isinstance(result, dict):
                    downloaded_files = result.get("downloaded_files", [])
                for fp in downloaded_files:
                    await self._handle_tool_event(
                        AssistantEvent(message="", file_pointer=fp),
                        tool_call_id,
                        tool_name,
                    )

                return {"success": True, "message": f"{tool_name} completed", "result": result}
            else:
                # Legacy signature: (workflow_instance, tool_call, tool_call_id)
                # These yield ToolEvents and call workflow_instance._handle_tool_event
                tool_call_dict = {"tool": tool_name, **tool_args}
                if tool_name == "spawn_agent":
                    tool_call_dict["_phase"] = self.current_phase
                executor_result = await executor(self, tool_call_dict, tool_call_id)
                # spawn_agent returns (last_status, summary) tuple
                if isinstance(executor_result, tuple):
                    last_status, result_text = executor_result
                else:
                    last_status, result_text = executor_result, ""
                failed = last_status == MessageStatus.ERROR
                if failed:
                    return {"error": True, "message": result_text or f"{tool_name} failed"}
                return {"success": True, "message": result_text or f"{tool_name} completed"}

        except asyncio.CancelledError:
            # User paused the agent - don't show as error
            workflow.logger.info(f"Tool {tool_name} cancelled (user paused)")
            return {"success": False, "message": "User paused the agent during browser execution"}

        except Exception as e:
            error_msg = extract_error_message(e)

            # Include user's rejection feedback in the error message
            if isinstance(e, UserRejectedError) and e.rejection_message:
                error_msg = f'User rejected with feedback: "{e.rejection_message}"'
                workflow.logger.info(f"Tool {tool_name} rejected by user: {e.rejection_message[:100]}")
            else:
                workflow.logger.error(f"Tool {tool_name} failed: {error_msg}")

            # For spawn_agent (general_purpose type), include child-agent context so frontend renders
            # as a proper sub-agent failure (SubAgentTree) instead of a raw chip
            error_metadata = None
            if tool_name == "spawn_agent" and tool_args.get("type") == "general_purpose":
                meta = {}
                # Find the child agent spawned by this tool_call_id
                for child_id, tid in getattr(self, "child_tool_ids", {}).items():
                    if tid == tool_call_id:
                        meta["subAgentIds"] = [child_id]
                        break
                bus_id = getattr(self, "bus_id", None)
                if bus_id:
                    meta["busId"] = bus_id
                if meta:
                    error_metadata = meta

            # Emit error event so it shows in frontend
            await self._handle_tool_event(
                ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"❌ {tool_name.replace('_', ' ').title()} failed",
                    message=error_msg,
                    status=MessageStatus.ERROR,
                    metadata=error_metadata,
                ),
                tool_call_id,
                tool_name,
            )
            return {"error": True, "message": error_msg}
        finally:
            # Remove tool from in-use and broadcast tree state
            self.tools_in_use.discard(tool_display)
            await self._update_tree_state()

    async def _handle_tool_event(self, event: ToolEvent, tool_call_id: str, tool_name: str) -> None:
        """
        Handle ToolEvent emitted by tool managers.

        Delegates to standalone handle_tool_event function which routes events
        to appropriate FE/DB updates. Works in both workflow and activity contexts.

        Note: Cost tracking is handled separately via _track_usage() for tools that
        return standardized usage dicts, not through events.
        """
        if isinstance(event, ToolEvent):
            phase = getattr(self, "current_phase", None)
            metadata = dict(event.metadata or {})
            if phase:
                metadata.setdefault("phase", phase)
            event.metadata = metadata

        # handle_tool_event imported at module level within imports_passed_through
        await handle_tool_event(
            event=event,
            agent_id=self.agent_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            execute_activity=workflow.execute_activity,  # Workflow context
            user_id=self.user_id,
            sub_agent_id=None,  # Main workflow doesn't have sub_agent_id
        )

    # =========================================================================
    # HELPERS
    # =========================================================================

    async def _track_tokens_and_cost(self, result: Dict) -> None:
        """Track context size and token_count from run_agent result.

        NOTE: tokens_in/out and cost are now tracked in real-time via _on_tokens callback
        during run_agent execution. This method only handles:
        1. context_size update (current context window)
        2. token_count update (total tokens for display)

        For non-run_agent LLM calls (e.g., completion summary), use _track_llm_cost directly.
        """
        # Update token_count (for display purposes)
        self.token_count += result.get("token_count", 0)

        # Update context_size to latest value (not cumulative - represents current context window)
        if "context_size" in result:
            self.context_size = result["context_size"]

        # NOTE: tokens_in/out and cost tracking moved to _on_tokens callback
        # which is called after each LLM call in run_agent for real-time limit checking

    async def _track_llm_cost(self, tokens_in: int, tokens_out: int, call_site: str = "unknown") -> None:
        """Track cost for LLM calls outside run_agent (e.g., completion summary).

        Use this for LLM calls that don't go through run_agent and thus don't trigger _on_tokens.

        Args:
            tokens_in: Input/prompt tokens
            tokens_out: Output/completion tokens
            call_site: Label identifying the LLM call source (e.g., completion_summary, context_compression)
        """
        # Update workflow token state
        self.tokens_in += tokens_in
        self.tokens_out += tokens_out

        # Calculate cost from tokens using stored pricing (fractional cents)
        if self.input_cents_per_1k > 0 or self.output_cents_per_1k > 0:
            cost_cents = (tokens_in * self.input_cents_per_1k / 1000) + (tokens_out * self.output_cents_per_1k / 1000)
            if cost_cents > 0:
                self.own_cost_cents += cost_cents
                workflow.logger.info(
                    f"💰 LLM cost ({call_site}): +{cost_cents:.2f}c (total: {self.own_cost_cents:.1f}c, "
                    f"in={tokens_in}, out={tokens_out})"
                )

                # Save to ToolUsage table for call_site tracking
                try:
                    await workflow.execute_activity(
                        save_tool_usage,
                        args=[
                            self.agent_id,
                            self.user_id,
                            call_site,
                            [
                                {
                                    "type": "llm",
                                    "cost_cents": cost_cents,
                                    "call_site": call_site,
                                    "tokens_in": tokens_in,
                                    "tokens_out": tokens_out,
                                    "model": self.model,
                                }
                            ],
                        ],
                        start_to_close_timeout=timedelta(seconds=15),
                        retry_policy=RetryPolicy(maximum_attempts=2),
                    )
                except Exception as e:
                    workflow.logger.warning(f"Failed to save tool usage for {call_site}: {e}")

                # Recalculate subtree cost and check limit
                await self._update_cost_and_signal_parent()

    async def _track_usage(
        self, usage: Optional[Dict] = None, tool_name: Optional[str] = None, call_site: Optional[str] = None
    ) -> None:
        """
        Track usage from any activity result.

        This is THE SINGLE POINT where all costs are:
        1. Calculated (LLM tokens → cost via pricing)
        2. Added to own_cost_cents
        3. Written to ToolUsage table (if tool_name provided)
        4. Signaled to parent for hierarchical relay

        Args:
            usage: Dict with "llm" and/or "service" lists
            tool_name: Tool name for ToolUsage table (optional for internal LLM calls)
            call_site: Label identifying the LLM call source (e.g., planner, explore_agent, browser_agent).
                       Falls back to tool_name if not provided.
        """
        if not usage:
            return

        total_cost_cents = 0
        usage_items_for_db = []

        # Process LLM usage items
        for llm in usage.get("llm", []):
            tokens_in = llm.get("tokens_in", 0)
            tokens_out = llm.get("tokens_out", 0)
            model = llm.get("model") or self.model
            provider = llm.get("provider") or model
            effective_call_site = call_site or tool_name or "unknown"
            cache_read = llm.get("cache_read_input_tokens", 0)
            cache_write = llm.get("cache_creation_input_tokens", 0)

            if isinstance(model, str) and (model.endswith("-claude") or model.endswith("-gpt")):
                workflow.logger.info(
                    f"💰 $0 cost (direct compute token): actual_model={model}, "
                    f"in={tokens_in}, out={tokens_out}, call_site={effective_call_site}"
                )
                usage_items_for_db.append(
                    {
                        "type": "llm",
                        "cost_cents": 0,
                        "call_site": effective_call_site,
                        "provider": provider,
                        "tokens_in": tokens_in,
                        "tokens_out": tokens_out,
                        "model": model,
                        "cache_read_input_tokens": cache_read,
                        "cache_creation_input_tokens": cache_write,
                    }
                )
                continue

            # Get pricing for this model (fetch if not cached)
            pricing = await self._get_model_pricing(model)
            if not pricing:
                workflow.logger.warning(
                    f"⚠️ No pricing for model {model}, skipping cost for {tokens_in}/{tokens_out} tokens"
                )
                continue

            input_rate = pricing["input_cents_per_1k"]
            output_rate = pricing["output_cents_per_1k"]

            # Apply provider-specific cache discounts if cache fields present
            is_anthropic = model and ("claude" in model.lower() or model.lower().endswith("-claude"))
            cache_read_mult = 0.1 if is_anthropic else 0.25
            cache_write_mult = 1.25 if is_anthropic else 1.0

            cost_cents = (
                (tokens_in * input_rate / 1000)
                + (cache_read * input_rate * cache_read_mult / 1000)
                + (cache_write * input_rate * cache_write_mult / 1000)
                + (tokens_out * output_rate / 1000)
            )
            usage_item = {
                "type": "llm",
                "cost_cents": cost_cents,
                "call_site": effective_call_site,
                "provider": provider,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "model": model,
                "cache_read_input_tokens": cache_read,
                "cache_creation_input_tokens": cache_write,
            }
            if cost_cents > 0:
                total_cost_cents += cost_cents
                workflow.logger.info(
                    f"💰 LLM cost: +{cost_cents:.2f}c ({provider}, in={tokens_in}, out={tokens_out}, call_site={effective_call_site})"
                )
                usage_items_for_db.append(usage_item)

        # Process service usage items (pre-calculated costs)
        for svc in usage.get("service", []):
            cost_cents = svc.get("cost_cents", 0)
            provider = svc.get("provider", "Service")
            if cost_cents > 0:
                total_cost_cents += cost_cents
                workflow.logger.info(f"💰 Service cost: +{cost_cents}c ({provider})")
                effective_call_site = call_site or tool_name or "unknown"
                usage_items_for_db.append(
                    {
                        "type": "service",
                        "cost_cents": cost_cents,
                        "call_site": effective_call_site,
                        "provider": provider,
                    }
                )

        if total_cost_cents > 0:
            # Update workflow cost state
            self.own_cost_cents += total_cost_cents
            workflow.logger.info(f"💰 Total own_cost_cents: {self.own_cost_cents}c (+{total_cost_cents}c)")

            # Signal parent for hierarchical cost relay
            await self._update_cost_and_signal_parent()

        # Write to ToolUsage table (if tool_name provided). This intentionally
        # includes zero-cost direct-token LLM rows so cache/accounting diagnostics
        # can see the same LLM calls that worker logs emit.
        effective_call_site = call_site or tool_name or "unknown"
        if tool_name and usage_items_for_db:
            try:
                await workflow.execute_activity(
                    save_tool_usage,
                    args=[self.agent_id, self.user_id, effective_call_site, usage_items_for_db],
                    start_to_close_timeout=timedelta(seconds=15),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as e:
                workflow.logger.warning(f"Failed to save tool usage to DB: {e}")

    async def _get_model_pricing(self, model: str) -> Optional[Dict[str, float]]:
        """Get pricing for a model, using cache or fetching if needed."""
        # Check if it's the workflow's primary model
        if model == self.model and (self.input_cents_per_1k > 0 or self.output_cents_per_1k > 0):
            return {
                "input_cents_per_1k": self.input_cents_per_1k,
                "output_cents_per_1k": self.output_cents_per_1k,
            }

        # Check cache
        if model in self.model_pricing_cache:
            return self.model_pricing_cache[model]

        # Pricing is an in-process constant table. Keep this on the workflow
        # path so cost accounting cannot stall user-visible tools behind the
        # activity queue under benchmark load.
        pricing = get_in_process_model_pricing(model)
        if pricing is None:
            pricing = get_default_pricing(model)
            workflow.logger.warning(f"💰 Using default pricing fallback for {model}: {pricing}")
        else:
            workflow.logger.info(f"💰 Resolved pricing for {model}: {pricing}")
        self.model_pricing_cache[model] = pricing
        return pricing

    # =========================================================================
    # COST LIMIT HELPERS
    # =========================================================================

    async def _query_parent_state(self) -> Dict:
        """Query parent workflow's state via activity (uses Temporal client).

        ExternalWorkflowHandle only supports signal/cancel, not query.
        This activity bridges the gap by querying via the client.
        Returns empty dict on failure (caller decides how to handle).
        """
        if not self.parent_workflow_id:
            return {}
        try:
            return await workflow.execute_activity(
                query_parent_state_activity,
                args=[self.parent_workflow_id],
                start_to_close_timeout=timedelta(seconds=10),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception as e:
            workflow.logger.warning(f"Failed to query parent state: {e}")
            return {}

    async def _check_parent_state(self) -> None:
        """Pull-based parent state check. Mirrors parent's pause/cost-limit state.

        Handles both directions:
        - Parent paused → child inherits pause (sets _paused_by_parent)
        - Parent unpaused → child unpauses (only if _paused_by_parent, not manual/credits)
        """
        if not self.parent_workflow_id:
            return

        state = await self._query_parent_state()
        if not state:
            return

        parent_cost_limited = state.get("is_cost_limit_reached", False)
        parent_paused = state.get("is_paused", False)

        if parent_cost_limited:
            if not self._cost_limit_reached:
                workflow.logger.warning("Parent hit cost limit — inheriting state")
                self._cost_limit_reached = True
                self.is_paused = True
                self._paused_by_parent = True
                await self._update_tree_state(status="COST_LIMIT_REACHED")
        elif parent_paused:
            if not self.is_paused:
                workflow.logger.warning("Parent is paused — inheriting state")
                self.is_paused = True
                self._paused_by_parent = True
                await self._update_tree_state(status="PAUSED")
        else:
            # Parent is running — unpause if we were paused by parent
            if self._paused_by_parent:
                workflow.logger.info("Parent resumed — clearing inherited pause")
                self._cost_limit_reached = False
                self.is_paused = False
                self._paused_by_parent = False
                await self._update_tree_state(status="ACTIVE")

    def _get_pending_child_workflow_ids(self) -> List[str]:
        """Get workflow IDs of pending children for signaling."""
        return [self.child_workflow_ids[cid] for cid in self.pending_children if cid in self.child_workflow_ids]

    def _get_children_tokens(self) -> Tuple[int, int]:
        """Get current sum of children's tokens for tree aggregation."""
        return (
            sum(self.children_tokens_in.values()),
            sum(self.children_tokens_out.values()),
        )

    async def _on_tokens(
        self,
        tokens_in_delta: int,
        tokens_out_delta: int,
        actual_model: Optional[str] = None,
        cache_read_input_tokens: int = 0,
        cache_creation_input_tokens: int = 0,
        call_site: str = "unknown",
        claude_token_error: Optional[str] = None,
        gpt_token_error: Optional[str] = None,
        claude_token_rotated: bool = False,
        gpt_token_rotated: bool = False,
        compute_token_used: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Callback for run_agent to report token usage after each LLM call.

        This enables real-time cost tracking and limit checking, not just at phase boundaries.

        Args:
            tokens_in_delta: Non-cached input tokens (Anthropic semantics)
            tokens_out_delta: Output/completion tokens
            actual_model: The model that actually served the request
            cache_read_input_tokens: Cached input tokens read (discounted pricing)
            cache_creation_input_tokens: Tokens written to cache (may cost extra for Anthropic)
            call_site: Label identifying the LLM call source (e.g., plan_loop, execute_loop, verifier_execute)
            claude_token_error: Why the claude token call failed (auth_error, rate_limit, stall, server_error)
            claude_token_rotated: True when RoseClient swapped tokens inside a successful claudeAuth call.
            gpt_token_rotated: True when RoseClient swapped tokens inside a successful gptAuth call.
        """
        # Update workflow token state (keep in sync with run_agent local vars)
        self.tokens_in += tokens_in_delta
        self.tokens_out += tokens_out_delta
        self.token_count += tokens_in_delta + tokens_out_delta
        self.context_size = tokens_in_delta + cache_read_input_tokens + cache_creation_input_tokens
        await self._advance_cloud_agent_lifecycle(CLOUD_AGENT_READY_TITLE, "FINISHED")

        # Track actual_model for credit billing
        if actual_model:
            self.actual_model = actual_model

            token_used_type = compute_token_used.get("type") if compute_token_used else None
            if compute_token_used and (
                (token_used_type == "claude" and actual_model.endswith("-claude"))
                or (token_used_type == "gpt" and actual_model.endswith("-gpt"))
            ):
                if self._remember_compute_token(compute_token_used):
                    workflow.logger.info(
                        f"🔑 Workflow cached compute token updated from successful call "
                        f"(type={self.compute_token_provider}, source={compute_token_used.get('source')})"
                    )

            if (
                self.compute_token_provider == "claude"
                and self.claude_max_token
                and actual_model.endswith("-claude")
                and claude_token_rotated
                and not compute_token_used
            ):
                workflow.logger.info(
                    "🔁 Claude token rotated inside RoseClient; refreshing workflow cached token"
                )
                self._clear_compute_token()
                if self.user_id:
                    try:
                        await self._refresh_compute_token(self.user_id)
                    except Exception as refresh_error:
                        workflow.logger.warning(
                            f"Rotation refetch failed after successful claudeAuth call: {refresh_error}"
                        )

            # Detect direct-token fallback: we had a selected token but Rose fell through to
            # the waterfall. Rotate on auth/rate-limit (token is bad) and on stall (RoseClient
            # already exhausted in-place TTFT-bumped retries on the same token, so the slot
            # itself is unhappy — swap to a different one). 5xx still keeps the token: it's
            # provider-side, retrying the same slot next call is the right call.
            if (
                self.compute_token_provider == "claude"
                and self.claude_max_token
                and actual_model != "unknown"
                and not actual_model.endswith("-claude")
            ):
                if claude_token_error in ("auth_error", "rate_limit", "stall"):
                    workflow.logger.warning(
                        f"⚠️ Claude token {claude_token_error}: actual_model={actual_model}, "
                        f"marking {self.claude_max_token_source} token rate-limited and rotating"
                    )
                    # Mark the offending token rate-limited in DB so the next fetch rotates:
                    #   source='user' → next fetch falls back to pool
                    #   source='pool' → fetchPoolToken skips this ID and returns a different pool token
                    # The cooldown is time-windowed (5 min); token auto-heals after rateLimitedUntil.
                    if self.claude_max_token_source and self.user_id:
                        try:
                            await workflow.execute_activity(
                                mark_compute_token_rate_limited_activity,
                                args=[
                                    "claude",
                                    self.claude_max_token_source,
                                    self.user_id,
                                    self.claude_max_token_pool_id,
                                    5 * 60,
                                    None,
                                    claude_token_error,
                                ],
                                start_to_close_timeout=timedelta(seconds=10),
                                retry_policy=RetryPolicy(maximum_attempts=2),
                            )
                        except Exception as mark_error:
                            workflow.logger.warning(
                                f"Failed to mark Claude token rate-limited: {mark_error}"
                            )
                    # Clear cache to force refetch on next call → rotation kicks in
                    self._clear_compute_token()
                    # Proactively refetch so subsequent LLM calls in this phase use the
                    # rotated token (otherwise they'd fall through to the waterfall until
                    # the next phase boundary calls _refresh_compute_token).
                    if self.user_id:
                        try:
                            await self._refresh_compute_token(self.user_id)
                        except Exception as refresh_error:
                            workflow.logger.warning(
                                f"Rotation refetch failed: {refresh_error}"
                            )
                else:
                    workflow.logger.info(
                        f"ℹ️ Claude token fallback (transient: {claude_token_error}): "
                        f"actual_model={actual_model}, keeping token for retry"
                    )
            if (
                self.compute_token_provider == "gpt"
                and self.gpt_code_token
                and actual_model.endswith("-gpt")
                and gpt_token_rotated
                and not compute_token_used
            ):
                workflow.logger.info(
                    "🔁 GPT token rotated inside RoseClient; refreshing workflow cached token"
                )
                self._clear_compute_token()
                if self.user_id:
                    try:
                        await self._refresh_compute_token(self.user_id)
                    except Exception as refresh_error:
                        workflow.logger.warning(
                            f"GPT rotation refetch failed after successful gptAuth call: {refresh_error}"
                        )

            if (
                self.compute_token_provider == "gpt"
                and self.gpt_code_token
                and actual_model != "unknown"
                and not actual_model.endswith("-gpt")
            ):
                if gpt_token_error in ("auth_error", "rate_limit", "stall"):
                    workflow.logger.warning(
                        f"⚠️ GPT token {gpt_token_error}: actual_model={actual_model}, "
                        f"marking {self.gpt_code_token_source} token rate-limited and rotating"
                    )
                    if self.gpt_code_token_source and self.user_id:
                        try:
                            await workflow.execute_activity(
                                mark_compute_token_rate_limited_activity,
                                args=[
                                    "gpt",
                                    self.gpt_code_token_source,
                                    self.user_id,
                                    self.gpt_code_token_pool_id,
                                    5 * 60,
                                    None,
                                    gpt_token_error,
                                ],
                                start_to_close_timeout=timedelta(seconds=10),
                                retry_policy=RetryPolicy(maximum_attempts=2),
                            )
                        except Exception as mark_error:
                            workflow.logger.warning(
                                f"Failed to mark GPT token rate-limited: {mark_error}"
                            )
                    self._clear_compute_token()
                    if self.user_id:
                        try:
                            await self._refresh_compute_token(self.user_id)
                        except Exception as refresh_error:
                            workflow.logger.warning(
                                f"GPT rotation refetch failed: {refresh_error}"
                            )
                else:
                    workflow.logger.info(
                        f"ℹ️ GPT token fallback (transient: {gpt_token_error}): "
                        f"actual_model={actual_model}, keeping token for retry"
                    )

        # Use actual_model pricing if available
        # For Anthropic models: hardcoded pricing (includes -claude passthrough = $0)
        # For OpenRouter models: falls back to pool-average (self.input_cents_per_1k)
        input_rate = self.input_cents_per_1k
        output_rate = self.output_cents_per_1k
        if actual_model:
            actual_pricing = get_anthropic_pricing(actual_model)
            if actual_pricing is not None:
                input_rate = actual_pricing["input_cents_per_1k"]
                output_rate = actual_pricing["output_cents_per_1k"]
                if input_rate == 0 and output_rate == 0:
                    workflow.logger.info(
                        f"💰 $0 cost (direct compute token): actual_model={actual_model}, "
                        f"in={tokens_in_delta}, out={tokens_out_delta}"
                    )

        # Calculate cost with provider-specific cache discounts
        # Anthropic direct: cache read = 0.1x input, cache write = 1.25x input
        # OpenRouter (all other providers): cache read = 0.25x input, cache write = 1.0x input
        is_anthropic = actual_model and ("claude" in actual_model.lower() or actual_model.lower().endswith("-claude"))
        cache_read_mult = 0.1 if is_anthropic else 0.25
        cache_write_mult = 1.25 if is_anthropic else 1.0

        cost_cents = 0.0
        if input_rate > 0 or output_rate > 0:
            input_cost = tokens_in_delta * input_rate / 1000
            cache_read_cost = cache_read_input_tokens * input_rate * cache_read_mult / 1000
            cache_write_cost = cache_creation_input_tokens * input_rate * cache_write_mult / 1000
            output_cost = tokens_out_delta * output_rate / 1000
            cost_cents = input_cost + cache_read_cost + cache_write_cost + output_cost

            if cost_cents > 0:
                self.own_cost_cents += cost_cents
                cache_info = ""
                if cache_read_input_tokens > 0 or cache_creation_input_tokens > 0:
                    cache_info = f", cache_read={cache_read_input_tokens}@{cache_read_mult}x, cache_write={cache_creation_input_tokens}@{cache_write_mult}x"
                workflow.logger.info(
                    f"💰 LLM cost: +{cost_cents:.2f}c (total own: {self.own_cost_cents:.1f}c, "
                    f"in={tokens_in_delta}, out={tokens_out_delta}{cache_info})"
                )

                # Recalculate subtree cost and check limit (for root) or signal parent
                await self._update_cost_and_signal_parent()

        # Save ToolUsage record for credit billing (with actual_model and correct cost)
        model_for_usage = actual_model or self.model
        try:
            await workflow.execute_activity(
                save_tool_usage,
                args=[
                    self.agent_id,
                    self.user_id,
                    call_site,
                    [
                        {
                            "type": "llm",
                            "cost_cents": cost_cents,
                            "call_site": call_site,
                            "tokens_in": tokens_in_delta,
                            "tokens_out": tokens_out_delta,
                            "model": model_for_usage,
                            "cache_read_input_tokens": cache_read_input_tokens,
                            "cache_creation_input_tokens": cache_creation_input_tokens,
                        }
                    ],
                ],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception as e:
            workflow.logger.warning(f"Failed to save LLM usage to DB: {e}")

    async def _update_cost_and_signal_parent(self) -> None:
        """Recalculate subtree cost/tokens and signal parent (or check limit if root)."""
        # Recalculate subtree cost
        self.subtree_cost_cents = self.own_cost_cents + sum(self.children_cost_cents.values())

        # Recalculate tree tokens (own + all children's subtrees)
        self.tree_tokens_in = self.tokens_in + sum(self.children_tokens_in.values())
        self.tree_tokens_out = self.tokens_out + sum(self.children_tokens_out.values())

        # Persist subtree cost to DB (for all agents, so frontend can display it)
        await self._persist_tree_cost()

        # Signal parent (if we have one)
        if self.parent_workflow_id:
            try:
                parent = workflow.get_external_workflow_handle(self.parent_workflow_id)
                await parent.signal(
                    "child_cost_update",
                    {
                        "child_agent_id": self.agent_id,
                        "subtree_cost_cents": self.subtree_cost_cents,
                        "subtree_tokens_in": self.tree_tokens_in,
                        "subtree_tokens_out": self.tree_tokens_out,
                    },
                )
            except Exception as e:
                workflow.logger.warning(f"Failed to signal parent cost update: {e}")
        else:
            # We are root - check cost limit
            await self._check_cost_limit()

        # Broadcast updated tree tokens to this agent's channel (for frontend display)
        # This applies to all agents (root and non-root) when receiving child updates
        # Skip if paused, cost-limited, or already finished — don't overwrite
        # PAUSED/COST_LIMIT_REACHED/COMPLETED/FAILED DB status with ACTIVE.
        # Regression: a late child_cost_update signal arriving after _mark_complete
        # would broadcast status=ACTIVE/Processing over the terminal status,
        # making the benchmark harness poll forever until the stall threshold
        # deleted the agent (404/DELETED at 136s).
        if not self._cost_limit_reached and not self.is_paused and not self._is_finished:
            try:
                await workflow.execute_activity(
                    update_agent_status,
                    args=[
                        self.agent_id,
                        "ACTIVE",
                        0.5,
                        "Processing",
                        self.token_count,
                        self.context_size,
                        self.message_count,
                        self.tree_tokens_in,
                        self.tree_tokens_out,
                    ],
                    start_to_close_timeout=timedelta(seconds=15),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as e:
                workflow.logger.warning(f"Failed to broadcast tree tokens: {e}")

    async def _check_cost_limit(self) -> None:
        """Check if subtree cost exceeds limit. Only root calls this."""
        if self.parent_workflow_id is not None:
            return  # Only root checks limit

        if self.subtree_cost_cents >= self.price_limit_cents and not self._cost_limit_reached:
            workflow.logger.warning(f"💰 Cost limit exceeded: {self.subtree_cost_cents}c >= {self.price_limit_cents}c")
            self._cost_limit_reached = True
            self.is_paused = True

            # Update status to COST_LIMIT_REACHED
            try:
                await workflow.execute_activity(
                    update_agent_status,
                    args=[
                        self.agent_id,
                        "COST_LIMIT_REACHED",
                        0.0,
                        "Cost limit reached",
                        self.token_count,
                        self.context_size,
                        self.message_count,
                        self.tokens_in,
                        self.tokens_out,
                    ],
                    start_to_close_timeout=timedelta(seconds=15),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
            except Exception as e:
                workflow.logger.error(f"Failed to update status to COST_LIMIT_REACHED: {e}")

            # Send SMS notification for cost_limit (root + SMS-source only)
            if self.agent_source == "SMS":
                try:
                    await workflow.execute_activity(
                        notify_sms_event_activity,
                        args=[
                            self.user_id,
                            "cost_limit",
                            self.agent_id,
                            {
                                "tree_cost_cents": int(self.subtree_cost_cents),
                                "price_limit_cents": self.price_limit_cents,
                            },
                        ],
                        start_to_close_timeout=timedelta(seconds=30),
                        retry_policy=RetryPolicy(maximum_attempts=2),
                    )
                    workflow.logger.info("Sent cost_limit SMS notification")
                except Exception as e:
                    workflow.logger.warning(f"Failed to send cost_limit SMS notification: {e}")

            # Cascade to children (pull-based checks cover spawn race conditions)
            for child_wf_id in self._get_pending_child_workflow_ids():
                try:
                    handle = workflow.get_external_workflow_handle(child_wf_id)
                    await handle.signal("cost_limit_reached")
                except Exception as e:
                    workflow.logger.warning(f"Failed to cascade cost_limit_reached to child: {e}")

    async def _persist_tree_cost(self) -> None:
        """Persist subtree cost and own cost to DB."""
        from helpers.update_tokens import update_agent_tree_cost_activity

        try:
            await workflow.execute_activity(
                update_agent_tree_cost_activity,
                args=[self.agent_id, int(self.subtree_cost_cents), self.own_cost_cents],
                start_to_close_timeout=timedelta(seconds=10),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception as e:
            workflow.logger.warning(f"Failed to persist tree cost: {e}")

    async def _update_tree_state(
        self,
        progress: float = None,
        status: str = None,
        structured_output: Dict = None,
        failure_context: Dict = None,
    ) -> None:
        """
        Broadcast tree state update to the bus channel and persist to DB.

        Only broadcasts if this agent has a bus_id (i.e., is part of a sub-agent tree).
        Used for real-time sub-agent tree UI updates.
        """
        if not self.bus_id:
            return

        tools_list = list(self.tools_in_use)

        # Build broadcast payload
        # Compute default status from flags, but mark whether it was explicit
        if self._cost_limit_reached:
            default_status = "COST_LIMIT_REACHED"
        elif self.is_paused:
            default_status = "PAUSED"
        else:
            default_status = "ACTIVE"

        broadcast_payload = {
            "agentId": self.agent_id,
            "parentAgentId": self.parent_agent_id,
            "goal": self.goal,
            "status": status or default_status,
            "progress": progress if progress is not None else 0.0,
            "toolsInUse": tools_list,
            "messageCount": self.message_count,
            "costCents": int(self.subtree_cost_cents),
            # Track if status was explicitly set (for DB persistence decision)
            "_statusExplicit": status is not None,
        }

        # Always include output schema (available from spawn, cached in instance)
        if self.output_schema:
            broadcast_payload["outputSchema"] = self.output_schema

        # Include structured output (actual values) only for completed agents
        if structured_output:
            broadcast_payload["structuredOutput"] = structured_output

        # Include failure context for failed agents
        if failure_context:
            broadcast_payload["failureContext"] = failure_context

        # Execute activity that does both broadcast AND DB persist
        # (broadcast must be in activity to avoid workflow sandbox httpx issues)
        try:
            await workflow.execute_activity(
                update_agent_tree_state,
                args=[self.agent_id, tools_list, self.bus_id, broadcast_payload],
                start_to_close_timeout=timedelta(seconds=10),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception as e:
            workflow.logger.debug(f"Tree state update failed (non-fatal): {e}")

    async def _handle_incomplete(self, result: Dict, phase: str) -> Dict:
        """Handle non-completed phase result."""
        workflow.logger.info(f"{phase} ended: {result['status']}")

        if result["status"] == "paused":
            await workflow.wait_condition(lambda: not self.is_paused)
            # Temporal SDK requires args=[] for multi-param workflows
            workflow.continue_as_new(
                args=[
                    self.agent_id,
                    self.user_id,
                    self.goal,
                    self.model,
                    self.reasoning_max_tokens,
                    self.verifier,
                    result.get("context"),
                    self.parent_workflow_id,
                    self.parent_agent_id,
                    self.depth,
                    self.bus_id,
                    "execute",  # start_phase: skip PLAN since we already have context
                    self.max_iterations,
                    self.price_limit_cents,
                    self.context_gates or None,  # Preserve context gates across pause/resume
                    self.fast_mode_cache_enabled,  # Preserve Fast Mode cache flag
                ]
            )
            return result

        if result["status"] == "max_iterations":
            await self._mark_failed(
                context=result.get("context", []),
                reason="max_iterations",
                message="Max Steps Reached",
                verifier_progress=result.get("verifier_progress", 0.0),
                verifier_reasoning=result.get("verifier_reasoning", ""),
                partial_structured_response=result.get("partial_structured_response"),
            )
            return {"status": "failed", "reason": "max_iterations", "goal": self.goal}

        if result["status"] == "error":
            await self._mark_failed(
                context=result.get("context", []),
                reason="error",
                message=result.get("message", "Unknown error"),
                verifier_progress=result.get("verifier_progress", 0.0),
                verifier_reasoning=result.get("verifier_reasoning", ""),
                partial_structured_response=result.get("partial_structured_response"),
            )
            return {"status": "failed", "reason": "error", "goal": self.goal}

        # Fallback for unknown statuses
        return result

    def _extract_failure_context(
        self,
        context: List[Dict],
        verifier_progress: float = 0.0,
        verifier_reasoning: str = "",
        partial_structured_response: Optional[Dict] = None,
    ) -> Dict:
        """Extract comprehensive failure context for parent agent learning.

        Returns dict with:
        - trajectory: List of {tool_name, success, error_message}
        - last_reasoning: Last ASSISTANT message (what agent was thinking)
        - last_plan: Plan from set_plan if exists
        - progress_estimate: Verifier-determined progress (0-100%)
        - verifier_reasoning: Why verifier thinks agent isn't done
        - partial_structured_response: Any partial structured data extracted
        - steps_taken: Number of tool calls made
        """
        trajectory = []
        seen_tool_calls = set()
        last_reasoning = None
        last_plan = None

        for msg in context:
            role = msg.get("role")
            metadata = msg.get("metadata") or {}

            # Extract last assistant reasoning
            if role == "ASSISTANT":
                text = msg.get("text", "")
                if text and not metadata.get("reasoning"):  # Skip pure reasoning blocks
                    last_reasoning = text[:500]  # Truncate to 500 chars

            # Extract plan from set_plan tool
            if role == "TOOL":
                tool_name = metadata.get("toolName")
                tool_status = metadata.get("toolStatus")

                if tool_name == "set_plan" and tool_status == "FINISHED":
                    plan_data = metadata.get("data", {})
                    tasks = plan_data.get("tasks", [])
                    if tasks:
                        # Extract task goals as plan summary
                        plan_goals = []
                        for task in tasks[:5]:  # Limit to 5 tasks
                            if isinstance(task, dict):
                                plan_goals.append(task.get("goal", str(task))[:100])
                            else:
                                plan_goals.append(str(task)[:100])
                        last_plan = plan_goals

                # Build trajectory (skip internal tools).
                # Verifier feedback is now tagged toolName="attempt_completion" with
                # metadata.verifierMessage=True; skip those rows so the trajectory
                # only contains real tool calls, not scoring messages.
                if metadata.get("verifierMessage"):
                    continue
                if not tool_name or tool_name in {"completion_summary", "set_plan"}:
                    continue

                tool_call_id = metadata.get("toolCallId")
                if tool_call_id and tool_call_id in seen_tool_calls:
                    continue
                if tool_call_id:
                    seen_tool_calls.add(tool_call_id)

                if tool_status not in {"FINISHED", "ERROR"}:
                    continue

                is_error = metadata.get("error", False) or tool_status == "ERROR"
                error_message = msg.get("text", "") if is_error else None

                trajectory.append(
                    {
                        "tool_name": tool_name,
                        "success": not is_error,
                        "error_message": error_message[:200] if error_message else None,
                    }
                )

        # Use verifier progress if available, fallback to step-based estimate
        steps_taken = len(trajectory)
        if verifier_progress > 0:
            progress_estimate = f"{verifier_progress * 100:.0f}%"
        else:
            successful_steps = sum(1 for t in trajectory if t["success"])
            progress_estimate = (
                f"{successful_steps}/{steps_taken} steps succeeded" if steps_taken > 0 else "No steps completed"
            )

        return {
            "trajectory": trajectory,
            "last_reasoning": last_reasoning,
            "last_plan": last_plan,
            "progress_estimate": progress_estimate,
            "verifier_reasoning": verifier_reasoning,
            "partial_structured_response": partial_structured_response,
            "steps_taken": steps_taken,
        }

    async def _mark_failed(
        self,
        context: List[Dict],
        reason: str,
        message: str,
        verifier_progress: float = 0.0,
        verifier_reasoning: str = "",
        partial_structured_response: Optional[Dict] = None,
    ) -> None:
        """Mark task as failed and signal parent.

        Order:
        1. Post FINISHED message with error → FE shows failure in CompletionSummaryCard
        2. Update tree state (broadcast FAILED) with failure_context
        3. Update DB status to FAILED
        4. Signal parent with failure context for learning (if sub-agent)
        """
        workflow.logger.warning(f"❌ Marking task failed: {reason} - {message}")
        # Latch the terminal flag FIRST — see _mark_complete for the regression
        # this prevents (status=ACTIVE clobbering FAILED on late child cost signals).
        self._is_finished = True

        tool_call_id = str(workflow.uuid4())

        # Extract comprehensive failure context for parent learning
        failure_context = self._extract_failure_context(
            context,
            verifier_progress=verifier_progress,
            verifier_reasoning=verifier_reasoning,
            partial_structured_response=partial_structured_response,
        )

        # Calculate duration
        duration_seconds = 0
        if self.start_time:
            duration_seconds = int((workflow.now() - self.start_time).total_seconds())

        try:
            # 1. Post FINISHED message with error details
            await self._post_message(
                "",
                "TOOL",
                {
                    "toolCallId": tool_call_id,
                    "toolName": "completion_summary",
                    "toolStatus": "ERROR",
                    "isFinalSummary": True,
                    "title": f"❌ {message}",
                    "completionSummary": {
                        "summary": f"Agent failed: {message}",
                        "outputs": [],
                        "toolUsage": [],
                        "totalToolCalls": failure_context["steps_taken"],
                        "durationSeconds": duration_seconds,
                        "costDollars": 0,
                        "error": True,
                        "errorReason": reason,
                    },
                },
            )

            # 2. Broadcast FAILED status to tree with failure context
            await self._update_tree_state(progress=1.0, status="FAILED", failure_context=failure_context)

            # 3. Update DB status to FAILED
            await workflow.execute_activity(
                update_agent_status,
                args=[
                    self.agent_id,
                    "FAILED",
                    1.0,
                    message,
                    self.token_count,
                    self.context_size,
                    len(context),
                    self.tokens_in,
                    self.tokens_out,
                ],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

        except Exception as e:
            workflow.logger.error(f"Failed to mark failed: {e}")

        # 4. Signal parent with failure context for learning
        if self.parent_workflow_id:
            try:
                parent = workflow.get_external_workflow_handle(self.parent_workflow_id)
                await parent.signal(
                    "child_completed",
                    {
                        "child_agent_id": self.agent_id,
                        "result": {
                            "status": "failed",
                            "goal": self.goal,
                            "summary": f"Failed: {message}",
                            "error_reason": reason,
                            "failure_context": failure_context,  # Full context for parent learning
                            "structured_response": None,
                            "tool_counts": {},
                        },
                    },
                )
            except Exception as e:
                workflow.logger.warning(f"Failed to signal parent: {e}")

    def _format_outputs(self, structured_response: Optional[Dict]) -> List[Dict]:
        """Convert structured_response → CompletionSummaryCard outputs format."""
        if not structured_response or not self.output_schema:
            return []

        fields = self.output_schema.get("fields", [])
        outputs = []

        for field in fields:
            field_name = field.get("name")
            if field_name and field_name in structured_response:
                outputs.append(
                    {
                        "key": field_name,
                        "label": field.get("description", field_name.replace("_", " ").title()),
                        "value": structured_response[field_name],
                    }
                )

        return outputs

    async def _mark_complete(self, context: List[Dict], structured_response: Optional[Dict] = None) -> None:
        """Mark task complete and signal parent.

        Order:
        1. Post IN_PROGRESS message → FE shows loading state
        2. Generate completion summary (LLM call)
        3. Post FINISHED message with isFinalSummary → FE renders CompletionSummaryCard
        4. Update tree state (broadcast COMPLETED)
        5. Mark finished in DB
        6. Signal parent (if sub-agent)
        7. Save blueprint (fire-and-forget, no UI)
        """
        workflow.logger.info("✓ Marking task complete")
        # Latch the terminal flag FIRST so any late child_cost_update signal
        # (which calls _update_cost_and_signal_parent → broadcast) cannot
        # overwrite the COMPLETED status with ACTIVE/Processing.
        self._is_finished = True

        # Poll for output_schema if missing (handles race condition with async schema generation)
        max_schema_attempts = 5
        schema_attempt = 0
        while self.output_schema is None and schema_attempt < max_schema_attempts:
            schema_attempt += 1
            try:
                agent_config = await workflow.execute_activity(
                    fetch_agent_config,
                    args=[self.agent_id],
                    start_to_close_timeout=timedelta(seconds=10),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                self.output_schema = agent_config.get("response_schema")
                workflow.logger.info(
                    f"Fetched output_schema attempt {schema_attempt}/{max_schema_attempts}: {self.output_schema is not None}"
                )

                if self.output_schema is None and schema_attempt < max_schema_attempts:
                    workflow.logger.info("Schema not ready, waiting 1s...")
                    await asyncio.sleep(1)
            except Exception as e:
                workflow.logger.warning(f"Failed to fetch output_schema (attempt {schema_attempt}): {e}")
                if schema_attempt < max_schema_attempts:
                    await asyncio.sleep(1)

        tool_counts = {}
        summary = ""
        tool_call_id = str(workflow.uuid4())

        try:
            # Post IN_PROGRESS message for FE loading state
            await self._post_message(
                "",
                "TOOL",
                {
                    "toolCallId": tool_call_id,
                    "toolName": "completion_summary",
                    "toolStatus": "IN_PROGRESS",
                    "title": "Generating summary",
                },
            )

            # Generate summary - pass structured_response, output_schema, and child_tool_counts
            summary_result = await workflow.execute_activity(
                generate_completion_summary,
                args=[
                    context,
                    self.goal,
                    self.model,
                    structured_response,
                    self.output_schema,
                    self.child_tool_counts,
                    self._active_claude_token(),
                    self._active_claude_source(),
                    self._active_claude_pool_id(),
                    self.user_id,
                    self._active_gpt_token(),
                    self._active_gpt_account_id(),
                    self._active_gpt_source(),
                    self._active_gpt_pool_id(),
                    self.user_id,
                    self.agent_id,
                    self.fast_mode_cache_enabled,
                    0,  # Fast Mode step — one completion summary per agent
                ],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
            summary = summary_result.get("summary", "")
            tool_counts = summary_result.get("tool_counts", {})
            # Track completion summary LLM cost (doesn't go through run_agent)
            await self._track_llm_cost(
                summary_result.get("usage", {}).get("prompt_tokens", 0),
                summary_result.get("usage", {}).get("completion_tokens", 0),
                call_site="completion_summary",
            )
            self.token_count += summary_result.get("usage", {}).get("total_tokens", 0)

            # Build tool usage array for frontend
            tool_usage = [{"name": k, "count": v} for k, v in tool_counts.items()] if tool_counts else []
            total_tool_calls = sum(tool_counts.values()) if tool_counts else 0

            # Calculate duration
            duration_seconds = 0
            if self.start_time:
                duration_seconds = int((workflow.now() - self.start_time).total_seconds())

            # Calculate cost from token usage (approximate: $0.001/1k input, $0.003/1k output)
            cost_dollars = (self.tokens_in / 1000 * 0.001) + (self.tokens_out / 1000 * 0.003)

            # Post FINISHED message with completion summary (same toolCallId)
            await self._post_message(
                "",
                "TOOL",
                {
                    "toolCallId": tool_call_id,
                    "isFinalSummary": True,
                    "toolName": "completion_summary",
                    "toolStatus": "FINISHED",
                    "title": "✅ Task Complete",
                    "completionSummary": {
                        "summary": summary,
                        "outputs": self._format_outputs(structured_response),
                        "toolUsage": tool_usage,
                        "totalToolCalls": total_tool_calls,
                        "durationSeconds": duration_seconds,
                        "costDollars": round(cost_dollars, 4),
                    },
                },
            )

            # Broadcast COMPLETED status with structured output to tree
            # (output_schema is already cached from startup and included in all broadcasts)
            await self._update_tree_state(progress=1.0, status="COMPLETED", structured_output=structured_response)

            # Mark finished (includes structured_response for persistence)
            await workflow.execute_activity(
                mark_finished,
                args=[
                    self.agent_id,
                    context,
                    self.token_count,
                    self.context_size,
                    len(context),
                    self.tokens_in,
                    self.tokens_out,
                    summary if self.parent_workflow_id else "",
                    structured_response,
                ],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

            # Send completion SMS notification (root + SMS-source only)
            if not self.parent_workflow_id and summary and self.agent_source == "SMS":
                try:
                    await workflow.execute_activity(
                        notify_sms_event_activity,
                        args=[self.user_id, "completion", self.agent_id, {"summary": summary}],
                        start_to_close_timeout=timedelta(seconds=30),
                        retry_policy=RetryPolicy(maximum_attempts=2),
                    )
                    workflow.logger.info("Sent completion SMS notification", agent_id=self.agent_id)
                except Exception as sms_error:
                    # Log but don't fail completion if SMS fails
                    workflow.logger.warning(f"Failed to send completion SMS notification: {sms_error}")

        except Exception as e:
            workflow.logger.error(f"Failed to mark complete: {e}")
            raise

        # Signal parent with tool_counts for aggregation
        if self.parent_workflow_id:
            try:
                parent = workflow.get_external_workflow_handle(self.parent_workflow_id)
                await parent.signal(
                    "child_completed",
                    {
                        "child_agent_id": self.agent_id,
                        "result": {
                            "status": "completed",
                            "goal": self.goal,
                            "summary": summary,
                            "structured_response": structured_response,
                            "tool_counts": tool_counts,
                        },
                    },
                )
            except Exception as e:
                workflow.logger.warning(f"Failed to signal parent: {e}")

        # Save blueprint (fire-and-forget, no tool messages - just logs)
        # This is the last step so it doesn't block completion UX
        if False:
            try:
                await workflow.execute_activity(
                    save_blueprint_activity,
                    args=[self.user_id, context],
                    start_to_close_timeout=timedelta(seconds=120),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                workflow.logger.info("Blueprint saved successfully")
            except Exception as e:
                workflow.logger.warning(f"Blueprint save failed (non-fatal): {e}")

    @workflow.query
    def get_status(self) -> Dict:
        """Query current status."""
        return {"agent_id": self.agent_id, "goal": self.goal, "tokens": self.token_count}

    @workflow.query
    def is_paused_query(self) -> bool:
        """Query if workflow is paused."""
        return self.is_paused

    @workflow.query
    def is_cost_limit_reached_query(self) -> bool:
        """Query if cost limit has been reached."""
        return self._cost_limit_reached

    @workflow.query
    def parent_state_query(self) -> Dict:
        """Combined query for children to check parent's pause/cost-limit state."""
        return {"is_paused": self.is_paused, "is_cost_limit_reached": self._cost_limit_reached}
