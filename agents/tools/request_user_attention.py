"""
Tool for requesting user attention when agent needs clarification or input.
Migrated to new event-driven architecture.
"""

from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import activity, workflow
from datetime import timedelta
import structlog
import httpx

from config import load_config
from tools.base import ToolManager, ToolEvent, EventType, MessageStatus

logger = structlog.get_logger()


class RequestUserAttentionManager(ToolManager):
    """Manager for user attention requests."""
    
    tool_name = "request_user_attention"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute user attention request and yield events.
        
        Yields:
            - Pre-execution status (question to user)
            - Post-execution status (after user responds)
        """
        question = tool_call.get("question", "")
        image_url = tool_call.get("image_url")
        
        if not question:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Invalid attention request",
                message="Question is required",
                status=MessageStatus.ERROR
            )
            return
        
        # 1. Pre-execution status - show the question
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="🔔 Requesting user attention",
            message=question,
            status=MessageStatus.IN_PROGRESS
        )
        
        # 2. Create attention request in database
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
                    str(image_url) if image_url else ""
                ],
                start_to_close_timeout=timedelta(seconds=30),
            )
            
            logger.info(
                "Attention request created, waiting for user response",
                request_id=request_id,
                workflow_id=workflow_id
            )
            
        except Exception as e:
            # Error creating request
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Failed to create attention request",
                message=str(e),
                status=MessageStatus.ERROR
            )
            return
        
        # 3. Wait for user response
        # The signal handler will post a USER message and add it to context
        # We wait until the last message is from USER
        try:
            await workflow.wait_condition(
                lambda: (
                    len(workflow_instance.context) > 0 and
                    workflow_instance.context[-1].get("role") == "USER"
                )
            )
        except Exception as e:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Failed waiting for user response",
                message=str(e),
                status=MessageStatus.ERROR
            )
            return
        
        # 4. Get the response from all consecutive USER messages at the end
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
            status=MessageStatus.FINISHED
        )


# ========================================
# ACTIVITY IMPLEMENTATION
# ========================================

@activity.defn
async def create_attention_request_activity(
    user_id: str,
    agent_id: str,
    workflow_id: str,
    question: str,
    image_url: Optional[str] = None,
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
        
        payload = {
            "userId": user_id,
            "agentId": agent_id,
            "workflowId": workflow_id,
            "question": question,
        }
        
        # Only include imageUrl if provided
        if image_url:
            payload["imageUrl"] = image_url
        
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
) -> Dict[str, str]:
    """
    Direct call helper for tools that need to request user attention with simple parameters.
    
    This is a wrapper around the new event-driven system that maintains the old API.
    Used by tools like amazon_shopping that make direct calls.
    
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
    pre_event = ToolEvent(
        type=EventType.POST_MESSAGE,
        title="🔔 Requesting user attention",
        message=question,
        status=MessageStatus.IN_PROGRESS
    )
    await workflow_instance._handle_tool_event(pre_event, tool_call_id, "request_user_attention")
    
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
                str(image_url) if image_url else ""
            ],
            start_to_close_timeout=timedelta(seconds=30),
        )
        
        logger.info(
            "Attention request created, waiting for user response",
            request_id=request_id,
            workflow_id=workflow_id
        )
        
    except Exception as e:
        # Post error message
        error_event = ToolEvent(
            type=EventType.POST_MESSAGE,
            title="❌ Failed to create attention request",
            message=str(e),
            status=MessageStatus.ERROR
        )
        await workflow_instance._handle_tool_event(error_event, tool_call_id, "request_user_attention")
        raise
    
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
        status=MessageStatus.FINISHED
    )
    await workflow_instance._handle_tool_event(post_event, tool_call_id, "request_user_attention")
    
    return {
        "response": response_text,
        "question": question
    }

