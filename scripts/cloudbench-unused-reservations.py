#!/usr/bin/env python3
"""Validate closed, unallocated archived reservations; never perform native effects."""

import base64
import copy
import hashlib
import json
from pathlib import Path
import re
import runpy
import tarfile

HERE = Path(__file__).resolve().parent
H = runpy.run_path(str(HERE / "cloudbench-archived-machine-reuse.py"))
CLOSED = runpy.run_path(str(HERE / "cloudbench-archived-owner-stop.py"))
need, canonical, config_sha = (H[key] for key in ("need", "canonical", "config_sha"))


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def read(path, inputs):
    path = Path(path).absolute()
    raw = CLOSED["raw"](path)
    inputs[str(path)] = digest(raw)
    return raw


def obj(path, inputs):
    return json.loads(read(path, inputs))


def closed_run(outer, inputs):
    launch = obj(outer / "controller-launch.intent.json", inputs)
    original_config = Path(launch["config_path"])
    output = Path(launch["run_directory"])
    need(
        original_config.name == "config.private.json" and output.parent == original_config.parent,
        "launch config/output binding differs",
    )
    need(re.fullmatch(r"launch-[0-9]+", original_config.parent.name), "invalid bound launch directory")
    local_config = outer / original_config.parent.name / original_config.name
    need(digest(read(local_config, inputs)) == launch["config_sha256"], "original config bytes changed")
    original_value = json.loads(read(local_config, inputs))
    local_output = outer / original_config.parent.name / output.name
    successor = local_output / "host-launch-successor.json"
    if successor.exists():
        pointer = obj(successor, inputs)
        need(pointer.get("schema") == "original600-host-launch-successor-v1", "foreign launch successor")
        evidence = pointer["evidence"]
        recorded_failure = Path(evidence["path"])
        if recorded_failure.is_absolute() and recorded_failure.is_relative_to(original_config.parent.parent):
            relative_failure = recorded_failure.relative_to(original_config.parent.parent)
            need(".." not in relative_failure.parts, "unsafe failure path")
            raw = read(outer / relative_failure, inputs)
        else:
            raw = read(outer / recorded_failure.name, inputs)
        need(
            digest(raw) == evidence["sha256"] and evidence["prior_output"] == str(output),
            "successor failure binding changed",
        )
        failure = json.loads(raw)
        legacy = failure.get("schema") == "observed-tool-session-join-v1"
        payload_refusal = (
            failure.get("schema") == "observed-host-prelaunch-refusal-v1"
            and failure.get("error") == "compressed launch payload too large for config transport"
            and failure.get("gate_created") is False
        )
        typed_refusal = (
            failure.get("schema") == "original600-host-payload-failure-v1"
            and failure.get("reason") == "compressed launch payload too large for config transport"
            and failure.get("gate_created") is False
            and failure.get("config_path") == str(original_config)
            and failure.get("config_sha256") == launch["config_sha256"]
            and failure.get("source_ref") == original_value["source_ref"]
            and recorded_failure == output / "launch-payload-failure.json"
        )
        need(
            typed_refusal or ((legacy or payload_refusal)
            and failure.get("tool_reported_exit_code") == 1 and (
                payload_refusal
                or (
                    failure.get("log_contains_synchronous_popen_errno") == 7
                    and failure.get("gate_pid") == "NOT_CREATED_BY_FAILED_POPEN"
                )
            )),
            "unproven pre-exec successor",
        )
        prefix = "run-after-popen-" if legacy else "run-after-prelaunch-"
        expected = output.parent / (prefix + digest(raw)[:16])
        need(evidence["successor_output"] == str(expected), "unexpected successor output")
        # Follow the recorded canonical path, preserving its layout when reading
        # an offline copy of the admission. No ad-hoc alias is an input contract.
        recorded_config = Path(pointer["config_path"])
        need(recorded_config.is_absolute() and ".." not in recorded_config.parts, "invalid successor config path")
        relative = recorded_config.relative_to(original_config.parent.parent)
        need(
            len(relative.parts) == 2
            and re.fullmatch(r"bound-continuation-[0-9]+", relative.parts[0])
            and relative.name == "config.private.json",
            "unexpected successor config layout",
        )
        derived_raw = read(outer / relative, inputs)
        derived = json.loads(derived_raw)
        need(digest(derived_raw) == pointer["config_sha256"], "successor config checksum differs")
        provenance = derived["host_operator_provenance"]
        need(
            provenance["original_config_path"] == str(original_config)
            and provenance["original_config_sha256"] == launch["config_sha256"]
            and provenance["original_launch_intent_sha256"]
            == inputs[str((outer / "controller-launch.intent.json").absolute())]
            and provenance["prelaunch_failure"] == evidence,
            "successor provenance differs",
        )
        local_output = outer / original_config.parent.name / expected.name
        need(
            obj(local_output / "host-operator-provenance.json", inputs) == provenance,
            "closed successor provenance differs",
        )
    return local_output, json.loads(read(local_config, inputs))


