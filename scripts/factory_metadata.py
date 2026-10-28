"""Allowlisted, evidence-backed factory telemetry; never scrape ambient secrets."""

from __future__ import annotations

import json
import math
import os
from datetime import datetime
from pathlib import Path

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
        raise ValueError("invalid metadata evidence: expected field-to-source mapping")  # noqa: TRY004
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


def load_metadata(path: str | Path | None = None) -> dict:
    """Only an explicitly selected JSON file is read; absent configuration is unknown."""
    selected = path or os.environ.get("FACTORY_METADATA_FILE")
    if not selected:
        return normalize_metadata({})
    data = Path(selected).read_bytes()
    if len(data) > 65536:
        raise ValueError("factory metadata exceeds 64 KiB")
    return normalize_metadata(json.loads(data))
