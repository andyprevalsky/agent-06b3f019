#!/usr/bin/env python3
"""Recover incomplete admission only from proved dispatch state; no unknown write replay."""

import ast
import base64
import binascii
import copy
import json
import runpy
import signal
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from functools import cache
from pathlib import Path

HERE = Path(__file__).resolve().parent
C = runpy.run_path(str(HERE / "cloudbench-reconcile-reservations.py"))
H, R = C["H"], C["R"]
need, sha, canonical = (H[k] for k in ("need", "sha", "canonical"))
SOURCE = "724ae71f5bd8756be01ea237de0c2742e4f94b77"
CLOSED_SOURCE = "49b792dcc2ea983325c6a25801da6c982f29c206"
CLOSED75_SOURCE = "1cec8c1cb20c85e66e10cd49446b44c5e85101f1"
CLOSED77_SOURCE = "c9d4817832720cc2b1bc6a212383973a77baf004"
# The one reviewed successor of the historical dispatch protocol: 676f54aa8
# makes wire() raise NativeRejected for a recorded 429 write receipt instead of
# the generic child failure. Request, receipt and result artifacts are unchanged,
# and known_error() treats the rejection as held. Any other change still fails.
REVIEWED_PROTOCOL_SOURCE = "676f54aa89a87e7987aa535402f453804864a3e6"


class CancelledAdmission(BaseException):
    """Cancellation after native owners joined cannot authorize launch."""


def protocol(source=SOURCE):
    result = {}
    selections = {
        "cloudbench-archived-reuse-effects.py": {
            "wire",
            "perform_wire",
            "_run_wire",
            "reserve_cohort",
        },
        "cloudbench-original600-runner.py": {"save"},
    }
    for name, selected in selections.items():

        def show(ref, name=name):
            return subprocess.check_output(
                [
                    "git",
                    "--no-replace-objects",
                    "-C",
                    str(HERE.parent),
                    "show",
                    ref + ":scripts/" + name,
                ]
            )

        raw = show(source)

        def functions(data, selected=selected):
            return {
                node.name: ast.dump(node, include_attributes=False)
                for node in ast.walk(ast.parse(data))
                if isinstance(node, ast.FunctionDef)
                and node.name in selected
                and node.col_offset <= 4
            }

        current = functions((HERE / name).read_bytes())
        need(
            current == functions(raw)
            or (
                functions(raw) == functions(show(SOURCE))
                and current == functions(show(REVIEWED_PROTOCOL_SOURCE))
            ),
            "dispatch protocol source changed",
        )
        result[name] = sha(raw)
    return result


def classified_wire(directory, mid, inputs):
    records, partials, observations = [], [], []
    root = directory / "wire"
    if not root.exists():
        return records, partials, observations
    need(root.resolve(strict=True) == root, "wire root alias")
    for folder in sorted(root.iterdir()):
        need(
            folder.is_dir()
            and folder.resolve(strict=True) == folder
            and len(folder.name) == 32
            and all(c in "0123456789abcdef" for c in folder.name),
            "unknown wire namespace",
        )
        paths = list(folder.iterdir())
        request_path = folder / "request.json"
        try:
            request = C["obj"](request_path, inputs)
        except (json.JSONDecodeError, UnicodeDecodeError, FileNotFoundError):
            # Exact known wire order: save(request) must return before any
            # transport-start/stderr/HTTP/response side effect can occur.
            need(
                all(p.name == "request.json" for p in paths),
                "malformed request has possible dispatch",
            )
            partials.append(
                {
                    "directory": str(folder),
                    "request_sha256": inputs.get(str(request_path)),
                    "state": "PRE_DISPATCH_INCOMPLETE",
                }
            )
            continue
        url = "/machines/" + mid
        need(
            request["app"] == H["APP"]
            and (request["method"], request["path"])
            in (
                ("GET", url),
                ("POST", url),
                ("POST", url + "/lease"),
                ("DELETE", url + "/lease"),
            ),
            "unknown native action",
        )
        need(
            all(
                path.name
                in {
                    "request.json",
                    "transport-start.json",
                    "stderr.private.log",
                    "http-start.json",
                    "result.json",
                }
                or path.name.endswith("-wire.json")
                for path in paths
            ),
            "unknown wire artifact",
        )
        raw_paths = sorted(folder.glob("*-wire.json"))
        need(len(raw_paths) <= 1, "multiple native raw responses")
        raw_record, value, path = None, None, None
        if raw_paths:
            path = str(raw_paths[0])
            try:
                candidate = C["obj"](raw_paths[0], inputs)
                raw = base64.b64decode(candidate["body_b64"], validate=True)
                need(
                    sha(raw) == candidate["sha256"]
                    and candidate["method"] == request["method"]
                    and candidate["path"] == request["path"],
                    "native raw hash/identity differs",
                )
                value = (
                    json.loads(raw)
                    if 200 <= candidate["status"] < 300 and raw.strip()
                    else None
                )
                raw_record = candidate
            except (
                json.JSONDecodeError,
                UnicodeDecodeError,
                KeyError,
                TypeError,
                binascii.Error,
            ):
                observations.append({"path": path, "state": "MALFORMED_RESPONSE"})
        if not raw_paths and request["method"] == "POST" and request["path"] == url:
            started = C["obj"](folder / "transport-start.json", inputs)
            need(
                type(started["monotonic_ns"]) is int and started["direct"] is False,
                "unknown config transport start",
            )
            raw_record = {
                "missing_response": True,
                "status": None,
                "monotonic_ns": started["monotonic_ns"],
            }
        # A broken derived result does not erase a positively verified raw ACK.
        if (folder / "result.json").exists():
            try:
                result = C["obj"](folder / "result.json", inputs)
                need(
                    raw_record is None or result == value,
                    "derived result differs from raw response",
                )
            except (json.JSONDecodeError, UnicodeDecodeError):
                observations.append(
                    {
                        "path": str(folder / "result.json"),
                        "state": "MALFORMED_DERIVED_RESULT",
                    }
                )
        records.append((request, raw_record, value, path))
    return records, partials, observations


