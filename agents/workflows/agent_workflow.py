"""Main agent workflow for executing autonomous tasks.

Uses run_agent for the core loop. Workflow handles:
- Signals (pause, resume, user response, sub-agent progress)
- Sub-agent orchestration
- continue_as_new for context overflow
"""

from datetime import timedelta, datetime
from typing import Dict, List, Optional, Any, Set, Tuple
from datetime import timezone
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import TimeoutError as TemporalTimeoutError
import asyncio
import json as _json
import structlog

# Import pass-through for workflow context:
# - Our own modules are safe (config.py has no import-time side effects)
# - Third-party libraries (httpx, instructor) may have import-time issues
# - This is a safety net, not strictly required for our code
with workflow.unsafe.imports_passed_through():
    from helpers import (
        poll_new_messages,
        post_agent_message,
        update_agent_status,
        generate_completion_summary,
        get_model_context_window,
        mark_finished,
        get_user_context,
        get_user_system_name,
        get_user_custom_system_prompt,
        check_user_usage,
        fetch_agent_config,
        fetch_model_pricing,
    )
    from helpers.messages import broadcast_to_bus, update_agent_tree_state
    from helpers.prompts import build_system_prompt, build_verifier_prompt
    from helpers.handle_tool_event import handle_tool_event
    from helpers.llm import fetch_claude_max_token_activity
    from helpers.save_tool_usage import save_tool_usage
    from helpers.model_pricing import get_anthropic_pricing
    from helpers.tool_schemas import PLAN_PHASE_TOOLS, EXECUTE_PHASE_TOOLS
    from tools.base import ToolEvent, AssistantEvent, EventType, MessageStatus
    # Tool executors (map tool name → workflow helper)
    from tools.deep_research import deep_research
    from tools.wait_seconds import wait_seconds
    from tools.send_message_to_user import send_message_to_user
    from tools.enable_write_permissions import enable_write_permissions
    from tools.request_user_approval import request_user_approval_direct, UserRejectedError
    from tools.knowledge_base import save_blueprint_activity
    from tools.web_search import web_search
    from tools.web_fetch import web_fetch
    from tools.spawn_sub_agents import spawn_sub_agent
    from helpers.error_utils import extract_error_message
    from tools.spawn_browser_agent_v3 import spawn_browser_agent  # V3: browser-use + Rose API
    from tools.spawn_claude_code_agent import spawn_claude_code_agent  # Claude Code in E2B sandbox
    from tools.search_user_network import search_user_network_for_people
    from tools.find_all import find_all
    from tools.enrich import enrich
    from tools.monitor import monitor
    from tools.check_monitor_events import check_monitor_events
    from tools.message_person import message_person
    from tools.set_plan import set_plan
    from tools.attempt_completion import attempt_completion
    from tools.x402_bazaar import search_x402_bazaar, pay_for_x402_bazaar_service
    from helpers.sms_activities import get_agent_source, send_direct_sms_activity, notify_sms_event_activity
    from tools.request_user_signup import request_user_signup
    from tools.call_phone_number import call_phone_number, get_manager as get_call_phone_manager
    from tools.people_search import people_search
    from loop.run_agent import run_agent
    from loop.dag_executor import extract_plan_from_context, TaskDAG, execute_dag
    from helpers.format_tool_display import format_tool_display
    from activities.shared_memory import get_shared_memory, append_shared_memory

logger = structlog.get_logger()

# =============================================================================
# TOOL CONFIGURATION
# =============================================================================

