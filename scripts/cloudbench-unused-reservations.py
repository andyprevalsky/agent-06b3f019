#!/usr/bin/env python3
"""Validate closed, unallocated archived reservations; never perform native effects."""

import base64
import copy
from functools import cache
import hashlib
import json
from pathlib import Path
import re
import stat
import runpy
import tarfile
import time

HERE = Path(__file__).resolve().parent
H = runpy.run_path(str(HERE / "cloudbench-archived-machine-reuse.py"))
CLOSED = runpy.run_path(str(HERE / "cloudbench-archived-owner-stop.py"))
need, canonical, config_sha = (H[key] for key in ("need", "canonical", "config_sha"))


@cache
def recovered_reader():
    return runpy.run_path(str(HERE / "cloudbench-recovered-reservations.py"))


@cache
def transition_reader():
    return runpy.run_path(str(HERE / "cloudbench-closed-transition-reservations.py"))


def request_for_closed(outer, closed, config, closure, inputs):
    provenance = config.get("host_operator_provenance", {})
    need(isinstance(provenance, dict), "invalid closed host provenance")
    failure = provenance.get("prelaunch_failure")
    workspace_successor = (
        isinstance(failure, dict) and failure.get("stage") == "CANONICAL_WORKSPACE_RELEASED_AFTER_UNKNOWN_CREATE"
    )
    if "incomplete_admission" in provenance or workspace_successor:
        context = recovered_reader()["load"](outer, closed, config, closure, inputs)
        return context["request"], context
    return obj(outer / "archived-reuse-request.private.json", inputs), None


def validate_reserved(outer, original, reserved, current, cohort, harness_ref, inputs, context=None):
    if context is not None:
        return recovered_reader()["validate"](context, original, reserved, current, inputs)
    return validate_candidate(outer, original, reserved, current, cohort, harness_ref, inputs)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def read(path, inputs):
    path = Path(path).absolute()
    raw = CLOSED["raw"](path)
    inputs[str(path)] = digest(raw)
    return raw


def obj(path, inputs):
    return json.loads(read(path, inputs))


def archive_manifest(run, inputs):
    path = Path(run).absolute() / "export/manifest.json"
    raw = CLOSED["manifest_bytes"](path)
    inputs[str(path)] = digest(raw)
    return json.loads(raw)


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
    need(
        digest(read(local_config, inputs)) == launch["config_sha256"],
        "original config bytes changed",
    )
    original_value = json.loads(read(local_config, inputs))
    local_output = outer / original_config.parent.name / output.name
    successor = local_output / "host-launch-successor.json"
    if successor.exists():
        pointer = obj(successor, inputs)
        need(
            pointer.get("schema") == "original600-host-launch-successor-v1",
            "foreign launch successor",
        )
        evidence = pointer["evidence"]
        if evidence.get("stage") == "CANONICAL_WORKSPACE_RELEASED_AFTER_UNKNOWN_CREATE":
            # This is the exact closed-workspace chain, not a pre-exec refusal.
            # Its existing reader binds old history and new immutable producer.
            # Full current controller closure is still required by prepare().
            current_path = Path(pointer["config_path"])
            need(
                original_config == local_config
                and current_path.parent.parent == outer
                and re.fullmatch(r"bound-continuation-[0-9]+", current_path.parent.name)
                and current_path.name == "config.private.json",
                "invalid workspace successor config layout",
            )
            current = obj(current_path, inputs)
            current_output = Path(evidence["successor_output"])
            recovered_reader()["recovered_launch"](outer, current_output, current, inputs)
            need(
                obj(current_output / "host-operator-provenance.json", inputs) == current["host_operator_provenance"],
                "closed workspace successor provenance differs",
            )
            return current_output, current
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
            typed_refusal
            or (
                (legacy or payload_refusal)
                and failure.get("tool_reported_exit_code") == 1
                and (
                    payload_refusal
                    or (
                        failure.get("log_contains_synchronous_popen_errno") == 7
                        and failure.get("gate_pid") == "NOT_CREATED_BY_FAILED_POPEN"
                    )
                )
            ),
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


# Reviewed inventory publishers with an identical generation layout; the second
# only extracts the startup-init predicates into shared helpers (identical for
# well-formed Fly machine configs).
INVENTORY_PRODUCER_SHA256S = frozenset(
    {
        "f8c22753a9498de5cd9e6c01f672556f8ee3caf6ea13415dd49b73bac8b03163",
        "5843e509a64380711147b140c346e81622a2f904b300d3af5a247415f5488797",
    }
)