def classify(directory, row, request, inputs):
    records, partials, observations = classified_wire(
        directory, row["machine_id"], inputs
    )
    posts = [
        record
        for record in records
        if record[0]["method"] == "POST"
        and record[0]["path"] == "/machines/" + row["machine_id"]
    ]
    allowed = {
        "wire",
        "original-native.json",
        "source-exclusion.json",
        "intent.json",
        "dispatch-entered.json",
        "not-dispatched.json",
        "reserved.json",
    }
    need(
        all(
            path.name in allowed
            or path.name.startswith("held-")
            and path.name.endswith(".json")
            for path in directory.iterdir()
        ),
        "unknown per-Machine effect artifact",
    )
    if posts:
        proof = C["positive"](
            directory, row, request, inputs, records=records, allow_pending=True
        )
        return {
            "lane": "PENDING_READ" if proof.get("old_response_unknown") else "ACK",
            "proof": proof,
            "partial_calls": partials,
            "unknown_observations": observations,
        }
    intent, dispatched = directory / "intent.json", directory / "dispatch-entered.json"
    if (directory / "original-native.json").exists():
        H["same_source"](row, C["obj"](directory / "original-native.json", inputs))
    if (directory / "source-exclusion.json").exists():
        marker = {
            "schema": H["SCHEMA"],
            "state": "RESERVED",
            "cohort": request["cohort"],
            "machine_id": row["machine_id"],
            "volume_id": row["volume_id"],
            "source_excluded": True,
            "archive_sha256": row["archive_sha256"],
            "harness_ref": request["harness_ref"],
        }
        need(
            C["obj"](directory / "source-exclusion.json", inputs)
            == {"predecessor": row, "marker": marker},
            "pre-config exclusion differs",
        )
    need(
        not (directory / "reserved.json").exists(),
        "reserved row without raw config ACK",
    )
    if intent.exists():
        value = C["obj"](intent, inputs)
        no_dispatch = C["obj"](directory / "not-dispatched.json", inputs)
        need(
            not dispatched.exists()
            and no_dispatch
            == {
                "intent_sha256": sha(canonical(value)),
                "cancelled_before_dispatch": True,
            },
            "unresolved intent without config request",
        )
    else:
        need(not dispatched.exists(), "dispatch without known config request")
    return {
        "lane": "PRE_CONFIG",
        "candidate": row,
        "partial_calls": partials,
        "unknown_observations": observations,
    }


@cache
def private_hasher():
    return runpy.run_path(str(HERE / "cloudbench-prepare-admission.py"))["file_hash"]


def private_digest(path):
    return private_hasher()(Path(path))["sha256"]


def check_plan_inputs(value):
    if value.get("schema") != "closed-admission-continuation-v1":
        return C["check_inputs"](value)
    for path, expected in value["inputs"].items():
        need(private_digest(path) == expected, "closed continuation input changed")


@cache
def retained_observer():
    return runpy.run_path(str(HERE / "cloudbench-recovered-reservations.py"))[
        "observed"
    ]


