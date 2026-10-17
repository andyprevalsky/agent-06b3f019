#!/usr/bin/env python3
"""Read a closed recovered admission; never infer a native write or replay one."""

import ast
import copy
import json
import re
import runpy
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
I = runpy.run_path(str(HERE / "cloudbench-incomplete-reservations.py"))
C, H, R = I["C"], I["H"], I["R"]
need, sha, canonical = I["need"], I["sha"], I["canonical"]
HOST = "f4ba201ff08041b58a4abebf96f5d797af56cb6c"
CLOSED_HOST_HASHES = {
    "cloudbench-incomplete-reservations.py": "8272f61ee9d68d96e301923a7910d8e10f074a8aad4cc16c930b0a7e5f53b94b",
    "run-original600-controller.py": "77cf28f87d2c913940e9bf15557e3a5f65f4d149e9280c073d61430cc4735988",
}


def closed_host(ref):
    need(
        isinstance(ref, str) and re.fullmatch("[0-9a-f]{40}", ref),
        "invalid recovered operator",
    )
    for name, expected in CLOSED_HOST_HASHES.items():
        raw = subprocess.check_output(
            [
                "git",
                "--no-replace-objects",
                "-C",
                str(HERE.parent),
                "show",
                ref + ":scripts/" + name,
            ]
        )
        need(sha(raw) == expected, "unknown closed admission host protocol")
    need(CLOSED_HOST_HASHES, "closed host source bindings missing")

    def source(revision, name):
        return subprocess.check_output(
            [
                "git",
                "--no-replace-objects",
                "-C",
                str(HERE.parent),
                "show",
                revision + ":scripts/" + name,
            ]
        )

    old_cli = ast.parse(source(I["CLOSED_SOURCE"], "run-original600-controller.py"))
    pins = next(
        ast.literal_eval(node.value)
        for node in old_cli.body
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name) and target.id == "PINS"
            for target in node.targets
        )
    )
    for name in pins:
        if (
            name not in CLOSED_HOST_HASHES
            and name != "cloudbench-recovered-reservations.py"
        ):
            need(
                source(ref, name) == source(I["CLOSED_SOURCE"], name),
                "recovered host dependency changed",
            )

    # The only recovery-reader function used during effects is the unchanged
    # strict leased-read validator; the remaining reader runs after closure.
    def observer(raw):
        return {
            node.name: ast.dump(node, include_attributes=False)
            for node in ast.parse(raw).body
            if isinstance(node, ast.FunctionDef)
            and node.name in {"observed", "obj", "wire_namespace"}
        }

    need(
        observer(source(ref, "cloudbench-recovered-reservations.py"))
        == observer(source(I["CLOSED_SOURCE"], "cloudbench-recovered-reservations.py")),
        "recovered observation protocol changed",
    )
    return ref


def obj(path, inputs):
    return C["obj"](Path(path), inputs)


def membership(root, inputs):
    need(
        root.resolve(strict=True) == root and root.is_dir(),
        "physical recovery journal required",
    )
    result = {}
    for path in sorted(root.rglob("*")):
        need(not path.is_symlink(), "recovery journal alias")
        relative = str(path.relative_to(root))
        if path.is_dir():
            result[relative] = {"kind": "directory"}
        else:
            raw = C["U"]["CLOSED"]["raw"](path)
            digest = sha(raw)
            inputs[str(path)] = digest
            result[relative] = {"kind": "file", "sha256": digest}
    return result


def unique(rows, label):
    result = {row["machine_id"]: row for row in rows}
    need(len(result) == len(rows), "duplicate " + label)
    return result


