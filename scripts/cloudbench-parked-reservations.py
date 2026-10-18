#!/usr/bin/env python3
"""New admission from closed parked claims; preserve every original failure and liability."""

import ast
import base64
import copy
import json
import re
import runpy
import subprocess
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
U = runpy.run_path(str(HERE / "cloudbench-unused-reservations.py"))
H, CLOSED = U["H"], U["CLOSED"]
need, canonical, config_sha = (H[k] for k in ("need", "canonical", "config_sha"))
T = runpy.run_path(str(HERE / "cloudbench-closed-transition-reservations.py"))


def protocol(ref):
    need(re.fullmatch("[0-9a-f]{40}", ref or ""), "exact archived harness ref required")
    source = subprocess.check_output(
        [
            "git",
            "--no-replace-objects",
            "-C",
            str(HERE.parent),
            "show",
            ref + ":scripts/cloudbench-archived-machine-reuse.py",
        ]
    )
    names = {"claim_native", "allocate", "proof_for", "campaign_candidate_index"}
    recovery = {"claim_read_evidence", "same_claim_evidence", "reconcile_claim_read", "ClaimReadCancelled"}

    def selected(raw):
        return {
            node.name: ast.dump(node, include_attributes=False)
            for node in ast.parse(raw).body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            and node.name in names | {"selected_request"} | recovery
        }

    current = (HERE / "cloudbench-archived-machine-reuse.py").read_bytes()
    archived_functions, current_functions = selected(source), selected(current)
    # Exact reviewed pre-reconciliation source remains a distinct protocol.
    old_source = (
        current
        if U["digest"](current) == "24c948d99fd2ed3dff7ce5f0cf01010e7f139342b99ad4f1ef6f5a3a43b4d7c7"
        else subprocess.check_output(
            [
                "git",
                "--no-replace-objects",
                "-C",
                str(HERE.parent),
                "show",
                "c9d4817832720cc2b1bc6a212383973a77baf004:scripts/cloudbench-archived-machine-reuse.py",
            ]
        )
    )
    need(
        U["digest"](old_source) == "24c948d99fd2ed3dff7ce5f0cf01010e7f139342b99ad4f1ef6f5a3a43b4d7c7",
        "reviewed old claim protocol changed",
    )
    old_functions = selected(old_source)
    old_protocol = U["digest"](source) == U["digest"](old_source)
    reference = old_functions if old_protocol or not recovery.intersection(archived_functions) else current_functions
    if recovery.intersection(archived_functions):
        need(
            recovery <= set(archived_functions)
            and recovery <= set(current_functions)
            and all(archived_functions[name] == current_functions[name] for name in recovery),
            "archived claim reconciliation protocol differs",
        )
    # The original allocator retained the full validated cohort while claiming
    # one row. Accept only those exact reviewed legacy bytes; the effect,
    # publication and index functions must still match the current protocol.
    allocator = next(
        (node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == "allocate"),
        None,
    )
    legacy_allocator = (
        allocator is not None
        and U["digest"](ast.get_source_segment(source.decode(), allocator).encode())
        == "d868a356e1a0137be6a46150056876728d55e2d622edc8b1c97a6591c73aa725"
    )
    need(
        old_protocol or legacy_allocator or recovery <= set(archived_functions),
        "unreviewed historical claim source",
    )
    need(
        names <= set(archived_functions)
        and all(archived_functions[name] == reference[name] for name in names - {"allocate"})
        and (
            (
                archived_functions["allocate"] == reference["allocate"]
                and archived_functions.get("selected_request") == reference.get("selected_request")
            )
            or legacy_allocator
        ),
        "archived claim publication/effect protocol differs",
    )
    if not legacy_allocator:
        indexed_source = subprocess.check_output(
            [
                "git",
                "--no-replace-objects",
                "-C",
                str(HERE.parent),
                "show",
                ref + ":scripts/cloudbench-reuse-index.py",
            ]
        )
        need(
            indexed_source == (HERE / "cloudbench-reuse-index.py").read_bytes(),
            "archived indexed selection protocol differs",
        )
    return U["digest"](source)


