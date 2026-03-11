"""Unified spawn_agent tool - dispatches to browser/code/sub_agent/explore agents.

Replaces separate spawn_browser_agent, spawn_claude_code_agent, spawn_sub_agent tools
with a single spawn_agent(type=...) interface. Also adds the new explore agent type
for research/information gathering.
"""

import asyncio
import uuid as uuid_module
from typing import Dict, Any, AsyncGenerator, Optional, List
from datetime import timedelta
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, CancelledError as TemporalCancelledError
import structlog
import httpx

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, format_tool_message
from tools.grep import fetch_local_data_summary
from tools.spawn_browser_agent_v3 import get_manager as get_browser_manager
from tools.spawn_claude_code_agent import get_manager as get_code_manager
from tools.spawn_sub_agents import get_manager as get_sub_agent_manager
from helpers.prompts import EXPLORE_AGENT_SYSTEM_PROMPT
from config import load_config

logger = structlog.get_logger()


# =============================================================================
# VALIDATION
# =============================================================================

def _validate_spawn_params(tool_call: dict) -> None:
    """Validate required fields per agent type. Raises ValueError with descriptive messages."""
    agent_type = tool_call.get("type")

    if not agent_type:
        raise ValueError(
            "spawn_agent requires 'type'. Must be one of: 'browser', 'code', 'sub_agent', 'explore'."
        )

    valid_types = {"browser", "code", "sub_agent", "explore"}
    if agent_type not in valid_types:
        raise ValueError(
            f"spawn_agent type='{agent_type}' is invalid. Must be one of: {', '.join(sorted(valid_types))}."
        )

    if not tool_call.get("goal"):
        raise ValueError(
            f"spawn_agent(type='{agent_type}') requires 'goal'. Describe the task for the agent."
        )

    if agent_type == "browser" and not tool_call.get("start_url"):
        raise ValueError(
            "spawn_agent(type='browser') requires 'start_url'. Provide the URL to navigate to."
        )

    if agent_type in ("browser", "code", "sub_agent") and not tool_call.get("output_schema"):
        raise ValueError(
            f"spawn_agent(type='{agent_type}') requires 'output_schema'. "
            "Define the expected response structure with fields."
        )

    if agent_type == "explore":
        if tool_call.get("output_schema"):
            raise ValueError(
                "spawn_agent(type='explore') does not use 'output_schema'. "
                "Explore agents return free-form research summaries."
            )
        if tool_call.get("verifier"):
            raise ValueError(
                "spawn_agent(type='explore') does not support 'verifier'. "
                "Only type='sub_agent' supports verification."
            )


# =============================================================================
# EXPLORE AGENT
# =============================================================================

async def save_explore_message(
    agent_id: str,
    title: str,
    message: str,
    status: MessageStatus,
    task_id: str,
    tool_call_id: str = None,
):
    """Save explore agent message directly to DB.

    When tool_call_id is provided, the message reuses that ID so the frontend
    deduplicator replaces the previous message with the same toolCallId.
    This is used for progress updates on the init bubble.
    """
    try:
        config = load_config()
        unique_tool_call_id = tool_call_id or str(uuid_module.uuid4())

        metadata = {
            "toolCallId": unique_tool_call_id,
            "toolName": "spawn_agent",
            "toolStatus": status.value,
            "title": title,
            "agentType": "explore",
            "taskId": task_id,
            "subAgentId": task_id,
        }

        if status == MessageStatus.ERROR:
            metadata["error"] = True

        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{config.backend.api_url}/api/agents/{agent_id}/messages",
                headers={
                    "x-api-key": config.backend.api_key or "",
                    "Content-Type": "application/json"
                },
                json={
                    "message": message,
                    "role": "TOOL",
                    "metadata": metadata
                }
            )
    except Exception as e:
        logger.error("Failed to save explore message", error=str(e))


