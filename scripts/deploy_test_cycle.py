#!/usr/bin/env python3
"""Source-bound staged /deploy validation. Does not merge or deploy production.

Every selected worker is launched concurrently. Worker commands own their isolated
checkout/services; the coordinator never removes host safeguards or grants skips.
/RCA receipts use deploy_failure_report.decision, the shared ownership policy.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from fnmatch import fnmatchcase
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time
import uuid

from deploy_test_process import CANCEL, cancellation_handlers, run_command
from deploy_test_result import MAX_RECEIPT_BYTES, preserve_contract, validate as validate_result, validate_recipe
from deploy_test_isolation import validate as validate_isolation

ROOT = Path(__file__).resolve().parents[1]
QUICK = {"format", "eslint", "typescript", "backend-structural", "application-structural"}
REQUIRED_QUICK = {"format", "eslint", "typescript"}
TERMINAL_OK = {"PASS", "SKIP"}
NAME = re.compile(r"^[A-Za-z0-9_.-]+$")


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def read(path: Path) -> dict:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"expected object: {path}")
    return value


def write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


@contextmanager
def exclusive(directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def source(root: Path) -> dict:
    def git(*args: str) -> bytes:
        return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True).stdout
    sha = git("rev-parse", "HEAD").decode().strip()
    # Include untracked/non-ignored files; state/logs must live in ignored .context.
    paths = git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split(b"\0")
    h = hashlib.sha256(sha.encode())
    for raw in sorted(set(paths) - {b""}):
        if raw.startswith(b"agents/benchmarks/history/"):
            continue  # Same output-ledger exclusion as run_deploy_pipeline.source_digest.
        path = root / os.fsdecode(raw)
        if not path.exists() and not path.is_symlink():
            data = b"DELETED"
        elif path.is_symlink():
            data = b"SYMLINK\0" + os.fsencode(os.readlink(path))
        else:
            data = path.read_bytes()
        h.update(raw + b"\0" + data + b"\0")
        if path.exists():
            h.update(str(source_mode(path)).encode())
    return {"head": sha, "digest": h.hexdigest()}


def source_mode(path: Path) -> int:
    """Match Git's file type/executable identity across private clone umasks."""
    mode = path.lstat().st_mode
    return stat.S_IFMT(mode) | (mode & stat.S_IXUSR)


def environment_digest() -> str:
    transient = {"_", "PWD", "OLDPWD", "SHLVL", "INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID"}
    return digest({k: v for k, v in os.environ.items() if k not in transient})


def input_fingerprints(plan: dict, root: Path) -> dict:
    paths = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                           cwd=root, check=True, capture_output=True).stdout.split(b"\0")
    files = {}
    for raw in set(paths) - {b""}:
        if raw.startswith(b"agents/benchmarks/history/"):
            continue
        path = root / os.fsdecode(raw)
        if path.is_symlink():
            content = os.fsencode(os.readlink(path))
        elif path.exists():
            content = path.read_bytes()
        else:
            content = b"DELETED"
        mode = source_mode(path) if path.exists() or path.is_symlink() else None
        files[os.fsdecode(raw)] = digest([hashlib.sha256(content).hexdigest(), mode])
    # Runtime configuration is an input even when Git ignores its secrets and
    # the gate narrows its source globs. Never let source selection hide it.
    runtime_config = {}
    for rel in [".env", "env.sh", "back-end/.env", "agents/.env", "agents/.env.benchmark-temporal",
                "front-end/.env", "front-end/.env.local"]:
        if (root / rel).is_file():
            runtime_config[rel] = hashlib.sha256((root / rel).read_bytes()).hexdigest()
    return {g["name"]: digest({"files": {p: h for p, h in files.items()
                            if any(fnmatchcase(p, glob) for glob in g.get("input_paths", ["*"]))},
                            "runtime_config": runtime_config,
                            "command": g["command"], "env": g.get("env", {}),
                            "worker": g.get("worker"), "checks": g["checks"],
                            "environment": environment_digest()}) for g in plan["gates"]}


def command(value: object) -> list[str]:
    if not isinstance(value, list) or not value or not all(isinstance(x, str) and x for x in value):
        raise ValueError("command must be a nonempty argv list")
    return value


