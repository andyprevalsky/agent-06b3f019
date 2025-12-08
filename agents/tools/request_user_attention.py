"""
Tool for requesting user attention when agent needs clarification or input.
Migrated to new event-driven architecture.

Supports auto-simulation after 60s timeout for direct LLM calls.
"""

from typing import Dict, Any, Optional, AsyncGenerator, List
from temporalio import activity, workflow
from temporalio.exceptions import TimeoutError as TemporalTimeoutError
from datetime import timedelta
import structlog
import httpx
import json
import asyncio

from config import load_config
from tools.base import ToolManager, ToolEvent, EventType, MessageStatus

logger = structlog.get_logger()

# Timeout for user response before auto-simulation (seconds)
USER_RESPONSE_TIMEOUT_SECONDS = 60


class RequestUserAttentionManager(ToolManager):
    """Manager for user attention requests."""
    
    tool_name = "request_user_attention"
    read_only = True  # Research phase tool - gets user input
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute user attention request and yield events.
        
        If simulate_user_response=True (direct LLM call), waits 60s then auto-simulates.
        If simulate_user_response=False (tool call from other tools), waits indefinitely.
        
        Yields:
            - Pre-execution status (question to user)
            - Post-execution status (after user responds or simulation)
        """
        question = tool_call.get("question", "")
        image_url = tool_call.get("image_url")
        metadata = tool_call.get("metadata")
        simulate_user_response = tool_call.get("simulate_user_response", False)
        event_metadata = None
        
        if not question:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Invalid attention request",
                message="Question is required",
                status=MessageStatus.ERROR
            )
            return
        
        # 1. Create attention request in database
        try:
            # Get workflow info
            info = workflow.info()
            workflow_id = info.workflow_id
            user_id = workflow_instance.user_id
            agent_id = workflow_instance.agent_id
            
            # Create the attention request via activity
            # Ensure all args are strings (None -> empty string)
            request_id = await workflow.execute_activity(
                create_attention_request_activity,
                args=[
                    str(user_id) if user_id else "",
                    str(agent_id) if agent_id else "",
                    str(workflow_id) if workflow_id else "",
                    str(question) if question else "",
                    str(image_url) if image_url else "",
                    metadata or None,
                ],
                start_to_close_timeout=timedelta(seconds=30),
            )
            
            if metadata or request_id:
                payload = dict(metadata or {})
                payload["attentionRequestId"] = request_id
                event_metadata = {"requestUserAttention": payload}
            
            logger.info(
                "Attention request created, waiting for user response",
                request_id=request_id,
                workflow_id=workflow_id,
                simulate_user_response=simulate_user_response
            )
            
        except Exception as e:
            # Error creating request
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Failed to create attention request",
                message=str(e),
                status=MessageStatus.ERROR,
                metadata={"requestUserAttention": metadata} if metadata else None
            )
            return
        
        # 2. Pre-execution status - show the question
        # Include timeout metadata for frontend countdown if simulation is enabled
        pre_metadata = dict(event_metadata or {})
        if simulate_user_response:
            pre_metadata["timeout"] = USER_RESPONSE_TIMEOUT_SECONDS
            pre_metadata["startTime"] = workflow.now().isoformat()
        
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="🔔 Requesting user attention",
            message=question,
            status=MessageStatus.IN_PROGRESS,
            metadata=pre_metadata
        )
        
        # 3. Wait for user response (with timeout if simulation enabled)
        user_responded = False
        simulated_response = None
        
        try:
            if simulate_user_response:
                # Wait with timeout - after 60s, auto-simulate
                try:
                    await workflow.wait_condition(
                        lambda: (
                            len(workflow_instance.context) > 0 and
                            workflow_instance.context[-1].get("role") == "USER"
                        ),
                        timeout=timedelta(seconds=USER_RESPONSE_TIMEOUT_SECONDS)
                    )
                    user_responded = True
                    logger.info(
                        "User responded within timeout",
                        request_id=request_id,
                        timeout_seconds=USER_RESPONSE_TIMEOUT_SECONDS
                    )
                except (asyncio.TimeoutError, TemporalTimeoutError):
                    # Timeout - simulate response
                    logger.info(
                        "User did not respond within timeout, simulating response",
                        request_id=request_id,
                        timeout_seconds=USER_RESPONSE_TIMEOUT_SECONDS
                    )
                    
                    # Call simulation activity
                    try:
                        simulated_response = await workflow.execute_activity(
                            simulate_user_response_activity,
                            args=[
                                str(user_id) if user_id else "",
                                question,
                                workflow_instance.context,
                            ],
                            start_to_close_timeout=timedelta(seconds=120),
                        )
                        
                        logger.info(
                            "Simulated user response generated",
                            request_id=request_id,
                            response_length=len(simulated_response) if simulated_response else 0
                        )
                        
                        # Check if user responded during simulation
                        if (len(workflow_instance.context) > 0 and
                            workflow_instance.context[-1].get("role") == "USER"):
                            logger.info(
                                "User responded during simulation, using real response",
                                request_id=request_id
                            )
                            user_responded = True
                            simulated_response = None
                        
                    except Exception as sim_error:
                        logger.error(
                            "Failed to simulate user response",
                            request_id=request_id,
                            error=str(sim_error)
                        )
                        # Fall back to waiting indefinitely
                        await workflow.wait_condition(
                            lambda: (
                                len(workflow_instance.context) > 0 and
                                workflow_instance.context[-1].get("role") == "USER"
                            )
                        )
                        user_responded = True
            else:
                # No timeout - wait indefinitely
                await workflow.wait_condition(
                    lambda: (
                        len(workflow_instance.context) > 0 and
                        workflow_instance.context[-1].get("role") == "USER"
                    )
                )
                user_responded = True
                
        except Exception as e:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Failed waiting for user response",
                message=str(e),
                status=MessageStatus.ERROR
            )
            return
        
        # 4. Get the response
        if user_responded:
            # Get real user response from context
            wf_context = workflow_instance.context
            user_messages = []
            
            # Walk backwards and collect all consecutive USER messages
            for i in range(len(wf_context) - 1, -1, -1):
                if wf_context[i].get("role") == "USER":
                    user_messages.insert(0, wf_context[i].get("text", ""))
                else:
                    break
            
            response_text = "\n\n".join(user_messages)
            
            logger.info(
                "User response received",
                request_id=request_id,
                response_length=len(response_text)
            )
            
            # 5. Success status
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="✓ User message received",
                message="",
                status=MessageStatus.FINISHED,
                metadata=event_metadata
            )
        else:
            # Use simulated response
            response_text = simulated_response or "I trust your judgment, proceed as you see fit."
            
            logger.info(
                "Using simulated response",
                request_id=request_id,
                response_length=len(response_text)
            )
            
            # Add simulated response to context as USER message
            # This allows the agent to see and use the simulated response
            workflow_instance.context.append({
                "role": "USER",
                "text": response_text,
                "timestamp": workflow.now().isoformat(),
                "metadata": {"simulated": True}
            })
            
            # 5. Success status with simulated flag
            finish_metadata = dict(event_metadata or {})
            finish_metadata["simulated"] = True
            
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="✓ Auto-answered (no response within 60s)",
                message=response_text,
                status=MessageStatus.FINISHED,
                metadata=finish_metadata
            )


# ========================================
# ACTIVITY IMPLEMENTATION
# ========================================

@activity.defn
async def simulate_user_response_activity(
    user_id: str,
    question: str,
    context: List[Dict[str, Any]],
) -> str:
    """
    Activity: Simulate a user response using LLM.
    
    Creates a 1-1 mirror of the user's mind by:
    1. Fetching user's communication style from recent messages (7 days)
    2. Transforming agent context (flip roles: ASSISTANT->user, USER->assistant, TOOL->user)
    3. Using rose-labs/rose-1-fast with SMART model_preference to generate an authentic response
    
    Args:
        user_id: User ID for fetching context
        question: The question the agent is asking
        context: Agent's conversation context
        
    Returns:
        Simulated user response string
    """
    from helpers.get_user_context import fetch_user_context, fetch_frequent_contact_messages, format_messages_for_simulation
    from openai import AsyncOpenAI
    
    try:
        activity.heartbeat("Fetching user context for simulation...")
        
        config = load_config()
        
        # Fetch user profile and messages in parallel
        user_context_task = fetch_user_context(user_id)
        messages_task = fetch_frequent_contact_messages(user_id)
        
        import asyncio
        user_context_str, user_messages = await asyncio.gather(
            user_context_task,
            messages_task
        )
        
        activity.heartbeat("Building simulation prompt...")
        
        # Extract user name from context if available
        user_name = "User"
        if "Name:" in user_context_str:
            try:
                name_line = [line for line in user_context_str.split('\n') if 'Name:' in line][0]
                user_name = name_line.split('Name:')[1].strip()
            except:
                pass
        
        # Format messages for simulation
        message_samples = format_messages_for_simulation(user_messages, user_name)
        
        # Build system prompt
        system_prompt = f"""You are {user_name}. You are responding to your AI assistant.