def retained_native(root, original, reserved, lane, inputs):
    mid = original["machine_id"]
    base = root / "archived-reuse-reservations"
    if lane == "ORIGINAL_CLOSED":
        proof = C["positive"](base / mid, original, reserved["_request"], inputs)
        native = proof["ack"]
        C["U"]["validate_candidate"](
            root,
            original,
            reserved["row"],
            native,
            reserved["_request"]["cohort"],
            reserved["_request"]["harness_ref"],
            inputs,
        )
        need(
            C["obj"](base / mid / "reserved.json", inputs) == reserved["row"],
            "retained original row changed",
        )
        return native
    need(lane == "OLD_OBSERVED", "unknown retained reservation lane")
    proof = C["positive"](base / mid, original, reserved["_request"], inputs)
    return retained_observer()(
        base / "acknowledged-holds-observation" / mid, proof, inputs
    )


def closed_classification(directory, row, request, inputs):
    """Potential only: a NEW lease must still observe the unchanged prior version."""
    entry = classify(directory, row, request, inputs)
    if entry["lane"] == "PENDING_READ":
        before = C["obj"](directory / "original-native.json", inputs)
        records, partials, observations = classified_wire(
            directory, row["machine_id"], inputs
        )
        need(not partials and not observations, "ambiguous old config history")
        tuples = [
            (
                raw.get("monotonic_ns") if raw else None,
                req,
                value,
                raw.get("status") if raw else None,
            )
            for req, raw, value, _ in records
        ]
        update = next(
            req
            for _, req, _, _ in tuples
            if req["method"] == "POST"
            and req["path"] == "/machines/" + row["machine_id"]
        )
        transition = runpy.run_path(
            str(HERE / "cloudbench-closed-transition-reservations.py")
        )
        proof = transition["unchanged"](
            before,
            before,
            update,
            C["obj"](directory / "intent.json", inputs),
            tuples,
            row["machine_id"],
            entry["proof"]["expected_native"]["config"],
        )
        proof.update(
            stage="VERSION_FENCED_OLD_HISTORY_ONLY", observed_prior_state=False
        )
        return {
            "lane": "PRIOR_UNKNOWN_NEW_CAS",
            "candidate": row,
            "prior_transition": proof,
            "fresh_prior_state_required": True,
        }
    need(entry["lane"] in ("PRE_CONFIG", "ACK"), "unsupported closed continuation lane")
    return entry


def failed_observation(directory, mid, inputs):
    """A completed failed leased read retains evidence, never reservation credit."""
    reader = runpy.run_path(str(HERE / "cloudbench-recovered-reservations.py"))
    names = {path.name for path in directory.iterdir()}
    need(
        names in ({"wire"}, {"wire", "observed.json"}),
        "unknown failed observation artifact",
    )
    reader["wire_namespace"](directory)
    records = C["wire"](directory, inputs)
    need(
        len(records) == 3 and all(record[1] is not None for record in records),
        "incomplete failed observation wire",
    )
    stamps = [record[1].get("monotonic_ns") for record in records]
    need(
        all(type(at) is int for at in stamps) and len(set(stamps)) == 3,
        "invalid failed observation order",
    )
    records.sort(key=lambda record: record[1]["monotonic_ns"])
    acquire, readback, release = records
    for request, raw, _, _ in records:
        need(
            request["app"] == H["APP"]
            and type(raw["status"]) is int
            and 200 <= raw["status"] < 300,
            "failed observation raw response not successful",
        )
    nonce = acquire[2].get("data", {}).get("nonce")
    need(isinstance(nonce, str) and nonce, "failed observation nonce missing")
    url = "/machines/" + mid
    need(
        acquire[0]["method"] == "POST"
        and acquire[0]["path"] == url + "/lease"
        and acquire[0]["body"]
        == {"description": "archived same-volume successor", "ttl": 180}
        and readback[0]["method"] == "GET"
        and readback[0]["path"] == url
        and readback[0]["body"] is None
        and release[0]["method"] == "DELETE"
        and release[0]["path"] == url + "/lease"
        and release[0]["body"] is None
        and all(
            record[0].get("headers", {}).get("fly-machine-lease-nonce") == nonce
            for record in (readback, release)
        )
        and isinstance(readback[2], dict)
        and readback[2].get("id") == mid,
        "failed observation is not one closed read-only lease",
    )
    if "observed.json" in names:
        need(
            C["obj"](directory / "observed.json", inputs) == readback[2],
            "failed saved observation differs",
        )
    for path in directory.rglob("*"):
        if path.is_file():
            raw = R["read"](path)
            inputs[str(path)] = sha(raw)