def inventory_pointer_members(manifest, config):
    """Recognize a cache publication pointer, never resolve it as claim data."""
    files = manifest["files"]
    pointers, generations = {}, set()
    for name, entry in files.items():
        if (
            not re.fullmatch(r"context/fleet/runs/[0-9]{8}-[0-9]{6}-[0-9]+/inventory/current", name)
            or entry.get("kind") != "symlink"
        ):
            continue
        target = entry.get("target")
        need(
            isinstance(target, str) and re.fullmatch(r"[.]generation-[A-Za-z0-9._-]+", target),
            "unsafe inventory generation pointer",
        )
        parent = str(Path(name).parent)
        generation = parent + "/" + target
        need(
            files.get(parent) == {"kind": "directory"} and files.get(generation) == {"kind": "directory"},
            "inventory pointer target is not a physical directory",
        )
        source = files.get("source/scripts/cloudbench-machine-readiness.py", {})
        need(
            source.get("kind") == "file"
            and source.get("sha256") in INVENTORY_PRODUCER_SHA256S
            and config.get("source_files", {}).get("cloudbench-machine-readiness.py") == source["sha256"],
            "unknown inventory pointer producer",
        )
        required = {
            generation: "directory",
            generation + "/machines": "directory",
            generation + "/names": "directory",
            generation + "/health": "file",
            generation + "/published_at": "file",
            generation + "/admission-machines.json": "file",
        }
        need(
            all(files.get(path, {}).get("kind") == kind for path, kind in required.items()),
            "incomplete inventory generation",
        )
        for path, value in files.items():
            if not path.startswith(generation + "/"):
                continue
            relative = path[len(generation) + 1 :]
            canonical_entry = (
                relative in ("machines", "names")
                and value.get("kind") == "directory"
                or relative in ("health", "published_at", "admission-machines.json")
                and value.get("kind") == "file"
                or re.fullmatch(r"(?:machines|names)/[A-Za-z0-9._-]+", relative)
                and Path(relative).name not in (".", "..")
                and value.get("kind") == "file"
            )
            need(canonical_entry, "foreign or aliased inventory generation member")
        pointers[name] = target
        generations.add(generation)
    return pointers, generations


# Reviewed collectors whose cleanup-reserve exclusion semantics are identical; the
# second only adds pre-snapshot flushing and bounded strict snapshot repetition, the
# third drains exiting writers (all threads) within a bounded window first, the
# fourth re-observes a transiently unreadable /proc entry before failing closed.
RESERVE_COLLECTOR_SHA256S = frozenset(
    {
        "ff7681d3eefde5df2c678cb0f900b66cb2427cf39180c0ed9a5c28e7dd721c1b",
        "8a004d2f194f90229fd4e96306866c3c91502d434b3b535e2f44eddaee3daf19",
        "87b52cfc31b70d582ed274e184c0b7a6b50267639e2019e21a1e8ead251a55ff",
        "316d28e6d86d8504d430b480774a8311ef788aded48f1ff63a8f3bac7157d08b",
        "4aaed3144c60053fe0c782647258d0e2b33b8c81771b83e1968773b97cccc08a",
    }
)


def excluded_cleanup_reserves(manifest, config):
    excluded = manifest.get("excluded", {})
    need(isinstance(excluded, dict), "invalid archive exclusions")
    if not excluded:
        return {}
    record, files = manifest["record"], manifest["files"]
    common = record.get("common_git")
    need(
        isinstance(common, str) and Path(common).is_absolute() and ".." not in Path(common).parts,
        "invalid reserve source root",
    )
    anchor = record.get("root_anchors", {}).get(common, {})
    source = files.get("source/scripts/cloudbench-controller-export.py", {})
    need(
        record.get("collector_sha256") in RESERVE_COLLECTOR_SHA256S
        and config.get("source_files", {}).get("cloudbench-controller-export.py") == record["collector_sha256"]
        and source.get("kind") == "file"
        and source.get("sha256") == record["collector_sha256"],
        "unknown cleanup reserve collector",
    )
    for name, value in excluded.items():
        need(
            re.fullmatch(r"git-common/cloudbench-fleet-ownership/[0-9a-f]{32}/cleanup-disk-reserve", name)
            and set(value) == {"source_path", "stat", "reason"}
            and value["reason"] == "physical cleanup reserve; payload never read"
            and value["source_path"] == str(Path(common).joinpath(*Path(name).parts[1:]))
            and name not in files,
            "foreign archive exclusion",
        )
        metadata = value["stat"]
        need(
            isinstance(metadata, dict)
            and set(metadata)
            == {"allocated_bytes", "bytes", "device", "gid", "inode", "mode", "mtime_ns", "nlink", "uid"}
            and all(type(v) is int and v >= 0 for v in metadata.values())
            and metadata["inode"] > 0
            and stat.S_ISREG(metadata["mode"])
            and not metadata["mode"] & 0o077
            and metadata["nlink"] == 1
            and metadata["uid"] == anchor.get("uid"),
            "unsafe cleanup reserve metadata",
        )
        need(
            all(
                files.get(str(parent)) == {"kind": "directory"}
                for parent in Path(name).parents
                if str(parent) not in (".", "git-common")
            ),
            "cleanup reserve parent is not physical",
        )
    return excluded


