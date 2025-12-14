"""Main agent workflow for executing autonomous tasks."""

from datetime import timedelta, datetime
from typing import Dict, List, Optional, Any
from datetime import timezone
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import TimeoutError as TemporalTimeoutError
import asyncio
import structlog

with workflow.unsafe.imports_passed_through():
    # Helper activities (workflow orchestration, not exposed to LLM)
    from helpers import (
        poll_new_messages,
        post_agent_message,
        decide_next_action,
        check_progress,
        update_agent_status,
        compress_context,
        generate_completion_summary,
        get_model_context_window,
        fetch_agent_tools,
        mark_finished,
        fetch_agent_config,
        check_user_usage,
    )
    from helpers.save_tool_usage import save_tool_usage
    # New event-driven tool system
    from tools.base import ToolEvent, EventType, MessageStatus
    from tools.deep_research import deep_research
    from tools.wait_seconds import wait_seconds
    from tools.send_message_to_user import send_message_to_user
    from tools.request_user_approval import request_user_approval_direct
    from tools.knowledge_base import query_blueprints, save_blueprint
    from tools.web_search import web_search
    from tools.spawn_sub_agents import spawn_sub_agents
    from tools.send_sms_as_user import send_sms_as_user
    from tools.spawn_browser_agent import spawn_browser_agent
    from tools.search_user_network import search_user_network_for_people
    from tools.find_all import find_all
    from tools.enrich import enrich
    from tools.monitor import monitor
    from tools.check_monitor_events import check_monitor_events
    from tools.read_message_history import read_message_history_with_person
    from tools.message_person import message_person, get_manager as get_message_person_manager
    # Plan phase tools
    from tools.set_plan import set_plan
    from tools.progress_to_autonomous_execution_phase import progress_to_autonomous_execution_phase
    # Legacy phase marker (kept for execute phase verification)
    from tools.mark_execution_complete import mark_execution_complete
    # x402 Bazaar tools
    from tools.x402_bazaar import search_x402_bazaar, pay_for_x402_bazaar_service

logger = structlog.get_logger()


# Trigger continue_as_new at 80% context usage
CONTEXT_THRESHOLD_PERCENTAGE = 0.8

# Tools migrated to new event-driven system
# Maps tool names to their workflow helper functions
EVENT_DRIVEN_TOOLS = {
    "spawn_browser_agent": spawn_browser_agent,
    "deep_research": deep_research,
    "wait_seconds": wait_seconds,
    "send_message_to_user": send_message_to_user,
    "query_blueprints": query_blueprints,
    "save_blueprint": save_blueprint,
    "web_search": web_search,
    "spawn_sub_agents": spawn_sub_agents,
    "send_sms_as_user": send_sms_as_user,
    "search_user_network_for_people": search_user_network_for_people,
    "find_all": find_all,
    "enrich": enrich,
    "monitor": monitor,
    "check_monitor_events": check_monitor_events,
    "read_message_history_with_person": read_message_history_with_person,
    "message_person": message_person,
    # Plan phase tools
    "set_plan": set_plan,
    "progress_to_autonomous_execution_phase": progress_to_autonomous_execution_phase,
    # Execute phase verification
    "mark_execution_complete": mark_execution_complete,
    # x402 Bazaar tools
    "search_x402_bazaar": search_x402_bazaar,
    "pay_for_x402_bazaar_service": pay_for_x402_bazaar_service,
}

# Read-only tools available during RESEARCH phase
READ_ONLY_TOOL_NAMES = {
    "web_search",
    "deep_research",
    "search_user_network_for_people",
    "read_message_history_with_person",
    "find_all",
    "check_monitor_events",
    "send_message_to_user",
    "search_x402_bazaar",
}

# Tool formatter registry (maps tool names to their formatters)
# NOTE: All tools migrated to EVENT_DRIVEN_TOOLS (v2 architecture)
TOOL_FORMATTERS = {}

# Registry of tool managers for approval checking
# Maps tool names to their get_manager() functions
TOOL_MANAGERS = {
    "message_person": get_message_person_manager,
}

# NOTE: query_blueprints and save_blueprint migrated to knowledge_base (event-driven)

