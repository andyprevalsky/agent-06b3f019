"""Dispatch the shared retained-output reader with trusted caller identity."""
import json
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.common import RetryPolicy

from tools.base import EventType, MessageStatus, ToolEvent
from helpers.tool_output import ReadToolOutputTool, preview_tool_text, read_tool_output


# Exception type names Temporal records for expected reader rejections.
EXPECTED_READ_FAILURES = ("ValueError", "ValidationError", "FileNotFoundError")


@activity.defn
async def preview_tool_output_activity(user_id: str, agent_id: str, session_id: str, text: str, limit: int) -> str:
    """Keep attachment-store I/O out of deterministic workflow execution."""
    return await preview_tool_text(text, user_id=user_id, agent_id=agent_id, session_id=session_id, limit=limit)


@activity.defn
async def read_tool_output_activity(user_id: str, agent_id: str, session_id: str, arguments: dict) -> dict:
    args = ReadToolOutputTool.model_validate({**arguments, "tool": "read_tool_output"})
    return await read_tool_output(user_id=user_id, agent_id=agent_id, session_id=session_id,
                                  **args.model_dump(exclude={"tool"}))


def format_read_tool_output(result: dict) -> str:
    # Keep page text unescaped so control characters cannot multiply a 20k
    # page into another oversized JSON result and recursively spill it.
    metadata = {key: value for key, value in result.items() if key != "content"}
    return json.dumps(metadata, ensure_ascii=False) + "\n" + result["content"]


async def read_tool_output_for_workflow(instance, tool_call: dict, tool_call_id: str):
    result = await workflow.execute_activity(
        read_tool_output_activity,
        args=[instance.user_id, instance.agent_id, "", tool_call],
        start_to_close_timeout=timedelta(seconds=30),
        # Invalid, expired, out-of-scope or missing handles fail identically on
        # retry; storage/network failures keep the retry.
        retry_policy=RetryPolicy(maximum_attempts=2, non_retryable_error_types=list(EXPECTED_READ_FAILURES)),
    )
    text = format_read_tool_output(result)
    await instance._handle_tool_event(
        ToolEvent(type=EventType.POST_MESSAGE, title="Read retained tool output", message=text,
                  status=MessageStatus.FINISHED), tool_call_id, "read_tool_output")
    return {"success": True, "message": text}
