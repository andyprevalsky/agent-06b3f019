"""Main agent workflow for executing autonomous tasks.

Uses run_agent for the core loop. Workflow handles:
- Signals (pause, resume, user response, sub-agent progress)
- Sub-agent orchestration
- continue_as_new for context overflow
"""

from datetime import timedelta, datetime
from typing import Dict, List, Optional, Any, Set
from datetime import timezone
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import TimeoutError as TemporalTimeoutError
import asyncio
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
        check_user_usage,
        fetch_agent_config,
    )
    from helpers.messages import broadcast_to_bus, update_agent_tree_state
    from helpers.prompts import build_system_prompt, build_verifier_prompt
    from helpers.handle_tool_event import handle_tool_event
    from tools.base import ToolEvent, EventType, MessageStatus
    # Tool executors (map tool name → workflow helper)
    from tools.deep_research import deep_research
    from tools.wait_seconds import wait_seconds
    from tools.send_message_to_user import send_message_to_user
    from tools.enable_write_permissions import enable_write_permissions
    from tools.request_user_approval import request_user_approval_direct
    from tools.knowledge_base import save_blueprint
    from tools.web_search import web_search
    from tools.spawn_sub_agents import spawn_sub_agents
    from tools.send_sms_as_user import send_sms_as_user
    from tools.spawn_browser_agent_v3 import spawn_browser_agent  # V3: browser-use + Rose API
    from tools.search_user_network import search_user_network_for_people
    from tools.find_all import find_all
    from tools.enrich import enrich
    from tools.monitor import monitor
    from tools.check_monitor_events import check_monitor_events
    from tools.read_message_history import read_message_history_with_person
    from tools.message_person import message_person, get_manager as get_message_person_manager
    from tools.set_plan import set_plan
    from tools.attempt_completion import attempt_completion
    from tools.x402_bazaar import search_x402_bazaar, pay_for_x402_bazaar_service
    from tools.request_user_signup import request_user_signup
    from loop.run_agent import run_agent
    from helpers.format_tool_display import format_tool_display

logger = structlog.get_logger()

# =============================================================================
# TOOL CONFIGURATION
# =============================================================================

# Tool name → executor function mapping
TOOL_EXECUTORS = {
    "spawn_browser_agent": spawn_browser_agent,
    "deep_research": deep_research,
    "wait_seconds": wait_seconds,
    "send_message_to_user": send_message_to_user,
    "send_message_to_user_execute_phase": send_message_to_user,  # Same handler, forces is_question=False
    "enable_write_permissions": enable_write_permissions,
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
    "set_plan": set_plan,
    "attempt_completion": attempt_completion,
    "search_x402_bazaar": search_x402_bazaar,
    "pay_for_x402_bazaar_service": pay_for_x402_bazaar_service,
    "request_user_signup": request_user_signup,
}

