"""Passive retry evidence, enabled only by WHM's current raw-completion owner.

Provider HTTP failure -> safe response metadata -> current WHM budget.
No callback means no response inspection or routing/timing behavior change.
"""

import hashlib
import json
import math
import time
import uuid
from contextvars import ContextVar
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

FAILURE_OBSERVER = ContextVar("rose_whm_retry_observer", default=None)


def _delay(headers):
    values = []
    for key, divisor in (("retry-after-ms", 1000), ("retry-after", 1)):
        value = headers.get(key)
        if value is None:
            continue
        try:
            delay = float(value) / divisor
        except ValueError:
            if key != "retry-after":
                continue
            try:
                delay = (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()
            except (TypeError, ValueError, OverflowError):
                continue
        if delay > 0 and not math.isnan(delay):
            values.append(delay)
    return max(values, default=0.0)


def observe_cooldown(model, remaining_seconds):
    callback = FAILURE_OBSERVER.get()
    if callback is not None:
        callback(
            {
                "model": model,
                "status": 429,
                "retry_after_s": max(0.0, remaining_seconds),
                "permanent": False,
                "source": "existing_provider_cooldown",
            }
        )


async def observe_http_failure(model, response, *, cooldown_seconds=None, body_read_required=False):
    callback = FAILURE_OBSERVER.get()
    if callback is None:
        return
    # Only stable protocol codes are classified; no prose matching or response
    # bodies/headers/credentials enter the observer or an ordinary log.
    delay = _delay(response.headers)
    if cooldown_seconds is not None and not math.isnan(cooldown_seconds):
        delay = max(delay, cooldown_seconds)
    safe = {
        "model": model,
        "status": response.status_code,
        "retry_after_s": delay,
        "permanent": response.status_code in (400, 401, 402, 403),
        "source": "provider_http_response",
        "response_observation_id": uuid.uuid4().hex,
        "response_headers": {
            key: response.headers[key]
            for key in (
                "x-request-id", "request-id", "apim-request-id",
                "x-ms-request-id", "cf-ray", "retry-after", "retry-after-ms",
            )
            if key in response.headers
        },
        "observed_at_ms": time.time_ns() // 1_000_000,
    }
    # Preserve headers even if the error-body read later fails or times out.
    callback(safe)
    quota = False
    try:
        body = await response.aread()
        # The observer exists only inside a WHM raw attempt. Keep this private
        # row for the existing native writer; never emit it to ordinary logs.
        safe.update(
            response_body=body.decode("utf-8", errors="surrogateescape"),
            response_body_encoding="utf-8-surrogateescape",
            response_body_bytes=len(body),
            response_body_sha256=hashlib.sha256(body).hexdigest(),
        )
        data = json.loads(body)
        error = data.get("error") if isinstance(data, dict) else None
        if isinstance(error, dict):
            quota = error.get("code") in {"insufficient_quota", "billing_hard_limit_reached"}
    except (ValueError, UnicodeError):
        pass
    except Exception:
        # Observation must not replace a route's existing HTTP-status failure.
        # A route that already consumes the error body retains its read failure.
        if body_read_required:
            raise
    if quota and not safe["permanent"]:
        callback({**safe, "permanent": True})