# System tools that are always available (don't need to be in DB)
# Tools with read_only=True are available during RESEARCH phase
SYSTEM_TOOLS = [
    {
        "id": "system-wait-seconds",
        "name": "wait_seconds",
        "description": "Pause execution for a specified number of seconds (1-3600). Use this when you need to wait for time-dependent results or real-world delays."
    },
    {
        "id": "system-spawn-sub-agents",
        "name": "spawn_sub_agents",
        "description": "Spawn multiple sub-agents to work on parallel subtasks concurrently. Use sub-agents to parallelize work: evaluate multiple hypotheses at once, execute context-independent tasks in parallel, and/or decompose the current goal into context-independent subgoals for faster and more accurate completion. Each sub-agent runs independently with its own goal and verifier. Provide a list of sub-agent configs with: goal (required), model (optional), reasoning_effort (optional), and verifier (required with type and llm_judge_prompt). The parent agent will wait for all sub-agents to complete before continuing. NOTE: Maximum nesting depth is 1 - sub-agents cannot spawn their own sub-agents."
    },
    {
        "id": "system-send-message-to-user",
        "name": "send_message_to_user",
        "description": "Communicate directly with the user from the PLAN phase. Use is_question=true when you must block for their clarification/approval, and is_question=false to send FYIs (like the plan you intend to execute) without waiting for a reply.",
        "read_only": True  # Available during research to ask clarifying questions
    },
    {
        "id": "system-find-all",
        "name": "find_all",
        "description": "Discover all entities matching specific criteria using natural language queries. Returns matched candidates with names, details, reasoning, and citations. Generators: 'preview' (cheapest, ~10 candidates for testing), 'base' (broad queries, many matches), 'core' (specific queries, moderate matches), 'pro' (highly specific/rare matches). Pricing: Fixed cost + per-match fee. Core generator: $2.00 fixed + $0.15/match. Use 'preview' first to test queries before scaling to other generators.",
        "read_only": True
    },
    {
        "id": "system-enrich",
        "name": "enrich",
        "description": "Enrich an entity (person/company) with additional structured data from the web. Provide input data (name, email, company, url, etc.) and an output_schema JSON schema defining what fields to extract. Processors: 'lite' (basic info, 5s-60s, $0.005), 'base' (simple research, 15s-100s, $0.01), 'core' (complex research, 1-5min, $0.025), 'core2x' (very complex, 2-5min, $0.05), 'pro' (exploratory, 3-9min, $0.10), 'ultra' (extensive deep research, 5-25min, $0.30), 'ultra2x/4x/8x' (advanced deep research with 2x/4x/8x compute, $0.60/$1.20/$2.40). Choose processor based on research complexity needed."
    },
    {
        "id": "system-monitor",
        "name": "monitor",
        "description": "Continuously monitor the web for material changes relevant to a query on a schedule. Cadence options: 'hourly', 'daily', 'weekly'. Returns monitor_id for tracking. Use check_monitor_events to retrieve detected events. Cost: $0.003 per request to create monitor. Best for: tracking news, competitor changes, regulatory updates, market events."
    },
    {
        "id": "system-check-monitor-events",
        "name": "check_monitor_events",
        "description": "Check for new events detected by a previously created monitor. Returns list of events with details about what changed on the web. Requires monitor_id from a previous monitor call. Use this periodically to retrieve updates - monitors run on their schedule but you must check for events to see results.",
        "read_only": True
    },
    {
        "id": "system-search-user-network",
        "name": "search_user_network_for_people",
        "description": "Search the user's personal network for people matching specific criteria. Performs semantic search across contacts, finding people by name, profession, company, skills, relationship type, location, or any combination. Use this to find connections who can help with specific tasks or goals. All fields are optional - search by whatever criteria you have.",
        "read_only": True
    },
    {
        "id": "system-read-message-history",
        "name": "read_message_history_with_person",
        "description": "Read message history with a person. Retrieves past conversations across all channels (iMessage, WhatsApp, email, etc.). Provide at least one identifier: phone number, email address, or first+last name. You MUST call this tool before using message_person to send any message - it ensures you have context about previous conversations.",
        "read_only": True
    },
    {
        "id": "system-message-person",
        "name": "message_person",
        "description": "Send a message to a person via SMS or email. IMPORTANT: You MUST first call read_message_history_with_person for the SAME person before using this tool - if you haven't read their message history, this tool will fail with an error. Requires: 'channel' ('sms' or 'email'), person identifier (phone for SMS, email for email), and 'message'. For email, 'subject' is also required."
    },
    {
        "id": "system-spawn-browser-agent",
        "name": "spawn_browser_agent",
        "description": "Spawn an autonomous browser agent to complete web tasks. The agent can navigate websites, fill forms, click buttons, and interact with web pages. Use this for any task that requires browsing the web interactively. Browser cookies have been injected - assume the user is logged in until proven otherwise."
    },
    {
        "id": "system-web-search",
        "name": "web_search",
        "description": "Search the web for information using Perplexity AI. Returns comprehensive answers with citations. Use for factual questions, current events, research, and any information gathering that doesn't require browsing interactively.",
        "read_only": True
    },
    {
        "id": "system-deep-research",
        "name": "deep_research",
        "description": "Conduct deep, comprehensive research on a topic using multiple sources and extended reasoning. More thorough than web_search but takes longer and costs more. Use for complex research questions requiring synthesis of multiple sources.",
        "read_only": True
    },
    {
        "id": "system-search-x402-bazaar",
        "name": "search_x402_bazaar",
        "description": "Search the x402 Bazaar for available paid API services. The Bazaar is a discovery layer for APIs that accept cryptocurrency payments via the x402 protocol. Returns a list of services with pricing, capabilities, and schemas. Use this to find specialized APIs that can help accomplish tasks, then use pay_for_x402_bazaar_service to call them. Our own services are automatically filtered out.",
        "read_only": True
    },
    {
        "id": "system-pay-x402-service",
        "name": "pay_for_x402_bazaar_service",
        "description": "Execute a paid API call to an x402 service discovered from search_x402_bazaar. Handles the x402 payment protocol automatically. Requires: resource_url (from search results), method (GET/POST), params (request parameters), and max_amount_cents (safety limit on payment). The call will fail if the service requires more than the max_amount_cents limit."
    },
]

# Plan-only tools (available only in PLAN phase, disappear in EXECUTE phase)
PLAN_ONLY_TOOLS = {
    "set_plan": {
        "id": "plan-set-plan",
        "name": "set_plan",
        "description": "Set or update the execution plan. Provide markdown_text (plan content), is_parallelizable (true if work can be parallelized, false if tasks are causally dependent), sub_tasks (steps list), and sub_goals (REQUIRED when is_parallelizable=true - list of goals with context for parallel sub-agents).",
        "plan_only": True
    },
    "progress_to_autonomous_execution_phase": {
        "id": "plan-progress-to-execute",
        "name": "progress_to_autonomous_execution_phase",
        "description": "Request to transition to autonomous execution phase. This will prompt the user to approve the plan before execution begins.",
        "plan_only": True
    },
}

# Execute phase verification tool
EXECUTE_MARKER_TOOL = {
    "id": "phase-mark-execution-complete",
    "name": "mark_execution_complete",
    "description": "Signal that execution is complete and ready for verification. Call this when you believe the goal has been fully accomplished."
}


def estimate_token_count(text: str) -> int:
    """
    Rough token estimation: ~4 chars per token for English text.
    This is conservative and works across most tokenizers.
    """
    return len(text) // 4


def detect_phase_from_context(context: List[Dict]) -> str:
    """
    Detect phase based on user messages and tool calls - stateless detection.
    
    Transitions to EXECUTE phase if:
    1. Any USER message contains "start autonomous execution" (case-insensitive)
    2. OR the progress_to_autonomous_execution_phase tool was called
    
    Otherwise, stays in PLAN phase.
    
    Args:
        context: List of message dicts
        
    Returns:
        "EXECUTE" or "PLAN"
    """
    for msg in context:
        # Check user messages for trigger phrase
        if msg.get('role') == 'USER':
            text = msg.get('text', '').lower()
            if 'start autonomous execution' in text:
                return 'EXECUTE'
        
        # Check for progress_to_autonomous_execution_phase tool call
        if msg.get('role') == 'TOOL':
            metadata = msg.get('metadata', {})
            tool_name = metadata.get('toolName', '')
            if tool_name == 'progress_to_autonomous_execution_phase':
                return 'EXECUTE'
        
        # Also check ASSISTANT messages for tool_calls metadata
        if msg.get('role') == 'ASSISTANT':
            metadata = msg.get('metadata', {})
            tool_calls = metadata.get('tool_calls', [])
            for tc in tool_calls:
                if tc.get('tool') == 'progress_to_autonomous_execution_phase':
                    return 'EXECUTE'
    
    return 'PLAN'