def closed_plan(directory, failure_path, *, historical=False, source=None):
    source = CLOSED_SOURCE if source is None else source
    need(
        source in (CLOSED_SOURCE, CLOSED75_SOURCE, CLOSED77_SOURCE),
        "unknown closed admission source",
    )
    typed75 = source == CLOSED75_SOURCE
    expected_error = (
        "AttributeError: 'NoneType' object has no attribute 'get' at verify_reuse_images current['config']"
        if typed75
        else "fresh capacity after reserved native readback is insufficient"
    )
    expected_last = (
        "AttributeError: 'NoneType' object has no attribute 'get'"
        if typed75
        else "ValueError: fresh capacity after reserved native readback is insufficient"
    )
    root = Path(directory).absolute()
    need(
        root.resolve(strict=True) == root and root.is_dir(),
        "physical closed admission required",
    )
    inputs = {}
    admission = C["obj"](root / "admission-intent.private.json", inputs)
    saved = C["obj"](root / "archived-reuse-original.private.json", inputs)
    request = saved["request"]
    H["validate_request"](request, source)
    need(
        saved["schema"] == "original600-archived-admission-request-v1"
        and saved["sha256"]
        == sha(json.dumps(request, sort_keys=True, allow_nan=False).encode())
        and admission["binding"]["source_ref"] == source
        and admission["deadline_epoch"] == admission["started_at_epoch"] + 5400,
        "closed source/request/clock differs",
    )
    failure = C["obj"](failure_path, inputs)
    need(
        Path(failure_path).absolute() == root / "observed-admission-failure.safe.json"
        and failure["schema"] == "original600-observed-admission-failure-v1"
        and failure["source_ref"] == source
        and failure["capture_kind"] == "original-process-stream"
        and failure["admission_directory"] == str(root)
        and failure["admission_intent_sha256"]
        == inputs[str(root / "admission-intent.private.json")]
        and failure["original_request_sha256"]
        == inputs[str(root / "archived-reuse-original.private.json")]
        and failure["joined_observed"] is True
        and failure["tool_reported_exit_code"] == 1
        and failure["controller_created"] is False
        and failure["request_output_absent"] is True
        and failure["launch_directories_absent"] is True
        and failure["observed_error"] == expected_error,
        "typed joined capacity failure differs",
    )
    source_root = Path(failure["source_root"])
    need(
        subprocess.check_output(
            [
                "git",
                "--no-replace-objects",
                "-C",
                str(source_root),
                "rev-parse",
                "HEAD",
            ],
            text=True,
        ).strip()
        == source,
        "original closed operator changed",
    )
    log_path = Path(failure["log_path"])
    log = R["read"](log_path)
    inputs[str(log_path)] = sha(log)
    lines = log.decode().splitlines()
    events = [json.loads(line) for line in lines if line.startswith("{")]
    need(
        sha(log) == failure["log_sha256"]
        and lines[-1] == expected_last
        and any(
            e.get("status") == "ADMISSION_STARTED"
            and e.get("source_ref") == source
            and e.get("directory") == str(root)
            for e in events
        )
        and any(
            e.get("status") == "ADMISSION_PENDING"
            and e.get("controller_started") is False
            and e.get("directory") == str(root)
            for e in events
        ),
        "closed capacity stream differs",
    )
    if typed75:
        need(
            (
                'File "'
                + str(source_root / "scripts/run-original600-controller.py")
                + '", line 178, in verify_reuse_images'
            )
            in log.decode()
            and "if current is None or image_identity(current['config'].get('image')) != identity:"
            in log.decode(),
            "known incomplete-config image frame required",
        )
    bound = admission["binding"]["inputs"]
    need(
        set(bound)
        == {
            "agents_env",
            "backend_env",
            "tasks",
            "facts",
            "snapshot_inventory",
            "warm_deps",
        },
        "complete closed input set required",
    )
    for item in bound.values():
        path = str(Path(item["path"]).absolute())
        need(private_digest(path) == item["sha256"], "closed bound input changed")
        inputs[path] = item["sha256"]
    tasks = json.loads(R["read"](bound["tasks"]["path"]))
    R["campaign_argv"](tasks, admission["started_at_epoch"])
    facts = runpy.run_path(str(HERE / "run-original600-controller.py"))["facts_from"](
        R["read"](bound["facts"]["path"])
    )
    need(
        tasks == request["task_names"]
        and H["immutable_image"](facts["image_ref"])
        == H["immutable_image"](request["image_ref"]),
        "closed tasks/image changed",
    )
    if not historical:
        need(
            not any(root.glob("launch-*"))
            and not (root / "controller-launch.intent.json").exists()
            and not (root / "config.private.json").exists()
            and not (root / "archived-reuse-request.private.json").exists(),
            "closed admission already published or launched",
        )
    base = root / "archived-reuse-reservations"
    closed = C["obj"](base / "reserved-request.json", inputs)
    observer = base / "acknowledged-holds-observation"
    observed_raw = R["read"](observer / "request.json")
    inputs[str(observer / "request.json")] = sha(observed_raw)
    observed = json.loads(observed_raw)
    complete = C["obj"](observer / "complete.json", inputs)
    intent = C["obj"](observer / "intent.json", inputs)
    need(
        failure["closed_request_sha256"] == inputs[str(base / "reserved-request.json")]
        and failure["observed_request_sha256"]
        == sha(observed_raw)
        == complete["request_sha256"]
        and complete["identity_sha256"]
        == intent["identity_sha256"]
        == sha(
            canonical(
                {
                    "request": request,
                    "closed": closed,
                    "deadline": admission["deadline_epoch"],
                }
            )
        )
        and complete["original_deadline"]
        == intent["original_deadline"]
        == admission["deadline_epoch"]
        and complete["cancelled_signals"] == []
        and complete["config_writes"] == intent["config_writes"] == 0
        and complete["task_credit"] == 0,
        "completed original observation differs",
    )
    initial = {r["machine_id"]: r for r in request["candidates"]}
    H["validate_request"](closed, source)
    H["validate_request"](observed, source)
    for pool in (closed, observed):
        need(
            all(pool.get(k) == v for k, v in request.items() if k != "candidates"),
            "closed pool input changed",
        )
        selected = {r["machine_id"]: r for r in pool["candidates"]}
        held_ids = [r["machine_id"] for r in pool.get("held_native_reservations", [])]
        need(
            len(selected) == len(pool["candidates"])
            and len(held_ids) == len(set(held_ids))
            and not set(selected).intersection(held_ids)
            and set(initial) == set(selected) | set(held_ids)
            and all(
                r.get("not_credited") is True
                for r in pool.get("held_native_reservations", [])
            ),
            "closed pool partition differs",
        )
        for mid, row in selected.items():
            need(
                all(
                    row.get(k) == v
                    for k, v in initial[mid].items()
                    if k
                    not in (
                        "source_instance_id",
                        "source_config_sha256",
                        "prior_marker",
                    )
                ),
                "carried reservation lineage differs",
            )
    old = {r["machine_id"]: r for r in closed["candidates"]}
    retained = {r["machine_id"]: r for r in observed["candidates"]}
    added = set(retained) - set(old)
    need(
        all(retained.get(mid) == row for mid, row in old.items())
        and len(complete["added_machine_ids"]) == len(added)
        and set(complete["added_machine_ids"]) == added
        and complete["prior_failures"] == closed["held_native_reservations"],
        "carried observation partition changed",
    )
    membership = C["history_membership"](root)
    old_membership = {
        key.removeprefix("archived-reuse-reservations/"): value
        for key, value in membership.items()
        if key != "archived-reuse-reservations/acknowledged-holds-observation"
        and not key.startswith(
            "archived-reuse-reservations/acknowledged-holds-observation/"
        )
    }
    need(
        old_membership == complete["old_membership"],
        "old native journal membership changed",
    )
    for path, expected in complete["inputs"].items():
        need(private_digest(path) == expected, "old observation proof changed")
        inputs[path] = expected
    controls = {"intent.json", "complete.json", "request.json"}
    observer_ids = {p.name for p in observer.iterdir()} - controls
    old_held = {row["machine_id"] for row in closed["held_native_reservations"]}
    final_held = {row["machine_id"] for row in observed["held_native_reservations"]}
    failed_ids = observer_ids - added
    need(
        {p.name for p in base.iterdir()}
        == set(initial) | {"reserved-request.json", "acknowledged-holds-observation"}
        and added <= observer_ids
        and failed_ids <= old_held & final_held,
        "unknown closed admission namespace",
    )
    diagnostics = complete.get("diagnostics", [])
    for mid in failed_ids:
        matches = [row for row in diagnostics if row.get("machine_id") == mid]
        need(
            len(matches) == 1
            and isinstance(matches[0].get("reason"), str)
            and matches[0]["reason"],
            "failed observation diagnostic missing or duplicated",
        )
        C["positive"](base / mid, initial[mid], request, inputs)
        failed_observation(observer / mid, mid, inputs)
    lanes = {
        mid: "OLD_OBSERVED" if mid in added else "ORIGINAL_CLOSED" for mid in retained
    }
    for mid, row in retained.items():
        native = retained_native(
            root, initial[mid], {"row": row, "_request": request}, lanes[mid], inputs
        )
        H["same_source"](row, native)
    classes, held = [], []
    for failed in observed["held_native_reservations"]:
        mid = failed["machine_id"]
        try:
            entry = closed_classification(base / mid, initial[mid], request, inputs)
            classes.append({"machine_id": mid, **entry})
        except (ValueError, KeyError, TypeError, OSError) as error:
            held.append(dict(failed, reason=type(error).__name__))
    return {
        "schema": "closed-admission-continuation-v1",
        "directory": str(root),
        "source_ref": source,
        "source_root": str(source_root),
        "started_at": admission["started_at_epoch"],
        "deadline": admission["deadline_epoch"],
        "original_epoch": admission["started_at_epoch"],
        "request": request,
        "retained_request": observed,
        "retained_lanes": lanes,
        "classifications": classes,
        "held": held,
        "inputs": inputs,
        "membership": membership,
        "protocol_hashes": protocol(source),
        "failure_path": str(Path(failure_path).absolute()),
    }


