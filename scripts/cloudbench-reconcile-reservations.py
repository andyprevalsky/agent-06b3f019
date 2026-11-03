#!/usr/bin/env python3
"""Observe positively ACKed held reservations without repeating any config write."""

import base64
import copy
import json
import re
import runpy
import stat
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
H = runpy.run_path(str(HERE / "cloudbench-archived-machine-reuse.py"))
U = runpy.run_path(str(HERE / "cloudbench-unused-reservations.py"))
R = runpy.run_path(str(HERE / "cloudbench-original600-runner.py"))
need, sha, canonical, config_sha = (
    H[key] for key in ("need", "sha", "canonical", "config_sha")
)
SOURCE = "08ecb42f3f8837fbc90ca6ab6857ffd9de795201"


def obj(path, inputs):
    path = Path(path).absolute()
    raw = R["read"](path)
    inputs[str(path)] = sha(raw)
    return json.loads(raw)


def wire(directory, inputs):
    result = []
    root = directory / "wire"
    need(
        root.is_dir() and root.resolve(strict=True) == root,
        "physical wire directory required",
    )
    for folder in sorted(root.iterdir()):
        need(
            folder.is_dir() and folder.resolve(strict=True) == folder,
            "physical wire request required",
        )
        request = obj(folder / "request.json", inputs)
        paths = sorted(folder.glob("*-wire.json"))
        need(len(paths) <= 1, "ambiguous raw reservation response")
        if not paths:
            result.append((request, None, None, None))
            continue
        raw_record = obj(paths[0], inputs)
        raw = base64.b64decode(raw_record["body_b64"], validate=True)
        need(
            sha(raw) == raw_record["sha256"]
            and raw_record["method"] == request["method"]
            and raw_record["path"] == request["path"],
            "native raw identity/hash differs",
        )
        value = (
            json.loads(raw)
            if 200 <= raw_record["status"] < 300 and raw.strip()
            else None
        )
        if (folder / "result.json").exists():
            need(
                obj(folder / "result.json", inputs) == value,
                "decoded reservation response differs",
            )
        result.append((request, raw_record, value, str(paths[0])))
    return result