def validate_plan(plan: dict, root: Path = ROOT) -> None:
    gates = plan.get("gates")
    if not isinstance(gates, list) or not gates:
        raise ValueError("plan needs gates")
    names, workers = set(), set()
    for gate in gates:
        name = gate.get("name", "")
        if not isinstance(name, str) or not NAME.fullmatch(name) or name in names:
            raise ValueError("gate names must be unique safe identifiers")
        names.add(name)
        command(gate.get("command"))
        if any("--reuse-passed" in arg for arg in gate["command"]):
            raise ValueError("staged runs require fresh execution, not pass-cache reuse")
        checks = gate.get("checks")
        if not isinstance(checks, list) or not checks or len(set(checks)) != len(checks):
            raise ValueError(f"{name}: explicit unique check inventory required")
        if not all(isinstance(c, str) and c and "\0" not in c for c in checks):
            raise ValueError(f"{name}: invalid check identifier")
        if 'worker_recipe' in gate:
            validate_recipe(gate['worker_recipe'], checks)
        if gate.get('result_transport', 'file') not in ('file', 'stdout'):
            raise ValueError('unknown result transport')
        paths = gate.get("input_paths", ["*"])
        if not isinstance(paths, list) or not paths or not all(isinstance(p, str) and p for p in paths):
            raise ValueError("input_paths must be a nonempty list of source globs")
        quick = gate.get("quick", False)
        if not isinstance(quick, bool):
            raise ValueError("quick must be boolean")
        if quick and gate.get("category") not in QUICK:
            raise ValueError("only application structural/static checks belong in quick phase")
        if not quick:
            # Separate worker identities prevent silently turning the new fanout
            # into simultaneous heavy commands on the coordinator's checkout.
            worker = gate.get("worker")
            if not isinstance(worker, str) or not worker or worker in workers or worker == "coordinator":
                raise ValueError(f"{name}: bind an independent isolated worker before execution")
            workers.add(worker)
        if not isinstance(gate.get("env", {}), dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in gate.get("env", {}).items()
        ):
            raise ValueError("env must map strings to strings")
        if gate.get("after"):
            raise ValueError("cross-gate after dependencies are not allowed; setup belongs inside its worker")
        timeout = gate.get("timeout_seconds")
        if not quick and gate.get('result_transport') == 'stdout' and timeout is None:
            raise ValueError('remote transport requires its existing gate deadline')
        if timeout is not None and (type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0):
            raise ValueError("timeout_seconds must be a finite positive number")
    quick_categories = {g.get('category') for g in gates if g.get('quick')}
    if (not REQUIRED_QUICK <= quick_categories or
            not quick_categories & {'backend-structural', 'application-structural'}):
        raise ValueError("format, eslint, typescript and application structural quick checks are required")
    validate_isolation(plan, root)


def initialize(plan: dict, root: Path) -> dict:
    validate_plan(plan, root)
    if plan.get("source") != source(root):
        raise ValueError("plan source is stale")
    return {"version": 1, "plan": plan, "source": plan["source"], "plan_digest": digest(plan),
            "phase": "quick", "next_after_quick": "initial", "round": 0,
            "repair_gates": [], "skips": {}, "attempts": [], "failures": [],
            "focused": {}, "ready": False, "environment": environment_digest(),
            "input_fingerprints": input_fingerprints(plan, root)}


def records(plan: dict, state: dict) -> list[dict]:
    phase = state["phase"]
    gates = plan["gates"]
    if phase == "quick":
        return [g for g in gates if g.get("quick")]
    if phase == "focused":
        selected = []
        for gate in gates:
            if gate['name'] not in state['repair_gates']:
                continue
            task = state['focused'][gate['name']]
            focused = dict(gate, command=task['command'], checks=task['checks'])
            if 'worker_recipe' in task:
                focused['worker_recipe'] = task['worker_recipe']
            selected.append(focused)
        return selected
    if phase == "failed-gates":
        return [g for g in gates if g["name"] in state["repair_gates"]]
    if phase in {"initial", "final"}:
        return [g for g in gates if not g.get("quick")]
    raise ValueError(f"phase {phase} is not executable")


