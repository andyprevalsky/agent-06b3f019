"""Approved own-number delivery through the ordinary durable browser manager."""
import json
from dataclasses import replace
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.message_person.repo import read_phone_message_activity
from domains.spawn_browser_agent_v3.handler import _logical_browser_task_id
from tools.base import EventType, MessageStatus, ToolEvent
from tools.spawn_browser_agent_v3 import get_manager as get_browser_manager


async def deliver_cloud_message(workflow_instance, *, queue_id, tool_call_id, recipient, body):
    child_id = tool_call_id + ":cloud-message"
    # Exact draft is already user-approved and durably stored by /imessage/queue.
    # The backend task binding, not this natural-language goal, authorizes send.
    goal = (
        "Send this already approved message using the dedicated cloud iPhone Messages app. "
        "Preserve the exact recipient and body; do not regenerate it or request duplicate approval. "
        "Navigate normally and inspect the current state. Use messages.send_approved with args "
        "{queueId: the supplied queueId} for the final send, never an ordinary tap/key for Send. "
        "Then observe and use messages.verify_sent with the same queueId. Never replay an "
        "UNKNOWN/submitted send or use another transport. Backend sent receipt is required; "
        "a model completion or a tap acknowledgment is not confirmation. Approved intent: "
        + json.dumps({"queueId": queue_id, "to": recipient, "body": body}, ensure_ascii=True)
    )
    async for event in get_browser_manager().execute_tool(
        workflow_instance,
        {"goal": goal, "approvedMessageIntent": queue_id},
        child_id,
    ):
        # A child completion is a claim, not delivery evidence. Preserve progress
        # and usage, but never publish a successful terminal card before receipt.
        if (event.type == EventType.POST_MESSAGE and event.status == MessageStatus.FINISHED
            and (event.metadata or {}).get("action_type") == "task_complete"):
            yield replace(event, title="Checking cloud message receipt", message="Verifying the authoritative send receipt.",
                          status=MessageStatus.IN_PROGRESS, metadata={"toolName": "message_person", "action_type": "delivery_verification"})
        else:
            yield event
    receipt = await workflow.execute_activity(
        read_phone_message_activity,
        args=[workflow_instance.user_id, workflow_instance.agent_id, queue_id],
        start_to_close_timeout=timedelta(seconds=30),
        retry_policy=RetryPolicy(maximum_attempts=1),
    )
    if (receipt.get("success") is True and receipt.get("provider") == "phone_harness"
        and receipt.get("queue_id") == queue_id
        and receipt.get("browser_task_id") == _logical_browser_task_id(workflow_instance.agent_id)
        and receipt.get("status") == "sent"
        and isinstance(receipt.get("sent_at"), str) and receipt["sent_at"]):
        yield ToolEvent(type=EventType.POST_MESSAGE, message="", status=MessageStatus.FINISHED,
                        data={"cloud_delivery": {"channel": "imessage", "provider": "phone_harness",
                              "queue_id": queue_id, "status": "sent", "sent_at": receipt["sent_at"]}})
        return
    yield ToolEvent(type=EventType.POST_MESSAGE, title="Cloud message not confirmed", status=MessageStatus.ERROR,
                    message="The approved cloud-phone send is unconfirmed. Do not resend or fall back to another transport; inspect the existing receipt.")
