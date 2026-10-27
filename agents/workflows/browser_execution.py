"""Browser execution surface: native task lifecycle, then ordinary verification."""
from __future__ import annotations

import uuid
import json
from typing import Any

from helpers.background_agents import PAUSED_TASK_STATUS
from loop.run_agent import _requirement_keys


def browser_execution_identity(agent_id: str, context: list[dict], *, requirements: list[str], schema: dict) -> str:
    """Bind dispatch to durable authored input and its accepted schema."""
    keys = sorted(_requirement_keys(context))
    if not keys:
        raise ValueError("Browser execution requires a durable user requirement identity")
    payload = json.dumps([agent_id, keys, requirements, schema], sort_keys=True, separators=(",", ":"))
    return str(uuid.uuid5(uuid.NAMESPACE_URL, payload))


async def run_browser_execution(owner: Any, context: list[dict]) -> dict:
    """Use the same real background browser task and join as planned execution.

    The wrapper never selects an alternate research surface. Native browser
    terminal success is required before the usual root verifier is invoked.
    """
    if owner._kill_request is not None or owner._orphaned:
        return {"status": "aborted", "context": context}
    if owner.is_paused:
        return {"status": "paused", "context": context}
    await owner._check_credits()
    if owner.is_paused:
        return {"status": "paused", "context": context}
    if not owner.output_schema:
        return {"status": "error", "context": context, "message": "Browser execution requires an output schema"}
    # A durable row can arrive during the poll; only bind a coherent accepted
    # requirement/schema pair. The ordinary revision owner controls refresh.
    while True:
        await owner._prepare_response_schema_continuation()
        owner._require_current_response_schema_acceptance()
        revision = owner._response_schema_revision
        requirements = await owner._response_schema_user_messages(include_schema=False)
        if owner._kill_request is not None or owner._orphaned:
            return {"status": "aborted", "context": context}
        if owner.is_paused:
            return {"status": "paused", "context": context}
        if revision != owner._response_schema_revision:
            continue
        owner._require_current_response_schema_acceptance()
        contract = json.dumps([requirements, owner.output_schema], sort_keys=True, separators=(",", ":"))
        previous_id = owner._browser_execution_task_id
        previous = owner._background_tasks.get(previous_id) or owner._background_finished.get(previous_id) or {}
        if previous_id and owner._browser_execution_contract != contract:
            if previous_id not in owner._background_tasks and previous.get("status") != PAUSED_TASK_STATUS:
                return {"status": "error", "context": context, "message": "Completed browser cannot acknowledge later requirements"}
            # The running/paused native browser already synchronizes real USER
            # rows before acting and verifying. Retain that conversation; never
            # replay a possibly completed write in a fresh browser.
            current_keys = _requirement_keys(owner.context or context)
            baseline_keys = set(map(tuple, owner._browser_execution_requirement_keys))
            new_keys = current_keys - baseline_keys
            rows = [row for row in (owner.context or context) if _requirement_keys([row]) & new_keys]
            if not new_keys or set().union(*(_requirement_keys([row]) for row in rows)) != new_keys or any(
                not (row.get("message_id") or row.get("id")) for row in rows
            ):
                return {"status": "error", "context": context, "message": "Browser update requires durable user message identities"}
            # Native browser sync deliberately excludes ancestor-authored rows.
            if any((row.get("metadata") or {}).get("agentMessage") for row in rows):
                return {"status": "error", "context": context, "message": "Native browser cannot acknowledge ancestor task updates"}
            owner._browser_execution_pending_input_ids = sorted(set(owner._browser_execution_pending_input_ids) | {
                str(row.get("message_id") or row.get("id")) for row in rows
            })
            owner._browser_execution_contract = contract
            task_id = previous_id
        else:
            task_id = previous_id
        if task_id is None:
            task_id = browser_execution_identity(owner.agent_id, owner.context or context, requirements=requirements, schema=owner.output_schema)
            owner._browser_execution_task_id = task_id
            owner._browser_execution_contract = contract
            owner._browser_execution_requirement_keys = [list(key) for key in sorted(_requirement_keys(owner.context or context))]
        break
    goal = "\n\n".join(requirements)
    record = owner._background_tasks.get(task_id) or owner._background_finished.get(task_id)
    if record is None:
        # A replacement without its durable task record must not create a new
        # browser for a dispatch already present in the real transcript.
        if any((row.get("metadata") or {}).get("backgroundTaskId") == task_id for row in context):
            return {"status": "error", "context": context, "message": "Browser execution state missing for existing dispatch"}
        started = await owner._start_background_spawn({
            "type": "browser",
            "task_name": f"browser_{task_id.replace('-', '')[:12]}",
            "goal": goal,
            "start_url": "about:blank",
            "output_schema": owner.output_schema,
            "run_in_background": True,
        }, task_id)
        if started.get("error"):
            return {"status": "error", "context": context, "message": started.get("message", "Browser dispatch failed")}
    elif record.get("status") == PAUSED_TASK_STATUS:
        if owner.is_paused:
            return {"status": "paused", "context": context}
        resumed = await owner._wake_background_task(
            task_id, goal, message_id=None, sender=None, continue_conversation=True,
        )
        if not resumed.get("woke"):
            return {"status": "error", "context": context, "message": resumed.get("reason", "Browser resume failed")}
    else:
        owner._relaunch_background_tasks()
    joined = await owner._await_dag_background_spawn(task_id)
    if isinstance(joined, dict) and joined.get("generation_handoff"):
        return {"status": "generation_handoff", "context": context, "handoff_task_queue": joined.get("handoff_task_queue")}
    if owner._kill_request is not None or owner._orphaned:
        return {"status": "aborted", "context": context}
    if owner.is_paused:
        return {"status": "paused", "context": context}
    finished = owner._background_finished.get(task_id) or {}
    if joined is not True or finished.get("browser_verified") is not True:
        return {"status": "error", "context": context, "message": "Native browser task did not complete successfully"}
    pending_ids = set(owner._browser_execution_pending_input_ids)
    receipt = finished.get("browser_instruction_receipt") or {}
    if pending_ids and not (
        receipt.get("read_confirmed") is True and receipt.get("schema_current") is True
        and pending_ids.issubset(set(receipt.get("message_ids") or []))
    ):
        return {"status": "error", "context": context, "message": "Native browser did not acknowledge the updated requirements"}
    verified = await owner._attempt_post_dag_completion(owner.agent_id, owner.user_id, owner.model)
    if verified and verified.get("superseded_by_user_feedback") is True:
        # The shared finish boundary continues with refreshed requirements before
        # accepting a verdict. Supersession is not terminal browser failure.
        return {**verified, "status": "completed", "context": verified.get("context", context)}
    if not verified or verified.get("score", 0) < 1 or verified.get("verifier_error"):
        return {"status": "error", "context": context, "message": (verified or {}).get("reasoning", "Browser completion verification failed")}
    # The completion helper polls again. Bind the actual verifier snapshot to
    # native acknowledgment too: input can arrive after browser's final sync,
    # during join, or between this wrapper and the verifier's fresh poll.
    judged_keys = set(map(tuple, verified.get("_verified_user_requirement_keys", [])))
    new_judged_keys = judged_keys - set(map(tuple, owner._browser_execution_requirement_keys))
    if new_judged_keys:
        rows = [row for row in (owner.context or context) if _requirement_keys([row]) & new_judged_keys]
        covered = set().union(*(_requirement_keys([row]) for row in rows))
        ids = {str(row.get("message_id") or row.get("id")) for row in rows if row.get("message_id") or row.get("id")}
        if covered != new_judged_keys or len(ids) != len(rows) or any((row.get("metadata") or {}).get("agentMessage") for row in rows) or not (
            receipt.get("read_confirmed") is True and receipt.get("schema_current") is True
            and ids.issubset(set(receipt.get("message_ids") or []))
        ):
            return {"status": "error", "context": context, "message": "Verifier requirements were not acknowledged by the native browser"}
    if not new_judged_keys and verified.get("_verified_requirement_revision", revision) != revision:
        return {"status": "error", "context": context, "message": "Changed verifier requirements have no native browser acknowledgment"}
    owner._browser_execution_pending_input_ids = []
    owner._browser_execution_requirement_keys = [list(key) for key in sorted(judged_keys or _requirement_keys(owner.context or context))]
    return {**verified, "status": "completed", "context": verified.get("context", context)}