# Tools requiring user approval before execution
APPROVAL_REQUIRED_TOOLS = {
    "message_person": get_message_person_manager,
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
        self.is_paused: bool = False
        self._has_new_messages: bool = False
        self._has_credits: bool = True  # Cached credit status
        self._last_credit_check: int = 0  # Iteration count at last check

        # Signup request state (for request_user_signup tool)
        self._signup_completed: bool = False
        self._signup_dismissed: bool = False

        # Context - kept in sync with run_agent for tools that check it
        self.context: List[Dict] = []

        # Response schema for structured output (fetched from agent config)
        self.response_schema: Optional[Dict[str, Any]] = None

        # Sub-agent tracking
        self.parent_workflow_id: Optional[str] = None
        self.parent_agent_id: Optional[str] = None  # Parent agent ID for tree structure
        self.pending_children: Set[str] = set()
        self.child_tool_ids: Dict[str, str] = {}
        self.child_last_tokens: Dict[str, Dict[str, int]] = {}
        self.depth: int = 0

        # Tree state tracking (for sub-agent tree UI)
        self.bus_id: Optional[str] = None  # Shared bus channel ID for tree updates
        self.tools_in_use: Set[str] = set()  # Currently executing tools (display strings)
        self.message_count: int = 0  # Total message count for this agent
        self.output_schema: Optional[Dict] = None  # Cached response schema for tree display
    
    # =========================================================================
    # SIGNALS
    # =========================================================================
    
    @workflow.signal
    async def pause(self):
        """Pause workflow execution."""
        workflow.logger.info("🔴 Received PAUSE signal")
        self.is_paused = True
    
    @workflow.signal
    async def resume(self):
        """Resume workflow execution."""
        workflow.logger.info("🟢 Received RESUME signal")
        self.is_paused = False
    
    @workflow.signal
    async def receive_user_response(self, response: str):
        """Receive user response - sets flag for run_agent to detect."""
        workflow.logger.info(f"💬 Received user response (length={len(response)})")
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
                    "toolName": "spawn_sub_agents",
                    "toolStatus": "IN_PROGRESS",
                    "title": goal[:30] if goal else "Sub-agent",
                    "subAgentId": child_agent_id,
                    "progress": progress
                }
            )
    
    @workflow.signal
    async def child_completed(self, data: dict):
        """Receive completion signal from child agent."""
        child_agent_id = data.get("child_agent_id", "")
        result = data.get("result", {})

        workflow.logger.info(f"✅ Child {child_agent_id[:8]} completed")

        child_tool_id = self.child_tool_ids.get(child_agent_id)
        if child_tool_id:
            summary = result.get("summary", "")
            goal_text = result.get("goal", "")
            structured_response = result.get("structured_response")
            await self._post_message(
                summary if summary else f"Completed: {goal_text}",
                "TOOL",
                metadata={
                    "toolCallId": child_tool_id,
                    "toolName": "spawn_sub_agents",
                    "toolStatus": "FINISHED",
                    "title": f"Sub-agent completed: {goal_text[:30]}",
                    "subAgentId": child_agent_id,
                    "progress": 1.0,
                    "structuredResponse": structured_response
                }
            )

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
    ) -> Dict:
        """Execute agent task: PLAN phase → EXECUTE phase."""
        self.agent_id = agent_id
        self.user_id = user_id
        self.goal = goal
        self.model = model
        self.reasoning_max_tokens = reasoning_max_tokens
        self.verifier = verifier
        self.parent_workflow_id = parent_workflow_id
        self.parent_agent_id = parent_agent_id
        self.depth = depth
        self.bus_id = bus_id

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

        # Fetch and cache output schema for tree display (available immediately after spawn)
        if self.bus_id:
            try:
                self.output_schema = await workflow.execute_activity(
                    fetch_agent_response_schema,
                    args=[agent_id],
                    start_to_close_timeout=timedelta(seconds=10),
                    retry_policy=RetryPolicy(maximum_attempts=2)
                )
            except Exception as e:
                workflow.logger.debug(f"Failed to fetch output schema (non-fatal): {e}")

            # Broadcast initial tree state with schema
            await self._update_tree_state(progress=0.0, status="ACTIVE")

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

        # Fetch response schema from agent config (for system prompts and verifier)
        response_schema = None
        try:
            agent_config = await workflow.execute_activity(
                fetch_agent_config,
                args=[agent_id],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3)
            )
            response_schema = agent_config.get("response_schema")
            self.response_schema = response_schema  # Store on instance for tools like set_plan
            workflow.logger.info(f"Fetched response_schema: {response_schema is not None}")
        except Exception as e:
            workflow.logger.warning(f"Failed to fetch agent config for response_schema: {e}")
        
        # =====================================================================
        # Define tool lists for both phases upfront
        # =====================================================================
        plan_tools = [
            "web_search",
            # "search_user_network_for_people",
            # "read_message_history_with_person",
            "send_message_to_user",
            # "search_x402_bazaar",
            "set_plan",
            "attempt_completion",
        ]
        
        execute_tools = [
            "spawn_browser_agent",
            "spawn_sub_agents",
            "wait_seconds",
            # "find_all",
            # "enrich",
            # "monitor",
            # "check_monitor_events",
            # "search_user_network_for_people",
            # "read_message_history_with_person",
            # "message_person",
            "web_search",
            # "search_x402_bazaar",
            # "pay_for_x402_bazaar_service",
            "send_message_to_user_execute_phase",
            "attempt_completion",
        ]

        # =====================================================================
        # PHASE 1: PLAN (research + create execution plan)
        # =====================================================================
        workflow.logger.info(f"▶ PLAN phase: {len(plan_tools)} tools")
        
        plan_result = await run_agent(
            agent_id=agent_id,
            user_id=user_id,
            system_prompt=build_system_prompt("PLAN", plan_tools, disabled_tools=execute_tools, user_context_section=user_context_section, response_schema=response_schema),
            verifier_prompt=build_verifier_prompt("PLAN", self.verifier.get("llmJudgePrompt", ""), response_schema=response_schema),
            model=model,
            tools=plan_tools,
            is_inside_temporal_activity=False,
            check_paused=lambda: asyncio.sleep(0, result=self.is_paused),
            wait_for_messages=self._wait_for_messages,
            on_context_overflow=self._handle_context_overflow,
            check_credits=self._check_credits,
            post_message=self._post_message,
            poll_messages=self._poll_messages,
            execute_tool=self._execute_tool,
            update_tree_state=self._update_tree_state,
            max_context_tokens=self.max_context_tokens,
            reasoning_max_tokens=reasoning_max_tokens,
            is_plan_loop=True,  # PLAN phase: requires set_plan, posts "sit back" message
            response_schema=response_schema,
        )
        
        self._track_tokens(plan_result)
        
        if plan_result["status"] != "completed":
            return await self._handle_incomplete(plan_result, "PLAN")
        
        workflow.logger.info("✓ PLAN complete, starting EXECUTE")
        
        # =====================================================================
        # PHASE 2: EXECUTE (run the plan with full tool access)
        # =====================================================================
        workflow.logger.info(f"▶ EXECUTE phase: {len(execute_tools)} tools")
        
        execute_result = await run_agent(
            agent_id=agent_id,
            user_id=user_id,
            system_prompt=build_system_prompt("EXECUTE", execute_tools, user_context_section=user_context_section, response_schema=response_schema),
            verifier_prompt=build_verifier_prompt("EXECUTE", self.verifier.get("llmJudgePrompt", ""), response_schema=response_schema),
            model=model,
            tools=execute_tools,
            is_inside_temporal_activity=False,
            check_paused=lambda: asyncio.sleep(0, result=self.is_paused),
            wait_for_messages=self._wait_for_messages,
            on_context_overflow=self._handle_context_overflow,
            check_credits=self._check_credits,
            post_message=self._post_message,
            poll_messages=self._poll_messages,
            execute_tool=self._execute_tool,
            update_tree_state=self._update_tree_state,
            max_context_tokens=self.max_context_tokens,
            reasoning_max_tokens=reasoning_max_tokens,
            skip_blueprint_query=True,  # Already queried in PLAN phase
            response_schema=response_schema,
        )
        
        self._track_tokens(execute_result)

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
        workflow.continue_as_new(
            agent_id=self.agent_id,
            user_id=self.user_id,
            goal=self.goal,
            model=self.model,
            reasoning_max_tokens=self.reasoning_max_tokens,
            tool_ids=[],
            verifier=self.verifier,
            context=compressed_context,
            parent_workflow_id=self.parent_workflow_id,
            parent_agent_id=self.parent_agent_id,
            depth=self.depth,
            bus_id=self.bus_id,
        )
    
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
            
            return messages
        except Exception:
            return []
    
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
                    question = manager.get_approval_question({"tool": tool_name, **tool_args})
                    await request_user_approval_direct(self, question=question, metadata={"toolApproval": True})

            executor = TOOL_EXECUTORS[tool_name]

            # Tools migrated to new signature: (execute_activity, tool_call, tool_call_id, agent_id, user_id)
            # These return results and call handle_tool_event internally
            NEW_SIGNATURE_TOOLS = {
                "web_search", "send_email", "send_sms", "send_sms_as_user",
                "search_user_network_for_people", "read_message_history_with_person",
                "monitor", "check_monitor_events",
                "deep_research", "attempt_completion",
                "search_x402_bazaar", "pay_for_x402_bazaar_service",
            }

            if tool_name in NEW_SIGNATURE_TOOLS:
                result = await executor(
                    execute_activity=workflow.execute_activity,
                    tool_call={"tool": tool_name, **tool_args},
                    tool_call_id=tool_call_id,
                    agent_id=self.agent_id,
                    user_id=self.user_id,
                )
                return {"success": True, "message": f"{tool_name} completed", "result": result}
            else:
                # Legacy signature: (workflow_instance, tool_call, tool_call_id)
                # These yield ToolEvents and call workflow_instance._handle_tool_event
                await executor(self, {"tool": tool_name, **tool_args}, tool_call_id)
                return {"success": True, "message": f"{tool_name} completed"}

        except asyncio.CancelledError:
            # User paused the agent - don't show as error
            workflow.logger.info(f"Tool {tool_name} cancelled (user paused)")
            return {"success": False, "message": "User paused the agent during browser execution"}

        except Exception as e:
            workflow.logger.error(f"Tool {tool_name} failed: {e}")
            # Emit error event so it shows in frontend
            await self._handle_tool_event(
                ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"{tool_name} failed",
                    message=str(e),
                    status=MessageStatus.ERROR
                ),
                tool_call_id,
                tool_name
            )
            return {"error": True, "message": str(e)}
        finally:
            # Remove tool from in-use and broadcast tree state
            self.tools_in_use.discard(tool_display)
            await self._update_tree_state()
    
    async def _handle_tool_event(self, event: ToolEvent, tool_call_id: str, tool_name: str) -> None:
        """
        Handle ToolEvent emitted by tool managers.
        
        Delegates to standalone handle_tool_event function which routes events
        to appropriate FE/DB updates. Works in both workflow and activity contexts.
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
    
    def _track_tokens(self, result: Dict) -> None:
        """Track tokens from run_agent result."""
        self.tokens_in += result.get("tokens_in", 0)
        self.tokens_out += result.get("tokens_out", 0)
        self.token_count += result.get("token_count", 0)

    async def _update_tree_state(self, progress: float = None, status: str = None, structured_output: Dict = None) -> None:
        """
        Broadcast tree state update to the bus channel and persist to DB.

        Only broadcasts if this agent has a bus_id (i.e., is part of a sub-agent tree).
        Used for real-time sub-agent tree UI updates.
        """
        if not self.bus_id:
            return

        tools_list = list(self.tools_in_use)

        # Build broadcast payload
        broadcast_payload = {
            "agentId": self.agent_id,
            "parentAgentId": self.parent_agent_id,
            "goal": self.goal,
            "status": status or "ACTIVE",
            "progress": progress if progress is not None else 0.0,
            "toolsInUse": tools_list,
            "messageCount": self.message_count,
        }

        # Always include output schema (available from spawn, cached in instance)
        if self.output_schema:
            broadcast_payload["outputSchema"] = self.output_schema

        # Include structured output (actual values) only for completed agents
        if structured_output:
            broadcast_payload["structuredOutput"] = structured_output

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
            workflow.continue_as_new(
                agent_id=self.agent_id,
                user_id=self.user_id,
                goal=self.goal,
                model=self.model,
                reasoning_max_tokens=self.reasoning_max_tokens,
                tool_ids=[],
                verifier=self.verifier,
                context=result.get("context"),
                parent_workflow_id=self.parent_workflow_id,
                parent_agent_id=self.parent_agent_id,
                depth=self.depth,
                bus_id=self.bus_id,
            )

            return result
            
    async def _mark_complete(self, context: List[Dict], structured_response: Optional[Dict] = None) -> None:
        """Mark task complete, save blueprint, signal parent."""
        workflow.logger.info("✓ Marking task complete")

        try:
            # Generate summary - pass structured_response and output_schema so summarizer includes them
            summary_result = await workflow.execute_activity(
                generate_completion_summary,
                args=[context, self.goal, self.model, structured_response, self.output_schema],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=3)
            )
            summary = summary_result.get("summary", "")
            self._track_tokens({"tokens_in": summary_result.get("usage", {}).get("prompt_tokens", 0),
                               "tokens_out": summary_result.get("usage", {}).get("completion_tokens", 0),
                               "token_count": summary_result.get("usage", {}).get("total_tokens", 0)})

            if summary:
                # Post as user attention message (like send_message_to_user) instead of ASSISTANT
                await self._post_message(summary, "TOOL", {
                    "isFinalSummary": True,
                    "isUserAttentionMessage": True,
                    "attentionMessage": summary,
                    "sendMessageToUser": {
                        "isQuestion": False,
                        "attentionKind": "info",
                        "isWaitingForUser": False,
                    },
                    "toolName": "completion_summary",
                    "toolStatus": "FINISHED",
                    "title": "✅ Task Complete",
                })

            # Save blueprint
            await save_blueprint(self, self.user_id, context)

            # Broadcast COMPLETED status with structured output to tree
            # (output_schema is already cached from startup and included in all broadcasts)
            await self._update_tree_state(progress=1.0, status="COMPLETED", structured_output=structured_response)

            # Mark finished (includes structured_response for persistence)
            await workflow.execute_activity(
                mark_finished,
                args=[self.agent_id, context, self.token_count, 0, len(context), self.tokens_in, self.tokens_out,
                      summary if self.parent_workflow_id else "", structured_response],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3)
            )
        except Exception as e:
            workflow.logger.error(f"Failed to mark complete: {e}")
            raise

        # Signal parent
        if self.parent_workflow_id:
            try:
                parent = workflow.get_external_workflow_handle(self.parent_workflow_id)
                await parent.signal("child_completed", {
                    "child_agent_id": self.agent_id,
                    "result": {
                        "status": "completed",
                        "goal": self.goal,
                        "summary": summary,
                        "structured_response": structured_response
                    }
                })
            except Exception as e:
                workflow.logger.warning(f"Failed to signal parent: {e}")
    
    @workflow.query
    def get_status(self) -> Dict:
        """Query current status."""
        return {"agent_id": self.agent_id, "goal": self.goal, "tokens": self.token_count}