def _plan(directory, failure_path, *, historical=False):
    root = Path(directory).absolute()
    need(root.resolve(strict=True) == root, "physical admission required")
    inputs = {}
    admission = C["obj"](root / "admission-intent.private.json", inputs)
    if admission["binding"]["source_ref"] in (
        CLOSED_SOURCE,
        CLOSED75_SOURCE,
        CLOSED77_SOURCE,
    ):
        return closed_plan(
            root,
            failure_path,
            historical=historical,
            source=admission["binding"]["source_ref"],
        )
    saved = C["obj"](root / "archived-reuse-original.private.json", inputs)
    request = saved["request"]
    H["validate_request"](request, SOURCE)
    need(
        saved["sha256"]
        == sha(json.dumps(request, sort_keys=True, allow_nan=False).encode())
        and admission["binding"]["source_ref"] == SOURCE
        and admission["deadline_epoch"] == admission["started_at_epoch"] + 5400,
        "original source/input/clock differs",
    )
    protocol_hashes = protocol()
    failure = C["obj"](failure_path, inputs)
    need(
        failure["schema"] == "original600-observed-incomplete-admission-v1"
        and failure["capture_kind"] == "original-process-stream"
        and failure["original_request_sha256"]
        == inputs[str(root / "archived-reuse-original.private.json")]
        and failure["source_ref"] == SOURCE
        and failure["admission_directory"] == str(root)
        and failure["admission_intent_sha256"]
        == inputs[str(root / "admission-intent.private.json")]
        and failure["joined_observed"] is True
        and failure["tool_reported_exit_code"] == 1
        and failure["controller_created"] is False,
        "positive original owner failure/join required",
    )
    source_root = Path(failure["source_root"])
    need(
        subprocess.check_output(
            [
                "git",
                "--no-replace-objects",
                "-C",
                str(source_root),
                "rev-parse",
                "HEAD",
            ],
            text=True,
        ).strip()
        == SOURCE,
        "original operator source changed",
    )
    log_path = Path(failure["log_path"])
    raw = R["read"](log_path)
    inputs[str(log_path)] = sha(raw)
    need(
        sha(raw) == failure["log_sha256"]
        and b"No space left on device" in raw
        and b"reserve_cohort" in raw
        and b"Traceback (most recent call last):" in raw,
        "positive joined ENOSPC stream differs",
    )
    bound = admission["binding"]["inputs"]
    need(
        set(bound)
        == {
            "agents_env",
            "backend_env",
            "tasks",
            "facts",
            "snapshot_inventory",
            "warm_deps",
        },
        "complete admission inputs required",
    )
    for entry in bound.values():
        path = Path(entry["path"]).absolute()
        raw_input = R["read"](path)
        need(sha(raw_input) == entry["sha256"], "original bound input changed")
        inputs[str(path)] = sha(raw_input)
    tasks = json.loads(R["read"](bound["tasks"]["path"]))
    R["campaign_argv"](tasks, admission["started_at_epoch"])
    facts = runpy.run_path(str(HERE / "run-original600-controller.py"))["facts_from"](
        R["read"](bound["facts"]["path"])
    )
    need(
        tasks == request["task_names"]
        and H["immutable_image"](facts["image_ref"])
        == H["immutable_image"](request["image_ref"]),
        "admitted task/image differs",
    )
    if not historical:
        need(
            not (root / "controller-launch.intent.json").exists()
            and not any(root.glob("launch-*"))
            and not (root / "config.private.json").exists(),
            "admission already launched",
        )
    base = root / "archived-reuse-reservations"
    need(
        not (base / "reserved-request.json").exists(), "closed reservation plan exists"
    )
    need(
        all(
            path.is_dir()
            and not path.is_symlink()
            and path.name in {row["machine_id"] for row in request["candidates"]}
            for path in base.iterdir()
        ),
        "unknown original reservation namespace",
    )
    membership = C["history_membership"](root)
    classes, held = [], []
    for row in request["candidates"]:
        try:
            value = classify(base / row["machine_id"], row, request, inputs)
            classes.append({"machine_id": row["machine_id"], **value})
        except (ValueError, KeyError, TypeError, OSError) as error:
            held.append(
                {
                    "machine_id": row["machine_id"],
                    "not_credited": True,
                    "error_type": type(error).__name__,
                    "reason": str(error)
                    if type(error) is ValueError
                    else type(error).__name__,
                }
            )
    return {
        "directory": str(root),
        "source_ref": SOURCE,
        "source_root": str(source_root),
        "started_at": admission["started_at_epoch"],
        "request": request,
        "classifications": classes,
        "held": held,
        "inputs": inputs,
        "membership": membership,
        "protocol_hashes": protocol_hashes,
        "deadline": admission["deadline_epoch"],
        "original_epoch": admission["started_at_epoch"],
        "failure_path": str(Path(failure_path).absolute()),
    }


