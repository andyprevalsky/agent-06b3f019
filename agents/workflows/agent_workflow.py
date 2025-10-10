"""Main agent workflow for executing autonomous tasks."""

from datetime import timedelta, datetime
from typing import Dict, List, Optional, Any
from temporalio import workflow
from temporalio.common import RetryPolicy
import structlog

with workflow.unsafe.imports_passed_through():
    # User-configurable tools
    from tools import (
        send_sms,
        list_contacts,
        web_search,
        accomplish_web_task,
    )
    # Helper activities (workflow orchestration, not exposed to LLM)
    from helpers import (
        poll_new_messages,
        post_agent_message,
        decide_next_action,
        check_progress,
        update_agent_status,
        compress_context,
        get_model_context_window,
        fetch_agent_tools,
        query_blueprints,
        save_blueprint,
        mark_finished,
    )

logger = structlog.get_logger()


# Trigger continue_as_new at 80% context usage
CONTEXT_THRESHOLD_PERCENTAGE = 0.8

# System tools that are always available (don't need to be in DB)
SYSTEM_TOOLS = [
    {
        "name": "post_message",
        "description": "Post a message to the user. Use this to communicate progress, results, or any information. Takes one argument: the message text."
    },
    {
        "name": "wait_seconds",
        "description": "Pause execution for a specified number of seconds (1-3600). Use this when you need to wait for time-dependent results or real-world delays."
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
        self.tool_ids: List[str] = []
        self.tools: List[Dict[str, str]] = []  # Tools with descriptions from DB
        self.verifier: Optional[Dict] = None
        self.context: List[Dict] = []
        self.last_message_check: Optional[datetime] = None
        self.iteration_count: int = 0
        self.context_tokens: int = 0
        self.max_context_tokens: Optional[int] = None  # Fetched from OpenRouter
        
    @workflow.run
    async def run(
        self,
        agent_id: str,
        user_id: str,
        goal: str,
        model: str,
        tool_ids: List[str],
        verifier: Dict,
        context: Optional[List[Dict]] = None,
    ) -> Dict:
        """
        Execute an autonomous agent task.
        
        Args:
            agent_id: Unique agent ID
            user_id: User ID who owns this agent
            goal: What the agent should accomplish
            model: LLM model to use for reasoning (e.g., anthropic/claude-sonnet-4.5)
            tool_ids: List of tool IDs available to this agent
            verifier: Verification config (type: FLOAT_LLM_JUDGE, llmJudgePrompt: str)
            context: Message history
            
        Returns:
            Task completion details or continues as new
        """
        self.agent_id = agent_id
        self.user_id = user_id
        self.goal = goal
        self.model = model
        self.tool_ids = tool_ids
        self.verifier = verifier
        self.context = context or []
        
        # Initialize last message check time (must use workflow.now() for determinism)
        if self.last_message_check is None:
            self.last_message_check = workflow.now()
        
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
                
                # Merge system tools (always available) with user's assigned tools
                self.tools = SYSTEM_TOOLS + db_tools
                
                workflow.logger.info(
                    "Agent tools fetched",
                    system_tools=len(SYSTEM_TOOLS),
                    db_tools=len(db_tools),
                    total_tools=len(self.tools)
                )
            except Exception as e:
                workflow.logger.error(
                    f"Failed to fetch agent tools: {str(e)}"
                )
                # Fall back to just system tools
                self.tools = SYSTEM_TOOLS
        
        # Update status to ACTIVE
        try:
            await workflow.execute_activity(
                update_agent_status,
                args=[agent_id, "ACTIVE", 0.0, "Agent started"],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=3)
            )
        except Exception as e:
            workflow.logger.warning(f"Failed to update initial status: {str(e)}")
        
        try:
            # Main agent loop
            while True:
                # 1. Query blueprints on first iteration
                if self.iteration_count == 0:
                    blueprints = await self._query_blueprints()
                    if blueprints:
                        # Insert blueprints directly into context
                        for bp in blueprints:
                            self.context.append({
                                "role": "SYSTEM",
                                "text": f"Blueprint for similar goal:\n{bp['blueprint']}",
                                "timestamp": workflow.now().isoformat()
                            })
                
                # 2. Poll for new user messages
                new_messages = await self._poll_messages()
                if new_messages:
                    self.context.extend(new_messages)
                    await self._post_message(f"Received {len(new_messages)} new messages", "ASSISTANT")
                
                # 3. Decide next action using LLM
                action = await self._decide_next_action()
                
                # 4. Execute action (if LLM decided on one)
                if action.get("tool"):
                    result = await self._execute_action(action)
                    # Add action result to context so LLM can see what happened
                    self.context.append({
                        "role": "TOOL",
                        "text": f"Action result: {result}",
                        "timestamp": workflow.now().isoformat()
                    })
                else:
                    # LLM didn't decide or errored - skip this iteration
                    workflow.logger.info("No action to execute, continuing")
                
                # 5. Check progress with verifier and update DB
                progress_result = await self._check_progress()
                progress_score = progress_result.get("score", 0.0)
                progress_reasoning = progress_result.get("reasoning", "No reasoning provided")
                
                # Post verifier's reasoning as an ASSISTANT message so the agent can see it
                await self._post_message(
                    f"Verifier assessment: {progress_reasoning} (Progress: {progress_score*100:.0f}%)",
                    "ASSISTANT"
                )
                
                # Update agent progress in DB
                await workflow.execute_activity(
                    update_agent_status,
                    args=[self.agent_id, "ACTIVE", progress_score, f"Iteration {self.iteration_count}: {progress_score*100:.1f}% complete"],
                    start_to_close_timeout=timedelta(seconds=15),
                    retry_policy=RetryPolicy(
                        maximum_attempts=6,
                        backoff_coefficient=4.0,
                        initial_interval=timedelta(seconds=2),
                        maximum_interval=timedelta(seconds=64)
                    )
                )
                
                # 6. If complete, mark finished and exit
                if progress_score >= 1.0:
                    await self._mark_complete()
                    return {"status": "completed", "goal": self.goal}
                
                # 7. Update iteration count and token usage
                self.iteration_count += 1
                
                # Calculate current context token usage
                context_text = "\n".join([msg.get('text', '') for msg in self.context])
                self.context_tokens = estimate_token_count(context_text)
                
                # Calculate threshold based on model's actual context window
                threshold_tokens = int(self.max_context_tokens * CONTEXT_THRESHOLD_PERCENTAGE)
                
                # 8. Continue as new if context is at 80% capacity
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
                        args=[self.goal, self.context, self.iteration_count, self.model],
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
                        tool_ids=self.tool_ids,
                        verifier=self.verifier,
                        context=compressed_context
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
            
            if messages:
                self.last_message_check = workflow.now()
            
            return messages
            
        except Exception as e:
            workflow.logger.error(f"Failed to poll messages: {str(e)}")
            # Return empty list on error - will try again next iteration
            return []
    
    async def _post_message(self, text: str, role: str = "ASSISTANT") -> None:
        """Post a message from the agent."""
        try:
            await workflow.execute_activity(
                post_agent_message,
                args=[self.agent_id, text, role],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64)
                )
            )
            
            # Add to local context too
            self.context.append({
                "role": role,
                "text": text,
                "timestamp": workflow.now().isoformat()
            })
            
        except Exception as e:
            workflow.logger.error(f"Failed to post message: {str(e)}")
            # Non-fatal - continue
    
    async def _query_blueprints(self) -> List[Dict]:
        """Query knowledge base for similar goals."""
        try:
            workflow.logger.info("Querying blueprints")
            
            blueprints = await workflow.execute_activity(
                query_blueprints,
                args=[self.goal, self.user_id, 3],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64)
                )
            )
            
            workflow.logger.info(f"Found {len(blueprints)} blueprints")
            return blueprints
            
        except Exception as e:
            workflow.logger.error(f"Failed to query blueprints: {str(e)}")
            return []
    
    async def _decide_next_action(self) -> Dict:
        """
        Decide next action based on goal and context using LLM.
        
        Returns:
            Dict with 'tool', 'args', 'reasoning'
        """
        workflow.logger.info("Deciding next action")
        
        try:
            action = await workflow.execute_activity(
                decide_next_action,
                args=[self.goal, self.context, self.tools, self.iteration_count, self.model],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64)
                )
            )
            
            workflow.logger.info(f"LLM decided: {action.get('tool')} - {action.get('reasoning')}")
            return action
            
        except Exception as e:
            workflow.logger.error(f"Failed to decide action: {str(e)}")
            # Fallback: wait and try again
            return {
                "tool": None,
                "args": [],
                "reasoning": f"Decision failed: {str(e)}, will retry"
            }
    
    async def _execute_action(self, action: Dict) -> Any:
        """Execute an action using the specified tool."""
        tool = action.get("tool")
        args = action.get("args", [])
        
        workflow.logger.info(f"Executing action: {tool}")
        
        # Special handling for post_message: just post to the agent
        if tool == "post_message":
            try:
                message = args[0] if args else ""
                if not message:
                    raise ValueError("Message text is required")
                
                await self._post_message(message, "ASSISTANT")
                return f"Posted message: {message}"
                
            except (ValueError, IndexError) as e:
                error_msg = f"Invalid message: {str(e)}"
                await self._post_message(error_msg, "TOOL")
                raise ValueError(error_msg)
        
        # Special handling for wait_seconds: it's not an activity, just workflow.sleep()
        if tool == "wait_seconds":
            try:
                # Validate and convert seconds
                seconds_raw = args[0] if args else 1
                seconds = int(seconds_raw) if isinstance(seconds_raw, str) else int(seconds_raw)
                
                # Validate range
                if seconds < 1 or seconds > 3600:
                    raise ValueError(f"Wait time must be between 1 and 3600 seconds, got {seconds}")
                
                workflow.logger.info(f"Starting wait for {seconds} seconds")
                await self._post_message(f"Waiting for {seconds} seconds...", "TOOL")
                await workflow.sleep(seconds)
                await self._post_message(f"Finished waiting {seconds} seconds", "TOOL")
                
                return f"Waited for {seconds} seconds"
                
            except (ValueError, TypeError) as e:
                error_msg = f"Invalid wait time: {str(e)}"
                await self._post_message(error_msg, "TOOL")
                raise ValueError(error_msg)
        
        # Map tool to activity (for all non-system tools)
        activity_map = {
            "send_sms": send_sms,
            "list_contacts": list_contacts,
            "web_search": web_search,
            "accomplish_web_task": accomplish_web_task,
        }
        
        activity_fn = activity_map.get(tool)
        if not activity_fn:
            error_msg = f"Unknown tool: {tool}"
            await self._post_message(error_msg, "ASSISTANT")
            raise ValueError(error_msg)
        
        # Check if tool is available
        available_tool_names = [t['name'] for t in self.tools]
        if tool not in available_tool_names:
            error_msg = f"Tool not available: {tool}"
            await self._post_message(error_msg, "ASSISTANT")
            raise ValueError(error_msg)
        
        # Execute with extreme backoff
        try:
            result = await workflow.execute_activity(
                activity_fn,
                args=args,
                start_to_close_timeout=timedelta(minutes=5),
                heartbeat_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64)
                )
            )
            
            # Add result to context
            result_msg = f"Executed {tool}: {result}"
            await self._post_message(result_msg, "TOOL")
            
            return result
            
        except Exception as e:
            # Error gets propagated to context
            error_msg = f"Tool {tool} failed: {str(e)}"
            await self._post_message(error_msg, "ASSISTANT")
            raise
    
    async def _check_progress(self) -> Dict[str, Any]:
        """
        Check progress toward goal using LLM verifier.
        
        Returns:
            Dict with 'score' (float 0.0-1.0) and 'reasoning' (str)
        """
        workflow.logger.info("Checking progress")
        
        try:
            result = await workflow.execute_activity(
                check_progress,
                args=[self.goal, self.context, self.verifier["llmJudgePrompt"], self.model],
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
        """Mark the task as complete and save blueprint."""
        workflow.logger.info("Marking task as complete")
        
        try:
            # Include all messages in blueprint (USER, ASSISTANT, TOOL, SYSTEM)
            steps = self.context
            
            # Save blueprint
            await workflow.execute_activity(
                save_blueprint,
                args=[self.user_id, self.goal, steps],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64)
                )
            )
            
            # Mark as finished in the database
            await workflow.execute_activity(
                mark_finished,
                args=[self.agent_id, self.goal, steps],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(
                    maximum_attempts=6,
                    backoff_coefficient=4.0,
                    initial_interval=timedelta(seconds=2),
                    maximum_interval=timedelta(seconds=64)
                )
            )
            
            await self._post_message("Task completed successfully!", "ASSISTANT")
            
        except Exception as e:
            error_msg = f"Failed to mark complete: {str(e)}"
            workflow.logger.error(error_msg)
            await self._post_message(error_msg, "ASSISTANT")
            raise
    
    @workflow.query
    def get_status(self) -> Dict:
        """Query the current status."""
        return {
            "agent_id": self.agent_id,
            "goal": self.goal,
            "iteration": self.iteration_count,
            "context_size": len(self.context),
        }