def archive_members(run, closure, request, config, inputs):
    """The full verified archive is the closed world for allocation absence."""
    manifest = archive_manifest(run, inputs)
    reserve_exclusions = excluded_cleanup_reserves(manifest, config)
    imported = "git-common/cloudbench-archived-reuse-" + request["cohort"] + ".json"
    inventory_pointers, inventory_generations = inventory_pointer_members(manifest, config)
    inventory_parents = {str(Path(name).parent) for name in inventory_pointers}
    seen, claimed, imported_raw = set(), {}, None

    def hold(mid, name, expected):
        need(
            isinstance(mid, str) and re.fullmatch("[0-9a-f]{14}", mid),
            "invalid archived claim Machine",
        )
        claimed.setdefault(mid, {})[name] = {"path": name, **expected}

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
            if name in inventory_pointers:
                need(
                    member.issym()
                    and not member.islnk()
                    and member.size == 0
                    and member.linkname == inventory_pointers[name]
                    and expected == dict(kind="symlink", target=member.linkname),
                    "inventory pointer differs from manifest",
                )
                continue  # Do not dereference/extract/cache-credit this pointer.
            inventory_member = name in inventory_parents or any(
                name == root or name.startswith(root + "/") for root in inventory_generations
            )
            producer_member = (
                bool(inventory_pointers) and name == "source/scripts/cloudbench-machine-readiness.py"
            ) or (bool(reserve_exclusions) and name == "source/scripts/cloudbench-controller-export.py")
            if inventory_member or producer_member:
                if expected.get("kind") == "directory":
                    need(member.isdir(), "inventory directory is not physical")
                else:
                    need(
                        member.isfile() and expected.get("kind") == "file" and member.size == expected["bytes"],
                        "inventory member is not a physical file",
                    )
                    stream = archive.extractfile(member)
                    digest_value = hashlib.sha256()
                    total = 0
                    while block := stream.read(1024 * 1024):
                        total += len(block)
                        digest_value.update(block)
                    need(
                        total == member.size and digest_value.hexdigest() == expected["sha256"],
                        "inventory member bytes differ",
                    )
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
                need(
                    not member.issym() and not member.islnk(),
                    "claim namespace contains an alias",
                )
            if name.startswith("git-common/cloudbench-native-effect-fences/"):
                for part in Path(name).parts:
                    if re.fullmatch("[0-9a-f]{14}", part):
                        hold(part, name, expected)
            current_claim = name.startswith("git-common/cloudbench-archived-reuse/current/")
            if current_claim and re.fullmatch("[0-9a-f]{14}", Path(name).stem):
                hold(Path(name).stem, name, expected)
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
                hold(fields[1], name, expected)
            else:
                value = json.loads(raw)
                for entry in (
                    value,
                    value.get("proof", {}),
                    value.get("predecessor", {}),
                    value.get("native_marker", {}),
                ):
                    if isinstance(entry, dict) and entry.get("machine_id"):
                        hold(entry["machine_id"], name, expected)
                # A journal carries its candidate in archived-successor's bound campaign index.
                if name.endswith("/archived-successor.json"):
                    index = H["campaign_candidate_index"](request, value)
                    if index < len(request["candidates"]):
                        hold(request["candidates"][index]["machine_id"], name, expected)
    need(seen == set(manifest["files"]), "incomplete closed-world archive")
    if inventory_pointers:
        closure["inventory_pointer_proof"] = dict(
            schema="cloudbench-archived-inventory-pointer-v1",
            pointers=inventory_pointers,
            producer_sha256=manifest["files"]["source/scripts/cloudbench-machine-readiness.py"]["sha256"],
            followed=False,
            capacity_credit=0,
            claim_credit=0,
        )
    if reserve_exclusions:
        closure["cleanup_reserve_exclusions"] = dict(
            schema="canonical-cleanup-reserve-exclusions-v1",
            excluded=reserve_exclusions,
            collector_sha256=manifest["record"]["collector_sha256"],
            payload_read=False,
            capacity_credit=0,
            claim_credit=0,
        )
    custody = "ARCHIVED_IMPORT"
    expected_file = [row for row in config["remote_files"] if row["relative_path"] == ".git/" + Path(imported).name]
    if imported_raw is None:
        startup = closure.get("startup_closure", {})
        need(
            startup.get("schema") == "expired-before-supervisor-proof-v1"
            and startup.get("supervisor_published") is False
            and startup.get("supervisor_joined") is False
            and startup.get("owned_job_authority") is False
            and not closure["archived_ownership"]
            and not closure["targets"]
            and not claimed,
            "closed controller imported another reservation request",
        )
        outer = run.parent.parent
        launch = obj(outer / "controller-launch.intent.json", inputs)
        recorded_config = Path(launch["config_path"])
        need(
            recorded_config.parent.name == run.parent.name
            and recorded_config.name == "config.private.json"
            and len(expected_file) == 1
            and expected_file[0]["source_path"] == str(recorded_config.parent / "archived-reuse-request.private.json")
            and config["remote_env"]["CLOUDBENCH_ARCHIVED_REUSE_REQUEST"]
            == "/tmp/gate/repo/" + expected_file[0]["relative_path"],
            "startup host reservation path differs",
        )
        imported_raw = read(run.parent / "archived-reuse-request.private.json", inputs)
        need(
            imported_raw == read(outer / "archived-reuse-request.private.json", inputs),
            "startup host reservation copies differ",
        )
        custody = "HOST_BOUND_NOT_IMPORTED"
    need(
        json.loads(imported_raw) == request,
        "closed controller imported another reservation request",
    )
    need(
        len(expected_file) == 1
        and expected_file[0]["sha256"] == digest(imported_raw)
        and config["remote_env"]["CLOUDBENCH_ARCHIVED_REUSE_REQUEST_SHA256"] == digest(imported_raw),
        "controller reservation input hash differs",
    )
    return claimed, digest(imported_raw), custody


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


