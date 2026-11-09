"""Background spawn_agent tasks and agent-to-agent rows: structural markers + rendering.

    spawn_agent(run_in_background=true, id=T)
        ─▶ FINISHED "Started … Address: A" row under T {runInBackground, hidden}
           (the model's tool_result for T forever; hidden from the FE)
        ─▶ workflow asyncio task runs the unchanged executor under T; every row
           it posts under T (or T:<n>) carries {excludeFromModel: true}, so the
           FE sees exactly a foreground spawn's rows and the model never does
        ─▶ completion: ONE appended USER row {agentNotification: true} whose text
           is the Codex completion body (see below)

Agent-to-agent content follows Codex (codex-rs/core/src/context/
inter_agent_message.rs, inter_agent_completion_message.rs). The model sees it
as ASSISTANT-role content (providers/rose/inter_agent_context.py)::

    Message Type: MESSAGE | NEW_TASK | FINAL_ANSWER | FAILED
    Task name: <recipient path>
    Sender: <sender path>
    Payload:
    <text>

Storage stays USER rows with metadata kinds (agentMessage / agentNotification):
response-schema feedback, "real user instruction" logic, DAG interrupt
detection and planner memory skip them by metadata, never by text.

CRITICAL: pure module (no I/O, no clock, no randomness) — imported inside the
Temporal workflow sandbox.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

AGENT_NOTIFICATION_TOOL_NAME = "agent_notification"
# Agent types whose work lives in a durable child workflow (not an activity).
CHILD_WORKFLOW_AGENT_TYPES = frozenset({"general_purpose", "for_each"})

AGENT_MESSAGE_TYPES = frozenset({"MESSAGE", "NEW_TASK"})
NOTIFICATION_MESSAGE_TYPES = {"completed": "FINAL_ANSWER", "failed": "FAILED"}
# Codex session_prefix.rs: 1000-token completion budget minus a 100-token envelope.
ERROR_PAYLOAD_MAX_TOKENS = 900
_APPROX_BYTES_PER_TOKEN = 4


def _metadata(message: Dict[str, Any]) -> Dict[str, Any]:
    metadata = message.get("metadata") if isinstance(message, dict) else None
    return metadata if isinstance(metadata, dict) else {}


def is_background_started_metadata(metadata: Any) -> bool:
    """The model-visible "Started … Address" result row of a background spawn."""
    return isinstance(metadata, dict) and metadata.get("runInBackground") is True


def background_execution_metadata(metadata: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """A row the background executor posts under its spawn's id: FE-only."""
    stamped = dict(metadata or {})
    stamped["excludeFromModel"] = True
    return stamped


def is_agent_authored_user_metadata(metadata: Any) -> bool:
    """USER rows written by agents (notifications / agent messages), not by the user."""
    if not isinstance(metadata, dict):
        return False
    return metadata.get("agentNotification") is True or metadata.get("agentMessage") is True


def is_agent_authored_user_row(message: Dict[str, Any]) -> bool:
    return is_agent_authored_user_metadata(_metadata(message))


def truncate_middle_tokens(text: str, max_tokens: int) -> str:
    """Codex ``truncate_middle_with_token_budget``: keep head + tail, mark the cut.

    ~4 bytes per token; the marker reads ``…N tokens truncated…``.
    """
    raw = text.encode("utf-8")
    budget = max(0, max_tokens) * _APPROX_BYTES_PER_TOKEN
    if len(raw) <= budget:
        return text
    left = budget // 2
    right = budget - left
    removed = (len(raw) - budget + _APPROX_BYTES_PER_TOKEN - 1) // _APPROX_BYTES_PER_TOKEN
    head = raw[:left].decode("utf-8", errors="ignore")
    tail = raw[len(raw) - right :].decode("utf-8", errors="ignore") if right else ""
    return f"{head}…{removed} tokens truncated…{tail}"


def inter_agent_body(message_type: str, *, task_name: str, sender: str, payload: str) -> str:
    """Codex InterAgentMessage / InterAgentCompletionMessage body."""
    return f"Message Type: {message_type}\nTask name: {task_name}\nSender: {sender}\nPayload:\n{payload}"


def agent_message_type(metadata: Dict[str, Any]) -> str:
    value = metadata.get("messageType")
    if isinstance(value, str) and value in AGENT_MESSAGE_TYPES:
        return value
    return "MESSAGE"