def archive_members(run, closure, request, config, inputs):
    """The full verified archive is the closed world for allocation absence."""
    manifest = obj(run / "export/manifest.json", inputs)
    need(not manifest.get("excluded"), "archive exclusions cannot prove claim absence")
    imported = "git-common/cloudbench-archived-reuse-" + request["cohort"] + ".json"
    seen, claimed, imported_raw = set(), set(), None
    with tarfile.open(run / "export/originals.tar.gz", "r:gz") as archive:
        for member in archive:
            name = member.name
            need(
                name not in seen and not name.startswith("/") and ".." not in Path(name).parts,
                "unsafe archive membership",
            )
            seen.add(name)
            expected = manifest["files"].get(name)
            need(expected is not None, "archive member absent from complete manifest")
            # Any alias under task/claim roots makes a missing record ambiguous.
            if name == "context" or name.startswith(
                (
                    "context/fleet/",
                    "git-common/cloudbench-fleet-ownership",
                    "git-common/cloudbench-fleet-audit",
                    "git-common/cloudbench-archived-reuse",
                    "git-common/cloudbench-native-effect-fences",
                )
            ):
                need(not member.issym() and not member.islnk(), "claim namespace contains an alias")
            if name.startswith("git-common/cloudbench-native-effect-fences/"):
                claimed.update(part for part in Path(name).parts if re.fullmatch("[0-9a-f]{14}", part))
            current_claim = name.startswith("git-common/cloudbench-archived-reuse/current/")
            if current_claim and re.fullmatch("[0-9a-f]{14}", Path(name).stem):
                claimed.add(Path(name).stem)
            sensitive = (
                current_claim
                or name == imported
                or "/archived-reuse/" in name
                or "/archived-reuse-journal/" in name
                or name.endswith(("/.cid", "/archived-reuse-proof.json", "/archived-successor.json"))
            )
            if not sensitive or member.isdir():
                continue
            need(
                member.isfile()
                and member.size <= 16 * 1024 * 1024
                and expected.get("kind") == "file"
                and expected.get("bytes") == member.size,
                "unsafe claim record",
            )
            raw = archive.extractfile(member).read(16 * 1024 * 1024 + 1)
            need(digest(raw) == expected["sha256"], "archived claim bytes differ")
            if name == imported:
                imported_raw = raw
                continue
            if name.endswith("/.cid"):
                fields = raw.decode().split()
                need(len(fields) == 2, "malformed allocation identity")
                claimed.add(fields[1])
            else:
                value = json.loads(raw)
                for entry in (
                    value,
                    value.get("proof", {}),
                    value.get("predecessor", {}),
                    value.get("native_marker", {}),
                ):
                    if isinstance(entry, dict) and entry.get("machine_id"):
                        claimed.add(entry["machine_id"])
                # A journal carries its candidate in archived-successor's bound campaign index.
                if name.endswith("/archived-successor.json"):
                    index = H["campaign_candidate_index"](request, value)
                    if index < len(request["candidates"]):
                        claimed.add(request["candidates"][index]["machine_id"])
    need(seen == set(manifest["files"]), "incomplete closed-world archive")
    need(
        imported_raw is not None and json.loads(imported_raw) == request,
        "closed controller imported another reservation request",
    )
    expected_file = [row for row in config["remote_files"] if row["relative_path"] == ".git/" + Path(imported).name]
    need(
        len(expected_file) == 1
        and expected_file[0]["sha256"] == digest(imported_raw)
        and config["remote_env"]["CLOUDBENCH_ARCHIVED_REUSE_REQUEST_SHA256"] == digest(imported_raw),
        "controller reservation input hash differs",
    )
    return claimed, digest(imported_raw)