@activity.defn
async def spawn_explore_agent_activity(
    agent_id: str,
    user_id: str,
    goal: str,
    model: str,
    network_metadata: str = "",
    local_data_summary: str = "",
    task_id: str = "",
    init_tool_call_id: str = "",
    claude_token: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Run the explore agent loop inside a Temporal activity.

    Uses run_agent with is_inside_temporal_activity=True and read-only tools
    (web_search, web_fetch, grep, attempt_completion).

    Returns:
        Dict with status, accumulated_usage, tokens_in, tokens_out
    """
    from loop.run_agent import run_agent
    from loop.activity_helper import call_temporal_activity_from_activity
    from helpers.handle_tool_event import handle_tool_event
    from tools.web_search import WebSearchManager
    from tools.web_fetch import WebFetchManager
    from tools.grep import GrepManager

    activity.heartbeat(f"Starting explore agent: {goal[:100]}...")

    # Accumulate usage from all tool calls inside the explore agent
    accumulated_usage: List[Dict] = []

    # Accumulate per-iteration LLM usage with actual_model from Rose response
    # (so cost tracking uses the real model, not the requested model)
    llm_iteration_usage: List[Dict] = []

    async def on_tokens(tokens_in_delta: int, tokens_out_delta: int, actual_model: Optional[str] = None):
        """Track each LLM call's tokens with the actual model used."""
        llm_iteration_usage.append({
            "tokens_in": tokens_in_delta,
            "tokens_out": tokens_out_delta,
            "model": actual_model or model,
            "provider": "Explore Agent",
        })

    # Wrap execute_activity to inject taskId into all internal tool messages
    # This ensures grep/web_search/web_fetch messages get grouped under the explore chip
    async def tagged_execute_activity(activity_fn, args=None, **kwargs):
        """Wraps call_temporal_activity_from_activity to tag internal messages with explore taskId."""
        # Intercept post_agent_message calls to inject taskId + agentType + subAgentId
        if activity_fn.__name__ == "post_agent_message" and args and len(args) >= 4:
            metadata = args[3]
            if isinstance(metadata, dict):
                metadata["taskId"] = task_id
                metadata["agentType"] = "explore"
                metadata["subAgentId"] = task_id
        return await call_temporal_activity_from_activity(activity_fn, args=args, **kwargs)

    # Build system prompt with network metadata and local data summary
    from datetime import datetime, timezone
    current_ts = datetime.now(timezone.utc).isoformat()

    system_prompt = EXPLORE_AGENT_SYSTEM_PROMPT.format(
        current_timestamp=current_ts,
        network_metadata=f"\nUSER NETWORK:\n{network_metadata}" if network_metadata else "",
        local_data_summary=f"\n{local_data_summary}" if local_data_summary else "",
    )

    async def explore_system_prompt():
        return system_prompt

    async def explore_verifier_prompt():
        return "Verify the research is complete and the summary addresses the original goal."

    async def explore_execute_tool(tool_name: str, tool_args: Dict, tool_call_id: str) -> Dict:
        """Execute a tool inside the explore activity context.

        Each tool manager posts its own IN_PROGRESS → FINISHED messages with its own toolCallId.
        tagged_execute_activity injects taskId + agentType=explore so the FE groups them
        under the explore chip. The init bubble (init_tool_call_id) stays stable.
        """
        activity.heartbeat(f"Explore agent executing: {tool_name}")

        tool_call_dict = {"tool": tool_name, **tool_args}

        if tool_name == "web_search":
            manager = WebSearchManager()
            result = await manager.execute_tool(
                execute_activity=tagged_execute_activity,
                tool_call=tool_call_dict,
                tool_call_id=tool_call_id,
                agent_id=agent_id,
                user_id=user_id,
            )
        elif tool_name == "web_fetch":
            manager = WebFetchManager()
            result = await manager.execute_tool(
                execute_activity=tagged_execute_activity,
                tool_call=tool_call_dict,
                tool_call_id=tool_call_id,
                agent_id=agent_id,
                user_id=user_id,
            )
        elif tool_name == "grep":
            manager = GrepManager()
            result = await manager.execute_tool(
                execute_activity=tagged_execute_activity,
                tool_call=tool_call_dict,
                tool_call_id=tool_call_id,
                agent_id=agent_id,
                user_id=user_id,
            )
        elif tool_name == "attempt_completion":
            return {"success": True, "message": "Completion accepted"}
        else:
            return {"error": True, "message": f"Unknown tool: {tool_name}"}

        # Extract and accumulate usage
        if isinstance(result, dict) and "usage" in result:
            accumulated_usage.append(result["usage"])
            actual_result = result.get("result", result)
        else:
            actual_result = result

        # Serialize the actual result into message so run_agent puts it in context.
        # Without this, the model only sees "grep completed" and never the actual data.
        import json
        try:
            result_str = json.dumps(actual_result, default=str)
            # Truncate to avoid blowing up context
            if len(result_str) > 8000:
                result_str = result_str[:8000] + "... (truncated)"
        except Exception:
            result_str = str(actual_result)[:8000]

        return {"success": True, "message": result_str}

    async def explore_post_message(message: str, role: str, metadata: Optional[Dict] = None):
        """Post messages from the explore agent to DB."""
        await save_explore_message(
            agent_id=agent_id,
            title="Explore agent thinking",
            message=message[:500],
            status=MessageStatus.IN_PROGRESS,
            task_id=task_id,
        )

    # Run the agent loop
    result = await run_agent(
        agent_id=agent_id,
        user_id=user_id,
        system_prompt=explore_system_prompt,
        verifier_prompt_generator=explore_verifier_prompt,
        model=model,
        tools=["web_search", "web_fetch", "grep", "attempt_completion"],
        initial_context=[{"role": "USER", "text": goal}],
        task_id=task_id,
        is_inside_temporal_activity=True,
        execute_tool=explore_execute_tool,
        post_message=explore_post_message,
        max_iterations=20,
        skip_verification=True,
        skip_blueprint_query=True,
        skip_status_updates=True,  # Don't overwrite parent agent's context_size
        claude_token=claude_token,
        on_tokens=on_tokens,
    )

    return {
        "status": "completed" if result.get("status") == "completed" else "error",
        "result": result.get("final_response", ""),
        "tokens_in": result.get("tokens_in", 0),
        "tokens_out": result.get("tokens_out", 0),
        "accumulated_usage": accumulated_usage,
        "llm_iteration_usage": llm_iteration_usage,
    }


# =============================================================================
# FETCH NETWORK METADATA (for explore agent context)
# =============================================================================

# Module-level cache
_network_metadata_cache: Dict[str, Dict[str, Any]] = {}

@activity.defn
async def fetch_full_network_metadata(user_id: str) -> str:
    """
    Fetch full user network metadata for explore agent system prompt.
    Cached with 5-minute TTL.
    """
    from datetime import datetime

    global _network_metadata_cache

    now = datetime.utcnow()
    if user_id in _network_metadata_cache:
        cached = _network_metadata_cache[user_id]
        from datetime import timedelta as td
        if (now - cached["fetched_at"]) < td(minutes=5):
            return cached["metadata"]

    config = load_config()
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                f"{config.backend.api_url}/api/people",
                params={"limit": 500},
                headers={
                    "X-API-Key": config.backend.api_key or "",
                    "X-User-Id": user_id,
                },
            )
            response.raise_for_status()
            data = response.json()
            people = data.get("people", [])

        # Format all non-null fields per person
        lines = []
        for person in people:
            parts = []
            first = person.get("firstName", "")
            last = person.get("lastName", "")
            name = f"{first} {last}".strip()
            if not name:
                continue

            parts.append(name)

            # Include all non-null fields
            skip_fields = {"id", "userId", "createdAt", "updatedAt", "firstName", "lastName"}
            for key, value in person.items():
                if key in skip_fields or value is None or value == "" or value == []:
                    continue
                # Format field name nicely
                field_name = key.replace("_", " ").replace("Id", "").strip()
                parts.append(f"{field_name}: {value}")

            lines.append("- " + " | ".join(parts))

        metadata = "\n".join(lines) if lines else "No contacts found."

        _network_metadata_cache[user_id] = {
            "metadata": metadata,
            "fetched_at": now,
        }

        return metadata
    except Exception as e:
        logger.error("Failed to fetch network metadata", user_id=user_id[:8], error=str(e))
        return ""