def positive(directory, row, request, inputs, records=None, allow_pending=False):
    mid = row["machine_id"]
    before = obj(directory / "original-native.json", inputs)
    H["same_source"](row, before)
    intent = obj(directory / "intent.json", inputs)
    need(
        obj(directory / "dispatch-entered.json", inputs)
        == {"intent_sha256": sha(canonical(intent))},
        "dispatch intent differs",
    )
    marker = {
        "schema": H["SCHEMA"],
        "state": "RESERVED",
        "cohort": request["cohort"],
        "machine_id": mid,
        "volume_id": row["volume_id"],
        "source_excluded": True,
        "archive_sha256": row["archive_sha256"],
        "harness_ref": request["harness_ref"],
    }
    need(
        obj(directory / "source-exclusion.json", inputs)
        == {"predecessor": row, "marker": marker},
        "reservation predecessor differs",
    )
    expected = copy.deepcopy(before["config"])
    expected.setdefault("metadata", {})[H["MARKER"]] = canonical(marker).decode()
    expected["init"] = {"cmd": ["sleep", "infinity"]}
    need(
        intent
        == {
            "current_version": before["instance_id"],
            "config_sha256": config_sha(expected),
        },
        "reservation intent differs",
    )
    records = wire(directory, inputs) if records is None else records
    url = "/machines/" + mid
    need(
        all(
            req["app"] == H["APP"]
            and (req["method"], req["path"])
            in (
                ("GET", url),
                ("POST", url),
                ("POST", url + "/lease"),
                ("DELETE", url + "/lease"),
            )
            for req, _, _, _ in records
        ),
        "foreign reservation native effect",
    )
    posts = [r for r in records if r[0]["method"] == "POST" and r[0]["path"] == url]
    need(len(posts) == 1, "unknown or repeated config dispatch")
    update, raw, ack, ack_path = posts[0]
    pending = bool(
        allow_pending
        and raw is not None
        and (raw.get("missing_response") is True or raw.get("status") == 499)
    )
    need(
        pending
        or raw is not None
        and isinstance(raw.get("status"), int)
        and 200 <= raw["status"] < 300
        and isinstance(ack, dict),
        "no positive raw config ACK",
    )
    nonce = update.get("headers", {}).get("fly-machine-lease-nonce")
    need(
        isinstance(nonce, str)
        and nonce
        and update["body"]
        == {
            "config": expected,
            "current_version": before["instance_id"],
            "skip_launch": True,
        },
        "config request differs",
    )
    at = raw["monotonic_ns"]
    need(
        any(
            w is not None
            and w["monotonic_ns"] < at
            and isinstance(w.get("status"), int)
            and 200 <= w["status"] < 300
            and req["method"] == "POST"
            and req["path"] == url + "/lease"
            and isinstance(value, dict)
            and value.get("data", {}).get("nonce") == nonce
            for req, w, value, _ in records
        ),
        "lease ACK not bound",
    )
    need(
        any(
            w is not None
            and w["monotonic_ns"] < at
            and isinstance(w.get("status"), int)
            and 200 <= w["status"] < 300
            and req["method"] == "GET"
            and req["path"] == url
            and isinstance(value, dict)
            and value.get("instance_id") == before["instance_id"]
            and value.get("id") == mid
            and value.get("config") == before["config"]
            for req, w, value, _ in records
        ),
        "pre-update GET missing",
    )
    if pending:
        return {
            "machine_id": mid,
            "candidate": row,
            "marker": marker,
            "expected_native": dict(before, config=expected),
            "original_instance": before["instance_id"],
            "old_response_unknown": True,
            "same_cohort": request["cohort"],
        }
    need(
        ack.get("id") == mid
        and ack.get("instance_id")
        and ack["instance_id"] != before["instance_id"]
        and ack.get("config") == expected
        and all(ack.get(k) == before.get(k) for k in ("name", "region", "created_at")),
        "raw ACK differs",
    )
    need(
        [m.get("volume") for m in ack["config"].get("mounts", [])]
        == [row["volume_id"]],
        "ACK volume differs",
    )
    return {
        "machine_id": mid,
        "candidate": row,
        "ack": ack,
        "marker": marker,
        "raw_ack_path": ack_path,
        "raw_ack_file_sha256": inputs[ack_path],
    }