# Tool name → executor function mapping
TOOL_EXECUTORS = {
    "spawn_browser_agent": spawn_browser_agent,
    "spawn_claude_code_agent": spawn_claude_code_agent,
    "deep_research": deep_research,
    "wait_seconds": wait_seconds,
    "send_message_to_user": send_message_to_user,
    "send_message_to_user_execute_phase": send_message_to_user,  # Same handler, forces is_question=False
    "enable_write_permissions": enable_write_permissions,
    "web_search": web_search,
    "web_fetch": web_fetch,
    "spawn_sub_agent": spawn_sub_agent,
    "search_user_network_for_people": search_user_network_for_people,
    "find_all": find_all,
    "enrich": enrich,
    "monitor": monitor,
    "check_monitor_events": check_monitor_events,
    "message_person": message_person,
    "set_plan": set_plan,
    "attempt_completion": attempt_completion,
    "search_x402_bazaar": search_x402_bazaar,
    "pay_for_x402_bazaar_service": pay_for_x402_bazaar_service,
    "request_user_signup": request_user_signup,
    "call_phone_number": call_phone_number,
    "people_search": people_search,
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
        self.model: str = "anthropic/claude-sonnet-4.5"
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
        self.child_workflow_ids: Dict[str, str] = {}  # child_agent_id -> child_temporal_workflow_id

        # Tree token tracking (hierarchical relay: child → parent → root)
        # Own tokens are in self.tokens_in/out (used for cost calc)
        # Children's tokens aggregated here for tree totals
        self.children_tokens_in: Dict[str, int] = {}  # child_agent_id -> subtree_tokens_in
        self.children_tokens_out: Dict[str, int] = {}  # child_agent_id -> subtree_tokens_out
        self.tree_tokens_in: int = 0  # own + sum(children) - for display
        self.tree_tokens_out: int = 0  # own + sum(children) - for display

        # Claude token (passed to Rose endpoint for direct Anthropic calls)
        self.claude_max_token: Optional[str] = None
        self.claude_max_token_fetched_at: Optional[datetime] = None  # For 5-min TTL refresh

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

        # Shared memory state (for cross-agent memory sharing within a run)
        self.shared_memory_hash: Optional[str] = None  # Current hash for cache invalidation
        self.shared_memory_content: List[Dict] = []  # Current shared memory entries
        self.appended_message_ids: Set[str] = set()  # Track message IDs we've already appended
    
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
            try:
                parent = workflow.get_external_workflow_handle(self.parent_workflow_id)
                state = await parent.query("parent_state_query")
                if state.get("is_cost_limit_reached") or state.get("is_paused"):
                    workflow.logger.warning("Cannot resume — parent is still paused/cost-limited")
                    return
            except Exception as e:
                workflow.logger.warning(f"Parent state check failed on resume, allowing: {e}")
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
        self.child_last_tokens[child_agent_id] = {"tokens_in": tokens_in, "tokens_out": tokens_out, "token_count": token_count}
        
        # Post progress update
        child_tool_id = self.child_tool_ids.get(child_agent_id)
        if child_tool_id:
            await self._post_message(
                f"Progress: {int(progress * 100)}%",
                "TOOL",
                metadata={
                    "toolCallId": child_tool_id,
                    "toolName": "spawn_sub_agent",
                    "toolStatus": "IN_PROGRESS",
                    "title": goal[:30] if goal else "Sub-agent",
                    "subAgentId": child_agent_id,
                    "progress": progress
                }
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
                        "toolName": "spawn_sub_agent",
                        "toolStatus": "ERROR",
                        "title": f"❌ Sub-agent failed: {goal_text[:30]}",
                        "subAgentId": child_agent_id,
                        "error": True,
                    }
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
                        "toolName": "spawn_sub_agent",
                        "toolStatus": "FINISHED",
                        "title": f"Sub-agent completed: {goal_text[:30]}",
                        "subAgentId": child_agent_id,
                        "progress": 1.0,
                        "structuredResponse": structured_response
                    }
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
            try:
                parent = workflow.get_external_workflow_handle(self.parent_workflow_id)
                state = await parent.query("parent_state_query")
                if state.get("is_cost_limit_reached"):
                    workflow.logger.warning("Cannot accept price_limit_increased — parent still cost-limited")
                    return
            except Exception as e:
                workflow.logger.warning(f"Parent state check failed on price_limit_increased, allowing: {e}")

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
    async def run(
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
    ) -> Dict:
        """Execute agent task: optionally PLAN phase → EXECUTE phase."""
        self.agent_id = agent_id
        self.user_id = user_id
        self.goal = goal
        self.model = model
        self.current_phase = "PLAN"  # Track current phase for condensor
        self.reasoning_max_tokens = reasoning_max_tokens
        self.verifier = verifier
        self.parent_workflow_id = parent_workflow_id
        self.parent_agent_id = parent_agent_id
        self.depth = depth
        self.bus_id = bus_id
        self.max_iterations = max_iterations
        self.price_limit_cents = price_limit_cents  # Use passed value instead of hardcoded default
        self.start_time = workflow.now()  # Track start time for duration calculation

        workflow.logger.info(f"Agent starting: agent={agent_id}, goal='{goal[:50]}', depth={depth}")
        
        # Fetch model context window
        if self.max_context_tokens is None:
            try:
                self.max_context_tokens = await workflow.execute_activity(
                    get_model_context_window,
                    args=[model],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=3)
                )
            except Exception:
                self.max_context_tokens = 100_000
        
        # Update status
        try:
            await workflow.execute_activity(
                update_agent_status,
                args=[agent_id, "ACTIVE", 0.0, "Agent started", 0, 0, 0, 0, 0],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=3)
            )
        except Exception:
            pass

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

        # Fetch user context once (for both phases)
        user_context_section = ""
        try:
            user_context_section = await workflow.execute_activity(
                get_user_context,
                args=[user_id],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3)
            )
        except Exception as e:
            workflow.logger.warning(f"Failed to fetch user context: {e}")
        self.user_context_section = user_context_section  # Store for condensor

        # Fetch user's custom system name (for approval messages and SMS)
        try:
            self.system_name = await workflow.execute_activity(
                get_user_system_name,
                args=[user_id],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=2)
            )
            workflow.logger.info(f"Using system name: {self.system_name}")
        except Exception as e:
            workflow.logger.warning(f"Failed to fetch system name, using default 'Rose': {e}")

        # Fetch user's custom system prompt (for personality injection)
        try:
            self.custom_system_prompt = await workflow.execute_activity(
                get_user_custom_system_prompt,
                args=[user_id],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=2)
            )
            if self.custom_system_prompt:
                workflow.logger.info(f"Custom system prompt loaded: {len(self.custom_system_prompt)} chars")
        except Exception as e:
            workflow.logger.warning(f"Failed to fetch custom system prompt: {e}")

        # Fetch Claude token for Anthropic calls via Rose endpoint
        await self._refresh_claude_token(user_id)

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
                    }
                )
                workflow.logger.info("Injected custom system prompt as hidden USER message")
            except Exception as e:
                workflow.logger.warning(f"Failed to inject custom system prompt: {e}")

        # Fetch response schema and write_lock_enabled from agent config
        response_schema = None
        try:
            agent_config = await workflow.execute_activity(
                fetch_agent_config,
                args=[agent_id],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3)
            )
            response_schema = agent_config.get("response_schema")
            self.output_schema = response_schema  # Single source of truth for output schema
            self.write_lock_enabled = agent_config.get("write_lock_enabled", True)  # Default to True (locked)
            workflow.logger.info(f"Fetched output_schema: {response_schema is not None}, write_lock_enabled: {self.write_lock_enabled}")
        except Exception as e:
            workflow.logger.warning(f"Failed to fetch agent config for response_schema: {e}")

        # Fetch model pricing for cost calculation
        try:
            pricing = await workflow.execute_activity(
                fetch_model_pricing,
                args=[model],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3)
            )
            self.input_cents_per_1k = pricing["input_cents_per_1k"]
            self.output_cents_per_1k = pricing["output_cents_per_1k"]
            workflow.logger.info(
                f"💰 Fetched model pricing: input={self.input_cents_per_1k}c/1k, output={self.output_cents_per_1k}c/1k"
            )
        except Exception as e:
            workflow.logger.error(f"Failed to fetch model pricing: {e}")
            # Cost tracking will be disabled if pricing unavailable

        # Broadcast initial tree state with schema (only for sub-agents with bus_id)
        if self.bus_id:
            await self._update_tree_state(progress=0.0, status="ACTIVE")

        # If sub-agent, check parent's pause/cost-limit state before starting work
        # (covers race condition where signal arrived after spawn but before we're ready)
        if self.parent_workflow_id:
            try:
                parent_handle = workflow.get_external_workflow_handle(self.parent_workflow_id)
                state = await parent_handle.query("parent_state_query")
                if state.get("is_paused"):
                    workflow.logger.info("Parent is paused - inheriting pause state")
                    self.is_paused = True
                    self._paused_by_parent = True
                if state.get("is_cost_limit_reached"):
                    workflow.logger.info("Parent hit cost limit - inheriting cost limit state")
                    self._cost_limit_reached = True
                    self.is_paused = True
                    self._paused_by_parent = True
            except Exception as e:
                workflow.logger.warning(f"Failed to query parent state: {e}")

        # =====================================================================
        # Tool lists from centralized source of truth
        # =====================================================================
        plan_tools = PLAN_PHASE_TOOLS
        execute_tools = EXECUTE_PHASE_TOOLS

        # Determine whether to skip PLAN phase
        skip_plan = (start_phase == "execute")

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
                verifier_prompt_generator=self._make_verifier_prompt_generator("PLAN", self.verifier.get("llmJudgePrompt", "")),
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
                claude_token=self.claude_max_token,
                get_claude_token=lambda: self.claude_max_token,
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

        # Try DAG execution if a plan exists
        plan_data = extract_plan_from_context(execute_context)
        if plan_data:
            workflow.logger.info("[DAG] Found plan, attempting DAG execution")
            dag = TaskDAG(plan_data)

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
            )

            # DAG completed or failed - both hand off to run_agent
            # run_agent polls from DB (DAG already posted results there)
            if dag_result["status"] == "completed":
                workflow.logger.info("[DAG] Tasks completed, handing off to LLM for attempt_completion")
            else:
                workflow.logger.info("[DAG] Execution needs LLM recovery, falling through to run_agent")
        else:
            workflow.logger.info("[DAG] No plan found, using LLM-driven execution")

        # LLM-driven execution (after DAG, or if no plan)
        # Note: Don't pass initial_context - run_agent polls from DB each step
        # DAG already posted all results to DB via post_message callback

        # Refresh Claude token before execute phase (may have expired during PLAN)
        await self._refresh_claude_token(user_id)

        execute_result = await run_agent(
            agent_id=agent_id,
            user_id=user_id,
            system_prompt=self.build_system_prompt,
            verifier_prompt_generator=self._make_verifier_prompt_generator("EXECUTE", self.verifier.get("llmJudgePrompt", "")),
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
            skip_blueprint_query=not skip_plan,  # Only skip if we ran PLAN phase
            response_schema=response_schema,
            get_response_schema=self._make_response_schema_getter(),
            claude_token=self.claude_max_token,
            get_claude_token=lambda: self.claude_max_token,
            **({"max_iterations": self.max_iterations} if self.max_iterations else {}),
        )

        await self._track_tokens_and_cost(execute_result)

        if execute_result["status"] == "completed":
            await self._mark_complete(
                execute_result.get("context", []),
                execute_result.get("structured_response")
            )
            return {"status": "completed", "goal": goal}
        
        return await self._handle_incomplete(execute_result, "EXECUTE")
    
    # =========================================================================
    # CALLBACKS FOR run_agent
    # =========================================================================

    def _make_verifier_prompt_generator(self, phase: str, llm_judge_prompt: str):
        """Create a generator function that builds the verifier prompt at verification time.

        This allows schema to be polled/fetched when actually needed, avoiding race conditions
        where the schema isn't ready at phase start.
        """
        async def generate() -> str:
            # Poll for schema if not available (handles async schema generation race condition)
            if self.output_schema is None:
                max_attempts = 5
                for attempt in range(max_attempts):
                    try:
                        agent_config = await workflow.execute_activity(
                            fetch_agent_config,
                            args=[self.agent_id],
                            start_to_close_timeout=timedelta(seconds=30),
                            retry_policy=RetryPolicy(maximum_attempts=2)
                        )
                        self.output_schema = agent_config.get("response_schema")
                        if self.output_schema:
                            workflow.logger.info(f"Fetched output_schema on attempt {attempt + 1}")
                            break
                        elif attempt < max_attempts - 1:
                            await asyncio.sleep(1)  # Wait before retry
                    except Exception as e:
                        workflow.logger.warning(f"Failed to fetch schema (attempt {attempt + 1}): {e}")

            return build_verifier_prompt(phase, llm_judge_prompt, response_schema=self.output_schema)

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
        """Build system prompt with fresh shared memory.

        Called by run_agent before each LLM call to ensure agents see
        the latest shared memory updates.
        """
        # Fetch latest shared memory from API
        shared_memory_section = await self._fetch_shared_memory()

        # Build prompt using helper
        return build_system_prompt(
            phase=self.current_phase,
            enabled_tools=self._current_tools,
            disabled_tools=self._disabled_tools,
            user_context_section=self.user_context_section,
            response_schema=self.output_schema,
            shared_memory_section=shared_memory_section,
        )

    async def _wait_for_messages(self) -> bool:
        """Wait for new messages."""
        try:
            await workflow.wait_condition(
                lambda: self._has_new_messages or not self.is_paused,
                timeout=timedelta(seconds=30)
            )
            result = self._has_new_messages
            self._has_new_messages = False
            return result
        except (asyncio.TimeoutError, TemporalTimeoutError):
            return False
    
    async def _handle_context_overflow(self, compressed_context: List[Dict]) -> None:
        """Handle context overflow via continue_as_new."""
        workflow.logger.info("Context overflow → continue_as_new")
        # Temporal SDK requires args=[] for multi-param workflows
        workflow.continue_as_new(args=[
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
            "execute",  # start_phase: skip PLAN since we already have context
            self.max_iterations,
            self.price_limit_cents,
        ])
    
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
                retry_policy=RetryPolicy(maximum_attempts=2)
            )
            if result and not result.get("has_credits", True):
                workflow.logger.warning("💰 Credits depleted - pausing agent")
                self.is_paused = True
                self._has_credits = False
            else:
                self._has_credits = True
        except Exception as e:
            workflow.logger.warning(f"Credit check failed (continuing): {e}")
    
    # Claude token TTL: 5 minutes
    CLAUDE_TOKEN_TTL = timedelta(minutes=5)

    async def _refresh_claude_token(self, user_id: str) -> None:
        """Fetch or refresh the Claude OAuth token if missing or expired (5-min TTL)."""
        now = workflow.now()
        if self.claude_max_token_fetched_at:
            age = now - self.claude_max_token_fetched_at
            if age < self.CLAUDE_TOKEN_TTL:
                return  # Still fresh
            workflow.logger.info(f"🔑 Claude token expired ({age.total_seconds():.0f}s old), refreshing")

        try:
            self.claude_max_token = await workflow.execute_activity(
                fetch_claude_max_token_activity,
                args=[user_id],
                start_to_close_timeout=timedelta(seconds=20),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            self.claude_max_token_fetched_at = now
            if self.claude_max_token:
                workflow.logger.info("🔑 Claude token available for planner")
        except Exception as e:
            workflow.logger.warning(f"Failed to fetch Claude token: {e}")

    async def _post_message(self, text: str, role: str = "ASSISTANT", metadata: Optional[Dict] = None) -> None:
        """Post message to database."""
        try:
            await workflow.execute_activity(
                post_agent_message,
                args=[self.agent_id, text, role, metadata],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3)
            )
            # Track message count and broadcast tree state
            self.message_count += 1
            await self._update_tree_state()
        except Exception as e:
            workflow.logger.error(f"Failed to post message: {e}")
    
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
                retry_policy=RetryPolicy(maximum_attempts=3)
            )

            # Update workflow context for tools that check it
            if messages:
                for msg in messages:
                    if msg not in self.context:
                        self.context.append(msg)
                self.context.sort(key=lambda x: x.get("timestamp", ""))

                # Append new USER messages to shared memory (with deduplication)
                await self._append_user_messages_to_shared_memory(messages)

            return messages
        except Exception:
            return []

    async def _append_user_messages_to_shared_memory(self, messages: List[Dict]) -> None:
        """Append new USER messages to shared memory for cross-agent visibility."""
        if not self.bus_id:
            return  # No bus_id means no shared memory scope

        for msg in messages:
            if msg.get("role") != "USER":
                continue

            msg_id = msg.get("id")
            if not msg_id or msg_id in self.appended_message_ids:
                continue  # Skip if no ID or already appended

            # Extract file pointers if present
            files = []
            file_pointer = msg.get("file_pointer") or msg.get("filePointer")
            if file_pointer:
                files.append({
                    "original_filename": file_pointer.get("original_filename", ""),
                    "mime_type": file_pointer.get("mime_type", ""),
                })

            try:
                result = await workflow.execute_activity(
                    append_shared_memory,
                    args=[
                        self.bus_id,
                        "USER_MESSAGE",
                        msg.get("text", ""),
                        msg_id,
                        files if files else None,
                    ],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=3)
                )

                if result:
                    self.shared_memory_hash = result.get("hash")
                    self.appended_message_ids.add(msg_id)
                    workflow.logger.debug(f"📝 Appended user message {msg_id[:8]} to shared memory")
            except Exception as e:
                workflow.logger.warning(f"Failed to append user message to shared memory: {e}")

    async def _fetch_shared_memory(self) -> str:
        """Fetch shared memory and format it for inclusion in system prompt."""
        if not self.bus_id:
            return ""  # No bus_id means no shared memory scope

        try:
            result = await workflow.execute_activity(
                get_shared_memory,
                args=[self.bus_id, self.shared_memory_hash],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3)
            )

            if result is None:
                # Hash matched, content unchanged - use cached
                pass
            elif result:
                # New content received
                self.shared_memory_content = result.get("content", [])
                self.shared_memory_hash = result.get("hash")

            # Format shared memory for system prompt
            if not self.shared_memory_content:
                return ""

            lines = []
            for entry in self.shared_memory_content:
                timestamp = entry.get("timestamp", "")[:19]  # Truncate to datetime
                entry_type = entry.get("type", "")
                content = entry.get("content", "")
                files = entry.get("files", [])

                line = f"[{timestamp}] {entry_type}: {content}"
                if files:
                    file_names = ", ".join(f.get("original_filename", "") for f in files)
                    line += f" (files: {file_names})"
                lines.append(line)

            return "\n".join(lines)
        except Exception as e:
            workflow.logger.warning(f"Failed to fetch shared memory: {e}")
            return ""
    
    async def _execute_tool(self, tool_name: str, tool_args: Dict, tool_call_id: str) -> Dict:
        """Execute a tool - supports both new and legacy signatures during migration."""
        if tool_name not in TOOL_EXECUTORS:
            return {"error": True, "message": f"Unknown tool: {tool_name}"}

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
                    question = manager.get_approval_question({"tool": tool_name, "system_name": self.system_name, **tool_args})
                    # Let UserRejectedError bubble up to outer Exception handler
                    # which posts ERROR for tool_call_id_A
                    await request_user_approval_direct(self, question=question, metadata={"toolApproval": True})

            executor = TOOL_EXECUTORS[tool_name]

            # Tools migrated to new signature: (execute_activity, tool_call, tool_call_id, agent_id, user_id)
            # These return results and call handle_tool_event internally
            NEW_SIGNATURE_TOOLS = {
                "web_search", "web_fetch", "send_email", "send_sms",
                "search_user_network_for_people",
                "monitor", "check_monitor_events",
                "deep_research", "attempt_completion",
                "search_x402_bazaar", "pay_for_x402_bazaar_service",
                "call_phone_number",
                "people_search",
            }

            if tool_name in NEW_SIGNATURE_TOOLS:
                # Track start time for condensor timing (includes tool + condensor)
                tool_start_time = workflow.now()
                tool_call_dict = {"tool": tool_name, **tool_args}

                result = await executor(
                    execute_activity=workflow.execute_activity,
                    tool_call=tool_call_dict,
                    tool_call_id=tool_call_id,
                    agent_id=self.agent_id,
                    user_id=self.user_id,
                )
                # Track usage if returned by tool (standardized format)
                original_usage = {}
                if isinstance(result, dict) and "usage" in result:
                    original_usage = result.get("usage", {})
                    await self._track_usage(original_usage, tool_name=tool_name)
                    # Extract actual result for caller
                    result = result.get("result", result)

                # Condensor: check tool's condensor_enabled flag and condense result
                manager = self._get_tool_manager(tool_name)
                if manager and getattr(manager, 'condensor_enabled', False):
                    result = await self._condense_tool_result(
                        tool_name=tool_name,
                        tool_call_id=tool_call_id,
                        tool_call=tool_call_dict,
                        original_usage=original_usage,
                        start_time=tool_start_time,
                        result=result,
                    )

                # Post downloaded files as ASSISTANT messages (like browser/code agents do)
                # This makes FilePointers visible in the frontend and agent context
                downloaded_files = (result.get("original", {}) or {}).get("downloaded_files", []) if isinstance(result, dict) else []
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
                last_status = await executor(self, {"tool": tool_name, **tool_args}, tool_call_id)
                failed = last_status == MessageStatus.ERROR
                return {"success": not failed, "message": f"{tool_name} completed"}

        except asyncio.CancelledError:
            # User paused the agent - don't show as error
            workflow.logger.info(f"Tool {tool_name} cancelled (user paused)")
            return {"success": False, "message": "User paused the agent during browser execution"}

        except Exception as e:
            error_msg = extract_error_message(e)
            workflow.logger.error(f"Tool {tool_name} failed: {error_msg}")

            # For spawn_sub_agent, include sub-agent context so frontend renders
            # as a proper sub-agent failure (SubAgentTree) instead of a raw chip
            error_metadata = None
            if tool_name == "spawn_sub_agent":
                meta = {}
                # Find the child agent spawned by this tool_call_id
                for child_id, tid in getattr(self, 'child_tool_ids', {}).items():
                    if tid == tool_call_id:
                        meta["subAgentIds"] = [child_id]
                        break
                bus_id = getattr(self, 'bus_id', None)
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
                tool_name
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

    def _get_tool_manager(self, tool_name: str):
        """Get the ToolManager instance for a tool to check flags like condensor_enabled."""
        TOOL_MANAGERS = {
            "web_search": lambda: __import__('tools.web_search', fromlist=['get_manager']).get_manager(),
            "web_fetch": lambda: __import__('tools.web_fetch', fromlist=['get_manager']).get_manager(),
        }
        if tool_name in TOOL_MANAGERS:
            return TOOL_MANAGERS[tool_name]()
        return None

    async def _condense_tool_result(
        self,
        tool_name: str,
        tool_call_id: str,
        tool_call: Dict[str, Any],
        original_usage: Dict[str, Any],
        start_time,
        result: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Condense tool result using LLM. Called from _execute_tool after tool returns."""
        from helpers.condensor import condense_tool_result_activity
        from helpers.prompts import build_system_prompt
        from helpers.model_pricing import fetch_model_pricing
        from tools.base import format_tool_message
        import json

        # Post IN_PROGRESS via self._handle_tool_event (sends to FE)
        await self._handle_tool_event(
            ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Condensing {tool_name.replace('_', ' ').title()}",
                message="Extracting relevant information",
                status=MessageStatus.IN_PROGRESS
            ),
            tool_call_id,
            tool_name
        )

        # Build system prompt for condensor context
        system_prompt = build_system_prompt(
            phase=self.current_phase,
            enabled_tools=[],
            user_context_section=getattr(self, 'user_context_section', "") or "",
        )

        # Format result for condensing
        result_str = json.dumps(result, indent=2, default=str)

        # Call condensor activity
        condensor_result = await workflow.execute_activity(
            condense_tool_result_activity,
            args=[result_str, system_prompt, self.model, tool_name, 500],
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(
                maximum_attempts=2,
                backoff_coefficient=2.0,
                initial_interval=timedelta(seconds=1),
            )
        )

        condensed_message = condensor_result["condensed"]
        condensor_usage = condensor_result["usage"]

        # Calculate elapsed time (from tool start to condensor finish)
        elapsed_time = (workflow.now() - start_time).total_seconds()

        # Calculate combined cost
        # 1. Original tool service cost (e.g., Parallel AI Search)
        tool_service_cost = sum(
            s.get("cost_cents", 0)
            for s in original_usage.get("service", [])
        )

        # 2. Original tool LLM cost (if tool uses LLM internally)
        tool_llm_cost = 0
        for llm_item in original_usage.get("llm", []):
            tokens_in = llm_item.get("tokens_in", 0)
            tokens_out = llm_item.get("tokens_out", 0)
            model = llm_item.get("model", "")
            if tokens_in or tokens_out:
                try:
                    pricing = await workflow.execute_activity(
                        fetch_model_pricing,
                        args=[model],
                        start_to_close_timeout=timedelta(seconds=10),
                        retry_policy=RetryPolicy(maximum_attempts=2),
                    )
                    tool_llm_cost += (
                        (tokens_in * pricing["input_cents_per_1k"] / 1000) +
                        (tokens_out * pricing["output_cents_per_1k"] / 1000)
                    )
                except Exception:
                    pass

        tool_cost_cents = tool_service_cost + tool_llm_cost

        # 3. Condensor LLM cost (calculate from tokens using model pricing)
        condensor_cost_cents = 0
        if condensor_usage.get("tokens_in") or condensor_usage.get("tokens_out"):
            try:
                pricing = await workflow.execute_activity(
                    fetch_model_pricing,
                    args=[condensor_usage["model"]],
                    start_to_close_timeout=timedelta(seconds=10),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                condensor_cost_cents = (
                    (condensor_usage["tokens_in"] * pricing["input_cents_per_1k"] / 1000) +
                    (condensor_usage["tokens_out"] * pricing["output_cents_per_1k"] / 1000)
                )
            except Exception:
                # If pricing fetch fails, continue without cost
                pass

            # Track condensor LLM usage
            await self._track_usage({
                "llm": [{
                    "tokens_in": condensor_usage["tokens_in"],
                    "tokens_out": condensor_usage["tokens_out"],
                    "model": condensor_usage["model"],
                    "provider": "Condensor",
                }],
                "service": [],
            }, tool_name=f"{tool_name}_condensor")

        total_cost_cents = tool_cost_cents + condensor_cost_cents

        # Preserve sources/images/links/downloaded_files from original result (not subject to condensation)
        sources = result.get("sources", [])
        images = result.get("images", [])
        links = result.get("links", [])
        downloaded_files = result.get("downloaded_files", [])

        # Format message using standard tool format (pass sources through for display)
        condensed_result = {"content": condensed_message}
        if sources:
            condensed_result["sources"] = sources
        if images:
            condensed_result["images"] = images
        if links:
            condensed_result["links"] = links
        if downloaded_files:
            condensed_result["downloaded_files"] = downloaded_files

        formatted_message = format_tool_message(
            params=tool_call,
            result=condensed_result,
            time_elapsed=elapsed_time,
            cost_cents=total_cost_cents
        )

        # Post FINISHED with formatted condensed result (sends to FE)
        await self._handle_tool_event(
            ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"{tool_name.replace('_', ' ').title()} completed",
                message=formatted_message,
                status=MessageStatus.FINISHED
            ),
            tool_call_id,
            tool_name
        )

        # Return condensed result for context
        # "message" key is what run_agent.py uses to build context text
        # Append sources/images/links so they appear in the LLM's context
        context_parts = [condensed_message]
        if sources:
            context_parts.append("\n**Sources:** " + ", ".join(sources))
        if images:
            context_parts.append("\n**Images:** " + ", ".join(images))
        if links:
            context_parts.append("\n**Links:** " + ", ".join(links))
        if downloaded_files:
            file_list = ", ".join(f["original_filename"] for f in downloaded_files)
            context_parts.append(f"\n**Downloaded Files:** {file_list}")
        context_message = "\n".join(context_parts)

        return {"message": context_message, "condensed": True, "original": result}

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

    async def _track_llm_cost(self, tokens_in: int, tokens_out: int) -> None:
        """Track cost for LLM calls outside run_agent (e.g., completion summary).

        Use this for LLM calls that don't go through run_agent and thus don't trigger _on_tokens.
        """
        # Update workflow token state
        self.tokens_in += tokens_in
        self.tokens_out += tokens_out

        # Calculate cost from tokens using stored pricing (fractional cents)
        if self.input_cents_per_1k > 0 or self.output_cents_per_1k > 0:
            cost_cents = (
                (tokens_in * self.input_cents_per_1k / 1000) +
                (tokens_out * self.output_cents_per_1k / 1000)
            )
            if cost_cents > 0:
                self.own_cost_cents += cost_cents
                workflow.logger.info(
                    f"💰 LLM cost (non-run_agent): +{cost_cents:.2f}c (total: {self.own_cost_cents:.1f}c, "
                    f"in={tokens_in}, out={tokens_out})"
                )

                # Recalculate subtree cost and check limit
                await self._update_cost_and_signal_parent()

    async def _track_usage(self, usage: Optional[Dict] = None, tool_name: Optional[str] = None) -> None:
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

            # Get pricing for this model (fetch if not cached)
            pricing = await self._get_model_pricing(model)
            if not pricing:
                workflow.logger.warning(f"⚠️ No pricing for model {model}, skipping cost for {tokens_in}/{tokens_out} tokens")
                continue

            cost_cents = (
                (tokens_in * pricing["input_cents_per_1k"] / 1000) +
                (tokens_out * pricing["output_cents_per_1k"] / 1000)
            )
            if cost_cents > 0:
                total_cost_cents += cost_cents
                workflow.logger.info(
                    f"💰 LLM cost: +{cost_cents:.2f}c ({provider}, in={tokens_in}, out={tokens_out})"
                )
                usage_items_for_db.append({
                    "type": "llm",
                    "cost_cents": cost_cents,
                    "provider": provider,
                    "tokens_in": tokens_in,
                    "tokens_out": tokens_out,
                    "model": model,
                })

        # Process service usage items (pre-calculated costs)
        for svc in usage.get("service", []):
            cost_cents = svc.get("cost_cents", 0)
            provider = svc.get("provider", "Service")
            if cost_cents > 0:
                total_cost_cents += cost_cents
                workflow.logger.info(f"💰 Service cost: +{cost_cents}c ({provider})")
                usage_items_for_db.append({
                    "type": "service",
                    "cost_cents": cost_cents,
                    "provider": provider,
                })

        if total_cost_cents > 0:
            # Update workflow cost state
            self.own_cost_cents += total_cost_cents
            workflow.logger.info(f"💰 Total own_cost_cents: {self.own_cost_cents}c (+{total_cost_cents}c)")

            # Write to ToolUsage table (if tool_name provided)
            if tool_name and usage_items_for_db:
                try:
                    await workflow.execute_activity(
                        save_tool_usage,
                        args=[self.agent_id, self.user_id, tool_name, usage_items_for_db],
                        start_to_close_timeout=timedelta(seconds=15),
                        retry_policy=RetryPolicy(maximum_attempts=2),
                    )
                except Exception as e:
                    workflow.logger.warning(f"Failed to save tool usage to DB: {e}")

            # Signal parent for hierarchical cost relay
            await self._update_cost_and_signal_parent()

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

        # Fetch pricing for this model
        try:
            pricing = await workflow.execute_activity(
                fetch_model_pricing,
                args=[model],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=2)
            )
            self.model_pricing_cache[model] = pricing
            workflow.logger.info(f"💰 Fetched pricing for {model}: {pricing}")
            return pricing
        except Exception as e:
            workflow.logger.error(f"Failed to fetch pricing for {model}: {e}")
            return None

    # =========================================================================
    # COST LIMIT HELPERS
    # =========================================================================

    async def _check_parent_state(self) -> None:
        """Pull-based parent state check. Mirrors parent's pause/cost-limit state.

        Handles both directions:
        - Parent paused → child inherits pause (sets _paused_by_parent)
        - Parent unpaused → child unpauses (only if _paused_by_parent, not manual/credits)
        """
        if not self.parent_workflow_id:
            return
        try:
            parent = workflow.get_external_workflow_handle(self.parent_workflow_id)
            state = await parent.query("parent_state_query")
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
        except Exception as e:
            workflow.logger.warning(f"Failed to check parent state: {e}")

    def _get_pending_child_workflow_ids(self) -> List[str]:
        """Get workflow IDs of pending children for signaling."""
        return [self.child_workflow_ids[cid] for cid in self.pending_children
                if cid in self.child_workflow_ids]

    def _get_children_tokens(self) -> Tuple[int, int]:
        """Get current sum of children's tokens for tree aggregation."""
        return (
            sum(self.children_tokens_in.values()),
            sum(self.children_tokens_out.values()),
        )

    async def _on_tokens(self, tokens_in_delta: int, tokens_out_delta: int, actual_model: Optional[str] = None) -> None:
        """Callback for run_agent to report token usage after each LLM call.

        This enables real-time cost tracking and limit checking, not just at phase boundaries.
        """
        # Update workflow token state (keep in sync with run_agent local vars)
        self.tokens_in += tokens_in_delta
        self.tokens_out += tokens_out_delta
        self.token_count += tokens_in_delta + tokens_out_delta
        self.context_size = tokens_in_delta  # Current context = prompt tokens of last LLM call

        # Track actual_model for credit billing
        if actual_model:
            self.actual_model = actual_model

            # Detect Claude token fallback: we had a token but Rose used racing instead
            if (self.claude_max_token
                    and actual_model != "unknown"
                    and not actual_model.endswith("-claude")):
                workflow.logger.warning(
                    f"⚠️ Claude token fallback detected: actual_model={actual_model}, "
                    f"invalidating cached token"
                )
                self.claude_max_token = None
                self.claude_max_token_fetched_at = None

        # Use actual_model pricing if available (e.g., "-claude" suffix = $0)
        input_rate = self.input_cents_per_1k
        output_rate = self.output_cents_per_1k
        if actual_model:
            actual_pricing = get_anthropic_pricing(actual_model)
            if actual_pricing is not None:
                input_rate = actual_pricing["input_cents_per_1k"]
                output_rate = actual_pricing["output_cents_per_1k"]
                if input_rate == 0 and output_rate == 0:
                    workflow.logger.info(
                        f"💰 $0 cost (user Claude token): actual_model={actual_model}, "
                        f"in={tokens_in_delta}, out={tokens_out_delta}"
                    )

        # Calculate cost from tokens using pricing (fractional cents to avoid truncation)
        cost_cents = 0.0
        if input_rate > 0 or output_rate > 0:
            cost_cents = (
                (tokens_in_delta * input_rate / 1000) +
                (tokens_out_delta * output_rate / 1000)
            )
            if cost_cents > 0:
                self.own_cost_cents += cost_cents
                workflow.logger.info(
                    f"💰 LLM cost: +{cost_cents:.2f}c (total own: {self.own_cost_cents:.1f}c, "
                    f"in={tokens_in_delta}, out={tokens_out_delta})"
                )

                # Recalculate subtree cost and check limit (for root) or signal parent
                await self._update_cost_and_signal_parent()

        # Save ToolUsage record for credit billing (with actual_model and correct cost)
        model_for_usage = actual_model or self.model
        try:
            await workflow.execute_activity(
                save_tool_usage,
                args=[self.agent_id, self.user_id, "llm_reasoning", [{
                    "type": "llm",
                    "cost_cents": cost_cents,
                    "tokens_in": tokens_in_delta,
                    "tokens_out": tokens_out_delta,
                    "model": model_for_usage,
                }]],
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
                await parent.signal("child_cost_update", {
                    "child_agent_id": self.agent_id,
                    "subtree_cost_cents": self.subtree_cost_cents,
                    "subtree_tokens_in": self.tree_tokens_in,
                    "subtree_tokens_out": self.tree_tokens_out,
                })
            except Exception as e:
                workflow.logger.warning(f"Failed to signal parent cost update: {e}")
        else:
            # We are root - check cost limit
            await self._check_cost_limit()

        # Broadcast updated tree tokens to this agent's channel (for frontend display)
        # This applies to all agents (root and non-root) when receiving child updates
        # Skip if paused or cost-limited (don't overwrite PAUSED/COST_LIMIT_REACHED DB status with ACTIVE)
        if not self._cost_limit_reached and not self.is_paused:
            try:
                await workflow.execute_activity(
                    update_agent_status,
                    args=[self.agent_id, "ACTIVE", 0.5, "Processing",
                          self.token_count, self.context_size, self.message_count,
                          self.tree_tokens_in, self.tree_tokens_out],
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
            workflow.logger.warning(
                f"💰 Cost limit exceeded: {self.subtree_cost_cents}c >= {self.price_limit_cents}c"
            )
            self._cost_limit_reached = True
            self.is_paused = True

            # Update status to COST_LIMIT_REACHED
            try:
                await workflow.execute_activity(
                    update_agent_status,
                    args=[self.agent_id, "COST_LIMIT_REACHED", 0.0, "Cost limit reached",
                          self.token_count, self.context_size, self.message_count, self.tokens_in, self.tokens_out],
                    start_to_close_timeout=timedelta(seconds=15),
                    retry_policy=RetryPolicy(maximum_attempts=3)
                )
            except Exception as e:
                workflow.logger.error(f"Failed to update status to COST_LIMIT_REACHED: {e}")

            # Send SMS notification for cost_limit (root + SMS-source only)
            if self.agent_source == "SMS":
                try:
                    await workflow.execute_activity(
                        notify_sms_event_activity,
                        args=[self.user_id, "cost_limit", self.agent_id, {
                            "tree_cost_cents": int(self.subtree_cost_cents),
                            "price_limit_cents": self.price_limit_cents,
                        }],
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
                retry_policy=RetryPolicy(maximum_attempts=2)
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
                retry_policy=RetryPolicy(maximum_attempts=2)
            )
        except Exception as e:
            workflow.logger.debug(f"Tree state update failed (non-fatal): {e}")
    
    async def _handle_incomplete(self, result: Dict, phase: str) -> Dict:
        """Handle non-completed phase result."""
        workflow.logger.info(f"{phase} ended: {result['status']}")

        if result["status"] == "paused":
            await workflow.wait_condition(lambda: not self.is_paused)
            # Temporal SDK requires args=[] for multi-param workflows
            workflow.continue_as_new(args=[
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
            ])
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

                # Build trajectory (skip internal tools)
                if not tool_name or tool_name in {"check_progress", "completion_summary", "set_plan"}:
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

                trajectory.append({
                    "tool_name": tool_name,
                    "success": not is_error,
                    "error_message": error_message[:200] if error_message else None
                })

        # Use verifier progress if available, fallback to step-based estimate
        steps_taken = len(trajectory)
        if verifier_progress > 0:
            progress_estimate = f"{verifier_progress * 100:.0f}%"
        else:
            successful_steps = sum(1 for t in trajectory if t["success"])
            progress_estimate = f"{successful_steps}/{steps_taken} steps succeeded" if steps_taken > 0 else "No steps completed"

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
            await self._post_message("", "TOOL", {
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
                }
            })

            # 2. Broadcast FAILED status to tree with failure context
            await self._update_tree_state(progress=1.0, status="FAILED", failure_context=failure_context)

            # 3. Update DB status to FAILED
            await workflow.execute_activity(
                update_agent_status,
                args=[self.agent_id, "FAILED", 1.0, message, self.token_count, self.context_size, len(context), self.tokens_in, self.tokens_out],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3)
            )

        except Exception as e:
            workflow.logger.error(f"Failed to mark failed: {e}")

        # 4. Signal parent with failure context for learning
        if self.parent_workflow_id:
            try:
                parent = workflow.get_external_workflow_handle(self.parent_workflow_id)
                await parent.signal("child_completed", {
                    "child_agent_id": self.agent_id,
                    "result": {
                        "status": "failed",
                        "goal": self.goal,
                        "summary": f"Failed: {message}",
                        "error_reason": reason,
                        "failure_context": failure_context,  # Full context for parent learning
                        "structured_response": None,
                        "tool_counts": {}
                    }
                })
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
                outputs.append({
                    "key": field_name,
                    "label": field.get("description", field_name.replace("_", " ").title()),
                    "value": structured_response[field_name]
                })

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
                    retry_policy=RetryPolicy(maximum_attempts=2)
                )
                self.output_schema = agent_config.get("response_schema")
                workflow.logger.info(f"Fetched output_schema attempt {schema_attempt}/{max_schema_attempts}: {self.output_schema is not None}")

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
            await self._post_message("", "TOOL", {
                "toolCallId": tool_call_id,
                "toolName": "completion_summary",
                "toolStatus": "IN_PROGRESS",
                "title": "Generating summary",
            })

            # Generate summary - pass structured_response, output_schema, and child_tool_counts
            summary_result = await workflow.execute_activity(
                generate_completion_summary,
                args=[context, self.goal, self.model, structured_response, self.output_schema, self.child_tool_counts],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=3)
            )
            summary = summary_result.get("summary", "")
            tool_counts = summary_result.get("tool_counts", {})
            # Track completion summary LLM cost (doesn't go through run_agent)
            await self._track_llm_cost(
                summary_result.get("usage", {}).get("prompt_tokens", 0),
                summary_result.get("usage", {}).get("completion_tokens", 0)
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
            await self._post_message("", "TOOL", {
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
                }
            })

            # Broadcast COMPLETED status with structured output to tree
            # (output_schema is already cached from startup and included in all broadcasts)
            await self._update_tree_state(progress=1.0, status="COMPLETED", structured_output=structured_response)

            # Mark finished (includes structured_response for persistence)
            await workflow.execute_activity(
                mark_finished,
                args=[self.agent_id, context, self.token_count, self.context_size, len(context), self.tokens_in, self.tokens_out,
                      summary if self.parent_workflow_id else "", structured_response],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3)
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
                await parent.signal("child_completed", {
                    "child_agent_id": self.agent_id,
                    "result": {
                        "status": "completed",
                        "goal": self.goal,
                        "summary": summary,
                        "structured_response": structured_response,
                        "tool_counts": tool_counts
                    }
                })
            except Exception as e:
                workflow.logger.warning(f"Failed to signal parent: {e}")

        # Save blueprint (fire-and-forget, no tool messages - just logs)
        # This is the last step so it doesn't block completion UX
        try:
            await workflow.execute_activity(
                save_blueprint_activity,
                args=[self.user_id, context],
                start_to_close_timeout=timedelta(seconds=120),
                retry_policy=RetryPolicy(maximum_attempts=2)
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