def execute(gate: dict, state: dict, directory: Path, root: Path) -> dict:
    name, phase = gate["name"], state["phase"]
    token = uuid.uuid4().hex
    case_skips = {key.split("/", 1)[1]: value for key, value in state["skips"].items()
                  if key.startswith(name + "/") and value["source"] == state["source"]}
    active = [c for c in gate["checks"] if c not in case_skips]
    if not active:
        return {"gate": name, "status": "SKIP", "cases": {c: "SKIP" for c in gate["checks"]},
                "native_exit": None, "executed": False, "source": state["source"]}
    # A worker must explicitly consume the case inventory, including exclusions.
    # Without a case-aware worker mixed skip/run would either rerun skipped tests
    # or silently omit checks, so reject it before launch.
    if case_skips and not gate.get("case_protocol"):
        raise ValueError(f"{name}: mixed skips require the worker's case protocol")
    folder = directory / "attempts" / str(state["round"]) / phase / name
    folder.mkdir(parents=True, exist_ok=False)
    request = {"token": token, "source": state["source"], "gate": name,
               "checks": active, "skips": case_skips, "phase": phase}
    if 'worker_recipe' in gate:
        request['worker_recipe'] = gate['worker_recipe']
        request['worker_root'] = gate.get('worker_root', str((root / gate['cwd']).resolve()))
    write(folder / "request.json", request)
    result_path = folder / "result.json"
    env = {**os.environ, **gate.get("env", {}), "DEPLOY_GATE_REQUEST": str(folder / "request.json"),
           "DEPLOY_GATE_RESULT": str(result_path), "DEPLOY_GATE_TOKEN": token,
           "DEPLOY_LANE_SCOPED_REUSE": "0", "DEPLOY_CYCLE_FRESH": "1"}
    started = time.time()
    timeout = gate.get("timeout_seconds", 120 if gate.get("quick") else None)  # declared wins; 120 s is the quick default
    timed_out = cancelled = lingering = False
    if (gate.get("category") == "agentcard-lifecycle"
            and gate.get("worker_transport") not in {"local-isolated", "boxes-thread"}):
        raise ValueError("AgentCard native lifecycle requires its validated worker binding")
    native_producer = (gate.get("native_cloud") is True
                       or (gate.get("category") == "agentcard-lifecycle"
                           and gate.get("worker_transport") in {"local-isolated", "boxes-thread"}))
    lifecycle = "native-producer" if native_producer else "owned"
    native_cleanup_reference = None
    with (folder / "output.log").open("wb") as output, (folder / 'stderr.log').open('wb') as stderr:
        try:
            code, timed_out, cancelled, lingering = run_command(gate["command"],
                cwd=root / gate.get("cwd", "."), env=env, output=output, timeout=timeout,
                input_path=folder / 'request.json' if gate.get('result_transport') == 'stdout' else None,
                stderr_output=stderr if gate.get('result_transport') == 'stdout' else None,
                owned_lifecycle=lifecycle == "owned")
        except OSError as error:
            output.write(str(error).encode())
            code = 127
    cases = {c: "SKIP" for c in case_skips}
    valid = False
    complete = False
    reason = None
    worker_evidence = {}
    if gate.get('result_transport') == 'stdout':
        try:
            if (folder / 'output.log').stat().st_size > MAX_RECEIPT_BYTES:
                raise ValueError('worker receipt exceeds transport limit')
            write(result_path, read(folder / 'output.log'))
        except (OSError, ValueError):
            pass
    if result_path.exists():
        try:
            if result_path.stat().st_size > MAX_RECEIPT_BYTES:
                raise ValueError('worker receipt exceeds transport limit')
            result = read(result_path)
            if lifecycle == 'native-producer':
                native_cleanup_reference = {
                    'result': str(result_path), 'native_directory': result.get('fleet_directory'),
                    'cleanup_complete': result.get('cleanup_complete') is True,
                    'result_sha256': hashlib.sha256(result_path.read_bytes()).hexdigest(),
                    'native_evidence': result.get('evidence', {}),
                }
            if isinstance(result.get('evidence'), dict):
                worker_evidence = result['evidence']
            raw_cases, complete = validate_result(result, request, code,
                invalid_process=timed_out or cancelled or lingering)
            cases.update(raw_cases)
            valid = True
        except (KeyError, TypeError, ValueError) as error:
            reason = str(error)
    elif code == 0 and not (gate.get("case_protocol") or cancelled or timed_out or lingering):
        cases.update({c: "PASS" for c in active})
        valid = True
        complete = True
    else:
        reason = "missing complete case receipt"
    if native_producer and (not valid or not complete):
        # Native producers can intentionally retain recovery resources. Unknown
        # native cleanup must be reconciled before another attempt can resume.
        lingering = True
    if not valid:
        # Unknown/unexecuted work is a blocking outcome; cannot waive this via
        # a known constituent failure or by treating launcher exit0 as coverage.
        cases.update({c: "UNVERIFIED" for c in active})
    status = "PASS" if all(v in TERMINAL_OK for v in cases.values()) else "FAIL"
    result = {"gate": name, "status": status, "cases": cases, "native_exit": code,
              "executed": True, "complete": valid and complete, "reason": reason, "timed_out": timed_out,
              "case_complete": {c: valid and v != 'UNVERIFIED' for c, v in cases.items()},
              "cancelled": cancelled, "lingering_group": lingering,
              "source": state["source"], "started_at": started, "finished_at": time.time(),
              "command": gate["command"], "log": str(folder / "output.log"),
              "stderr_log": str(folder / 'stderr.log'), "token": token}
    result['lifecycle'] = lifecycle
    result['native_cleanup_reference'] = native_cleanup_reference
    if native_producer and (timed_out or cancelled or lingering):
        result['cleanup_owner'] = {'request_token': token, 'worker_root': str(root / gate.get('cwd', '.')),
                                   'native_cleanup_reference': native_cleanup_reference}
    result['worker_evidence'] = worker_evidence
    result['worker_result'] = str(result_path) if result_path.exists() else None
    write(folder / "receipt.json", result)
    return result