def normal_hold_partition(outer, original, request, inputs):
    """Retain failed normal-admission rows as liabilities, never as candidates."""
    initial = {row["machine_id"]: row for row in original["candidates"]}
    selected = {row["machine_id"] for row in request["candidates"]}
    failed = request.get("held_native_reservations", [])
    ids = [row["machine_id"] for row in failed]
    need(
        len(ids) == len(set(ids)) and not selected.intersection(ids) and set(initial) == selected | set(ids),
        "normal reservation held partition differs",
    )
    held = []
    for row in failed:
        mid = row["machine_id"]
        need(
            set(row) == {"machine_id", "not_credited", "error_type", "error"}
            and row["not_credited"] is True
            and isinstance(row["error_type"], str)
            and isinstance(row["error"], str),
            "normal reservation hold evidence differs",
        )
        directory = outer / "archived-reuse-reservations" / mid
        need(
            directory.is_dir() and directory.resolve(strict=True) == directory,
            "normal held journal missing or aliased",
        )
        for path in sorted(directory.rglob("*")):
            need(
                path.resolve(strict=True) == path and not path.is_symlink(),
                "normal held journal alias",
            )
            if not path.is_dir():
                read(path, inputs)
        held.append(
            dict(
                copy.deepcopy(row),
                volume_id=initial[mid]["volume_id"],
                capacity_credit=0,
                reuse_credit=False,
            )
        )
    inherited = copy.deepcopy(original.get("held_prior_reservations", []))
    seen = set()
    for scope in inherited:
        ids = scope["machine_ids"]
        need(
            isinstance(scope["archive_sha256"], str)
            and re.fullmatch("[0-9a-f]{64}", scope["archive_sha256"])
            and scope["archive_sha256"] not in seen
            and scope.get("reuse_credit") is False
            and len(ids) == len(set(ids))
            and all(isinstance(mid, str) and re.fullmatch("[0-9a-f]{14}", mid) for mid in ids),
            "invalid inherited normal hold scope",
        )
        seen.add(scope["archive_sha256"])
    return held, inherited