def collect(closed, held, inputs):
    manifest = U["archive_manifest"](closed, inputs)
    roots = {}
    owner_metadata = {}
    for row in held:
        for evidence in row["claim_evidence"]:
            path = evidence["path"]
            if path.endswith(
                (
                    "/archived-reuse-journal/source-exclusion.json",
                    "/archived-successor.json",
                )
            ):
                root = path.removesuffix("/archived-reuse-journal/source-exclusion.json").removesuffix(
                    "/archived-successor.json"
                )
                roots.setdefault(
                    root,
                    {
                        "machine_id": row["machine_id"],
                        "root": root,
                        "files": {},
                        "hashes": {},
                        "claim_evidence": row["claim_evidence"],
                        "published": [],
                        "malformed_json": [],
                        "namespace": {},
                        "producer_sha256": None,
                    },
                )
                need(
                    roots[root]["machine_id"] == row["machine_id"],
                    "claim root has conflicting Machines",
                )
    with tarfile.open(closed / "export/originals.tar.gz", "r|gz") as archive:
        for member in archive:
            if (
                re.fullmatch(r"git-common/cloudbench-fleet-(?:ownership|audits)/[0-9a-f]{32}/meta", member.name)
                and member.isfile()
            ):
                expected = manifest["files"][member.name]
                raw = archive.extractfile(member).read(1048577)
                need(
                    len(raw) <= 1048576 and len(raw) == expected["bytes"] and U["digest"](raw) == expected["sha256"],
                    "partial owner metadata differs",
                )
                owner_metadata[member.name] = raw
            parts = member.name.split("/")
            # context/fleet/runs/RUN/TASK is the canonical private task root.
            root = "/".join(parts[:5])
            if member.name == "source/scripts/lib/cloudbench-archived-reuse.sh" and member.isfile():
                expected = manifest["files"][member.name]
                raw = archive.extractfile(member).read(1048577)
                need(
                    len(raw) <= 1048576 and len(raw) == expected["bytes"] and U["digest"](raw) == expected["sha256"],
                    "claim shell producer differs",
                )
                for group in roots.values():
                    group["producer_sha256"] = U["digest"](raw)
            if root not in roots:
                continue
            relative = "/".join(parts[5:])
            roots[root]["namespace"][relative] = manifest["files"][member.name]
            if not member.isfile():
                continue
            if relative in ("archived-reuse-proof.json", ".cid"):
                roots[root]["published"].append(member.name)
                if relative == ".cid":
                    continue
            if relative in ("bench-e2e.started-epoch", "bench-e2e.finished-epoch"):
                expected = manifest["files"][member.name]
                raw = archive.extractfile(member).read(129)
                need(
                    len(raw) <= 128 and len(raw) == expected["bytes"] and U["digest"](raw) == expected["sha256"],
                    "claim epoch bytes differ",
                )
                roots[root]["hashes"][member.name] = U["digest"](raw)
                roots[root]["files"][relative] = raw.decode().strip()
                continue
            if not member.name.endswith(".json"):
                continue
            if relative not in (
                "archived-successor.json",
                "archived-reuse-proof.json",
                ".startup-state.json",
            ) and not relative.startswith(("archived-reuse-journal/", "archived-reuse-wire/")):
                continue
            expected = manifest["files"][member.name]
            need(
                member.size <= 16 * 1024 * 1024 and expected["kind"] == "file",
                "unsafe claim input",
            )
            raw = archive.extractfile(member).read(16 * 1024 * 1024 + 1)
            need(
                len(raw) == expected["bytes"] == member.size and U["digest"](raw) == expected["sha256"],
                "claim bytes changed",
            )
            roots[root]["hashes"][member.name] = U["digest"](raw)
            try:
                roots[root]["files"][relative] = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                roots[root]["malformed_json"].append(
                    {"path": member.name, "bytes": len(raw), "sha256": U["digest"](raw)}
                )
    for group in roots.values():
        group["manifest_files"] = manifest["files"]
        group["owner_metadata"] = owner_metadata
    return roots


