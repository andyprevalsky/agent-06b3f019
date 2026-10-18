"""Explicit-only live Settings connectivity fixture and private receipt checker."""

import asyncio
import json
import os
import subprocess
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from benchmarks.fixture_host_guard import FIXTURE_HOST_GUARD_SECONDS
from benchmarks.logs import load_env_var

TASK_NAME = "browser-cloud-iphone-settings"
ANDY = "c49b4ce3-3489-499d-bfbd-846d04ba6275"
ROOT = Path(__file__).resolve().parents[2]


def guard(base_url, user_id):
    parsed = urlsplit(base_url)
    if (
        parsed.scheme not in ("http", "https")
        or parsed.hostname not in ("localhost", "127.0.0.1")
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or user_id != ANDY
        or os.environ.get("BENCHMARK_ISOLATED_RUN", "").lower() not in ("1", "true")
    ):
        raise ValueError("Phone benchmark requires isolated local backend and trusted Andy identity")


def device_id():
    value = os.environ.get("PHONE_HARNESS_DEVICE_ID", "").strip()
    if not value:
        raise ValueError("PHONE_HARNESS_DEVICE_ID is required for the live phone benchmark")
    return value


async def apply_fixture(base_url, user_id, backend_key, *, client=None):
    guard(base_url, user_id)
    device = device_id()
    if not backend_key:
        raise ValueError("BACKEND_API_KEY required for internal device binding")
    if client is None:
        async with httpx.AsyncClient(timeout=15, trust_env=False) as owned:
            return await apply_fixture(base_url, user_id, backend_key, client=owned)
    headers = {"X-API-Key": backend_key, "X-User-Id": user_id}
    response = await client.put(
        base_url.rstrip("/") + "/api/iphone/device", headers=headers, json={"providerDeviceId": device}
    )
    if response.status_code not in (200, 201):
        raise RuntimeError(f"Phone device binding rejected: HTTP {response.status_code}")
    response = await client.get(base_url.rstrip("/") + "/api/iphone/capability", headers=headers)
    if (
        response.status_code != 200
        or response.json().get("enabled") is not True
        or response.json().get("configured") is not True
    ):
        raise RuntimeError("Dedicated phone capability is not enabled/configured")
    # Never return the mapping or any provider credentials.
    return {"fixture": "dedicated-cloud-iphone", "configured": True}


def check_proof(proof, root_agent_id=None):
    valid = (
        proof.get("source") == "persisted-iphone-commands-v1"
        and proof.get("userId") == ANDY
        and proof.get("rootAgentId") == root_agent_id
        and bool(root_agent_id)
        and bool(proof.get("launchId"))
        and bool(proof.get("readId"))
        and isinstance(proof.get("heading"), str)
        and bool(proof["heading"].strip())
        and proof.get("ordered") is True
        and proof.get("attentionCount") == 0
        and proof.get("allCommandsAllowed") is True
    )
    return bool(valid), None if valid else "Live persisted Settings launch/read proof missing or invalid"


def evaluate_persisted(base_url, user_id, root_agent_id, database_url, reported_heading=""):
    guard(base_url, user_id)
    parsed = urlsplit(database_url or "")
    if (
        parsed.scheme not in ("postgres", "postgresql")
        or parsed.hostname not in ("localhost", "127.0.0.1")
        or not parsed.path.startswith("/victoria")
    ):
        raise ValueError("Phone evaluator requires the isolated local Victoria database")
    env = os.environ.copy()
    env.update(
        DATABASE_URL=database_url,
        DIRECT_URL=database_url,
        PHONE_BENCH_USER_ID=user_id,
        PHONE_BENCH_AGENT_ID=root_agent_id,
        PHONE_HARNESS_DEVICE_ID=device_id(),
        PHONE_BENCH_REPORTED_HEADING=reported_heading,
    )
    # The checker uses only backend envelope decryption. It never calls the
    # provider and must not receive the cloud provider account key.
    env.pop("PHONE_HARNESS_API_KEY", None)
    envelope_key = load_env_var("CLAUDE_CREDENTIAL_DECRYPTION_KEY", str(ROOT / "back-end" / ".env"))
    if envelope_key:
        env["CLAUDE_CREDENTIAL_DECRYPTION_KEY"] = envelope_key
    result = subprocess.run(
        ["node", "--import", "tsx", str(Path(__file__).with_suffix(".probe.ts"))],
        cwd=ROOT / "back-end",
        env=env,
        capture_output=True,
        text=True,
        timeout=FIXTURE_HOST_GUARD_SECONDS,
    )
    if result.returncode:
        return False, "Private phone receipt checker unavailable (local schema/key/ownership)", None
    try:
        proof = json.loads(result.stdout)
    except (ValueError, TypeError):
        return False, "Private phone checker returned invalid proof", None
    passed, reason = check_proof(proof, root_agent_id)
    if proof.get("heading") != reported_heading.strip():
        passed, reason = False, "Final reported heading does not match persisted OCR proof"
    return passed, reason, proof if passed else None


