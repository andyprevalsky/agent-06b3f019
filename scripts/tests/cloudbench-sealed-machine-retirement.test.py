#!/usr/bin/env python3
"""Owning recurrence: an unsealed peer cannot retain a fully sealed Machine.

Run against the original controller to observe RED, then this candidate for
GREEN. Native Fly is an exact-ID journaled fixture; no paid/model work occurs.
"""
import argparse
import hashlib
import json
import os
import re
import runpy
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE_HOST_GUARD_SECONDS = runpy.run_path(str(ROOT / "agents/benchmarks/fixture_host_guard.py"))["FIXTURE_HOST_GUARD_SECONDS"]
BASH = "/opt/homebrew/bin/bash" if Path("/opt/homebrew/bin/bash").exists() else shutil.which("bash")
OWNER = "a" * 32
APP = "sealed-retirement-fixture"
MIDS = ("11111111111111", "22222222222222")
VOLS = ("vol_11111111111111", "vol_22222222222222")


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) + "\n" if isinstance(value, (dict, list)) else value)


def fields(path, value):
    write(path, "".join(f"{k}={v}\n" for k, v in value.items()))


def extract(text, name):
    start = text.index(name + "() {")
    # Python dict braces in a heredoc do not end the shell function.
    lines, delimiter = [], None
    for line in text[start:].splitlines(keepends=True):
        lines.append(line)
        if delimiter:
            if line.strip() == delimiter:
                delimiter = None
            continue
        match = re.search(r"<<[\"']?([A-Za-z0-9_]+)[\"']?", line)
        if match:
            delimiter = match.group(1)
        elif line == "}\n":
            return "".join(lines)
    raise AssertionError("unterminated function " + name)