def plan(directory, failure_path):
    """Unlaunched admission only; retain the original launch refusal."""
    return _plan(directory, failure_path)


def historical_plan(directory, failure_path):
    """Proof-only replay after a caller has independently verified full closure."""
    return _plan(directory, failure_path, historical=True)


def known_error(error):
    return (
        isinstance(
            error,
            (
                OSError,
                ValueError,
                KeyError,
                TypeError,
                subprocess.SubprocessError,
                R["Deadline"],
                # A recorded 429 is a definitive no-effect write rejection.
                H["NativeRejected"],
            ),
        )
        or type(error).__name__ == "CaptureFailure"
    )


def observe_ack(api_factory, proof, out, deadline, cancelled):
    out.mkdir(mode=0o700, exist_ok=True)
    need(
        not cancelled and deadline - time.time() >= 100,
        "insufficient fresh ACK observation budget",
    )
    mid = proof["machine_id"]
    api = api_factory(out)
    with api.lease(mid):
        need(not cancelled and time.time() < deadline, "cancelled before ACK GET")
        current = api.request("GET", "/machines/" + mid, timeout=20)
        expected = proof.get("expected_native", proof.get("ack"))
        keys = (
            ("id", "config", "name", "created_at", "region")
            if proof.get("old_response_unknown")
            else ("id", "instance_id", "config", "name", "created_at", "region")
        )
        need(
            current["state"] in ("created", "stopped")
            and all(current.get(k) == expected.get(k) for k in keys),
            "fresh reserved native mismatch",
        )
        if proof.get("old_response_unknown"):
            need(
                isinstance(current.get("instance_id"), str)
                and current["instance_id"]
                and current["instance_id"] != proof["original_instance"],
                "pending config not positively observed",
            )
        R["save"](out / "observed.json", current)
    return dict(
        proof["candidate"],
        source_instance_id=current["instance_id"],
        source_config_sha256=H["config_sha"](current["config"]),
        prior_marker=canonical(proof["marker"]).decode(),
        reservation={
            "cohort": proof["marker"]["cohort"],
            "marker": proof["marker"],
            "instance_id": current["instance_id"],
            "config_sha256": H["config_sha"](current["config"]),
        },
    )


