"""Static checks on a finished code-agent run: one spawn, one code agent; messages reach it.

RCA 2026-11-06-code-spawn-create-retry-duplicated-sessions (root 1a3d495c,
"Rose Repo Status"): one read-only spawn showed three code-agent children and
send_message_to_agent("/root/rose_repo_status") failed with "No agent or
background task at /root/rose_repo_status".

    run ends ─► hydrate_code_agent_run(base_url, api_key, user_id, root_agent_id)
                  GET /api/agents/<root>                       root rows (incl. the rows the
                                                               code agent posts on its owner)
                  GET /api/agents/code-agents?root_ids=<root>  the sidebar's code-agent children
                  ─► {"root_agent_id", "messages", "code_agents"}
               pure checks on that record (each returns {"passed", "detail", ...evidence}):
                  check_single_code_agent           exactly `expected` code agents under the root,
                                                    one task per code spawn call, no orphan task
                  check_message_reached_code_agent  every send_message_to_agent addressed to a code
                                                    spawn succeeded, the backend delivered it as a
                                                    CLI turn, and the CLI's transcript shows it

Message rows are the agent-detail shape: {role, message|text, metadata}.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

import httpx

CODE_SPAWN_TOOL = "spawn_claude_code_agent"
# Characters of a sent message that must appear in the code agent's own turn.
MESSAGE_MATCH_CHARS = 60


def _rows(messages: Iterable[Any]) -> List[Dict[str, Any]]:
    rows = []
    for message in messages or []:
        if isinstance(message, dict):
            metadata = message.get("metadata")
            rows.append({**message, "metadata": metadata if isinstance(metadata, dict) else {}})
    return rows


def _text(row: Dict[str, Any]) -> str:
    value = row.get("message")
    if not isinstance(value, str):
        value = row.get("text")
    return value if isinstance(value, str) else ""


def _tool_calls(rows: List[Dict[str, Any]], tool: str) -> List[Dict[str, Any]]:
    calls = []
    for row in rows:
        if row.get("role") != "ASSISTANT":
            continue
        for call in row["metadata"].get("tool_calls") or []:
            if isinstance(call, dict) and call.get("tool") == tool and isinstance(call.get("tool_call_id"), str):
                calls.append(call)
    return calls


def code_spawn_calls(messages: Iterable[Any]) -> List[Dict[str, Any]]:
    """The root's spawn_agent(type=code) calls: {tool_call_id, task_name, path, task_ids}."""
    rows = _rows(messages)
    spawns = []
    for call in _tool_calls(rows, "spawn_agent"):
        if call.get("type") != "code":
            continue
        call_id = call["tool_call_id"]
        task_ids = sorted(
            {
                row["metadata"]["task_id"]
                for row in rows
                if row["metadata"].get("toolName") == CODE_SPAWN_TOOL
                and row["metadata"].get("toolCallId") == call_id
                and isinstance(row["metadata"].get("task_id"), str)
            }
        )
        task_name = call.get("task_name") if isinstance(call.get("task_name"), str) else None
        spawns.append(
            {
                "tool_call_id": call_id,
                "task_name": task_name,
                "path": f"/root/{task_name}" if task_name else None,
                "task_ids": task_ids,
            }
        )
    return spawns


def check_single_code_agent(run: Dict[str, Any], expected: int = 1) -> Dict[str, Any]:
    """Exactly `expected` code agents under the root: one per code spawn call, none duplicated."""
    root = run.get("root_agent_id")
    agents = [
        agent
        for agent in run.get("code_agents") or []
        if isinstance(agent, dict) and (root is None or agent.get("root_agent_id") == root)
    ]
    agent_ids = {agent.get("code_agent_id") for agent in agents}
    spawns = code_spawn_calls(run.get("messages") or [])
    problems = []
    if len(agents) != expected:
        problems.append(f"{len(agents)} code agents under the root (expected {expected})")
    if len(spawns) != expected:
        problems.append(f"{len(spawns)} code spawn calls (expected {expected})")
    for spawn in spawns:
        if len(spawn["task_ids"]) > 1:
            problems.append(f"spawn {spawn['tool_call_id']} reported {len(spawn['task_ids'])} tasks")
    reported = {task for spawn in spawns for task in spawn["task_ids"]}
    orphans = sorted(task for task in agent_ids if task not in reported)
    if orphans:
        problems.append(f"code agents no spawn reported (duplicated creates): {orphans}")
    return {
        "passed": not problems,
        "detail": "; ".join(problems) or f"{len(agents)} code agent(s), one per spawn",
        "code_agent_ids": sorted(str(task) for task in agent_ids),
        "spawns": spawns,
    }