def reported_heading(data):
    """Read the latest real FINISHED workflow completion card, not an attempt."""
    from benchmarks.run_benchmark import _completion_cards_from_messages

    cards = _completion_cards_from_messages(data.get("messages", []) or [])
    if not cards:
        return ""
    outputs = cards[-1].get("outputs")
    if not isinstance(outputs, list):
        return ""
    headings = [
        output.get("value") for output in outputs if isinstance(output, dict) and output.get("key") == "visible_heading"
    ]
    if len(headings) != 1 or not isinstance(headings[0], str):
        return ""
    return headings[0].strip()


class PhoneCleanupBlocked(RuntimeError):
    """Do not delete the root or discard its isolated database/recovery authority."""


def cleanup_snapshot(base_url, user_id, root_agent_id, database_url, timeout=15):
    guard(base_url, user_id)
    parsed = urlsplit(database_url or "")
    if parsed.hostname not in ("localhost", "127.0.0.1") or not parsed.path.startswith("/victoria"):
        raise PhoneCleanupBlocked("Phone cleanup local database scope unavailable")
    env = os.environ.copy()
    env.pop("PHONE_HARNESS_API_KEY", None)
    env.update(
        DATABASE_URL=database_url,
        DIRECT_URL=database_url,
        PHONE_BENCH_USER_ID=user_id,
        PHONE_BENCH_AGENT_ID=root_agent_id,
        PHONE_HARNESS_DEVICE_ID=device_id(),
        PHONE_BENCH_MODE="cleanup",
    )
    result = subprocess.run(
        ["node", "--import", "tsx", str(Path(__file__).with_suffix(".probe.ts"))],
        cwd=ROOT / "back-end",
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode:
        raise PhoneCleanupBlocked("Phone cleanup ownership/probe unavailable; retain isolated database")
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise PhoneCleanupBlocked("Phone cleanup proof malformed") from None


async def cleanup_phone(
    base_url, user_id, root_agent_id, database_url, backend_key, *, client=None, poll_seconds=2, deadline=None
):
    guard(base_url, user_id)
    if not backend_key:
        raise PhoneCleanupBlocked("Phone cleanup internal authentication unavailable")
    deadline = deadline if deadline is not None else time.monotonic() + 90
    if client is None:
        async with httpx.AsyncClient(timeout=10, trust_env=False) as owned:
            return await cleanup_phone(
                base_url,
                user_id,
                root_agent_id,
                database_url,
                backend_key,
                client=owned,
                poll_seconds=poll_seconds,
                deadline=deadline,
            )
    headers = {"X-API-Key": backend_key, "X-User-Id": user_id}
    while time.monotonic() < deadline:
        try:
            snapshot = await asyncio.to_thread(
                cleanup_snapshot,
                base_url,
                user_id,
                root_agent_id,
                database_url,
                min(15, max(0.1, deadline - time.monotonic())),
            )
        except subprocess.TimeoutExpired:
            raise PhoneCleanupBlocked("Phone cleanup ownership probe timed out; retain isolated database") from None
        if snapshot.get("owned") is not True or snapshot.get("foreignLive") is not False:
            raise PhoneCleanupBlocked("Phone cleanup scope missing/foreign; retain isolated database")
        leases = snapshot.get("leases")
        if not isinstance(leases, list) or any(
            not isinstance(row, dict) or not isinstance(row.get("id"), str) for row in leases
        ):
            raise PhoneCleanupBlocked("Phone cleanup lease proof malformed")
        if snapshot.get("idle") is True and all(
            row.get("status") in ("RELEASED", "EXPIRED", "CANCELLED", "TIMED_OUT") for row in leases
        ):
            return {"cleanupComplete": True, "leaseCount": len(leases)}
        if not leases:
            raise PhoneCleanupBlocked("Phone allocation has no owned lease recovery anchor")
        for row in leases:
            from urllib.parse import quote

            path = base_url.rstrip("/") + "/api/iphone/leases/" + quote(row["id"], safe="")
            # A DELETE/stop acknowledgement is not proof. The next private DB
            # snapshot must show IDLE and all three session/start fields cleared.
            try:
                for method, url in (("POST", path + "/release"), ("GET", path)):
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise PhoneCleanupBlocked("Phone cleanup deadline exceeded; retain isolated database")
                    response = await client.request(
                        method, url, headers=headers, json={} if method == "POST" else None, timeout=min(10, remaining)
                    )
                    if response.status_code != 200:
                        raise PhoneCleanupBlocked(f"Phone cleanup API refused: HTTP {response.status_code}")
                    try:
                        bound = response.json().get("lease", {})
                    except ValueError:
                        raise PhoneCleanupBlocked("Phone cleanup API proof malformed") from None
                    if bound.get("id") != row["id"]:
                        raise PhoneCleanupBlocked("Phone cleanup returned a foreign/missing lease")
            except httpx.HTTPError:
                raise PhoneCleanupBlocked("Phone cleanup transport unconfirmed; retain isolated database") from None
        await asyncio.sleep(poll_seconds)
    raise PhoneCleanupBlocked("Phone cleanup deadline exceeded; retain isolated database")