def records(files):
    result = []
    for name, request in files.items():
        if not name.startswith("archived-reuse-wire/") or not name.endswith("/request.json"):
            continue
        prefix = name.removesuffix("request.json")
        wires = [value for key, value in files.items() if key.startswith(prefix) and key.endswith("-wire.json")]
        need(len(wires) <= 1, "ambiguous raw claim response")
        if not wires:
            started = files.get(prefix + "transport-start.json", {})
            at = started.get("monotonic_ns")
            if request["method"] == "POST" and request["path"].count("/") == 2:
                need(type(at) is int and started.get("direct") is False, "unknown claim dispatch ordering")
            result.append((at, request, None, None))
            continue
        wire = wires[0]
        raw = base64.b64decode(wire["body_b64"], validate=True)
        need(
            U["digest"](raw) == wire["sha256"]
            and wire["method"] == request["method"]
            and wire["path"] == request["path"],
            "claim raw wire changed",
        )
        value = json.loads(raw) if 200 <= wire["status"] < 300 and raw.strip() else None
        if prefix + "result.json" in files:
            need(files[prefix + "result.json"] == value, "claim decoded response differs")
        result.append((wire["monotonic_ns"], request, value, wire["status"]))
    return result


def validate_partial_proof(group, request, proof, wire, current, stage, source_sha):
    need(
        source_sha
        in {
            "24c948d99fd2ed3dff7ce5f0cf01010e7f139342b99ad4f1ef6f5a3a43b4d7c7",
            "829cd14575c5e0d74ac0e969c7354719e03e311a79b97abcec8490474d53e8a1",
        }
        and group.get("producer_sha256") == "20c34a26e524e6beb9c7d077aa8705b45134106ec831e2ad616b3139df3ececc"
        and stage == "CONFIG_ACKED_UNPUBLISHED",
        "unknown partial claim publication producer",
    )
    files = group["files"]
    need(
        files["archived-reuse-proof.json"] == proof
        and files["archived-reuse-journal/claim-ack.json"]
        == dict(instance_id=current["instance_id"], native_marker_sha256=proof["native_marker_sha256"]),
        "partial claim publication proof differs",
    )
    ordered = sorted(wire, key=lambda item: item[0] if type(item[0]) is int else -1)
    url = "/machines/" + current["id"]
    need(
        len(ordered) == 5
        and all(type(t) is int for t, *_ in ordered)
        and [t for t, *_ in ordered] == sorted(set(t for t, *_ in ordered))
        and [(q["method"], q["path"]) for _, q, _, _ in ordered]
        == [("POST", url + "/lease"), ("GET", url), ("POST", url), ("GET", url), ("DELETE", url + "/lease")]
        and [code for _, _, _, code in ordered] == [201, 200, 200, 200, 200],
        "partial claim lease history is not closed",
    )
    wire_names = {name for name in group["namespace"] if name.startswith("archived-reuse-wire/")}
    folders = {name.removesuffix("/request.json") for name in wire_names if name.endswith("/request.json")}
    expected_names = folders | {
        folder + "/" + name
        for folder in folders
        for name in (
            "request.json",
            "0001-wire.json",
            "result.json",
            "http-start.json",
            "transport-start.json",
            "stderr.private.log",
        )
    }
    need(len(folders) == 5 and wire_names == expected_names, "partial claim wire namespace is not exact closed history")
    need(
        ordered[0][1].get("body") == {"description": "archived same-volume successor", "ttl": 180}
        and all(ordered[i][1].get("body") is None for i in (1, 3, 4)),
        "partial claim lease/read body differs",
    )
    nonce = ordered[0][2]["data"]["nonce"]
    need(
        all(q.get("headers", {}).get("fly-machine-lease-nonce") == nonce for _, q, _, _ in ordered[1:])
        and all(
            ordered[3][2].get(k) == current.get(k)
            for k in ("id", "instance_id", "config", "name", "region", "created_at")
        )
        and ordered[3][2].get("state") == "stopped",
        "partial claim readback differs",
    )
    successor = proof["successor"]
    token = successor["owner_token"]
    for kind, version in (("ownership", "2"), ("audits", "1")):
        prefix = "git-common/cloudbench-fleet-" + kind + "/" + token
        path = prefix + "/meta"
        raw = group["owner_metadata"][path]
        pairs = [line.split("=", 1) for line in raw.decode().splitlines()]
        need(
            all(len(pair) == 2 for pair in pairs) and len({pair[0] for pair in pairs}) == len(pairs),
            "partial owner metadata malformed",
        )
        meta = dict(pairs)
        need(
            meta.get("version") == version
            and meta.get("fleet_owner_token") == token
            and meta.get("app") == H["APP"]
            and meta.get("run_id") == successor["run_id"]
            and (kind != "ownership" or meta.get("host") == successor["controller_id"]),
            "partial owner lineage differs",
        )
        need(
            not any(name.startswith(prefix + "/archived-reuse/") for name in group["manifest_files"]),
            "partial owner already registered native reuse",
        )
        group["hashes"][path] = U["digest"](raw)
    need(
        "git-common/cloudbench-archived-reuse/current/" + current["id"] + ".json" not in group["manifest_files"],
        "partial claim globally published",
    )
    for name, entry in group["namespace"].items():
        allowed = (
            name
            in (
                "",
                "archived-reuse-journal",
                "archived-reuse-wire",
                "archived-successor.json",
                "archived-reuse-proof.json",
                ".startup-state.json",
                "bench-e2e.started-epoch",
            )
            or name
            in {
                "archived-reuse-journal/" + n
                for n in ("claim-ack.json", "claim-intent.json", "original-native.json", "source-exclusion.json")
            }
            or re.fullmatch(
                r"archived-reuse-wire/[0-9a-f]{32}(?:/(?:request.json|0001-wire.json|result.json|transport-start.json|http-start.json|stderr.private.log))?",
                name,
            )
        )
        need(
            allowed and entry.get("kind") in ("file", "directory"),
            "partial claim contains task publication or foreign artifact",
        )
    startup = files.get(".startup-state.json")
    if startup is not None:
        need(
            set(startup) == {"seen"} and set(startup["seen"]) <= {"cloning"},
            "partial claim startup progressed beyond allocation",
        )