def failed_cases(state: dict, results: list[dict]) -> list[dict]:
    phase = state["phase"]
    failed = []
    for result in results:
        for check, verdict in result["cases"].items():
            if verdict not in TERMINAL_OK:
                key = result["gate"] + "/" + check
                failed.append({"id": uuid.uuid4().hex, "check": key, "native_result": verdict,
                               "gate": result["gate"], "source": state["source"],
                               "complete": result.get("case_complete", {}).get(check, result.get("complete", False)), "phase": phase,
                               "evidence": result.get("log"), "command": result.get("command"),
                               "worker_result": result.get('worker_result'),
                               "worker_evidence": result.get('worker_evidence', {}).get(check)})
    return failed


def advance(state: dict, results: list[dict], failures: list[dict] | None = None) -> None:
    phase = state["phase"]
    state["attempts"].append({"phase": phase, "source": state["source"], "results": results})
    failed = failed_cases(state, results) if failures is None else failures
    if failed:
        state["failures"].extend(failed)
        state["pending"] = list(dict.fromkeys([*state.get("pending", []), *[f["id"] for f in failed]]))
        state["failure_phase"] = phase
        state["phase"] = "triage"
        return
    if phase == "quick":
        state["phase"] = state.pop("next_after_quick", "initial")
    elif phase == "initial":
        state.update(phase="ready", ready=True)
    elif phase == "focused":
        state["phase"] = "failed-gates"
    elif phase == "failed-gates":
        state.update(phase="quick", next_after_quick="final")
    elif phase == "final":
        state.update(phase="ready", ready=True)


ASSIGNED_EXCLUSIVE = ("repair_agent", "external_provider", "post_merge", "execute_unverified")


def validate_assigned_repair(entry: dict, disposition: str) -> None:
    """Owned assignment: NOT_INTRODUCED is attribution only; the root keeps the repair and re-runs the gate.

    The occurrence stays blocking (no skip, no waiver, no attribution change) and cannot be combined
    with a repair link, provider waiver, post-merge packet or execution recovery.
    """
    if entry.get("assigned_repair") is not True:
        raise ValueError("assigned_repair must be the explicit boolean true")
    if entry.get("attribution") not in {"NOT_INTRODUCED", "NOT INTRODUCED"}:
        raise ValueError("assigned_repair retains a NOT_INTRODUCED attribution only; introduced and unknown "
                         "occurrences use the normal blocking path")
    if any(entry.get(k) for k in ASSIGNED_EXCLUSIVE):
        raise ValueError("assigned_repair cannot be combined with a repair link, provider waiver, "
                         "post-merge packet or execution recovery")
    for key in ("assigned_reason", "assigned_evidence"):
        if not isinstance(entry.get(key), str) or not entry[key].strip():
            raise ValueError("assigned_repair requires the owned-assignment reason and an evidence reference")
    if disposition != "blocking":
        raise ValueError("assigned_repair applies to a blocking occurrence only")