def load(outer, closed, config, closure, inputs):
    """Called only after CLOSED.prepare; bind its complete inputs before replay."""
    outer, closed = Path(outer).absolute(), Path(closed).absolute()
    need(
        closure.get("schema") == "cloudbench-archived-owner-stop-plan-v1"
        and closure["source_ref"] == config["source_ref"]
        and config["source_ref"] in (I["SOURCE"], I["CLOSED_SOURCE"])
        and closure.get("no_delete") is True,
        "full closed controller context required",
    )
    required = {
        str(closed / name)
        for name in (
            "terminal.json",
            "cleanup-call.intent.json",
            "authority.private.json",
            "export/disposable-export.verified.json",
            "export/manifest.json",
            "export/launch.json",
            "export/originals.tar.gz",
        )
    }
    need(required <= set(closure["inputs"]), "incomplete closed context")
    for path, expected in closure["inputs"].items():
        if Path(path) == closed / "export/originals.tar.gz":
            observed = C["U"]["CLOSED"]["archive_digest"](Path(path))
        else:
            # Buffered read(n) may reserve n bytes even for a small file.
            limit = min(Path(path).lstat().st_size, 256 * 1024 * 1024)
            observed = sha(C["U"]["CLOSED"]["raw"](Path(path), limit))
        need(observed == expected, "closed context bytes changed")
        inputs[path] = expected
    launch = obj(outer / "controller-launch.intent.json", inputs)
    config_path = Path(launch["config_path"])
    need(
        config_path.parent.parent == outer
        and closed == config_path.parent / "run"
        and config_path.name == "config.private.json",
        "exact recovered launch required",
    )
    raw_config = R["read"](config_path)
    need(
        sha(raw_config) == launch["config_sha256"]
        and json.loads(raw_config) == config
        and launch["run_directory"] == str(closed),
        "recovered config binding differs",
    )
    inputs[str(config_path)] = sha(raw_config)
    provenance = config["host_operator_provenance"]
    typed_closed = config["source_ref"] == I["CLOSED_SOURCE"]
    host = closed_host(provenance["host_operator_source_ref"]) if typed_closed else HOST
    need(
        provenance["host_operator_source_ref"] == host
        and provenance["workload_source_ref"] == config["source_ref"],
        "unknown recovered host protocol",
    )
    # This is the canonical original receipt, never a fallback basename search.
    plan = I["historical_plan"](outer, outer / "observed-admission-failure.safe.json")
    inputs.update(plan["inputs"])
    journal = outer / "incomplete-admission-recovery"
    before = membership(journal, inputs)
    complete, intent = (
        obj(journal / "complete.json", inputs),
        obj(journal / "intent.json", inputs),
    )
    identity = sha(canonical(plan))
    need(
        complete["identity_sha256"] == intent["identity_sha256"] == identity
        and complete["cancelled_signals"] == []
        and complete["original_deadline"]
        == intent["original_deadline"]
        == plan["deadline"]
        and intent["old_journal_immutable"] is True
        and complete["old_failures_retained"] is True
        and complete["task_credit"] == 0,
        "incomplete or mismatched recovery completion",
    )
    need(
        provenance["incomplete_admission"]["original_plan_sha256"]
        == sha(json.dumps(plan, sort_keys=True, allow_nan=False).encode())
        and provenance["incomplete_admission"]["source_ref"] == host
        and provenance["original_started_at_epoch"]
        == plan["started_at"]
        == config["started_at_epoch"],
        "original historical plan/epoch differs",
    )
    raw_request = R["read"](journal / "request.json")
    request = json.loads(raw_request)
    need(
        sha(raw_request) == complete["request_sha256"],
        "recovered request checksum differs",
    )
    launch_request = config_path.parent / "archived-reuse-request.private.json"
    need(
        R["read"](launch_request) == raw_request, "launch request differs from recovery"
    )
    inputs[str(launch_request)] = sha(raw_request)
    relative = ".git/cloudbench-archived-reuse-" + request["cohort"] + ".json"
    selected = [
        row for row in config["remote_files"] if row["relative_path"] == relative
    ]
    need(
        len(selected) == 1
        and selected[0]["source_path"] == str(launch_request)
        and selected[0]["sha256"] == sha(raw_request)
        and config["remote_env"]["CLOUDBENCH_ARCHIVED_REUSE_REQUEST_SHA256"]
        == sha(raw_request),
        "sealed remote recovered request differs",
    )
    original = plan["request"]
    need(
        all(
            request[key] == value
            for key, value in original.items()
            if key not in ("candidates", "held_native_reservations")
        ),
        "recovered request original fields differ",
    )
    rows, initial = (
        unique(request["candidates"], "recovered candidate"),
        unique(original["candidates"], "original candidate"),
    )
    results, held = (
        unique(complete["results"], "recovery result"),
        unique(complete["held"], "held result"),
    )
    classes = unique(plan["classifications"], "classified row")
    effect_ids = set(classes)
    retained = unique(
        plan.get("retained_request", {}).get("candidates", []), "retained row"
    )
    need(not set(retained) & set(classes), "retained row classified for another write")
    if typed_closed:
        need(
            plan.get("schema") == "closed-admission-continuation-v1"
            and all(rows.get(mid) == row for mid, row in retained.items()),
            "closed retained request changed",
        )
        classes.update(
            {mid: {"machine_id": mid, "lane": "RETAINED"} for mid in retained}
        )
    need(
        set(rows) == set(results)
        and not set(rows) & set(held)
        and set(rows) | set(held) == set(initial)
        and request["held_native_reservations"] == complete["held"],
        "recovery partition differs",
    )
    for mid, result in results.items():
        need(
            mid in classes
            and result
            == {
                "machine_id": mid,
                "lane": classes[mid]["lane"],
                "old_failure_retained": True,
            },
            "recovered lane differs",
        )
    need(
        set(before)
        == {"intent.json", "complete.json", "request.json"}
        | {name for name in before if name.split("/")[0] in effect_ids},
        "foreign recovery namespace",
    )
    need(
        membership(journal, inputs) == before,
        "recovery journal changed while inspected",
    )
    inherited = copy.deepcopy(original.get("held_prior_reservations", []))
    origins = {entry["archive_sha256"] for entry in original["archives"]}
    seen_origins = set()
    for scope in inherited:
        ids = scope["machine_ids"]
        need(
            (
                re.fullmatch("[0-9a-f]{64}", scope["archive_sha256"])
                if typed_closed
                else scope["archive_sha256"] in origins
            )
            and scope["archive_sha256"] not in seen_origins
            and scope.get("reuse_credit") is False
            and len(ids) == len(set(ids))
            and all(
                isinstance(mid, str) and re.fullmatch("[0-9a-f]{14}", mid)
                for mid in ids
            ),
            "invalid inherited recovered hold scope",
        )
        seen_origins.add(scope["archive_sha256"])
    held_rows = [
        {
            **copy.deepcopy(row),
            "volume_id": initial[mid]["volume_id"],
            "capacity_credit": 0,
            "reuse_credit": False,
        }
        for mid, row in sorted(held.items())
    ]
    return {
        "directory": str(outer),
        "journal": str(journal),
        "request": request,
        "original": original,
        "classifications": classes,
        "results": results,
        "membership": before,
        "historical_plan": plan,
        "held_rows": held_rows,
        "inherited_held_scopes": inherited,
        "recovery_identity_sha256": identity,
        "closed": str(closed),
    }


