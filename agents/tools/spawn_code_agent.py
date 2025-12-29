"""Code agent tool using Cursor Cloud Agents + Vercel preview deployments.

This tool spawns autonomous code agents via the Cursor Cloud Agent API to write
and deploy code. Generated apps are automatically deployed to Vercel for
instant preview.
"""

import uuid
from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, UsageType, UsageItem
from helpers.cursor_api import (
    launch_cursor_agent,
    poll_cursor_agent_status,
    CursorAgentStatus,
)
from helpers.vercel_api import (
    ensure_vercel_project,
    get_vercel_preview_url,
    VercelDeployment,
)

# Config import is safe - no side effects at import time (load_dotenv is lazy)
from config import load_config

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        import time
        return time.time()
    except Exception:
        return 0.0


class SpawnCodeAgentManager(ToolManager):
    """Manager for spawning autonomous code agents via Cursor Cloud Agents."""
    
    tool_name = "spawn_code_agent"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Spawn an autonomous code agent with a high-level goal.
        
        The code agent will:
        1. Launch a Cursor Cloud Agent to write code
        2. Push code to a GitHub branch
        3. Deploy via Vercel for instant preview
        
        Yields:
            - Initial message (main context)
            - Status updates during execution
            - Usage tracking
            - Completion message with preview URL
        """
        goal = tool_call.get("goal", "")
        user_id = workflow_instance.user_id
        agent_id = workflow_instance.agent_id

        logger.info("Code agent starting", goal=goal, user_id=user_id, agent_id=agent_id)
        
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Starting code agent",
            message='',
            status=MessageStatus.IN_PROGRESS
        )
        
        try:
            # Execute the activity that handles all the work
            result = await workflow.execute_activity(
                spawn_code_agent_activity,
                args=[user_id, agent_id, goal, tool_call_id],
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(minutes=5),
                retry_policy=RetryPolicy(
                    maximum_attempts=2,
                    initial_interval=timedelta(seconds=5),
                    maximum_interval=timedelta(seconds=30)
                )
            )
            
            # Report usage
            if result.get("usage_items"):
                yield ToolEvent(
                    type=EventType.USAGE,
                    tool_name="spawn_code_agent",
                    usage_items=result["usage_items"]
                )
            
            # Final completion message
            preview_url = result.get("preview_url")
            if result.get("status") == "COMPLETED" and preview_url:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Code deployed successfully",
                    message=f"Preview: {preview_url}\n\n{result.get('message', '')}",
                    status=MessageStatus.FINISHED,
                    metadata={
                        "preview_url": preview_url,
                        "branch_name": result.get("branch_name"),
                        "task_id": result.get("task_id"),
                        "action_type": "code_deployed"
                    }
                )
            else:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Code agent completed",
                    message=result.get("message", ""),
                    status=MessageStatus.FINISHED if result.get("status") == "COMPLETED" else MessageStatus.ERROR,
                    metadata={
                        "task_id": result.get("task_id"),
                        "action_type": "code_complete"
                    }
                )
            
        except Exception as e:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Code agent failed",
                message=str(e),
                status=MessageStatus.ERROR
            )
            raise


# ========================================
# SINGLETON
# ========================================

_manager: Optional[SpawnCodeAgentManager] = None


def get_manager() -> SpawnCodeAgentManager:
    """Get or create spawn_code_agent manager singleton."""
    global _manager
    if _manager is None:
        _manager = SpawnCodeAgentManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def spawn_code_agent(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for spawn_code_agent.
    
    Spawns an autonomous code agent with a high-level goal.
    
    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict with 'goal'
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "spawn_code_agent")


# ========================================
# TEMPORAL ACTIVITY
# ========================================

@activity.defn
async def spawn_code_agent_activity(
    user_id: str,
    agent_id: str,
    goal: str,
    tool_call_id: str,
) -> Dict[str, Any]:
    """
    Activity: Spawn an autonomous code agent to write and deploy code.
    
    This activity:
    1. Fetches the user's GitHub repo configuration
    2. Ensures a Vercel project exists for the repo
    3. Launches a Cursor Cloud Agent with the goal
    4. Polls until the agent completes
    5. Polls Vercel until the preview deployment is ready
    6. Returns the preview URL
    
    Args:
        user_id: User's Supabase ID
        agent_id: Current agent ID
        goal: High-level goal for the code agent
        tool_call_id: Unique ID for this tool call
        
    Returns:
        Dict with:
        - status: "COMPLETED" or "FAILED"
        - message: Summary message
        - preview_url: Vercel preview URL (if successful)
        - branch_name: Git branch name
        - task_id: Unique task ID for grouping messages
        - usage_items: List[Dict] (cost tracking)
    """
    import time
    
    config = load_config()
    start_time = _safe_time()
    
    # Generate unique task ID for grouping messages
    task_id = str(uuid.uuid4())
    
    activity.heartbeat("Initializing code agent")
    
    # Validate configuration
    if not config.cursor.api_key:
        raise RuntimeError("CURSOR_API_KEY not configured")
    
    if not config.vercel.token:
        raise RuntimeError("VERCEL_TOKEN not configured")
    
    try:
        # 1. Fetch user's GitHub repo configuration
        activity.heartbeat("Fetching user settings")
        logger.info("Fetching GitHub repo for user", user_id=user_id)
        
        github_repo = None
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{config.backend.api_url}/api/user-settings",
                headers={"X-API-Key": config.backend.api_key, "x-user-id": user_id}
            )
            if resp.status_code == 200:
                user_settings = resp.json()
                github_repo = user_settings.get("githubRepo")
        
        if not github_repo:
            raise RuntimeError(
                "No GitHub repository configured. Please set up your GitHub repo in settings."
            )
        
        logger.info("Using GitHub repo", github_repo=github_repo)
        
        # 2. Generate unique branch name for this task
        branch_name = f"navi-agent/{task_id[:8]}"
        
        # Save initial message to DB
        await save_code_agent_message(
            agent_id=agent_id,
            title="Code Agent Started",
            message=goal,
            status=MessageStatus.IN_PROGRESS,
            task_id=task_id,
            action_type="code_started",
            tool_call_id=tool_call_id,
            is_init_message=True
        )
        
        # 3. Ensure Vercel project exists for the repo
        activity.heartbeat("Setting up Vercel project")
        logger.info("Ensuring Vercel project exists", github_repo=github_repo)
        
        await save_code_agent_message(
            agent_id=agent_id,
            title="Setting up Vercel",
            message="Connecting GitHub repository to Vercel...",
            status=MessageStatus.IN_PROGRESS,
            task_id=task_id,
            action_type="vercel_setup"
        )
        
        vercel_project = await ensure_vercel_project(
            token=config.vercel.token,
            github_repo=github_repo,
            team_id=config.vercel.team_id
        )
        
        await save_code_agent_message(
            agent_id=agent_id,
            title="Vercel Ready",
            message=f"Project: {vercel_project.name}",
            status=MessageStatus.FINISHED,
            task_id=task_id,
            action_type="vercel_setup"
        )
        
        # 4. Launch Cursor Cloud Agent
        activity.heartbeat("Launching Cursor agent")
        logger.info(
            "Launching Cursor agent",
            github_repo=github_repo,
            branch_name=branch_name,
            goal=goal[:100]
        )
        
        await save_code_agent_message(
            agent_id=agent_id,
            title="Writing Code",
            message="Cursor agent is working on your request...",
            status=MessageStatus.IN_PROGRESS,
            task_id=task_id,
            action_type="cursor_working"
        )
        
        cursor_result = await launch_cursor_agent(
            api_key=config.cursor.api_key,
            goal=goal,
            github_repo=github_repo,
            branch_name=branch_name,
            base_url=config.cursor.base_url,
            auto_create_pr=False,  # Push code without creating PR
        )
        
        cursor_agent_id = cursor_result["agent_id"]
        
        # 5. Poll Cursor agent until complete
        async def on_cursor_status(status: CursorAgentStatus):
            """Callback for Cursor agent status updates."""
            activity.heartbeat(f"Cursor agent: {status.status}")
            
            status_messages = {
                "running": "Writing and testing code...",
                "completed": "Code written successfully!",
                "failed": f"Code generation failed: {status.error_message or 'Unknown error'}",
            }
            
            if status.status in status_messages:
                await save_code_agent_message(
                    agent_id=agent_id,
                    title=f"Cursor: {status.status.title()}",
                    message=status_messages[status.status],
                    status=MessageStatus.IN_PROGRESS if status.status == "running" else MessageStatus.FINISHED,
                    task_id=task_id,
                    action_type="cursor_status"
                )
        
        final_cursor_status = await poll_cursor_agent_status(
            api_key=config.cursor.api_key,
            agent_id=cursor_agent_id,
            base_url=config.cursor.base_url,
            poll_interval=5.0,
            timeout=600.0,  # 10 minute timeout
            on_status_update=on_cursor_status
        )
        
        if final_cursor_status.status == "failed":
            raise RuntimeError(
                f"Cursor agent failed: {final_cursor_status.error_message or 'Unknown error'}"
            )
        
        if final_cursor_status.status == "cancelled":
            raise RuntimeError("Cursor agent was cancelled")
        
        # Log files changed
        files_changed = final_cursor_status.files_changed or []
        logger.info("Cursor agent completed", files_changed=files_changed)
        
        await save_code_agent_message(
            agent_id=agent_id,
            title="Code Written",
            message=f"Changed {len(files_changed)} file(s)",
            status=MessageStatus.FINISHED,
            task_id=task_id,
            action_type="code_written",
            metadata={"files_changed": files_changed}
        )
        
        # 6. Poll Vercel for deployment
        activity.heartbeat("Waiting for Vercel deployment")
        logger.info("Polling Vercel for deployment", branch_name=branch_name)
        
        await save_code_agent_message(
            agent_id=agent_id,
            title="Deploying",
            message="Building and deploying to Vercel...",
            status=MessageStatus.IN_PROGRESS,
            task_id=task_id,
            action_type="vercel_deploying"
        )
        
        async def on_vercel_status(deployment: VercelDeployment):
            """Callback for Vercel deployment status updates."""
            activity.heartbeat(f"Vercel: {deployment.state}")
        
        preview_url = await get_vercel_preview_url(
            token=config.vercel.token,
            project_id=vercel_project.id,
            branch_name=branch_name,
            team_id=config.vercel.team_id,
            poll_interval=5.0,
            timeout=300.0,  # 5 minute timeout for deployment
            on_status_update=on_vercel_status
        )
        
        await save_code_agent_message(
            agent_id=agent_id,
            title="Deployed",
            message=preview_url,
            status=MessageStatus.FINISHED,
            task_id=task_id,
            action_type="code_deployed",
            metadata={"preview_url": preview_url}
        )
        
        execution_time_ms = (_safe_time() - start_time) * 1000
        
        # Calculate usage
        usage_items = [
            {
                "type": "service",
                "cost_cents": 5,  # Flat fee for Cursor agent usage (placeholder)
                "provider": "Cursor Cloud Agent"
            }
        ]
        
        logger.info(
            "Code agent completed successfully",
            preview_url=preview_url,
            branch_name=branch_name,
            files_changed=len(files_changed),
            execution_time_ms=execution_time_ms
        )
        
        return {
            "status": "COMPLETED",
            "message": f"Created {len(files_changed)} file(s). Preview at: {preview_url}",
            "preview_url": preview_url,
            "branch_name": branch_name,
            "task_id": task_id,
            "files_changed": files_changed,
            "usage_items": usage_items,
            "execution_time_ms": execution_time_ms
        }
        
    except Exception as e:
        logger.error("Code agent failed", error=str(e), user_id=user_id)
        
        # Save error message
        await save_code_agent_message(
            agent_id=agent_id,
            title="Failed",
            message=str(e),
            status=MessageStatus.ERROR,
            task_id=task_id,
            action_type="code_error"
        )
        
        raise


async def save_code_agent_message(
    agent_id: str,
    title: str,
    message: str,
    status: MessageStatus,
    task_id: str,
    action_type: str = "default",
    tool_call_id: str = None,
    is_init_message: bool = False,
    metadata: dict = None,
):
    """
    Save code agent sub-action message directly to DB for real-time display.
    
    These messages have task_id metadata which:
    1. Groups them into code agent panels on frontend
    2. Filters them from agent context (so LLM doesn't see them)
    
    Args:
        agent_id: Agent ID for the message
        title: Title for the message
        message: Message content
        status: Message status (IN_PROGRESS, FINISHED, ERROR)
        task_id: Stable task ID for grouping
        action_type: Type of action for frontend icon rendering
        tool_call_id: Optional ID for deduplication
        is_init_message: If True, appears in main chat
        metadata: Additional metadata to include
    """
    try:
        config = load_config()
        
        unique_tool_call_id = tool_call_id or str(uuid.uuid4())
        
        msg_metadata = {
            "toolCallId": unique_tool_call_id,
            "toolName": "spawn_code_agent",
            "toolStatus": status.value,
            "title": title,
            "task_id": task_id,
            "action_type": action_type,
        }
        
        # Add extra metadata
        if metadata:
            msg_metadata.update(metadata)
        
        # Only add subAgentId for non-init messages
        if not is_init_message:
            msg_metadata["subAgentId"] = task_id
        
        if status == MessageStatus.ERROR:
            msg_metadata["error"] = True
        
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
                    "metadata": msg_metadata
                }
            )
    except Exception as e:
        logger.error("Failed to save code agent message", error=str(e))