def render_agent_message_text(text: str, metadata: Dict[str, Any]) -> str:
    """Model-visible body of a stored agent-to-agent row (raw text + metadata)."""
    recipient = metadata.get("toAgentPath") or metadata.get("recipientTaskId") or "unknown"
    sender = metadata.get("fromAgentPath") or metadata.get("fromAgentId") or "unknown"
    return inter_agent_body(
        agent_message_type(metadata), task_name=str(recipient), sender=str(sender), payload=text or ""
    )


def model_agent_row_text(message: Dict[str, Any]) -> Optional[str]:
    """Inter-agent body of an agent-authored USER row, or None for any other row.

    Notifications store their rendered body; agent messages store the raw
    payload and are rendered from metadata.
    """
    metadata = _metadata(message)
    text = str(message.get("text") or "")
    if metadata.get("agentMessage") is True:
        return render_agent_message_text(text, metadata)
    if metadata.get("agentNotification") is True:
        return text
    return None


def build_agent_notification_text(
    *,
    recipient: str,
    sender: str,
    agent_type: str,
    status: str,
    summary: str,
    structured_response: Any = None,
    file_pointers: Optional[List[Dict[str, Any]]] = None,
    session_id: Optional[str] = None,
    failed: Optional[bool] = None,
) -> str:
    """One completion notification (Codex completion message shape).

    completed → FINAL_ANSWER with the uncapped result; failed → FAILED with
    the error text capped Codex-style (head + tail). ``failed`` (when given)
    picks the type for a "paused" task: a pause is FAILED only when the run
    failed. A browser ending names its provider ``session_id`` (paused, kept
    for continuation) on every outcome.
    """
    message_type = _notification_message_type(status, failed)
    result = summary.strip() or f"Background {agent_type} agent {status}."
    if message_type != "FINAL_ANSWER":
        result = truncate_middle_tokens(result, ERROR_PAYLOAD_MAX_TOKENS)
    sections = [result]
    if structured_response not in (None, {}, []):
        sections.append(
            "Structured Response: " + json.dumps(structured_response, ensure_ascii=False, sort_keys=True, default=str)
        )
    for pointer in file_pointers or []:
        if isinstance(pointer, dict):
            sections.append("File: " + json.dumps(pointer, ensure_ascii=False, sort_keys=True, default=str))
    if session_id:
        sections.append(f"Session ID: {session_id}")
    return inter_agent_body(message_type, task_name=recipient, sender=sender, payload="\n\n".join(sections))


def build_pending_background_status_text(records: List[Dict[str, Any]]) -> Optional[str]:
    """Verifier evidence: factual list of background agents still running.

    Appended after the verifier's conversation evidence only when non-empty,
    so the verifier's cached prefix is unchanged for every other call.
    """
    lines = []
    for record in records:
        if not isinstance(record, dict):
            continue
        goal = " ".join(str(record.get("goal") or "").split())
        lines.append(
            f"- {record.get('address')} (type: {record.get('agent_type')}, status: {record.get('status')}): {goal}"
        )
    if not lines:
        return None
    return "Background agents still running when completion was attempted:\n" + "\n".join(lines)


def _notification_message_type(status: str, failed: Optional[bool]) -> str:
    if failed is not None:
        return "FAILED" if failed else "FINAL_ANSWER"
    return NOTIFICATION_MESSAGE_TYPES.get(status, "FAILED")


def agent_notification_metadata(
    *,
    address: str,
    agent_type: str,
    status: str,
    background_task_id: Optional[str],
    idempotency_key: str,
    run: int = 1,
    session_id: Optional[str] = None,
    failed: Optional[bool] = None,
) -> Dict[str, Any]:
    metadata = {
        "agentNotification": True,
        "toolName": AGENT_NOTIFICATION_TOOL_NAME,
        "fromAgentAddress": address,
        "agentType": agent_type,
        "status": status,
        "messageType": _notification_message_type(status, failed),
        "backgroundTaskId": background_task_id,
        "idempotencyKey": idempotency_key,
    }
    if run > 1:
        metadata["backgroundRun"] = run
    if session_id:
        metadata["sessionId"] = session_id
    return metadata


# Browser/code tasks keep live state (browser profile, code sandbox). A finished
# (completed/failed) one cannot be messaged; one whose run a user pause ended is
# "paused", and a message resumes it with an explicit continue_conversation.
RESUMABLE_TASK_TYPES = frozenset({"browser", "code"})
FINISHED_TASK_STATUSES = frozenset({"completed", "failed"})
PAUSED_TASK_STATUS = "paused"
# Internal spawn args a resume sets (never model-supplied): see workflows/background_agents.py.
RESUME_CONVERSATION_KEYS = frozenset(
    {
        "_resume_paused_conversation",
        "_fresh_conversation",
        "_user_attachments",
        "_resume_code_provider",
        "_resume_cli_settings",
    }
)


