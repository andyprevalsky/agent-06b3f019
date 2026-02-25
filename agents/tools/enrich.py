"""Enrich tool - migrated to event-driven architecture using Parallel Task API."""

from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from datetime import timedelta
import structlog
import httpx
import asyncio
import time

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, format_tool_message, format_error_message

# Config import is safe - no side effects at import time (load_dotenv is lazy)
from config import load_config

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


class EnrichManager(ToolManager):
    """Manager for Enrich operations using Parallel AI's Task API."""
    
    tool_name = "enrich"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute enrichment and yield events with time-based progress tracking.
        
        Yields:
            - Pre-execution status
            - Progress updates based on elapsed time
            - Usage tracking events
            - Post-execution status with enriched results
        """
        input_data = tool_call.get("input", {})
        output_schema = tool_call.get("output_schema", {})
        processor = tool_call.get("processor", "lite")
        # Convert enum to string if needed
        if hasattr(processor, 'value'):
            processor = processor.value
        
        # Build verbose title from input - use name, email, company, or url
        entity_name = input_data.get("name") or input_data.get("email") or input_data.get("company") or input_data.get("url") or "entity"
        title_entity = entity_name if len(str(entity_name)) <= 50 else str(entity_name)[:47] + "..."
        
        # Track start time for elapsed time calculation
        start_time = _safe_time()
        
        # Track current progress
        current_progress = 0
        
        # Build display message from input
        input_summary = []
        if input_data.get("name"):
            input_summary.append(f"Name: {input_data['name']}")
        if input_data.get("email"):
            input_summary.append(f"Email: {input_data['email']}")
        if input_data.get("company"):
            input_summary.append(f"Company: {input_data['company']}")
        if input_data.get("url"):
            input_summary.append(f"URL: {input_data['url']}")
        display_input = "\n".join(input_summary) if input_summary else "Entity data provided"
        
        # 1. Pre-execution status with verbose title (0%)
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"🔬 Enriching {title_entity}",
            message=f"{display_input}\nProcessor: {processor}\nExtracting additional data...",
            status=MessageStatus.IN_PROGRESS,
            metadata={"progressComplete": 0}
        )
        
        # 2. Execute enrichment with split activities and time-based progress
        try:
            logger.info("Starting enrich workflow", input_keys=list(input_data.keys()), processor=processor)
            
            # Step 1: Create Task (0% → 30%)
            create_result = await workflow.execute_activity(
                enrich_create_task_activity,
                args=[input_data, output_schema, processor],
                start_to_close_timeout=timedelta(minutes=2),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10)
                )
            )
            
            current_progress = 30
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"🔬 Enriching {title_entity}",
                message="Task created, enriching data...",
                status=MessageStatus.IN_PROGRESS,
                metadata={"progressComplete": current_progress}
            )
            
            run_id = create_result.get("run_id")
            
            # Step 2: Poll with time-based progress (30% → 80%)
            # Since enrich API doesn't expose granular metrics, use time-based estimation
            poll_start_time = _safe_time()
            max_poll_time = 600  # 10 minutes max
            poll_interval = 2.0  # Start with 2 seconds
            last_progress_update = poll_start_time
            
            warnings = None
            
            while True:
                # Check timeout
                elapsed_poll_time = _safe_time() - poll_start_time
                if elapsed_poll_time >= max_poll_time:
                    raise TimeoutError(f"Enrichment task timed out after {max_poll_time} seconds")
                
                # Sleep before polling
                await workflow.sleep(poll_interval)
                
                # Poll status once
                poll_result = await workflow.execute_activity(
                    enrich_poll_status_once_activity,
                    args=[run_id],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(
                        maximum_attempts=3,
                        backoff_coefficient=2.0,
                        initial_interval=timedelta(seconds=1),
                        maximum_interval=timedelta(seconds=5)
                    )
                )
                
                is_completed = poll_result.get("is_completed", False)
                is_failed = poll_result.get("is_failed", False)
                warnings = poll_result.get("warnings")
                
                # Check for completion or failure
                if is_failed:
                    error_msg = warnings or "Unknown error"
                    raise ValueError(f"Enrichment task failed: {error_msg}")
                
                if is_completed:
                    # Set progress to 80% when complete (leave 20% for results retrieval)
                    current_progress = 80
                    yield ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title=f"🔬 Enriching {title_entity}",
                        message="Enrichment completed! Retrieving results...",
                        status=MessageStatus.IN_PROGRESS,
                        metadata={"progressComplete": current_progress}
                    )
                    break
                
                # Time-based progress estimation: 30% → 80% (50% range)
                # Update progress every 5 seconds
                time_since_last_update = _safe_time() - last_progress_update
                if time_since_last_update >= 5.0:
                    # Calculate progress based on elapsed time (cap at 80%)
                    progress_range = 50  # 30% to 80%
                    time_progress = min(1.0, elapsed_poll_time / max_poll_time)
                    current_progress = min(80, 30 + int(time_progress * progress_range))
                    
                    last_progress_update = _safe_time()
                    
                    # Yield progress event
                    yield ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title=f"🔬 Enriching {title_entity}",
                        message=f"Enriching... ({int(elapsed_poll_time)}s elapsed)",
                        status=MessageStatus.IN_PROGRESS,
                        metadata={"progressComplete": current_progress}
                    )
                
                # Exponential backoff for polling
                poll_interval = min(poll_interval * 1.5, 10.0)
            
            # Step 3: Get Results (80% → 100%)
            current_progress = 90
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"🔬 Enriching {title_entity}",
                message="Fetching enriched data...",
                status=MessageStatus.IN_PROGRESS,
                metadata={"progressComplete": current_progress}
            )
            
            results_data = await workflow.execute_activity(
                enrich_get_task_results_activity,
                args=[run_id],
                start_to_close_timeout=timedelta(minutes=2),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10)
                )
            )
            
            output = results_data.get("output", {})
            run_info = results_data.get("run", {})
            usage = results_data.get("usage")
            
            # Calculate elapsed time and cost
            elapsed_time = _safe_time() - start_time
            
            # Calculate cost based on actual Parallel AI Task API pricing
            # Source: https://parallel.ai/pricing & https://docs.parallel.ai/task-api/guides/choose-a-processor
            # Pricing varies by processor tier (per request):
            processor_costs_cents = {
                "lite": 0.5,      # $0.005 per request ($5 per 1,000)
                "base": 1,        # $0.01 per request ($10 per 1,000)
                "core": 2.5,      # $0.025 per request ($25 per 1,000)
                "core2x": 5,      # $0.05 per request ($50 per 1,000)
                "pro": 10,        # $0.10 per request ($100 per 1,000)
                "ultra": 30,      # $0.30 per request ($300 per 1,000)
                "ultra2x": 60,    # $0.60 per request ($600 per 1,000)
                "ultra4x": 120,   # $1.20 per request ($1,200 per 1,000)
                "ultra8x": 240,   # $2.40 per request ($2,400 per 1,000)
            }
            total_cost_cents = processor_costs_cents.get(processor.lower(), 2.5)
            
            # 3. Build standardized usage for workflow cost tracking
            tool_usage = {
                "llm": [],
                "service": [{"cost_cents": int(total_cost_cents), "provider": f"Parallel Task API ({processor})"}],
            }

            # 4. Format success message using standardized format
            result = {
                "run_id": run_id,
                "output": output,
                "run": run_info,
                "usage": usage
            }
            
            message = format_tool_message(
                params=tool_call,
                result=result,
                time_elapsed=elapsed_time,
                cost_cents=total_cost_cents
            )
            
            # Post-execution success with verbose title (100%) - include usage for tracking
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Enrichment completed: {title_entity}",
                message=message,
                status=MessageStatus.FINISHED,
                data={"usage": tool_usage}
            )
            
        except Exception as e:
            # Calculate elapsed time even on error
            elapsed_time = _safe_time() - start_time
            
            # Format error message using standardized format
            error_message = format_error_message(
                params=tool_call,
                error=e,
                time_elapsed=elapsed_time,
                cost_cents=0
            )
            
            # Error status with verbose title and current progress
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"❌ Enrichment failed: {title_entity}",
                message=error_message,
                status=MessageStatus.ERROR,
                metadata={"progressComplete": current_progress}
            )
            # Don't raise - error event already posted the formatted message


# ========================================
# SINGLETON
# ========================================

_manager: Optional[EnrichManager] = None


def get_manager() -> EnrichManager:
    """Get or create Enrich manager singleton."""
    global _manager
    if _manager is None:
        _manager = EnrichManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def enrich(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for Enrich (new event-driven system).

    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict with 'input', 'output_schema', 'processor'
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    last_status = None

    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "enrich")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
        # Track usage from final event (included in data field)
        if event.data and event.data.get("usage"):
            await workflow_instance._track_usage(event.data["usage"], tool_name="enrich")

    return last_status


# ========================================
# TEMPORAL ACTIVITIES (Split into sub-activities)
# ========================================

@activity.defn
async def enrich_create_task_activity(
    input_data: Dict[str, Optional[str]], 
    output_schema: Dict[str, Any], 
    processor: str
) -> Dict[str, Any]:
    """
    Activity 1: Create an enrichment task.
    
    Args:
        input_data: Dict with person/company metadata
        output_schema: JSON schema defining what to extract
        processor: Processor type (lite/base/core/pro/ultra)
        
    Returns:
        Dict with:
            - run_id: ID of the created task run
    """
    try:
        try:
            activity.heartbeat(f"Creating enrichment task: {input_data.get('name', 'Unknown')}")
        except RuntimeError:
            pass
        
        config = load_config()
        api_key = config.parallel.api_key
        base_url = "https://api.parallel.ai"
        
        headers = {
            "x-api-key": api_key,
            "Content-Type": "application/json"
        }
        
        task_payload = {
            "input": input_data,
            "task_spec": {
                "output_schema": output_schema
            },
            "processor": processor
        }
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            create_response = await client.post(
                f"{base_url}/v1/tasks/runs",
                headers=headers,
                json=task_payload
            )
            create_response.raise_for_status()
            create_data = create_response.json()
            
            run_id = create_data.get("run_id")
            if not run_id:
                raise ValueError("No run_id returned from task run creation")
            
            logger.info("Enrichment task created", run_id=run_id, processor=processor)
            
            return {"run_id": run_id}
            
    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Enrich create task error", error=error_msg, input_data=input_data)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Enrich create task failed", error=str(e), input_data=input_data)
        raise


@activity.defn
async def enrich_poll_status_once_activity(run_id: str) -> Dict[str, Any]:
    """
    Activity 2: Poll status once and return data.
    
    Args:
        run_id: ID of the enrichment task run
        
    Returns:
        Dict with:
            - status: Status value
            - is_active: Whether task is active
            - is_completed: bool
            - is_failed: bool
            - warnings: Any warnings (if failed)
    """
    try:
        try:
            activity.heartbeat(f"Polling enrichment status for {run_id}...")
        except RuntimeError:
            pass
        
        config = load_config()
        api_key = config.parallel.api_key
        base_url = "https://api.parallel.ai"
        
        headers = {
            "x-api-key": api_key,
            "Content-Type": "application/json"
        }
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            status_response = await client.get(
                f"{base_url}/v1/tasks/runs/{run_id}",
                headers=headers
            )
            status_response.raise_for_status()
            status_data = status_response.json()
            
            status_value = status_data.get("status", "unknown")
            is_active = status_data.get("is_active", True)
            warnings = status_data.get("warnings")
            
            is_completed = (status_value == "completed" and not is_active)
            is_failed = (status_value == "failed")
            
            logger.info(
                "Enrich status polled",
                run_id=run_id,
                status=status_value,
                is_active=is_active
            )
            
            return {
                "status": status_value,
                "is_active": is_active,
                "is_completed": is_completed,
                "is_failed": is_failed,
                "warnings": warnings
            }
            
    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Enrich poll status error", error=error_msg, run_id=run_id)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Enrich poll status failed", error=str(e), run_id=run_id)
        raise


@activity.defn
async def enrich_get_task_results_activity(run_id: str) -> Dict[str, Any]:
    """
    Activity 3: Get results from completed enrichment task.
    
    Args:
        run_id: ID of the enrichment task run
        
    Returns:
        Dict with:
            - output: Enrichment output data
            - run: Run information
            - usage: Usage information (if available)
    """
    try:
        try:
            activity.heartbeat(f"Retrieving enrichment results for {run_id}...")
        except RuntimeError:
            pass
        
        config = load_config()
        api_key = config.parallel.api_key
        base_url = "https://api.parallel.ai"
        
        headers = {
            "x-api-key": api_key,
            "Content-Type": "application/json"
        }
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            result_response = await client.get(
                f"{base_url}/v1/tasks/runs/{run_id}/result",
                headers=headers
            )
            result_response.raise_for_status()
            result_data = result_response.json()
            
            output = result_data.get("output", {})
            run_info = result_data.get("run", {})
            
            logger.info(
                "Enrichment results retrieved",
                run_id=run_id,
                output_type=output.get("type", "unknown")
            )
            
            return {
                "output": output,
                "run": run_info,
                "usage": None  # Task API may not return usage in same format
            }
            
    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Enrich get results error", error=error_msg, run_id=run_id)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Enrich get results failed", error=str(e), run_id=run_id)
        raise