def wire_records(directory, mid, inputs):
    records = []
    wire = directory / "wire"
    need(wire.is_dir() and not wire.is_symlink(), "complete original native wire evidence required")
    for folder in sorted(wire.iterdir()):
        need(folder.is_dir() and not folder.is_symlink(), "unsafe native wire directory")
        request = obj(folder / "request.json", inputs)
        need(request["app"] == H["APP"], "native wire app differs")
        raw_records = sorted(folder.glob("*-wire.json"))
        need(len(raw_records) == 1, "missing or ambiguous native response")
        record = obj(raw_records[0], inputs)
        raw = base64.b64decode(record["body_b64"], validate=True)
        need(
            digest(raw) == record["sha256"]
            and record["method"] == request["method"]
            and record["path"] == request["path"]
            and type(record["monotonic_ns"]) is int,
            "native raw response identity differs",
        )
        need(
            request["path"] == "/machines/" + mid or request["path"].startswith("/machines/" + mid + "/"),
            "foreign native wire path",
        )
        successful = 200 <= record["status"] < 300
        response = (json.loads(raw) if raw.strip() else {}) if successful else None
        if (folder / "result.json").exists():
            need(obj(folder / "result.json", inputs) == response, "native decoded response differs")
        records.append((record["monotonic_ns"], request, response, record["status"]))
    return sorted(records, key=lambda row: row[0])


def validate_candidate(outer, original, reserved, current, cohort, harness_ref, inputs):
    mid = original["machine_id"]
    need(reserved["machine_id"] == current["id"] == mid, "reservation Machine differs")
    need(
        original["predecessor"]["id"] == mid
        and original["predecessor"]["volume_id"] == original["volume_id"]
        and original["predecessor"]["name"] == original["name"],
        "original archived row ownership differs",
    )
    H["same_source"](reserved, current)
    directory = outer / "archived-reuse-reservations" / mid
    original_native = obj(directory / "original-native.json", inputs)
    H["same_source"](original, original_native)
    intent = obj(directory / "intent.json", inputs)
    dispatch = obj(directory / "dispatch-entered.json", inputs)
    need(dispatch["intent_sha256"] == digest(canonical(intent)), "native dispatch intent differs")
    marker = reserved["reservation"]["marker"]
    need(
        marker
        == dict(
            schema=H["SCHEMA"],
            state="RESERVED",
            cohort=cohort,
            machine_id=mid,
            volume_id=original["volume_id"],
            source_excluded=True,
            archive_sha256=original["archive_sha256"],
            harness_ref=harness_ref,
        ),
        "foreign reservation marker",
    )
    need(
        obj(directory / "source-exclusion.json", inputs) == dict(predecessor=original, marker=marker),
        "predecessor exclusion differs",
    )
    need(obj(directory / "reserved.json", inputs) == reserved, "closed reserved row differs")
    need(
        intent["current_version"] == original["source_instance_id"]
        and intent["config_sha256"] == reserved["source_config_sha256"],
        "reservation native intent differs",
    )
    need(
        current["config"].get("metadata", {}).get(H["MARKER"]) == canonical(marker).decode(),
        "native reservation marker differs",
    )
    records = wire_records(directory, mid, inputs)
    posts = [
        (at, req, ack, status)
        for at, req, ack, status in records
        if req["method"] == "POST" and req["path"] == "/machines/" + mid
    ]
    need(len(posts) == 1, "missing or repeated reservation native update")
    at, request, ack, status = posts[0]
    need(200 <= status < 300 and isinstance(ack, dict), "native update ACK unsuccessful or unknown")
    nonce = request.get("headers", {}).get("fly-machine-lease-nonce")
    need(
        any(
            time < at
            and req["method"] == "POST"
            and req["path"] == "/machines/" + mid + "/lease"
            and 200 <= status < 300
            and isinstance(value, dict)
            and value.get("data", {}).get("nonce") == nonce
            for time, req, value, status in records
        ),
        "native update lease was not acknowledged",
    )
    need(
        any(
            time > at
            and req["method"] == "DELETE"
            and req["path"] == "/machines/" + mid + "/lease"
            and 200 <= status < 300
            and req.get("headers", {}).get("fly-machine-lease-nonce") == nonce
            for time, req, value, status in records
        ),
        "native reservation lease retirement unverified",
    )
    need(
        any(
            time < at
            and req["method"] == "GET"
            and req["path"] == "/machines/" + mid
            and 200 <= status < 300
            and isinstance(value, dict)
            and value.get("id") == mid
            and value.get("instance_id") == original["source_instance_id"]
            and config_sha(value.get("config", {})) == original["source_config_sha256"]
            for time, req, value, status in records
        ),
        "original native version lacks raw pre-update read",
    )
    body = request["body"]
    need(
        body["current_version"] == original["source_instance_id"]
        and body["skip_launch"] is True
        and config_sha(body["config"]) == intent["config_sha256"]
        and request.get("headers", {}).get("fly-machine-lease-nonce"),
        "unleased or foreign native update",
    )
    need(
        ack["id"] == mid
        and ack["instance_id"] == reserved["source_instance_id"]
        and ack["instance_id"] != original["source_instance_id"]
        and config_sha(ack["config"]) == intent["config_sha256"],
        "reservation native ACK differs",
    )
    need(
        any(
            time > at
            and req["method"] == "GET"
            and req["path"] == "/machines/" + mid
            and 200 <= status < 300
            and isinstance(value, dict)
            and value.get("id") == mid
            and value.get("instance_id") == ack["instance_id"]
            and value.get("state") in ("created", "stopped")
            and config_sha(value.get("config", {})) == intent["config_sha256"]
            for time, req, value, status in records
        ),
        "no exact post-ACK inactive readback",
    )
    return copy.deepcopy(reserved)