{user_context_str}

Here is how you communicate (your real messages from the past week):

{message_samples if message_samples else "No recent messages available."}

Respond as yourself. Your response should be indistinguishable from what you would actually type."""

        # Transform context: flip roles for simulation
        # ASSISTANT -> user (the assistant asking questions)
        # USER -> assistant (what the simulated user previously said)
        # TOOL -> user (tool results shown to user)
        # SYSTEM -> system
        transformed_messages = [{"role": "system", "content": system_prompt}]
        
        for msg in context:
            role = msg.get("role", "")
            text = msg.get("text", "")
            
            if not text.strip():
                continue
            
            if role == "ASSISTANT":
                transformed_messages.append({"role": "user", "content": text})
            elif role == "USER":
                transformed_messages.append({"role": "assistant", "content": text})
            elif role == "TOOL":
                # Include tool results as user messages (info shown to user)
                metadata = msg.get("metadata", {})
                title = metadata.get("title", "")
                content = f"[Tool: {title}] {text}" if title else text
                transformed_messages.append({"role": "user", "content": content})
            elif role == "SYSTEM":
                transformed_messages.append({"role": "system", "content": text})
        
        # Add the current question as the final user message
        transformed_messages.append({"role": "user", "content": question})
        
        activity.heartbeat("Calling LLM for simulation...")
        
        # Call rose-labs/rose-1-fast with SMART model preference
        request_body = {
            "model": "rose-labs/rose-1-fast",
            "model_preference": "SMART",
            "messages": transformed_messages,
            "temperature": 0.7,
            "max_tokens": 1000,
        }
        
        async with httpx.AsyncClient(timeout=120.0) as http_client:
            response = await http_client.post(
                config.rose.api_url,
                json=request_body,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {config.rose.supabase_anon_key}",
                    "x-api-key": config.rose.api_key,
                }
            )
            
            if response.status_code != 200:
                error_body = response.text[:1000] if response.text else "No response body"
                logger.error(
                    "Rose API error in simulation",
                    status_code=response.status_code,
                    error_body=error_body
                )
            
            response.raise_for_status()
        
        data = response.json()
        simulated_response = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        
        logger.info(
            "User response simulated",
            user_id=user_id[:8] if user_id else "unknown",
            response_length=len(simulated_response),
            actual_model=data.get("actual_model", "unknown")
        )
        
        return simulated_response.strip() if simulated_response else "Proceed as you see fit."
        
    except Exception as e:
        logger.error(
            "Failed to simulate user response",
            user_id=user_id[:8] if user_id else "unknown",
            error=str(e)
        )
        # Return a safe fallback response
        return "I trust your judgment, proceed as you see fit."


@activity.defn
async def create_attention_request_activity(
    user_id: str,
    agent_id: str,
    workflow_id: str,
    question: str,
    image_url: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Activity: Create an attention request in the database.
    
    Args:
        user_id: User ID
        agent_id: Agent ID
        workflow_id: Temporal workflow ID
        question: Question to ask the user
        image_url: Optional image URL (e.g. product thumbnail)
    
    Returns:
        The ID of the created request
    """
    try:
        config = load_config()
        backend_url = config.backend.api_url
        
        payload: Dict[str, Any] = {
            "userId": user_id,
            "agentId": agent_id,
            "workflowId": workflow_id,
            "question": question,
        }
        
        # Only include imageUrl if provided
        if image_url:
            payload["imageUrl"] = image_url

        if metadata:
            payload["metadata"] = metadata
        
        logger.info(
            "Creating attention request",
            payload=payload,
            backend_url=backend_url
        )
        
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{backend_url}/api/attention-requests",
                json=payload,
                timeout=30.0
            )
            
            if response.status_code != 200:
                logger.error(
                    "Failed to create attention request - HTTP error",
                    status_code=response.status_code,
                    response_body=response.text,
                    payload=payload
                )
            
            response.raise_for_status()
            data = response.json()
            
            request_id = data.get("id")
            logger.info(
                "Attention request created",
                request_id=request_id,
                agent_id=agent_id,
                question=question[:100]
            )
            
            return request_id
            
    except Exception as e:
        logger.error("Failed to create attention request", error=str(e))
        raise