def check_message_reached_code_agent(run: Dict[str, Any]) -> Dict[str, Any]:
    """Every send_message_to_agent to a code spawn succeeded and its CLI saw the message."""
    rows = _rows(run.get("messages") or [])
    spawns = code_spawn_calls(rows)
    by_address: Dict[str, Dict[str, Any]] = {}
    for spawn in spawns:
        for address in (spawn["path"], spawn["tool_call_id"]):
            if address:
                by_address[address] = spawn
    sends = [call for call in _tool_calls(rows, "send_message_to_agent") if call.get("to") in by_address]
    if not sends:
        return {"passed": False, "detail": "no send_message_to_agent addressed a code agent", "sends": []}
    results = []
    for call in sends:
        spawn = by_address[call["to"]]
        message = str(call.get("message") or "")
        needle = message.strip()[:MESSAGE_MATCH_CHARS]
        outcome = _send_outcome(rows, call["tool_call_id"])
        receipt = _delivery_receipt(rows, spawn, message)
        seen = any(
            row["metadata"].get("toolCallId") == spawn["tool_call_id"]
            and row["metadata"].get("toolName") == CODE_SPAWN_TOOL
            and "[Agent → " in _text(row)
            and needle in _text(row)
            for row in rows
        )
        problems = []
        if outcome is None or outcome.get("status") != "FINISHED":
            problems.append(f"send {call['tool_call_id']} result: {outcome}")
        if receipt is None:
            problems.append("no delivered CLI turn (a2a received row) for the message")
        if not seen:
            problems.append("the code agent's transcript never shows the message")
        results.append({"to": call["to"], "send": outcome, "delivered": receipt is not None, "seen": seen, "problems": problems})
    failed = [result for result in results if result["problems"]]
    return {
        "passed": not failed,
        "detail": "; ".join(p for result in failed for p in result["problems"]) or f"{len(results)} message(s) delivered",
        "sends": results,
    }


def _send_outcome(rows: List[Dict[str, Any]], call_id: str) -> Optional[Dict[str, Any]]:
    for row in reversed(rows):
        metadata = row["metadata"]
        if metadata.get("toolName") == "send_message_to_agent" and metadata.get("toolCallId") == call_id:
            if metadata.get("toolStatus") in ("FINISHED", "ERROR"):
                return {"status": metadata.get("toolStatus"), "text": _text(row)[:300]}
    return None


def _delivery_receipt(rows: List[Dict[str, Any]], spawn: Dict[str, Any], message: str) -> Optional[Dict[str, Any]]:
    """The backend's row for a message it delivered as the code agent's CLI turn."""
    for row in rows:
        metadata = row["metadata"]
        a2a = metadata.get("a2a")
        if (
            isinstance(a2a, dict)
            and a2a.get("direction") == "received"
            and metadata.get("action_type") == "agent_message"
            and metadata.get("task_id") in spawn["task_ids"]
            and str(a2a.get("text") or "").strip() == message.strip()
        ):
            return row
    return None


async def hydrate_code_agent_run(base_url: str, api_key: str, user_id: str, root_agent_id: str) -> Dict[str, Any]:
    """Read a finished run's root rows and code-agent children through the public API."""
    headers = {"X-API-Key": api_key, "X-User-Id": user_id}
    base = base_url.rstrip("/")
    async with httpx.AsyncClient(timeout=30.0) as client:
        detail = await client.get(f"{base}/api/agents/{root_agent_id}", headers=headers)
        detail.raise_for_status()
        listed = await client.get(f"{base}/api/agents/code-agents", params={"root_ids": root_agent_id}, headers=headers)
        listed.raise_for_status()
    body = detail.json()
    return {
        "root_agent_id": root_agent_id,
        "messages": body.get("messages") or (body.get("agent") or {}).get("messages") or [],
        "code_agents": listed.json().get("code_agents") or [],
    }
