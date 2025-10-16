"""Tool for requesting user attention when agent needs clarification or input."""

from typing import Dict, Any, Optional
from temporalio import activity, workflow
import structlog
import httpx
from datetime import timedelta

from config import load_config

logger = structlog.get_logger()


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


async def request_user_attention(
    workflow_instance: Any,
    question: str,
    image_url: Optional[str] = None,
) -> Dict[str, str]:
    """
    Workflow function: Request user attention and wait for response.
    
    This function should be called from within a workflow. It will:
    1. Create an attention request in the database
    2. Block until the user responds via signal (which posts a USER message)
    3. Return success (the message is already in context)
    
    Args:
        workflow_instance: The workflow instance (self) to access context
        question: The question to ask the user
        image_url: Optional image URL (e.g. product thumbnail)
        
    Returns:
        Dict with:
            - response: The user's response text
            - question: Original question (for context)
    """
    # Must be called from within a workflow
    if not workflow.in_workflow():
        raise RuntimeError("request_user_attention must be called from within a workflow")
    
    # Get workflow info and IDs from workflow instance
    info = workflow.info()
    workflow_id = info.workflow_id
    user_id = workflow_instance.user_id
    agent_id = workflow_instance.agent_id
    
    # Create the attention request via activity
    request_id = await workflow.execute_activity(
        create_attention_request_activity,
        args=[user_id, agent_id, workflow_id, question, image_url],
        start_to_close_timeout=timedelta(seconds=30),
    )
    
    logger.info(
        "Waiting for user response",
        request_id=request_id,
        workflow_id=workflow_id
    )
    
    # Wait for user response signal to post a USER message
    # The signal handler will post the message and add it to context
    # We just wait until the last message is from USER
    await workflow.wait_condition(
        lambda: (
            len(workflow_instance.context) > 0 and
            workflow_instance.context[-1].get("role") == "USER"
        )
    )
    
    # Get the response from all consecutive USER messages at the end
    # (in case user sends multiple messages in quick succession)
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
    
    return {
        "response": response_text,
        "question": question
    }


def format_pre_message(tool_call: Dict[str, Any]) -> Dict[str, str]:
    """Format the pre-execution message for user attention request."""
    question = tool_call.get("question", "")
    
    return {
        "title": "🔔 Requesting user attention",
        "message": question
    }


def format_post_message(tool_call: Dict[str, Any], result: Any) -> Dict[str, str]:
    """Format the post-execution message after user responds."""
    return {
        "title": "✓ User message received",
        "message": ""
    }