def background_message_refusal(
    record: Dict[str, Any], continue_conversation: Optional[bool], *, by_user: bool = False
) -> Optional[str]:
    """Why send_message_to_agent cannot deliver to this own background task (None when it can).

    Reads the task's structured type, status and foreground flag only. Running
    tasks and background explore tasks are always deliverable; a finished
    foreground spawn never is (its result already is the spawn call's result).
    ``by_user``: the owner typed to the code agent in its own view; a completed or
    failed background code task then resumes its own conversation too (its
    persistent session keeps the sandbox and the CLI conversation).
    """
    agent_type = record.get("agent_type")
    status = record.get("status")
    address = record.get("path") or record.get("address") or "that agent"
    if record.get("foreground") and status != "running":
        resume = (
            " To continue in its code session and branch, spawn a new code agent with the code_session_id "
            "from its result."
            if agent_type == "code"
            else ""
        )
        return (
            f"{address} is a {status} foreground {agent_type} agent: its result is the result of the spawn_agent "
            f"call that ran it, and it takes no more messages. Spawn a new {agent_type} agent for new work.{resume}"
        )
    if agent_type not in RESUMABLE_TASK_TYPES:
        return None
    # A person's resume: a code agent continues its own CLI conversation; a finished
    # browser kept no conversation, so it starts a fresh one carrying its earlier
    # goal and result (the browser tool's continue_conversation=false recovery).
    user_resume = by_user and (
        (agent_type == "code" and continue_conversation is True)
        or (agent_type == "browser" and continue_conversation is False)
    )
    if status in FINISHED_TASK_STATUSES and not user_resume:
        return (
            f"{address} is a {status} {agent_type} agent; completed browser and code agents cannot be "
            f"messaged. Spawn a new {agent_type} agent for new work."
        )
    if status == PAUSED_TASK_STATUS and continue_conversation is None:
        return (
            f"{address} is a paused {agent_type} agent; set continue_conversation to true to resume "
            "its exact prior conversation or false to start a fresh one."
        )
    return None


# A woken explore/browser/code task gets its previous result (head + tail) as context.
WAKE_PREVIOUS_RESULT_MAX_TOKENS = 2000


def build_background_wake_result(summary: Any, structured_response: Any = None) -> str:
    """A finished run's result as the next run sees it (capped head + tail)."""
    sections = [str(summary or "").strip()]
    if structured_response not in (None, {}, []):
        sections.append(
            "Structured Response: " + json.dumps(structured_response, ensure_ascii=False, sort_keys=True, default=str)
        )
    return truncate_middle_tokens("\n\n".join(part for part in sections if part), WAKE_PREVIOUS_RESULT_MAX_TOKENS)


def build_background_wake_goal(*, message: str, base_goal: str, previous_status: str, previous_result: str) -> str:
    """Goal of a finished explore/browser/code task's next run: the message, then what it already did."""
    previous = truncate_middle_tokens(previous_result.strip(), WAKE_PREVIOUS_RESULT_MAX_TOKENS) or "(no result text)"
    return (
        f"{message.strip()}\n\n"
        "This continues your previous run of this task. Its goal was:\n"
        f"{base_goal.strip()}\n\n"
        f"Its result ({previous_status}):\n"
        f"{previous}"
    )


__all__ = [
    "AGENT_MESSAGE_TYPES",
    "FINISHED_TASK_STATUSES",
    "PAUSED_TASK_STATUS",
    "RESUMABLE_TASK_TYPES",
    "RESUME_CONVERSATION_KEYS",
    "background_message_refusal",
    "AGENT_NOTIFICATION_TOOL_NAME",
    "CHILD_WORKFLOW_AGENT_TYPES",
    "ERROR_PAYLOAD_MAX_TOKENS",
    "NOTIFICATION_MESSAGE_TYPES",
    "agent_message_type",
    "agent_notification_metadata",
    "background_execution_metadata",
    "WAKE_PREVIOUS_RESULT_MAX_TOKENS",
    "build_agent_notification_text",
    "build_background_wake_goal",
    "build_background_wake_result",
    "build_pending_background_status_text",
    "inter_agent_body",
    "is_agent_authored_user_metadata",
    "is_agent_authored_user_row",
    "is_background_started_metadata",
    "model_agent_row_text",
    "render_agent_message_text",
    "truncate_middle_tokens",
]