def plan(directory):
    root = Path(directory).absolute()
    need(
        root.resolve(strict=True) == root and root.is_dir(),
        "physical admission required",
    )
    inputs = {}
    admission = obj(root / "admission-intent.private.json", inputs)
    envelope = obj(root / "archived-reuse-original.private.json", inputs)
    request = envelope["request"]
    need(
        envelope["schema"] == "original600-archived-admission-request-v1"
        and envelope["sha256"]
        == sha(json.dumps(request, sort_keys=True, allow_nan=False).encode()),
        "original admission checksum differs",
    )
    H["validate_request"](request, SOURCE)
    source = subprocess.check_output(
        [
            "git",
            "--no-replace-objects",
            "-C",
            str(HERE.parent),
            "show",
            SOURCE + ":scripts/run-original600-controller.py",
        ]
    )
    need(
        b"fresh capacity after reserved native readback is insufficient" in source,
        "known source refusal protocol missing",
    )
    need(
        admission["binding"]["source_ref"] == SOURCE
        and admission["deadline_epoch"] == admission["started_at_epoch"] + 5400,
        "original source/clock differs",
    )
    bound = admission["binding"]["inputs"]
    need(
        set(bound)
        == {
            "agents_env",
            "backend_env",
            "facts",
            "snapshot_inventory",
            "tasks",
            "warm_deps",
        },
        "complete original admission inputs required",
    )
    for descriptor in bound.values():
        path = Path(descriptor["path"]).absolute()
        raw = R["read"](path)
        need(sha(raw) == descriptor["sha256"], "original admission input changed")
        inputs[str(path)] = sha(raw)
    tasks = json.loads(R["read"](bound["tasks"]["path"]))
    R["campaign_argv"](tasks, admission["started_at_epoch"])
    public = runpy.run_path(str(HERE / "run-original600-controller.py"))
    facts = public["facts_from"](R["read"](bound["facts"]["path"]))
    need(
        request["task_names"] == tasks
        and H["immutable_image"](request["image_ref"])
        == H["immutable_image"](facts["image_ref"]),
        "task/image admission differs",
    )
    closed = obj(root / "archived-reuse-reservations/reserved-request.json", inputs)
    H["validate_request"](closed, SOURCE)
    need(
        all(closed.get(k) == v for k, v in request.items() if k != "candidates"),
        "closed plan input differs",
    )
    original = {r["machine_id"]: r for r in request["candidates"]}
    credited = set()
    for row in closed["candidates"]:
        mid = row["machine_id"]
        need(mid in original and mid not in credited, "foreign closed candidate")
        need(
            all(
                row.get(k) == v
                for k, v in original[mid].items()
                if k
                not in ("source_instance_id", "source_config_sha256", "prior_marker")
            ),
            "closed candidate lineage differs",
        )
        marker = row["reservation"]["marker"]
        need(
            row["reservation"]["cohort"] == request["cohort"]
            and marker["machine_id"] == mid
            and row["prior_marker"] == canonical(marker).decode()
            and row["source_instance_id"] == row["reservation"]["instance_id"]
            and row["source_config_sha256"] == row["reservation"]["config_sha256"],
            "closed reservation differs",
        )
        credited.add(mid)
    held = closed.get("held_native_reservations", [])
    held_ids = [r["machine_id"] for r in held]
    need(
        len(set(held_ids)) == len(held_ids)
        and set(held_ids) == set(original) - credited
        and all(r.get("not_credited") is True for r in held),
        "held partition differs",
    )
    accepted, rejected = [], []
    for mid in held_ids:
        try:
            accepted.append(
                positive(
                    root / "archived-reuse-reservations" / mid,
                    original[mid],
                    request,
                    inputs,
                )
            )
        except (ValueError, KeyError, TypeError, OSError) as error:
            rejected.append(
                {
                    "machine_id": mid,
                    "reason": str(error)
                    if type(error) is ValueError
                    else type(error).__name__,
                }
            )
    return {
        "schema": "original600-positive-reservation-reconciliation-v1",
        "directory": str(root),
        "original_request": request,
        "closed_request": closed,
        "accepted": accepted,
        "rejected": rejected,
        "inputs": inputs,
        "original_epoch": admission["started_at_epoch"],
        "deadline": admission["deadline_epoch"],
        "zero_task_credit": True,
        "no_config_write": True,
    }


def history_membership(directory):
    root = Path(directory).absolute()
    base = root / "archived-reuse-reservations"
    members = {}
    for path in sorted(base.rglob("*")):
        value = path.lstat()
        relative = str(path.relative_to(root))
        need(
            value.st_uid == __import__("os").geteuid() and not value.st_mode & 0o077,
            "private old journal required",
        )
        if stat.S_ISDIR(value.st_mode):
            need(path.resolve(strict=True) == path, "journal alias")
            members[relative] = {"kind": "directory"}
        else:
            raw = R["read"](path)
            members[relative] = {"kind": "file", "bytes": len(raw), "sha256": sha(raw)}
    return members


def check_inputs(value):
    for path, expected in value["inputs"].items():
        need(sha(R["read"](path)) == expected, "reconciliation input changed")


