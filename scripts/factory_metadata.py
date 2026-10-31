"""Allowlisted, evidence-backed factory telemetry; never scrape ambient secrets."""

from __future__ import annotations

import json
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path

SNAPSHOT_MAX_BYTES = 65536
SOURCE_SHA = re.compile(r"[0-9a-f]{40}")
SELECTED_SNAPSHOT_ENV = "FACTORY_METADATA_FILE"

# Null means unrecorded, never zero. Units are explicit in field names.
FIELDS = {
    "execution": dict.fromkeys(
        (
            "provider",
            "model",
            "reasoning_effort",
            "service_tier",
            "harness",
            "harness_version",
        ),
        str,
    ),
    "usage": {
        **dict.fromkeys(("input_tokens", "output_tokens", "cached_input_tokens"), int),
        "cost_usd": float,
    },
    "attribution": dict.fromkeys(
        (
            "run_id",
            "assignment_id",
            "thread_id",
            "agent_id",
            "parent_agent_id",
            "configuration_id",
        ),
        str,
    ),
    "timing": {
        **dict.fromkeys(
            (
                "active_seconds",
                "approval_wait_seconds",
                "queue_wait_seconds",
                "rate_limit_wait_seconds",
                "infrastructure_wait_seconds",
                "other_seconds",
                "time_to_first_token_seconds",
                "output_tokens_per_second",
            ),
            float,
        )
    },
    "environment": {
        **dict.fromkeys(
            ("os", "architecture", "runtime_version", "resource_class"), str
        ),
        "concurrency": int,
    },
    "validation": dict.fromkeys(
        ("source_sha", "command_redacted", "result", "evidence_ref"), str
    ),
}


def normalize_metadata(raw: dict) -> dict:
    if not isinstance(raw, dict) or set(raw) - {
        *FIELDS,
        "schema_version",
        "observed_at",
        "record_type",
        "evidence",
    }:
        raise ValueError("invalid factory metadata fields")
    if raw.get("schema_version", 1) != 1:
        raise ValueError("unsupported factory metadata version")
    observed = raw.get("observed_at")
    if observed is not None:
        if not isinstance(observed, str):
            raise ValueError(
                "metadata observed_at must be a timezone-aware ISO timestamp"
            )
        try:
            parsed = datetime.fromisoformat(observed)
            if parsed.tzinfo is None:
                raise ValueError()
        except ValueError as error:
            raise ValueError(
                "metadata observed_at must be a timezone-aware ISO timestamp"
            ) from error
    kind = raw.get("record_type", "snapshot")
    if kind not in {"snapshot", "retrospective"}:
        raise ValueError("invalid metadata record_type")
    evidence = raw.get("evidence", {})
    if not isinstance(evidence, dict):
        raise ValueError("invalid metadata evidence: expected field-to-source mapping")
    known = {
        f"{section}.{name}" for section, fields in FIELDS.items() for name in fields
    }
    if set(evidence) - known or any(
        not isinstance(v, str) or not v.strip() for v in evidence.values()
    ):
        raise ValueError("invalid metadata evidence reference")
    out = {
        "schema_version": 1,
        "observed_at": observed,
        "record_type": kind,
        "evidence": evidence,
    }
    for section, fields in FIELDS.items():
        values = raw.get(section, {})
        if not isinstance(values, dict) or set(values) - set(fields):
            raise ValueError(f"invalid factory metadata section: {section}")
        out[section] = {}
        for name, expected in fields.items():
            value = values.get(name)
            path = f"{section}.{name}"
            if value is not None:
                numeric = expected in (int, float)
                valid = (
                    type(value) is int
                    if expected is int
                    else isinstance(value, (int, float)) and not isinstance(value, bool)
                    if expected is float
                    else isinstance(value, str) and bool(value.strip())
                )
                if not valid or (numeric and (not math.isfinite(value) or value < 0)):
                    raise ValueError(f"invalid factory metadata value: {path}")
                if path not in evidence or observed is None:
                    raise ValueError(
                        f"factory metadata requires timestamp and evidence: {path}"
                    )
            out[section][name] = value
    cached, total = out["usage"]["cached_input_tokens"], out["usage"]["input_tokens"]
    if cached is not None and total is not None and cached > total:
        raise ValueError("cached input must be a subset of total input tokens")
    return out