def get_phase_tools_and_config(
    phase: str,
    all_tools: List[Dict],
    is_first_call: bool = False,
) -> Dict[str, Any]:
    """
    Get tools, tool names, and model preference for the current phase.
    
    Simplified 2-Phase Flow: PLAN → EXECUTE
    
    Args:
        phase: Current phase (PLAN or EXECUTE)
        all_tools: Full list of available tools
        is_first_call: True if this is the first LLM call (no tools, fast model)
        
    Returns:
        Dict with 'enabled_tools', 'enabled_tool_names', 'disabled_tools', 'model_preference'
    """
    enabled_tools = []
    disabled_tools = []
    model_pref = None
    
    if is_first_call:
        # First call: no tools, fast model (like old PREPARE_RESEARCH)
        enabled_tools = []
        model_pref = "FAST"
        # All tools are disabled on first call
        disabled_tools = list(all_tools)
        # Add execute-only note for non-read-only tools
        for tool in disabled_tools:
            if not tool.get("read_only") and not tool.get("plan_only"):
                tool["_disabled_note"] = "available in execute phase"
        
    elif phase == "PLAN":
        # PLAN phase: read-only tools + plan-only tools
        enabled_tools = [
            t for t in all_tools 
            if t.get("read_only")
        ]
        
        # Add plan-only tools
        for tool_def in PLAN_ONLY_TOOLS.values():
            if tool_def not in enabled_tools:
                enabled_tools.append(tool_def)
        
        # Calculate disabled tools (execute-only tools)
        enabled_names = {t["name"] for t in enabled_tools}
        disabled_tools = [
            t for t in all_tools 
            if t["name"] not in enabled_names
        ]
        
        # Mark disabled tools with note
        for tool in disabled_tools:
            tool["_disabled_note"] = "available in execute phase"
        
    else:  # EXECUTE
        # EXECUTE phase: all tools EXCEPT plan-only tools
        # Plan-only tools completely disappear (not disabled)
        plan_only_names = {t["name"] for t in PLAN_ONLY_TOOLS.values()}
        enabled_tools = [
            t for t in all_tools 
            if t["name"] not in plan_only_names and t.get("name") != "send_message_to_user"
        ]
        
        # Add mark_execution_complete marker
        if EXECUTE_MARKER_TOOL not in enabled_tools:
            enabled_tools.append(EXECUTE_MARKER_TOOL)
        
        # send_message_to_user is explicitly disabled during execute phase
        disabled_tools = []
        request_tool = next((t for t in all_tools if t.get("name") == "send_message_to_user"), None)
        if request_tool:
            disabled_tools.append(request_tool)
    
    return {
        "enabled_tools": enabled_tools,
        "enabled_tool_names": [t["name"] for t in enabled_tools],
        "disabled_tools": disabled_tools,
        "model_preference": model_pref
    }