def wire_namespace(directory):
    allowed = {
        "request.json",
        "transport-start.json",
        "stderr.private.log",
        "http-start.json",
        "result.json",
    }
    for folder in (directory / "wire").iterdir():
        need(folder.is_dir() and not folder.is_symlink(), "wire request alias")
        for path in folder.iterdir():
            need(
                path.is_file()
                and not path.is_symlink()
                and (
                    path.name in allowed
                    or re.fullmatch(r"[0-9]{4}-wire\.json", path.name)
                ),
                "unknown wire effect artifact",
            )


def observed(directory, proof, inputs):
    """Exactly one leased read, with a positive raw release after the read."""
    need(
        {p.name for p in directory.iterdir()} == {"wire", "observed.json"},
        "unknown observation artifact",
    )
    current = obj(directory / "observed.json", inputs)
    wire_namespace(directory)
    records = C["wire"](directory, inputs)
    mid = proof["machine_id"]
    url = "/machines/" + mid
    need(len(records) == 3, "observation has extra or missing native requests")
    need(all(row[1] is not None for row in records), "observation raw response missing")
    stamps = [row[1].get("monotonic_ns") for row in records]
    need(
        all(type(at) is int for at in stamps) and len(stamps) == len(set(stamps)),
        "observation monotonic timestamps invalid",
    )
    records.sort(key=lambda row: row[1]["monotonic_ns"])
    acquire, readback, release = records
    for request, raw, value, _ in records:
        need(
            request["app"] == H["APP"]
            and raw is not None
            and 200 <= raw["status"] < 300,
            "observation raw response not successful",
        )
    nonce = acquire[2]["data"]["nonce"]
    need(isinstance(nonce, str) and nonce, "observation lease nonce absent")
    need(
        acquire[0]["method"] == "POST"
        and acquire[0]["path"] == url + "/lease"
        and readback[0]["method"] == "GET"
        and readback[0]["path"] == url
        and release[0]["method"] == "DELETE"
        and release[0]["path"] == url + "/lease"
        and all(
            record[0].get("headers", {}).get("fly-machine-lease-nonce") == nonce
            for record in (readback, release)
        )
        and acquire[1]["monotonic_ns"]
        < readback[1]["monotonic_ns"]
        < release[1]["monotonic_ns"]
        and readback[2] == current,
        "observation lease/read/release chain differs",
    )
    expected = proof.get("expected_native", proof.get("ack"))
    keys = ("id", "config", "name", "created_at", "region")
    if not proof.get("old_response_unknown"):
        keys += ("instance_id",)
    need(
        current["state"] in ("created", "stopped")
        and all(current.get(key) == expected.get(key) for key in keys),
        "observed reserve differs",
    )
    if proof.get("old_response_unknown"):
        need(
            isinstance(current.get("instance_id"), str)
            and current["instance_id"]
            and current["instance_id"] != proof["original_instance"],
            "unknown update not positively observed",
        )
    return current