def current_intended_unknown(group, before, current, update, intent, wire, mid, expected, source_sha):
    """New custody eligibility; an unknown old response never becomes an ACK."""
    need(
        source_sha
        in {
            "24c948d99fd2ed3dff7ce5f0cf01010e7f139342b99ad4f1ef6f5a3a43b4d7c7",
            "829cd14575c5e0d74ac0e969c7354719e03e311a79b97abcec8490474d53e8a1",
        }
        and group.get("producer_sha256") == "20c34a26e524e6beb9c7d077aa8705b45134106ec831e2ad616b3139df3ececc",
        "unknown intended claim producer",
    )
    # Validate the old version fence and history without claiming a current prior-state read.
    T["unchanged"](before, before, update, intent, wire, mid, expected)
    need(
        current.get("state") == "stopped"
        and isinstance(current.get("instance_id"), str)
        and current["instance_id"]
        and current["instance_id"] != before["instance_id"]
        and current.get("config") == expected
        and all(current.get(k) == before.get(k) for k in ("id", "name", "region", "created_at")),
        "current native is not exact intended claim",
    )
    ordered = sorted(wire, key=lambda item: item[0] if type(item[0]) is int else -1)
    url = "/machines/" + mid
    need(
        len(ordered) == 4
        and all(type(t) is int for t, *_ in ordered)
        and [t for t, *_ in ordered] == sorted(set(t for t, *_ in ordered))
        and [(q["method"], q["path"]) for _, q, _, _ in ordered]
        == [("POST", url + "/lease"), ("GET", url), ("POST", url), ("DELETE", url + "/lease")]
        and [code for _, _, _, code in ordered] == [201, 200, None, 200],
        "unknown intended claim lease is not closed",
    )
    nonce = ordered[0][2]["data"]["nonce"]
    need(
        ordered[0][1].get("body") == {"description": "archived same-volume successor", "ttl": 180}
        and all(q.get("headers", {}).get("fly-machine-lease-nonce") == nonce for _, q, _, _ in ordered[1:])
        and all(ordered[i][1].get("body") is None for i in (1, 3)),
        "unknown intended claim lease/read differs",
    )
    folders = {
        name.removesuffix("/request.json")
        for name in group["namespace"]
        if name.startswith("archived-reuse-wire/") and name.endswith("/request.json")
    }
    need(len(folders) == 4, "unknown intended claim wire count differs")
    expected_wire = set(folders)
    for folder in folders:
        q = group["files"][folder + "/request.json"]
        names = {"request.json", "http-start.json", "transport-start.json", "stderr.private.log"}
        if q != update:
            names |= {"0001-wire.json", "result.json"}
        expected_wire.update(folder + "/" + name for name in names)
    need(
        {name for name in group["namespace"] if name.startswith("archived-reuse-wire/")} == expected_wire,
        "unknown intended claim wire namespace differs",
    )
    allowed = {
        "",
        "archived-reuse-journal",
        "archived-reuse-wire",
        "archived-successor.json",
        ".startup-state.json",
        "bench-e2e.started-epoch",
        "bench-e2e.finished-epoch",
    }
    allowed |= {
        "archived-reuse-journal/" + name
        for name in ("claim-intent.json", "original-native.json", "source-exclusion.json")
    }
    need(
        all(
            (name in allowed or name in expected_wire) and entry.get("kind") in ("file", "directory")
            for name, entry in group["namespace"].items()
        ),
        "unknown intended claim has task publication or foreign artifact",
    )
    startup = group["files"].get(".startup-state.json")
    need(
        startup is None or (set(startup) == {"seen"} and set(startup["seen"]) <= {"cloning"}),
        "unknown intended claim progressed beyond allocation",
    )
    epochs = [group["files"].get("bench-e2e." + name + "-epoch") for name in ("started", "finished")]
    if epochs != [None, None]:
        need(all(isinstance(value, str) for value in epochs), "unknown intended claim failure epochs incomplete")
        epochs = [float(value) for value in epochs]
        need(
            all(0 < value < 1e12 for value in epochs) and epochs[0] <= epochs[1],
            "unknown intended claim failure epochs differ",
        )
    token = group["files"]["archived-successor.json"]["owner_token"]
    need(
        not any(
            name.startswith("git-common/cloudbench-fleet-" + kind + "/" + token + "/archived-reuse/")
            for kind in ("ownership", "audits")
            for name in group["manifest_files"]
        )
        and "git-common/cloudbench-archived-reuse/current/" + mid + ".json" not in group["manifest_files"],
        "unknown intended claim already assigned",
    )
    return dict(
        stage="CURRENT_INTENDED_CLAIM_WITH_UNKNOWN_OLD_RESPONSE",
        old_outcome="UNKNOWN_RETAINED",
        native_claim_acknowledged=False,
        current_state_observed=True,
        assignment_published=False,
        source_instance_id=current["instance_id"],
        prior_current_version=before["instance_id"],
        fresh_lease_and_current_version_cas_required=True,
        capacity_credit=0,
    )


