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
    # User-configurable tools
    from tools import (
        web_search,
        web_search_pre,
        web_search_post,
        deep_research,
        deep_research_pre,
        deep_research_post,
        buy_item_from_amazon,
        buy_item_from_amazon_pre,
        buy_item_from_amazon_post,
    )
    from tools.request_user_attention import (
        request_user_attention,
        format_pre_message as request_user_attention_pre,
        format_post_message as request_user_attention_post,
    )
    # Sub-agent spawning
    from tools.spawn_sub_agents import spawn_sub_agents
    # Tool formatters
    from tools.wait_seconds import (
        format_pre_message as wait_seconds_pre,
        format_post_message as wait_seconds_post,
    )
    from tools.spawn_sub_agents_formatters import (
        format_pre_message as spawn_sub_agents_pre,
        format_post_message as spawn_sub_agents_post,
    )
    # Activity formatters
    from helpers.formatters import (
        format_query_blueprints_pre,
        format_query_blueprints_post,
        format_save_blueprint_pre,
        format_save_blueprint_post,
    )
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
        query_blueprints,
        save_blueprint,
        mark_finished,
        fetch_agent_config,
    )

logger = structlog.get_logger()


# Trigger continue_as_new at 80% context usage
CONTEXT_THRESHOLD_PERCENTAGE = 0.8

# Tool formatter registry (maps tool names to their formatters)
TOOL_FORMATTERS = {
    "wait_seconds": {
        "pre": wait_seconds_pre,
        "post": wait_seconds_post
    },
    "spawn_sub_agents": {
        "pre": spawn_sub_agents_pre,
        "post": spawn_sub_agents_post
    },
    "web_search": {
        "pre": web_search_pre,
        "post": web_search_post
    },
    "deep_research": {
        "pre": deep_research_pre,
        "post": deep_research_post
    },
    "buy_item_from_amazon": {
        "pre": buy_item_from_amazon_pre,
        "post": buy_item_from_amazon_post
    },
    "request_user_attention": {
        "pre": request_user_attention_pre,
        "post": request_user_attention_post
    }
}

# Activity formatter registry (for workflow activities that aren't tools)
ACTIVITY_FORMATTERS = {
    "query_blueprints": {
        "pre": format_query_blueprints_pre,
        "post": format_query_blueprints_post
    },
    "save_blueprint": {
        "pre": format_save_blueprint_pre,
        "post": format_save_blueprint_post
    }
}

# System tools that are always available (don't need to be in DB)
SYSTEM_TOOLS = [
    {
        "id": "system-wait-seconds",
        "name": "wait_seconds",
        "description": "Pause execution for a specified number of seconds (1-3600). Use this when you need to wait for time-dependent results or real-world delays."
    },
    {
        "id": "system-spawn-sub-agents",
        "name": "spawn_sub_agents",
        "description": "Spawn multiple sub-agents to work on parallel subtasks concurrently. Each sub-agent runs independently with its own goal, model, tools, and verifier. Provide a list of sub-agent configs with: goal (required), model (optional), reasoning_effort (optional), tool_ids (optional), and verifier (required with type and llm_judge_prompt). The parent agent will wait for all sub-agents to complete before continuing. NOTE: Maximum nesting depth is 1 - sub-agents cannot spawn their own sub-agents."
    },
    {
        "id": "system-request-user-attention",
        "name": "request_user_attention",
        "description": "Ask the User a direct question when you need clarification, preferences, decisions, or information that only they can provide. Do NOT use this for factual information that can be found via web_search or other tools - only use when the User's personal input is required."
    },
]


