"""Native PARK-TIME measurement, separate from the hosted last-served HTTP report."""
from urllib.parse import urlsplit
from datetime import datetime


def measurement_required(task):
    return any(check.get("left_on_sign_in_form") is True
               for evaluator in task.evaluators
               for check in evaluator.get("checks", []) if isinstance(check, dict))


def parked_page_observation(data, manifest, user_id):
    agent = data.get("agent") or {}
    # Aggregate root status can stay ACTIVE while its exact browser task is parked.
    if agent.get("status") not in ("ACTIVE", "PAUSED") or not manifest:
        return None
    requests = (data.get("_benchmark") or {}).get("pending_attention_requests") or []
    pending = {row.get("id") for row in requests if isinstance(row, dict)
               and row.get("agent_id") == agent.get("agent_id") and row.get("kind") == "auth_assistance"}
    # A later event for the same task (including resume/terminal) invalidates its park.
    latest, prior_time = {}, None
    for row in data.get("messages") or []:
        metadata = row.get("metadata") or {}
        if row.get("role") not in {"USER", "TOOL"}:
            continue
        try:
            at = datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00"))
            if at.tzinfo is None or (prior_time is not None and at <= prior_time):
                return None
        except (KeyError, ValueError, TypeError):
            return None
        prior_time = at
        if row.get("role") == "USER":
            latest.clear()
        elif metadata.get("toolName") == "spawn_browser_agent" and metadata.get("toolCallId"):
            latest[metadata["toolCallId"]] = metadata
    valid = []
    for tool_call_id, metadata in latest.items():
        task_id = metadata.get("task_id")
        obs = metadata.get("browser_page_observation")
        request = metadata.get("requestUserAuthentication") or {}
        if (not isinstance(obs, dict) or obs.get("phase") != "park_time"
                or metadata.get("action_type") != "auth_assistance" or metadata.get("toolStatus") != "IN_PROGRESS"):
            continue
        if obs.get("tool_call_id") != tool_call_id:
            continue
        if not all(isinstance(obs.get(key), str) and obs[key] for key in
                   ("agent_id", "user_id", "task_id", "session_id", "request_id", "target_id", "tool_call_id", "origin", "path")):
            continue
        if (obs["agent_id"] != agent.get("agent_id") or obs["user_id"] != user_id
                or obs["task_id"] != task_id or request.get("taskId") != task_id
                or obs["session_id"] != request.get("steelSessionId")
                or obs["request_id"] != request.get("requestId") or obs["request_id"] not in pending):
            continue
        try:
            entry, origin = urlsplit(manifest["entryUrl"]), urlsplit(obs["origin"])
        except (ValueError, KeyError):
            continue
        prefix, path = entry.path.rstrip("/"), obs["path"]
        if (origin.scheme not in {"http", "https"} or origin.netloc != entry.netloc
                or origin.scheme != entry.scheme or origin.path or origin.query or origin.fragment
                or not path.startswith(prefix + "/") or "{{secret:" in obs["origin"] + path):
            continue
        valid.append({**obs, "path": path[len(prefix):]})
    return valid[0] if len(valid) == 1 else None