def released_workspace_request(outer, closed, config, inputs):
    """A closed unstarted admission has no controller archive to invent."""
    reader = recovered_reader()
    need(
        config["source_ref"] == reader["I"]["CLOSED75_SOURCE"],
        "unknown unstarted workload",
    )
    config_path, original = reader["recovered_launch"](outer, closed, config, inputs)
    need(
        original == config and closed == config_path.parent / "run",
        "unstarted successor not supported",
    )
    reader["closed_host"](
        config["host_operator_provenance"]["host_operator_source_ref"],
        workload=config["source_ref"],
    )
    terminal = obj(closed / "terminal.json", inputs)
    release = obj(closed / "export/disposable-controller.release.json", inputs)
    authority = obj(closed / "authority.private.json", inputs)
    caller = obj(closed / "caller.json", inputs)
    workspace = obj(closed / "export/workspace-volume.ownership.json", inputs)
    native_create = obj(closed / "export/workspace-volume-create.private.json", inputs)
    volume_intent = obj(closed / "export/workspace-volume.intent.json", inputs)
    gate_caller = obj(closed / "export/caller.json", inputs)
    epoch = config["started_at_epoch"]
    authority_sha = inputs[str(closed / "authority.private.json")]
    need(
        terminal
        == dict(
            status="FAILED_STARTUP_WORKSPACE_RELEASED",
            machine=None,
            gate_exit_code=1,
            controller_cleanup_exit_code=1,
            externally_reconciled_after_helper_failure=True,
            release=release,
            source_ref=config["source_ref"],
            started_at_epoch=epoch,
            original_deadline=epoch + 5400,
            benchmark_success_inferred=False,
        ),
        "canonical released unstarted terminal required",
    )
    need(
        release
        == dict(
            machine_id=None,
            volume_id=workspace["volume_id"],
            volume_disposition=release["volume_disposition"],
            no_live_machine_observed=True,
            command_history_verified=False,
        )
        and release["volume_disposition"] in ("ABSENT", "pending_destroy", "destroyed"),
        "unstarted release differs",
    )
    need(
        authority["source_ref"] == caller["source_ref"] == workspace["source_ref"] == config["source_ref"]
        and caller["authority_sha256"] == authority_sha
        and caller["epoch"] == epoch
        and caller["deadline"] == epoch + 5400
        and authority["output_directory"] == str(closed / "export")
        and (authority["cleanup_owner_pid"], authority["cleanup_owner_birth"]) == (caller["pid"], caller["birth"])
        and (gate_caller["pid"], gate_caller["birth"]) == (caller["gate_pid"], caller["gate_birth"])
        and workspace["volume_id"] not in authority["protected_volumes"],
        "unstarted authority/caller differs",
    )
    need(
        workspace["schema"] == "cloudbench-controller-workspace-ownership-v1"
        and workspace["app"] == authority["app"] == "navi-whisper-lux-bench"
        and workspace["size_gb"] == 256
        and workspace["mount_path"] == "/tmp/gate"
        and workspace["native_create"] == native_create
        and workspace["native_create_sha256"] == inputs[str(closed / "export/workspace-volume-create.private.json")]
        and workspace["intent_sha256"] == inputs[str(closed / "export/workspace-volume.intent.json")]
        and workspace["caller"] == volume_intent["caller"] == gate_caller
        and workspace["caller_sha256"] == volume_intent["caller_sha256"] == inputs[str(closed / "export/caller.json")]
        and all(
            native_create.get(key) == value
            for key, value in dict(
                id=workspace["volume_id"],
                name=workspace["name"],
                region=authority["region"],
                size_gb=256,
                encrypted=True,
                state="created",
                attached_machine_id=None,
            ).items()
        ),
        "unstarted workspace allocation differs",
    )
    need(
        obj(closed / "export/disposable-delete-volume.intent.json", inputs)
        == dict(
            authority_sha256=authority_sha,
            kind="volume",
            identifier=workspace["volume_id"],
        )
        and obj(closed / "cleanup-call.intent.json", inputs)
        == dict(
            action="cleanup-workspace",
            machine=None,
            gate_joined=True,
            supervisor_joined=False,
            export_verified_file=None,
        ),
        "unstarted cleanup differs",
    )
    provenance = obj(closed / "host-operator-provenance.json", inputs)
    need(
        provenance == config["host_operator_provenance"],
        "unstarted host provenance differs",
    )
    log = read(closed / "gate.private.log", inputs)
    need(
        b"in backup_off" in log
        and b"native.get(key)" in log
        and b"AttributeError: 'NoneType' object has no attribute 'get'" in log
        and b"GATE_WORKSPACE_VOLUME_RETAINED id=" + workspace["volume_id"].encode() in log,
        "known pre-Machine backup failure required",
    )
    closure = obj(closed / "observed-closure.safe.json", inputs)
    need(
        closure["schema"] == "original600-observed-closed-v1"
        and closure["run_directory"] == str(closed)
        and closure["original_tool_exit_code"] == 1
        and closure["release_observer_exit_code"] == 0
        and closure["caller_live"] is False
        and closure["supervisor_published"] is False
        and closure["task_attempts"] == 0
        and closure["caller_pid"] == caller["pid"]
        and closure["gate_live"] is False
        and closure["gate_pid"] == caller["gate_pid"]
        and closure["source_ref"] == config["source_ref"]
        and closure["started_at_epoch"] == epoch
        and closure["original_deadline"] == epoch + 5400
        and closure["terminal_sha256"] == inputs[str(closed / "terminal.json")]
        and closure["release_sha256"] == inputs[str(closed / "export/disposable-controller.release.json")]
        and epoch <= closure["observed_epoch"] <= time.time()
        and type(closure["original_session"]) is int
        and closure["original_session"] > 0
        and closure["release_observer_handle_kind"] == "synchronous-terminal-chunk"
        and re.fullmatch(r"exec:[0-9a-f]+", closure["release_observer_session"]),
        "positive unstarted caller join required",
    )
    observation = closed / "workspace-release-observation"
    check = obj(observation / "check.json", inputs)
    intent = obj(observation / "intent.json", inputs)
    need(
        {k: v for k, v in intent.items() if k != "observed_epoch"} == check
        and check["allowed_method"] == "GET"
        and check["allowed_path"] == "/volumes/" + workspace["volume_id"]
        and check["source_ref"] == config["source_ref"]
        and check["volume_id"] == workspace["volume_id"]
        and check["caller_pid"] == caller["pid"]
        and check["caller_birth"] == caller["birth"]
        and check["operator_sha256"] == "4a16af376f7cb613c194f3e6baf4aaeb9e18da020f445658cb61f25fc6bd0f7f",
        "known GET-only release observation required",
    )
    need(
        set(check["bindings"])
        == {
            "authority.private.json",
            "caller.json",
            "cleanup-call.intent.json",
            "cleanup.pending.json",
            "gate.pending.json",
            "gate.private.log",
            "export/disposable-delete-volume.intent.json",
            "export/workspace-volume.ownership.json",
        },
        "release observation bindings incomplete",
    )
    need(
        set(check["source_pins"])
        == {
            "cloudbench-controller-export.py",
            "cloudbench-controller-payload-finalization.py",
            "cloudbench-disposable-controller.py",
            "cloudbench-original-volume-capture.py",
            "cloudbench-original600-runner.py",
            "cloudbench-resume-controller-payload.py",
            "run-cloudbench-controller-gate",
            "run-original600-controller.py",
        },
        "release source bindings incomplete",
    )
    for name, expected in check["bindings"].items():
        need(
            name
            in {
                "authority.private.json",
                "caller.json",
                "cleanup-call.intent.json",
                "cleanup.pending.json",
                "gate.pending.json",
                "gate.private.log",
                "export/disposable-delete-volume.intent.json",
                "export/workspace-volume.ownership.json",
            }
            and digest(read(closed / name, inputs)) == expected,
            "release observation input changed",
        )
    for name, expected in check["source_pins"].items():
        source = reader["subprocess"].check_output(
            [
                "git",
                "--no-replace-objects",
                "-C",
                str(HERE.parent),
                "show",
                config["source_ref"] + ":scripts/" + name,
            ]
        )
        need(digest(source) == expected, "release observation source changed")
    for number in (1, 2):
        prefix = observation / ("wire-%06d" % number)
        need(
            obj(Path(str(prefix) + ".request.json"), inputs)
            == dict(method="GET", path=check["allowed_path"], body=None),
            "release observation effect forbidden",
        )
        raw = obj(Path(str(prefix) + ".raw.json"), inputs)
        body = base64.b64decode(raw["body_b64"], validate=True)
        need(
            raw["method"] == "GET"
            and raw["path"] == check["allowed_path"]
            and raw["bytes"] == len(body)
            and raw["sha256"] == digest(body),
            "release raw proof differs",
        )
        if number == 2 and raw["status"] == 404:
            need(release["volume_disposition"] == "ABSENT", "release absence differs")
        else:
            value = obj(Path(str(prefix) + ".decoded.json"), inputs)
            need(
                raw["status"] == 200
                and json.loads(body) == value
                and all(
                    value.get(key) == native_create.get(key) for key in ("id", "name", "region", "size_gb", "encrypted")
                )
                and value.get("attached_machine_id") is None
                and value.get("state") in ("pending_destroy", "destroyed")
                and value["state"] == release["volume_disposition"],
                "positive released workspace observation required",
            )
    need(
        obj(observation / "complete.json", inputs)
        == dict(
            status="CANONICAL_RELEASE_WRITTEN",
            release_sha256=inputs[str(closed / "export/disposable-controller.release.json")],
            provider_writes=0,
        ),
        "GET-only release completion differs",
    )
    once = "authority.private.json." + authority_sha + ".once"
    need(
        obj(closed / once, inputs)
        == dict(
            authority_sha256=authority_sha,
            driver_pid=caller["gate_pid"],
            driver_birth=caller["gate_birth"],
        ),
        "original allocation owner differs",
    )
    sidecars = obj(closed / "controller-sidecars.private.json", inputs)
    sidecar_names = set()
    for item in sidecars:
        path = closed / ("controller-sidecar-" + item["sha256"] + ".private.gz")
        raw = read(path, inputs)
        need(
            item["path"] == str(path) and len(raw) == item["bytes"] and digest(raw) == item["sha256"],
            "unstarted sidecar changed",
        )
        sidecar_names.add(path.name)
    expected = {
        "authority.private.json",
        once,
        "caller.json",
        "cleanup-call.intent.json",
        "terminal.json",
        "gate.private.log",
        "host-operator-provenance.json",
        "controller-launch-payload.private.json.gz",
        "controller-sidecars.private.json",
        "observed-closure.safe.json",
        "export",
        "workspace-release-observation",
    } | sidecar_names
    optional = {
        "cleanup.pending.json",
        "gate.pending.json",
        "threshold-owner.identity.private.json",
        "launch-failure.observed.safe.json",
    }
    need(
        expected <= {p.name for p in closed.iterdir()} <= expected | optional,
        "unknown unstarted output namespace",
    )
    export_names = {
        "caller.json",
        "current-agents.private.env",
        "current-backend.private.env",
        "workspace-volume.intent.json",
        "workspace-volume.ownership.json",
        "workspace-volume-create.private.json",
        "workspace-volume-create.stderr.private.log",
        "disposable-delete-volume.intent.json",
        "disposable-controller.release.json",
    }
    need(
        {p.name for p in (closed / "export").iterdir()} == export_names,
        "possible Machine creation/export activity",
    )
    observation_names = {"check.json", "intent.json", "complete.json"} | {
        "wire-%06d.%s.json" % (i, suffix) for i in (1, 2) for suffix in ("request", "raw", "decoded")
    }
    if release["volume_disposition"] == "ABSENT":
        observation_names.remove("wire-000002.decoded.json")
    need(
        {p.name for p in observation.iterdir()} == observation_names,
        "unknown release observation namespace",
    )
    for key in ("agents", "backend"):
        need(
            digest(read(closed / "export" / ("current-" + key + ".private.env"), inputs))
            == authority["env_files"][key]["sha256"],
            "unstarted environment custody differs",
        )
    before = reader["membership"](closed, inputs)
    context = reader["recovery_history"](outer, closed, config_path, config, inputs)
    need(
        reader["membership"](closed, inputs) == before,
        "unstarted closure changed while inspected",
    )
    proof = dict(
        schema="cloudbench-closed-unstarted-admission-v1",
        directory=str(outer),
        run_directory=str(closed),
        source_ref=config["source_ref"],
        epoch=epoch,
        original_deadline=epoch + 5400,
        terminal_sha256=inputs[str(closed / "terminal.json")],
        release_sha256=inputs[str(closed / "export/disposable-controller.release.json")],
        recovery_identity_sha256=context["recovery_identity_sha256"],
        request_sha256=digest(canonical(context["request"])),
        input_manifest_sha256=digest(canonical(inputs)),
        membership=before,
        task_attempts=0,
        supervisor_published=False,
        no_archive_claimed=True,
        old_failure_retained=True,
    )
    return context, proof


