#!/usr/bin/env python3
"""Preserved-ID archived Machine admission. Never delete resources or old claims."""

from __future__ import annotations
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
from types import MappingProxyType

HERE = Path(__file__).resolve().parent
SCHEMA = "cloudbench-archived-reuse-v1"
STORAGE = "retained-volume-fresh-generation"
MARKER = "cloudbench_archived_reuse"
APP = "navi-whisper-lux-bench"
TASK_REF = "1387ae608e7cfb8e3f0a876daae92093f503b465"


def need(value, reason):
    if not value:
        raise ValueError(reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def config_sha(value):
    return sha(canonical(value))


def module(name):
    return runpy.run_path(str(HERE / name))


# The immutable snapshot pins this dependency. Resolve it before native effects,
# so private receipt reads/writes never reload a module inside an observation.
_PRIVATE_IO = module("cloudbench-original600-runner.py")


def private(path):
    return _PRIVATE_IO["read"](path)


def save(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    _PRIVATE_IO["save"](path, value)


def exact_or_save(path, value):
    path = Path(path)
    if path.exists():
        need(json.loads(private(path)) == value, "durable claim changed")
    else:
        save(path, value)


def immutable_image(value):
    need(isinstance(value, str) and "@sha256:" in value, "immutable native image required")
    repository, digest = value.rsplit("@sha256:", 1)
    need(re.fullmatch("[0-9a-f]{64}", digest), "immutable image digest required")
    if ":" in repository.rsplit("/", 1)[-1]:
        repository = repository.rsplit(":", 1)[0]
    return repository, digest


def target_from(machine, ownership, archive):
    mid, vid = machine["id"], ownership["volume_id"]
    need(
        machine["state"] == "stopped" and machine.get("instance_id"),
        "archived candidate must be stopped with exact version",
    )
    cfg = machine["config"]
    mounts = cfg.get("mounts", [])
    need(
        len(mounts) == 1 and mounts[0].get("volume") == vid and mounts[0].get("path") == "/data",
        "same-volume /data binding required",
    )
    need(
        cfg.get("persist_rootfs", cfg.get("guest", {}).get("persist_rootfs", "never")) == "never",
        "fresh rootfs policy required",
    )
    need(
        not any(cfg.get(key) for key in ("containers", "processes", "standbys", "schedule")),
        "unsupported native layout",
    )
    prior_marker = cfg.get("metadata", {}).get(MARKER)
    proof = ownership.get("archived_reuse_proof")
    need(
        prior_marker == (canonical(proof["native_marker"]).decode() if proof else None),
        "candidate successor custody not bound by current archive",
    )
    return dict(
        machine_id=mid,
        volume_id=vid,
        source_instance_id=machine["instance_id"],
        source_config_sha256=config_sha(cfg),
        image_ref=cfg.get("image"),
        name=machine["name"],
        created_at=machine["created_at"],
        region=machine["region"],
        predecessor=ownership,
        archive_sha256=archive,
        prior_marker=prior_marker,
        prior_liabilities="UNRESOLVED; no successful/never-started/provider-cleanup inference",
    )


def prepare_request(archive_runs, inventory_path, cohort, harness_ref, excluded=(), unused_runs=(), parked_runs=(), expired_runs=()):
    need(re.fullmatch("[0-9a-f]{32}", cohort or ""), "exact reserved successor cohort required")
    need(re.fullmatch("[0-9a-f]{40}", harness_ref or ""), "exact harness ref required")
    need(
        len(archive_runs) >= 1 and len(set(map(str, archive_runs))) == len(archive_runs),
        "distinct complete archive runs required",
    )
    recovery_runs = list(unused_runs) + list(parked_runs) + list(expired_runs)
    need(len(set(map(str, recovery_runs))) == len(recovery_runs),
         "duplicate or overlapping reservation recovery run")
    # Validate closed unused reservations first, then exclude their identities
    # only from the older archives' native comparison. Their old claims remain.
    carried = []
    carried_archives = []
    carried_ids = set()
    carried_volumes = set()
    held_scopes = {}
    unused_ids = set()
    recovery_sources = [("cloudbench-unused-reservations.py", run) for run in unused_runs]
    recovery_sources.extend(("cloudbench-parked-reservations.py", run) for run in parked_runs)
    recovery_sources.extend(("cloudbench-reconcile-reservations.py", run) for run in expired_runs)
    for helper, run in recovery_sources:
        result = module(helper)["prepare"](run, inventory_path)
        archive = result["archive"]
        carried_archives.append(archive)
        held = result.get("held_machine_ids", [])
        need(isinstance(held, list) and len(set(held)) == len(held)
             and all(isinstance(mid, str) and re.fullmatch('[0-9a-f]{14}', mid) for mid in held),
             "invalid held reservation partition")
        result_ids = set(held) | {candidate["machine_id"] for candidate in result["candidates"]}
        need(len(result_ids) == len(held) + len(result["candidates"]),
             "overlapping unused reservation partition")
        need(not result_ids & unused_ids, "duplicate unused Machine/Volume")
        unused_ids.update(result_ids)
        if held:
            held_scopes.setdefault(archive["archive_sha256"], set()).update(held)
        for scope in result.get('inherited_held_scopes', []):
            ids = scope['machine_ids']
            need(re.fullmatch('[0-9a-f]{64}', scope['archive_sha256'])
                 and scope.get('reuse_credit') is False and len(ids) == len(set(ids))
                 and all(isinstance(mid, str) and re.fullmatch('[0-9a-f]{14}', mid) for mid in ids),
                 'invalid inherited hold scope')
            held_scopes.setdefault(scope['archive_sha256'], set()).update(ids)
        for candidate in result["candidates"]:
            mid, volume = candidate["machine_id"], candidate["volume_id"]
            need(mid not in carried_ids and volume not in carried_volumes, "duplicate unused Machine/Volume")
            need(candidate["archive_sha256"] == archive["archive_sha256"], "unused reservation archive mismatch")
            need("reservation" not in candidate, "prior reservation is not new capacity credit")
            carried_ids.add(mid)
            carried_volumes.add(volume)
            carried.append(candidate)
    targets = {}
    archives = []
    legacy_ownership = {}
    owner_module = module("cloudbench-archived-owner-stop.py")
    validator = owner_module["prepare"]
    for run in archive_runs:
        archive = owner_module["digest_file"](Path(run) / "export/originals.tar.gz")
        prior_holds = set().union(*(ids for origin, ids in held_scopes.items() if origin != archive))
        plan = validator(
            run, inventory_path, excluded_machines=set(excluded) | carried_ids | prior_holds
        )  # Full archive hashes, membership, joined/deleted controller, protections.
        need(archive == next(d for name, d in plan["inputs"].items() if name.endswith("/originals.tar.gz")),
             "archive changed during scoped eligibility validation")
        archives.append(dict(controller=plan["controller"], archive_sha256=archive, inputs=plan["inputs"]))
        for mid, ownership in plan["archived_ownership"].items():
            legacy_ownership[archive, mid] = ownership
        rows = list(plan["targets"])
        reconsider = (
            (prior_holds & plan["archived_ownership"].keys())
            - set(excluded)
            - carried_ids
            - set(plan["protected_machines"])
        )
        if reconsider:
            raw_inventory = owner_module["raw"](inventory_path, 256 * 1024 * 1024)
            need(
                sha(raw_inventory) == plan["inputs"][str(Path(inventory_path).absolute())],
                "native snapshot changed during held-owner validation",
            )
            machines = owner_module["BASE"]["inventory"](json.loads(raw_inventory))
            native = {machine["id"]: machine for machine in machines}
            need(len(native) == len(machines), "duplicate native inventory identity")
            for mid in sorted(reconsider):
                if mid not in native:
                    continue
                origins = {
                    origin
                    for origin, ids in held_scopes.items()
                    if origin != archive and mid in ids
                }
                proof = plan["archived_ownership"][mid].get("archived_reuse_proof")
                if not isinstance(proof, dict) or not origins <= set(
                    proof.get("predecessor_archive_sha256s", [])
                ):
                    continue
                try:
                    row = owner_module["native_owned_target"](
                        native[mid], plan["archived_ownership"][mid]
                    )
                except ValueError:
                    continue  # An old hold remains; only exact current custody can add eligibility.
                rows.append(row)
        for row in rows:
            if row["machine"]["id"] in excluded:
                continue
            candidate = target_from(row["machine"], row["ownership"], archive)
            mid = candidate["machine_id"]
            if mid in reconsider:
                candidate["historical_hold_revalidation"] = {
                    "held_archive_sha256": sorted(
                        origin
                        for origin, ids in held_scopes.items()
                        if origin != archive and mid in ids
                    ),
                    "current_archive_sha256": archive,
                    "native_sha256": sha(canonical(row["machine"])),
                    "old_hold_released": False,
                    "capacity_credit": 0,
                }
            need(mid not in targets, "duplicate Machine across predecessor archives")
            targets[mid] = candidate
    legacy_hashes = {archive["archive_sha256"] for archive in archives}
    for candidate in carried:
        need(candidate["legacy_archive_sha256"] in legacy_hashes, "unused reservation original archive not supplied")
        ownership = legacy_ownership.get((candidate["legacy_archive_sha256"], candidate["machine_id"]))
        need(
            ownership is not None and candidate["predecessor"] == ownership,
            "unused reservation original ownership differs from verified archive",
        )
        need(
            candidate["volume_id"] == ownership["volume_id"] and candidate["name"] == ownership["name"],
            "unused reservation native identity differs from original owner",
        )
        if candidate["machine_id"] in excluded:
            continue
        need(candidate["machine_id"] not in targets, "duplicate carried Machine")
        targets[candidate["machine_id"]] = candidate
    archives.extend(carried_archives)
    need(len({row["volume_id"] for row in targets.values()}) == len(targets), "duplicate candidate Volume")
    need(targets, "no exact archived candidates")
    result = dict(
        schema=SCHEMA,
        storage_mode=STORAGE,
        app=APP,
        cohort=cohort,
        harness_ref=harness_ref,
        task_ref=TASK_REF,
        archives=archives,
        candidates=sorted(targets.values(), key=lambda r: r["machine_id"]),
        no_delete=True,
        no_old_claim_release=True,
        benchmark_success_inferred=False,
        excluded_machine_ids=sorted(set(excluded)),
    )
    if held_scopes:
        result["held_prior_reservations"] = [
            {"archive_sha256": origin, "machine_ids": sorted(ids), "reuse_credit": False}
            for origin, ids in sorted(held_scopes.items())
        ]
    return result


def validate_request(value, harness_ref=None):
    need(
        value.get("schema") == SCHEMA and value.get("storage_mode") == STORAGE and value.get("app") == APP,
        "foreign reuse request",
    )
    need(
        value.get("task_ref") == TASK_REF and (harness_ref is None or value["harness_ref"] == harness_ref),
        "task/harness pin mismatch",
    )
    need(re.fullmatch("[0-9a-f]{32}", value.get("cohort", "")), "invalid successor cohort")
    rows = value.get("candidates")
    need(isinstance(rows, list) and rows, "missing reuse candidates")
    need(
        len({r["machine_id"] for r in rows}) == len(rows) and len({r["volume_id"] for r in rows}) == len(rows),
        "duplicate Machine/Volume",
    )
    expected_image = immutable_image(value.get("image_ref"))
    for row in rows:
        need(
            immutable_image(row.get("image_ref")) == expected_image,
            "archived Machine image differs from admitted image",
        )
        need(
            re.fullmatch("[0-9a-f]{14}", row["machine_id"]) and re.fullmatch("vol_[A-Za-z0-9]+", row["volume_id"]),
            "invalid resource identity",
        )
        need(
            row["source_instance_id"] and re.fullmatch("[0-9a-f]{64}", row["source_config_sha256"]),
            "missing native version/config",
        )
        need(row["archive_sha256"] in {a["archive_sha256"] for a in value["archives"]}, "unbound predecessor archive")
    return value


def capacity_demand(value, inventory, protected, *, require_reserved=False):
    validate_request(value)
    machines = {m["id"]: m for m in inventory}
    need(len(machines) == len(inventory), "duplicate inventory identity")
    qualified = []
    for row in value["candidates"]:
        need(row["machine_id"] not in protected, "protected Machine cannot be reused")
        current = machines.get(row["machine_id"])
        need(current is not None, "candidate absent from current inventory")
        if require_reserved:
            need(
                row.get("reservation") and row["reservation"]["cohort"] == value["cohort"],
                "capacity cannot credit unreserved archived identity",
            )
        same_source(row, current)
        qualified.append(row["machine_id"])
    need(len(qualified) <= 600, "reuse exceeds original600 logical demand")
    return dict(
        qualified_ids=qualified,
        qualified_reuse_count=len(qualified),
        new_machine_demand=601 - len(qualified),
        original_tasks=600,
        controller_slots=1,
    )


def same_source(row, machine):
    need(
        machine.get("id") == row["machine_id"]
        and machine.get("name") == row["name"]
        and machine.get("created_at") == row["created_at"],
        "Machine creation identity changed",
    )
    need(
        machine.get("state") in (("created", "stopped") if row.get("reservation") else ("stopped",))
        and machine.get("instance_id") == row["source_instance_id"],
        "candidate state/version changed",
    )
    need(config_sha(machine["config"]) == row["source_config_sha256"], "candidate config changed")
    need(
        [m.get("volume") for m in machine["config"].get("mounts", [])] == [row["volume_id"]], "candidate volume changed"
    )
    need(
        machine["config"].get("metadata", {}).get(MARKER) == row.get("prior_marker"),
        "predecessor superseded by durable native successor",
    )


def proof_for(request, row, successor):
    need(
        re.fullmatch("[0-9a-f]{14}", successor.get("controller_id", "")),
        "actual successor controller required before task effects",
    )
    need(
        successor.get("harness_ref") == request["harness_ref"] and successor.get("task_ref") == TASK_REF,
        "successor source/task mismatch",
    )
    need(
        re.fullmatch("[0-9a-f]{32}", successor.get("owner_token", ""))
        and type(successor.get("ordinal")) is int
        and successor["ordinal"] >= 0,
        "exact successor task owner required",
    )
    need(successor.get("run_id") and successor.get("task"), "successor task/run missing")
    claim = sha(canonical([request["cohort"], row["machine_id"], successor]))[:32]
    data = "/data/.cloudbench-generations/" + claim
    marker = dict(
        schema=SCHEMA,
        cohort=request["cohort"],
        claim_id=claim,
        machine_id=row["machine_id"],
        volume_id=row["volume_id"],
        source_excluded=True,
        predecessor_archive_sha256=row["archive_sha256"],
        prior_marker_sha256=sha(row["prior_marker"].encode()) if row.get("prior_marker") else None,
        successor=successor,
    )
    return dict(
        schema=SCHEMA,
        storage_mode=STORAGE,
        claim_id=claim,
        generation_id=claim,
        machine_id=row["machine_id"],
        volume_id=row["volume_id"],
        native_name=row["name"],
        created_at=row["created_at"],
        region=row["region"],
        source_instance_id=row["source_instance_id"],
        source_config_sha256=row["source_config_sha256"],
        predecessor_archive_sha256s=[a["archive_sha256"] for a in request["archives"]],
        successor=successor,
        guest=dict(data_dir=data, repo_dir=data + "/repo"),
        native_marker=marker,
        native_marker_sha256=sha(canonical(marker)),
        old_liabilities=row["prior_liabilities"],
    )


def claim_native(
    api,
    request,
    row,
    successor,
    journal,
    *,
    read_only=False,
    acknowledged=None,
    active=lambda: None,
):
    """Caller owns API/token; lease and current_version are mandatory, no START/DELETE."""
    proof = proof_for(request, row, successor)
    journal = Path(journal)
    journal.mkdir(mode=0o700, parents=True, exist_ok=True)
    exact_or_save(journal / "source-exclusion.json", dict(proof=proof, predecessor=row))
    mid = row["machine_id"]
    url = "/machines/" + mid
    active()
    with api.lease(mid):
        active()
        current = api.request("GET", url)
        active()
        marker = current.get("config", {}).get("metadata", {}).get(MARKER)
        if marker == canonical(proof["native_marker"]).decode():
            need(
                current["state"] in ("stopped", "created"),
                "claimed Machine is not inactive",
            )
            if read_only:
                need(
                    isinstance(acknowledged, dict)
                    and all(
                        current.get(key) == acknowledged.get(key)
                        for key in (
                            "id",
                            "instance_id",
                            "config",
                            "name",
                            "region",
                            "created_at",
                        )
                    ),
                    "read-only claim differs from acknowledged incarnation",
                )
            intent = json.loads(private(journal / "claim-intent.json"))
            need(
                config_sha(current["config"]) == intent["config_sha256"],
                "claimed config drifted after native claim",
            )
            exact_or_save(
                journal / "claim-ack.json",
                dict(
                    instance_id=current["instance_id"],
                    native_marker_sha256=proof["native_marker_sha256"],
                ),
            )
            return proof
        need(not read_only, "read-only claim marker not observed; no CAS replay")
        same_source(row, current)
        exact_or_save(journal / "original-native.json", current)
        config = copy.deepcopy(current["config"])
        config.setdefault("metadata", {})[MARKER] = canonical(
            proof["native_marker"]
        ).decode()
        # Park old startup without launching it; exact old volume stays attached.
        config["init"] = {"cmd": ["sleep", "infinity"]}
        need(
            not (journal / "claim-intent.json").exists(),
            "ambiguous claim update: reconcile only, never rePOST",
        )
        exact_or_save(
            journal / "claim-intent.json",
            dict(
                current_version=current["instance_id"], config_sha256=config_sha(config)
            ),
        )
        ack = api.request(
            "POST",
            url,
            dict(
                config=config, current_version=current["instance_id"], skip_launch=True
            ),
        )
        need(
            ack.get("id") == mid
            and isinstance(ack.get("instance_id"), str)
            and ack["instance_id"]
            and ack["instance_id"] != current["instance_id"]
            and config_sha(ack["config"]) == config_sha(config),
            "claim update ACK mismatch",
        )
        observed = wait_inactive(api, url, ack, timeout=20)
        need(
            observed.get("instance_id") == ack["instance_id"]
            and config_sha(observed["config"]) == config_sha(config)
            and observed["state"] in ("stopped", "created"),
            "claim readback mismatch; retain durable source exclusion",
        )
        exact_or_save(
            journal / "claim-ack.json",
            dict(
                instance_id=observed["instance_id"],
                native_marker_sha256=proof["native_marker_sha256"],
            ),
        )
    return proof


def campaign_candidate_index(request, successor):
    """One task per child; campaign index is distinct from its local ordinal zero."""
    names = request.get("task_names")
    module("cloudbench-original600-runner.py")["campaign_argv"](names, 1)
    match = re.fullmatch(r"r(\d{3})-j(\d{4})", successor.get("campaign_job_id", ""))
    need(match and successor.get("campaign_total_jobs") == 600, "exact original600 campaign child required")
    index = int(match[2]) - 1
    need(0 <= index < 600 and int(match[1]) == index // 200 + 1, "campaign replica/index mismatch")
    need(
        successor.get("ordinal") == 0 and successor.get("task") == names[index % 200],
        "campaign task/local ordinal mismatch",
    )
    need(
        type(successor.get("campaign_attempt")) is int and successor["campaign_attempt"] >= 1,
        "campaign attempt missing",
    )
    return index


def selected_request(request_path, request_sha, successor):
    index_path = os.environ.get("CLOUDBENCH_ARCHIVED_REUSE_INDEX")
    index_sha = os.environ.get("CLOUDBENCH_ARCHIVED_REUSE_INDEX_SHA256")
    need(bool(index_path) == bool(index_sha), "incomplete reuse index binding")
    if index_path:
        match = re.fullmatch(r"r(\d{3})-j(\d{4})", successor.get("campaign_job_id", ""))
        need(match is not None, "exact original600 campaign child required")
        selected = int(match[2]) - 1
        request, row = module("cloudbench-reuse-index.py")["select"](
            request_path, request_sha, index_path, index_sha, selected
        )
        need(
            successor.get("harness_ref") in (None, request["harness_ref"]),
            "indexed harness pin mismatch",
        )
        index = campaign_candidate_index(request, successor)
        need(index == selected, "indexed campaign selection differs")
    else:
        raw = private(request_path)
        need(sha(raw) == request_sha, "reuse request bytes changed")
        request = validate_request(json.loads(raw), successor.get("harness_ref"))
        index = campaign_candidate_index(request, successor)
        row = request["candidates"][index] if index < len(request["candidates"]) else None
    # A retry has a different native task lifetime. It cannot steal its prior
    # attempt's Machine or generation; normal fresh retry admission still applies.
    if successor["campaign_attempt"] > 1:
        row = None
    # All cohort validation and child selection above remain mandatory. Only
    # these immutable fields and the selected private row enter the native claim.
    request = MappingProxyType({
        "harness_ref": request["harness_ref"],
        "cohort": request["cohort"],
        "archives": tuple(MappingProxyType({"archive_sha256": archive["archive_sha256"]})
                          for archive in request["archives"]),
    })
    return request, row


class ClaimReadCancelled(BaseException):
    """Cancellation is propagated only after the new owned lease closes."""


def claim_read_evidence(request, row, successor, output):
    """Bind one old claim CAS and its completed lease without inferring success."""
    import base64
    import stat

    output = Path(output)
    journal, wire = output / "archived-reuse-journal", output / "archived-reuse-wire"
    need(
        {p.name for p in journal.iterdir()}
        == {"source-exclusion.json", "original-native.json", "claim-intent.json"},
        "unknown old claim publication",
    )
    members, data, total = {}, {}, 0
    for root in (journal, wire):
        need(
            root.resolve(strict=True) == root and root.is_dir(),
            "physical old claim root required",
        )
        for path in (root, *sorted(root.rglob("*"))):
            need(len(members) < 256, "old claim member bound exceeded")
            value = path.lstat()
            need(
                path.resolve(strict=True) == path
                and value.st_uid == os.getuid()
                and not value.st_mode & 0o077,
                "private old claim member required",
            )
            if stat.S_ISDIR(value.st_mode):
                members[str(path)] = {
                    "kind": "directory",
                    "identity": [
                        value.st_dev,
                        value.st_ino,
                        value.st_mode,
                        value.st_uid,
                        value.st_gid,
                        value.st_nlink,
                    ],
                }
            else:
                need(
                    stat.S_ISREG(value.st_mode) and value.st_nlink == 1,
                    "old claim alias refused",
                )
                raw = private(path)
                total += len(raw)
                need(
                    total <= 16 * 1024 * 1024 and len(members) < 256,
                    "old claim evidence bound exceeded",
                )
                members[str(path)] = {
                    "kind": "file",
                    "sha256": sha(raw),
                    "identity": [
                        value.st_dev,
                        value.st_ino,
                        value.st_mode,
                        value.st_uid,
                        value.st_gid,
                        value.st_nlink,
                        value.st_size,
                        value.st_mtime_ns,
                        value.st_ctime_ns,
                    ],
                }
                data[path] = raw
    proof = proof_for(request, row, successor)
    need(
        json.loads(data[journal / "source-exclusion.json"])
        == {"proof": proof, "predecessor": row},
        "old claim exclusion differs",
    )
    before = json.loads(data[journal / "original-native.json"])
    same_source(row, before)
    config = copy.deepcopy(before["config"])
    config.setdefault("metadata", {})[MARKER] = canonical(
        proof["native_marker"]
    ).decode()
    config["init"] = {"cmd": ["sleep", "infinity"]}
    need(
        json.loads(data[journal / "claim-intent.json"])
        == {
            "current_version": before["instance_id"],
            "config_sha256": config_sha(config),
        },
        "old claim intent differs",
    )
    records = []
    allowed = {
        "request.json",
        "transport-start.json",
        "http-start.json",
        "stderr.private.log",
        "result.json",
    }
    for folder in wire.iterdir():
        need(
            folder.is_dir() and re.fullmatch("[0-9a-f]{32}", folder.name),
            "unknown old claim request directory",
        )
        paths = list(folder.iterdir())
        need(
            all(
                p.is_file()
                and (p.name in allowed or re.fullmatch(r"[0-9]{4}-wire\.json", p.name))
                for p in paths
            ),
            "unknown old claim request artifact",
        )
        raw_paths = [p for p in paths if p.name.endswith("-wire.json")]
        need(len(raw_paths) == 1, "old claim raw response missing or repeated")
        req, raw = (
            json.loads(data[folder / "request.json"]),
            json.loads(data[raw_paths[0]]),
        )
        body = base64.b64decode(raw["body_b64"], validate=True)
        need(
            req["app"] == APP
            and raw["method"] == req["method"]
            and raw["path"] == req["path"]
            and sha(body) == raw["sha256"]
            and type(raw["status"]) is int
            and 200 <= raw["status"] < 300
            and type(raw["monotonic_ns"]) is int,
            "old claim raw response differs",
        )
        value = json.loads(body)
        if folder / "result.json" in data:
            need(
                json.loads(data[folder / "result.json"]) == value,
                "old claim result differs",
            )
        records.append((req, raw, value))
    need(
        len(records) == 5 and len({r[1]["monotonic_ns"] for r in records}) == 5,
        "unknown old claim request count/order",
    )
    records.sort(key=lambda r: r[1]["monotonic_ns"])
    need(
        [record[1]["status"] for record in records] == [201, 200, 200, 200, 200],
        "old claim response status vector differs",
    )
    lease, prior, update, observed, release = records
    url = "/machines/" + row["machine_id"]
    need(
        [(r[0]["method"], r[0]["path"]) for r in records]
        == [
            ("POST", url + "/lease"),
            ("GET", url),
            ("POST", url),
            ("GET", url),
            ("DELETE", url + "/lease"),
        ],
        "old claim has a foreign writer",
    )
    nonce = lease[2].get("data", {}).get("nonce")
    need(
        isinstance(nonce, str)
        and nonce
        and lease[0]["body"]
        == {"ttl": 180, "description": "archived same-volume successor"}
        and all(
            r[0].get("headers", {}).get("fly-machine-lease-nonce") == nonce
            for r in records[1:]
        ),
        "old claim lease differs",
    )
    need(
        prior[0]["body"] is None
        and observed[0]["body"] is None
        and release[0]["body"] is None
        and prior[2] == before
        and update[0]["body"]
        == {
            "config": config,
            "current_version": before["instance_id"],
            "skip_launch": True,
        },
        "old claim CAS differs",
    )
    ack = update[2]
    need(
        ack["id"] == row["machine_id"]
        and isinstance(ack["instance_id"], str)
        and ack["instance_id"]
        and ack["instance_id"] != before["instance_id"]
        and ack["config"] == config
        and isinstance(observed[2], dict)
        and observed[2].get("id") == row["machine_id"],
        "old claim ACK differs",
    )
    for path, expected in members.items():
        if expected["kind"] == "file":
            need(sha(private(path)) == expected["sha256"], "old claim evidence changed")
    same_claim_evidence(output, members)
    return ack, members


def same_claim_evidence(output, members, *, published=False):
    roots = [
        Path(output) / name
        for name in ("archived-reuse-journal", "archived-reuse-wire")
    ]
    actual = {str(path) for root in roots for path in (root, *root.rglob("*"))}
    allowed = {str(roots[0] / "claim-ack.json")} if published else set()
    need(actual == set(members) | allowed, "old claim membership changed")
    for path, value in members.items():
        observed = Path(path).lstat()
        identity = [
            observed.st_dev,
            observed.st_ino,
            observed.st_mode,
            observed.st_uid,
            observed.st_gid,
            observed.st_nlink,
        ]
        if value["kind"] == "file":
            identity += [observed.st_size, observed.st_mtime_ns, observed.st_ctime_ns]
        need(identity == value["identity"], "old claim member identity changed")
        if value["kind"] == "file":
            need(sha(private(path)) == value["sha256"], "old claim input changed")


def reconcile_claim_read(api, request, row, successor, output, error, request_sha):
    """One fresh leased read after a recorded deadline; never resend the CAS."""
    import math
    import signal
    import threading
    import time
    import sys
    import traceback

    deadline_text = os.environ.get("RUN_BENCH_CAMPAIGN_E2E_DEADLINE_MONOTONIC")
    directory = Path(output) / "archived-reuse-read-reconciliation"
    directory.mkdir(mode=0o700)
    save(
        directory / "original-error.json",
        dict(
            error_type=type(error).__name__,
            error=str(error),
            traceback="".join(
                traceback.format_exception(type(error), error, error.__traceback__)
            ),
        ),
    )
    save(
        directory / "pending.json",
        dict(
            schema="cloudbench-claim-observation-pending-v1",
            error_type=type(error).__name__,
            error=str(error),
            original_failure_retained=True,
            request_sha256=request_sha,
            request_context_sha256=sha(
                canonical(
                    dict(
                        harness_ref=request["harness_ref"],
                        cohort=request["cohort"],
                        archive_sha256s=[
                            entry["archive_sha256"] for entry in request["archives"]
                        ],
                    )
                )
            ),
            selected_row_sha256=sha(canonical(row)),
            successor_sha256=sha(canonical(successor)),
            config_writes=0,
            original_deadline_monotonic=deadline_text,
            original_error_sha256=sha(private(directory / "original-error.json")),
        ),
    )

    def event(name, receipt):
        print(
            json.dumps(
                dict(
                    event=name,
                    receipt=str(receipt),
                    receipt_sha256=sha(private(receipt)),
                    original_failure_retained=True,
                    timely_original_read=False,
                ),
                sort_keys=True,
            ),
            file=sys.stderr,
            flush=True,
        )

    event("CLAIM_OBSERVATION_DEADLINE", directory / "pending.json")
    cancelled, handlers = [], {}

    def active():
        if cancelled:
            raise ClaimReadCancelled("claim read reconciliation cancelled")
        need(deadline_text is not None, "original claim campaign deadline missing")
        value = float(deadline_text)
        need(
            math.isfinite(value) and time.monotonic() < value,
            "original claim campaign deadline exhausted",
        )

    try:
        ack, members = claim_read_evidence(request, row, successor, output)
        save(
            directory / "intent.json",
            dict(
                ack_sha256=sha(canonical(ack)),
                old_membership=members,
                read_only=True,
                original_failure_retained=True,
            ),
        )
        need(
            threading.current_thread() is threading.main_thread(),
            "owned claim read requires main thread",
        )
        for sig in (signal.SIGINT, signal.SIGTERM):
            handlers[sig] = signal.signal(
                sig, lambda sig, _frame: cancelled.append(sig)
            )
        active()
        same_claim_evidence(output, members)
        fresh = NativeAdapter(api.api, directory / "wire")
        proof = claim_native(
            fresh,
            request,
            row,
            successor,
            Path(output) / "archived-reuse-journal",
            read_only=True,
            acknowledged=ack,
            active=active,
        )
        active()
        same_claim_evidence(output, members, published=True)
        save(
            directory / "complete.json",
            dict(
                status="READ_RECONCILED_AFTER_RECORDED_DEADLINE",
                original_failure_retained=True,
                timely_original_read=False,
                proof_sha256=sha(canonical(proof)),
                config_writes=0,
            ),
        )
        active()
        event("READ_RECONCILED_AFTER_RECORDED_DEADLINE", directory / "complete.json")
    except BaseException as failure:
        save(
            directory / "failed.json",
            dict(
                error_type=type(failure).__name__,
                original_failure_retained=True,
                config_writes=0,
                cancelled_signals=cancelled,
            ),
        )
        event("CLAIM_READ_RECONCILIATION_FAILED", directory / "failed.json")
        raise
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
    try:
        active()
    except BaseException as failure:
        save(
            directory / "failed.json",
            dict(
                error_type=type(failure).__name__,
                original_failure_retained=True,
                config_writes=0,
                cancelled_signals=cancelled,
            ),
        )
        event("CLAIM_READ_RECONCILIATION_FAILED", directory / "failed.json")
        raise
    return proof


def allocate(request_path, request_sha, ordinal, successor, output, token):
    need(successor["ordinal"] == ordinal, "successor ordinal mismatch")
    need(successor.get("harness_ref") is not None, "successor harness pin required")
    request, row = selected_request(request_path, request_sha, successor)
    if row is None:
        return None
    need(row.get("reservation"), "unreserved candidate cannot be allocated")
    api = NativeAdapter(
        module("cloudbench-original-volume-capture.py")["Fly"](APP, token),
        Path(output) / "archived-reuse-wire",
    )
    try:
        proof = claim_native(
            api, request, row, successor, Path(output) / "archived-reuse-journal"
        )
    except ObservationDeadline as error:
        proof = reconcile_claim_read(
            api, request, row, successor, output, error, request_sha
        )
    exact_or_save(Path(output) / "archived-reuse-proof.json", proof)
    return proof


def read_proof(filename):
    value = json.loads(private(filename))
    need(value["schema"] == SCHEMA and value["storage_mode"] == STORAGE, "foreign reuse proof")
    claim = value["claim_id"]
    need(re.fullmatch("[0-9a-f]{32}", claim), "unsafe generation claim")
    need(
        value["guest"]
        == dict(
            data_dir="/data/.cloudbench-generations/" + claim,
            repo_dir="/data/.cloudbench-generations/" + claim + "/repo",
        ),
        "unsafe physical generation mapping",
    )
    need(sha(canonical(value["native_marker"])) == value["native_marker_sha256"], "native marker digest changed")
    return value


# Share one validation contract with bounded native effects; no third-party imports.
_EFFECTS = runpy.run_path(
    str(HERE / "cloudbench-archived-reuse-effects.py"),
    init_globals={
        "VALIDATION": {
            key: globals()[key]
            for key in (
                "need",
                "canonical",
                "sha",
                "config_sha",
                "module",
                "private",
                "save",
                "exact_or_save",
                "validate_request",
                "same_source",
                "MARKER",
                "SCHEMA",
            )
        }
    },
)
NativeAdapter = _EFFECTS["NativeAdapter"]
reserve_cohort = _EFFECTS["reserve_cohort"]
retire_native = _EFFECTS["retire_native"]
wait_inactive = _EFFECTS["wait_inactive"]
ObservationDeadline = _EFFECTS["ObservationDeadline"]
NativeWireDeadline = _EFFECTS["NativeWireDeadline"]
NativeRejected = _EFFECTS["NativeRejected"]


def external_command(proof, command):
    return module("cloudbench-archived-reuse-transport.py")["external_command"](proof, command, canonical(proof))


def fenced_native_effect(api, mid, operation, journal):
    """Fence a predecessor effect by owner, native incarnation and durable intent."""
    need(operation in ("stop", "destroy"), "unsupported predecessor effect")
    journal = Path(journal)
    journal.mkdir(mode=0o700, parents=True, exist_ok=True)
    with api.lease(mid):
        url = "/machines/" + mid
        current = api.request("GET", url)
        need(current["id"] == mid and current.get("instance_id"), "exact native identity required")
        need(
            not current["config"].get("metadata", {}).get(MARKER),
            "archived successor forbids predecessor native effect",
        )
        # A config update creates a new incarnation; its separately owned effect
        # must not overwrite the earlier operation's receipt or unknown outcome.
        incarnation = sha(canonical([mid, current["instance_id"], current["config"]]))
        out = journal / incarnation
        out.mkdir(mode=0o700, exist_ok=True)
        intent = out / "intent.json"
        if operation == "stop" and current["state"] in ("stopped", "created"):
            exact_or_save(
                out / "stopped.json",
                dict(machine_id=mid, instance_id=current["instance_id"], config_sha256=config_sha(current["config"])),
            )
            return
        need(not intent.exists(), "unknown predecessor native effect; reconcile only")
        save(intent, dict(machine=current, operation=operation))
        try:
            result = api.request(
                "DELETE" if operation == "destroy" else "POST",
                url + ("?force=true" if operation == "destroy" else "/stop"),
            )
        except NativeRejected as rejected:
            # A recorded no-effect rejection (rate limit) performed nothing:
            # retain the intent and receipt, then admit the caller's bounded retry.
            attempt = sum(1 for _ in out.glob("rejected-*")) + 1
            rejection = out / f"rejected-{attempt:04d}"
            rejection.mkdir(mode=0o700)
            save(rejection / "receipt.json", json.loads(private(rejected.receipt)))
            os.replace(intent, rejection / "intent.json")
            raise
        save(out / "ack.json", result)


def main():
    import sys

    if sys.argv[1:2] == ["wire"]:
        directory = Path(sys.argv[2])
        request = json.loads(private(directory / "request.json"))
        Fly = module("cloudbench-original-volume-capture.py")["Fly"]
        api = object.__new__(Fly)
        api.app = request["app"]
        api.authorization = os.environ["CLOUDBENCH_WIRE_AUTH"]
        api.base = os.environ["CLOUDBENCH_WIRE_BASE"]
        api.loopback = os.environ["CLOUDBENCH_WIRE_LOOPBACK"] == "1"
        observer = NativeAdapter(api, directory)
        observer.perform_wire(request)
        return
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    prepare = sub.add_parser("prepare")
    prepare.add_argument("--archive-run", action="append", required=True, type=Path)
    prepare.add_argument("--unused-reservation-run", action="append", default=[], type=Path)
    prepare.add_argument("--parked-reservation-run", action="append", default=[], type=Path)
    prepare.add_argument("--expired-reservation-run", action="append", default=[], type=Path)
    prepare.add_argument("--inventory", required=True, type=Path)
    prepare.add_argument("--cohort", required=True)
    prepare.add_argument("--harness-ref", required=True)
    prepare.add_argument("--image-ref", required=True)
    prepare.add_argument("--output", required=True, type=Path)
    prepare.add_argument("--exclude-machine", action="append", default=[])
    allocate_parser = sub.add_parser("allocate")
    for name in ("request", "request-sha", "ordinal", "successor", "output"):
        allocate_parser.add_argument("--" + name, required=True)
    retire = sub.add_parser("retire")
    retire.add_argument("--proof", required=True)
    retire.add_argument("--journal", required=True)
    retire.add_argument("--audit", type=Path)
    mapping = sub.add_parser("map-command")
    mapping.add_argument("--proof", required=True)
    mapping.add_argument("--command", required=True)
    export = sub.add_parser("export-file")
    export.add_argument("--proof", required=True)
    export.add_argument("--remote", required=True)
    export.add_argument("--local", required=True)
    credit = sub.add_parser("capacity-credit")
    credit.add_argument("--task", required=True)
    transport = sub.add_parser("transport")
    transport.add_argument("--proof", required=True)
    transport.add_argument("args", nargs=argparse.REMAINDER)
    effect = sub.add_parser("fenced-effect")
    effect.add_argument("--machine", required=True)
    effect.add_argument("--operation", choices=["stop", "destroy"], required=True)
    effect.add_argument("--journal", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == "fenced-effect":
        need(re.fullmatch("[0-9a-f]{14}", args.machine), "exact Machine required")
        journal = Path(args.journal)
        journal.mkdir(mode=0o700, parents=True, exist_ok=True)
        api = NativeAdapter(
            module("cloudbench-original-volume-capture.py")["Fly"](APP, os.environ["FLY_API_TOKEN"]), journal / "wire"
        )
        fenced_native_effect(api, args.machine, args.operation, journal)
        return
    if args.action == "export-file":
        module("cloudbench-archived-reuse-transport.py")["export_file"](
            read_proof(args.proof), args.remote, args.local, external_command
        )
        return
    if args.action == "transport":
        proof = read_proof(args.proof)
        values = args.args
        if values[:1] == ["--"]:
            values = values[1:]
        need(
            "--machine" in values and values[values.index("--machine") + 1] == proof["machine_id"],
            "transport exact Machine mismatch",
        )
        if values[:2] == ["ssh", "console"]:
            need("-C" in values, "interactive archived task SSH is not supported")
            position = values.index("-C") + 1
            values[position] = external_command(proof, values[position])
        elif values[:2] == ["ssh", "sftp"]:
            for position, value in enumerate(values):
                if value == "/data" or value.startswith("/data/"):
                    need("/../" not in value and not value.endswith("/.."), "unsafe logical guest path")
                    raise ValueError("use namespace-bound export-file for archived /data reads; writes are forbidden")
        else:
            raise ValueError("unsupported archived guest transport")
        for value in values:
            sys.stdout.buffer.write(value.encode() + b"\0")
        return
    if args.action == "capacity-credit":
        successor = dict(
            ordinal=0,
            task=args.task,
            harness_ref=os.environ.get("REVIEWED_OPERATOR_SOURCE_REF"),
            campaign_job_id=os.environ.get("RUN_BENCH_CAMPAIGN_JOB_ID"),
            campaign_total_jobs=int(os.environ.get("RUN_BENCH_CAMPAIGN_TOTAL_JOBS", "0")),
            campaign_attempt=int(os.environ.get("RUN_BENCH_CAMPAIGN_ATTEMPT", "1")),
        )
        request, row = selected_request(
            os.environ["CLOUDBENCH_ARCHIVED_REUSE_REQUEST"],
            os.environ["CLOUDBENCH_ARCHIVED_REUSE_REQUEST_SHA256"], successor,
        )
        if row is None:
            print(0)
        else:
            need(
                row.get("reservation", {}).get("cohort") == request["cohort"],
                "capacity requires exact reserved native candidate",
            )
            print(1)
        return
    if args.action == "map-command":
        print(external_command(read_proof(args.proof), args.command))
        return
    if args.action == "retire":
        proof = read_proof(args.proof)
        api = NativeAdapter(
            module("cloudbench-original-volume-capture.py")["Fly"](APP, os.environ["FLY_API_TOKEN"]),
            Path(args.journal) / "wire",
        )
        retire_native(api, proof, args.journal)
        if args.audit is not None:
            module("cloudbench-retained-successor.py")["record"](
                args.proof, Path(args.journal) / "retained-terminal.json", args.audit
            )
        return
    if args.action == "allocate":
        successor = json.loads(private(args.successor))
        token = os.environ.get("FLY_API_TOKEN", "")
        need(token, "canonical Fly credential required")
        proof = allocate(args.request, args.request_sha, int(args.ordinal), successor, args.output, token)
        print(proof["machine_id"] if proof else "")
        return
    value = prepare_request(
        args.archive_run,
        args.inventory,
        args.cohort,
        args.harness_ref,
        args.exclude_machine,
        args.unused_reservation_run,
        args.parked_reservation_run,
        args.expired_reservation_run,
    )
    value["image_ref"] = args.image_ref
    validate_request(value)
    save(args.output, value)
    print(
        json.dumps(
            dict(
                path=str(args.output),
                sha256=sha(private(args.output)),
                candidates=len(value["candidates"]),
                storage_mode=STORAGE,
            )
        )
    )


if __name__ == "__main__":
    main()