def reconcile(api_factory, value, journal, deadline):
    need(
        deadline == value["deadline"] and time.time() < deadline,
        "original deadline expired or changed",
    )
    root = Path(value["directory"])
    journal = Path(journal).absolute()
    need(
        journal.parent == root,
        "new reconciliation journal must be outside original reservation tree",
    )

    def unchanged():
        need(
            protocol(value.get("source_ref", SOURCE)) == value["protocol_hashes"]
            and C["history_membership"](root) == value["membership"],
            "original reservation evidence changed",
        )
        check_plan_inputs(value)
        need(
            not any(root.glob("launch-*"))
            and not (root / "config.private.json").exists()
            and not (root / "controller-launch.intent.json").exists(),
            "original admission launched",
        )

    unchanged()
    identity = sha(canonical(value))
    if journal.exists():
        receipt = json.loads(R["read"](journal / "complete.json"))
        need(
            receipt["identity_sha256"] == identity and not receipt["cancelled_signals"],
            "unknown or cancelled reconciliation",
        )
        raw = R["read"](journal / "request.json")
        need(
            sha(raw) == receipt["request_sha256"] and time.time() < deadline,
            "completed request changed/expired",
        )
        return json.loads(raw)
    journal.mkdir(mode=0o700)
    R["save"](
        journal / "intent.json",
        {
            "identity_sha256": identity,
            "original_deadline": deadline,
            "old_journal_immutable": True,
        },
    )
    carried = copy.deepcopy(value.get("retained_request", {}).get("candidates", []))
    cancelled, candidates, held, results = (
        [],
        carried,
        copy.deepcopy(value["held"]),
        [
            {
                "machine_id": row["machine_id"],
                "lane": "RETAINED",
                "old_failure_retained": True,
            }
            for row in carried
        ],
    )
    handlers = {
        sig: signal.signal(sig, lambda sig, _: cancelled.append(sig))
        for sig in (signal.SIGINT, signal.SIGTERM)
    }

    def process(entry):
        mid = entry["machine_id"]
        try:
            need(
                not cancelled and deadline - time.time() >= 100,
                "cancelled or insufficient original time",
            )
            out = journal / mid
            out.mkdir(mode=0o700)
            if entry["lane"] in ("ACK", "PENDING_READ"):
                row = observe_ack(api_factory, entry["proof"], out, deadline, cancelled)
            else:
                need(
                    not cancelled and deadline - time.time() >= 200,
                    "insufficient original new-CAS budget",
                )
                request = dict(value["request"], candidates=[entry["candidate"]])
                try:
                    observed = H["reserve_cohort"](
                        lambda location: api_factory(location),
                        request,
                        out / "new-reservation",
                    )
                    need(
                        len(observed["candidates"]) == 1,
                        "new reservation not verified",
                    )
                    row = observed["candidates"][0]
                except (Exception, R["Deadline"]) as error:
                    if not known_error(error):
                        raise
                    # Rescue only the positive ACK from this once-only NEW
                    # attempt; never dispatch its config update a second time.
                    recovered = classify(
                        out / "new-reservation" / mid,
                        entry["candidate"],
                        request,
                        {},
                    )
                    need(
                        recovered["lane"] == "ACK",
                        "new attempt lacks positive raw ACK",
                    )
                    proof = recovered["proof"]
                    row = observe_ack(
                        api_factory, proof, out / "ack-rescue", deadline, cancelled
                    )
            need(
                not cancelled and time.time() < deadline,
                "cancelled/expired after native owners joined",
            )
            candidates.append(row)
            results.append(
                {
                    "machine_id": mid,
                    "lane": entry["lane"],
                    "old_failure_retained": True,
                }
            )
        except (Exception, R["Deadline"]) as error:
            if not known_error(error):
                raise
            held.append(
                {
                    "machine_id": mid,
                    "not_credited": True,
                    "error_type": type(error).__name__,
                }
            )

    try:
        with ThreadPoolExecutor(max_workers=16) as executor:
            futures = [
                executor.submit(process, entry) for entry in value["classifications"]
            ]
            try:
                for future in futures:
                    future.result()
            except BaseException:
                for future in futures:
                    future.cancel()
                raise
        order = {
            row["machine_id"]: index
            for index, row in enumerate(value["request"]["candidates"])
        }
        candidates.sort(key=lambda row: order[row["machine_id"]])
        held.sort(key=lambda row: row["machine_id"])
        results.sort(key=lambda row: row["machine_id"])
        unchanged()
        if cancelled:
            R["save"](
                journal / "cancelled.json",
                {
                    "signals": cancelled,
                    "original_deadline": deadline,
                    "owners_joined": True,
                },
            )
            raise CancelledAdmission("cancelled after joining native ownership")
        need(candidates, "no newly verified reservations")
        result = dict(
            value["request"], candidates=candidates, held_native_reservations=held
        )
        H["validate_request"](result)
        R["save"](journal / "request.json", result)
        R["save"](
            journal / "complete.json",
            {
                "identity_sha256": identity,
                "request_sha256": sha(R["read"](journal / "request.json")),
                "cancelled_signals": cancelled,
                "original_deadline": deadline,
                "results": results,
                "held": held,
                "old_failures_retained": True,
                "task_credit": 0,
            },
        )
        if cancelled:
            raise CancelledAdmission("cancelled after joining native ownership")
        need(time.time() < deadline, "deadline expired before return")
        return result
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