def adjudicate(state: dict, report: dict) -> None:
    from deploy_failure_report import decision
    if state["phase"] != "triage":
        raise ValueError("no failures awaiting RCA")
    entries = report.get("failures", [])
    by_id = {entry["id"]: entry for entry in entries}
    if len(by_id) != len(entries) or set(by_id) != set(state["pending"]):
        raise ValueError("RCA dispositions must cover every pending occurrence exactly once")
    pending = [f for f in state["failures"] if f["id"] in state["pending"]]
    decisions = []
    for failure in pending:
        entry = by_id[failure["id"]]
        if (entry.get("source") != failure["source"] or entry.get("check") != failure["check"]
                or entry.get("command") != failure.get("command")
                or entry.get("native_result") != failure["native_result"]):
            raise ValueError("RCA receipt has the wrong source or check")
        disposition = decision(entry)
        if entry.get("assigned_repair") is not None:
            validate_assigned_repair(entry, disposition)
        if disposition == "execution required":
            if failure["complete"]:
                raise ValueError("execution recovery requires an incomplete occurrence")
        elif disposition != "blocking" and not failure["complete"]:
            raise ValueError("unverified/incomplete execution cannot be waived as a completed case")
        decisions.append((failure, entry, disposition))
    # Atomic transition: UNKNOWN leaves every occurrence open, never drops peers.
    if any(d == "blocking" and e.get("attribution") != "INTRODUCED" and e.get("assigned_repair") is not True
           for _, e, d in decisions):
        raise ValueError("UNKNOWN or unhanded-off failure still blocks; finish /RCA attribution")
    repair = set()
    for failure, entry, disposition in decisions:
        failure["rca"] = entry
        failure["disposition"] = disposition
        if disposition in {"blocking", "execution required"}:
            repair.add(failure["gate"])
        else:
            state["skips"][failure["check"]] = {"source": state["source"], "rca": entry,
                                                   "disposition": disposition,
                                                   "input_fingerprint": state["input_fingerprints"][failure["gate"]]}
            if disposition == "pending post-merge":
                # Pre-merge READY may proceed; completion stays blocked until the parent dispatches
                # this packet after merge and records the actual repair link (resolve action).
                state.setdefault("pending_post_merge", []).append({
                    "id": failure["id"], "check": failure["check"], "gate": failure["gate"],
                    "native_result": failure["native_result"], "packet": entry["post_merge"]})
    state.pop("pending")
    # Gates routed by `reexecute` during THIS triage are repair work for the same round; the
    # accumulated repair_gates ledger carries stale credit from earlier rounds and is not the signal.
    repair |= set(state.pop("triage_repair_gates", []))
    if repair:
        state["repair_gates"] = sorted(set(state["repair_gates"]) | repair)
        state["phase"] = "needs-focused-plan"
    else:
        # Waivers never trigger a rerun. Continue precisely where this round
        # would have gone if the waived cases had been SKIP initially.
        prior = state["failure_phase"]
        state["phase"] = {"quick": state.get("next_after_quick", "initial"), "initial": "ready",
                          "focused": "failed-gates", "failed-gates": "quick", "final": "ready",
                          "refresh": "needs-focused-plan" if state["repair_gates"] else "final"}[prior]
        if prior == "failed-gates":
            state["next_after_quick"] = "final"
        if state["phase"] == "triage":
            state["phase"] = "needs-focused-plan" if state["repair_gates"] else "final"
        state["ready"] = state["phase"] == "ready"


def reexecute(state: dict, occurrence_id: str) -> None:
    """Observation loss only: an incomplete UNVERIFIED occurrence re-runs its bound gate unchanged.

    No attribution, waiver, skip or credit: the native UNVERIFIED record stays in history with an
    audit reason and the gate is routed into the repair set exactly like "execution required".
    """
    if state["phase"] != "triage" or occurrence_id not in state.get("pending", []):
        raise ValueError("re-execution is only accepted for an occurrence still awaiting RCA")
    failure = next((f for f in state["failures"] if f["id"] == occurrence_id), None)
    if failure is None:
        raise ValueError("unknown occurrence")
    if failure.get("rca") or failure.get("disposition") or failure.get("repair_agent"):
        raise ValueError("occurrence already carries an attribution or handoff; use triage")
    if failure.get("native_result") != "UNVERIFIED" or failure.get("complete"):
        raise ValueError("only an incomplete UNVERIFIED occurrence (coordinator/observation loss) can be "
                         "re-executed; a completed or failed test needs /RCA attribution")
    failure["disposition"] = "execution required"
    failure["reexecution"] = {"reason": "observation loss; re-executing unchanged gate", "at": time.time(),
                              "native_result": failure["native_result"]}
    state["pending"] = [i for i in state["pending"] if i != occurrence_id]
    state["repair_gates"] = sorted(set(state["repair_gates"]) | {failure["gate"]})
    state["triage_repair_gates"] = sorted(set(state.get("triage_repair_gates", [])) | {failure["gate"]})
    if not state["pending"]:
        state.pop("pending")
        state.pop("triage_repair_gates")  # this triage is complete; the gate is already in repair_gates
        state["phase"] = "needs-focused-plan"


def focused_plan(state: dict, plan: dict, payload: dict) -> None:
    if state["phase"] != "needs-focused-plan":
        raise ValueError("focused plan is only accepted for diagnosed failures")
    if payload.get("source") != state["source"]:
        raise ValueError("focused plan source is stale")
    tasks = payload.get("gates", {})
    if set(tasks) != set(state["repair_gates"]):
        raise ValueError("focused plan must cover every blocking gate")
    allowed = {g["name"]: set(g["checks"]) for g in plan["gates"]}
    original = {g['name']: g for g in plan['gates']}
    for gate, task in tasks.items():
        command(task.get("command"))
        if not task.get("checks") or not set(task["checks"]) <= allowed[gate]:
            raise ValueError("focused check list is not in the gate inventory")
        required = {f["check"].split("/", 1)[1] for f in state["failures"]
                    if f["gate"] == gate and f.get("disposition") in {"blocking", "execution required"}}
        if not required <= set(task["checks"]):
            raise ValueError("focused command omits an unresolved failing check")
        if 'worker_recipe' in original[gate] and 'worker_recipe' not in task:
            raise ValueError('focused task must keep the bound worker recipe and transport')  # finding 4447557578
        if 'worker_recipe' in task:
            validate_recipe(task['worker_recipe'], task['checks'])
            if ('worker_recipe' not in original[gate]
                    or task['command'] != original[gate]['command']):
                raise ValueError('focused recipes must keep the bound worker transport')
            bound, focused = original[gate]['worker_recipe'], task['worker_recipe']
            # Identity except the permitted narrowing of cases to the focused checks: a focused run
            # must execute the bound case commands/env/cwd and setup/cleanup exactly.
            if (any(bound.get(k) != focused.get(k) for k in (bound.keys() | focused.keys()) - {'cases'})
                    or any(focused['cases'][name] != bound['cases'].get(name) for name in focused['cases'])):
                raise ValueError('focused recipe must be identical to the bound recipe except for narrowed checks')
    state["focused"] = tasks
    state["phase"] = "focused"


