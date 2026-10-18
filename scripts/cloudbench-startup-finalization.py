#!/usr/bin/env python3
"""Finalize a verified expired startup before supervisor publication; never invent JOINED."""

import argparse
import fcntl
import json
import os
import runpy
import signal
import stat
import subprocess
import tarfile
import time
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
F = runpy.run_path(str(HERE / "cloudbench-controller-payload-finalization.py"))
B, R = F["B"], F["R"]
need, read, save, sha = (R[k] for k in ("need", "read", "save", "sha"))
SOURCE = "59ab01b35aa91521e105a3d48e1587007aa347ad"
STEP = b'v24.22.0\nGATE_CONTROLLER_CLIENT version=0.4.115 sha256=5041b9a563fff170fda4238b47048e9a5e714fc7ed2304668fd44bcdcd3bef83\nTraceback (most recent call last):\n  File "<string>", line 45, in <module>\n  File "<string>", line 26, in decode_remote_file\nAssertionError: original payload transfer deadline expired\n'


def obj(path):
    return json.loads(read(path))


def archive_proof(state):
    out = Path(state["out"])
    export = out / "export"
    marker_sha = F["verified_export"](state)
    record = obj(export / "launch.json")
    manifest = obj(export / "manifest.json")
    need(
        record["source_ref"] == SOURCE
        and record["machine_id"] == state["machine_id"]
        and record["caller"] == obj(export / "caller.json"),
        "export launch binding differs",
    )
    need(
        record["caller"]["pid"] == state["caller"]["gate_pid"]
        and record["caller"]["birth"] == state["caller"]["gate_birth"],
        "export gate owner differs",
    )
    root = Path(state["source_root"])
    collector = runpy.run_path(str(root / "scripts/cloudbench-controller-export.py"))
    collector["verify"](
        SimpleNamespace(
            archive=export / "originals.tar.gz",
            manifest=export / "manifest.json",
            record=export / "launch.json",
            caller=export / "caller.json",
            ref=SOURCE,
            machine=state["machine_id"],
            app=R["APP"],
            image=record["image"],
        )
    )
    need(not manifest.get("excluded"), "complete startup archive required")
    identity = Path(state["caller"]["identity_path"]).name
    forbidden = {
        "context/" + identity,
        "context/" + str(Path(identity).with_suffix(".tasks.json")),
        "context/" + str(Path(identity).with_suffix(".terminal.json")),
    }
    need(
        not forbidden & manifest["files"].keys(),
        "supervisor runtime publication exists",
    )
    need(
        not any(
            n.startswith(("context/fleet/runs/", "context/benchmarks/campaigns/"))
            for n in manifest["files"]
        ),
        "task campaign publication exists",
    )
    need(
        not any(
            name.startswith("context/original600-supervisor.")
            for name in manifest["files"]
        ),
        "unexpected supervisor runtime publication exists",
    )
    with tarfile.open(export / "originals.tar.gz", "r:gz") as archive:
        member = archive.getmember("controller-output/step-1.log")
        need(
            member.isfile() and member.size == len(STEP),
            "startup failure record differs",
        )
        raw = archive.extractfile(member).read(len(STEP) + 1)
        need(raw == STEP, "unsupported startup failure")
    source = state["source_hashes"]["cloudbench-original600-runner.py"]
    need(
        source == sha((root / "scripts/cloudbench-original600-runner.py").read_bytes()),
        "startup publisher source changed",
    )
    gate_log = read(out / "gate.private.log").decode()
    need(
        (
            "GATE_EXPORT_VERIFIED machine="
            + state["machine_id"]
            + " directory="
            + str(export)
            + " resource_release_verified=false"
        )
        in gate_log,
        "canonical gate export completion required",
    )
    remote_log = read(Path(state["remote_gate_log_path"]))
    need(
        any(
            "app[" + state["machine_id"] + "]" in line
            and line.endswith("GATE_EXPORT exit=0")
            for line in remote_log.decode().splitlines()
        ),
        "exact remote gate export completion required",
    )
    proof = {
        "schema": "expired-before-supervisor-proof-v1",
        "source_ref": SOURCE,
        "config_sha256": state["config_sha256"],
        "config_path": state["config_path"],
        "caller": state["caller"],
        "source_root": state["source_root"],
        "source_pins": state["source_pins"],
        "operator_ref": state["operator_ref"],
        "operator_pins": state["operator_pins"],
        "caller_sha256": sha(read(out / "caller.json")),
        "owner_capture_sha256": sha(
            read(out / "threshold-owner.identity.private.json")
        ),
        "authority_sha256": sha(read(out / "authority.private.json")),
        "started_at_epoch": state["epoch"],
        "original_deadline": state["deadline"],
        "supervisor_published": False,
        "supervisor_joined": False,
        "gate_reap": "OBSERVED_ORIGINAL_PARENT_REAP",
        "step1_sha256": sha(raw),
        "supervisor_absent_paths": sorted(forbidden),
        "export_marker_sha256": marker_sha,
        "archive_sha256": manifest["archive_sha256"],
        "manifest_sha256": sha(read(export / "manifest.json")),
        "launch_sha256": sha(read(export / "launch.json")),
        "gate_log_sha256": sha(read(out / "gate.private.log")),
        "remote_gate_log_sha256": sha(remote_log),
        "remote_gate_log_path": state["remote_gate_log_path"],
    }
    return json.loads(json.dumps(proof, sort_keys=True, allow_nan=False))


