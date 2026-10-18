"""Explicit PH-6D private protocol capture. Never a semantic sign-in verdict."""

import asyncio
import json
import os
import secrets
import subprocess
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from benchmarks import phone_connectivity as phone
from benchmarks.logs import load_env_var

TASK_NAME = "browser-cloud-iphone-critical-attention"
PHONE_BENCH_TASK_NAMES = frozenset((phone.TASK_NAME, TASK_NAME))


def _env(base_url, user_id, root, database_url):
    phone.guard(base_url, user_id)
    url = urlsplit(database_url or "")
    if (
        url.scheme not in ("postgres", "postgresql")
        or url.hostname not in ("localhost", "127.0.0.1")
        or not url.path.startswith("/victoria")
    ):
        raise ValueError("PH-6D requires isolated local Victoria database")
    env = os.environ.copy()
    env.update(
        DATABASE_URL=database_url,
        DIRECT_URL=database_url,
        PHONE_BENCH_USER_ID=user_id,
        PHONE_BENCH_AGENT_ID=root,
        PHONE_HARNESS_DEVICE_ID=phone.device_id(),
    )
    env.pop("PHONE_HARNESS_API_KEY", None)
    key = load_env_var("CLAUDE_CREDENTIAL_DECRYPTION_KEY", str(phone.ROOT / "back-end" / ".env"))
    if key:
        env["CLAUDE_CREDENTIAL_DECRYPTION_KEY"] = key
    return env


def _run(file, env, payload=None):
    result = subprocess.run(
        ["node", "--import", "tsx", str(Path(__file__).with_name(file))],
        cwd=phone.ROOT / "back-end",
        env=env,
        input=json.dumps(payload) if payload else None,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode:
        raise RuntimeError("Private PH-6D fixture/proof unavailable")
    return json.loads(result.stdout)


def probe(base_url, user_id, root, database_url, *, mode="pending", custody=None):
    env = _env(base_url, user_id, root, database_url)
    env["PHONE_BENCH_MODE"] = mode
    if custody is not None:
        env["PHONE_BENCH_CUSTODY"] = json.dumps(custody)
    return _run("phone_critical_attention.probe.ts", env)


def key_fixture(base_url, user_id, root, database_url, *, action, key, key_id):
    return _run(
        "phone_user_key.fixture.ts",
        _env(base_url, user_id, root, database_url),
        {"action": action, "userId": user_id, "root": root, "key": key, "id": key_id},
    )


def private_directory():
    path = phone.ROOT / ".context" / "phone-harness" / "private"
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


async def configure_profile(base_url, user_id, backend_key, database_url, *, client=None):
    phone.guard(base_url, user_id)
    source = os.environ.get("PHONE_BENCH_APPLE_IDENTITY_FILE")
    if not source:
        raise ValueError("PHONE_BENCH_APPLE_IDENTITY_FILE is required")
    # Runtime-only trusted fixture read, never returned or interpolated into errors.
    try:
        identity = json.loads(Path(source).read_text())["apple_account_email"]
        if not isinstance(identity, str) or not identity or len(identity) > 512:
            raise ValueError()
    except (OSError, ValueError, KeyError, TypeError):
        raise ValueError("Private Apple identifier configuration invalid") from None
    if client is None:
        async with httpx.AsyncClient(timeout=15, trust_env=False) as owned:
            return await configure_profile(base_url, user_id, backend_key, database_url, client=owned)
    # Profile CAS has no public GET. Read revision and compare privately; do not reset a matching ready profile.
    env = _env(base_url, user_id, "profile", database_url)
    env["PHONE_BENCH_MODE"] = "profile"
    state = await asyncio.to_thread(_run, "phone_critical_attention.probe.ts", env, {"identity": identity})
    if state.get("matches"):
        return {"configured": True}
    response = await client.put(
        base_url.rstrip("/") + "/api/iphone/device/setup-profile",
        headers={"X-API-Key": backend_key, "X-User-Id": user_id},
        json={"expectedProfileRevision": state["profileRevision"], "expectedAppleIdentity": identity},
    )
    if response.status_code != 200:
        raise RuntimeError(f"Private phone setup configuration rejected: HTTP {response.status_code}")
    return {"configured": True}


async def evaluate_critical_attention(base_url, user_id, root, database_url, *, client=None):
    phone.guard(base_url, user_id)
    if client is None:
        async with httpx.AsyncClient(timeout=30, trust_env=False) as owned:
            return await evaluate_critical_attention(base_url, user_id, root, database_url, client=owned)
    before = await asyncio.to_thread(probe, base_url, user_id, root, database_url)
    if not before.get("valid"):
        return (
            False,
            "Critical native attention not exercised"
            if before.get("notExercised")
            else "Critical native attention protocol proof invalid",
            {"protocolOnly": True, "notExercised": before.get("notExercised") is True},
        )
    key, key_id = "rose-ph6d-" + secrets.token_urlsafe(32), str(uuid.uuid4())
    args = (base_url, user_id, root, database_url)
    await asyncio.to_thread(key_fixture, *args, action="create", key=key, key_id=key_id)
    try:
        headers = {"X-API-Key": key}
        response = await client.get(
            base_url.rstrip("/") + f"/api/iphone/leases/{before['leaseId']}/frame", headers=headers
        )
        if (
            response.status_code != 200
            or response.headers.get("content-type", "").split(";")[0] != "image/png"
            or not response.content.startswith(b"\x89PNG\r\n\x1a\n")
            or len(response.content) > 8_000_000
        ):
            return False, "Private owner PNG capture failed", {"protocolOnly": True}
        after = await asyncio.to_thread(probe, *args)
        if (
            not after.get("valid")
            or after.get("requestId") != before["requestId"]
            or after.get("custody") != before.get("custody")
        ):
            return False, "Native custody changed during PNG capture", {"protocolOnly": True}
        path = private_directory() / f"ph6d-{root}-{before['requestId']}.png"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(response.content)
        response = await client.post(
            base_url.rstrip("/") + f"/api/attention-requests/{before['requestId']}/reject", headers=headers, json={}
        )
        if response.status_code != 200:
            return False, "Exact native rejection failed", {"protocolOnly": True}
        final = await asyncio.to_thread(probe, *args, mode="rejected", custody=before.get("custody"))
        ok = (
            final.get("valid") is True
            and final.get("rejected") is True
            and final.get("requestId") == before["requestId"]
        )
        public = {k: v for k, v in final.items() if k != "custody"}
        public["_custody"] = before.get("custody")
        return ok, None if ok else "Persisted native rejection proof missing", public
    finally:
        await asyncio.to_thread(key_fixture, *args, action="delete", key=key, key_id=key_id)


def cleanup_owner_transport(base_url, user_id, root, database_url):
    return _run(
        "phone_user_key.fixture.ts",
        _env(base_url, user_id, root, database_url),
        {"action": "cleanup", "userId": user_id, "root": root},
    )