def rca_requests(state: dict, directory: Path) -> list[Path]:
    paths = []
    for failure in [*state["failures"], *state.get("live_failures", [])]:
        if failure["id"] not in [*state.get("pending", []), *[f["id"] for f in state.get("live_failures", [])]]:
            continue
        path = directory / "rca" / (failure["id"] + ".json")
        write(path, {**failure, "instruction": "/RCA: diagnose this occurrence; return the evidence-backed "
                    "INTRODUCED/NOT_INTRODUCED gate under .claude/shared/deploy-failure-policy.md. "
                    "UNKNOWN blocks. Group with an existing root cause only after reading evidence. "
                    "Do not deploy or weaken assertions/timeouts. Independent failures run concurrently."})
        paths.append(path)
    return paths


def launch_rca(path: Path, launcher: list[str]) -> None:
    # One service launch per occurrence even when a second observer calls rca.
    with exclusive(path.parent / (path.stem + ".launch-lock")):
        receipt = path.with_suffix(".launch.json")
        if receipt.exists():
            return
        submission = path.with_suffix(".submitted.json")
        if submission.exists():
            raise ValueError(f"RCA submission may have succeeded; reconcile {path.stem} before retrying")
        write(submission, {"request_id": path.stem, "state": "submission-started", "at": time.time()})
        outcome = subprocess.run([*launcher, str(path)], capture_output=True, check=True, timeout=120)
        value = json.loads(outcome.stdout)
        if not isinstance(value, dict) or value.get("ok") is not True:
            raise ValueError("RCA launcher did not confirm submission")
        write(receipt, value)


def run_phase(plan: dict, state: dict, directory: Path, root: Path,
              launcher: list[str] | None = None) -> None:
    if (source(root) != state["source"] or digest(plan) != state["plan_digest"]
            or environment_digest() != state["environment"]
            or input_fingerprints(plan, root) != state["input_fingerprints"]):
        raise ValueError("source/plan changed; refresh after RCA before running")
    selected = records(plan, state)
    state["round"] += 1
    state["live_failures"] = []
    results = []
    launched = []
    with ThreadPoolExecutor(max_workers=max(1, len(selected))) as rc_pool:
        with ThreadPoolExecutor(max_workers=max(1, len(selected))) as pool:
            futures = {pool.submit(execute, gate, state, directory, root): gate for gate in selected}
            for future in as_completed(futures):
                gate = futures[future]
                try:
                    result = future.result()
                except (ValueError, OSError) as error:
                    result = {"gate": gate["name"], "status": "FAIL", "complete": False,
                              "cases": {c: "UNVERIFIED" for c in gate["checks"]},
                              "source": state["source"], "reason": str(error)}
                results.append(result)
                fresh = failed_cases(state, [result])
                state["live_failures"].extend(fresh)
                write(directory / "cycle.json", state)
                # Publish and dispatch each failure while healthy siblings run.
                for path in rca_requests(state, directory):
                    if launcher and not CANCEL.is_set() and path.stem in {f["id"] for f in fresh}:
                        launched.append(rc_pool.submit(launch_rca, path, launcher))
        failures = state.pop("live_failures")
        if CANCEL.is_set():
            state["attempts"].append({"phase": state["phase"], "results": results, "interrupted": True})
            state.update(resume_phase=state["phase"], phase="interrupted", ready=False)
        elif (source(root) != state["source"] or environment_digest() != state["environment"]
              or input_fingerprints(plan, root) != state["input_fingerprints"]):
            state["attempts"].append({"phase": state["phase"], "results": results, "stale": True})
            state.update(phase="stale", ready=False)
        else:
            advance(state, results, failures)
        for job in launched:
            try:
                job.result()
            except (ValueError, OSError, subprocess.SubprocessError) as error:
                state.setdefault("rca_launch_errors", []).append(str(error))
        write(directory / "cycle.json", state)