def check(args):
    out = args.run_directory.absolute()
    config_raw = read(args.config)
    need(sha(config_raw) == args.config_sha256, "config hash differs")
    config = json.loads(config_raw)
    need(config["source_ref"] == SOURCE, "unsupported startup source")
    root = Path(config["source_root"])
    old_pins = B["source_identity"](root, SOURCE, config["source_files"])
    public = runpy.run_path(str(root / "scripts/run-original600-controller.py"))
    source_hashes = public["source"](root, SOURCE)
    need(
        source_hashes == config["source_files"], "original complete source pins differ"
    )
    runner = runpy.run_path(str(root / "scripts/cloudbench-original600-runner.py"))
    runner["validate_source_members"](root, SOURCE, source_hashes)
    need(
        runner["REMOTE_LAUNCH"]
        .splitlines()[25]
        .strip()
        .startswith("assert time.time()<v['epoch']+5400"),
        "known prepublication source boundary differs",
    )
    caller = obj(out / "caller.json")
    auth = obj(out / "authority.private.json")
    ownership = obj(out / "export/disposable-controller.ownership.json")
    epoch = config["started_at_epoch"]
    need(
        caller["source_ref"] == auth["source_ref"] == SOURCE
        and caller["epoch"] == epoch
        and caller["deadline"] == epoch + 5400 <= time.time(),
        "original startup clock differs",
    )
    need(
        caller["authority_sha256"]
        == ownership["authority_sha256"]
        == sha(read(out / "authority.private.json"))
        and auth["cleanup_owner_pid"] == caller["pid"]
        and auth["cleanup_owner_birth"] == caller["birth"]
        and auth["output_directory"] == str(out / "export"),
        "original authority differs",
    )
    need(
        auth["app"] == R["APP"] and caller["task_ref"] == R["TASK_REF"],
        "original task/app differs",
    )
    owner = B["process_identity"](caller["pid"])
    recorded_owner = obj(out / "threshold-owner.identity.private.json")
    need(
        recorded_owner["caller"] == caller
        and recorded_owner["config_sha256"] == args.config_sha256
        and recorded_owner["owner"] == owner,
        "retained live caller identity differs",
    )
    need(
        owner["birth"] == caller["birth"]
        and str(root / "scripts/run-original600-controller.py") in owner["argv"]
        and str(root / "scripts/run-original600-controller.py")
        in recorded_owner["validated_scripts"],
        "original live caller differs",
    )
    state = {
        "out": str(out),
        "remote_gate_log_path": str(args.remote_gate_log.absolute()),
        "source_root": str(root),
        "source_ref": SOURCE,
        "config_sha256": args.config_sha256,
        "config_path": str(args.config.absolute()),
        "caller": caller,
        "owner": owner,
        "machine_id": ownership["machine"]["id"],
        "machine": ownership["machine"],
        "authority": auth,
        "epoch": epoch,
        "deadline": caller["deadline"],
        "source_hashes": source_hashes,
    }
    need(F["gate_gone"](state), "original gate has not been reaped")
    need(
        state["machine_id"] not in auth["protected_machines"]
        and ownership["volume"]["id"] not in auth["protected_volumes"],
        "protected startup resource",
    )
    need(
        ownership["workspace_sha256"]
        == sha(read(out / "export/workspace-volume.ownership.json")),
        "workspace binding differs",
    )
    for name in (
        "cleanup-call.intent.json",
        "terminal.json",
        "export/disposable-controller.release.json",
        "export/disposable-delete-machine.intent.json",
        "export/disposable-delete-volume.intent.json",
    ):
        if not (
            getattr(args, "resume_release", False)
            or getattr(args, "check_release", False)
        ):
            need(
                not os.path.lexists(out / name), "prior cleanup effect exists; no retry"
            )
    names = (
        "cloudbench-startup-finalization.py",
        "cloudbench-controller-payload-finalization.py",
        "cloudbench-resume-controller-payload.py",
        "cloudbench-original600-runner.py",
        "cloudbench-original-volume-capture.py",
        "run-original600-controller.py",
    )
    hashes = {n: sha((HERE / n).read_bytes()) for n in names}
    pins = B["source_identity"](HERE.parent, args.operator_ref, hashes)
    state["operator_ref"] = args.operator_ref
    state["operator_hashes"] = hashes
    state["operator_pins"] = pins
    state["source_pins"] = old_pins
    paths = [
        args.config,
        args.remote_gate_log,
        out / "caller.json",
        out / "authority.private.json",
        out / "threshold-owner.identity.private.json",
        out / "gate.private.log",
        out / "export/disposable-controller.ownership.json",
        out / "export/workspace-volume.ownership.json",
    ]
    paths.extend(Path(value["path"]) for value in auth["env_files"].values())
    state["input_pins"] = {
        str(Path(path).absolute()): {
            "fingerprint": B["fingerprint"](path),
            "sha256": sha(read(path)),
        }
        for path in paths
    }
    state["proof"] = archive_proof(state)
    if getattr(args, "resume_release", False) or getattr(args, "check_release", False):
        state["prior_release"] = prior_release(state)
    return state


