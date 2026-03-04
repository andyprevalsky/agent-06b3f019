"""
Tool for requesting user approval when agent needs authorization for actions.

This is used by other tools (like message_person, send_sms_as_user) to gate
write actions that require explicit user approval. Creates an attention request
in the database and waits for user response.

This is NOT called directly by the LLM - it's used internally by tools.
"""

from typing import Dict, Any, Optional, AsyncGenerator, List
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx

from config import load_config
from tools.base import ToolManager, ToolEvent, EventType, MessageStatus

logger = structlog.get_logger()


class UserRejectedError(Exception):
    """Raised when user rejects an approval request."""
    pass


class RequestUserApprovalManager(ToolManager):
    """Manager for user approval requests (used by tools, not LLM directly)."""
    
    tool_name = "request_user_approval"
    read_only = True  # This is a gating mechanism, not a write action itself
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute user approval request and yield events.
        
        Waits indefinitely for user response (no timeout - approval is blocking).
        
        Yields:
            - Pre-execution status (question to user)
            - Post-execution status (after user responds)
        """
        question = tool_call.get("question", "")
        image_url = tool_call.get("image_url")
        metadata = tool_call.get("metadata")
        event_metadata = None
        
        if not question:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Invalid approval request",
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
            request_id = await workflow.execute_activity(
                create_approval_request_activity,
                args=[
                    str(user_id) if user_id else "",
                    str(agent_id) if agent_id else "",
                    str(workflow_id) if workflow_id else "",
                    str(question) if question else "",
                    str(image_url) if image_url else "",
                    metadata or None,
                ],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
            
            if metadata or request_id:
                payload = dict(metadata or {})
                payload["attentionRequestId"] = request_id
                event_metadata = {"requestUserApproval": payload}
            
            logger.info(
                "Approval request created, waiting for user response",
                request_id=request_id,
                workflow_id=workflow_id
            )
            
        except Exception as e:
            # Error creating request
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Failed to create approval request",
                message=str(e),
                status=MessageStatus.ERROR,
                metadata={"requestUserApproval": metadata} if metadata else None
            )
            return
        
        # 2. Pre-execution status - show the question
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="🔐 Requesting user approval",
            message=question,
            status=MessageStatus.IN_PROGRESS,
            metadata=event_metadata
        )
        
        # 3. Wait indefinitely for user response (approval is blocking)
        try:
            await workflow.wait_condition(
                lambda: (
                    len(workflow_instance.context) > 0 and
                    workflow_instance.context[-1].get("role") == "USER"
                )
            )
            
            logger.info(
                "User responded to approval request",
                request_id=request_id
            )
                
        except Exception as e:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Failed waiting for user response",
                message=str(e),
                status=MessageStatus.ERROR
            )
            return
        
        # 4. Get the response from context
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
            "User approval response received",
            request_id=request_id,
            response_length=len(response_text)
        )
        
        # 5. Success status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="✓ User approval received",
            message="",
            status=MessageStatus.FINISHED,
            metadata=event_metadata
        )


# ========================================
# ACTIVITY IMPLEMENTATION
# ========================================

@activity.defn
async def create_approval_request_activity(
    user_id: str,
    agent_id: str,
    workflow_id: str,
    question: str,
    image_url: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Activity: Create an approval request in the database.
    
    Args:
        user_id: User ID
        agent_id: Agent ID
        workflow_id: Temporal workflow ID
        question: Question to ask the user
        image_url: Optional image URL (e.g. product thumbnail)
        metadata: Optional additional metadata
    
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
            "Creating approval request",
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
                    "Failed to create approval request - HTTP error",
                    status_code=response.status_code,
                    response_body=response.text,
                    payload=payload
                )
            
            response.raise_for_status()
            data = response.json()
            
            request_id = data.get("id")
            logger.info(
                "Approval request created",
                request_id=request_id,
                agent_id=agent_id,
                question=question[:100]
            )
            
            return request_id
            
    except Exception as e:
        logger.error("Failed to create approval request", error=str(e))
        raise


# ========================================
# SINGLETON
# ========================================

_manager: Optional[RequestUserApprovalManager] = None


def get_manager() -> RequestUserApprovalManager:
    """Get or create request user approval manager singleton."""
    global _manager
    if _manager is None:
        _manager = RequestUserApprovalManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def request_user_approval(workflow_instance, tool_call: Dict[str, Any], tool_call_id: str) -> None:
    """
    Workflow helper for request_user_approval (event-driven system).
    
    This is used by other tools to gate actions requiring user approval.
    Not called directly by the LLM.
    """
    manager = get_manager()
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "request_user_approval")


# ========================================
# DIRECT CALL HELPER (for other tools)
# ========================================

async def request_user_approval_direct(
    workflow_instance,
    question: str,
    image_url: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, str]:
    """
    Direct call helper for tools that need to request user approval with simple parameters.
    
    This is used by tools that make direct calls (message_person, send_sms_as_user, etc).
    
    Args:
        workflow_instance: The workflow instance (self)
        question: The question to ask the user
        image_url: Optional image URL (e.g. product thumbnail)
        metadata: Optional additional metadata
        
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
    
    # Create the approval request via activity
    try:
        request_id = await workflow.execute_activity(
            create_approval_request_activity,
            args=[
                str(user_id) if user_id else "",
                str(agent_id) if agent_id else "",
                str(workflow_id) if workflow_id else "",
                str(question) if question else "",
                str(image_url) if image_url else "",
                metadata or None,
            ],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )
        
        logger.info(
            "Approval request created, waiting for user response",
            request_id=request_id,
            workflow_id=workflow_id
        )

        metadata_payload = dict(metadata or {})
        metadata_payload["attentionRequestId"] = request_id
        event_metadata = {
            "isUserAttentionMessage": True,
            "attentionMessage": question,
            "requestUserApproval": metadata_payload,
        }

        # Send SMS write_lock notification (root + SMS-source agents only)
        if (getattr(workflow_instance, 'parent_workflow_id', None) is None
                and getattr(workflow_instance, 'agent_source', 'WEB') == "SMS"):
            try:
                from helpers.sms_activities import notify_sms_event_activity
                await workflow.execute_activity(
                    notify_sms_event_activity,
                    args=[user_id, "write_lock", agent_id, {
                        "question": question,
                        "attention_request_id": request_id,
                        "workflow_id": workflow_id,
                    }],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                logger.info("Sent write_lock SMS notification", request_id=request_id, agent_id=agent_id)
            except Exception as sms_err:
                logger.warning(f"Failed to send write_lock SMS notification: {sms_err}")

    except Exception as e:
        # Post error message
        error_event = ToolEvent(
            type=EventType.POST_MESSAGE,
            title="❌ Failed to create approval request",
            message=str(e),
            status=MessageStatus.ERROR,
            metadata={"requestUserApproval": metadata} if metadata else None
        )
        await workflow_instance._handle_tool_event(error_event, tool_call_id, "request_user_approval")
        raise
    
    pre_event = ToolEvent(
        type=EventType.POST_MESSAGE,
        title="🔐 Requesting user approval",
        message=question,
        status=MessageStatus.IN_PROGRESS,
        metadata=event_metadata
    )
    await workflow_instance._handle_tool_event(pre_event, tool_call_id, "request_user_approval")
    
    # Wait indefinitely for this specific request's response
    await workflow.wait_condition(
        lambda: request_id in workflow_instance._signal_responses
    )

    signal_response = workflow_instance._signal_responses.pop(request_id)

    if signal_response and signal_response.strip() == "__REJECTED__":
        logger.info("User rejected approval request (via signal)", request_id=request_id)

        # Post FINISHED to close the approval chip cleanly (caller will post ERROR for the tool)
        reject_event = ToolEvent(
            type=EventType.POST_MESSAGE,
            title="✗ User rejected action",
            message="",
            status=MessageStatus.FINISHED,
            metadata=event_metadata
        )
        await workflow_instance._handle_tool_event(reject_event, tool_call_id, "request_user_approval")

        # Raise exception so caller posts ERROR for the actual tool
        raise UserRejectedError("User rejected the approval request")

    # Poll messages to get the actual response content (for approvals with user text)
    from datetime import datetime, timezone
    messages = await workflow_instance._poll_messages(datetime.fromtimestamp(0, tz=timezone.utc))

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
        "User approval response received",
        request_id=request_id,
        response_length=len(response_text),
        response_preview=response_text[:50] if response_text else ""
    )

    # Post success message
    post_event = ToolEvent(
        type=EventType.POST_MESSAGE,
        title="✓ User approval received",
        message="",
        status=MessageStatus.FINISHED,
        metadata=event_metadata
    )
    await workflow_instance._handle_tool_event(post_event, tool_call_id, "request_user_approval")

    return {
        "response": response_text,
        "question": question,
        "attention_request_id": metadata_payload.get("attentionRequestId") if metadata_payload else None,
    }

