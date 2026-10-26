"""set-plan domain handler -- thin tool entry point.

Parses input, delegates to service, emits tool events for UI updates.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from temporalio import workflow

from domains.set_plan.config import MAX_RETRIES
from domains.set_plan.service import (
    build_plan_data,
    build_plan_message,
    build_planner_messages,
    get_planner_tools_description,
    run_planner_attempt,
    validate_planner_result,
)
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager
from utils.rose_desktop import is_rose_desktop_user

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator


class SetPlanManager(ToolManager):
    """Manager for set_plan tool -- triggers planner LLM."""

    tool_name = "set_plan"

    async def execute_tool(
        self,
        workflow_instance: Any,
        tool_call: dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Trigger planner LLM to generate execution plan.

        Yields:
            - IN_PROGRESS while planner is thinking
            - Plan data on success
            - Error if validation fails after retries
        """
        total_start = workflow.now()

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Generating Plan",
            message="Analyzing context and generating execution plan",
            status=MessageStatus.IN_PROGRESS,
        )

        context_start = workflow.now()
        base_messages, user_messages = build_planner_messages(workflow_instance.context)

        tools_description = get_planner_tools_description(
            rose_desktop=is_rose_desktop_user(getattr(workflow_instance, "user_id", None))
        )
        user_context = getattr(workflow_instance, "user_context_section", "")
        response_schema = getattr(workflow_instance, "output_schema", None)

        # Refresh compute token if expired (5-min TTL)
        user_id = getattr(workflow_instance, "user_id", None)
        if user_id and hasattr(workflow_instance, "_refresh_claude_token"):
            await workflow_instance._refresh_claude_token(user_id)
        claude_max_token = (
            workflow_instance._active_claude_token()
            if hasattr(workflow_instance, "_active_claude_token")
            else getattr(workflow_instance, "claude_max_token", None)
        )
        gpt_token = (
            workflow_instance._active_gpt_token()
            if hasattr(workflow_instance, "_active_gpt_token")
            else getattr(workflow_instance, "gpt_code_token", None)
        )
        gpt_account_id = (
            workflow_instance._active_gpt_account_id()
            if hasattr(workflow_instance, "_active_gpt_account_id")
            else getattr(workflow_instance, "gpt_code_account_id", None)
        )
        gpt_token_source = (
            workflow_instance._active_gpt_source()
            if hasattr(workflow_instance, "_active_gpt_source")
            else getattr(workflow_instance, "gpt_code_token_source", None)
        )
        gpt_token_pool_id = (
            workflow_instance._active_gpt_pool_id()
            if hasattr(workflow_instance, "_active_gpt_pool_id")
            else getattr(workflow_instance, "gpt_code_token_pool_id", None)
        )

        context_elapsed = (workflow.now() - context_start).total_seconds()
        workflow.logger.info(
            f"[TIMING] Context building: {context_elapsed * 1000:.1f}ms"
            f" (messages: {len(base_messages)}, has_schema: {response_schema is not None})"
        )

        planner_result = None
        last_error: str | None = None

        for attempt in range(MAX_RETRIES):
            attempt_start = workflow.now()
            messages_for_planner = base_messages.copy()

            if last_error:
                messages_for_planner.append(
                    {
                        "role": "user",
                        "content": f"[VALIDATION ERROR - Please fix]: {last_error}",
                    }
                )

            try:
                planner_result = await run_planner_attempt(
                    workflow_instance=workflow_instance,
                    messages=messages_for_planner,
                    tools_description=tools_description,
                    user_context=user_context,
                    response_schema=response_schema,
                    claude_max_token=claude_max_token,
                    gpt_token=gpt_token,
                    gpt_account_id=gpt_account_id,
                    gpt_token_source=gpt_token_source,
                    gpt_token_pool_id=gpt_token_pool_id,
                    user_messages=user_messages,
                    tool_call_id=tool_call_id,
                    attempt=attempt,
                )
            except BaseException as e:
                if isinstance(e, GeneratorExit):
                    raise
                from utils.error_utils import extract_error_message

                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Planner Error",
                    message=f"Failed to generate plan: {extract_error_message(e)}",
                    status=MessageStatus.ERROR,
                )
                return

            # Validate
            validation_start = workflow.now()
            validation_error = validate_planner_result(planner_result)
            validation_elapsed = (workflow.now() - validation_start).total_seconds()
            attempt_elapsed = (workflow.now() - attempt_start).total_seconds()
            workflow.logger.info(
                f"[TIMING] Validation: {validation_elapsed * 1000:.1f}ms,"
                f" Total attempt {attempt + 1}: {attempt_elapsed * 1000:.1f}ms"
            )
            if validation_error is None:
                break

            last_error = validation_error
            if attempt < MAX_RETRIES - 1:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Retrying plan generation",
                    message=f"Validation error: {validation_error}\n\nRetrying with correction",
                    status=MessageStatus.IN_PROGRESS,
                )

        # If still invalid after retries, fail
        if last_error:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Plan Validation Failed",
                message=f"Planner failed after {MAX_RETRIES} attempts: {last_error}",
                status=MessageStatus.ERROR,
            )
            return

        assert planner_result is not None  # noqa: S101
        plan_data = build_plan_data(planner_result)
        msg = build_plan_message(plan_data)

        total_elapsed = (workflow.now() - total_start).total_seconds()
        workflow.logger.info(
            f"[TIMING] ===== TOTAL set_plan execution: {total_elapsed * 1000:.1f}ms ({total_elapsed:.2f}s) ====="
        )

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=plan_data["title"],
            message=msg,
            status=MessageStatus.FINISHED,
            data=plan_data,
        )


# ========================================
# SINGLETON
# ========================================

_manager: SetPlanManager | None = None


def get_manager() -> SetPlanManager:
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = SetPlanManager()
    return _manager


# ========================================
# TOOL ENTRY POINT
# ========================================


async def set_plan(
    workflow_instance: Any,
    tool_call: dict[str, Any],
    tool_call_id: str,
) -> tuple[MessageStatus | None, str]:
    """Workflow helper for set_plan (event-driven system).

    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict (now empty - planner generates plan)
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    last_status = None
    last_message = ""

    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "set_plan")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
            if event.message:
                last_message = event.message

    return (last_status, last_message)