def prepare_released_workspace(outer, closed, config, inventory_path, inputs):
    context, proof = released_workspace_request(outer, closed, config, inputs)
    inventory_path = Path(inventory_path).absolute()
    native_raw = CLOSED["raw"](inventory_path, min(inventory_path.lstat().st_size, 256 * 1024 * 1024))
    inputs[str(inventory_path)] = digest(native_raw)
    native = {row["id"]: row for row in json.loads(native_raw)}
    need(len(native) == len(json.loads(native_raw)), "duplicate current Machine identity")
    archive_sha = digest(canonical(proof))
    candidates = []
    authority = obj(closed / "authority.private.json", inputs)
    for row in context["request"]["candidates"]:
        mid = row["machine_id"]
        need(
            mid not in authority["protected_machines"] and row["volume_id"] not in authority["protected_volumes"],
            "protected reservation",
        )
        need(
            mid in native and native[mid].get("state") == "stopped",
            "closed unstarted reservation not stopped",
        )
        original = next(value for value in context["original"]["candidates"] if value["machine_id"] == mid)
        current = recovered_reader()["validate"](context, original, row, native[mid], inputs)
        candidate = copy.deepcopy(current)
        candidate.pop("reservation")
        candidate.setdefault("legacy_archive_sha256", candidate["archive_sha256"])
        candidate["archive_sha256"] = archive_sha
        candidate["closed_unstarted_reservation_proof"] = dict(
            closure_sha256=archive_sha,
            old_failure_retained=True,
            capacity_credit=0,
            reuse_credit=False,
        )
        candidates.append(candidate)
    return dict(
        candidates=candidates,
        held_machine_ids=[row["machine_id"] for row in context["held_rows"]],
        held_reservations=context["held_rows"],
        inherited_held_scopes=context["inherited_held_scopes"],
        archive=dict(archive_sha256=archive_sha, inputs=inputs, closed_unstarted_admission=proof),
    )


