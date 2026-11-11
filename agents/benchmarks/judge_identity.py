"""Persist an isolated owner for externally executed benchmark judges."""

from contextlib import asynccontextmanager
from typing import AsyncIterator, Any

import httpx


@asynccontextmanager
async def judge_identity(
    *, base_url: str, headers: dict, agent_id: str, goal: str, audit: dict[str, Any]
) -> AsyncIterator[None]:
    """Use the backend's create transaction without launching a competing agent loop."""
    async with httpx.AsyncClient(timeout=90) as client:
        persisted = False
        completed = False
        primary_error: BaseException | None = None
        # The ID is known before the POST, so even an ambiguous create response
        # has one exact cleanup target. DELETE is owner-scoped and soft archives.
        try:
            response = await client.post(
                f"{base_url}/api/agents",
                headers={**headers, "X-Agent-Execution-Mode": "external", "X-Benchmark-Run": headers["X-API-Key"]},
                json={
                    "agent_id": agent_id,
                    "goal": goal,
                    "fast_mode_cache_enabled": False,
                    "memory_enabled": False,
                },
            )
            response.raise_for_status()
            if response.json().get("agent_id") != agent_id:
                raise RuntimeError("Judge identity creation returned a different agent_id")
            if response.json().get("execution_mode") != "external":
                raise RuntimeError("Backend did not acknowledge external judge execution")
            audit["identity_persisted"] = True
            persisted = True
            yield
            completed = True
        except BaseException as error:
            primary_error = error
            audit["execution_error"] = f"{type(error).__name__}: {error}"
            raise
        finally:
            try:
                try:
                    if persisted:
                        trace = await client.get(f"{base_url}/api/agents/{agent_id}", headers=headers)
                        trace.raise_for_status()
                        snapshot = trace.json()
                        audit["trace"] = snapshot
                        agent = snapshot["agent"]
                        terminal = await client.patch(
                            f"{base_url}/api/agents/{agent_id}/status", headers=headers,
                            json={
                                "status": "COMPLETED" if completed else "FAILED",
                                "progress": agent["progress"],
                                "tokenCount": agent["token_count"],
                                "tokensIn": agent["tokens_in"],
                                "tokensOut": agent["tokens_out"],
                                "contextSize": agent["context_size"],
                                "messageCount": agent["message_count"],
                            },
                        )
                        terminal.raise_for_status()
                finally:
                    response = await client.delete(f"{base_url}/api/agents/{agent_id}", headers=headers)
                    if response.status_code not in (204, 404):
                        response.raise_for_status()
                        raise RuntimeError(f"Judge archive returned HTTP {response.status_code}")
                    audit["archived"] = response.status_code == 204
                    if response.status_code == 404:
                        raise RuntimeError(f"Judge {agent_id} creation/cleanup could not be reconciled")
                    # Archive responses alone cannot certify sandbox release: the kill
                    # path deliberately logs provider errors and leaves retry obligations.
                    persistent_ids = set()
                    for provider in ("claude", "codex"):
                        sessions = await client.get(f"{base_url}/api/{provider}-code-session/agent/{agent_id}", headers=headers)
                        sessions.raise_for_status()
                        rows = sessions.json()["sessions"]
                        audit[f"{provider}_sessions"] = [
                            {"id": row["id"], "status": row["status"], "closedAt": row.get("closedAt")}
                            for row in rows
                        ]
                        if any(row["status"] == "ACTIVE" for row in rows):
                            raise RuntimeError(f"Judge {agent_id} still has an active {provider} session after archive")
                        persistent_ids.update(row["codeSessionId"] for row in rows if row.get("codeSessionId"))
                    audit["persistent_sessions"] = []
                    for session_id in sorted(persistent_ids):
                        persistent = await client.get(
                            f"{base_url}/api/claude-code-session/code-sessions/{session_id}", headers=headers
                        )
                        persistent.raise_for_status()
                        view = persistent.json()
                        if view["owner_agent_id"] != agent_id:
                            raise RuntimeError(f"Judge {agent_id} persistent session {session_id} has a different owner")
                        if view["state"] != "RETIRED":
                            retired = await client.delete(
                                f"{base_url}/api/claude-code-session/code-sessions/{session_id}", headers=headers
                            )
                            retired.raise_for_status()
                            confirmed = await client.get(
                                f"{base_url}/api/claude-code-session/code-sessions/{session_id}", headers=headers
                            )
                            confirmed.raise_for_status()
                            view = confirmed.json()
                        audit["persistent_sessions"].append(view)
                        if view["owner_agent_id"] != agent_id or view["state"] != "RETIRED":
                            raise RuntimeError(f"Judge {agent_id} persistent session {session_id} is not retired")
                    audit["cleanup_verified"] = True
            except BaseException as cleanup_error:
                audit["cleanup_error"] = f"{type(cleanup_error).__name__}: {cleanup_error}"
                if primary_error is not None:
                    raise BaseExceptionGroup("Judge execution and cleanup failed", [primary_error, cleanup_error])
                raise