# =============================================================================
# SPAWN AGENT MANAGER (Legacy pattern - async generator)
# =============================================================================

class SpawnAgentManager(ToolManager):
    """Unified manager that dispatches to browser/code/sub_agent/explore based on type."""

    @property
    def tool_name(self) -> str:
        return "spawn_agent"

    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """Dispatch to appropriate agent type."""
        agent_type = tool_call.get("type")

        # Validate params
        try:
            _validate_spawn_params(tool_call)
        except ValueError as e:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="spawn_agent failed",
                message=str(e),
                status=MessageStatus.ERROR,
            )
            return

        if agent_type == "explore":
            async for event in self._spawn_explore(workflow_instance, tool_call, tool_call_id):
                yield event
        elif agent_type == "browser":
            async for event in self._spawn_browser(workflow_instance, tool_call, tool_call_id):
                yield event
        elif agent_type == "code":
            async for event in self._spawn_code(workflow_instance, tool_call, tool_call_id):
                yield event
        elif agent_type == "sub_agent":
            async for event in self._spawn_sub_agent(workflow_instance, tool_call, tool_call_id):
                yield event

    async def _spawn_explore(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Spawn explore agent - research sub-agent."""
        goal = tool_call.get("goal", "")
        task_id = str(uuid_module.uuid4())

        # IN_PROGRESS
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Exploring",
            message=goal[:200],
            status=MessageStatus.IN_PROGRESS,
            metadata={"agentType": "explore", "taskId": task_id, "fullGoal": goal},
        )

        try:
            # Fetch network metadata and local data summary in parallel
            network_metadata = await workflow.execute_activity(
                fetch_full_network_metadata,
                args=[workflow_instance.user_id],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

            local_data_summary = await workflow.execute_activity(
                fetch_local_data_summary,
                args=[workflow_instance.user_id],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

            # Run explore agent activity with pause polling (like browser agent)
            model = getattr(workflow_instance, "model", "rose-labs/rose-1-lite")
            claude_token = getattr(workflow_instance, "claude_max_token", None)
            activity_handle = workflow.start_activity(
                spawn_explore_agent_activity,
                args=[
                    workflow_instance.agent_id,
                    workflow_instance.user_id,
                    goal,
                    model,
                    network_metadata,
                    local_data_summary,
                    task_id,
                    tool_call_id,  # init_tool_call_id — progress updates reuse this to replace the init bubble
                    claude_token,
                ],
                start_to_close_timeout=timedelta(seconds=600),  # 10 min max
                heartbeat_timeout=timedelta(seconds=120),
                cancellation_type=workflow.ActivityCancellationType.TRY_CANCEL,
                retry_policy=RetryPolicy(maximum_attempts=1),  # Don't retry explore agents
            )

            # Poll for pause while activity runs
            was_cancelled = False
            while not activity_handle.done():
                await workflow_instance._check_parent_state()
                if workflow_instance.is_paused:
                    logger.info("🔴 Cancelling explore agent due to pause", goal=goal[:100])
                    activity_handle.cancel()
                    was_cancelled = True
                    break
                await workflow.sleep(1)

            # Get result
            try:
                result = await activity_handle
            except (asyncio.CancelledError, ActivityError) as e:
                if isinstance(e, ActivityError):
                    if not isinstance(e.cause, (asyncio.CancelledError, TemporalCancelledError)):
                        raise  # Re-raise non-cancellation errors
                was_cancelled = True
                result = {}

            if was_cancelled:
                logger.info("🔴 Explore agent cancelled", goal=goal[:100])
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Research cancelled",
                    message="Explore agent cancelled by user",
                    status=MessageStatus.FINISHED,
                    metadata={"agentType": "explore", "taskId": task_id, "fullGoal": goal},
                )
                return

            explore_result = result.get("result", "No results found.")
            accumulated_usage = result.get("accumulated_usage", [])
            llm_iteration_usage = result.get("llm_iteration_usage", [])

            # Use per-iteration LLM usage (has correct actual_model from Rose response)
            # instead of a single summary with the requested model name
            combined_llm = list(llm_iteration_usage)
            combined_service = []
            for usage in accumulated_usage:
                combined_llm.extend(usage.get("llm", []))
                combined_service.extend(usage.get("service", []))

            # FINISHED with result and usage
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=goal[:200],
                message=explore_result[:2000],
                status=MessageStatus.FINISHED,
                data={
                    "usage": {
                        "llm": combined_llm,
                        "service": combined_service,
                    },
                    "result": explore_result,
                },
                metadata={"agentType": "explore", "taskId": task_id, "fullGoal": goal},
            )

        except BaseException as e:
            # Catch BaseException (not just Exception) to handle asyncio.CancelledError
            # which is BaseException in Python 3.9+ and would otherwise silently exit
            # the generator, causing spawn_agent to return without FINISHED/ERROR.
            if isinstance(e, GeneratorExit):
                raise  # Never suppress GeneratorExit
            error_msg = str(e)
            logger.error("Explore agent failed", error=error_msg, goal=goal[:100], exc_type=type(e).__name__)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=goal[:200],
                message=error_msg[:500],
                status=MessageStatus.ERROR,
                metadata={"agentType": "explore", "taskId": task_id, "fullGoal": goal},
            )

    async def _spawn_browser(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Delegate to existing SpawnBrowserAgentManagerV3."""
        # Reshape tool_call to match what browser manager expects
        browser_tool_call = {
            "tool": "spawn_browser_agent",
            "start_url": tool_call.get("start_url"),
            "goal": tool_call.get("goal"),
            "output_schema": tool_call.get("output_schema"),
        }
        if tool_call.get("attachments"):
            browser_tool_call["attachments"] = tool_call["attachments"]

        manager = get_browser_manager()
        async for event in manager.execute_tool(workflow_instance, browser_tool_call, tool_call_id):
            yield event

    async def _spawn_code(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Delegate to existing SpawnClaudeCodeAgentManager."""
        # Reshape tool_call
        code_tool_call = {
            "tool": "spawn_claude_code_agent",
            "goal": tool_call.get("goal"),
            "output_schema": tool_call.get("output_schema"),
        }
        if tool_call.get("attachments"):
            code_tool_call["attachments"] = tool_call["attachments"]
        if tool_call.get("github_repo_link"):
            code_tool_call["github_repo_link"] = tool_call["github_repo_link"]

        manager = get_code_manager()
        async for event in manager.execute_tool(workflow_instance, code_tool_call, tool_call_id):
            yield event

    async def _spawn_sub_agent(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Delegate to existing SpawnSubAgentManager."""
        # Reshape to match sub_agent manager's expected format
        sub_agent_config = {
            "goal": tool_call.get("goal"),
            "output_schema": tool_call.get("output_schema"),
            "read_only": tool_call.get("read_only", False),
            "attachments": tool_call.get("attachments"),
        }
        if tool_call.get("verifier"):
            sub_agent_config["verifier"] = tool_call["verifier"]
        else:
            # Default verifier required by SubAgentConfig
            sub_agent_config["verifier"] = {
                "type": "FLOAT_LLM_JUDGE",
                "llm_judge_prompt": f"Evaluate whether the agent successfully completed: {tool_call.get('goal', '')}",
            }

        sub_agent_tool_call = {
            "tool": "spawn_sub_agent",
            "sub_agent": sub_agent_config,
        }

        manager = get_sub_agent_manager()
        async for event in manager.execute_tool(workflow_instance, sub_agent_tool_call, tool_call_id):
            yield event


def get_manager():
    return SpawnAgentManager()


# =============================================================================
# WORKFLOW HELPER (called from TOOL_EXECUTORS)
# =============================================================================

async def spawn_agent(workflow_instance, tool_call: Dict, tool_call_id: str):
    """
    Workflow helper for spawn_agent tool.

    Called from the workflow's _execute_tool method for legacy (event-driven) tools.
    """
    agent_type = tool_call.get("type", "unknown")
    workflow.logger.info(f"[spawn_agent] Starting type={agent_type}, goal={str(tool_call.get('goal', ''))[:80]}")

    manager = get_manager()
    last_status = None
    last_result = ""
    event_count = 0
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        event_count += 1
        await workflow_instance._handle_tool_event(event, tool_call_id, "spawn_agent")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
        # Capture the result from the FINISHED event so it can be piped into the parent context
        if isinstance(event, ToolEvent) and event.data and event.data.get("result"):
            last_result = event.data["result"]
        # Track usage from events (explore agent pipes accumulated usage here)
        if isinstance(event, ToolEvent) and event.data and event.data.get("usage"):
            await workflow_instance._track_usage(event.data["usage"], tool_name="spawn_agent")

    workflow.logger.info(f"[spawn_agent] Finished type={agent_type}, events={event_count}, last_status={last_status}")
    return last_status, last_result