def prepare(expired_run, inventory_path):
    """New-cohort eligibility only; never revive or mutate the expired admission."""
    value = plan(expired_run)
    root = Path(value["directory"])
    inputs = value["inputs"]
    failure = obj(root / "observed-admission-failure.safe.json", inputs)
    expiry = obj(root / "observed-expired-admission.safe.json", inputs)
    intent_sha = inputs[str(root / "admission-intent.private.json")]
    closed_sha = inputs[str(root / "archived-reuse-reservations/reserved-request.json")]
    need(
        failure["schema"] == "original600-observed-admission-failure-v1"
        and failure["source_ref"] == SOURCE
        and failure["admission_directory"] == str(root)
        and failure["admission_intent_sha256"] == intent_sha
        and failure["closed_request_sha256"] == closed_sha
        and failure["tool_reported_exit_code"] == 1
        and failure["joined_observed"] is True
        and failure["controller_created"] is False
        and failure["capture_kind"]
        == "verbatim text from two observed exec tool output chunks; not a separately captured original process stream"
        and type(failure["tool_session_id"]) is int
        and failure["tool_session_id"] > 0,
        "positive joined admission refusal required",
    )
    log = Path(failure["log_path"])
    need(
        log.parent == root
        and log.name
        == "observed-tool-" + str(failure["tool_session_id"]) + ".stdout-stderr.txt",
        "refusal log outside admission",
    )
    raw = R["read"](log)
    inputs[str(log)] = sha(raw)
    need(
        sha(raw) == failure["log_sha256"]
        and raw.endswith(
            b"ValueError: fresh capacity after reserved native readback is insufficient\n"
        ),
        "positive capacity refusal log differs",
    )
    lines = raw.decode().splitlines()
    started, pending = json.loads(lines[0]), json.loads(lines[1])
    need(
        started["status"] == "ADMISSION_STARTED"
        and started["source_ref"] == SOURCE
        and started["directory"] == str(root)
        and pending["status"] == "ADMISSION_PENDING"
        and pending["directory"] == str(root)
        and pending["controller_started"] is False
        and "in reserve_reuse_capacity" in raw.decode(),
        "known joined refusal trace differs",
    )
    need(
        expiry["schema"] == "original600-observed-expired-admission-v1"
        and expiry["admission_intent_sha256"] == intent_sha
        and expiry["started_at_epoch"] == value["original_epoch"]
        and expiry["original_deadline_epoch"] == value["deadline"]
        and value["deadline"] < expiry["observed_at_epoch"] <= time.time()
        and time.time() > value["deadline"]
        and expiry["config_present"] is False
        and expiry["controller_launch_intent_present"] is False
        and expiry["prior_failure_receipt"] == "observed-admission-failure.safe.json",
        "expired admission proof differs",
    )
    need(
        not any(root.glob("launch-*"))
        and not (root / "config.private.json").exists()
        and not (root / "controller-launch.intent.json").exists(),
        "admission has launch artifacts",
    )
    native_path = Path(inventory_path).absolute()
    raw = H["module"]("cloudbench-archived-owner-stop.py")["raw"](
        native_path, 256 * 1024 * 1024
    )
    inputs[str(native_path)] = sha(raw)
    rows = json.loads(raw)
    native = {row["id"]: row for row in rows}
    need(len(native) == len(rows), "duplicate native inventory")
    accepted = {entry["machine_id"]: entry for entry in value["accepted"]}
    selected = list(value["closed_request"]["candidates"])
    original_rows = {
        row["machine_id"]: row for row in value["original_request"]["candidates"]
    }
    for row in selected:
        mid = row["machine_id"]
        need(mid in native, "closed reservation missing from inventory")
        U["validate_candidate"](
            root,
            original_rows[mid],
            row,
            native[mid],
            value["original_request"]["cohort"],
            SOURCE,
            inputs,
        )
    for entry in value["accepted"]:
        ack = entry["ack"]
        selected.append(
            dict(
                entry["candidate"],
                source_instance_id=ack["instance_id"],
                source_config_sha256=config_sha(ack["config"]),
                prior_marker=canonical(entry["marker"]).decode(),
                reservation={
                    "cohort": value["original_request"]["cohort"],
                    "marker": entry["marker"],
                    "instance_id": ack["instance_id"],
                    "config_sha256": config_sha(ack["config"]),
                },
            )
        )
    membership = history_membership(root)
    proof = {
        "history_membership": membership,
        "history_membership_sha256": sha(canonical(membership)),
        "immutable_inputs_sha256": sha(
            canonical(
                {key: value for key, value in inputs.items() if key != str(native_path)}
            )
        ),
        "schema": "original600-expired-reservation-eligibility-v1",
        "directory": str(root),
        "admission_intent_sha256": inputs[str(root / "admission-intent.private.json")],
        "closed_request_sha256": inputs[
            str(root / "archived-reuse-reservations/reserved-request.json")
        ],
        "closure_sha256": inputs[str(root / "observed-expired-admission.safe.json")],
        "original_epoch": value["original_epoch"],
        "deadline": value["deadline"],
    }
    archive_sha = sha(canonical(proof))
    inherited = value["original_request"].get("held_prior_reservations", [])
    origins = {
        entry["archive_sha256"] for entry in value["original_request"]["archives"]
    }
    seen = set()
    for scope in inherited:
        ids = scope["machine_ids"]
        need(
            scope["archive_sha256"] in origins
            and scope.get("reuse_credit") is False
            and len(ids) == len(set(ids))
            and all(
                isinstance(mid, str) and re.fullmatch("[0-9a-f]{14}", mid)
                for mid in ids
            )
            and scope["archive_sha256"] not in seen,
            "invalid inherited reservation hold scope",
        )
        seen.add(scope["archive_sha256"])
    candidates = []
    for row in selected:
        mid = row["machine_id"]
        need(
            mid in native and native[mid]["state"] == "stopped",
            "expired reservation not stopped",
        )
        H["same_source"](row, native[mid])
        candidate = copy.deepcopy(row)
        candidate.pop("reservation")
        candidate.setdefault("legacy_archive_sha256", candidate["archive_sha256"])
        candidate["archive_sha256"] = archive_sha
        candidate["expired_reservation_proof"] = dict(
            {key: value for key, value in proof.items() if key != "history_membership"},
            original_failure_retained=True,
            positive_held_ack=mid in accepted,
            capacity_credit=0,
        )
        candidates.append(candidate)
    return {
        "candidates": candidates,
        "held_machine_ids": [row["machine_id"] for row in value["rejected"]],
        "archive": {
            "archive_sha256": archive_sha,
            "inputs": inputs,
            "expired_admission": proof,
        },
        "diagnostics": value["rejected"],
        "inherited_held_scopes": copy.deepcopy(inherited),
    }