def validate_proof(context, original_row, reserved_row, inputs):
    """Validate reserved custody even when a later claim changed current config."""
    mid = original_row["machine_id"]
    initial = unique(context["original"]["candidates"], "original")
    selected = unique(context["request"]["candidates"], "recovered")
    need(
        initial.get(mid) == original_row and selected.get(mid) == reserved_row,
        "row absent from exact recovered request",
    )
    entry = context["classifications"][mid]
    directory = Path(context["journal"]) / mid
    if entry["lane"] == "RETAINED":
        native = I["retained_native"](
            Path(context["directory"]),
            original_row,
            {"row": reserved_row, "_request": context["original"]},
            context["historical_plan"]["retained_lanes"][mid],
            inputs,
        )
        H["same_source"](reserved_row, native)
        need(
            membership(Path(context["journal"]), inputs) == context["membership"],
            "recovery completion changed",
        )
        return copy.deepcopy(reserved_row)
    if entry["lane"] in ("ACK", "PENDING_READ"):
        proof = entry["proof"]
        native = observed(directory, proof, inputs)
    else:
        base = directory / "new-reservation"
        need(
            {p.name for p in directory.iterdir()} <= {"new-reservation", "ack-rescue"},
            "unknown PRE_CONFIG recovery artifact",
        )
        native_dir = base / mid
        need(
            {p.name for p in base.iterdir()} <= {mid, "reserved-request.json"}
            and native_dir.is_dir()
            and not native_dir.is_symlink(),
            "foreign new reservation namespace",
        )
        single_request = dict(context["original"], candidates=[original_row])
        closed_path = base / "reserved-request.json"
        if closed_path.exists():
            closed_request = obj(closed_path, inputs)
            need(
                closed_request == dict(single_request, candidates=[reserved_row]),
                "one-row new reservation completion differs",
            )
        recovered = I["classify"](native_dir, original_row, single_request, inputs)
        need(recovered["lane"] == "ACK", "new reservation lacks strict classified ACK")
        wire_namespace(native_dir)
        if (directory / "ack-rescue").exists():
            recovered = I["classify"](
                native_dir,
                original_row,
                dict(context["original"], candidates=[original_row]),
                inputs,
            )
            need(recovered["lane"] == "ACK", "rescue requires positive new ACK")
            proof = recovered["proof"]
            native = observed(directory / "ack-rescue", proof, inputs)
        else:
            need(closed_path.exists(), "normal one-row reservation not closed")
            reserved = obj(native_dir / "reserved.json", inputs)
            need(reserved == reserved_row, "new reserved row differs")
            # Strict original raw ACK proof, then positive read and release.
            proof = C["positive"](native_dir, original_row, context["original"], inputs)
            records = C["wire"](native_dir, inputs)
            need(
                all(
                    row[1] is not None and type(row[1].get("monotonic_ns")) is int
                    for row in records
                ),
                "new reserve raw chronology missing",
            )
            records.sort(key=lambda row: row[1]["monotonic_ns"])
            ack = proof["ack"]
            posts = [
                r
                for r in records
                if r[0]["method"] == "POST" and r[0]["path"] == "/machines/" + mid
            ]
            at = posts[0][1]["monotonic_ns"]
            reads = [
                r
                for r in records
                if r[0]["method"] == "GET"
                and r[0]["path"] == "/machines/" + mid
                and r[1] is not None
                and 200 <= r[1]["status"] < 300
                and r[1]["monotonic_ns"] > at
                and isinstance(r[2], dict)
                and all(
                    r[2].get(key) == ack.get(key)
                    for key in (
                        "id",
                        "instance_id",
                        "config",
                        "name",
                        "created_at",
                        "region",
                    )
                )
                and r[2].get("state") in ("created", "stopped")
            ]
            need(reads, "new reservation lacks exact inactive read")
            nonce = posts[0][0]["headers"]["fly-machine-lease-nonce"]
            need(
                any(
                    r[0]["method"] == "DELETE"
                    and r[0]["path"] == "/machines/" + mid + "/lease"
                    and r[0]["headers"].get("fly-machine-lease-nonce") == nonce
                    and r[1] is not None
                    and 200 <= r[1]["status"] < 300
                    and r[1]["monotonic_ns"] > reads[-1][1]["monotonic_ns"]
                    for r in records
                ),
                "new reservation release not proved",
            )
            native = reads[-1][2]
    marker = proof["marker"]
    expected_row = dict(
        original_row,
        source_instance_id=native["instance_id"],
        source_config_sha256=H["config_sha"](native["config"]),
        prior_marker=canonical(marker).decode(),
        reservation={
            "cohort": marker["cohort"],
            "marker": marker,
            "instance_id": native["instance_id"],
            "config_sha256": H["config_sha"](native["config"]),
        },
    )
    need(reserved_row == expected_row, "recovered row lineage differs from original")
    H["same_source"](reserved_row, native)
    expected_members = {
        name.removeprefix(mid + "/"): value
        for name, value in context["membership"].items()
        if name.startswith(mid + "/")
    }
    need(
        membership(directory, inputs) == expected_members, "recovery row proof changed"
    )
    return copy.deepcopy(reserved_row)


def validate(context, original_row, reserved_row, current, inputs):
    row = validate_proof(context, original_row, reserved_row, inputs)
    H["same_source"](row, current)
    return row
