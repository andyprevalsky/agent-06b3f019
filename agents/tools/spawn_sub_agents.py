"""Event-driven spawn_sub_agent tool implementation."""

import asyncio
import random
from dataclasses import asdict
from typing import List, Dict, Any, AsyncGenerator
from datetime import timedelta
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
import httpx
import structlog
import structlog.contextvars

from tools.base import ToolManager, ToolEvent, AssistantEvent, EventType, MessageStatus
from config import load_config
from helpers.attachments import FilePointer, extract_attachments_from_context

logger = structlog.get_logger()


def extract_error_message(e: Exception) -> str:
    """
    Extract the actual error message from an exception, unwrapping Temporal wrappers.

    Temporal wraps activity failures in ActivityError/ApplicationError which have
    generic messages like "Activity task failed". The real error is in .cause.
    """
    current = e
    messages = []

    while current is not None:
        msg = str(current)
        if msg and msg not in ("Activity task failed", ""):
            messages.append(msg)

        if hasattr(current, "cause") and current.cause is not None:
            current = current.cause
        elif hasattr(current, "__cause__") and current.__cause__ is not None:
            current = current.__cause__
        else:
            break

    if messages:
        return messages[-1] if len(messages) > 1 else messages[0]
    return str(e) or "Unknown error"


def extract_file_pointers_from_structured_response(
    structured_response: Dict[str, Any],
    output_schema: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """
    Extract FilePointer dicts from structured_response based on output_schema field types.

    Args:
        structured_response: The response dict from sub-agent verifier
        output_schema: The output schema with field definitions

    Returns:
        List of FilePointer dicts found in the structured response
    """
    if not structured_response or not output_schema:
        return []

    file_pointers = []
    fields = output_schema.get("fields", [])

    for field in fields:
        field_name = field.get("name")
        field_type = field.get("type")

        if not field_name or field_name not in structured_response:
            continue

        value = structured_response[field_name]

        if field_type == "file_pointer":
            # Single file pointer
            if value and isinstance(value, dict) and value.get("id") and value.get("storage_path"):
                file_pointers.append(value)
        elif field_type == "list[file_pointer]":
            # List of file pointers
            if isinstance(value, list):
                for item in value:
                    if item and isinstance(item, dict) and item.get("id") and item.get("storage_path"):
                        file_pointers.append(item)

    return file_pointers


class SpawnSubAgentManager(ToolManager):
    """Manager for spawn_sub_agent tool using event-driven architecture."""

    @property
    def tool_name(self) -> str:
        return "spawn_sub_agent"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute spawn_sub_agent tool with event-driven architecture.

        Args:
            workflow_instance: The workflow instance
            tool_call: Dict with "sub_agent" field (single sub-agent config)
            tool_call_id: Unique ID for this tool call

        Yields:
            - Pre-execution status
            - Post-execution status with result
        """
        sub_agent = tool_call.get("sub_agent")

        if not sub_agent:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Sub-agent failed",
                message="No sub-agent specified",
                status=MessageStatus.ERROR,
                metadata={"toolName": "spawn_sub_agent"},
            )
            return

        goal = sub_agent.get("goal", "Unknown goal")

        try:
            # Get workflow info
            info = workflow.info()
            user_id = workflow_instance.user_id
            parent_agent_id = workflow_instance.agent_id
            parent_workflow_id = info.workflow_id
            depth = getattr(workflow_instance, 'depth', 0) + 1
            parent_is_paused = getattr(workflow_instance, 'is_paused', False)

            # Check depth limit
            MAX_DEPTH = 4  # Allow up to 4 levels of nesting
            if workflow_instance.depth >= MAX_DEPTH:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Sub-agent failed",
                    message=f"Cannot spawn sub-agent: maximum nesting depth ({MAX_DEPTH}) reached.",
                    status=MessageStatus.ERROR
                )
                return

            # Determine busId for children:
            # - If parent has a busId, children inherit it
            # - If parent is root (no busId), children use parent's agentId as busId
            parent_bus_id = getattr(workflow_instance, 'bus_id', None)
            if parent_bus_id is None:
                # Parent is root - children use parent's agentId as busId
                bus_id = parent_agent_id
                # Also set parent's bus_id so it broadcasts its own state
                workflow_instance.bus_id = bus_id
                # Broadcast parent's initial state to the bus
                await workflow_instance._update_tree_state()
            else:
                # Inherit parent's busId
                bus_id = parent_bus_id

            # 2. Execute spawn activity (wrap single sub_agent in list for activity)
            parent_model = getattr(workflow_instance, 'model', 'rose-labs/rose-1-lite')
            parent_source = getattr(workflow_instance, 'agent_source', 'WEB')
            result = await workflow.execute_activity(
                spawn_sub_agent_activity,
                args=[user_id, [sub_agent], parent_agent_id, parent_workflow_id, depth, parent_is_paused, parent_model, bus_id, parent_source],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

            # 3. Set up child tracking and post initial message
            agents_list = result.get("agents", [])

            if not agents_list:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Sub-agent failed",
                    message="Failed to spawn sub-agent",
                    status=MessageStatus.ERROR
                )
                return

            child_info = agents_list[0]
            if "error" in child_info:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Sub-agent failed",
                    message=f"Error: {child_info.get('error', 'Unknown error')}",
                    status=MessageStatus.ERROR
                )
                return

            logger.info("✅ Spawned sub-agent, setting up tracking...")

            # Use the passed tool_call_id for consistent message tracking
            child_tool_id = tool_call_id
            child_agent_id = child_info["agent_id"]

            # Store mapping: agent_id -> tool_call_id
            # Signal handlers will use this to update the right message
            workflow_instance.child_tool_ids[child_agent_id] = child_tool_id
            workflow_instance.pending_children.add(child_agent_id)

            # Store mapping: agent_id -> temporal_workflow_id (for cost limit signaling)
            child_temporal_workflow_id = child_info.get("temporal_workflow_id")
            if child_temporal_workflow_id:
                workflow_instance.child_workflow_ids[child_agent_id] = child_temporal_workflow_id

            # Post initial IN_PROGRESS message with subAgentId
            # This creates the message that signals will update
            await workflow_instance._post_message(
                child_info['goal'],
                "TOOL",
                metadata={
                    "toolCallId": child_tool_id,
                    "toolName": "spawn_sub_agent",
                    "toolStatus": "IN_PROGRESS",
                    "title": "Sub-agent starting",
                    "subAgentId": child_agent_id,
                    "progress": 0.0
                }
            )

            # 4. Post summary message (agent spawned, waiting for completion)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Spawning sub-agent",
                message="",
                status=MessageStatus.IN_PROGRESS,
                metadata={
                    "toolName": "spawn_sub_agent",
                    "subAgentIds": [child_agent_id],
                    "busId": bus_id,
                }
            )

            # 5. Wait for child to complete (via signals)
            logger.info(f"⏳ Waiting for sub-agent {child_agent_id} to complete...")

            await workflow.wait_condition(
                lambda cid=child_agent_id: cid in workflow_instance.child_results
            )

            # 6. Check if child failed
            child_result = workflow_instance.child_results.get(child_agent_id, {})
            child_status = child_result.get("status", "completed")

            if child_status == "failed":
                error_reason = child_result.get("error_reason", "unknown")
                failure_context = child_result.get("failure_context", {})
                trajectory = failure_context.get("trajectory", [])
                last_reasoning = failure_context.get("last_reasoning")
                last_plan = failure_context.get("last_plan")
                progress_estimate = failure_context.get("progress_estimate", "Unknown")
                verifier_reasoning = failure_context.get("verifier_reasoning")
                partial_structured_response = failure_context.get("partial_structured_response")

                logger.warning(f"❌ Sub-agent {child_agent_id} failed: {error_reason}")

                # Build comprehensive error message for parent to learn from
                error_parts = [f"Sub-agent failed: {error_reason}"]
                error_parts.append(f"Progress: {progress_estimate}")

                # Include verifier reasoning (why task isn't complete)
                if verifier_reasoning:
                    error_parts.append(f"\nWhy not complete:\n{verifier_reasoning[:400]}")

                # Include partial structured data if extracted
                if partial_structured_response and isinstance(partial_structured_response, dict):
                    partial_lines = ["\nPartial data extracted:"]
                    for key, value in list(partial_structured_response.items())[:5]:
                        formatted_key = key.replace("_", " ").title()
                        if isinstance(value, str) and len(value) > 100:
                            value = value[:100] + "..."
                        elif isinstance(value, list):
                            value = f"[{len(value)} items]"
                        partial_lines.append(f"- {formatted_key}: {value}")
                    error_parts.append("\n".join(partial_lines))

                # Include what the agent was trying to do (last reasoning)
                if last_reasoning:
                    error_parts.append(f"\nLast thought:\n{last_reasoning[:300]}...")

                # Include the plan if it had one
                if last_plan:
                    error_parts.append(f"\nPlan was:\n" + "\n".join(f"- {g}" for g in last_plan[:5]))

                # Include trajectory
                if trajectory:
                    trajectory_lines = []
                    for step in trajectory[:10]:
                        icon = "✓" if step.get("success") else "✗"
                        tool = step.get("tool_name", "unknown")
                        err = step.get("error_message", "")[:50] if not step.get("success") else ""
                        trajectory_lines.append(f"{icon} {tool}" + (f": {err}" if err else ""))
                    error_parts.append(f"\nTrajectory:\n" + "\n".join(trajectory_lines))

                error_message = "\n".join(error_parts)

                # Clean up stored result
                workflow_instance.child_results.pop(child_agent_id, None)

                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Sub-agent failed",
                    message=error_message,
                    status=MessageStatus.ERROR,
                    metadata={
                        "subAgentIds": [child_agent_id],
                        "busId": bus_id,
                        "error_reason": error_reason,
                        "failure_context": failure_context,  # Include full context for structured access
                    }
                )
                return  # Don't continue to success path

            logger.info(f"🎉 Sub-agent {child_agent_id} completed!")

            # 7. Extract file pointers from child result and yield as ASSISTANT messages
            structured_response = child_result.get("structured_response", {})
            output_schema = sub_agent.get("output_schema", {})

            file_pointers = extract_file_pointers_from_structured_response(
                structured_response, output_schema
            )

            if file_pointers:
                logger.info(
                    "Posting sub-agent output files as ASSISTANT messages",
                    child_agent_id=child_agent_id,
                    file_count=len(file_pointers),
                )
                for fp in file_pointers:
                    yield AssistantEvent(
                        message="",
                        file_pointer=fp,
                    )

            # Save summary before cleanup (child_result is popped below)
            child_summary = child_result.get("summary", "") or f"Completed: {child_info.get('goal', '')}"

            # Clean up stored result
            workflow_instance.child_results.pop(child_agent_id, None)

            # 8. Post final FINISHED message (replaces IN_PROGRESS via toolCallId dedup)
            # Include structured_response so parent verifier can extract full FilePointers
            # Include summary in message so build_llm_messages dedup preserves it
            # (this is the latest FINISHED message per toolCallId, so it wins over
            # the earlier child_completed summary posted by the signal handler)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Spawning sub-agent",
                message=child_summary,
                status=MessageStatus.FINISHED,
                metadata={
                    "toolName": "spawn_sub_agent",
                    "subAgentIds": [child_agent_id],
                    "busId": bus_id,
                    "structured_response": structured_response,
                }
            )

        except Exception as e:
            error_msg = extract_error_message(e)
            logger.error("Failed to spawn sub-agent", error=error_msg)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Sub-agent failed",
                message=f"Error spawning sub-agent: {error_msg}",
                status=MessageStatus.ERROR,
                metadata={"toolName": "spawn_sub_agent"},
            )


# Singleton instance
_manager_instance = None


def get_manager() -> SpawnSubAgentManager:
    """Get or create manager singleton."""
    global _manager_instance
    if _manager_instance is None:
        _manager_instance = SpawnSubAgentManager()
    return _manager_instance


# ============================================================================
# TEMPORAL ACTIVITY
# ============================================================================


@activity.defn
async def spawn_sub_agent_activity(
    user_id: str,
    sub_agents: List[Dict[str, Any]],
    parent_agent_id: str,
    parent_workflow_id: str,
    depth: int,
    parent_is_paused: bool,
    parent_model: str = "rose-labs/rose-1-lite",
    bus_id: str = None,
    parent_source: str = "WEB"
) -> Dict[str, Any]:
    """
    Activity: Spawn multiple sub-agents to work on parallel subtasks.

    Args:
        user_id: User ID (agents will be created for this user)
        sub_agents: List of agent configs, each with:
            - goal (str): The subtask goal
            - verifier (dict): {"type": "FLOAT_LLM_JUDGE", "llm_judge_prompt": "..."}
            - start_phase (str, optional): "plan" (default) or "execute"
            - attachments (list[str], optional): Filenames to pass to this sub-agent
        parent_agent_id: Parent agent ID (for hierarchy)
        parent_workflow_id: Parent workflow ID (for signaling)
        depth: Nesting depth for children
        parent_is_paused: Whether parent is currently paused (children inherit this state)
        parent_model: Model from parent agent (inherited by all sub-agents)
        bus_id: Shared bus channel ID for sub-agent tree updates
        parent_source: Agent source from parent (WEB or MAC_APP), inherited by sub-agents

    Returns:
        Dict with summary: {"spawned": int, "completed": int, "failed": int, "agents": [...]}
    """
    structlog.contextvars.bind_contextvars(agent_id=parent_agent_id)

    try:
        activity.heartbeat(f"Spawning {len(sub_agents)} sub-agents")

        # Get config
        config = load_config()
        backend_url = config.backend.api_url.rstrip('/')
        api_key = config.backend.api_key

        if not api_key:
            raise ValueError("BACKEND_API_KEY not configured - required for spawning sub-agents")

        # Always fetch parent's attachments so they can auto-forward to sub-agents
        # that don't explicitly specify attachments (prevents file propagation gaps)
        filename_to_pointer: Dict[str, Dict[str, Any]] = {}
        all_pointers_by_id: Dict[str, Dict[str, Any]] = {}
        activity.heartbeat("Fetching parent agent's attachments...")
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(
                    f"{backend_url}/api/agents/{parent_agent_id}",
                    headers={
                        "X-API-Key": api_key,
                        "Content-Type": "application/json"
                    },
                )
                response.raise_for_status()
                parent_data = response.json()
                parent_messages = parent_data.get("messages", [])

                # Extract FilePointers from parent's context
                file_pointers = extract_attachments_from_context(parent_messages)

                # Build filename -> FilePointer dict lookup (last wins on dupes)
                # Also keep a full list keyed by ID for forwarding all attachments
                for fp in file_pointers:
                    fp_dict = asdict(fp)
                    filename_to_pointer[fp.original_filename] = fp_dict
                    if fp.id:
                        all_pointers_by_id[fp.id] = fp_dict

                logger.info(
                    "Extracted parent attachments",
                    parent_agent_id=parent_agent_id,
                    attachment_count=len(file_pointers),
                    filenames=list(filename_to_pointer.keys())
                )
        except Exception as e:
            logger.warning(f"Failed to fetch parent attachments: {e}")
            # Continue without attachments - don't fail the spawn

        # Spawn strategy:
        # - Pool pattern with max 10 parallel spawn requests
        # - Per-agent retries with exponential backoff + jitter
        # - Attempt ALL agents before returning (never exit early on partial failures)
        MAX_PARALLEL_SPAWNS = 10
        MAX_SPAWN_ATTEMPTS = 4
        BASE_BACKOFF_SECONDS = 0.5
        RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}

        async with httpx.AsyncClient(timeout=30.0) as client:
            semaphore = asyncio.Semaphore(MAX_PARALLEL_SPAWNS)

            async def spawn_one_with_retry(index: int, agent_cfg: Dict[str, Any]) -> tuple[int, Dict[str, Any]]:
                async with semaphore:
                    goal = agent_cfg.get("goal", "")
                    activity.heartbeat(f"Spawning sub-agent {index + 1}/{len(sub_agents)}")

                    # Resolve attachments for this sub-agent
                    resolved_attachments = []
                    # Build ID lookup for cases where LLM passes UUIDs instead of filenames
                    id_to_pointer = {v.get("id", ""): v for v in filename_to_pointer.values() if v.get("id")}
                    if agent_cfg.get("attachments"):
                        for filename in agent_cfg["attachments"]:
                            if filename in filename_to_pointer:
                                resolved_attachments.append(filename_to_pointer[filename])
                            elif filename in id_to_pointer:
                                resolved_attachments.append(id_to_pointer[filename])
                            else:
                                logger.warning(
                                    f"Attachment not found in parent context: {filename}",
                                    available_files=list(filename_to_pointer.keys())
                                )
                    # Use all_pointers_by_id for forwarding to preserve duplicate filenames
                    all_attachments = list(all_pointers_by_id.values()) if all_pointers_by_id else list(filename_to_pointer.values())
                    # If explicit resolution found nothing, auto-forward all
                    if agent_cfg.get("attachments") and not resolved_attachments and filename_to_pointer:
                        logger.info(
                            "Explicit attachment resolution failed, auto-forwarding all parent attachments",
                            index=index,
                            requested=agent_cfg["attachments"],
                            num_files=len(all_attachments),
                            filenames=list(filename_to_pointer.keys())
                        )
                        resolved_attachments = all_attachments
                    elif not agent_cfg.get("attachments") and filename_to_pointer:
                        # Auto-forward all parent attachments when none explicitly requested
                        logger.info(
                            "Auto-forwarding parent attachments to sub-agent",
                            index=index,
                            num_files=len(all_attachments),
                            filenames=list(filename_to_pointer.keys())
                        )
                        resolved_attachments = all_attachments

                    # start_phase must be strict: plan | execute
                    start_phase = str(agent_cfg.get("start_phase", "plan")).strip().lower()
                    if start_phase not in {"plan", "execute"}:
                        start_phase = "plan"

                    payload = {
                        "user_id": user_id,  # For internal auth
                        "goal": goal,
                        "verifier": agent_cfg["verifier"],
                        "start_phase": start_phase,
                        "parent_agent_id": parent_agent_id,
                        "parent_workflow_id": parent_workflow_id,
                        "depth": depth,
                        "pause_state": parent_is_paused,  # Inherit parent's pause state
                        "response_schema": agent_cfg.get("output_schema"),
                        "bus_id": bus_id,  # Shared bus channel for tree updates
                        "max_iterations": 25,
                        "source": parent_source,  # Inherit source from parent
                        "model": parent_model,  # Always inherit model from parent
                    }
                    if resolved_attachments:
                        payload["attachments"] = resolved_attachments
                    if agent_cfg.get("context_gates"):
                        payload["context_gates"] = agent_cfg["context_gates"]

                    last_error = "unknown error"
                    for attempt in range(1, MAX_SPAWN_ATTEMPTS + 1):
                        try:
                            logger.info(
                                "Spawning sub-agent",
                                index=index,
                                attempt=attempt,
                                payload=payload,
                            )
                            response = await client.post(
                                f"{backend_url}/api/agents",
                                headers={
                                    "X-API-Key": api_key,
                                    "Content-Type": "application/json"
                                },
                                json=payload
                            )

                            # Success
                            if response.is_success:
                                data = response.json()
                                logger.info(
                                    "Sub-agent spawned",
                                    agent_id=data.get("agent_id"),
                                    workflow_id=data.get("temporal_workflow_id"),
                                    goal=data.get("goal", goal),
                                    index=index,
                                )
                                return index, {
                                    "agent_id": data["agent_id"],
                                    "temporal_workflow_id": data["temporal_workflow_id"],
                                    "goal": data["goal"],
                                    "model": data["model"],
                                    "status": data["status"]
                                }

                            # Retryable HTTP error
                            status_code = response.status_code
                            response_text = response.text[:500]
                            last_error = f"HTTP {status_code}: {response_text}"
                            if status_code in RETRYABLE_STATUS_CODES and attempt < MAX_SPAWN_ATTEMPTS:
                                delay = BASE_BACKOFF_SECONDS * (2 ** (attempt - 1))
                                jitter = random.uniform(0, delay * 0.3)
                                sleep_s = delay + jitter
                                logger.warning(
                                    "Retrying sub-agent spawn after HTTP error",
                                    index=index,
                                    attempt=attempt,
                                    status_code=status_code,
                                    sleep_seconds=round(sleep_s, 2),
                                )
                                await asyncio.sleep(sleep_s)
                                continue

                            # Non-retryable or exhausted retries
                            logger.error(
                                "Failed to spawn sub-agent - HTTP error",
                                index=index,
                                goal=goal,
                                status_code=status_code,
                                response_text=response_text,
                            )
                            break

                        except Exception as e:
                            last_error = str(e)
                            if attempt < MAX_SPAWN_ATTEMPTS:
                                delay = BASE_BACKOFF_SECONDS * (2 ** (attempt - 1))
                                jitter = random.uniform(0, delay * 0.3)
                                sleep_s = delay + jitter
                                logger.warning(
                                    "Retrying sub-agent spawn after exception",
                                    index=index,
                                    attempt=attempt,
                                    error=last_error,
                                    sleep_seconds=round(sleep_s, 2),
                                )
                                await asyncio.sleep(sleep_s)
                                continue
                            logger.error(
                                "Failed to spawn sub-agent - exception",
                                index=index,
                                goal=goal,
                                error=last_error,
                            )
                            break

                    return index, {
                        "error": last_error,
                        "goal": goal,
                        "status": "FAILED"
                    }

            # Schedule all spawns with bounded concurrency (pool pattern)
            tasks = [
                asyncio.create_task(spawn_one_with_retry(i, agent_cfg))
                for i, agent_cfg in enumerate(sub_agents)
            ]

            spawned: List[Dict[str, Any]] = [{} for _ in sub_agents]
            for finished in asyncio.as_completed(tasks):
                idx, result = await finished
                spawned[idx] = result
            
            # Count results
            completed = sum(1 for s in spawned if s.get("status") != "FAILED")
            failed = sum(1 for s in spawned if s.get("status") == "FAILED")
            
            return {
                "spawned": len(spawned),
                "completed": completed,
                "failed": failed,
                "agents": spawned
            }
            
    except Exception as e:
        logger.error("Failed to spawn sub-agents", error=str(e))
        raise


# ============================================================================
# WORKFLOW HELPER
# ============================================================================


async def spawn_sub_agent(workflow_instance, tool_call: Dict, tool_call_id: str):
    """
    Workflow helper for spawn_sub_agent tool.

    This function is called from the workflow's _execute_tool method for
    event-driven tools.
    """
    manager = get_manager()
    last_status = None
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "spawn_sub_agent")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status

    return last_status