def prepare(run, inventory_path):
    """Return only positively unused reserved IDs from one explicit outer state dir."""
    outer = Path(run).absolute()
    need(outer.resolve(strict=True) == outer and outer.is_dir(), "physical admission directory required")
    inputs = {}
    request = obj(outer / "archived-reuse-request.private.json", inputs)
    H["validate_request"](request)
    original_envelope = obj(outer / "archived-reuse-original.private.json", inputs)
    original = original_envelope["request"]
    need(
        original_envelope["schema"] == "original600-archived-admission-request-v1"
        and original_envelope["sha256"] == digest(json.dumps(original, sort_keys=True, allow_nan=False).encode()),
        "original admission request checksum differs",
    )
    H["validate_request"](original)
    need(
        all(request[key] == value for key, value in original.items() if key != "candidates"),
        "reservation request source differs",
    )
    initial = {row["machine_id"]: row for row in original["candidates"]}
    closed, config = closed_run(outer, inputs)
    closure = CLOSED["prepare"](closed, inventory_path)
    inputs.update(closure["inputs"])
    need(
        closure["source_ref"] == request["harness_ref"] == config["source_ref"],
        "closed controller source differs from admission",
    )
    claimed, imported_sha = archive_members(closed, closure, request, config, inputs)
    machines = {row["id"]: row for row in json.loads(CLOSED["raw"](inventory_path, 256 * 1024 * 1024))}
    need(len(machines) == len(json.loads(CLOSED["raw"](inventory_path, 256 * 1024 * 1024))), "duplicate inventory")
    need(closure["controller"] not in machines, "closed controller still present in native inventory")
    candidates = []
    for row in request["candidates"]:
        mid = row["machine_id"]
        need(mid in initial and mid not in claimed, "reservation was allocated or has unresolved claim intent")
        need(
            mid not in closure["protected_machines"] and row["volume_id"] not in closure["protected_volumes"],
            "protected reservation",
        )
        before = initial[mid]
        need(
            all(
                row.get(key) == value
                for key, value in before.items()
                if key not in ("source_instance_id", "source_config_sha256", "prior_marker")
            ),
            "reservation lineage changed",
        )
        need(mid in machines, "reserved Machine missing from native inventory")
        candidate = validate_candidate(
            outer, before, row, machines[mid], request["cohort"], request["harness_ref"], inputs
        )
        candidate.pop("reservation")
        candidate.setdefault("legacy_archive_sha256", candidate["archive_sha256"])
        candidate["archive_sha256"] = closure["inputs"][str((closed / "export/originals.tar.gz").absolute())]
        candidate["unused_reservation_proof"] = dict(
            controller=closure["controller"],
            old_cohort=request["cohort"],
            imported_request_sha256=imported_sha,
            original_request_sha256=original_envelope["sha256"],
        )
        candidates.append(candidate)
    return dict(
        candidates=candidates,
        archive=dict(
            controller=closure["controller"],
            archive_sha256=closure["inputs"][str((closed / "export/originals.tar.gz").absolute())],
            inputs=inputs,
        ),
    )
