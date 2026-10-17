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
from pathlib import Path

HERE = Path(__file__).resolve().parent
C = runpy.run_path(str(HERE / "cloudbench-reconcile-reservations.py"))
H, R = C["H"], C["R"]
need, sha, canonical = (H[k] for k in ("need", "sha", "canonical"))
SOURCE = "724ae71f5bd8756be01ea237de0c2742e4f94b77"


class CancelledAdmission(BaseException):
    """Cancellation after native owners joined cannot authorize launch."""


def protocol():
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
        raw = subprocess.check_output(
            [
                "git",
                "--no-replace-objects",
                "-C",
                str(HERE.parent),
                "show",
                SOURCE + ":scripts/" + name,
            ]
        )

        def functions(data, selected=selected):
            return {
                node.name: ast.dump(node, include_attributes=False)
                for node in ast.walk(ast.parse(data))
                if isinstance(node, ast.FunctionDef)
                and node.name in selected
                and node.col_offset <= 4
            }

        need(
            functions(raw) == functions((HERE / name).read_bytes()),
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


def plan(directory, failure_path):
    root = Path(directory).absolute()
    need(root.resolve(strict=True) == root, "physical admission required")
    inputs = {}
    admission = C["obj"](root / "admission-intent.private.json", inputs)
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
            protocol() == value["protocol_hashes"]
            and C["history_membership"](root) == value["membership"],
            "original reservation evidence changed",
        )
        C["check_inputs"](value)
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
    cancelled, candidates, held, results = [], [], copy.deepcopy(value["held"]), []
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
