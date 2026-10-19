#!/usr/bin/env python3
"""Lease and observe positive held ACKs; never rewrite native config."""

import copy
import json
import os
import signal
import stat
import subprocess
import time
from pathlib import Path

_contract = globals().pop("CONTRACT")
H, R, need, sha, canonical, config_sha, positive = (
    _contract[key]
    for key in ("H", "R", "need", "sha", "canonical", "config_sha", "positive")
)


class AdmissionObservationCancelled(BaseException):
    """A consumed owner cancellation cannot permit subsequent launch."""


def membership(base, excluded):
    result = {}
    for path in sorted(base.rglob("*")):
        if path == excluded or excluded in path.parents:
            continue
        info = path.lstat()
        need(
            info.st_uid == os.geteuid() and not info.st_mode & 0o077,
            "private reservation evidence required",
        )
        if stat.S_ISDIR(info.st_mode):
            need(path.resolve(strict=True) == path, "reservation evidence alias")
            result[str(path.relative_to(base))] = {"kind": "directory"}
        else:
            raw = R["read"](path)
            result[str(path.relative_to(base))] = {
                "kind": "file",
                "bytes": len(raw),
                "sha256": sha(raw),
            }
    return result


def observe_acknowledged_holds(api_factory, request, closed, journal, deadline):
    """Add only positively ACKed reservations after leased observation, never config POST."""
    H["validate_request"](request)
    H["validate_request"](closed)
    need(
        all(closed.get(k) == v for k, v in request.items() if k != "candidates"),
        "closed observation inputs differ",
    )
    original = {r["machine_id"]: r for r in request["candidates"]}
    credited = set()
    for row in closed["candidates"]:
        mid = row["machine_id"]
        need(
            mid in original
            and mid not in credited
            and all(
                row.get(k) == v
                for k, v in original[mid].items()
                if k
                not in ("source_instance_id", "source_config_sha256", "prior_marker")
            ),
            "closed observation lineage differs",
        )
        credited.add(mid)
    held = closed.get("held_native_reservations", [])
    ids = [row["machine_id"] for row in held]
    need(
        len(set(ids)) == len(ids)
        and set(ids) == set(original) - credited
        and all(r.get("not_credited") is True for r in held),
        "held observation partition differs",
    )
    journal = Path(journal).absolute()
    base = journal.parent
    need(
        base.resolve(strict=True) == base, "physical original reservation root required"
    )
    admission = json.loads(R["read"](base.parent / "admission-intent.private.json"))
    saved = json.loads(R["read"](base.parent / "archived-reuse-original.private.json"))
    need(
        saved["request"] == request
        and saved["sha256"]
        == sha(json.dumps(request, sort_keys=True, allow_nan=False).encode())
        and json.loads(R["read"](base / "reserved-request.json")) == closed,
        "observation original/closed bytes differ",
    )
    need(
        deadline == admission["deadline_epoch"] == admission["started_at_epoch"] + 5400
        and time.time() < deadline,
        "original observation deadline expired/changed",
    )
    identity = sha(
        canonical({"request": request, "closed": closed, "deadline": deadline})
    )
    old_membership = membership(base, journal)
    if journal.exists():
        receipt = json.loads(R["read"](journal / "complete.json"))
        need(
            receipt["identity_sha256"] == identity
            and receipt["old_membership"] == old_membership,
            "observation journal identity differs",
        )
        result_raw = R["read"](journal / "request.json")
        need(
            sha(result_raw) == receipt["request_sha256"],
            "completed observation request changed",
        )
        for path, digest in receipt["inputs"].items():
            need(sha(R["read"](path)) == digest, "completed observation proof changed")
        need(
            not receipt.get("cancelled_signals") and time.time() < deadline,
            "cancelled or expired observation cannot authorize launch",
        )
        return json.loads(result_raw)
    journal.mkdir(mode=0o700)
    R["save"](
        journal / "intent.json",
        {
            "identity_sha256": identity,
            "original_deadline": deadline,
            "config_writes": 0,
        },
    )
    cancelled = []
    bound_paths = (
        base.parent / "admission-intent.private.json",
        base.parent / "archived-reuse-original.private.json",
        base / "reserved-request.json",
    )
    result, inputs, observed, diagnostics = (
        copy.deepcopy(closed),
        {str(path): sha(R["read"](path)) for path in bound_paths},
        set(),
        [],
    )
    handlers = {
        sig: signal.signal(sig, lambda sig, _: cancelled.append(sig))
        for sig in (signal.SIGTERM, signal.SIGINT)
    }
    try:
        for mid in ids:
            if cancelled or deadline - time.time() < 100:
                diagnostics.append(
                    {"machine_id": mid, "reason": "cancelled_or_original_deadline"}
                )
                continue
            try:
                proof = positive(base / mid, original[mid], request, inputs)
                out = journal / mid
                out.mkdir(mode=0o700)
                api = api_factory(out)
                need(
                    not cancelled and deadline - time.time() >= 100,
                    "insufficient original lease observation budget",
                )
                # Pinned NativeAdapter bounds lease/GET/release children individually;
                # never interrupt their mandatory join with an outer alarm.
                with api.lease(mid):
                    need(
                        not cancelled and time.time() < deadline,
                        "cancelled before native observation",
                    )
                    current = api.request("GET", "/machines/" + mid, timeout=20)
                    need(
                        current.get("state") in ("created", "stopped")
                        and all(
                            current.get(k) == proof["ack"].get(k)
                            for k in (
                                "id",
                                "instance_id",
                                "config",
                                "name",
                                "region",
                                "created_at",
                            )
                        ),
                        "observed reservation differs from ACK",
                    )
                    R["save"](out / "observed.json", current)
                need(
                    not cancelled and time.time() < deadline,
                    "cancelled after native observation",
                )
                marker = proof["marker"]
                row = dict(
                    original[mid],
                    source_instance_id=current["instance_id"],
                    source_config_sha256=config_sha(current["config"]),
                    prior_marker=canonical(marker).decode(),
                    reservation={
                        "cohort": request["cohort"],
                        "marker": marker,
                        "instance_id": current["instance_id"],
                        "config_sha256": config_sha(current["config"]),
                    },
                )
                result["candidates"].append(row)
                inputs[str(out / "observed.json")] = sha(
                    R["read"](out / "observed.json")
                )
                observed.add(mid)
            except (Exception, R["Deadline"]) as error:
                if (
                    not isinstance(
                        error,
                        (
                            OSError,
                            ValueError,
                            KeyError,
                            TypeError,
                            subprocess.SubprocessError,
                            R["Deadline"],
                        ),
                    )
                    and type(error).__name__ != "CaptureFailure"
                ):
                    raise
                diagnostics.append(
                    {
                        "machine_id": mid,
                        "reason": str(error)
                        if type(error) is ValueError
                        else type(error).__name__,
                    }
                )
        result["held_native_reservations"] = [
            row for row in held if row["machine_id"] not in observed
        ]
        H["validate_request"](result)
        need(
            membership(base, journal) == old_membership,
            "original reservation membership changed",
        )
        for path, digest in inputs.items():
            need(
                sha(R["read"](path)) == digest,
                "observation proof changed during leased readback",
            )
        R["save"](journal / "request.json", result)
        R["save"](
            journal / "complete.json",
            {
                "identity_sha256": identity,
                "request_sha256": sha(R["read"](journal / "request.json")),
                "inputs": inputs,
                "old_membership": old_membership,
                "added_machine_ids": sorted(observed),
                "prior_failures": held,
                "diagnostics": diagnostics,
                "cancelled_signals": cancelled,
                "original_deadline": deadline,
                "config_writes": 0,
                "task_credit": 0,
            },
        )
        if cancelled:
            raise AdmissionObservationCancelled(
                "admission observation cancelled after joining native ownership"
            )
        need(time.time() < deadline, "original deadline expired after observation")
        return result
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
