"""Backend HTTP client for the PlannerMemory history table.

All reads/writes go through the backend API (Claim Check pattern: activities
may run on any machine and never touch Postgres directly).
"""

from __future__ import annotations

from typing import Any, Optional

import httpx
import structlog

from config import load_config
from helpers.workflow_generation import workflow_generation_headers

logger = structlog.get_logger(__name__)

DEFAULT_TIMEOUT_S = 10.0


def _base() -> tuple[str, dict[str, str]]:
    config = load_config()
    api_key = config.backend.api_key or ""
    if not api_key:
        raise RuntimeError("BACKEND_API_KEY required for planner memory")
    headers = {"X-API-Key": api_key, "Content-Type": "application/json", **workflow_generation_headers()}
    return config.backend.api_url.rstrip("/"), headers


async def search_memories(
    goal: str,
    *,
    user_id: Optional[str],
    exclude_root_agent_id: Optional[str],
    limit: int = 20,
    passed_only: bool = False,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> list[dict[str, Any]]:
    base, headers = _base()
    body: dict[str, Any] = {"goal": goal, "limit": limit, "passed_only": passed_only}
    if user_id:
        body["user_id"] = user_id
    if exclude_root_agent_id:
        body["exclude_root_agent_id"] = exclude_root_agent_id
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        response = await client.post(f"{base}/api/planner-memory/search", headers=headers, json=body)
    response.raise_for_status()
    data = response.json()
    candidates = data.get("candidates") if isinstance(data, dict) else None
    return [c for c in candidates or [] if isinstance(c, dict)]


async def get_memory(root_agent_id: str, *, timeout_s: float = DEFAULT_TIMEOUT_S) -> Optional[dict[str, Any]]:
    base, headers = _base()
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        response = await client.get(f"{base}/api/planner-memory/{root_agent_id}", headers=headers)
    if response.status_code == 404:
        return None
    response.raise_for_status()
    data = response.json()
    return data if isinstance(data, dict) else None


async def upsert_memory(
    root_agent_id: str, row: dict[str, Any], *, timeout_s: float = DEFAULT_TIMEOUT_S
) -> dict[str, Any]:
    base, headers = _base()
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        response = await client.put(f"{base}/api/planner-memory/{root_agent_id}", headers=headers, json=row)
    response.raise_for_status()
    data = response.json()
    return data if isinstance(data, dict) else {}


async def store_critical_path(
    root_agent_id: str,
    critical_path: dict[str, Any],
    *,
    compressor_version: str,
    lease_id: str,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> bool:
    base, headers = _base()
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        response = await client.patch(
            f"{base}/api/planner-memory/{root_agent_id}/critical-path",
            headers=headers,
            json={"critical_path": critical_path, "compressor_version": compressor_version, "lease_id": lease_id},
        )
    if response.status_code in {404, 409}:
        logger.warning(
            "planner_memory.store_critical_path.rejected",
            root_agent_id=root_agent_id,
            status=response.status_code,
        )
        return False
    response.raise_for_status()
    return True


async def claim_compression(
    root_agent_id: str, *, compressor_version: str, timeout_s: float = DEFAULT_TIMEOUT_S
) -> dict[str, Any]:
    base, headers = _base()
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        response = await client.post(
            f"{base}/api/planner-memory/{root_agent_id}/critical-path-claim",
            headers=headers,
            json={"compressor_version": compressor_version},
        )
    if response.status_code == 404:
        return {"claimed": False, "reason": "missing"}
    response.raise_for_status()
    data = response.json()
    return data if isinstance(data, dict) else {"claimed": False, "reason": "invalid"}


async def release_compression(root_agent_id: str, *, lease_id: str, timeout_s: float = DEFAULT_TIMEOUT_S) -> bool:
    base, headers = _base()
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        response = await client.request(
            "DELETE",
            f"{base}/api/planner-memory/{root_agent_id}/critical-path-claim",
            headers=headers,
            json={"lease_id": lease_id},
        )
    response.raise_for_status()
    data = response.json()
    return bool(data.get("released")) if isinstance(data, dict) else False


async def memory_stats(*, timeout_s: float = DEFAULT_TIMEOUT_S) -> dict[str, Any]:
    base, headers = _base()
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        response = await client.get(f"{base}/api/planner-memory/stats", headers=headers)
    response.raise_for_status()
    data = response.json()
    return data if isinstance(data, dict) else {}