def validate_handoff(archive):
    """Recheck immutable inputs and exact old journals; handoff file is outside history."""
    proof = archive["expired_admission"]
    need(
        sha(canonical(proof)) == archive["archive_sha256"],
        "expired closure digest differs",
    )
    for path, expected in archive["inputs"].items():
        source = Path(path)
        if source.stat().st_size > 16 * 1024 * 1024:
            raw = U["CLOSED"]["raw"](source, 256 * 1024 * 1024)
        else:
            raw = R["read"](source)
        need(sha(raw) == expected, "expired handoff input changed")
    need(
        history_membership(proof["directory"]) == proof["history_membership"],
        "old reservation membership changed",
    )
    root = Path(proof["directory"])
    need(
        not any(root.glob("launch-*"))
        and not (root / "config.private.json").exists()
        and not (root / "controller-launch.intent.json").exists(),
        "expired admission acquired launch artifacts",
    )
    return True


_OBSERVER = runpy.run_path(
    str(HERE / "cloudbench-observe-reservations.py"),
    init_globals={
        "CONTRACT": {
            key: globals()[key]
            for key in ("H", "R", "need", "sha", "canonical", "config_sha", "positive")
        }
    },
)
observe_acknowledged_holds = _OBSERVER["observe_acknowledged_holds"]