def pin_check(state):
    for path, expected in {**state["source_pins"], **state["operator_pins"]}.items():
        need(B["fingerprint"](path) == expected, "startup source changed")
    for path, expected in state["input_pins"].items():
        need(
            B["fingerprint"](path) == expected["fingerprint"]
            and sha(read(path)) == expected["sha256"],
            "startup evidence changed",
        )


def release_check(state, proof):
    out = Path(state["out"])
    export = out / "export"
    need(
        F["verified_export"](state) == proof["export_marker_sha256"],
        "export changed before release",
    )
    closure = obj(out / "cleanup-call.intent.json")
    need(
        closure["failure_proof_sha256"]
        == sha(read(Path(closure["failure_proof_path"]))),
        "failure closure changed",
    )
    need(
        obj(Path(closure["failure_proof_path"])) == proof, "saved failure proof differs"
    )
    need(
        closure["supervisor_published"] is False
        and closure["supervisor_joined"] is False
        and closure["gate_joined"] is True,
        "startup closure differs",
    )
    release = obj(export / "disposable-controller.release.json")
    workspace = obj(export / "workspace-volume.ownership.json")
    need(
        release["machine_id"] == state["machine_id"]
        and release["machine_deleted"] is True
        and release["volume_id"] == workspace["volume_id"]
        and release["volume_disposition"] in ("ABSENT", "pending_destroy", "destroyed"),
        "canonical startup release differs",
    )
    return release