@workflow.defn
class AgentWorkflow:
    """
    Main workflow for autonomous agent task execution.
    
    This workflow:
    1. Polls for new user messages between steps
    2. Uses LLM to decide next action based on goal + context
    3. Executes actions with extreme backoff retries
    4. All errors get propagated to agent context (no "critical" failures)
    5. Uses workflow.sleep() for all waits
    6. Uses continue_as_new to manage unbounded history
    """
    
    def __init__(self):
        self.agent_id: Optional[str] = None
        self.user_id: Optional[str] = None
        # user_phone removed - now fetched from user context via get_user_context
        self.goal: Optional[str] = None
        self.model: str = "anthropic/claude-sonnet-4.5"
        self.reasoning_effort: str = "low"  # OpenRouter reasoning effort
        self.tool_ids: List[str] = []
        self.tools: List[Dict[str, str]] = []  # Tools with descriptions from DB
        self.verifier: Optional[Dict] = None
        self.context: List[Dict] = []
        self.last_message_check: Optional[datetime] = datetime(1970, 1, 1).replace(tzinfo=timezone.utc)
        self.iteration_count: int = 0
        self.context_tokens: int = 0
        self.max_context_tokens: Optional[int] = None  # Fetched from OpenRouter
        self.token_count: int = 0  # Cumulative tokens used (total)
        self.tokens_in: int = 0  # Cumulative input tokens (prompt)
        self.tokens_out: int = 0  # Cumulative output tokens (completion)
        self.is_paused: bool = False  # Pause state
        
        # Sub-agent tracking (for parent workflows)
        self.parent_workflow_id: Optional[str] = None
        self.pending_children: Set[str] = set()
        self.child_tool_ids: Dict[str, str] = {}  # Map child_agent_id -> tool_call_id
        self.child_last_tokens: Dict[str, Dict[str, int]] = {}  # Track last token counts from each child
        self.depth: int = 0  # Agent nesting depth (0 = top-level, 1 = sub-agent, etc.)
        
        # Simplified 2-phase system: PLAN → EXECUTE
        # Phase is detected statelessly from user messages containing "execute"
        self.is_first_call: bool = True  # First call uses fast model, no tools
        
        # Lock for thread-safe token counter updates during parallel execution
        self._state_lock = asyncio.Lock()
    
    @workflow.signal
    async def pause(self):
        """Pause workflow execution (instant via signal)."""
        workflow.logger.info("🔴 Received PAUSE signal")
        self.is_paused = True
    
    @workflow.signal
    async def resume(self):
        """Resume workflow execution (instant via signal)."""
        workflow.logger.info("🟢 Received RESUME signal")
        self.is_paused = False
    
    @workflow.signal
    async def receive_user_response(self, response: str):
        """
        Receive user response to an attention request.
        Adds the response to context (message is already in DB from the POST endpoint).
        
        Args:
            response: The user's response text
        """
        workflow.logger.info(f"💬 Received user response (length={len(response)})")
        
        # Only add to context - message is already in DB from POST /agents/:id/messages
        # This unblocks any wait_condition checking for USER messages
        self.context.append({
            "role": "USER",
            "text": response,
            "timestamp": workflow.now().isoformat()
        })
    
    @workflow.signal
    async def child_progress(self, data: dict):
        """
        Receive progress update from child agent.
        Updates the sub-agent's tool message with current progress.
        Also accumulates token usage from child.
        
        Args:
            data: Dict with "child_agent_id", "progress" (float 0.0-1.0), 
                  and optional "tokens_in", "tokens_out", "token_count", "goal"
        """
        child_agent_id = data.get("child_agent_id", "")
        progress = data.get("progress", 0.0)
        tokens_in = data.get("tokens_in", 0)
        tokens_out = data.get("tokens_out", 0)
        token_count = data.get("token_count", 0)
        goal = data.get("goal", "")
        
        workflow.logger.info(
            f"📊 Progress update from child {child_agent_id[:8]}: "
            f"{progress*100:.1f}%, tokens: {token_count}"
        )
        
        # Calculate delta from last token count (only add new tokens)
        last_tokens = self.child_last_tokens.get(child_agent_id, {
            "tokens_in": 0,
            "tokens_out": 0,
            "token_count": 0
        })
        
        delta_in = tokens_in - last_tokens["tokens_in"]
        delta_out = tokens_out - last_tokens["tokens_out"]
        delta_total = token_count - last_tokens["token_count"]
        
        # Update last known token counts for this child
        self.child_last_tokens[child_agent_id] = {
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "token_count": token_count
        }
        
        # Accumulate only the delta into parent's counters
        if delta_in > 0 or delta_out > 0 or delta_total > 0:
            self.tokens_in += delta_in
            self.tokens_out += delta_out
            self.token_count += delta_total
            workflow.logger.info(
                f"💰 Accumulated child token delta: "
                f"+{delta_total} total (+{delta_in} in, +{delta_out} out)"
            )
        
        # Get child's tool_call_id
        child_tool_id = self.child_tool_ids.get(child_agent_id)
        if not child_tool_id:
            workflow.logger.warning(f"No tool_call_id for child {child_agent_id}")
            return
        
        # Format title with truncated goal (first 30 chars)
        goal_text = goal[:30] if goal else "Unknown goal"
        if goal and len(goal) > 30:
            goal_text += "..."
        title = f"{goal_text}"
        
        # Post progress update with metadata
        await self._post_message(
            f"Progress: {int(progress * 100)}%",
            "TOOL",
            metadata={
                "toolCallId": child_tool_id,
                "toolName": "spawn_sub_agents",
                "toolStatus": "IN_PROGRESS",
                "title": title,
                "subAgentId": child_agent_id,
                "progress": progress
            }
        )
    
    @workflow.signal
    async def child_completed(self, data: dict):
        """
        Receive completion signal from child agent.
        Mark child's tool as FINISHED and add summary to context.
        
        Args:
            data: Dict with "child_agent_id" and "result" (includes summary)
        """
        child_agent_id = data.get("child_agent_id", "")
        result = data.get("result", {})
        
        workflow.logger.info(f"✅ Child {child_agent_id[:8]} completed")
        
        # Get child's tool_call_id and post FINISHED message FIRST
        # (before removing from pending, to avoid race condition where parent
        # sees all children complete before all completion messages are posted)
        child_tool_id = self.child_tool_ids.get(child_agent_id)
        if child_tool_id:
            status = result.get("status", "completed")
            goal_text = result.get("goal", "")
            summary = result.get("summary", "")
            
            # Use summary as the message content if available, otherwise use goal
            message_content = summary if summary else f"Completed: {goal_text}"
            
            # Post FINISHED message with summary
            await self._post_message(
                message_content,
                "TOOL",
                metadata={
                    "toolCallId": child_tool_id,
                    "toolName": "spawn_sub_agents",
                    "toolStatus": "FINISHED",
                    "title": "Sub-agent completed: " + goal_text[:30],
                    "subAgentId": child_agent_id,
                    "progress": 1.0
                }
            )
            
            workflow.logger.info(
                f"Child result added to context: child_id={child_agent_id[:8]}, summary_length={len(summary) if summary else 0}"
            )
        
        # Remove from pending AFTER posting message
        # This ensures parent's wait_condition doesn't wake up until message is posted
        self.pending_children.discard(child_agent_id)
        
    @workflow.run
    async def run(
        self,
        agent_id: str,
        user_id: str,
        goal: str,
        model: str,
        reasoning_effort: str,
        tool_ids: List[str],
        verifier: Dict,
        context: Optional[List[Dict]] = None,
        parent_workflow_id: Optional[str] = None,  # Parent workflow ID for signaling
        depth: int = 0,  # Nesting depth (0 = top-level, 1 = sub-agent, 2 = max)
        # user_phone removed - now fetched from user context via get_user_context
    ) -> Dict:
        """
        Execute an autonomous agent task.
        
        Args:
            agent_id: Unique agent ID
            user_id: User ID who owns this agent
            goal: What the agent should accomplish
            model: LLM model to use for reasoning (e.g., anthropic/claude-sonnet-4.5)
            reasoning_effort: OpenRouter reasoning effort level (low, medium, high)
            tool_ids: List of tool IDs available to this agent
            verifier: Verification config (type: FLOAT_LLM_JUDGE, llmJudgePrompt: str)
            
        Returns:
            Task completion details or continues as new
        """
        self.agent_id = agent_id
        self.user_id = user_id
        # user_phone removed - now fetched from user context
        self.goal = goal
        self.model = model
        self.reasoning_effort = reasoning_effort
        self.tool_ids = tool_ids
        self.verifier = verifier
        self.parent_workflow_id = parent_workflow_id  # Store parent ID for signaling
        self.depth = depth  # Store nesting depth
        self.context = context or []
        
        # Phase is detected statelessly from user messages
        # First call uses fast model with no tools
        
        # Initialize last message check time to 1 hour ago so we fetch the goal message
        # (must use workflow.now() for determinism)
        
        workflow.logger.info(
            f"Agent iteration {self.iteration_count}: agent={agent_id}, goal='{goal}', model={model}, tools={len(tool_ids)}"
        )
        
        # Fetch model's context window and tools from backend (only on first iteration)
        if self.max_context_tokens is None:
            try:
                workflow.logger.info(f"🔍 Calling get_model_context_window for model={model}")
                self.max_context_tokens = await workflow.execute_activity(
                    get_model_context_window,
                    args=[model],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(
                        maximum_attempts=3,
                        backoff_coefficient=2.0,
                        initial_interval=timedelta(seconds=1),
                        maximum_interval=timedelta(seconds=10)
                    )
                )
                workflow.logger.info(
                    f"Model context window fetched: model={model}, max_context_tokens={self.max_context_tokens}"
                )
            except Exception as e:
                # Fallback to safe default if fetch fails
                self.max_context_tokens = 100_000
                workflow.logger.warning(
                    f"Failed to fetch context window, using default {self.max_context_tokens}: {str(e)}"
                )
        
        # Fetch tool descriptions from backend (only on first iteration)
        # This fetches tools assigned to this agent via AgentTool junction table
        if not self.tools:
            # Filter system tools based on depth (sub-agents can't spawn more sub-agents)
            # Use self.depth which is passed through the workflow args
            is_sub_agent = self.depth >= 1
            
            if is_sub_agent:
                workflow.logger.info("🔗 Sub-agent detected (depth=%d), excluding spawn_sub_agents tool", self.depth)
            
            # Filter system tools: exclude spawn_sub_agents for sub-agents
            system_tools = [
                tool for tool in SYSTEM_TOOLS 
                if not (is_sub_agent and tool["name"] == "spawn_sub_agents")
            ]
            
            try:
                workflow.logger.info(f"🔍 Calling fetch_agent_tools for agent_id={agent_id}")
                db_tools = await workflow.execute_activity(
                    fetch_agent_tools,
                    args=[agent_id],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(
                        maximum_attempts=3,
                        backoff_coefficient=2.0,
                        initial_interval=timedelta(seconds=1),
                        maximum_interval=timedelta(seconds=10)
                    )
                )
                
                # Merge filtered system tools with user's assigned tools
                self.tools = system_tools + db_tools
                
                workflow.logger.info(
                    f"Agent tools fetched: system_tools={len(system_tools)}, db_tools={len(db_tools)}, total_tools={len(self.tools)}, is_sub_agent={is_sub_agent}"
                )
            except Exception as e:
                workflow.logger.error(
                    f"Failed to fetch agent tools: {str(e)}"
                )
                # Fall back to just filtered system tools
                self.tools = system_tools
        
        # Update status to ACTIVE
        try:
            workflow.logger.info(f"🔍 Calling update_agent_status (initial): agent_id={agent_id}, status=ACTIVE, progress=0.0, msg_count={len(self.context)}")
            await workflow.execute_activity(
                update_agent_status,
                args=[agent_id, "ACTIVE", 0.0, "Agent started", 0, 0, len(self.context), 0, 0],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=3)
            )
        except Exception as e:
            workflow.logger.warning(f"Failed to update initial status: {str(e)}")
        
        try:
            # Main agent loop
            while True:
                # Poll config at start of each iteration
                manually_paused = False
                try:
                    config = await workflow.execute_activity(
                        fetch_agent_config,
                        args=[agent_id],
                        start_to_close_timeout=timedelta(seconds=30),
                        retry_policy=RetryPolicy(maximum_attempts=3)
                    )
                    manually_paused = config['status'] == 'PAUSED'
                    
                    # Update model and reasoning effort
                    if config['model'] != self.model:
                        workflow.logger.info(f"📝 Model changed: {self.model} → {config['model']}")
                        self.model = config['model']
                    
                    if 'reasoning_effort' in config and config['reasoning_effort'] != self.reasoning_effort:
                        workflow.logger.info(f"📝 Reasoning effort changed: {self.reasoning_effort} → {config['reasoning_effort']}")
                        self.reasoning_effort = config['reasoning_effort']
                    
                    if config.get('verifier_prompt'):
                        self.verifier['llmJudgePrompt'] = config['verifier_prompt']
                    
                    # Check if tools have changed
                    new_tool_ids = config.get('tool_ids', [])
                    if new_tool_ids != self.tool_ids:
                        workflow.logger.info(
                            f"🔄 Tool configuration changed (old: {len(self.tool_ids)}, new: {len(new_tool_ids)})"
                        )
                        self.tool_ids = new_tool_ids
                        
                        # Refetch tool descriptions from backend
                        # Filter system tools based on depth (sub-agents can't spawn more sub-agents)
                        is_sub_agent = self.depth >= 1
                        system_tools = [
                            tool for tool in SYSTEM_TOOLS 
                            if not (is_sub_agent and tool["name"] == "spawn_sub_agents")
                        ]
                        
                        try:
                            db_tools = await workflow.execute_activity(
                                fetch_agent_tools,
                                args=[agent_id],
                                start_to_close_timeout=timedelta(seconds=30),
                                retry_policy=RetryPolicy(
                                    maximum_attempts=3,
                                    backoff_coefficient=2.0,
                                    initial_interval=timedelta(seconds=1),
                                    maximum_interval=timedelta(seconds=10)
                                )
                            )
                            
                            # Merge system tools with updated DB tools
                            self.tools = system_tools + db_tools
                            
                            workflow.logger.info(
                                f"✅ Tools updated: system_tools={len(system_tools)}, db_tools={len(db_tools)}, total_tools={len(self.tools)}"
                            )
                        except Exception as e:
                            workflow.logger.error(
                                f"⚠️ Failed to refetch tools: {str(e)}, keeping existing tools"
                            )
                except Exception as e:
                    workflow.logger.warning(f"Failed to fetch config: {str(e)}")
                
                # Check user's credit usage - pause if depleted
                has_credits = True  # Default to true if check fails
                try:
                    usage_result = await workflow.execute_activity(
                        check_user_usage,
                        args=[self.user_id],
                        start_to_close_timeout=timedelta(seconds=10),
                        retry_policy=RetryPolicy(
                            maximum_attempts=2,
                            backoff_coefficient=2.0,
                            initial_interval=timedelta(seconds=1),
                            maximum_interval=timedelta(seconds=5)
                        )
                    )
                    
                    # If None, activity failed - assume has credits to avoid blocking
                    if usage_result is None:
                        workflow.logger.warning(
                            "⚠️  Failed to check usage after retries - assuming has credits"
                        )
                    else:
                        has_credits = usage_result.get("has_credits", True)
                        remaining = usage_result.get("remaining", 0)
                        
                        if not has_credits:
                            workflow.logger.warning(
                                f"💳 User has no credits remaining (${remaining:.2f})"
                            )
                            # Update agent status to OUT_OF_CREDITS
                            try:
                                await workflow.execute_activity(
                                    update_agent_status,
                                    args=[
                                        self.agent_id,
                                        "OUT_OF_CREDITS",
                                        0.0,  # progress
                                        "Out of credits - add more to continue",
                                        self.token_count,
                                        self.context_tokens,
                                        len(self.context),
                                        self.tokens_in,
                                        self.tokens_out
                                    ],
                                    start_to_close_timeout=timedelta(seconds=10),
                                    retry_policy=RetryPolicy(maximum_attempts=2)
                                )
                            except Exception as e:
                                workflow.logger.error(f"Failed to update status to OUT_OF_CREDITS: {str(e)}")
                        elif remaining < 1.0:  # Warn when below $1
                            workflow.logger.warning(
                                f"⚠️  Low credits: ${remaining:.2f} remaining"
                            )
                
                except Exception as e:
                    workflow.logger.warning(f"Failed to check usage: {str(e)} - continuing anyway")
                
                # Paused if manually paused OR out of credits
                self.is_paused = manually_paused or (not has_credits)
                
                # If paused, wait with timeout then reloop to re-check
                if self.is_paused:
                    try:
                        await workflow.wait_condition(
                            lambda: not self.is_paused,
                            timeout=timedelta(seconds=30)
                        )
                    except (asyncio.TimeoutError, TemporalTimeoutError):
                        pass
                    continue
                
                # 1. Poll for new user messages (already in DB, just add to context)
                new_messages = await self._poll_messages()
                if new_messages:
                    for message in new_messages:
                        # Messages are already in DB, just add to context (no re-insertion)
                        self.context.append({
                            "role": message["role"],
                            "text": message["text"],
                            "timestamp": message["timestamp"]
                        })
                    # Sort context by timestamp to maintain chronological order
                    self.context.sort(key=lambda x: x.get("timestamp", ""))

                # 2. Query blueprints AFTER first call (iteration 1, not 0)
                # First call (iteration 0) is fast with no tools, blueprint query happens after
                if self.iteration_count == 1:
                    blueprints = await query_blueprints(self, self.context, self.user_id, 3)
                    if blueprints:
                        # Insert blueprints as reference examples from past successful agents
                        for idx, bp in enumerate(blueprints, 1):
                            formatted_blueprint = (
                                f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
                                f"📋 REFERENCE EXAMPLE #{idx} (from previous agent)\n"
                                f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
                                f"Similar Goal: {bp['title']}\n\n"
                                f"How a past agent successfully approached this:\n"
                                f"{bp['blueprint']}\n"
                                f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
                                f"Note: This is a reference example, not your current progress.\n"
                                f"Use these insights to inform your own approach.\n"
                                f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                            )
                            self.context.append({
                                "role": "SYSTEM",
                                "text": formatted_blueprint,
                                "timestamp": workflow.now().isoformat()
                            })
                
                # 3. Decide next action using LLM
                action = await self._decide_next_action()
                
                # Validate action result
                if action is None:
                    raise ValueError("_decide_next_action returned None")
                
                if not isinstance(action, dict):
                    raise ValueError(f"_decide_next_action returned non-dict: {type(action)}")
                
                # Track tokens from LLM call - STRICT: usage must exist
                if "usage" not in action:
                    raise ValueError("Action missing required 'usage' field")
                
                usage = action["usage"]
                if usage is None:
                    raise ValueError("Action 'usage' field is None")
                
                if "prompt_tokens" not in usage:
                    raise ValueError("Action usage missing 'prompt_tokens'")
                if "completion_tokens" not in usage:
                    raise ValueError("Action usage missing 'completion_tokens'")
                if "total_tokens" not in usage:
                    raise ValueError("Action usage missing 'total_tokens'")
                
                async with self._state_lock:
                    self.tokens_in += usage["prompt_tokens"]
                    self.tokens_out += usage["completion_tokens"]
                    self.token_count += usage["total_tokens"]
                
                # 4. Post response to user (visible in UI and added to context)
                # Reasoning is logged but not posted to chat
                # Include tool_calls in metadata for proper OpenAI format reconstruction
                response = action.get("response", "")
                tool_calls = action.get("tool_calls", [])
                
                # Generate IDs for all tool calls upfront (so they match in assistant message + tool results)
                for tool_call in tool_calls:
                    if 'tool_call_id' not in tool_call:
                        tool_call['tool_call_id'] = workflow.uuid4()
                
                if response:
                    metadata = {"tool_calls": tool_calls} if tool_calls else None
                    await self._post_message(response, "ASSISTANT", metadata=metadata)
                
                # 5. Execute all tools in parallel
                async def execute_one_tool(tool_call):
                    """Execute a single tool with error handling."""
                    tool_name = tool_call.get("tool", "unknown")
                    tool_call_id = tool_call['tool_call_id']
                    
                    try:
                        if tool_name not in EVENT_DRIVEN_TOOLS:
                            raise ValueError(f"Unknown tool: {tool_name}")
                        
                        # Check if tool requires user approval before execution
                        if tool_name in TOOL_MANAGERS:
                            manager = TOOL_MANAGERS[tool_name]()
                            if manager.requires_approval:
                                workflow.logger.info(f"🔐 Tool {tool_name} requires approval, requesting...")
                                approval_question = manager.get_approval_question(tool_call)
                                await request_user_approval_direct(
                                    self,
                                    question=approval_question,
                                    metadata={"toolApproval": True, "toolName": tool_name}
                                )
                                workflow.logger.info(f"✅ User approved {tool_name}, proceeding with execution")
                        
                        workflow.logger.info(f"✨ Executing tool: {tool_name}")
                        v2_helper = EVENT_DRIVEN_TOOLS[tool_name]
                        await v2_helper(self, tool_call, tool_call_id)
                        
                    except Exception as e:
                        # Post error message to UI and context
                        error_msg = f"Tool {tool_name} failed: {str(e)}"
                        await self._post_message(
                            error_msg,
                            "TOOL",
                            metadata={
                                "toolCallId": tool_call_id,
                                "toolName": tool_name,
                                "toolStatus": "FINISHED",
                                "title": "Error",
                                "error": True
                            }
                        )
                        workflow.logger.error(f"Tool execution failed: {error_msg}")
                
                if tool_calls:
                    await asyncio.gather(*[execute_one_tool(tc) for tc in tool_calls])
                
                # 5.5. Mark first call as complete (after first LLM response)
                if self.is_first_call:
                    workflow.logger.info("📋 First call complete, subsequent calls will have tools")
                    self.is_first_call = False
                
                # Phase is detected statelessly - no tool-based transitions needed
                # The phase is determined at the start of _decide_next_action
                
                # 6. Check progress ONLY if mark_execution_complete was called
                tool_names_called = [tc.get("tool") for tc in tool_calls]
                if "mark_execution_complete" in tool_names_called:
                    # Generate a unique ID for this verifier call
                    verifier_call_id = workflow.uuid4()
                    
                    # Post IN_PROGRESS message
                    await self._post_message(
                        "",
                        "TOOL",
                        metadata={
                            "toolCallId": verifier_call_id,
                            "toolName": "check_progress",
                            "toolStatus": "IN_PROGRESS",
                            "title": "⚖️ Verifying goal completion",
                            "verifierMessage": True
                        }
                    )
                    
                    progress_result = await self._check_progress()
                    # Track tokens from verifier LLM call (usage is always present)
                    verifier_usage = progress_result["usage"]
                    
                    async with self._state_lock:
                        self.tokens_in += verifier_usage.get("prompt_tokens", 0)
                        self.tokens_out += verifier_usage.get("completion_tokens", 0)
                        self.token_count += verifier_usage.get("total_tokens", 0)
                    
                    progress_score = progress_result.get("score", 0.0)
                    progress_reasoning = progress_result.get("reasoning", "No reasoning provided")
                    
                    # Post FINISHED message with verifier's reasoning
                    await self._post_message(
                        progress_reasoning,
                        "TOOL",
                        metadata={
                            "toolCallId": verifier_call_id,
                            "toolName": "check_progress",
                            "toolStatus": "FINISHED",
                            "title": f"⚖️ Goal progress is {progress_score*100:.0f}%",
                            "verifierMessage": True
                        }
                    )
                    
                    # If this is a sub-agent, signal parent with progress update AND token usage
                    if self.parent_workflow_id:
                        try:
                            parent_handle = workflow.get_external_workflow_handle(self.parent_workflow_id)
                            await parent_handle.signal("child_progress", {
                                "child_agent_id": self.agent_id,
                                "progress": progress_score,
                                "tokens_in": self.tokens_in,
                                "tokens_out": self.tokens_out,
                                "token_count": self.token_count,
                                "goal": self.goal
                            })
                            workflow.logger.info(
                                f"📊 Sent progress update to parent: {progress_score*100:.1f}%, "
                                f"tokens: {self.token_count}"
                            )
                        except Exception as signal_error:
                            workflow.logger.warning(f"Failed to signal parent progress: {signal_error}")
                    
                    # Calculate context metrics before updating
                    context_text = "\n".join([msg.get('text', '') for msg in self.context])
                    self.context_tokens = estimate_token_count(context_text)
                    
                    # Update agent progress in DB with metrics
                    current_status = "PAUSED" if self.is_paused else "ACTIVE"
                    await workflow.execute_activity(
                        update_agent_status,
                        args=[
                            self.agent_id,
                            current_status,
                            progress_score,
                            f"Iteration {self.iteration_count}: {progress_score*100:.1f}% complete",
                            self.token_count,
                            self.context_tokens,
                            len(self.context),
                            self.tokens_in,
                            self.tokens_out
                        ],
                        start_to_close_timeout=timedelta(seconds=15),
                        retry_policy=RetryPolicy(
                            maximum_attempts=6,
                            backoff_coefficient=4.0,
                            initial_interval=timedelta(seconds=2),
                            maximum_interval=timedelta(seconds=64)
                        )
                    )
                    
                    # 7. If complete, mark finished and exit
                    if progress_score >= 1.0:
                        workflow.logger.info("🎯 Agent reached 100% completion, calling _mark_complete()")
                        await self._mark_complete()
                        workflow.logger.info("✅ _mark_complete() finished successfully")
                        return {"status": "completed", "goal": self.goal}
                    
                    # If not complete, verifier feedback is already in context from the FINISHED message
                    # Agent will continue executing with the feedback
                    workflow.logger.info(f"📋 Verifier returned {progress_score*100:.0f}%, continuing execution")
                
                # 8. Update iteration count and token usage
                self.iteration_count += 1
                
                # Calculate current context token usage
                context_text = "\n".join([msg.get('text', '') for msg in self.context])
                self.context_tokens = estimate_token_count(context_text)
                
                # Calculate threshold based on model's actual context window
                threshold_tokens = int(self.max_context_tokens * CONTEXT_THRESHOLD_PERCENTAGE)
                
                # 9. Continue as new if context is at 80% capacity
                # This keeps the SAME workflow ID but resets event history to prevent unbounded growth
                if self.context_tokens >= threshold_tokens:
                    workflow.logger.info(
                        f"Context threshold reached, compressing and continuing as new: context_tokens={self.context_tokens}, max_context={self.max_context_tokens}, threshold_tokens={threshold_tokens}, usage_percentage={(self.context_tokens / self.max_context_tokens) * 100:.1f}%"
                    )
                    
                    # Use Claude 4.5 Sonnet to extract key learnings
                    learnings = await workflow.execute_activity(
                        compress_context,
                        args=[self.context, self.iteration_count, self.model],
                        start_to_close_timeout=timedelta(seconds=60),
                        retry_policy=RetryPolicy(
                            maximum_attempts=6,
                            backoff_coefficient=4.0,
                            initial_interval=timedelta(seconds=2),
                            maximum_interval=timedelta(seconds=64)
                        )
                    )
                    
                    # Reset context with just a system message containing learnings
                    compressed_context = [{
                        "role": "SYSTEM",
                        "text": learnings,
                        "timestamp": workflow.now().isoformat()
                    }]
                    
                    workflow.logger.info(
                        f"Context compressed: original_size={len(self.context)}, original_tokens={self.context_tokens}, new_size={len(compressed_context)}"
                    )
                    
                    # Continue with same workflow ID, fresh history
                    workflow.continue_as_new(
                        agent_id=self.agent_id,
                        user_id=self.user_id,
                        goal=self.goal,
                        model=self.model,
                        reasoning_effort=self.reasoning_effort,
                        tool_ids=self.tool_ids,
                        verifier=self.verifier,
                        context=compressed_context,
                        parent_workflow_id=self.parent_workflow_id,  # Preserve parent relationship
                        depth=self.depth,  # Preserve depth to prevent sub-agents from spawning
                        # user_phone removed - fetched from user context
                    )
                
                # No sleep between iterations - let the agent work as fast as possible
                
        except Exception as e:
            # Propagate all errors to context - no critical failures
            error_msg = f"Error in iteration {self.iteration_count}: {str(e)}"
            workflow.logger.error(f"{error_msg} for agent_id={agent_id}")
            
            self.context.append({
                "role": "ASSISTANT",
                "text": error_msg,
                "timestamp": workflow.now().isoformat()
            })
            
            await self._post_message(error_msg, "ASSISTANT")
            
            # Continue trying - workflow will restart and retry
            raise
    
    async def _poll_messages(self) -> List[Dict]:
        """Poll for new user messages since last check."""
        try:
            workflow.logger.info(f"🔍 Calling poll_new_messages: agent_id={self.agent_id}, last_message_check={self.last_message_check}")
            messages = await workflow.execute_activity(
                poll_new_messages,
                args=[self.agent_id, self.last_message_check],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64)
                )
            )
            
            self.last_message_check = workflow.now()
            
            return messages
            
        except Exception as e:
            workflow.logger.error(f"Failed to poll messages: {str(e)}")
            # Return empty list on error - will try again next iteration
            return []
    
    async def _post_message(self, text: str, role: str = "ASSISTANT", metadata: Optional[Dict] = None) -> None:
        """Post a message from the agent with optional metadata."""
        try:
            workflow.logger.info(f"🔍 Calling post_agent_message: agent_id={self.agent_id}, role={role}, text_preview={text[:50] if len(text) > 50 else text}, has_metadata={metadata is not None}")
            await workflow.execute_activity(
                post_agent_message,
                args=[self.agent_id, text, role, metadata],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64)
                )
            )
            
            # Add to local context too (include metadata for LLM formatting)
            context_entry = {
                "role": role,
                "text": text,
                "timestamp": workflow.now().isoformat()
            }
            if metadata:
                context_entry["metadata"] = metadata
            self.context.append(context_entry)
            
        except Exception as e:
            workflow.logger.error(f"Failed to post message: {str(e)}")
            # Non-fatal - continue
    
    async def _handle_tool_event(self, event: ToolEvent, tool_call_id: str, tool_name: str) -> None:
        """
        Handle a single event from a tool.
        
        This is the core event handler for the new event-driven tool system.
        Called for each event yielded by tool managers.
        """
        if event.type == EventType.POST_MESSAGE:
            # Post message to UI and add to context
            metadata = {
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "title": event.title,
            }
            # Include status if provided (IN_PROGRESS, FINISHED, ERROR)
            if event.status:
                metadata["toolStatus"] = event.status.value
                # Frontend expects 'error' flag for ERROR status messages
                if event.status == MessageStatus.ERROR:
                    metadata["error"] = True
            
            # Include structured data if provided (e.g., plan artifacts)
            if event.data:
                metadata["data"] = event.data
            
            # Merge in any additional metadata from the event
            if event.metadata:
                metadata.update(event.metadata)
            
            await self._post_message(
                event.message or "",
                "TOOL",
                metadata=metadata
            )
        
        elif event.type == EventType.USAGE:
            # Save tool usage to database
            if event.usage_items:
                try:
                    usage_items_dicts = [item.to_dict() for item in event.usage_items]
                    await workflow.execute_activity(
                        save_tool_usage,
                        args=[self.agent_id, self.user_id, event.tool_name or tool_name, usage_items_dicts],
                        start_to_close_timeout=timedelta(seconds=10),
                        retry_policy=RetryPolicy(
                            maximum_attempts=3,
                            backoff_coefficient=2.0,
                            initial_interval=timedelta(seconds=1),
                            maximum_interval=timedelta(seconds=10)
                        )
                    )
                except Exception as e:
                    workflow.logger.error(f"Failed to save tool usage: {str(e)}")
                    # Don't fail the workflow if usage tracking fails
        
        elif event.type == EventType.ADD_TO_CONTEXT:
            # Add message to context (no UI posting)
            context_entry = {
                "role": event.role or "SYSTEM",
                "text": event.text or "",
                "timestamp": workflow.now().isoformat()
            }
            if event.metadata:
                context_entry["metadata"] = event.metadata
            self.context.append(context_entry)
        
        elif event.type == EventType.WAIT_FOR_SIGNAL:
            # Wait for a signal (e.g., user response)
            if event.signal_key:
                # For now, just log - specific tools like send_message_to_user
                # will handle their own wait logic
                workflow.logger.info(f"Tool waiting for signal: {event.signal_key}")
        
        else:
            workflow.logger.warning(f"Unknown event type: {event.type}")
    
    
    async def _decide_next_action(self) -> Dict:
        """
        Decide next action based on goal, context, and current phase using LLM.
        
        Simplified 2-Phase Flow: PLAN → EXECUTE
        
        Phase is detected statelessly from user messages:
        - If any USER message contains "execute" → EXECUTE phase
        - Otherwise → PLAN phase
        
        First call (is_first_call=True): No tools, FAST model
        PLAN phase: Read-only tools + plan-only tools (set_plan, progress_to_execute_phase)
        EXECUTE phase: All tools except plan-only tools (which disappear)
        
        Returns:
            Dict with 'tool', 'args', 'reasoning'
        """
        # Detect phase statelessly from user messages
        phase = detect_phase_from_context(self.context)
        workflow.logger.info(f"Deciding next action (phase={phase}, is_first_call={self.is_first_call})")
        
        try:
            # Get phase-specific tools and model preference
            phase_config = get_phase_tools_and_config(
                phase=phase,
                all_tools=self.tools,
                is_first_call=self.is_first_call,
            )
            
            enabled_tools = phase_config["enabled_tools"]
            enabled_tool_names = phase_config["enabled_tool_names"]
            disabled_tools = phase_config["disabled_tools"]
            model_preference = phase_config["model_preference"]
            
            # Filter browser sub-actions from LLM context
            # Browser sub-actions have browser_url metadata and should not be seen by LLM
            filtered_context = [
                msg for msg in self.context
                if not (msg.get("metadata") and msg["metadata"].get("browser_url"))
            ]
            
            workflow.logger.info(
                f"Phase routing: phase={phase}, enabled={len(enabled_tools)}, disabled={len(disabled_tools)}, model_pref={model_preference}"
            )
            
            action = await workflow.execute_activity(
                decide_next_action,
                args=[
                    filtered_context,
                    enabled_tools,
                    enabled_tool_names,
                    disabled_tools,
                    self.iteration_count,
                    self.model,
                    self.reasoning_effort,
                    self.user_id,
                    phase,
                    model_preference
                ],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64)
                )
            )
            
            tool_calls_count = len(action.get('tool_calls', []))
            workflow.logger.info(f"LLM decided: {tool_calls_count} tools - {action.get('reasoning')[:100]}")
            return action
            
        except Exception as e:
            error_msg = f"Failed to decide action: {type(e).__name__}: {str(e)}"
            import traceback
            workflow.logger.error(f"{error_msg}\n{traceback.format_exc()}")
            # Fallback: return empty reasoning and no tools, with empty usage
            return {
                "reasoning": f"Decision failed: {error_msg}, will retry",
                "tool_calls": [],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
            }
    
    async def _check_progress(self) -> Dict[str, Any]:
        """
        Check progress toward goal using LLM verifier.
        
        Returns:
            Dict with 'score' (float 0.0-1.0) and 'reasoning' (str)
        """
        phase = detect_phase_from_context(self.context)
        workflow.logger.info(f"🔍 Calling check_progress: phase={phase}, context_len={len(self.context)}, verifier_prompt={self.verifier['llmJudgePrompt'][:50]}, model={self.model}")
        
        try:
            # Filter browser sub-actions from context (same as decide_next_action)
            filtered_context = [
                msg for msg in self.context
                if not (msg.get("metadata") and msg["metadata"].get("browser_url"))
            ]
            
            result = await workflow.execute_activity(
                check_progress,
                args=[filtered_context, self.verifier["llmJudgePrompt"], self.model, phase],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64)
                )
            )
            
            workflow.logger.info(f"Progress: {result['score'] * 100:.1f}%")
            return result
            
        except Exception as e:
            workflow.logger.error(f"Failed to check progress: {str(e)}")
            # Return 0.5 on error to keep agent running
            return {"score": 0.5, "reasoning": f"Error checking progress: {str(e)}"}
    
    async def _mark_complete(self) -> None:
        """Mark the task as complete, save blueprint, and signal parent if sub-agent."""
        workflow.logger.info(f"Marking task as complete: parent_workflow_id={self.parent_workflow_id}, depth={self.depth}")
        activity_id = workflow.uuid4()

        try:
            # Include all messages in blueprint (USER, ASSISTANT, TOOL, SYSTEM)
            steps = self.context
            
            # Generate completion summary for ALL agents (before blueprint so it's included)
            workflow.logger.info("📝 Generating completion summary")
            summary_result = await workflow.execute_activity(
                generate_completion_summary,
                args=[self.context, self.goal, self.model],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=16)
                )
            )
            summary = summary_result.get("summary", "")
            
            # Track tokens from summary generation LLM call
            summary_usage = summary_result.get("usage", {})
            
            async with self._state_lock:
                self.tokens_in += summary_usage.get("prompt_tokens", 0)
                self.tokens_out += summary_usage.get("completion_tokens", 0)
                self.token_count += summary_usage.get("total_tokens", 0)
            
            workflow.logger.info(
                f"Summary generated: summary_length={len(summary)}, tokens_used={summary_usage.get('total_tokens', 0)}"
            )
            
            # Post summary as ASSISTANT message to agent's own context
            if summary:
                await self._post_message(
                    summary,
                    "ASSISTANT",
                    metadata={"isFinalSummary": True}
                )
                workflow.logger.info("Posted final summary to agent context")
            
            # Save blueprint (using new event-driven system)
            # Note: save_blueprint handles messages and returns result with usage data
            blueprint_result = await save_blueprint(self, self.user_id, steps)
            
            # Track tokens from blueprint compression LLM call
            blueprint_usage = blueprint_result.get("usage", {})
            
            async with self._state_lock:
                self.tokens_in += blueprint_usage.get("prompt_tokens", 0)
                self.tokens_out += blueprint_usage.get("completion_tokens", 0)
                self.token_count += blueprint_usage.get("total_tokens", 0)
            
            workflow.logger.info(
                f"Blueprint extracted and saved: tokens_used={blueprint_usage.get('total_tokens', 0)}"
            )
            
            # Mark as finished in the database (with updated token counts including summary)
            # Note: summary is already generated above before blueprint saving
            finish_result = await workflow.execute_activity(
                mark_finished,
                args=[
                    self.agent_id,
                    steps,
                    self.token_count,
                    self.context_tokens,
                    len(self.context),
                    self.tokens_in,
                    self.tokens_out,
                    summary if self.parent_workflow_id else ""  # Pass summary only for sub-agents
                ],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64)
                )
            )
            
        except Exception as e:
            error_msg = f"Failed to mark complete: {str(e)}"
            workflow.logger.error(error_msg)
            await self._post_message(error_msg, "ASSISTANT")
            raise

        # Signal parent if this is a sub-agent
        if self.parent_workflow_id:
            try:
                parent_handle = workflow.get_external_workflow_handle(self.parent_workflow_id)
                # Signal takes signal_name and a single argument (dict with multiple values)
                await parent_handle.signal("child_completed", {
                    "child_agent_id": self.agent_id,
                    "result": {
                        "status": "completed",
                        "goal": self.goal,
                        "summary": finish_result.get("summary", "")  # Include summary
                    }
                })
                workflow.logger.info(
                    f"📤 Signaled parent completion: parent_id={self.parent_workflow_id[:8]}, has_summary={bool(finish_result.get('summary'))}"
                )
            except Exception as signal_error:
                workflow.logger.warning(f"Failed to signal parent completion: {signal_error}")
        
    
    @workflow.query
    def get_status(self) -> Dict:
        """Query the current status."""
        return {
            "agent_id": self.agent_id,
            "goal": self.goal,
            "iteration": self.iteration_count,
            "context_size": len(self.context),
        }
