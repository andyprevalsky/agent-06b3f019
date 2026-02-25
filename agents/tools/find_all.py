"""Find All tool - migrated to event-driven architecture."""

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


class FindAllManager(ToolManager):
    """Manager for Find All operations using Parallel AI's Find All API."""
    
    tool_name = "find_all"
    read_only = True  # Research phase tool
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute Find All search and yield events with metrics-based progress tracking.
        
        Yields:
            - Pre-execution status
            - Progress updates based on candidate generation/matching metrics
            - Usage tracking events
            - Post-execution status with results
        """
        objective = tool_call.get("objective", "")
        generator = tool_call.get("generator", "core")
        # Convert enum to string if needed
        if hasattr(generator, 'value'):
            generator = generator.value
        match_limit = tool_call.get("match_limit", 10)
        
        # Validate match_limit for preview generator
        if generator.lower() == "preview" and match_limit > 10:
            start_time = _safe_time()
            error_message = format_error_message(
                params=tool_call,
                error=ValueError("Match limit must be 10 or less for 'preview' generator. Preview is designed for testing queries with ~10 candidates. Use 'base', 'core', or 'pro' generators for more results."),
                time_elapsed=0,
                cost_cents=0
            )
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"❌ Invalid Find All parameters",
                message=error_message,
                status=MessageStatus.ERROR
            )
            return
        
        # Truncate long objectives for display in title
        # Remove common prefixes to avoid duplication (e.g., "Finding All Find all...")
        title_objective = objective
        for prefix in ["find all ", "find ", "search for ", "get all ", "list all ", "locate all "]:
            if title_objective.lower().startswith(prefix):
                title_objective = title_objective[len(prefix):]
                break
        
        # Capitalize first letter after removing prefix
        if title_objective:
            title_objective = title_objective[0].upper() + title_objective[1:]
        
        # Truncate if too long
        if len(title_objective) > 50:
            title_objective = title_objective[:47] + "..."
        
        # Track start time for elapsed time calculation
        start_time = _safe_time()
        
        # Track current progress
        current_progress = 0
        
        # 1. Pre-execution status with verbose title (0%)
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"🔍 Finding All {title_objective}",
            message=f"Objective: {objective[:100] if len(objective) <= 100 else objective[:97] + '...'}\nGenerator: {generator}\nMatch limit: {match_limit}",
            status=MessageStatus.IN_PROGRESS,
            metadata={"progressComplete": 0}
        )
        
        # 2. Execute Find All with split activities and metrics-based progress
        try:
            logger.info("Starting find_all workflow", objective_len=len(objective), generator=generator, match_limit=match_limit)
            
            # Step 1: Ingest (0% → 20%)
            ingest_result = await workflow.execute_activity(
                find_all_ingest_activity,
                args=[objective],
                start_to_close_timeout=timedelta(minutes=2),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10)
                )
            )
            
            current_progress = 20
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"🔍 Finding All {title_objective}",
                message="Objective ingested, creating search run...",
                status=MessageStatus.IN_PROGRESS,
                metadata={"progressComplete": current_progress}
            )
            
            entity_type = ingest_result.get("entity_type")
            match_conditions = ingest_result.get("match_conditions")
            
            # Step 2: Create Run (20% → 40%)
            create_result = await workflow.execute_activity(
                find_all_create_run_activity,
                args=[objective, entity_type, match_conditions, generator, match_limit],
                start_to_close_timeout=timedelta(minutes=2),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10)
                )
            )
            
            current_progress = 40
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"🔍 Finding All {title_objective}",
                message="Search run created, generating candidates...",
                status=MessageStatus.IN_PROGRESS,
                metadata={"progressComplete": current_progress}
            )
            
            findall_id = create_result.get("findall_id")
            
            # Step 3: Poll with metrics-based progress (40% → 95%)
            # Track previous counts to detect changes
            prev_generated_count = 0
            prev_matched_count = 0
            poll_start_time = _safe_time()
            max_poll_time = 1200  # 20 minutes max
            poll_interval = 2.0  # Start with 2 seconds
            
            final_status = None
            
            while True:
                # Check timeout
                elapsed_poll_time = _safe_time() - poll_start_time
                if elapsed_poll_time >= max_poll_time:
                    raise TimeoutError(f"Find All run timed out after {max_poll_time} seconds")
                
                # Sleep before polling
                await workflow.sleep(poll_interval)
                
                # Poll status once
                poll_result = await workflow.execute_activity(
                    find_all_poll_status_once_activity,
                    args=[findall_id],
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
                generated_count = poll_result.get("generated_candidates_count", 0)
                matched_count = poll_result.get("matched_candidates_count", 0)
                final_status = poll_result.get("status", {})
                
                # Check for completion or failure
                if is_failed:
                    error_msg = final_status.get("message", "Unknown error")
                    raise ValueError(f"Find All run failed: {error_msg}")
                
                if is_completed:
                    # Set progress to 95% when complete (leave 5% for results retrieval)
                    current_progress = 95
                    yield ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title=f"🔍 Finding All {title_objective}",
                        message=f"Search completed! Found {matched_count} matches. Retrieving results...",
                        status=MessageStatus.IN_PROGRESS,
                        metadata={"progressComplete": current_progress}
                    )
                    break
                
                # Calculate progress based on metrics changes
                generated_delta = generated_count - prev_generated_count
                matched_delta = matched_count - prev_matched_count
                
                # Only yield progress event if counts changed
                if generated_delta > 0 or matched_delta > 0:
                    # Increment progress: 2-3% per change
                    if generated_delta > 0:
                        # Generation phase: 40% → 70% (cap at 70)
                        current_progress = min(70, current_progress + 3)
                    if matched_delta > 0:
                        # Matching phase: 70% → 95% (cap at 95)
                        current_progress = min(95, current_progress + 3)
                    
                    # Update previous counts
                    prev_generated_count = generated_count
                    prev_matched_count = matched_count
                    
                    # Yield progress event
                    yield ToolEvent(
                        type=EventType.POST_MESSAGE,
                        title=f"🔍 Finding All {title_objective}",
                        message=f"Generated: {generated_count} | Matched: {matched_count}",
                        status=MessageStatus.IN_PROGRESS,
                        metadata={"progressComplete": current_progress}
                    )
                
                # Exponential backoff for polling
                poll_interval = min(poll_interval * 1.5, 10.0)
            
            # Step 4: Get Results (95% → 100%)
            results_data = await workflow.execute_activity(
                find_all_get_results_activity,
                args=[findall_id],
                start_to_close_timeout=timedelta(minutes=2),
                retry_policy=RetryPolicy(
                    maximum_attempts=3,
                    backoff_coefficient=2.0,
                    initial_interval=timedelta(seconds=1),
                    maximum_interval=timedelta(seconds=10)
                )
            )
            
            candidates = results_data.get("candidates", [])
            usage = results_data.get("usage")
            
            # Calculate elapsed time and cost
            elapsed_time = _safe_time() - start_time
            
            # Calculate cost based on actual Parallel AI FindAll pricing
            # Source: https://parallel.ai/pricing
            # Find All uses: Fixed Cost + (Cost Per Match × Number of Matches)
            candidate_count = len(candidates)
            
            generator_pricing = {
                "preview": {"fixed": 10, "per_match": 0},      # $0.10 fixed + $0.00 per match
                "base": {"fixed": 25, "per_match": 3},         # $0.25 fixed + $0.03 per match
                "core": {"fixed": 200, "per_match": 15},       # $2.00 fixed + $0.15 per match
                "pro": {"fixed": 1000, "per_match": 100},      # $10.00 fixed + $1.00 per match
            }
            
            pricing = generator_pricing.get(generator.lower(), generator_pricing["core"])
            total_cost_cents = pricing["fixed"] + (pricing["per_match"] * candidate_count)
            
            # 3. Build standardized usage for workflow cost tracking
            tool_usage = {
                "llm": [],
                "service": [{"cost_cents": int(total_cost_cents), "provider": f"Parallel Find All ({generator})"}],
            }

            # 4. Format success message using standardized format
            result = {
                "findall_id": findall_id,
                "candidates": candidates,
                "status": final_status,
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
                title=f"Find All completed: {title_objective}",
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
                cost_cents=0  # No cost charged on failure
            )
            
            # Error status with verbose title and current progress
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"❌ Find All failed: {title_objective}",
                message=error_message,
                status=MessageStatus.ERROR,
                metadata={"progressComplete": current_progress}
            )
            # Don't raise - error event already posted the formatted message


# ========================================
# SINGLETON
# ========================================

_manager: Optional[FindAllManager] = None


def get_manager() -> FindAllManager:
    """Get or create Find All manager singleton."""
    global _manager
    if _manager is None:
        _manager = FindAllManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def find_all(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for Find All (new event-driven system).

    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict with 'objective', 'generator', 'match_limit'
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    last_status = None

    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "find_all")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
        # Track usage from final event (included in data field)
        if event.data and event.data.get("usage"):
            await workflow_instance._track_usage(event.data["usage"], tool_name="find_all")

    return last_status


# ========================================
# TEMPORAL ACTIVITIES (Split into sub-activities)
# ========================================

@activity.defn
async def find_all_ingest_activity(objective: str) -> Dict[str, Any]:
    """
    Activity 1: Ingest objective and convert to entity_type and match_conditions.
    
    Args:
        objective: Natural language description of entities to find
        
    Returns:
        Dict with:
            - entity_type: Type of entity to search for
            - match_conditions: List of conditions to match
    """
    try:
        try:
            activity.heartbeat(f"Ingesting objective: {objective[:50]}...")
        except RuntimeError:
            pass  # Not in activity context (testing)
        
        config = load_config()
        api_key = config.parallel.api_key
        base_url = "https://api.parallel.ai"
        
        headers = {
            "x-api-key": api_key,
            "parallel-beta": "findall-2025-09-15",
            "Content-Type": "application/json"
        }
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            ingest_response = await client.post(
                f"{base_url}/v1beta/findall/ingest",
                headers=headers,
                json={"objective": objective}
            )
            ingest_response.raise_for_status()
            ingest_data = ingest_response.json()
            
            entity_type = ingest_data.get("entity_type", "entities")
            match_conditions = ingest_data.get("match_conditions", [])
            
            logger.info(
                "Find All ingest completed",
                entity_type=entity_type,
                match_conditions_count=len(match_conditions)
            )
            
            return {
                "entity_type": entity_type,
                "match_conditions": match_conditions
            }
            
    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Find All ingest error", error=error_msg, objective=objective)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Find All ingest failed", error=str(e), objective=objective)
        raise


@activity.defn
async def find_all_create_run_activity(
    objective: str, 
    entity_type: str, 
    match_conditions: list, 
    generator: str, 
    match_limit: int
) -> Dict[str, Any]:
    """
    Activity 2: Create a Find All run.
    
    Args:
        objective: Natural language description
        entity_type: Type of entity
        match_conditions: List of match conditions
        generator: Generator type (preview/base/core/pro)
        match_limit: Maximum number of matches
        
    Returns:
        Dict with:
            - findall_id: ID of the created run
    """
    try:
        try:
            activity.heartbeat("Creating Find All run...")
        except RuntimeError:
            pass
        
        config = load_config()
        api_key = config.parallel.api_key
        base_url = "https://api.parallel.ai"
        
        headers = {
            "x-api-key": api_key,
            "parallel-beta": "findall-2025-09-15",
            "Content-Type": "application/json"
        }
        
        create_run_payload = {
            "objective": objective,
            "entity_type": entity_type,
            "match_conditions": match_conditions,
            "generator": generator,
            "match_limit": match_limit
        }
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            create_response = await client.post(
                f"{base_url}/v1beta/findall/runs",
                headers=headers,
                json=create_run_payload
            )
            create_response.raise_for_status()
            create_data = create_response.json()
            
            findall_id = create_data.get("findall_id")
            if not findall_id:
                raise ValueError("No findall_id returned from create run")
            
            logger.info("Find All run created", findall_id=findall_id)
            
            return {"findall_id": findall_id}
            
    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Find All create run error", error=error_msg)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Find All create run failed", error=str(e))
        raise


@activity.defn
async def find_all_poll_status_once_activity(findall_id: str) -> Dict[str, Any]:
    """
    Activity 3: Poll status once and return metrics.
    
    Args:
        findall_id: ID of the Find All run
        
    Returns:
        Dict with:
            - status: Full status object
            - is_completed: bool
            - is_failed: bool
            - generated_candidates_count: int
            - matched_candidates_count: int
    """
    try:
        try:
            activity.heartbeat(f"Polling status for {findall_id}...")
        except RuntimeError:
            pass
        
        config = load_config()
        api_key = config.parallel.api_key
        base_url = "https://api.parallel.ai"
        
        headers = {
            "x-api-key": api_key,
            "parallel-beta": "findall-2025-09-15",
            "Content-Type": "application/json"
        }
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            status_response = await client.get(
                f"{base_url}/v1beta/findall/runs/{findall_id}",
                headers=headers
            )
            status_response.raise_for_status()
            status_data = status_response.json()
            
            status_obj = status_data.get("status", {})
            status_value = status_obj.get("status", "unknown")
            is_active = status_obj.get("is_active", True)
            
            # Extract metrics
            metrics = status_obj.get("metrics", {})
            generated_count = metrics.get("generated_candidates_count", 0)
            matched_count = metrics.get("matched_candidates_count", 0)
            
            is_completed = (status_value == "completed" and not is_active)
            is_failed = (status_value == "failed")
            
            logger.info(
                "Find All status polled",
                findall_id=findall_id,
                status=status_value,
                generated=generated_count,
                matched=matched_count
            )
            
            return {
                "status": status_obj,
                "is_completed": is_completed,
                "is_failed": is_failed,
                "generated_candidates_count": generated_count,
                "matched_candidates_count": matched_count
            }
            
    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Find All poll status error", error=error_msg, findall_id=findall_id)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Find All poll status failed", error=str(e), findall_id=findall_id)
        raise


@activity.defn
async def find_all_get_results_activity(findall_id: str) -> Dict[str, Any]:
    """
    Activity 4: Get results from completed Find All run.
    
    Args:
        findall_id: ID of the Find All run
        
    Returns:
        Dict with:
            - candidates: List of matched candidates
            - usage: Usage information
            - status: Status object
    """
    try:
        try:
            activity.heartbeat(f"Retrieving results for {findall_id}...")
        except RuntimeError:
            pass
        
        config = load_config()
        api_key = config.parallel.api_key
        base_url = "https://api.parallel.ai"
        
        headers = {
            "x-api-key": api_key,
            "parallel-beta": "findall-2025-09-15",
            "Content-Type": "application/json"
        }
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            result_response = await client.get(
                f"{base_url}/v1beta/findall/runs/{findall_id}/result",
                headers=headers
            )
            result_response.raise_for_status()
            result_data = result_response.json()
            
            candidates = result_data.get("candidates", [])
            usage = result_data.get("usage")
            
            logger.info(
                "Find All results retrieved",
                findall_id=findall_id,
                candidates_count=len(candidates)
            )
            
            return {
                "candidates": candidates,
                "usage": usage,
                "status": {}
            }
            
    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Find All get results error", error=error_msg, findall_id=findall_id)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Find All get results failed", error=str(e), findall_id=findall_id)
        raise