def qualify(
    outer,
    request,
    original,
    row,
    group,
    current,
    inputs,
    controller,
    reservation_context=None,
):
    files = group["files"]
    read_failures = T["read_failures"](group, row["machine_id"])
    source_sha = protocol(request["harness_ref"])
    exclusion = files.get("archived-reuse-journal/source-exclusion.json")
    successor = files["archived-successor.json"]
    allowed = {
        group["root"] + "/archived-successor.json",
        group["root"] + "/archived-reuse-journal/source-exclusion.json",
    }
    partial = group["published"] == [group["root"] + "/archived-reuse-proof.json"]
    if partial:
        allowed.add(group["root"] + "/archived-reuse-proof.json")
    need(
        (not group["published"] or partial) and all(e["path"] in allowed for e in group["claim_evidence"]),
        "unaccounted claim or published task effect",
    )
    need(
        successor["controller_id"] == controller,
        "claim belongs another closed controller",
    )
    proof = H["proof_for"](request, row, successor)
    index = H["campaign_candidate_index"](request, successor)
    need(
        index < len(request["candidates"]) and request["candidates"][index] == row,
        "claim candidate index differs",
    )
    if exclusion:
        need(
            exclusion == {"predecessor": row, "proof": proof},
            "foreign partial claim proof",
        )
    mid = row["machine_id"]
    need(
        current["id"] == mid and current["state"] == "stopped",
        "parked Machine must be stopped",
    )
    need(
        not any(
            key.endswith("retained-terminal.json") or (key.endswith("claim-ack.json") and not partial) for key in files
        ),
        "completed claim belongs latest archive",
    )
    wire = records(files)
    need(exclusion is not None or not wire, "native effect without source exclusion")
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
            for _, req, _, _ in wire
        ),
        "foreign native action in claim history",
    )
    posts = [record for record in wire if record[1]["method"] == "POST" and record[1]["path"] == url]
    transition = None
    intent = files.get("archived-reuse-journal/claim-intent.json")
    if intent is None:
        need(not posts, "unknown native update without intent")
        # Even lease-only claims retain the original reservation's full raw proof.
        U["validate_reserved"](
            outer,
            original,
            row,
            current,
            request["cohort"],
            request["harness_ref"],
            inputs,
            reservation_context,
        )
        stage = "PRE_CONFIG_UNCHANGED_RESERVED" if exclusion else "PRE_CALL_UNCHANGED_RESERVED"
    else:
        need(exclusion is not None, "claim intent without source exclusion")
        before = files["archived-reuse-journal/original-native.json"]
        U["validate_reserved"](
            outer,
            original,
            row,
            before,
            request["cohort"],
            request["harness_ref"],
            inputs,
            reservation_context,
        )
        need(len(posts) == 1, "unknown or repeated claim native update")
        at, update, ack, status = posts[0]
        expected = copy.deepcopy(before["config"])
        expected.setdefault("metadata", {})[H["MARKER"]] = canonical(proof["native_marker"]).decode()
        expected["init"] = {"cmd": ["sleep", "infinity"]}
        need(
            intent
            == {
                "current_version": before["instance_id"],
                "config_sha256": config_sha(expected),
            },
            "claim intent differs",
        )
        need(
            update["body"]
            == {
                "config": expected,
                "current_version": before["instance_id"],
                "skip_launch": True,
            },
            "claim update differs",
        )
        nonce = update["headers"].get("fly-machine-lease-nonce")
        need(
            isinstance(nonce, str)
            and nonce
            and any(
                t is not None
                and t < at
                and req["method"] == "POST"
                and req["path"] == url + "/lease"
                and code is not None
                and 200 <= code < 300
                and isinstance(value, dict)
                and value.get("data", {}).get("nonce") == nonce
                for t, req, value, code in wire
            ),
            "claim lease ACK missing",
        )
        need(
            any(
                t is not None
                and t < at
                and req["method"] == "GET"
                and req["path"] == url
                and req.get("headers", {}).get("fly-machine-lease-nonce") == nonce
                and code is not None
                and 200 <= code < 300
                and isinstance(value, dict)
                and value.get("instance_id") == before["instance_id"]
                and config_sha(value.get("config", {})) == config_sha(before["config"])
                for t, req, value, code in wire
            ),
            "claim pre-update read missing",
        )
        if status is None or not 200 <= status < 300:
            if current.get("instance_id") != before["instance_id"]:
                need(status is None and not partial, "unknown intended claim requires absent old response")
                transition = current_intended_unknown(
                    group, before, current, update, intent, wire, mid, expected, source_sha
                )
            else:
                transition = T["unchanged"](before, current, update, intent, wire, mid, expected)
            stage = transition["stage"]
        else:
            need(isinstance(ack, dict), "claim update has no decoded ACK")
            need(
                ack.get("id") == mid
                and ack.get("instance_id")
                and ack["instance_id"] != before["instance_id"]
                and ack.get("config") == expected,
                "claim native ACK differs",
            )
            need(
                all(
                    current.get(key) == ack.get(key)
                    for key in (
                        "id",
                        "instance_id",
                        "config",
                        "name",
                        "region",
                        "created_at",
                    )
                ),
                "current parked identity differs from ACK",
            )
            stage = "CONFIG_ACKED_UNPUBLISHED"
    if partial:
        validate_partial_proof(group, request, proof, wire, current, stage, source_sha)
        stage = "PARTIAL_PROOF_PUBLICATION_BEFORE_ASSIGNMENT"
    candidate = copy.deepcopy(row)
    candidate.pop("reservation")
    candidate.update(
        source_instance_id=current["instance_id"],
        source_config_sha256=config_sha(current["config"]),
        prior_marker=current["config"].get("metadata", {}).get(H["MARKER"]),
    )
    candidate.setdefault("legacy_archive_sha256", candidate["archive_sha256"])
    candidate["closed_transition_proof"] = {
        "unknown_read_responses": read_failures,
        "prior_effect": transition if intent is not None and stage != "CONFIG_ACKED_UNPUBLISHED" else None,
    }
    candidate["parked_claim_proof"] = {
        "stage": stage,
        "archived_claim_source_sha256": source_sha,
        "claim_id": proof["claim_id"] if exclusion else None,
        "successor": successor,
        "archive_inputs": group["hashes"],
        "current_native_sha256": U["digest"](canonical(current)),
        "old_failure_retained": True,
        "old_liabilities": "UNRESOLVED",
        "capacity_credit": 0,
    }
    if partial:
        candidate["parked_claim_proof"].update(
            native_claim_acknowledged=True,
            assignment_published=False,
            task_started_inferred=False,
            task_namespace=group["namespace"],
        )
    return candidate


