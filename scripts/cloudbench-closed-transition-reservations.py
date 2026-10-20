#!/usr/bin/env python3
"""Eligibility from closed version-fenced transitions; never replay an old effect."""

import copy
import runpy
from pathlib import Path

HERE = Path(__file__).resolve().parent
H = runpy.run_path(str(HERE / "cloudbench-archived-machine-reuse.py"))
need, canonical, config_sha = (H[key] for key in ("need", "canonical", "config_sha"))


def read_failures(group, mid):
    """Only an empty raw response to an exact read can be an unknown observation."""
    for item in group["malformed_json"]:
        relative = item["path"].removeprefix(group["root"] + "/")
        parts = relative.split("/")
        need(
            len(parts) == 3
            and parts[0] == "archived-reuse-wire"
            and parts[2] == "0001-wire.json"
            and len(parts[1]) == 32
            and all(c in "0123456789abcdef" for c in parts[1])
            and item["bytes"] == 0
            and item["sha256"] == H["sha"](b""),
            "unknown malformed claim artifact",
        )
        prefix = "/".join(parts[:2]) + "/"
        request = group["files"].get(prefix + "request.json", {})
        need(
            request.get("method") == "GET"
            and request.get("path") == "/machines/" + mid
            and request.get("app") == H["APP"]
            and request.get("body") is None
            and prefix + "result.json" not in group["files"],
            "malformed response is not an isolated read",
        )
        need(
            [
                p
                for p in group["hashes"]
                if p.startswith(group["root"] + "/" + prefix)
                and p.endswith("-wire.json")
            ]
            == [item["path"]],
            "ambiguous read response",
        )
    return copy.deepcopy(group["malformed_json"])


def unchanged(before, current, update, intent, records, mid, expected):
    url = "/machines/" + mid
    need(
        current.get("state") == "stopped"
        and all(
            current.get(k) == before.get(k)
            for k in ("id", "instance_id", "config", "name", "created_at", "region")
        ),
        "prior native state changed",
    )
    need(
        intent
        == {
            "current_version": before["instance_id"],
            "config_sha256": config_sha(expected),
        }
        and update["body"]
        == {
            "config": expected,
            "current_version": before["instance_id"],
            "skip_launch": True,
        },
        "unknown CAS is not fenced to prior instance",
    )
    posts = [r for r in records if r[1]["method"] == "POST" and r[1]["path"] == url]
    need(len(posts) == 1 and posts[0][1] == update, "multiple or missing prior CAS")
    at = posts[0][0]
    need(
        type(at) is int
        and all(
            req["app"] == H["APP"]
            and (req["method"], req["path"])
            in (
                ("GET", url),
                ("POST", url),
                ("POST", url + "/lease"),
                ("DELETE", url + "/lease"),
            )
            for _, req, _, _ in records
        ),
        "unknown prior writer action",
    )
    nonce = update.get("headers", {}).get("fly-machine-lease-nonce")
    need(
        isinstance(nonce, str)
        and nonce
        and any(
            type(t) is int
            and t < at
            and req["method"] == "POST"
            and req["path"] == url + "/lease"
            and type(code) is int
            and 200 <= code < 300
            and isinstance(value, dict)
            and value.get("data", {}).get("nonce") == nonce
            for t, req, value, code in records
        ),
        "prior CAS lease proof missing",
    )
    need(
        any(
            type(t) is int
            and t < at
            and req["method"] == "GET"
            and req["path"] == url
            and req.get("headers", {}).get("fly-machine-lease-nonce") == nonce
            and type(code) is int
            and 200 <= code < 300
            and isinstance(value, dict)
            and all(
                value.get(k) == before.get(k)
                for k in ("id", "instance_id", "config", "name", "region", "created_at")
            )
            for t, req, value, code in records
        ),
        "prior CAS pre-read missing",
    )
    return {
        "stage": "UNCHANGED_PRIOR_STATE_WITH_UNKNOWN_EFFECT",
        "old_response_status": posts[0][3],
        "old_outcome": "UNKNOWN_OR_ERROR_RETAINED",
        "old_liabilities": "UNRESOLVED",
        "capacity_credit": 0,
    }