def _read_snapshot(path: Path) -> dict:
    data = path.read_bytes()
    if len(data) > SNAPSHOT_MAX_BYTES:
        raise ValueError("factory metadata exceeds 64 KiB")
    raw = json.loads(data)
    normalize_metadata(raw)  # fail closed before anything reads or rewrites it
    return raw


def load_metadata(path: str | Path | None = None) -> dict:
    """Only an explicitly selected JSON file is read; absent configuration is unknown."""
    selected = path or os.environ.get(SELECTED_SNAPSHOT_ENV)
    if not selected:
        return normalize_metadata({})
    return normalize_metadata(_read_snapshot(Path(selected)))


def refresh_snapshot(path: str | Path, *, head: str, producer: str, now: datetime | None = None) -> dict:
    """Re-stamp a snapshot for a newly launched head and return it normalized.

    ``observed_at`` becomes the refresh time and ``validation.source_sha`` the
    caller's ``git rev-parse HEAD``, with evidence naming that command, the
    producer and the time. Every other field and evidence entry is carried
    forward unchanged: the launching session's configuration did not change
    and nothing else was re-measured here, so nothing else is written. The
    file must already be a valid allowlisted snapshot; an invalid file or a
    retrospective record (which keeps its original observation) is rejected
    unchanged, never repaired or created.
    """
    path = Path(path)
    if not SOURCE_SHA.fullmatch(head):
        raise ValueError("factory metadata source_sha must be a full 40-hex commit id")
    raw = _read_snapshot(path)
    if raw.get("record_type", "snapshot") != "snapshot":
        raise ValueError("only snapshot records are refreshed; a retrospective keeps its observation")
    observed = datetime.now(timezone.utc) if now is None else now
    if observed.tzinfo is None:
        raise ValueError("factory metadata refresh time must be timezone-aware")
    stamp = observed.isoformat()
    updated = dict(raw)
    updated["observed_at"] = stamp
    updated["validation"] = {**(raw.get("validation") or {}), "source_sha": head}
    updated["evidence"] = {
        **(raw.get("evidence") or {}),
        "validation.source_sha": f"git rev-parse HEAD ({head}) read by {producer} at {stamp}",
    }
    normalized = normalize_metadata(updated)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(updated, indent=2) + "\n")
    temporary.replace(path)
    return normalized


def refresh_selected_snapshot(head: str, *, producer: str, checkout: str | Path) -> dict:
    """Refresh ``FACTORY_METADATA_FILE`` when it is ``checkout``'s own
    ``.context/`` snapshot.

    A snapshot describes the checkout whose ``.context/`` holds it. One
    anywhere else (a nested worktree's ``.context/`` under the canonical
    checkout, a sibling deploy's file inherited through the environment, a
    test fixture) is left alone and reported, so no other checkout or test can
    re-stamp a live deploy's telemetry. A retrospective record keeps its
    original observation and is reported, not rewritten. Returns
    ``{"status", "path", "message"}`` with status ``unset`` | ``missing`` |
    ``outside`` | ``retrospective`` | ``refreshed`` (plus ``telemetry`` when
    refreshed); an invalid snapshot raises ``ValueError``.
    """
    selected = os.environ.get(SELECTED_SNAPSHOT_ENV)
    if not selected:
        return {"status": "unset", "path": None,
                "message": f"factory metadata: {SELECTED_SNAPSHOT_ENV} unset, nothing to refresh"}
    path = Path(selected)
    try:
        resolved = path.resolve(strict=True)
    except OSError:
        return {"status": "missing", "path": str(path),
                "message": f"factory metadata: not refreshed, {path} is missing"}
    if resolved.parent != (Path(checkout) / ".context").resolve():
        return {"status": "outside", "path": str(path),
                "message": f"factory metadata: not refreshed, {path} is not this checkout's "
                           f"{Path(checkout) / '.context'} snapshot"}
    if _read_snapshot(resolved).get("record_type", "snapshot") != "snapshot":
        return {"status": "retrospective", "path": str(path),
                "message": f"factory metadata: not refreshed, {path} is a retrospective record and keeps "
                           "its original observation"}
    telemetry = refresh_snapshot(resolved, head=head, producer=producer)
    return {"status": "refreshed", "path": str(path), "telemetry": telemetry,
            "message": (f"factory metadata: refreshed {path} observed_at={telemetry['observed_at']} "
                        f"source_sha={head}")}
