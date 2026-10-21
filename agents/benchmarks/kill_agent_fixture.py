"""Owned local benchmark fixture: real paused workflows, no provider allocation."""
from urllib.parse import urlsplit

import httpx
from temporalio.client import Client
from config import load_config
from temporal_connection import temporal_connect_options
from utils.tool_schemas import ResponseSchemaConfig

TASK = "kill-agent-subtree"


async def prepare(base_url, root_id, user_id, api_key, task_queue):
    if urlsplit(base_url).hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("kill-agent fixture requires the isolated local benchmark stack")
    headers = {"X-API-Key": api_key, "Content-Type": "application/json"}
    fixture = {"root_id": root_id, "agents": []}
    async with httpx.AsyncClient(timeout=60) as client:
        for label, parent_index in [("target", None), ("grandchild", 0), ("control", None)]:
            parent_id = root_id if parent_index is None else fixture["agents"][parent_index]["agent_id"]
            body = {"goal": f"Kill-agent benchmark {label}: remain paused; perform no external actions.",
                    "user_id": user_id, "parent_agent_id": parent_id, "parent_workflow_id": parent_id,
                    "bus_id": root_id, "start_phase": "execute", "pause_state": True,
                    "depth": 2 if parent_index is not None else 1, "price_limit_cents": 10,
                    "response_schema": {"fields": [{"name": "result", "type": "str", "required": True}]}}
            ResponseSchemaConfig.model_validate(body["response_schema"])
            if task_queue:
                body["task_queue"] = task_queue
            response = await client.post(f"{base_url}/api/agents", headers=headers, json=body)
            response.raise_for_status()
            fixture["agents"].append({"label": label, **response.json()})
        target = fixture["agents"][0]["agent_id"]
        control = fixture["agents"][2]["agent_id"]
        response = await client.post(f"{base_url}/api/agents/{root_id}/messages", headers=headers,
                                    json={"message": f"Stop target agent {target} using kill_agent. Repeat kill_agent on the same target to verify idempotency. Do not stop control agent {control}, yourself, or any other work. Then report the actual tool results and finish.", "role": "USER"})
        response.raise_for_status()
    return fixture


async def verify_and_cleanup(base_url, api_key, fixture):
    config = load_config()
    temporal = await Client.connect(config.temporal.address, **temporal_connect_options(
        config.temporal.address, config.temporal.namespace, config.temporal.api_key))
    observed = {}
    result = {}
    async with httpx.AsyncClient(timeout=60) as client:
        try:
            for row in fixture["agents"]:
                workflow_id = row.get("temporal_workflow_id") or row["agent_id"]
                description = await temporal.get_workflow_handle(workflow_id).describe()
                observed[row["label"]] = description.status.name
            result = {"ok": observed == {"target": "TERMINATED", "grandchild": "TERMINATED", "control": "RUNNING"},
                    "workflow_states": observed, "fixture": fixture}
        finally:
            for row in fixture["agents"]:
                response = await client.delete(f"{base_url}/api/agents/{row['agent_id']}", headers={"X-API-Key": api_key})
                if response.status_code not in {200, 204, 404}:
                    response.raise_for_status()
    result["cleanup_states"] = {}
    for row in fixture["agents"]:
        description = await temporal.get_workflow_handle(row.get("temporal_workflow_id") or row["agent_id"]).describe()
        result["cleanup_states"][row["label"]] = description.status.name
    if any(state == "RUNNING" for state in result["cleanup_states"].values()):
        raise RuntimeError("Owned benchmark workflow cleanup remains unconfirmed")
    return result