def finalize(args, state):
    out = Path(state["out"])
    fd = os.open(
        out / "payload-finalizer.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
    )
    cancelled = []
    handlers = {
        s: signal.signal(s, lambda s, _: cancelled.append(s))
        for s in (signal.SIGINT, signal.SIGTERM)
    }
    try:
        info = os.fstat(fd)
        need(
            stat.S_ISREG(info.st_mode)
            and info.st_uid == os.geteuid()
            and info.st_nlink == 1
            and not info.st_mode & 0o077,
            "private finalizer lock required",
        )
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        need(check(args) == state, "startup proof changed")
        journal = out / "startup-finalization"
        journal.mkdir(mode=0o700)
        save(
            journal / "intent.json",
            {
                "operator_ref": args.operator_ref,
                "operator_hashes": state["operator_hashes"],
                "operator_pins": state["operator_pins"],
                "pid": os.getpid(),
                "birth": R["birth"](os.getpid()),
                "owner": state["owner"],
            },
        )
        save(journal / "failure-proof.json", state["proof"])
        proof_sha = sha(read(journal / "failure-proof.json"))
        api = F["RecordedAPI"](F["api_for"](state), state, journal)
        current = api.request("GET", "/machines/" + state["machine_id"])
        need(
            all(
                current.get(k) == state["machine"].get(k)
                for k in ("id", "instance_id", "config", "name", "region")
            ),
            "startup native identity changed",
        )
        need(not cancelled, "startup finalization cancelled before cleanup")
        need(check(args) == state, "startup authority changed before cleanup")
        need(not cancelled, "cancelled before cleanup intent")
        closure = {
            "action": "cleanup",
            "machine": state["machine_id"],
            "gate_joined": True,
            "supervisor_published": False,
            "supervisor_joined": False,
            "failure_proof_sha256": proof_sha,
            "failure_proof_path": str(journal / "failure-proof.json"),
            "export_verified_file": state["proof"]["export_marker_sha256"],
        }
        save(out / "cleanup-call.intent.json", closure)
        command = F["cleanup_command"](state)
        save(journal / "cleanup.intent.json", {"argv": command, "no_supervisor": True})
        env = dict(os.environ, FLY_API_TOKEN=F["selected_token"](state))
        with (journal / "cleanup.log").open("xb") as log:
            need(not cancelled, "cancelled before cleanup dispatch")
            pin_check(state)
            need(not cancelled, "cancelled at cleanup dispatch")
            child = subprocess.Popen(
                command,
                cwd=state["source_root"],
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
            try:
                save(
                    journal / "cleanup.child.json",
                    {
                        "pid": child.pid,
                        "birth": R["birth"](child.pid)
                        if child.poll() is None
                        else None,
                    },
                )
            finally:
                code = child.wait()
        save(
            journal / "cleanup.joined.json",
            {"exit_code": code, "owned_join": True, "cancelled_signals": cancelled},
        )
        need(not cancelled, "cleanup joined after cancellation; retain caller")
        need(code == 0, "cleanup child failed; no retry")
        release = release_check(state, state["proof"])
        not_found = api.transport.api.__globals__["NotFound"]
        for kind, identifier in (
            ("machines", state["machine_id"]),
            ("volumes", release["volume_id"]),
        ):
            need(not cancelled, "cancelled before release observation")
            try:
                native = api.request("GET", "/" + kind + "/" + identifier)
                need(
                    isinstance(native, dict), "non404 native observation must be object"
                )
            except not_found:
                raw = obj(journal / f"wire-{api.sequence:06d}.raw.json")
                need(
                    raw["status"] == 404
                    and raw["method"] == "GET"
                    and raw["path"] == "/" + kind + "/" + identifier,
                    "release absence not confirmed",
                )
                native = None
            need(
                released_native(native, state, kind, identifier),
                "resource release still pending",
            )
        save(journal / "release.verified.json", release)

        def closed():
            pin_check(state)
            need(not cancelled, "cancelled before caller retirement")
            need(F["gate_gone"](state), "gate parent ownership changed")
            need(
                release_check(state, state["proof"]) == release,
                "startup release changed",
            )

        retired = F["retire_caller"](state, journal, closed)
        terminal = {
            "status": "FAILED_BEFORE_SUPERVISOR",
            "machine": state["machine_id"],
            "source_ref": SOURCE,
            "started_at_epoch": state["epoch"],
            "original_deadline": state["deadline"],
            "supervisor_published": False,
            "supervisor_joined": False,
            "gate_reap": "OBSERVED_ORIGINAL_PARENT_REAP",
            "failure_proof_sha256": proof_sha,
            "failure_proof_path": str(journal / "failure-proof.json"),
            "controller_cleanup_exit_code": code,
            "release": release,
            "caller_disposition": retired,
            "benchmark_success_inferred": False,
            "finalizer_operator_ref": args.operator_ref,
        }
        save(out / "terminal.json", terminal)
        save(journal / "complete.json", terminal)
        return terminal
    finally:
        for s, h in handlers.items():
            signal.signal(s, h)
        os.close(fd)


def prior_release(state):
    out = Path(state["out"])
    journal = out / "startup-finalization"
    expected = {
        "intent.json",
        "failure-proof.json",
        "cleanup.intent.json",
        "cleanup.child.json",
        "cleanup.joined.json",
        "cleanup.log",
    } | {
        f"wire-{n:06d}.{kind}.json"
        for n in (1, 2)
        for kind in ("request", "raw", "decoded")
    }
    need(
        {p.name for p in journal.iterdir()} == expected,
        "unsupported prior startup journal",
    )
    files = {name: sha(read(journal / name)) for name in sorted(expected)}
    intent = obj(journal / "intent.json")
    roots = [
        Path(p).parent.parent
        for p in intent["operator_pins"]
        if p.endswith("/scripts/cloudbench-startup-finalization.py")
    ]
    need(
        len(roots) == 1
        and intent["operator_hashes"]["cloudbench-startup-finalization.py"]
        == "6335250eb296ae7be79d65f4fed1f8d8dfaaf8791aa25f7f05d7d57a9004f421",
        "unsupported prior startup operator",
    )
    B["source_identity"](roots[0], intent["operator_ref"], intent["operator_hashes"])
    try:
        birth = R["birth"](intent["pid"])
    except FileNotFoundError:
        birth = None
    need(birth != intent["birth"], "prior startup owner still live")
    joined = obj(journal / "cleanup.joined.json")
    need(
        joined == {"exit_code": 0, "owned_join": True, "cancelled_signals": []},
        "cleanup not positively joined",
    )
    need(
        obj(journal / "cleanup.intent.json")
        == {"argv": F["cleanup_command"](state), "no_supervisor": True},
        "prior cleanup command differs",
    )
    proof = obj(journal / "failure-proof.json")
    current = dict(state["proof"])
    for key in ("operator_ref", "operator_pins"):
        current[key] = proof[key]
    need(current == proof, "prior startup proof changed")
    release_check(state, proof)
    for n in (1, 2):
        request = obj(journal / f"wire-{n:06d}.request.json")
        raw = obj(journal / f"wire-{n:06d}.raw.json")
        import base64

        body = base64.b64decode(raw["body_b64"], validate=True)
        need(
            request
            == {
                "method": "GET",
                "path": "/machines/" + state["machine_id"],
                "body": None,
            }
            and raw["method"] == "GET"
            and raw["path"] == request["path"]
            and raw["status"] == 200
            and raw["bytes"] == len(body)
            and raw["sha256"] == sha(body)
            and json.loads(body) == obj(journal / f"wire-{n:06d}.decoded.json"),
            "prior observation differs",
        )
    need(
        all(
            obj(journal / "wire-000001.decoded.json").get(k) == state["machine"].get(k)
            for k in ("id", "instance_id", "config", "name", "region")
        ),
        "prior initial native identity differs",
    )
    need(
        released_native(
            obj(journal / "wire-000002.decoded.json"),
            state,
            "machines",
            state["machine_id"],
        ),
        "prior release refusal not exact destroyed tombstone",
    )
    return {
        "files": files,
        "operator_ref": intent["operator_ref"],
        "proof": proof,
        "source_root": str(roots[0]),
        "operator_hashes": intent["operator_hashes"],
    }


def released_native(native, state, kind, identifier):
    if native is None:
        return True
    if kind == "volumes":
        return native.get("id") == identifier and native.get("state") in (
            "pending_destroy",
            "destroyed",
        )
    return native.get("state") == "destroyed" and all(
        native.get(k) == state["machine"].get(k)
        for k in ("id", "instance_id", "config", "name", "region")
    )


def resume_release(args, state):
    out = Path(state["out"])
    fd = os.open(out / "payload-finalizer.lock", os.O_RDWR | os.O_NOFOLLOW)
    cancelled = []
    handlers = {
        sig: signal.signal(sig, lambda sig, _: cancelled.append(sig))
        for sig in (signal.SIGINT, signal.SIGTERM)
    }
    try:
        info = os.fstat(fd)
        need(
            stat.S_ISREG(info.st_mode)
            and info.st_uid == os.geteuid()
            and info.st_nlink == 1
            and not info.st_mode & 0o077,
            "private finalizer lock required",
        )
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        need(
            not os.path.lexists(out / "terminal.json")
            and not os.path.lexists(out / "startup-release-observation"),
            "prior continuation exists; no replay",
        )
        need(check(args) == state, "release continuation proof changed")
        journal = out / "startup-release-observation"
        journal.mkdir(mode=0o700)
        save(
            journal / "intent.json",
            {
                "operator_ref": args.operator_ref,
                "operator_pins": state["operator_pins"],
                "prior": state["prior_release"],
                "no_effect_replay": True,
            },
        )
        api = F["RecordedAPI"](F["api_for"](state), state, journal)
        release = release_check(state, state["prior_release"]["proof"])
        not_found = api.transport.api.__globals__["NotFound"]
        for kind, identifier in (
            ("machines", state["machine_id"]),
            ("volumes", release["volume_id"]),
        ):
            need(not cancelled, "release continuation cancelled")
            try:
                native = api.request("GET", "/" + kind + "/" + identifier)
                need(
                    isinstance(native, dict), "non404 native observation must be object"
                )
            except not_found:
                raw = obj(journal / f"wire-{api.sequence:06d}.raw.json")
                need(
                    raw["status"] == 404
                    and raw["method"] == "GET"
                    and raw["path"] == "/" + kind + "/" + identifier,
                    "unconfirmed release absence",
                )
                native = None
            need(
                released_native(native, state, kind, identifier),
                "resource release still pending",
            )

        def closed():
            pin_check(state)
            need(
                not cancelled and F["gate_gone"](state),
                "release continuation ownership changed",
            )
            need(
                prior_release(state) == state["prior_release"],
                "prior release journal changed",
            )

        closed()
        retired = F["retire_caller"](state, journal, closed)
        terminal = {
            "status": "FAILED_BEFORE_SUPERVISOR",
            "machine": state["machine_id"],
            "source_ref": SOURCE,
            "started_at_epoch": state["epoch"],
            "original_deadline": state["deadline"],
            "gate_reap": state["prior_release"]["proof"]["gate_reap"],
            "supervisor_published": False,
            "supervisor_joined": False,
            "controller_cleanup_exit_code": 0,
            "release": release,
            "failure_proof_path": str(out / "startup-finalization/failure-proof.json"),
            "failure_proof_sha256": sha(
                read(out / "startup-finalization/failure-proof.json")
            ),
            "prior_finalizer_operator_ref": state["prior_release"]["operator_ref"],
            "finalizer_operator_ref": args.operator_ref,
            "caller_disposition": retired,
            "no_effect_replay": True,
            "benchmark_success_inferred": False,
        }
        save(out / "terminal.json", terminal)
        save(journal / "complete.json", terminal)
        return terminal
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
        os.close(fd)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    m = p.add_mutually_exclusive_group(required=True)
    m.add_argument("--check", action="store_true")
    m.add_argument("--run", action="store_true")
    m.add_argument("--resume-release", action="store_true")
    m.add_argument("--check-release", action="store_true")
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--config-sha256", required=True)
    p.add_argument("--run-directory", type=Path, required=True)
    p.add_argument("--operator-ref", required=True)
    p.add_argument("--remote-gate-log", type=Path, required=True)
    args = p.parse_args()
    os.umask(0o077)
    state = check(args)
    print(
        json.dumps(
            {"status": "CHECKED", "provider_calls": 0, "proof": state["proof"]}
            if args.check or args.check_release
            else resume_release(args, state)
            if args.resume_release
            else finalize(args, state),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
