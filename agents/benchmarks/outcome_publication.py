"""Exact evaluated-outcome acknowledgment, independent of resource cleanup."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def packet(run_id: str, run_token: str, machine_id: str, name: str, status: str, agent_id: str) -> dict:
    return {
        "version": 1,
        "run_id": run_id,
        "run_token": run_token,
        "machine_id": machine_id,
        "name": name,
        "status": status,
        "agent_id": agent_id,
    }


def digest(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def prepare(result, context: Path, token: str) -> tuple[Path, str] | None:
    parent = os.environ.get("BENCHMARK_HUB_PARENT_RUN_ID", "")
    machine = os.environ.get("FLY_MACHINE_ID", "")
    if not parent or not re.fullmatch(r"[0-9a-f]{14}", machine):
        return None
    value = packet(parent, token, machine, result.name, "passed" if result.passed else "failed", result.agent_id)
    signature = digest(value)
    pending = context / f"cloudbench-outcome-{token}.pending.json"
    temporary = pending.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    temporary.replace(pending)
    return context / f"cloudbench-outcome-{token}.ack", signature


async def wait_for_publication(pending: tuple[Path, str] | None) -> None:
    if pending is None:
        return
    path, expected = pending
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            if not path.is_symlink() and path.read_text().strip() == expected:
                print("✅ benchmark Hub evaluated outcome acknowledged before teardown")
                return
        except OSError:
            pass
        await asyncio.sleep(0.25)
    # Publication is best effort. Its observation never licenses leaving an
    # owned agent, browser or provider resource behind, or changes grading.
    print("⚠ benchmark Hub outcome acknowledgment unavailable; continuing exact resource cleanup")


def acknowledge_published(card: dict, *, run_id: str, fleet_dir: Path) -> None:
    """Called only after this exact card was successfully posted to the Hub."""
    bearer = os.environ.get("CLOUDBENCH_BARRIER_TOKEN", "")
    if not bearer:
        return

    def acknowledge(row):
        if row.get("status") not in ("passed", "failed"):
            return
        name = row["name"]
        if name in (".", "..") or not re.fullmatch(r"[A-Za-z0-9._-]+", name):
            return
        out = fleet_dir / name
        try:
            owner = json.loads((out / "runtime-evidence.owner.json").read_text())
            port = int((out / "status-proxy.port").read_text())
            ids = parse_qs(urlparse(row.get("agent_url") or "").query).get("agent-id") or []
            if not ids or not 1 <= port <= 65535:
                return
            value = packet(run_id, owner["run_token"], owner["machine_id"], name, row["status"], ids[0])
            signature = digest(value)
            if row.get("outcome_sha256") != signature:
                return
            receipt = out / "hub-outcome-published.ack"
            if receipt.exists() and receipt.read_text().strip() == signature:
                return
            request = urllib.request.Request(
                f"http://127.0.0.1:{port}/outcome-published",
                data=json.dumps(value).encode(),
                method="POST",
                headers={
                    "Authorization": "Bearer " + bearer,
                    "X-Cloudbench-Run-Token": owner["run_token"],
                    "X-Cloudbench-Machine-Id": owner["machine_id"],
                    "Content-Type": "application/json",
                },
            )
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(request, timeout=5) as response:
                if response.status == 204:
                    metadata = out / "hub-outcome-published.meta.json"
                    staged = metadata.with_suffix(".tmp")
                    staged.write_text(json.dumps({"sha256": signature, "acknowledged_at_epoch": time.time()}))
                    staged.replace(metadata)
                    temporary = receipt.with_suffix(".tmp")
                    temporary.write_text(signature + "\n")
                    temporary.replace(receipt)
        except (OSError, ValueError, KeyError):
            # Retry on the existing aggregator cadence. Never turn an ACK
            # observation into a failure of the benchmark or resource release.
            return

    # One slow guest cannot serially delay publication of the other outcomes.
    # This is metadata delivery over existing owned proxies, never model work.
    with ThreadPoolExecutor(max_workers=10) as executor:
        list(executor.map(acknowledge, card.get("per_task") or []))