def estimate_token_count(text: str) -> int:
    """
    Rough token estimation: ~4 chars per token for English text.
    This is conservative and works across most tokenizers.
    """
    return len(text) // 4


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
        Posts the response as a USER message which unblocks the workflow.
        
        Args:
            response: The user's response text
        """
        workflow.logger.info("💬 Received user response", response_length=len(response))
        
        # Post the user's response as a USER message
        # _post_message will also add it to self.context with the correct format
        await self._post_message(
            response,
            "USER",
            metadata=None
        )
    
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
        title = f"Sub-agent working: {goal_text}"
        
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
                "Child result added to context",
                child_id=child_agent_id[:8],
                summary_length=len(summary) if summary else 0
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
        self.goal = goal
        self.model = model
        self.reasoning_effort = reasoning_effort
        self.tool_ids = tool_ids
        self.verifier = verifier
        self.parent_workflow_id = parent_workflow_id  # Store parent ID for signaling
        self.depth = depth  # Store nesting depth
        self.context = context or []
        
        # Initialize last message check time to 1 hour ago so we fetch the goal message
        # (must use workflow.now() for determinism)
        
        workflow.logger.info(
            f"Agent iteration {self.iteration_count}",
            agent_id=agent_id,
            goal=goal,
            model=model,
            tools=tool_ids
        )
        
        # Fetch model's context window and tools from backend (only on first iteration)
        if self.max_context_tokens is None:
            try:
                workflow.logger.info("🔍 Calling get_model_context_window", model=model)
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
                    "Model context window fetched",
                    model=model,
                    max_context_tokens=self.max_context_tokens
                )
            except Exception as e:
                # Fallback to safe default if fetch fails
                self.max_context_tokens = 100_000
                workflow.logger.warning(
                    f"Failed to fetch context window, using default: {str(e)}",
                    default=self.max_context_tokens
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
                workflow.logger.info("🔍 Calling fetch_agent_tools", agent_id=agent_id)
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
                    "Agent tools fetched",
                    system_tools=len(system_tools),
                    db_tools=len(db_tools),
                    total_tools=len(self.tools),
                    is_sub_agent=is_sub_agent
                )
            except Exception as e:
                workflow.logger.error(
                    f"Failed to fetch agent tools: {str(e)}"
                )
                # Fall back to just filtered system tools
                self.tools = system_tools
        
        # Update status to ACTIVE
        try:
            workflow.logger.info("🔍 Calling update_agent_status (initial)", agent_id=agent_id, status="ACTIVE", progress=0.0, msg_count=len(self.context))
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
                # Poll config at start of each iteration (syncs pause state, model, tools)
                try:
                    config = await workflow.execute_activity(
                        fetch_agent_config,
                        args=[agent_id],
                        start_to_close_timeout=timedelta(seconds=30),
                        retry_policy=RetryPolicy(maximum_attempts=3)
                    )
                    was_paused = self.is_paused
                    self.is_paused = (config['status'] == 'PAUSED')
                    
                    if was_paused != self.is_paused:
                        workflow.logger.info(f"⏸️  Pause state changed from DB: {was_paused} -> {self.is_paused}")
                    
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
                                "✅ Tools updated",
                                system_tools=len(system_tools),
                                db_tools=len(db_tools),
                                total_tools=len(self.tools)
                            )
                        except Exception as e:
                            workflow.logger.error(
                                f"⚠️ Failed to refetch tools: {str(e)}, keeping existing tools"
                            )
                except Exception as e:
                    workflow.logger.warning(f"Failed to fetch config: {str(e)}")
                
                # Green-light check: wait if paused (with timeout to re-check DB)
                if self.is_paused:
                    workflow.logger.info("⏸️  Agent is PAUSED, waiting for resume...")
                
                try:
                    await workflow.wait_condition(
                        lambda: not self.is_paused,
                        timeout=timedelta(seconds=30)
                    )
                    
                    if self.is_paused:
                        # Still paused after timeout, will loop back
                        workflow.logger.info("⏸️  Still paused after 30s, re-checking config...")
                    else:
                        workflow.logger.info("▶️  Agent resumed, continuing execution")
                except (asyncio.TimeoutError, TemporalTimeoutError):
                    # Timeout = still paused, loop back to re-poll config
                    workflow.logger.info("⏸️  Timeout while paused, re-checking config...")
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

                # 2. Query blueprints on first iteration
                if self.iteration_count == 0:
                    blueprints = await self._query_blueprints()
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
                
                # 5. Execute all tools sequentially
                for tool_call in tool_calls:
                    tool_name = tool_call.get("tool", "unknown")
                    args = tool_call.get("args", [])
                    
                    # Use the pre-generated ID from step 4
                    tool_call_id = tool_call['tool_call_id']
                    
                    try:
                        # Get tool formatter (or use defaults)
                        formatter = TOOL_FORMATTERS.get(tool_name, {})
                        
                        # Format and post pre-execution message (IN_PROGRESS)
                        if formatter.get("pre"):
                            pre_msg = formatter["pre"](tool_call)
                        else:
                            # Default formatting for tools without custom formatter
                            pre_msg = {"title": f"Executing {tool_name}", "message": f"params: {tool_call}"}
                        
                        # Ensure message is not empty (backend validation requires at least 1 character)
                        message_content = pre_msg.get('message', '').strip()
                        
                        await self._post_message(
                            message_content,
                            "TOOL",
                            metadata={
                                "toolCallId": tool_call_id,
                                "toolName": tool_name,
                                "toolStatus": "IN_PROGRESS",
                                "title": pre_msg['title']
                            }
                        )
                        
                        # Execute tool (blocking)
                        result = await self._execute_tool(tool_call, tool_call_id)
                        
                        # Format and post post-execution message (FINISHED)
                        # Skip for spawn_sub_agents - it posts its own summary message before waiting
                        if tool_name != "spawn_sub_agents":
                            if formatter.get("post"):
                                post_msg = formatter["post"](tool_call, result)
                            else:
                                # Default formatting
                                post_msg = {"title": f"Completed {tool_name}", "message": str(result)}
                            
                            # Ensure message is not empty (backend validation requires at least 1 character)
                            message_content = post_msg.get('message', '').strip()
                            
                            await self._post_message(
                                message_content,
                                "TOOL",
                                metadata={
                                    "toolCallId": tool_call_id,
                                    "toolName": tool_name,
                                    "toolStatus": "FINISHED",
                                    "title": post_msg['title']
                                }
                            )
                        
                    except Exception as e:
                        # Post error and add to context so agent can see what failed
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
                
                # 6. Check progress with verifier and update DB
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
                        "title": "⚖️ Calculating progress towards Goal",
                        "verifierMessage": True
                    }
                )
                
                progress_result = await self._check_progress()
                # Track tokens from verifier LLM call (usage is always present)
                verifier_usage = progress_result["usage"]
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
                # Use current pause state, not hardcoded status
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
                        "Context threshold reached, compressing and continuing as new",
                        context_tokens=self.context_tokens,
                        max_context=self.max_context_tokens,
                        threshold_tokens=threshold_tokens,
                        usage_percentage=f"{(self.context_tokens / self.max_context_tokens) * 100:.1f}%"
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
                        "Context compressed",
                        original_size=len(self.context),
                        original_tokens=self.context_tokens,
                        new_size=len(compressed_context)
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
                        depth=self.depth  # Preserve depth to prevent sub-agents from spawning
                    )
                
                # No sleep between iterations - let the agent work as fast as possible
                
        except Exception as e:
            # Propagate all errors to context - no critical failures
            error_msg = f"Error in iteration {self.iteration_count}: {str(e)}"
            workflow.logger.error(f"{error_msg} (agent_id={agent_id})")
            
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
            workflow.logger.info("🔍 Calling poll_new_messages", 
                agent_id=self.agent_id, 
                last_message_check=self.last_message_check
            )
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
            workflow.logger.info("🔍 Calling post_agent_message", 
                agent_id=self.agent_id, 
                role=role, 
                text_preview=text[:50] if len(text) > 50 else text,
                has_metadata=metadata is not None
            )
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
    
    
    async def _query_blueprints(self) -> List[Dict]:
        """Query knowledge base for similar goals."""
        activity_id = workflow.uuid4()
        
        try:
            # Get formatter
            formatter = ACTIVITY_FORMATTERS.get("query_blueprints", {})
            
            # Post pre-execution message
            pre_msg = formatter["pre"]([])
            await self._post_message(
                pre_msg.get('message', ''),
                "TOOL",
                metadata={
                    "toolCallId": activity_id,
                    "toolName": "query_blueprints",
                    "toolStatus": "IN_PROGRESS",
                    "title": pre_msg['title']
                }
            )
            
            workflow.logger.info("🔍 Calling query_blueprints", 
                context_type=type(self.context).__name__, 
                context_len=len(self.context),
                user_id=self.user_id,
                limit=3
            )
            
            blueprints = await workflow.execute_activity(
                query_blueprints,
                args=[self.context, self.user_id, 3],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64)
                )
            )
            
            workflow.logger.info(f"Found {len(blueprints)} blueprints")
            
            # Post post-execution message
            post_msg = formatter["post"]([], blueprints)
            await self._post_message(
                post_msg.get('message', ''),
                "TOOL",
                metadata={
                    "toolCallId": activity_id,
                    "toolName": "query_blueprints",
                    "toolStatus": "FINISHED",
                    "title": post_msg['title']
                }
            )
            
            return blueprints
            
        except Exception as e:
            workflow.logger.error(f"Failed to query blueprints: {str(e)}")
            # Post error message
            await self._post_message(
                f"Failed to query blueprints: {str(e)}",
                "TOOL",
                metadata={
                    "toolCallId": activity_id,
                    "toolName": "query_blueprints",
                    "toolStatus": "FINISHED",
                    "title": "Error",
                    "error": True
                }
            )
            return []
    
    async def _decide_next_action(self) -> Dict:
        """
        Decide next action based on goal and context using LLM.
        
        Returns:
            Dict with 'tool', 'args', 'reasoning'
        """
        workflow.logger.info("Deciding next action")
        
        try:
            # Extract tool names from tools list
            tool_names = [tool["name"] for tool in self.tools]
            
            action = await workflow.execute_activity(
                decide_next_action,
                args=[self.context, self.tools, tool_names, self.iteration_count, self.model, self.reasoning_effort],
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
            workflow.logger.error(error_msg, exc_info=True)
            # Fallback: return empty reasoning and no tools, with empty usage
            return {
                "reasoning": f"Decision failed: {error_msg}, will retry",
                "tool_calls": [],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
            }
    
    async def _execute_tool(self, tool_call: Dict, tool_call_id: str = None) -> Any:
        """
        Execute a single tool call. Returns result (dict for activities, str for system tools).
        Does NOT post messages - main loop handles all posting.
        Exception: spawn_sub_agents posts its summary message before waiting.
        """
        tool = tool_call.get("tool")
        args = tool_call.get("args", [])
        
        workflow.logger.info(f"Executing tool: {tool}")
        
        # Special handling for wait_seconds: it's not an activity, just workflow.sleep()
        if tool == "wait_seconds":
            try:
                # Get seconds from tool_call dict (new Pydantic model format)
                seconds = tool_call.get("seconds", 1)
                
                # Validate range
                if seconds < 1 or seconds > 3600:
                    raise ValueError(f"Wait time must be between 1 and 3600 seconds, got {seconds}")
                
                workflow.logger.info(f"Waiting {seconds} seconds")
                await workflow.sleep(seconds)
                
                # Return simple result (formatter will handle the message)
                return f"completed"
                
            except (ValueError, TypeError) as e:
                raise ValueError(f"Invalid wait time: {str(e)}")
        
        # Special handling for spawn_sub_agents: spawn + wait for signal-based completion
        if tool == "spawn_sub_agents":
            try:
                # Check depth limit (max 2 levels: 0=parent, 1=child, 2=not allowed)
                MAX_DEPTH = 1  # Sub-agents can't create sub-agents
                if self.depth >= MAX_DEPTH:
                    raise ValueError(
                        f"Cannot spawn sub-agents: maximum nesting depth ({MAX_DEPTH}) reached. "
                        f"Sub-agents cannot create their own sub-agents."
                    )
                
                # Get sub_agents from tool_call dict (new Pydantic model format)
                sub_agents = tool_call.get("sub_agents", [])
                
                if not sub_agents or not isinstance(sub_agents, list):
                    raise ValueError("spawn_sub_agents requires a list of sub-agent configs")
                
                # Inherit parent model if not specified for each sub-agent
                for sub_agent in sub_agents:
                    if "model" not in sub_agent:
                        sub_agent["model"] = self.model
                    if "reasoning_effort" not in sub_agent:
                        sub_agent["reasoning_effort"] = self.reasoning_effort
                
                workflow.logger.info(f"🚀 Spawning {len(sub_agents)} sub-agents at depth {self.depth+1} (model: {self.model})")
                
                # Get parent workflow ID (this workflow)
                parent_workflow_id = workflow.info().workflow_id
                
                # Calculate child depth
                child_depth = self.depth + 1
                
                # Step 1: Spawn all children via activity, passing parent agent ID, workflow ID, depth, and pause state
                spawned = await workflow.execute_activity(
                    spawn_sub_agents,
                    args=[self.user_id, sub_agents, self.agent_id, parent_workflow_id, child_depth, self.is_paused],
                    start_to_close_timeout=timedelta(seconds=60),
                    retry_policy=RetryPolicy(
                        maximum_attempts=3,
                        backoff_coefficient=2.0,
                        initial_interval=timedelta(seconds=1),
                        maximum_interval=timedelta(seconds=10)
                    )
                )
                
                workflow.logger.info(f"✅ Spawned {len(spawned)} sub-agents, waiting for signals...")
                
                # Step 2: Track children and create tool_call_id mapping
                for i, child_info in enumerate(spawned):
                    if "error" not in child_info:
                        # Generate unique tool call ID for this sub-agent
                        child_tool_id = workflow.uuid4()
                        child_agent_id = child_info["agent_id"]
                        
                        # Store mapping: agent_id -> tool_call_id
                        self.child_tool_ids[child_agent_id] = child_tool_id
                        self.pending_children.add(child_agent_id)
                        
                        # Post initial IN_PROGRESS message with metadata
                        await self._post_message(
                            child_info['goal'],
                            "TOOL",
                            metadata={
                                "toolCallId": child_tool_id,
                                "toolName": "spawn_sub_agents",
                                "toolStatus": "IN_PROGRESS",
                                "title": "Sub-agent starting",
                                "subAgentId": child_agent_id,
                                "progress": 0.0
                            }
                        )
                
                # Step 2.5: Post the spawn_sub_agents post message (agents spawned summary)
                # This happens BEFORE waiting, so user sees "agents spawned" immediately
                if tool_call_id:
                    # Post a simple "agents spawned" message
                    await self._post_message(
                        "",
                        "TOOL",
                        metadata={
                            "toolCallId": tool_call_id,
                            "toolName": "spawn_sub_agents",
                            "toolStatus": "FINISHED",  # Still in progress (waiting for children)
                            "title": f"⭐ Spawned {len(spawned)} sub-agent{'s' if len(spawned) != 1 else ''}"
                        }
                    )
                
                # Step 3: Wait for all children to signal completion
                # Using workflow.wait_condition (Temporal primitive - parent goes dormant)
                workflow.logger.info(f"⏳ Waiting for {len(self.pending_children)} sub-agents to complete (via signals)...")
                
                await workflow.wait_condition(
                    lambda: len(self.pending_children) == 0
                    # No timeout - can wait indefinitely (months/years)
                )
                
                workflow.logger.info(f"🎉 All {len(spawned)} sub-agents completed!")
                
                # Return summary (detailed results already posted via signals)
                return {
                    "spawned": len(spawned),
                    "completed": len(spawned) - len(self.pending_children),
                    "message": "All sub-agents completed. Check individual results above."
                }
                
            except Exception as e:
                raise ValueError(f"spawn_sub_agents failed: {str(e)}")
        
        # Special handling for request_user_attention: create request + wait for signal
        if tool == "request_user_attention":
            try:
                # Get question and context from tool_call dict
                question = tool_call.get("question", "")
                context = tool_call.get("context")
                
                if not question:
                    raise ValueError("request_user_attention requires a question")
                
                workflow.logger.info(f"🔔 Requesting user attention: {question[:100]}")
                
                # Call the workflow function (handles activity + wait_condition internally)
                # This will create the attention request and wait for the signal
                result = await request_user_attention(question, context)
                
                workflow.logger.info(f"✓ User response received, continuing workflow")
                
                # Return result for formatter (signal already posted the message)
                return result
                
            except Exception as e:
                raise ValueError(f"request_user_attention failed: {str(e)}")
        
        # Map tool to activity (for all non-system tools)
        activity_map = {
            "web_search": web_search,
            "deep_research": deep_research,
            "buy_item_from_amazon": buy_item_from_amazon,
        }
        
        activity_fn = activity_map.get(tool)
        if not activity_fn:
            raise ValueError(f"Unknown tool: {tool}")
        
        # Check if tool is available
        available_tool_names = [t['name'] for t in self.tools]
        if tool not in available_tool_names:
            raise ValueError(f"Tool not available: {tool}")
        
        # Extract arguments from tool_call dict based on tool type
        # Each tool has its own Pydantic model with specific fields
        if tool == "web_search":
            activity_args = [tool_call.get("query")]
        elif tool == "deep_research":
            # Pass query and max_tokens (with default if not provided)
            activity_args = [tool_call.get("query"), tool_call.get("max_tokens", 4000)]
        elif tool == "buy_item_from_amazon":
            # Pass item_search_query and item_qualifications
            activity_args = [
                tool_call.get("item_search_query"),
                tool_call.get("item_qualifications"),
            ]
        else:
            # Fallback to args if present (for backward compatibility)
            activity_args = args
        
        # Execute with extreme backoff
        result = await workflow.execute_activity(
            activity_fn,
            args=activity_args,
            start_to_close_timeout=timedelta(minutes=5),
            heartbeat_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(
                maximum_attempts=6,
                backoff_coefficient=4.0,
                initial_interval=timedelta(seconds=2),
                maximum_interval=timedelta(seconds=64)
            )
        )
        
        return result
    
    async def _check_progress(self) -> Dict[str, Any]:
        """
        Check progress toward goal using LLM verifier.
        
        Returns:
            Dict with 'score' (float 0.0-1.0) and 'reasoning' (str)
        """
        workflow.logger.info("🔍 Calling check_progress", 
            context_type=type(self.context).__name__,
            context_len=len(self.context),
            verifier_prompt=self.verifier["llmJudgePrompt"][:50],
            model=self.model
        )
        
        try:
            result = await workflow.execute_activity(
                check_progress,
                args=[self.context, self.verifier["llmJudgePrompt"], self.model],
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
        workflow.logger.info("Marking task as complete", parent_workflow_id=self.parent_workflow_id, depth=self.depth)
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
            self.tokens_in += summary_usage.get("prompt_tokens", 0)
            self.tokens_out += summary_usage.get("completion_tokens", 0)
            self.token_count += summary_usage.get("total_tokens", 0)
            
            workflow.logger.info(
                "Summary generated",
                summary_length=len(summary),
                tokens_used=summary_usage.get("total_tokens", 0)
            )
            
            # Post summary as ASSISTANT message to agent's own context
            if summary:
                await self._post_message(
                    summary,
                    "ASSISTANT",
                    metadata={"isFinalSummary": True}
                )
                workflow.logger.info("Posted final summary to agent context")
            
            # Get formatter
            formatter = ACTIVITY_FORMATTERS.get("save_blueprint", {})
            
            # Post pre-execution message
            pre_msg = formatter["pre"]([])
            await self._post_message(
                pre_msg.get('message', ''),
                "TOOL",
                metadata={
                    "toolCallId": activity_id,
                    "toolName": "save_blueprint",
                    "toolStatus": "IN_PROGRESS",
                    "title": pre_msg['title']
                }
            )
            
            # Save blueprint (uses LLM to compress message history)
            blueprint_result = await workflow.execute_activity(
                save_blueprint,
                args=[self.user_id, steps],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64)
                )
            )
            
            # Track tokens from blueprint compression LLM call
            blueprint_usage = blueprint_result.get("usage", {})
            self.tokens_in += blueprint_usage.get("prompt_tokens", 0)
            self.tokens_out += blueprint_usage.get("completion_tokens", 0)
            self.token_count += blueprint_usage.get("total_tokens", 0)
            
            workflow.logger.info(
                "Blueprint extracted and saved",
                tokens_used=blueprint_usage.get("total_tokens", 0)
            )
            
            # Post post-execution message
            post_msg = formatter["post"]([], blueprint_result)
            await self._post_message(
                post_msg.get('message', ''),
                "TOOL",
                metadata={
                    "toolCallId": activity_id,
                    "toolName": "save_blueprint",
                    "toolStatus": "FINISHED",
                    "title": post_msg['title']
                }
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
                    "📤 Signaled parent completion", 
                    parent_id=self.parent_workflow_id[:8],
                    has_summary=bool(finish_result.get("summary"))
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