def omitted(context, row, current, inputs, claimed):
    """A closed recovered admission omitted this row; it never became task authority."""
    incomplete, C = (
        runpy.run_path(str(HERE / "cloudbench-incomplete-reservations.py")),
        runpy.run_path(str(HERE / "cloudbench-reconcile-reservations.py")),
    )
    U = C["U"]
    mid = row["machine_id"]
    need(
        mid not in claimed and mid in {r["machine_id"] for r in context["held_rows"]},
        "omitted row has a task claim",
    )
    H["same_source"](row, current)
    archive = next(
        a
        for a in context["original"]["archives"]
        if a["archive_sha256"] == row["archive_sha256"]
    )
    need("expired_admission" in archive, "positive prior reservation ancestry required")
    C["validate_handoff"](archive)
    inputs.update(archive["inputs"])
    prior = C["plan"](archive["expired_admission"]["directory"])
    inputs.update(prior["inputs"])
    prior_original = next(
        r for r in prior["original_request"]["candidates"] if r["machine_id"] == mid
    )
    reserved = next(
        (r for r in prior["closed_request"]["candidates"] if r["machine_id"] == mid),
        None,
    )
    if reserved is not None:
        U["validate_candidate"](
            Path(prior["directory"]),
            prior_original,
            reserved,
            current,
            prior["original_request"]["cohort"],
            C["SOURCE"],
            inputs,
        )
    else:
        entry = next(r for r in prior["accepted"] if r["machine_id"] == mid)
        need(
            all(
                current.get(k) == entry["ack"].get(k)
                for k in ("id", "instance_id", "config", "name", "region", "created_at")
            ),
            "prior positive ACK changed",
        )
    expected_proof = {
        k: v
        for k, v in archive["expired_admission"].items()
        if k != "history_membership"
    }
    expected_proof.update(
        original_failure_retained=True,
        positive_held_ack=reserved is None,
        capacity_credit=0,
    )
    need(
        row["expired_reservation_proof"] == expected_proof,
        "expired ancestry proof differs",
    )
    directory = Path(context["directory"]) / "archived-reuse-reservations" / mid
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
            p.name in allowed or p.name.startswith("held-") and p.name.endswith(".json")
            for p in directory.iterdir()
        ),
        "unknown reservation effect artifact",
    )
    before = C["obj"](directory / "original-native.json", inputs)
    H["same_source"](row, before)
    request = context["original"]
    marker = dict(
        schema=H["SCHEMA"],
        state="RESERVED",
        cohort=request["cohort"],
        machine_id=mid,
        volume_id=row["volume_id"],
        source_excluded=True,
        archive_sha256=row["archive_sha256"],
        harness_ref=request["harness_ref"],
    )
    need(
        C["obj"](directory / "source-exclusion.json", inputs)
        == {"predecessor": row, "marker": marker},
        "reservation exclusion differs",
    )
    intent = C["obj"](directory / "intent.json", inputs)
    need(
        C["obj"](directory / "dispatch-entered.json", inputs)
        == {"intent_sha256": H["sha"](canonical(intent))},
        "reservation dispatch differs",
    )
    wire, partials, observations = incomplete["classified_wire"](directory, mid, inputs)
    need(not observations, "unknown reservation observation")
    records = [
        (
            raw.get("monotonic_ns") if raw else None,
            req,
            value,
            raw.get("status") if raw else None,
        )
        for req, raw, value, _ in wire
    ]
    posts = [
        r
        for r in records
        if r[1]["method"] == "POST" and r[1]["path"] == "/machines/" + mid
    ]
    need(len(posts) == 1, "unknown reservation CAS count")
    expected = copy.deepcopy(before["config"])
    expected.setdefault("metadata", {})[H["MARKER"]] = canonical(marker).decode()
    expected["init"] = {"cmd": ["sleep", "infinity"]}
    proof = unchanged(before, current, posts[0][1], intent, records, mid, expected)
    proof["pre_dispatch_incomplete_calls"] = partials
    candidate = copy.deepcopy(row)
    candidate["closed_transition_proof"] = proof
    return candidate