# ========================================
# SINGLETON
# ========================================

_manager: Optional[RequestUserAttentionManager] = None


def get_manager() -> RequestUserAttentionManager:
    """Get or create request user attention manager singleton."""
    global _manager
    if _manager is None:
        _manager = RequestUserAttentionManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def request_user_attention(workflow_instance, tool_call: Dict[str, Any], tool_call_id: str) -> None:
    """
    Workflow helper for request_user_attention (new event-driven system).
    
    This replaces the old request_user_attention function.
    Yields events instead of returning a value.
    """
    manager = get_manager()
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "request_user_attention")


# ========================================
# DIRECT CALL HELPER (for other tools)
# ========================================

async def request_user_attention_direct(
    workflow_instance,
    question: str,
    image_url: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, str]:
    """
    Direct call helper for tools that need to request user attention with simple parameters.
    
    This is a wrapper around the new event-driven system that maintains the old API.
    Used by tools that make direct calls.
    
    Args:
        workflow_instance: The workflow instance (self)
        question: The question to ask the user
        image_url: Optional image URL (e.g. product thumbnail)
        
    Returns:
        Dict with:
            - response: The user's response text
            - question: Original question (for context)
    """
    # Get workflow info
    info = workflow.info()
    workflow_id = info.workflow_id
    user_id = workflow_instance.user_id
    agent_id = workflow_instance.agent_id
    
    # Create tool_call_id
    tool_call_id = workflow.uuid4()
    
    # Post pre-execution message
    event_metadata = None
    metadata_payload: Optional[Dict[str, Any]] = None
    
    # Create the attention request via activity
    try:
        # Ensure all args are strings (None -> empty string)
        request_id = await workflow.execute_activity(
            create_attention_request_activity,
            args=[
                str(user_id) if user_id else "",
                str(agent_id) if agent_id else "",
                str(workflow_id) if workflow_id else "",
                str(question) if question else "",
                str(image_url) if image_url else "",
                metadata or None,
            ],
            start_to_close_timeout=timedelta(seconds=30),
        )
        
        logger.info(
            "Attention request created, waiting for user response",
            request_id=request_id,
            workflow_id=workflow_id
        )
        
        metadata_payload = dict(metadata or {})
        metadata_payload["attentionRequestId"] = request_id
        event_metadata = {"requestUserAttention": metadata_payload}
        
    except Exception as e:
        # Post error message
        error_event = ToolEvent(
            type=EventType.POST_MESSAGE,
            title="❌ Failed to create attention request",
            message=str(e),
            status=MessageStatus.ERROR,
            metadata={"requestUserAttention": metadata} if metadata else None
        )
        await workflow_instance._handle_tool_event(error_event, tool_call_id, "request_user_attention")
        raise
    
    pre_event = ToolEvent(
        type=EventType.POST_MESSAGE,
        title="🔔 Requesting user attention",
        message=question,
        status=MessageStatus.IN_PROGRESS,
        metadata=event_metadata
    )
    await workflow_instance._handle_tool_event(pre_event, tool_call_id, "request_user_attention")
    
    # Wait for user response
    await workflow.wait_condition(
        lambda: (
            len(workflow_instance.context) > 0 and
            workflow_instance.context[-1].get("role") == "USER"
        )
    )
    
    # Get the response from all consecutive USER messages at the end
    wf_context = workflow_instance.context
    user_messages = []
    
    # Walk backwards and collect all consecutive USER messages
    for i in range(len(wf_context) - 1, -1, -1):
        if wf_context[i].get("role") == "USER":
            user_messages.insert(0, wf_context[i].get("text", ""))
        else:
            break
    
    response_text = "\n\n".join(user_messages)
    
    logger.info(
        "User response received",
        request_id=request_id,
        response_length=len(response_text)
    )
    
    # Post success message
    post_event = ToolEvent(
        type=EventType.POST_MESSAGE,
        title="✓ User message received",
        message="",
        status=MessageStatus.FINISHED,
        metadata=event_metadata
    )
    await workflow_instance._handle_tool_event(post_event, tool_call_id, "request_user_attention")
    
    return {
        "response": response_text,
        "question": question,
        "attention_request_id": metadata_payload.get("attentionRequestId") if metadata_payload else None,
    }