def refresh(state: dict, old: dict, new: dict, root: Path) -> None:
    if digest(old) != state["plan_digest"]:
        raise ValueError("previous plan does not match the frozen selection")
    validate_plan(new, root)
    if state.get("pending"):
        raise ValueError("adjudicate pending occurrences before binding a changed source")
    if state["phase"] not in {"needs-focused-plan", "focused", "triage", "stale"}:
        raise ValueError("source refresh only at the repair boundary")
    if new["source"] != source(root):
        raise ValueError("new plan is not bound to current source")
    old_gates = {g["name"]: g for g in old["gates"]}
    new_gates = {g["name"]: g for g in new["gates"]}
    if not old_gates.keys() <= new_gates.keys():
        raise ValueError("repair cannot silently remove originally selected gates")
    for name, gate in old_gates.items():
        preserve_contract(gate, new_gates[name])
        if not set(gate["checks"]) <= set(new_gates[name]["checks"]):
            raise ValueError("repair cannot silently remove originally selected checks")
    fingerprints = input_fingerprints(new, root)
    if (new["source"] == state["source"] and digest(new) == state["plan_digest"]
            and fingerprints == state["input_fingerprints"]):
        raise ValueError("refresh requires actual changed source or plan")
    carry, revisit, superseded_pending = {}, [], []
    for key, skip in state["skips"].items():
        gate = key.split("/", 1)[0]
        if skip.get("input_fingerprint") == fingerprints.get(gate):
            carry[key] = {**skip, "source": new["source"], "original_source": skip["source"]}
        elif skip.get("disposition") == "pending post-merge":
            # A pending qualification is not an executed handoff: with changed inputs the case simply
            # runs again in the next full sweep. The original native FAIL + packet stay in history;
            # no synthetic result is written. Only a test that actually failed can be pending.
            superseded_pending.extend({**p, "superseded": "changed inputs; case re-executes", "source": skip["source"]}
                                      for p in state.get("pending_post_merge", []) if p["check"] == key)
        else:
            revisit.append({"id": uuid.uuid4().hex, "check": key, "gate": gate,
                            "source": new["source"], "native_result": "prior waived failure; changed inputs",
                            "command": new_gates[gate]["command"],
                            "complete": True, "phase": "refresh", "prior_waiver": skip})
    state["superseded_skips"] = [*state.get("superseded_skips", []), *state["skips"].values()]
    state["skips"] = carry
    if superseded_pending:
        done = {p["id"] for p in superseded_pending}
        state["superseded_pending_post_merge"] = [*state.get("superseded_pending_post_merge", []), *superseded_pending]
        state["pending_post_merge"] = [p for p in state.get("pending_post_merge", []) if p["id"] not in done]
    state["failures"].extend(revisit)
    if revisit:
        state["pending"] = list(dict.fromkeys([*state.get("pending", []), *[f["id"] for f in revisit]]))
        state["failure_phase"] = "refresh"
    state.update(plan=new, source=new["source"], plan_digest=digest(new), ready=False, focused={},
                 input_fingerprints=fingerprints, environment=environment_digest(),
                 phase="quick", next_after_quick="triage" if state.get("pending") else
                 ("needs-focused-plan" if state["repair_gates"] else "final"))


def resolve_post_merge(state: dict, occurrence_id: str, repair_agent: str) -> None:
    from deploy_failure_report import decision
    if not isinstance(repair_agent, str) or not repair_agent.strip():
        raise ValueError("resolving a pending post-merge packet requires the actual repair link")
    pending = next((p for p in state.get("pending_post_merge", []) if p["id"] == occurrence_id), None)
    failure = next((f for f in state["failures"] if f["id"] == occurrence_id), None)
    if pending is None or failure is None or failure.get("disposition") != "pending post-merge":
        raise ValueError("only a recorded pending post-merge occurrence can be resolved")
    entry = {k: v for k, v in failure["rca"].items() if k != "post_merge"}
    entry["repair_agent"] = repair_agent
    disposition = decision(entry)  # validates the link
    failure.update(rca={**entry, "resolved_post_merge": pending["packet"]}, disposition=disposition)
    skip = state["skips"].get(failure["check"])
    if skip is not None:
        skip.update(rca=failure["rca"], disposition=disposition)
    state["pending_post_merge"] = [p for p in state["pending_post_merge"] if p["id"] != occurrence_id]


def pending_completion_block(state: dict) -> str | None:
    pending = state.get("pending_post_merge") or []
    if pending:
        return (f"{len(pending)} pending post-merge packet(s) block completion; "
                "dispatch after merge and resolve with the repair link")
    return None