def prepare(run, inventory_path):
    """Return only positively unused reserved IDs from one explicit outer state dir."""
    outer = Path(run).absolute()
    need(outer.resolve(strict=True) == outer and outer.is_dir(), "physical admission directory required")
    inputs = {}
    closed, config = closed_run(outer, inputs)
    terminal = obj(closed / "terminal.json", inputs)
    if terminal.get("status") == "FAILED_STARTUP_WORKSPACE_RELEASED":
        return prepare_released_workspace(outer, closed, config, inventory_path, inputs)
    closure = CLOSED["prepare"](closed, inventory_path)
    inputs.update(closure["inputs"])
    request, context = request_for_closed(outer, closed, config, closure, inputs)
    H["validate_request"](request)
    original_envelope = obj(outer / "archived-reuse-original.private.json", inputs)
    original = original_envelope["request"]
    need(
        original_envelope["schema"] == "original600-archived-admission-request-v1"
        and original_envelope["sha256"] == digest(json.dumps(original, sort_keys=True, allow_nan=False).encode()),
        "original admission request checksum differs",
    )
    H["validate_request"](original)
    if context is not None:
        need(context["original"] == original, "recovered original request differs")
    need(
        all(request[key] == value for key, value in original.items() if key != "candidates"),
        "reservation request source differs",
    )
    initial = {row["machine_id"]: row for row in original["candidates"]}
    need(
        closure["source_ref"] == request["harness_ref"] == config["source_ref"],
        "closed controller source differs from admission",
    )
    claimed, imported_sha, request_custody = archive_members(closed, closure, request, config, inputs)
    request_binding = (
        {"imported_request_sha256": imported_sha}
        if request_custody == "ARCHIVED_IMPORT"
        else {"request_sha256": imported_sha, "request_custody": request_custody}
    )
    machines = {row["id"]: row for row in json.loads(CLOSED["raw"](inventory_path, 256 * 1024 * 1024))}
    need(len(machines) == len(json.loads(CLOSED["raw"](inventory_path, 256 * 1024 * 1024))), "duplicate inventory")
    need(closure["controller"] not in machines, "closed controller still present in native inventory")
    candidates, held = [], []
    if context is None:
        omitted_rows, inherited_scopes = normal_hold_partition(outer, original, request, inputs)
    else:
        omitted_rows, inherited_scopes = context["held_rows"], context["inherited_held_scopes"]
    archive_sha = closure["inputs"][str((closed / "export/originals.tar.gz").absolute())]
    if omitted_rows:
        selected = {row["machine_id"] for row in request["candidates"]}
        seen_held = set()
        for omitted in omitted_rows:
            mid = omitted["machine_id"]
            need(mid in initial and mid not in selected and mid not in seen_held, "invalid recovered held partition")
            seen_held.add(mid)
            need(
                omitted["volume_id"] == initial[mid]["volume_id"]
                and mid not in closure["protected_machines"]
                and omitted["volume_id"] not in closure["protected_volumes"],
                "protected or mismatched recovered hold",
            )
            try:
                need(context is not None, "normal failed reservation remains held")
                candidate = transition_reader()["omitted"](context, initial[mid], machines[mid], inputs, claimed)
            except (ValueError, KeyError, TypeError, OSError):
                held.append(
                    dict(
                        omitted,
                        capacity_credit=0,
                        closed_archive_sha256=archive_sha,
                        **request_binding,
                        original_request_sha256=original_envelope["sha256"],
                    )
                )
            else:
                candidate["archive_sha256"] = archive_sha
                candidates.append(candidate)
    for row in request["candidates"]:
        mid = row["machine_id"]
        need(mid in initial, "reservation absent from original admission")
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
        if mid in claimed:
            held.append(
                {
                    "machine_id": mid,
                    "volume_id": row["volume_id"],
                    "capacity_credit": 0,
                    "reason": "allocated_or_unresolved_claim",
                    "closed_archive_sha256": archive_sha,
                    **request_binding,
                    "original_request_sha256": original_envelope["sha256"],
                    "claim_evidence": [claimed[mid][path] for path in sorted(claimed[mid])],
                }
            )
            continue
        need(mid in machines, "reserved Machine missing from native inventory")
        candidate = validate_reserved(
            outer, before, row, machines[mid], request["cohort"], request["harness_ref"], inputs, context
        )
        candidate.pop("reservation")
        candidate.setdefault("legacy_archive_sha256", candidate["archive_sha256"])
        candidate["archive_sha256"] = closure["inputs"][str((closed / "export/originals.tar.gz").absolute())]
        candidate["unused_reservation_proof"] = dict(
            controller=closure["controller"],
            old_cohort=request["cohort"],
            **request_binding,
            original_request_sha256=original_envelope["sha256"],
        )
        candidates.append(candidate)
    result = dict(
        candidates=candidates,
        held_machine_ids=sorted(row["machine_id"] for row in held),
        held_reservations=sorted(held, key=lambda row: row["machine_id"]),
        archive=dict(
            controller=closure["controller"],
            archive_sha256=closure["inputs"][str((closed / "export/originals.tar.gz").absolute())],
            inputs=inputs,
        ),
    )
    if closure.get("cleanup_reserve_exclusions"):
        result["archive"]["cleanup_reserve_exclusions"] = closure["cleanup_reserve_exclusions"]
    if closure.get("inventory_pointer_proof"):
        result["archive"]["inventory_pointer_proof"] = closure["inventory_pointer_proof"]
    if request_custody == "HOST_BOUND_NOT_IMPORTED":
        result["archive"].update(request_binding)
    if inherited_scopes:
        result["inherited_held_scopes"] = copy.deepcopy(inherited_scopes)
    return result
