"""Find All domain repo — Parallel AI HTTP activities (data access layer)."""

from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING, Any

import httpx
import structlog
from temporalio import activity

from config import load_config
from domains.find_all.config import BASE_URL, BETA_HEADER_VALUE

if TYPE_CHECKING:
    from domains.find_all.types import (
        CreateRunResult,
        GetResultsResult,
        IngestResult,
        PollStatusResult,
    )

logger = structlog.get_logger()


def _headers(api_key: str) -> dict[str, str]:
    return {
        "x-api-key": api_key,
        "parallel-beta": BETA_HEADER_VALUE,
        "Content-Type": "application/json",
    }


def _heartbeat(msg: str) -> None:
    """Best-effort Temporal heartbeat (no-op outside activity context)."""
    with contextlib.suppress(RuntimeError):
        activity.heartbeat(msg)


@activity.defn
async def find_all_ingest_activity(objective: str) -> dict[str, Any]:
    """Ingest an objective and return entity_type + match_conditions."""
    try:
        _heartbeat(f"Ingesting objective: {objective[:50]}...")

        config = load_config()
        headers = _headers(config.parallel.api_key)

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{BASE_URL}/v1beta/findall/ingest",
                headers=headers,
                json={"objective": objective},
            )
            resp.raise_for_status()
            data = resp.json()

            entity_type = data.get("entity_type", "entities")
            match_conditions = data.get("match_conditions", [])

            logger.info(
                "Find All ingest completed",
                entity_type=entity_type,
                match_conditions_count=len(match_conditions),
            )

            result: IngestResult = {
                "entity_type": entity_type,
                "match_conditions": match_conditions,
            }
            return result

    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Find All ingest error", error=error_msg, objective=objective)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Find All ingest failed", error=str(e), objective=objective)
        raise


@activity.defn
async def find_all_create_run_activity(
    objective: str,
    entity_type: str,
    match_conditions: list[dict[str, Any]],
    generator: str,
    match_limit: int,
) -> dict[str, Any]:
    """Create a FindAll run and return its ID."""
    try:
        _heartbeat("Creating Find All run...")

        config = load_config()
        headers = _headers(config.parallel.api_key)

        payload = {
            "objective": objective,
            "entity_type": entity_type,
            "match_conditions": match_conditions,
            "generator": generator,
            "match_limit": match_limit,
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{BASE_URL}/v1beta/findall/runs",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()

            findall_id = data.get("findall_id")
            if not findall_id:
                raise ValueError("No findall_id returned from create run")

            logger.info("Find All run created", findall_id=findall_id)

            result: CreateRunResult = {"findall_id": findall_id}
            return result

    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Find All create run error", error=error_msg)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Find All create run failed", error=str(e))
        raise


@activity.defn
async def find_all_poll_status_once_activity(findall_id: str) -> dict[str, Any]:
    """Poll a FindAll run's status once and return metrics."""
    try:
        _heartbeat(f"Polling status for {findall_id}...")

        config = load_config()
        headers = _headers(config.parallel.api_key)

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{BASE_URL}/v1beta/findall/runs/{findall_id}",
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()

            status_obj = data.get("status", {})
            status_value = status_obj.get("status", "unknown")
            is_active = status_obj.get("is_active", True)

            metrics = status_obj.get("metrics", {})
            generated_count = metrics.get("generated_candidates_count", 0)
            matched_count = metrics.get("matched_candidates_count", 0)

            is_completed = status_value == "completed" and not is_active
            is_failed = status_value == "failed"

            logger.info(
                "Find All status polled",
                findall_id=findall_id,
                status=status_value,
                generated=generated_count,
                matched=matched_count,
            )

            result: PollStatusResult = {
                "status": status_obj,
                "is_completed": is_completed,
                "is_failed": is_failed,
                "generated_candidates_count": generated_count,
                "matched_candidates_count": matched_count,
            }
            return result

    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Find All poll status error", error=error_msg, findall_id=findall_id)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Find All poll status failed", error=str(e), findall_id=findall_id)
        raise


@activity.defn
async def find_all_get_results_activity(findall_id: str) -> dict[str, Any]:
    """Retrieve results from a completed FindAll run."""
    try:
        _heartbeat(f"Retrieving results for {findall_id}...")

        config = load_config()
        headers = _headers(config.parallel.api_key)

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.get(
                f"{BASE_URL}/v1beta/findall/runs/{findall_id}/result",
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()

            candidates = data.get("candidates", [])
            usage = data.get("usage")

            logger.info(
                "Find All results retrieved",
                findall_id=findall_id,
                candidates_count=len(candidates),
            )

            result: GetResultsResult = {
                "candidates": candidates,
                "usage": usage,
                "status": {},
            }
            return result

    except httpx.HTTPStatusError as e:
        error_msg = f"HTTP error {e.response.status_code}: {e.response.text}"
        logger.error("Find All get results error", error=error_msg, findall_id=findall_id)
        raise ValueError(error_msg) from e
    except Exception as e:
        logger.error("Find All get results failed", error=str(e), findall_id=findall_id)
        raise
