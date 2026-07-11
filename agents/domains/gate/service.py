"""Gate domain service.

`raise_gate_direct` is the organic gate primitive: a tool/handler calls it FROM
CODE at a real block site (e.g. a purchase that requires a subscription, an email
action with no connected inbox). It mirrors `request_user_approval_direct`'s
pause/resume — the backend emits the in-stream gate message on create, and the
workflow parks on the returned attention-request id until the user resolves it
(`receive_user_response` signal). Returns the user's response, or raises
`GateRejectedError` if declined.

Imports: own repo, own types, external packages, tools.base.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Dict, Optional

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy

from tools.base import EventType, MessageStatus, ToolEvent

from domains.request_user_approval.config import REJECTION_SENTINEL

from .repo import create_gate_request_activity
from .types import GateRejectedError

logger = structlog.get_logger()

TOOL_NAME = "gate"
DEFAULT_SUBSCRIBE_URL = "https://roselabs.ai/subscribe"
DEFAULT_KYC_URL = "https://roselabs.ai/kyc/start"


def build_subscription_gate(
    checkout_url: Optional[str] = None,
    reason: Optional[str] = None,
    title: Optional[str] = None,
) -> Dict[str, Any]:
    """Gate raised when an action needs an active subscription (e.g. a purchase)."""
    return {
        "gateKey": "subscription",
        "type": "subscription",
        "status": "PENDING",
        "severity": "blocking",
        "presentation": {
            "title": title or "Subscribe to let Rose complete purchases",
            "reason": reason
            or "You're out of free credit — an active plan lets me finish tasks that cost real money.",
            "cta": "Subscribe · $20/mo",
        },
        "action": {"kind": "link", "url": checkout_url or DEFAULT_SUBSCRIBE_URL},
        "detection": {"method": "stripe_webhook", "probeKey": "subscription"},
    }


def build_kyc_gate(kyc_url: Optional[str] = None, reason: Optional[str] = None) -> Dict[str, Any]:
    """Gate raised when card issuing requires identity verification."""
    return {
        "gateKey": "kyc",
        "type": "kyc",
        "status": "PENDING",
        "severity": "blocking",
        "presentation": {
            "title": "Verify identity to issue your Rose card",
            "reason": reason
            or "A one-time identity check is required before Rose can issue a payment card.",
            "cta": "Verify identity",
        },
        "action": {"kind": "link", "url": kyc_url or DEFAULT_KYC_URL},
        "detection": {"method": "agentcard_error", "probeKey": "customers_needed_kyc"},
    }


def build_source_connect_gate(source_key: str, title: str, reason: str, connect_url: str) -> Dict[str, Any]:
    """Gate raised when a task needs a data source (e.g. Gmail) that isn't connected."""
    return {
        "gateKey": f"source_connect:{source_key}",
        "type": "source_connect",
        "status": "PENDING",
        "severity": "blocking",
        "presentation": {"title": title, "reason": reason, "cta": f"Connect {source_key.title()}"},
        "action": {"kind": "link", "url": connect_url},
        "detection": {"method": "oauth_callback", "probeKey": f"source_connect:{source_key}"},
        "context": {"sourceKey": source_key},
    }


async def raise_gate_direct(workflow_instance: Any, gate: Dict[str, Any], gate_key: str) -> str:
    """Raise a Gate and block the workflow until the user resolves it.

    Args:
        workflow_instance: The workflow instance (self) — provides user_id,
            agent_id, and the `_signal_responses` inbox.
        gate: The Gate object (presentation/action/detection...). See
            back-end gateSchema and docs/plans/active/sms-onboarding-and-gates.md.
        gate_key: Dedup identity (e.g. "subscription", "source_connect:gmail").

    Returns:
        The user's response text.

    Raises:
        GateRejectedError: If the user declines the gate.
    """
    info = workflow.info()
    workflow_id = info.workflow_id
    user_id = workflow_instance.user_id
    agent_id = workflow_instance.agent_id
    question = str(gate.get("presentation", {}).get("title") or "Action needed")

    # Create (or dedup onto) the gate. The backend emits the in-stream gate
    # message, so we do NOT post our own here (avoids a duplicate card).
    request_id = await workflow.execute_activity(
        create_gate_request_activity,
        args=[
            str(user_id or ""),
            str(agent_id or ""),
            str(workflow_id or ""),
            question,
            gate,
            gate_key,
        ],
        start_to_close_timeout=timedelta(seconds=30),
        retry_policy=RetryPolicy(maximum_attempts=3),
    )
    logger.info("Gate raised, awaiting resolution", request_id=request_id, gate_key=gate_key)

    # Park until the backend signals this request's resolution (same inbox the
    # approval flow uses; the backend fans a resolve out to every waiter).
    await workflow.wait_condition(lambda: request_id in workflow_instance._signal_responses)
    signal_response = workflow_instance._signal_responses.pop(request_id)

    declined = bool(signal_response) and signal_response.strip() == REJECTION_SENTINEL

    # Close the in-stream card by replacing the IN_PROGRESS gate message
    # (same toolCallId = request_id). A resolved gate closes as a FINISHED
    # tool call; a declined gate closes as an ERROR tool call so the FE
    # renders it as a failed/errored action rather than a success.
    closed_gate = {**gate, "status": "REJECTED" if declined else "RESOLVED"}
    close_event = ToolEvent(
        type=EventType.POST_MESSAGE,
        title="Gate declined" if declined else "Gate resolved",
        message="",
        status=MessageStatus.ERROR if declined else MessageStatus.FINISHED,
        metadata={"gate": closed_gate, "attentionRequestId": request_id},
    )
    await workflow_instance._handle_tool_event(close_event, request_id, TOOL_NAME)

    if declined:
        logger.info("Gate declined by user", request_id=request_id, gate_key=gate_key)
        raise GateRejectedError(gate_key, request_id)

    logger.info("Gate resolved by user", request_id=request_id, gate_key=gate_key)
    return signal_response or ""