def verify_saved(directory: Path, root: Path, expect_head: str | None = None) -> int:
    try:
        state = read(directory / "cycle.json")
        plan = state["plan"]
        if state["plan_digest"] != digest(plan):
            return 5
        validate_plan(plan, root)
        if state["phase"] != "ready" or state["ready"] is not True:
            return 1
        # Pending post-merge packets do not block pre-merge readiness (Phase 3 verify); the
        # separate completion check (`complete` / `--require-resolved`) refuses until resolved.
        if (state["source"] != source(root) or state["plan_digest"] != digest(plan)
                or state["environment"] != environment_digest()
                or state["input_fingerprints"] != input_fingerprints(plan, root)
                or (expect_head is not None and state["source"]["head"] != expect_head)):
            return 5  # Same stale-source result as the existing pipeline verifier.
        return 0
    except (OSError, ValueError, KeyError, TypeError):
        return 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["init", "run", "resume", "status", "triage", "focus", "refresh", "rca", "verify", "report", "resolve", "complete", "reexecute"])
    parser.add_argument("--occurrence", help="resolve: pending post-merge occurrence id")
    parser.add_argument("--repair-agent", help="resolve: the actual post-merge repair link")
    parser.add_argument("--require-resolved", action="store_true",
                        help="verify: also refuse while pending post-merge packets exist (post-merge completion)")
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--rca-launcher", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    try:
        plan = read(args.plan)
        directory = args.state_dir.resolve()
        with exclusive(directory):
            state_path = directory / "cycle.json"
            state = initialize(plan, args.root) if args.action == "init" else read(state_path)
            if args.action == "init" and state_path.exists():
                raise ValueError("existing cycle must not be reset")
            if args.action in {"run", "resume"}:
                if args.action == "resume":
                    if state["phase"] != "interrupted":
                        raise ValueError("resume requires an interrupted cycle")
                    if any(r.get('lingering_group') for r in state['attempts'][-1]['results']):
                        raise ValueError('worker descendants remain; reconcile owned cleanup before resuming')
                    state["phase"] = state.pop("resume_phase")
                with cancellation_handlers():
                    while state["phase"] in {"quick", "initial", "focused", "failed-gates", "final"}:
                        run_phase(plan, state, directory, args.root, args.rca_launcher)
            elif args.action == "triage":
                if args.input is None:
                    raise ValueError("--input RCA report required")
                adjudicate(state, read(args.input))
            elif args.action == "focus":
                if args.input is None:
                    raise ValueError("--input focused command plan required")
                focused_plan(state, plan, read(args.input))
            elif args.action == "refresh":
                if args.input is None:
                    raise ValueError("--input previous plan required")
                refresh(state, read(args.input), plan, args.root)
            elif args.action == "rca":
                requests = rca_requests(state, directory)
                if state["phase"] != "triage" or not requests or not args.rca_launcher:
                    raise ValueError("pending RCA requests and explicit boxes.dev launcher required")
                with ThreadPoolExecutor(max_workers=len(requests)) as pool:
                    jobs = [pool.submit(launch_rca, path, args.rca_launcher) for path in requests]
                    for job in jobs:
                        job.result()
            elif args.action == "resolve":
                resolve_post_merge(state, args.occurrence, args.repair_agent)
            elif args.action == "reexecute":
                reexecute(state, args.occurrence)
            elif args.action == "complete":
                # Post-merge completion (Step 12a / before the final scorecard): every packet dispatched and resolved.
                blocked = pending_completion_block(state)
                if blocked:
                    print(f"DEPLOY_CYCLE INCOMPLETE: {blocked}", file=sys.stderr)
                    return 1
            elif args.action == "verify":
                if args.require_resolved and pending_completion_block(state):
                    raise ValueError(pending_completion_block(state))
                if (not state["ready"] or state["phase"] != "ready"
                        or source(args.root) != state["source"] or digest(plan) != state["plan_digest"]
                        or environment_digest() != state["environment"]
                        or input_fingerprints(plan, args.root) != state["input_fingerprints"]):
                    raise ValueError("cycle not complete on exact current source and plan")
            elif args.action == "report":
                from deploy_failure_report import render
                failures = [{**f["rca"], "disposition": f["disposition"]}
                            for f in state["failures"] if "rca" in f]
                header = (f"Deploy validation: {state['phase']}\nSource: {state['source']['head']}\n"
                          f"Pending RCA: {len(state.get('pending', []))}\n"
                          f"Pending post-merge: {len(state.get('pending_post_merge', []))}\n")
                # The header is not a scorecard: pass none so BLOCKING failures render (finding 4447557591).
                text = header + render({"failures": failures})
                (directory / "report.md").write_text(text)
                print(text, end="")
                return 0
            write(state_path, state)
            print(json.dumps({"phase": state["phase"], "ready": state["ready"],
                              "failures": len(state.get("pending", [])), "source": state["source"],
                              "pending_post_merge": len(state.get("pending_post_merge", []))}))
            return 1 if args.action in {"run", "resume"} and not state["ready"] else 0
    except (ImportError, ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        print(f"DEPLOY_CYCLE BLOCKED: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
