"""Exact finalizer admission for a bounded browser stop, separate from user pause."""
from __future__ import annotations

from datetime import timedelta
import math
from typing import Any

from temporalio import activity, workflow


def _blocked(owner: Any) -> bool:
    return bool(owner.is_paused or getattr(owner, "_kill_request", None) is not None
                or getattr(owner, "_orphaned", False)
                or getattr(owner, "_has_credits", True) is False)


def register_finalizer(owner: Any, *, task_id: str, tool_id: str,
                       activity_id: str, limit: int, timeout_seconds: float) -> dict | None:
    """Only the native, single-browser root can own this optional handshake."""
    if _blocked(owner) or getattr(owner, "_browser_execution_task_id", None) != tool_id:
        return None
    if (type(limit) is not int or limit <= 0 or type(timeout_seconds) not in (int, float)
            or not math.isfinite(timeout_seconds) or timeout_seconds <= 0):
        return None
    info = workflow.info()
    ticket = {"version": 1, "agent_id": owner.agent_id, "workflow_id": info.workflow_id,
              "run_id": info.run_id, "first_run_id": info.first_execution_run_id,
              "task_id": task_id, "tool_id": tool_id, "activity_id": activity_id,
              "attempt": 1, "nonce": str(workflow.uuid4()), "limit": limit,
              "requirement_revision": getattr(owner, "_response_schema_revision", None)}
    records = getattr(owner, "_browser_finalizers", None)
    if records is None:
        records = owner._browser_finalizers = {}
    records[tool_id] = {"ticket": ticket, "timeout_seconds": timeout_seconds,
                        "phase": "acting", "deadline": None, "accepted": False,
                        "pending_deadline": workflow.now().timestamp() + timeout_seconds}
    return ticket


def acknowledge_finalizer(owner: Any, payload: dict) -> bool:
    if _blocked(owner) or not isinstance(payload, dict):
        return False
    ticket = payload.get("ticket")
    if not isinstance(ticket, dict):
        return False
    record = getattr(owner, "_browser_finalizers", {}).get(ticket.get("tool_id"))
    if not record or ticket != record["ticket"] or record["phase"] != "acting":
        return False
    current = workflow.info()
    if (ticket["run_id"] != current.run_id or ticket["workflow_id"] != current.workflow_id
            or ticket["first_run_id"] != current.first_execution_run_id):
        return False
    deadline = payload.get("deadline")
    now = workflow.now().timestamp()
    if type(deadline) not in (int, float) or not now < deadline <= now + record["timeout_seconds"]:
        return False
    if (type(payload.get("steps")) is not int or payload.get("steps") != ticket["limit"]
            or ticket["requirement_revision"] != getattr(owner, "_response_schema_revision", None)):
        return False
    record.update(phase="finalizing", deadline=deadline)
    return True


def request_budget_stop(owner: Any, request: dict) -> dict:
    """Workflow update: a refusal leaves the existing pause path responsible."""
    if _blocked(owner) or not isinstance(request, dict) or type(request.get("budget")) is not int:
        return {"accepted": False}
    info = workflow.info()
    if request.get("first_run_id") != info.first_execution_run_id:
        return {"accepted": False}
    records = getattr(owner, "_browser_finalizers", {})
    if len(records) != 1:
        return {"accepted": False}
    record = next(iter(records.values()))
    ticket = record["ticket"]
    if (request["budget"] != ticket["limit"]
            or ticket["agent_id"] != owner.agent_id or ticket["workflow_id"] != info.workflow_id
            or ticket["first_run_id"] != info.first_execution_run_id
            or ticket["run_id"] != info.run_id or ticket["tool_id"] != getattr(owner, "_browser_execution_task_id", None)
            or ticket["requirement_revision"] != getattr(owner, "_response_schema_revision", None)):
        return {"accepted": False}
    # Native entry owns exactly one background task. Never defer other work.
    active = getattr(owner, "_background_tasks", {})
    if set(active) != {ticket["tool_id"]}:
        return {"accepted": False}
    now = workflow.now().timestamp()
    if record["phase"] == "acting":
        deadline = record.get("pending_deadline")
        if (type(deadline) not in (int, float) or not math.isfinite(deadline)
                or now >= deadline):
            return {"accepted": False}
        # This is not acceptance: every ordinary poll must revalidate the same
        # native owner until its existing activity announces finalizer readiness.
        return {"accepted": False, "pending": True, "task_id": ticket["task_id"],
                "run_id": ticket["run_id"], "first_run_id": ticket["first_run_id"],
                "deadline": deadline}
    if (record["phase"] != "finalizing"
            or type(record["deadline"]) not in (int, float)
            or not math.isfinite(record["deadline"]) or now >= record["deadline"]):
        return {"accepted": False}
    record["accepted"] = True
    return {"accepted": True, "task_id": ticket["task_id"], "run_id": ticket["run_id"],
            "first_run_id": ticket["first_run_id"], "deadline": record["deadline"]}