def fixture(base, healthy=0, inverse=None):
    registry = base / "owners" / OWNER
    audit = base / "audits" / OWNER
    run = base / "runs" / "failed-two"
    registry.mkdir(parents=True)
    (audit / "fresh").mkdir(parents=True)
    (registry / "clones").mkdir()
    names = ["member-one", "member-two"]
    meta = {"version": "2", "app": APP, "fleet_owner_token": OWNER, "host": "fixture-host", "pid": "777", "pid_start": "fixture-birth", "run_id": run.name, "workspace_root": str(ROOT), "runs_root": str(run.parent), "audit_dir": str(audit), "owned_ids_file": str(run / "owned.ids"), "owned_names_file": str(run / "owned.names"), "cleanup_policy": "reap"}
    fields(registry / "meta", meta)
    fields(audit / "meta", meta)
    write(registry / "guest-cleanup-unconfirmed", "peer guest latch\n")
    if inverse == "reconnect-runtime-failure":
        (registry / "guest-cleanup-unconfirmed").unlink()
    write(registry / "runtime-evidence-unconfirmed", "peer runtime latch\n")
    write(run / "_batch/benches.json", [{"name": n} for n in names])
    lifecycle = {"version": 1, "status": "failed", "controller_exit_code": 1, "fleet_owner_token": OWNER, "run_id": run.name}
    write(run / "_batch/lifecycle.json", lifecycle)
    # A public pure schema builder supplies a small valid provenance document.
    pmod = runpy.run_path(str(ROOT / "scripts/cloudbench_execution_provenance.py"))
    matrix = pmod["build_task_matrix"]([n + "=real" for n in names])
    config = {"schema_version": pmod["CONFIG_SCHEMA_VERSION"], "values": {"task_count": "2", "task_matrix_sha256": matrix["sha256"]}}
    config["sha256"] = pmod["canonical_sha256"](config)
    provenance = {"schema_version": pmod["EXECUTION_SCHEMA_VERSION"], "base_sha": "5" * 40, "workspace_patch_sha256": "none", "controller_snapshot": {"schema_version": pmod["SNAPSHOT_SCHEMA_VERSION"], "sha256": "c" * 64}, "config": config}
    write(run / "execution-provenance.json", provenance)
    write(run / "execution-task-matrix.json", matrix)
    state = {"machines": {}, "volumes": {}, "journal": [], "config_reads": 0}
    for index, (name, mid, vol) in enumerate(zip(names, MIDS, VOLS)):
        clone = "cloudbench-" + name
        token = OWNER + "-" + str(index)
        fields(registry / "clones" / clone, {"name": clone, "id": mid, "volume_id": vol})
        fields(audit / "fresh" / clone, {"version": "1", "fleet_owner_token": OWNER, "run_id": run.name, "app": APP, "source": "fresh-clone", "source_machine_id": "abcdefabcdefab", "clone_name": clone, "machine_id": mid, "volume_id": vol, "disposition": "owned"})
        out = run / name
        write(out / ".cid", "clone " + mid + "\n")
        write(out / "status-proxy.port", str(15000 + index) + "\n")
        write(out / "worker-clones.ids", "")
        write(out / "guest-shutdown.confirmed", run.name + "\n")
        own = {"version": 1, "machine_id": mid, "run_token": token}
        write(out / "runtime-evidence.owner.json", own)
        config = {"env": {"CLOUDBENCH_RUN_TOKEN": token, "REF": provenance["base_sha"], "LOCAL_PATCH_SHA256": provenance["workspace_patch_sha256"]}, "mounts": [{"volume": vol}], "init": {"cmd": ["/bin/true"]}}
        state["machines"][mid] = {"id": mid, "name": clone, "state": "started", "config": config, "guest": str(base / "guests" / mid), "created_at": "2026-10-07T00:00:00Z", "instance_id": "fixture-" + str(index)}
        state["volumes"][vol] = {"id": vol, "state": "created", "attached_machine_id": mid, "name": clone, "region": "iad", "size_gb": 20, "created_at": "2026-10-07T00:00:00Z"}
        if index != healthy and inverse != "two-sealed":
            write(out / "runtime-evidence.pending", own)
            continue
        bundle = out / "remote-logs/runtime-evidence"
        result = {"tasks": [{"name": name, "world_model_mode": "real", "benchmark_status": "FAILED", "passed": False, "execution_provenance": provenance}], "summary": {"total": 1, "passed": 0, "failed": 1}, "execution_provenance": provenance}
        write(bundle / "services.json", {"status": "stopped", "env": {"worker_processes": 1}})
        write(bundle / "run.json", result)
        write(out / "cloudbench-run.json", result)
        fields(bundle / ("cloudbench-stack-cleanup-" + token + ".status"), {"state": "clean", "token": token, "stack_pid": "123", "stack_birth": "proc-start:1"})
        for relative in ("stack.log", "logs/backend.log", "logs/worker.log"):
            write(bundle / relative, "sealed fixture original bytes\n")
        manifest = {"version": 1, "machine_id": mid, "run_token": token, "files": {str(p.relative_to(bundle)): {"bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in bundle.rglob("*") if p.is_file()}}
        write(bundle / "manifest.json", manifest)
        guest = Path(state["machines"][mid]["guest"])
        for p in bundle.rglob("*"):
            if p.is_file() and p.name != "manifest.json":
                q = guest / "repo/.context/cloudbench" / p.relative_to(bundle)
                q.parent.mkdir(parents=True, exist_ok=True)
                q.write_bytes(p.read_bytes())
        write(guest / "bench.log", "RUNSTAMP-" + token + "\n")
        write(guest / "cloudbench-driver.state", "running\n" if inverse == "live" else "exited\n")
        write(guest / ("cloudbench-driver-clean-" + token + ".ack"), token + "\n")
        fields(guest / ("cloudbench-interrupt-cleanup-" + token + ".status"), {"version": "1", "state": "clean", "token": token})
        if inverse == "foreign":
            state["machines"][mid]["name"] = "foreign-member"
        if inverse == "reused":
            config["env"]["CLOUDBENCH_RUN_TOKEN"] = "b" * 32 + "-0"
        if inverse == "corrupt":
            write(bundle / "logs/backend.log", "changed original\n")
        if inverse == "symlink":
            p = bundle / "logs/backend.log"
            target = base / "foreign-bytes"
            target.write_bytes(p.read_bytes())
            p.unlink()
            p.symlink_to(target)
    state["healthy"] = MIDS[healthy]
    if inverse == "large-inventory":
        state["machines"]["33333333333333"] = {"id": "33333333333333", "name": "foreign-inventory-member", "state": "started", "config": {"metadata": {"padding": "x" * (2 * 1024 * 1024)}}}
    state["inverse"] = inverse
    write(base / "native.json", state)
    return registry, run


FAKE = r'''import json,os,shlex,subprocess,sys
from pathlib import Path
p=Path(os.environ['FIXTURE_STATE']); s=json.loads(p.read_text()); op=sys.argv[1]; args=sys.argv[2:]
if op=='details':
 m=s['machines'].get(args[0]) or s.get('tombstones',{}).get(args[0]);
 if m is None: sys.exit(1)
 print(m['state'],m['name'],'fdaa::1');sys.exit(0)
if op=='config':
 s['config_reads']+=1
 m=s['machines'].get(args[0]) or s.get('tombstones',{})[args[0]]
 if s['inverse']=='config-change' and s['config_reads']>1: m['config']['env']['changed']='1'
 p.write_text(json.dumps(s)); print(json.dumps(m['config']));sys.exit(0)
if op=='status':
 m=s['machines'].get(args[0]) or s.get('tombstones',{}).get(args[0]);
 if m is None: sys.exit(1)
 print('Machine ID: '+m['id']+'\nState: '+m['state']+'\n\nVM\n  ID = '+m['id']+'\n  Name = '+m['name']+'\n  State = '+m['state']+'\n  Created = '+m['created_at']+'\n  Instance ID = '+m['instance_id']+'\n\nEvent Logs');sys.exit(0)
if args[:2]==['volumes','show']:
 v=s['volumes'].get(args[2]);
 if v is None: sys.exit(1)
 print(json.dumps(v));sys.exit(0)
if args[:2]==['machines','list']:
 if s['inverse']=='over-bound-inventory':
  sys.stdout.write('[{"id":"33333333333333","padding":"'+('x'*(128*1024*1024))+'"}]');sys.exit(0)
 print(json.dumps(list(s['machines'].values())));sys.exit(0)
if args[:2]==['ssh','console']:
 mid=args[args.index('--machine')+1]; m=s['machines'][mid]
 command=shlex.split(args[args.index('-C')+1]);code=command[2]
 code=code.replace("root=Path('/data')",'root=Path('+repr(m['guest'])+')')
 env=dict(os.environ,FLY_MACHINE_ID=mid,**m['config']['env'])
 r=subprocess.run([sys.executable,'-c',code],env=env,capture_output=True,text=True)
 sys.stdout.write(r.stdout);sys.exit(r.returncode)
if args[:2]==['machine','destroy']:
 mid=args[3];m=s['machines'].pop(mid);s['journal'].append(['machine-destroy',mid])
 if s['inverse']=='tombstone':
  m['state']='destroyed';s.setdefault('tombstones',{})[mid]=m
 for v in s['volumes'].values():
  if v['attached_machine_id']==mid:v['attached_machine_id']=None
 p.write_text(json.dumps(s));sys.exit(0)
raise SystemExit(2)
'''


def run_case(controller, healthy, inverse=None, absence_transition=None):
    with tempfile.TemporaryDirectory() as temporary:
        base = Path(temporary).resolve()
        registry, run = fixture(base, healthy, inverse)
        write(base / "fake.py", FAKE)
        original_native = json.loads((base / "native.json").read_text())["machines"][MIDS[healthy]]
        if inverse in ("intent-before", "intent-reused", "tombstone-reused", "tombstone-listed"):
            helper = ROOT / "scripts/cloudbench-sealed-machine-retirement.py"
            common = ["--registry", str(registry), "--machine-id", MIDS[healthy], "--app", APP]
            command = subprocess.run(["python3", str(helper), "probe-command", *common], capture_output=True, text=True, check=True)
            proof = subprocess.run(["python3", str(base / "fake.py"), "native", "ssh", "console", "--machine", MIDS[healthy], "-C", command.stdout.strip()], env=dict(os.environ, FIXTURE_STATE=str(base / "native.json")), capture_output=True, text=True, check=True)
            native = json.loads((base / "native.json").read_text())
            for name, value in (("proof.json", json.loads(proof.stdout)), ("config.json", native["machines"][MIDS[healthy]]["config"]), ("volume.json", native["volumes"][VOLS[healthy]]), ("machines.json", list(native["machines"].values()))):
                write(base / name, value)
            subprocess.run(["python3", str(helper), "prepare", *common, "--config-json", str(base / "config.json"), "--machines-json", str(base / "machines.json"), "--volume-json", str(base / "volume.json"), "--guest-proof-json", str(base / "proof.json")], capture_output=True, text=True, check=True)
            if inverse == "intent-reused":
                native["machines"][MIDS[healthy]]["config"]["env"]["CLOUDBENCH_RUN_TOKEN"] = "b" * 32 + "-0"
                write(base / "native.json", native)
            elif inverse in ("tombstone-reused", "tombstone-listed"):
                original = native["machines"].pop(MIDS[healthy])
                original["state"] = "destroyed"
                native["tombstones"] = {MIDS[healthy]: original}
                native["volumes"][VOLS[healthy]]["attached_machine_id"] = None
                if inverse == "tombstone-reused":
                    original["instance_id"] = "reused-terminal-instance"
                else:
                    native["machines"][MIDS[healthy]] = original
                write(base / "native.json", native)
        before = {str(p): p.read_bytes() for d in (registry / "clones", base / "audits" / OWNER / "fresh") for p in d.iterdir()}
        for p in (registry / "meta", registry / "guest-cleanup-unconfirmed", registry / "runtime-evidence-unconfirmed", run / "_batch/lifecycle.json"):
            if p.exists():
                before[str(p)] = p.read_bytes()
        source = controller.read_text()
        names = ["recover_exact_stale_fleet_owner", "fleet_registry_build_guest_recovery_plan"]
        if "fleet_recovery_retire_one_sealed_machine()" in source:
            names += ["fleet_recovery_retire_one_sealed_machine", "fleet_recovery_verify_retired_sealed_machine", "fleet_recovery_sealed_machine_reconnect_state"]
        script = "\n".join(extract(source, name) for name in names) + r'''
registry_meta_value() { python3 -c 'import sys;print(dict(x.split("=",1) for x in open(sys.argv[1]).read().splitlines())[sys.argv[2]])' "$@"; }
fleet_registry_cleanup_state() { printf quarantined; }
registry_owner_alive() { [ "${FIXTURE_LIVE_OWNER:-0}" = 1 ]; }
release_cleanup_disk_reserve() { return 0; }
acquire_registry_recovery_lock() { return 0; }
fleet_recovery_reconnect_guest_shutdowns() {
    local receipt="$FLEET_OWNERSHIP_ROOT/$FIXTURE_OWNER/sealed-machine-retirements/$FIXTURE_SELECTED.intent.json" status
    if [ -f "$receipt" ]; then
        if fleet_recovery_sealed_machine_reconnect_state "$FLEET_OWNERSHIP_ROOT/$FIXTURE_OWNER" "$FIXTURE_SELECTED" "$FIXTURE_VOLUME"; then return 0; else status=$?; fi
        [ "$status" -eq 2 ] || return 1
    fi
    [ "${FIXTURE_RECONNECT_FAIL:-0}" != 1 ] || return 1
    return 0
}
fleet_recovery_confirm_runtime_evidence() { return 1; }
registry_machine_details() { python3 "$FIXTURE_BASE/fake.py" details "$1"; }
machine_config_exact_read() { python3 "$FIXTURE_BASE/fake.py" config "$1"; }
machine_status_exact_read() { python3 "$FIXTURE_BASE/fake.py" status "$1"; }
fly_with_timeout() { shift; python3 "$FIXTURE_BASE/fake.py" native "$@"; }
recover_exact_stale_fleet_owner "$FIXTURE_OWNER"
'''
        # Keep the stub at the provider/process boundaries; the owning recovery,
        # complete mapping, source validator, guest program and receipt are real.
        write(base / "control.sh", script)
        env = dict(os.environ, FIXTURE_BASE=str(base), FIXTURE_STATE=str(base / "native.json"), FIXTURE_OWNER=OWNER, FIXTURE_SELECTED=MIDS[healthy], FIXTURE_VOLUME=VOLS[healthy], APP=APP, FLEET_OWNERSHIP_ROOT=str(base / "owners"), FLEET_AUDIT_ROOT=str(base / "audits"), FLEET_OWNER_HOST="fixture-host", SEALED_MACHINE_RETIREMENT_HELPER=str(ROOT / "scripts/cloudbench-sealed-machine-retirement.py"), SOURCE_HELPER="", POOL_CLAIMS_DIR="", FIXTURE_LIVE_OWNER="1" if inverse == "owner-live" else "0", FIXTURE_RECONNECT_FAIL="1" if inverse in ("reconnect-runtime-failure", "reconnect-guest-failure") else "0")
        completed = subprocess.run([BASH, str(base / "control.sh")], env=env, capture_output=True, text=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
        assert completed.returncode == 1, (completed.returncode, completed.stderr)
        state = json.loads((base / "native.json").read_text())
        for path, original in before.items():
            assert Path(path).read_bytes() == original, path
        receipt = registry / "sealed-machine-retirements" / (MIDS[healthy] + ".json")
        expected_retirement = inverse in (None, "intent-before", "reconnect-runtime-failure", "large-inventory", "tombstone", "two-sealed")
        if expected_retirement:
            assert state["journal"] == [["machine-destroy", MIDS[healthy]]], completed.stdout + completed.stderr
            assert MIDS[1 - healthy] in state["machines"] and len(state["volumes"]) == 2
            r = json.loads(receipt.read_text())
            assert r["proof_credit"] == 0 and r["full_task_count"] == 2 and r["volume_retained"] is True
            if inverse == "tombstone":
                assert r["machine_absence"] == "exact-native-destroyed-unlisted"
            assert state["volumes"][VOLS[healthy]]["attached_machine_id"] is None
            if inverse == "reconnect-runtime-failure":
                assert not (registry / "guest-cleanup-unconfirmed").exists()
            # Repeating ordinary recovery keeps the complete failed owner and
            # receipt, and does not spend it to retire the unsealed peer.
            again = subprocess.run([BASH, str(base / "control.sh")], env=env, capture_output=True, text=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
            assert again.returncode == 1
            assert json.loads((base / "native.json").read_text())["journal"] == state["journal"]
            if absence_transition:
                # The ordinary wrapper verifies CURRENT native endpoint state
                # independently of the historical receipt's description.
                state = json.loads((base / "native.json").read_text())
                historical_bytes = receipt.read_bytes()
                if absence_transition == "destroyed-to-not-found":
                    state.pop("tombstones", None)
                else:
                    tombstone = dict(original_native, state="destroyed")
                    if absence_transition == "not-found-to-reused-destroyed":
                        tombstone["instance_id"] = "foreign-reused-instance"
                    elif absence_transition == "destroyed-to-live":
                        tombstone["state"] = "started"
                    elif absence_transition == "destroyed-to-unknown":
                        tombstone["state"] = "starting"
                    state["tombstones"] = {MIDS[healthy]: tombstone}
                    if absence_transition == "not-found-to-listed-destroyed":
                        state["machines"][MIDS[healthy]] = tombstone
                    elif absence_transition == "not-found-to-missing-config":
                        del tombstone["config"]
                write(base / "native.json", state)
                prefix = script.rsplit('recover_exact_stale_fleet_owner "$FIXTURE_OWNER"', 1)[0]
                verify_script = prefix + '\nfleet_recovery_verify_retired_sealed_machine ' + ' '.join(shlex.quote(x) for x in (str(registry), MIDS[healthy], VOLS[healthy])) + '\n'
                checked = subprocess.run([BASH, "-c", verify_script], env=env, capture_output=True, text=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
                accepted = absence_transition in ("destroyed-to-not-found", "not-found-to-destroyed")
                assert checked.returncode == (0 if accepted else 1), checked.stderr
                assert receipt.read_bytes() == historical_bytes
                assert json.loads((base / "native.json").read_text())["journal"] == state["journal"]
                if accepted:
                    current = "exact-native-not-found" if absence_transition == "destroyed-to-not-found" else "exact-native-destroyed-unlisted"
                    warning = "SEALED_RETIREMENT_ABSENCE_TRANSITION=" + r["machine_absence"] + "->" + current
                    assert warning in checked.stderr, "missing diagnostic for " + absence_transition
                return {"transition": absence_transition, "accepted": accepted, "native_proof_required": True, "receipt_unchanged": True, "provider_mutations": 0, "proof_credit": 0}
            # Crash after destroy but before receipt publication: the durable
            # intent must resume without another provider mutation. This is the
            # same verifier used by ordinary recovery's reconnect loop.
            receipt.unlink()
            prefix = script.rsplit('recover_exact_stale_fleet_owner "$FIXTURE_OWNER"', 1)[0]
            verify_script = prefix + '\nfleet_recovery_verify_retired_sealed_machine ' + ' '.join(shlex.quote(x) for x in (str(registry), MIDS[healthy], VOLS[healthy])) + '\n'
            resumed = subprocess.run([BASH, "-c", verify_script], env=env, capture_output=True, text=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
            assert resumed.returncode == 0 and receipt.exists(), resumed.stderr
            state = json.loads((base / "native.json").read_text())
            assert state["journal"] == [["machine-destroy", MIDS[healthy]]]
            # An ID that reappears after this receipt must fail verification.
            state["machines"][MIDS[healthy]] = {"name": "reused-foreign", "state": "started"}
            write(base / "native.json", state)
            reused = subprocess.run([BASH, "-c", verify_script], env=env, capture_output=True, text=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
            assert reused.returncode == 1
            assert json.loads((base / "native.json").read_text())["journal"] == state["journal"]
        else:
            assert not state["journal"] and not receipt.exists()
        if inverse == "over-bound-inventory":
            assert "retirement refused at stage=native-inventory-input" in completed.stderr
        if inverse == "large-inventory":
            assert "33333333333333" in state["machines"]
        return {"healthy_ordinal": healthy, "inverse": inverse, "exit": completed.returncode, "machine_only_retired": len(state["journal"]), "volumes_retained": len(state["volumes"]), "full_ledger_unchanged": True, "latches_unchanged": True, "proof_credit": 0}


def run_absence_kind_controls(controller=ROOT / "scripts/run-bench-fleet"):
    cases = ("destroyed-to-not-found", "not-found-to-destroyed", "not-found-to-reused-destroyed", "not-found-to-listed-destroyed", "not-found-to-missing-config", "destroyed-to-live", "destroyed-to-unknown")
    return [run_case(controller, 0, "tombstone" if reason.startswith("destroyed-") else None, reason) for reason in cases]


def run_recurrence(controller=ROOT / "scripts/run-bench-fleet"):
    outcomes = [run_case(controller, h) for h in (0, 1)]
    outcomes += [run_case(controller, 0, reason) for reason in ("intent-before", "intent-reused", "reconnect-runtime-failure", "reconnect-guest-failure", "live", "owner-live", "foreign", "reused", "corrupt", "symlink", "config-change")]
    outcomes.append(run_case(controller, 0, "large-inventory"))
    outcomes.append(run_case(controller, 0, "over-bound-inventory"))
    outcomes += [run_case(controller, 0, reason) for reason in ("tombstone", "tombstone-reused", "tombstone-listed", "two-sealed")]
    outcomes += run_absence_kind_controls(controller)
    helper = runpy.run_path(str(ROOT / "scripts/cloudbench-sealed-machine-retirement.py"))
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary).resolve() / "over-bound.json"
        with path.open("wb") as stream:
            stream.truncate(helper["NATIVE_INVENTORY_LIMIT"] + 1)
        try:
            helper["obj"](path, helper["NATIVE_INVENTORY_LIMIT"])
        except AssertionError:
            pass
        else:
            raise AssertionError("over-bound native inventory was accepted")
        try:
            helper["obj"](path)
        except AssertionError:
            pass
        else:
            raise AssertionError("receipt default bound was widened")
    return {"status": "PASS", "cases": outcomes, "native_inventory_over_bound_retained": True, "receipt_default_limit_unchanged": True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--controller", type=Path, default=ROOT / "scripts/run-bench-fleet")
    args = parser.parse_args()
    print(json.dumps(run_recurrence(args.controller), sort_keys=True))


if __name__ == "__main__":
    main()