def prepare(run, inventory_path):
    outer = Path(run).absolute()
    result = U["prepare"](outer, inventory_path)
    inputs = result["archive"]["inputs"]
    original = U["obj"](outer / "archived-reuse-original.private.json", inputs)["request"]
    initial = {row["machine_id"]: row for row in original["candidates"]}
    closed, config = U["closed_run"](outer, inputs)
    latest = CLOSED["prepare"](closed, inventory_path)
    inputs.update(latest["inputs"])
    request, reservation_context = U["request_for_closed"](outer, closed, config, latest, inputs)
    owned = set(latest["archived_ownership"])
    native = {row["id"]: row for row in json.loads(CLOSED["raw"](inventory_path, 256 * 1024 * 1024))}
    selected = {row["machine_id"] for row in request["candidates"]}
    held_ids = {row["machine_id"] for row in result["held_reservations"]}
    omitted = {
        row["machine_id"]: row
        for row in (reservation_context["held_rows"] if reservation_context else [])
        if row["machine_id"] in held_ids
    }
    need(
        not selected & omitted.keys() and omitted.keys() <= held_ids,
        "recovered held partition changed",
    )
    claim_holds = []
    for row in result["held_reservations"]:
        mid = row["machine_id"]
        if mid in omitted:
            need(
                row["capacity_credit"] == 0
                and row["reuse_credit"] is False
                and all(row.get(key) == value for key, value in omitted[mid].items()),
                "recovered omitted hold changed",
            )
            continue
        need(mid in selected, "unexplained held reservation")
        claim_holds.append(row)
    groups = collect(closed, claim_holds, inputs)
    by_mid = {}
    for group in groups.values():
        by_mid.setdefault(group["machine_id"], []).append(group)
    qualified, diagnostics = set(), []
    for row in request["candidates"]:
        mid = row["machine_id"]
        if mid in owned or mid not in by_mid or len(by_mid[mid]) != 1 or mid not in native:
            diagnostics.append(
                {
                    "machine_id": mid,
                    "eligible": False,
                    "reason": "owned_or_missing_or_ambiguous_claim",
                }
            )
            continue
        try:
            candidate = qualify(
                outer,
                request,
                initial[mid],
                row,
                by_mid[mid][0],
                native[mid],
                inputs,
                result["archive"]["controller"],
                reservation_context,
            )
        except (
            ValueError,
            KeyError,
            TypeError,
            OSError,
            subprocess.CalledProcessError,
        ) as error:
            reason = str(error) if type(error) is ValueError else type(error).__name__
            diagnostics.append(
                {
                    "machine_id": mid,
                    "eligible": False,
                    "reason": reason,
                    "malformed_json": by_mid[mid][0]["malformed_json"],
                }
            )
            continue  # Unknown or conflicting claims remain held, never native retries.
        candidate["archive_sha256"] = result["archive"]["archive_sha256"]
        candidate["parked_claim_proof"]["closed_archive_sha256"] = result["archive"]["archive_sha256"]
        result["candidates"].append(candidate)
        qualified.add(mid)
        diagnostics.append(
            {
                "machine_id": mid,
                "eligible": True,
                "reason": candidate["parked_claim_proof"]["stage"],
            }
        )
    counts = {}
    for row in diagnostics:
        counts[row["reason"]] = counts.get(row["reason"], 0) + 1
    result["archive"]["parked_classification"] = {
        "rows": diagnostics,
        "reason_counts": counts,
        "new_capacity_credit": 0,
    }
    result["held_machine_ids"] = [mid for mid in result["held_machine_ids"] if mid not in qualified]
    result["held_reservations"] = [row for row in result["held_reservations"] if row["machine_id"] not in qualified]
    result["candidates"].sort(key=lambda row: row["machine_id"])
    need(
        len({r["machine_id"] for r in result["candidates"]}) == len(result["candidates"])
        and len({r["volume_id"] for r in result["candidates"]}) == len(result["candidates"]),
        "duplicate parked candidate",
    )
    return result