async def announce_finalizer(ticket: dict | None, *, steps: int) -> bool:
    """An optional handshake never changes normal finalizer work or cancellation."""
    if ticket is None:
        return False
    info = activity.info()
    if (info.workflow_id != ticket["workflow_id"] or info.workflow_run_id != ticket["run_id"]
            or info.activity_id != ticket["activity_id"] or info.attempt != ticket["attempt"]
            or info.start_to_close_timeout is None):
        return False
    from helpers.query_parent_state import get_temporal_client
    client = get_temporal_client()
    if client is None:
        return False
    deadline = (info.started_time + info.start_to_close_timeout).timestamp()
    if deadline <= workflow_time():
        return False
    try:
        handle = client.get_workflow_handle(info.workflow_id, run_id=info.workflow_run_id)
        return await handle.execute_update("browser_finalizer_ready", {
            "ticket": ticket, "deadline": deadline, "steps": steps,
        }, rpc_timeout=timedelta(seconds=min(15, max(0.001, deadline - workflow_time())))) is True
    except Exception:
        return False


def workflow_time() -> float:
    # Activity wall time, not workflow deterministic time.
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).timestamp()


async def finish_budget_stop(owner: Any, ticket: dict | None, result: dict) -> None:
    if ticket is None or _blocked(owner):
        return
    record = getattr(owner, "_browser_finalizers", {}).get(ticket["tool_id"])
    if (record and record["ticket"] == ticket and record["accepted"]
            and result.get("status") == "max_iterations"):
        # Called after the manager's result event has been consumed, before join
        # can release the native-entry coroutine to dispatch more work.
        await owner.pause("budget")


def forget_finalizer(owner: Any, ticket: dict | None) -> None:
    if ticket is None:
        return
    records = getattr(owner, "_browser_finalizers", {})
    record = records.get(ticket["tool_id"])
    if record and record["ticket"] == ticket:
        del records[ticket["tool_id"]]


def finalizer_stop_requested(owner: Any, ticket: dict | None) -> bool:
    if ticket is None:
        return False
    record = getattr(owner, "_browser_finalizers", {}).get(ticket["tool_id"])
    return bool(record and record["ticket"] == ticket and record["accepted"]
                and (_blocked(owner) or ticket["requirement_revision"] != getattr(owner, "_response_schema_revision", None)
                     or workflow.now().timestamp() >= record["deadline"]))


def finalizer_result(owner: Any, ticket: dict | None, result: dict) -> dict:
    record = getattr(owner, "_browser_finalizers", {}).get((ticket or {}).get("tool_id"))
    if (ticket is not None and record and record["accepted"]
            and ticket["requirement_revision"] != getattr(owner, "_response_schema_revision", None)):
        result = dict(result)
        result.pop("structured_response", None)
    return result


def budget_stop_pending(owner: Any) -> bool:
    return any(record.get("accepted") is True
               for record in getattr(owner, "_browser_finalizers", {}).values())
