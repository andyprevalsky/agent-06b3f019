"""The native private prediction writer, including pending provider-attempt evidence."""

from __future__ import annotations

import fcntl
import hashlib
import json
import multiprocessing
import os
import time
import uuid
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path


def prediction_path(root, session_id, prediction_id):
    from benchmarks.wmh_provider_capture import owner_path

    owner_path(root, session_id, prediction_id)  # Existing exact safe-ID contract.
    return Path(root) / "native-predictions" / session_id / (prediction_id + ".json")


def redaction_workers() -> int:
    """Explicit bound for the served model's redaction processes (WMH_NATIVE_REDACTION_WORKERS)."""
    configured = os.environ.get("WMH_NATIVE_REDACTION_WORKERS", "").strip()
    if configured:
        value = int(configured)
        if not 1 <= value <= 64:
            raise ValueError("WMH_NATIVE_REDACTION_WORKERS must be between 1 and 64")
        return value
    return max(1, min(4, os.cpu_count() or 1))


def redaction_pool():
    """A fixed-size spawned pool for redacting full prediction records.

    Each record carries the whole request, so redaction is CPU-bound and grows
    with the world's history. In the serving process every concurrent step's
    redaction serialized on its GIL beside the event loop (SIM run 7: 90
    concurrent steps). Only an entrypoint with a main guard may own one.
    """
    from concurrent.futures import ProcessPoolExecutor

    return ProcessPoolExecutor(max_workers=redaction_workers(), mp_context=multiprocessing.get_context("spawn"))


@contextmanager
def record_lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(".capture-lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


class NativePredictionWriter:
    """One redacted writer/sink for existing final records and rejected provider attempts."""

    def __init__(self, root, world_model_id, prompt_sha256, *, redactor=None):
        self.root = Path(root)
        self.world_model_id = world_model_id
        self.prompt_sha256 = prompt_sha256
        # Optional process pool (redaction_pool); same upstream rules, off the GIL.
        # A broken pool fails the write; it never skips redaction.
        self.redactor = redactor

    def _write(self, path, record):
        from benchmarks.wmh_archive_io import atomic_json, redact_archive

        if self.redactor is None:
            safe, redactions = redact_archive(record)
        else:
            safe, redactions = self.redactor.submit(redact_archive, record).result()
        safe.update(world_model_id=self.world_model_id, prompt_sha256=self.prompt_sha256, redaction_count=redactions)
        atomic_json(path, safe)
        return {
            "path": str(path.relative_to(self.root)),
            "sha256_at_write": hashlib.sha256(path.read_bytes()).hexdigest(),
        }

    def begin(self, record):
        from exp.common.core.artifacts import sha256_json

        if (
            record.get("schema") != "rose.wmh_native_prediction.v1"
            or sha256_json(record["request"]) != record["request_sha256"]
            or any(key in record for key in ("response", "error", "finished_at_ms"))
        ):
            raise ValueError("Native capture requires a truthful pending prediction template")
        path = prediction_path(self.root, record["session_id"], record["prediction_id"])
        with record_lock(path):
            if path.exists():
                raise ValueError("Native prediction capture already exists")
            return self._write(path, {**record, "capture_pending": True, "provider_attempts": []})

    def append_rejected(self, session_id, prediction_id, rejected):
        path = prediction_path(self.root, session_id, prediction_id)
        with record_lock(path):
            record = json.loads(path.read_text())
            if record.get("schema") != "rose.wmh_native_prediction.v1":
                raise ValueError("Native prediction capture schema differs")
            digest = hashlib.sha256(json.dumps(rejected, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            attempts = record.setdefault("provider_attempts", [])
            ordinal = rejected.get("attempt_ordinal")
            if type(ordinal) is not int or ordinal < 1:
                raise ValueError("Rejected provider attempt requires its exact ordinal")
            existing = [
                row for row in attempts
                if row["attempt_ordinal"] == ordinal
                and row.get("kind") == rejected.get("kind")
            ]
            if existing:
                if existing[0]["capture_sha256"] != digest:
                    raise ValueError("Native provider attempt ordinal reused for different evidence")
            else:
                attempts.append(
                    {
                        **deepcopy(rejected),
                        "status": "rejected",
                        "recorded_at_ms": time.time_ns() // 1_000_000,
                        "capture_sha256": digest,
                    }
                )
            return self._write(path, record)

    def __call__(self, record):
        path = None
        if record.get("schema") == "rose.wmh_native_prediction.v1":
            candidate = prediction_path(self.root, record["session_id"], record["prediction_id"])
            # Only admitted capture records are updated. Ordinary/historical calls
            # retain the existing UUID publication and exact original record shape.
            if candidate.exists():
                path = candidate
        if path is None:
            path = self.root / "native-predictions" / record["session_id"] / (uuid.uuid4().hex + ".json")
            return self._write(path, record)
        with record_lock(path):
            existing = json.loads(path.read_text())
            for key in ("session_id", "prediction_id", "request_sha256", "execution_identity"):
                if existing.get(key) != record.get(key):
                    raise ValueError("Native final prediction differs from capture owner")
            final = {**record, "capture_pending": False, "provider_attempts": existing.get("provider_attempts", [])}
            return self._write(path, final)
