#!/usr/bin/env python3
"""Source-bound staged /deploy validation. Does not merge or deploy production.

Every selected worker is launched concurrently. Worker commands own their isolated
checkout/services; the coordinator never removes host safeguards or grants skips.
/RCA receipts use deploy_failure_report.decision, the shared ownership policy.
"""
from __future__ import annotations

import argparse
import copy
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, as_completed, wait
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
import threading
import time
import uuid

import deploy_gate_progress as progress
from deploy_test_process import CANCEL, cancellation_handlers, run_command
from deploy_test_result import MAX_RECEIPT_BYTES, preserve_contract, validate as validate_result, validate_recipe
from deploy_test_isolation import validate as validate_isolation

ROOT = Path(__file__).resolve().parents[1]
QUICK = {"format", "eslint", "typescript", "backend-structural", "application-structural", "mac-app-static"}
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


def index_gitlinks(root: Path) -> dict[bytes, bytes]:
    """Read gitlink OIDs without descending into initialized submodule directories."""
    output = subprocess.run(["git", "ls-files", "--stage", "-z"], cwd=root,
                            check=True, capture_output=True).stdout
    links, seen = {}, set()
    for record in output.split(b"\0"):
        if not record:
            continue
        metadata, path = record.split(b"\t", 1)
        mode, oid, stage = metadata.split()
        if stage != b"0" or path in seen:
            raise ValueError("source identity requires an unambiguous merged index")
        seen.add(path)
        if mode == b"160000":
            links[path] = oid
    return links


def source(root: Path) -> dict:
    def git(*args: str) -> bytes:
        return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True).stdout
    sha = git("rev-parse", "HEAD").decode().strip()
    # Include untracked/non-ignored files; state/logs must live in ignored .context.
    paths = git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split(b"\0")
    links = index_gitlinks(root)
    h = hashlib.sha256(sha.encode())
    for raw in sorted(set(paths) - {b""}):
        if raw.startswith(b"agents/benchmarks/history/"):
            continue  # Same output-ledger exclusion as run_deploy_pipeline.source_digest.
        if raw in links:
            h.update(raw + b"\0GITLINK\0" + links[raw] + b"\0")
            h.update(str(0o160000).encode())
            continue
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
    transient = {"_", "PWD", "OLDPWD", "SHLVL", "INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID",
                 "CODEX_TOOL_CALL_ID"}
    return digest({k: v for k, v in os.environ.items() if k not in transient})


ROTATING_CREDENTIAL = re.compile(rb"(?m)^([ \t]*(?:export[ \t]+)?GITHUB_TOKEN[ \t]*=).*$")


def runtime_config_sha256(path: Path) -> str:
    """Digest a runtime config file, ignoring only the rotating GitHub user token's value.

    The devbox daemon rewrites ``GITHUB_TOKEN`` in the managed env files every time it refreshes
    that short-lived credential (observed 3 times in 40 minutes on 2026-11-07), which made any
    staged cycle longer than the refresh interval go stale. The key's presence and every other
    byte stay bound, so adding, removing or changing any other setting still invalidates a cycle.
    """
    return hashlib.sha256(ROTATING_CREDENTIAL.sub(rb"\1<rotating-credential>", path.read_bytes())).hexdigest()


def input_fingerprints(plan: dict, root: Path, *, environment: str | None = None) -> dict:
    paths = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                           cwd=root, check=True, capture_output=True).stdout.split(b"\0")
    links = index_gitlinks(root)
    files = {}
    for raw in set(paths) - {b""}:
        if raw.startswith(b"agents/benchmarks/history/"):
            continue
        path = root / os.fsdecode(raw)
        if raw in links:
            content = b"GITLINK\0" + links[raw]
        elif path.is_symlink():
            content = os.fsencode(os.readlink(path))
        elif path.exists():
            content = path.read_bytes()
        else:
            content = b"DELETED"
        mode = 0o160000 if raw in links else source_mode(path) if path.exists() or path.is_symlink() else None
        files[os.fsdecode(raw)] = digest([hashlib.sha256(content).hexdigest(), mode])
    # Runtime configuration is an input even when Git ignores its secrets and
    # the gate narrows its source globs. Never let source selection hide it.
    runtime_config = {}
    for rel in [".env", "env.sh", "back-end/.env", "agents/.env", "agents/.env.benchmark-temporal",
                "front-end/.env", "front-end/.env.local"]:
        if (root / rel).is_file():
            runtime_config[rel] = runtime_config_sha256(root / rel)
    return {g["name"]: digest({"files": {p: h for p, h in files.items()
                            if any(fnmatchcase(p, glob) for glob in g.get("input_paths", ["*"]))},
                            "runtime_config": runtime_config,
                            "command": g["command"], "env": g.get("env", {}),
                            "worker": g.get("worker"), "checks": g["checks"],
                            "environment": environment_digest() if environment is None else environment}) for g in plan["gates"]}


def command(value: object) -> list[str]:
    if not isinstance(value, list) or not value or not all(isinstance(x, str) and x for x in value):
        raise ValueError("command must be a nonempty argv list")
    return value


def validate_plan(plan: dict, root: Path = ROOT) -> None:
    """Refuse unsupported workers before allocating ownership or admitting native work."""
    gates = plan.get("gates")
    if not isinstance(gates, list) or not gates:
        raise ValueError("plan needs gates")
    names, workers = set(), set()
    for gate in gates:
        name = gate.get("name", "")
        if not isinstance(name, str) or not NAME.fullmatch(name) or name in names:
            raise ValueError("gate names must be unique safe identifiers")
        names.add(name)
        if (gate.get('native_cloud') is True
                and gate.get('worker_transport') == 'benchmark-cloud-cli' and sys.platform != 'linux'):
            raise ValueError(f'{name}: native cloud supervision requires Linux before adapter admission')
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


def reuse_qualifications(state: dict, gate: dict, *, include_custody=True, root=ROOT, custody_refresh=False) -> dict:
    """Replay existing dispositions; projected source fields never replace native proof."""
    from deploy_failure_report import decision
    revalidate_standing_skips(state)
    name, expected = gate['name'], {}
    for key, entry in state.get('skips', {}).items():
        if not key.startswith(name + '/') or entry['source'] != state['source']:
            continue
        if entry.get('input_fingerprint') != state['input_fingerprints'][name]:
            raise ValueError('reuse qualification input changed')
        if 'standing_skip' not in entry and decision(entry['rca']) != entry['disposition']:
            raise ValueError('reuse qualification disposition changed')
        expected[key.split('/', 1)[1]] = entry
    for warning in state.get('resource_warnings', []):
        if warning['gate'] != name or warning['source'] != state['source']:
            continue
        case = warning['check'].split('/', 1)[1]
        failure = next(f for f in state['failures'] if f['id'] == warning['id'])
        validate_resource_skip(failure['rca'], failure)
        evidence = failure['worker_evidence']
        if (warning.get('input_fingerprint') != state['input_fingerprints'][name]
                or warning['confirmation'] != failure['rca']['resource_skip']
                or warning['native_row'] != evidence['native_task']
                or warning['receipt_sha256'] != evidence['sha256']
                or sha_file(evidence['path']) != evidence['sha256'] or case in expected):
            raise ValueError('reuse resource qualification changed')
        if 'renewal' in warning:
            from deploy_test_agentcard_renewal import validate_active
            validate_active(state, warning)
        expected[case] = {'disposition': RESOURCE_SKIP, **warning}
    if include_custody:
        from deploy_test_historical_custody import guard, identical_inputs_binding
        current = (identical_inputs_binding(state, root)
                   if custody_refresh and state.get('historical_no_retry_custody') else None)
        expected.update(guard(state, gate, root, expected, current=current))
    if not set(expected) <= set(gate['checks']):
        raise ValueError('reuse qualification outside full inventory')
    return expected


def qualification_identity(skips: dict) -> dict:
    # Only projection source/plan may change during an identical-input refresh.
    # Native source, task, financial facts, environment and fingerprints remain bound.
    result = copy.deepcopy(skips)
    for value in result.values():
        for field in ('source', 'original_source'):
            value.pop(field, None)
        if value.get('disposition') == 'NO_RETRY_CUSTODY':
            for field in ('source', 'plan_digest'):
                value['current_binding'].pop(field, None)
    return result


def full_pass_binding(state: dict, gate: dict, *, root=ROOT, custody_refresh=False) -> dict | None:
    """Latest FULL execution: native PASS subset plus exact existing qualified exclusions."""
    latest = latest_receipts(state).get(gate['name'])
    if not latest or gate.get('quick'):
        return None
    receipt = latest
    # Recovered native evidence has no positive-adoption contract yet.
    if receipt.get('kind') == 'recovered-native-execution-v1':
        return None
    try:
        skips = reuse_qualifications(state, gate, root=root, custody_refresh=custody_refresh)
    except (OSError, ValueError, KeyError, TypeError, StopIteration):
        return None
    active = [case for case in gate['checks'] if case not in skips]
    expected = {case: 'SKIP' if case in skips else 'PASS' for case in gate['checks']}
    attempt = next((a for a in reversed(state.get('attempts', [])) if any(r is receipt for r in a.get('results', []))), {})
    if (not (attempt.get('phase') in {'initial', 'focused', 'failed-gates', 'final'}
             or attempt.get('phase') == 'triage' and attempt.get('independent_full') is True)
            or attempt.get('stale') or attempt.get('interrupted')
            or receipt.get('status') != 'PASS' or receipt.get('complete') is not True
            or receipt.get('executed') is not True or type(receipt.get('native_exit')) is not int
            or receipt['native_exit'] != 0
            or any(receipt.get(flag) is not False for flag in ('timed_out', 'cancelled', 'lingering_group'))
            or receipt.get('cleanup_owner')
            or not active or receipt.get('cases') != expected
            or receipt.get('command') != gate['command']
            or receipt.get('execution_binding') != {'input_fingerprint': state['input_fingerprints'].get(gate['name']),
                'contract_digest': digest(gate), 'environment': state['environment']}):
        return None
    try:
        path = Path(receipt['log']).parent / 'receipt.json'
        if bounded_read(path, 'carried native receipt') != receipt or receipt_owner(gate['name'], receipt):
            return None
        request_path = path.parent / 'request.json'
        request = bounded_read(request_path, 'carried gate request')
        if (any(request.get(k) != receipt.get(k) for k in ('token', 'source', 'gate'))
                or request.get('checks') != active
                or qualification_identity(request.get('skips', {})) != qualification_identity(skips)
                or any(v.get('source') != receipt['source'] for v in request.get('skips', {}).values())
                or any(receipt.get('case_complete', {}).get(k) is not False
                       or receipt.get('current_execution', {}).get(k) != 'UNVERIFIED'
                       for k, v in skips.items() if v.get('disposition') == 'NO_RETRY_CUSTODY')
                or request.get('worker_recipe') != gate.get('worker_recipe')):
            return None
        worker = receipt.get('worker_result')
        if skips and (not gate.get('case_protocol') or not worker):
            return None
        if worker:
            value = bounded_read(worker, 'carried worker result')
            checks, complete = validate_result(value, request, receipt['native_exit'], invalid_process=False)
            if not complete or checks != dict.fromkeys(active, 'PASS'):
                return None
        return {'receipt': str(path), 'receipt_sha256': sha_file(path), 'request_sha256': sha_file(request_path),
                'worker_result_sha256': sha_file(worker) if worker else None,
                'native_source': receipt['source'], 'token': receipt['token'],
                **({'qualification_digest': digest(qualification_identity(skips))} if skips else {})}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def carried_pass(state: dict, gate: dict, *, root=ROOT, custody_refresh=False) -> bool:
    entry = state.get('carried_passes', {}).get(gate['name'])
    if not entry:
        return False
    return (entry.get('validated_source') == state['source']
            and entry.get('input_fingerprint') == state['input_fingerprints'].get(gate['name'])
            and entry.get('contract_digest') == digest(gate)
            and full_pass_binding(state, gate, root=root, custody_refresh=custody_refresh) == entry.get('native_binding'))


def reusable_full_pass(state: dict, gate: dict) -> bool:
    return carried_pass(state, gate) or bool(full_pass_binding(state, gate)
        and latest_receipts(state)[gate['name']].get('source') == state['source'])


def records(plan: dict, state: dict) -> list[dict]:
    phase = state["phase"]
    gates = plan["gates"]
    if phase == "quick":
        return [g for g in gates if g.get("quick")]
    if phase == "focused":
        selected = []
        for gate in gates:
            if gate['name'] not in state['repair_gates'] or reusable_full_pass(state, gate):
                continue
            task = state['focused'][gate['name']]
            focused = dict(gate, command=task['command'], checks=task['checks'])
            if 'worker_recipe' in task:
                focused['worker_recipe'] = task['worker_recipe']
            selected.append(focused)
        return selected
    if phase == "failed-gates":
        return [g for g in gates if g["name"] in state["repair_gates"] and not reusable_full_pass(state, g)]
    if phase in {"initial", "final"}:
        return [g for g in gates if not g.get("quick") and not reusable_full_pass(state, g)]
    raise ValueError(f"phase {phase} is not executable")


def local_admission_root(gate: dict, root: Path) -> Path:
    location = (root / gate.get('cwd', '.')).resolve()
    if gate.get('worker_root') and Path(gate['worker_root']).resolve() != location:
        raise ValueError('local admission root differs from its prepared worker root')
    return location


def run_with_local_slot(gate: dict, root: Path, admission: dict, *, operation=None, local_failure=None, **kwargs):
    """Distinct roots overlap; an already owned root refuses a duplicate launch."""
    if gate.get('worker_transport') != 'local-isolated' or not gate.get('case_protocol'):
        return run_command(gate['command'], **kwargs)
    timeout = kwargs.pop('timeout')
    if timeout is not None and (type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0):
        raise OSError('native local admission requires the existing finite gate deadline')
    local_failure = local_failure if local_failure is not None else threading.Event()
    queued = time.monotonic()
    deadline = None if timeout is None else queued + timeout
    lock_path = local_admission_root(gate, root) / '.context/native-worker-admission.lock'
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    admission.update(lock=str(lock_path), original_budget_seconds=timeout, deadline_monotonic=deadline, started=False)
    with lock_path.open('a') as lock:
        while True:
            remaining = None if deadline is None else deadline - time.monotonic()
            expired = remaining is not None and remaining <= 0
            if CANCEL.is_set() or expired or local_failure.is_set():
                admission.update(queued_seconds=time.monotonic() - queued,
                                 reason='cancelled before local worker launch' if CANCEL.is_set()
                                 else 'prior local worker retained or unverified cleanup' if local_failure.is_set()
                                 else 'existing deadline exhausted in local root admission',
                                 timed_out=expired, cancelled=CANCEL.is_set())
                return operation(None) if operation is not None else (None, expired, CANCEL.is_set(), False)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                admission.update(queued_seconds=time.monotonic() - queued,
                                 reason='isolation root already owns an active worker; refuse duplicate launch',
                                 timed_out=False, cancelled=False)
                return operation(None) if operation is not None else (None, False, False, False)
            remaining = None if deadline is None else deadline - time.monotonic()
            if CANCEL.is_set() or local_failure.is_set() or remaining is not None and remaining <= 0:
                continue  # The next iteration returns without starting a worker.
            admission.update(started=True, queued_seconds=time.monotonic() - queued)
            # The retained lock spans setup/cases/cleanup and the existing owned drain.
            try:
                result = (operation(remaining) if operation is not None else
                          run_command(gate['command'], timeout=remaining, **kwargs))
            except BaseException:
                local_failure.set()
                raise
            if (isinstance(result, dict) and (result.get('lingering_group') or result.get('cleanup_owner')
                    or result.get('executed') is not False and result.get('complete') is not True)
                    or isinstance(result, tuple) and result[3]):
                local_failure.set()  # Still under flock: queued locals cannot cross this ownership fence.
            return result


def execute(gate: dict, state: dict, directory: Path, root: Path, *, local_failure=None) -> dict:
    if gate.get('worker_transport') != 'local-isolated' or not gate.get('case_protocol'):
        return _execute(gate, state, directory, root)
    admission = {}
    return run_with_local_slot(gate, root, admission, local_failure=local_failure,
        timeout=gate.get('timeout_seconds'), operation=lambda remaining: _execute(
            gate, state, directory, root, host_admission=admission, host_timeout=remaining))


def benchmark_teardown(gate: dict, token: str, started: float, folder: Path, root: Path, attempt: int) -> dict:
    """Reach the gate's own detached benchmark controllers once its process group ended.

    benchmarks/local.py runs the runner and its isolated stack in sessions of their own, so the
    gate's group TERM and ten-second group KILL never wait for their cleanup: on 2026-11-05 an
    interrupted cycle left agentcard-lifecycle's controller running queued paid tasks for ~24
    minutes. This is the legacy lane teardown bound to this request's token: only token-owned
    owner records are signalled (the controller first, then its own published shutdown budget,
    then the last-resort KILL), foreign runs are only reported, and run directories stay in place
    for the interrupted-worker recovery protocol.
    """
    import run_deploy_pipeline as lanes
    context = (root / gate.get('cwd', '.')).resolve() / '.context' / 'benchmarks'
    receipt = lanes.teardown_lane(gate['name'], attempt=attempt, token=token, started_epoch=started,
                                  state_dir=folder, context_root=context, reconcile_runs=False)
    return lanes._teardown_summary(receipt)


def _execute(gate: dict, state: dict, directory: Path, root: Path, *, host_admission=None, host_timeout=None) -> dict:
    """Admit one source-bound gate, run it, and retain its native cleanup receipt."""
    from run_deploy_pipeline import LANE_TOKEN_ENV
    name, phase = gate["name"], state["phase"]
    revalidate_standing_skips(state)
    if any(w.get('gate') == name and 'renewal' in w for w in state.get('resource_warnings', [])):
        reuse_qualifications(state, gate)
    from deploy_test_historical_custody import guard, state_identity, known
    custody = {}
    if ('historical_custody_import' in state or known(state, root)
            or state.get('historical_no_retry_custody') or state.get('historical_custody_history')):
        legacy = reuse_qualifications(state, gate, include_custody=False, root=root)
        custody = guard(state, gate, root, legacy)
    token = uuid.uuid4().hex
    case_skips = {key.split("/", 1)[1]: value for key, value in state["skips"].items()
                  if key.startswith(name + "/") and value["source"] == state["source"]}
    # Qualified third-party resource skips bound to the CURRENT source and gate inputs are not
    # resubmitted; they stay in the request/cases record as SKIP with their evidence (no pass credit).
    qualified = {w["check"].split("/", 1)[1]: {"disposition": RESOURCE_SKIP, **w}
                 for w in state.get("resource_warnings", [])
                 if w["gate"] == name and w["source"] == state["source"]
                 and w.get("input_fingerprint") == state["input_fingerprints"].get(name)}
    active = [c for c in gate["checks"] if c not in case_skips and c not in qualified and c not in custody]
    if not active:
        return {"gate": name, "status": "SKIP", "cases": {c: "SKIP" for c in gate["checks"]},
                "native_exit": None, "executed": False, "source": state["source"], "resource_skips": qualified,
                "custody_skips": custody, "case_complete": {c: False for c in custody},
                "current_execution": {c: "UNVERIFIED" for c in custody}}
    # A worker must explicitly consume the case inventory, including exclusions.
    # Without a case-aware worker mixed skip/run would either rerun skipped tests
    # or silently omit checks, so reject it before launch.
    if (case_skips or qualified or custody) and not gate.get("case_protocol"):
        raise ValueError(f"{name}: mixed skips require the worker's case protocol")
    folder = directory / "attempts" / str(state["round"]) / phase / name
    folder.mkdir(parents=True, exist_ok=False)
    request = {"token": token, "source": state["source"], "gate": name,
               "checks": active, "skips": {**case_skips, **qualified, **custody}, "phase": phase}
    if custody or (directory / 'cycle.json').exists():
        request.update(custody_state=str((directory / 'cycle.json').resolve()), custody_state_sha256=state_identity(state))
    if 'worker_recipe' in gate:
        request['worker_recipe'] = gate['worker_recipe']
        request['worker_root'] = gate.get('worker_root', str((root / gate.get('cwd', '.')).resolve()))
    write(folder / "request.json", request)
    result_path = folder / "result.json"
    env = {**os.environ, **gate.get("env", {}), "DEPLOY_GATE_REQUEST": str(folder / "request.json"),
           "DEPLOY_GATE_RESULT": str(result_path), "DEPLOY_GATE_TOKEN": token,
           # Workers (and a remote gate's launcher mirror) append per-test rows as they finish.
           progress.ENV: str(folder / "progress.jsonl"),
           "DEPLOY_LANE_SCOPED_REUSE": "0", "DEPLOY_CYCLE_FRESH": "1",
           # Teardown ownership of every process the gate starts (benchmark_teardown).
           LANE_TOKEN_ENV: token}
    if 'custody_state' in request:
        from deploy_test_historical_custody import environment_identity, runtime_identity
        request['custody_runtime'] = runtime_identity(root)
        request['custody_child_environment'] = environment_identity(env)
        write(folder / 'request.json', request)
    admission = isolated_request(state, gate, request, root, env)
    if admission:
        request['isolated_validation'] = admission
        write(folder / 'request.json', request)
    started = time.time()
    timeout = gate.get("timeout_seconds", 120 if gate.get("quick") else None)  # declared wins; 120 s is the quick default
    timed_out = cancelled = lingering = False
    native_producer = gate.get("native_cloud") is True
    lifecycle = "native-producer" if native_producer else "owned"
    native_cleanup_reference = None
    preallocation_refused = False
    worker_cleanup_owner = None
    host_admission = {} if host_admission is None else host_admission
    with (folder / "output.log").open("wb") as output, (folder / 'stderr.log').open('wb') as stderr:
        try:
            if host_admission.get('deadline_monotonic') is not None:
                host_timeout = host_admission['deadline_monotonic'] - time.monotonic()
                if host_timeout <= 0:
                    host_admission.update(started=False, timed_out=True,
                                          reason='existing deadline exhausted before local worker launch')
            if host_admission.get('started') is False:
                code, timed_out, cancelled, lingering = (None, host_admission.get('timed_out', False),
                                                       host_admission.get('cancelled', False), False)
            else:
                code, timed_out, cancelled, lingering = run_command(gate['command'],
                cwd=root / gate.get("cwd", "."), env=env, output=output, timeout=host_timeout if host_admission else timeout,
                input_path=folder / 'request.json' if gate.get('result_transport') == 'stdout' else None,
                stderr_output=stderr if gate.get('result_transport') == 'stdout' else None,
                owned_lifecycle=lifecycle == "owned")
        except OSError as error:
            output.write(str(error).encode())
            code = 127
    cases = {c: "SKIP" for c in [*case_skips, *qualified, *custody]}
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
            if isinstance(result.get('cleanup_owner'), dict):
                # A remote turn still owns the worker (boxes-thread cancel/expiry/no usable result).
                # Capture it BEFORE validation can reject the receipt (finding 4449994487).
                worker_cleanup_owner = result['cleanup_owner']
            if lifecycle == 'native-producer':
                native_cleanup_reference = {
                    'result': str(result_path), 'native_directory': result.get('fleet_directory'),
                    'cleanup_complete': result.get('cleanup_complete') is True,
                    'result_sha256': hashlib.sha256(result_path.read_bytes()).hexdigest(),
                    'native_evidence': result.get('evidence', {}),
                }
            if isinstance(result.get('evidence'), dict):
                worker_evidence = result['evidence']
            from deploy_test_cloud_refusal import refused_before_admission
            preallocation_refused = refused_before_admission(
                result, request, gate, root, code, invalid_process=timed_out or cancelled or lingering)
            if preallocation_refused:
                raw_cases, complete = result['cases'], False
            else:
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
    teardown = None
    abnormal = timed_out or cancelled or lingering or any(
        isinstance(row, dict) and any(row.get(k) is True for k in ('timed_out', 'cancelled', 'lingering_group'))
        for row in worker_evidence.values())
    if host_admission.get('started') is not False and abnormal:
        try:
            teardown = benchmark_teardown(gate, token, started, folder, root, state['round'])
        except (OSError, ValueError) as error:
            teardown = {'outcome': 'failed', 'error': f'{type(error).__name__}: {error}'}
        if teardown['outcome'] not in ('clean', 'exited', 'terminated'):
            lingering = True  # A KILLed or surviving owner leaves its resources unverified.
    if worker_cleanup_owner is not None:
        # The remote owner must be reconciled before any other token may use that worker
        # thread/root: no credit, and the existing resume guard refuses on lingering_group.
        lingering = True
        valid = False
        complete = False
        reason = reason or 'worker reported a retained remote cleanup owner'
    if native_producer and host_admission.get('started') is not False and not preallocation_refused and (not valid or not complete):
        # Native producers can intentionally retain recovery resources. Unknown
        # native cleanup must be reconciled before another attempt can resume.
        lingering = True
    if not valid:
        # Unknown/unexecuted work is a blocking outcome; cannot waive this via
        # a known constituent failure or by treating launcher exit0 as coverage.
        cases.update({c: "UNVERIFIED" for c in active})
    status = "PASS" if all(v in TERMINAL_OK for v in cases.values()) else "FAIL"
    result = {"gate": name, "status": status, "cases": cases, "native_exit": code,
              "executed": host_admission.get('started', True), "complete": valid and complete,
              "reason": host_admission.get('reason', reason), "timed_out": timed_out,
              "case_complete": {c: valid and v != 'UNVERIFIED' and c not in custody for c, v in cases.items()},
              "current_execution": {c: "UNVERIFIED" for c in custody}, "custody_skips": custody,
              "cancelled": cancelled, "lingering_group": lingering,
              "source": state["source"], "started_at": started, "finished_at": time.time(),
              "command": gate["command"], "log": str(folder / "output.log"),
              "stderr_log": str(folder / 'stderr.log'), "token": token}
    result['execution_binding'] = {'input_fingerprint': state['input_fingerprints'].get(name),
                                   'contract_digest': digest(gate), 'environment': state['environment']}
    result['isolated_validation'] = admission
    result['host_admission'] = host_admission
    result['lifecycle'] = lifecycle
    result['native_cleanup_reference'] = native_cleanup_reference
    if worker_cleanup_owner is not None:
        result['cleanup_owner'] = {'request_token': token, 'worker_cleanup_owner': worker_cleanup_owner,
                                   'native_cleanup_reference': native_cleanup_reference}
    elif native_producer and host_admission.get('started') is not False and (timed_out or cancelled or lingering):
        result['cleanup_owner'] = {'request_token': token, 'worker_root': str(root / gate.get('cwd', '.')),
                                   'native_cleanup_reference': native_cleanup_reference}
    result['worker_evidence'] = worker_evidence
    result['resource_skips'] = qualified
    result['worker_result'] = str(result_path) if result_path.exists() else None
    if teardown is not None:
        result['teardown'] = teardown
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
                               "worker_evidence": result.get('worker_evidence', {}).get(check),
                               "finished_at": result.get("finished_at")})
    return failed


def advance(state: dict, results: list[dict], failures: list[dict] | None = None) -> None:
    phase = state["phase"]
    for result in results:
        state.get('carried_passes', {}).pop(result['gate'], None)
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
    """Owned assignment: NOT_INTRODUCED or a diagnosed UNKNOWN is attribution only; the root keeps the
    repair and re-runs the bound gate.

    The occurrence stays blocking (no skip, no waiver, no credit, no attribution relabel) and cannot be
    combined with a repair link, provider waiver, post-merge packet or execution recovery. An introduced
    defect keeps its normal blocking route; an unassigned UNKNOWN still blocks at the atomic check.
    """
    if entry.get("assigned_repair") is not True:
        raise ValueError("assigned_repair must be the explicit boolean true")
    if entry.get("attribution") not in {"NOT_INTRODUCED", "NOT INTRODUCED", "UNKNOWN"}:
        raise ValueError("assigned_repair retains a NOT_INTRODUCED or UNKNOWN attribution; an introduced "
                         "defect uses the normal blocking path")
    if any(entry.get(k) for k in ASSIGNED_EXCLUSIVE):
        raise ValueError("assigned_repair cannot be combined with a repair link, provider waiver, "
                         "post-merge packet or execution recovery")
    for key in ("assigned_reason", "assigned_evidence"):
        if not isinstance(entry.get(key), str) or not entry[key].strip():
            raise ValueError("assigned_repair requires the owned-assignment reason and an evidence reference")
    if disposition != "blocking":
        raise ValueError("assigned_repair applies to a blocking occurrence only")


RESOURCE_SKIP = "SKIPPED_WITH_WARNING"
RESOURCE_EXCLUSIVE = ("repair_agent", "external_provider", "post_merge", "execute_unverified", "assigned_repair")
# Standing AgentCard release stall (docs/rca/cases/2026-10-02-agentcard-abandonment-closed-card-transfer-never-
# released.md): the exact runtime reason prefix of run_benchmark.AGENTCARD_RELEASE_SKIP_REASON, which records the
# native SKIPPED row only for a catalog sandbox lifecycle task whose stall matched _agentcard_release_stalled.
AGENTCARD_RELEASE_STALL_CODE = "agentcard_release_stall"
AGENTCARD_RELEASE_STALL_REASON = ("AgentCard never released the closed card's org transfer (consumed, "
                                  "releasedCents=0); skipped under the standing user-approved warning policy")


@contextmanager
def source_module(path: Path):
    """Fresh source with an owned module identity, without process-global argv changes."""
    import importlib.util
    module_name = '_deploy_source_' + uuid.uuid4().hex
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        # Bypass timestamp/size based .pyc reuse, including same-size source edits.
        exec(compile(path.read_bytes(), str(path), 'exec'), module.__dict__)
        yield module
    finally:
        if sys.modules.get(module_name) is module:
            del sys.modules[module_name]


def agentcard_release_stall_task(name: object, root: Path = ROOT, production: bool = False) -> bool:
    """The same literal catalog predicate the selector prints for this standing warning. Staged smoke qualifies
    sandbox rows only (the default: production tasks never run there); scripts/deploy_prod.py's production
    lane asks for the production task with production=True."""
    with source_module(root / 'agents/benchmarks/select_predeploy_benches.py') as selector:
        tasks = [task for task in selector.load_tasks(root / 'agents/benchmarks/tasks.json')
                 if task.name == name and bool(task.production_only) is production]
        rules = selector.standing_skip_eligibility(tasks, [name]).get(name, []) if tasks else []
        return any(rule.startswith('AgentCard release-stall standing warning') for rule in rules)



def unreleased_amount_text(transfer: object) -> str:
    """The funds a standing release-stall leaves unreleased, from the runner's own typed org-transfer record:
    transferredCents less releasedCents, with the provider mode (livemode false is the sandbox). An amount the
    record does not state, or states inconsistently, is UNRECORDED, never zero. Shared by the staged cycle's
    warning row and the production lane (scripts/deploy_prod.py)."""
    try:
        transferred, released = transfer['transferredCents'], transfer['releasedCents']
        if any(type(v) is not int or v < 0 for v in (transferred, released)) or released > transferred:
            raise ValueError('unreleased amount is not stated')
    except (KeyError, TypeError, ValueError):
        return 'Unreleased: UNRECORDED'
    livemode = transfer.get('livemode')
    mode = 'live' if livemode is True else 'sandbox' if livemode is False else 'mode UNRECORDED'
    return (f"Unreleased: ${(transferred - released) / 100:.2f} {mode} "
            f"(transferredCents {transferred} / releasedCents {released})")


def agentcard_unreleased_text(state: dict, warning: dict) -> str:
    """The funds a standing release-stall warning leaves unreleased, for its report row.

    Read from the exact native run document the warning is bound to (its sha256 is checked), from the
    runner's own typed org-transfer record (unreleased_amount_text). An amount the record does not state is
    UNRECORDED, never zero.
    """
    failure = next((f for f in state['failures'] if f['id'] == warning['id']), {})
    evidence = failure.get('worker_evidence') if isinstance(failure.get('worker_evidence'), dict) else {}
    try:
        path = evidence['path']
        if sha_file(path) != warning['receipt_sha256']:
            raise ValueError('native run document changed')
        name = warning['native_row']['name']
        task = next(t for t in bounded_read(path, 'native run document')['tasks'] if t.get('name') == name)
        transfer = task['logs']['agentcard_release_stall_lifecycle']['orgTransfer']
    except (KeyError, StopIteration, TypeError, ValueError, OSError):
        return 'Unreleased: UNRECORDED'
    return unreleased_amount_text(transfer)


def sidecar_finished_at(failure: dict):
    """Read-only fallback for occurrences recorded before finished_at existed: the coordinator
    receipt beside the worker result must match the failure exactly; otherwise there is no bound."""
    worker_result = failure.get("worker_result")
    if not isinstance(worker_result, str) or not worker_result:
        return None
    sidecar = Path(worker_result).parent / "receipt.json"
    try:
        receipt = read(sidecar)
    except (OSError, ValueError):
        return None
    case = failure["check"].split("/", 1)[1]
    if (receipt.get("source") != failure.get("source") or receipt.get("gate") != failure.get("gate")
            or receipt.get("executed") is not True or not isinstance(receipt.get("cases"), dict)
            or receipt["cases"].get(case) != failure.get("native_result")
            or receipt.get("case_complete", {}).get(case) != failure.get("complete")):
        return None
    return receipt.get("finished_at")


def standing_claude_bundle(proof: dict) -> dict:
    """Replay the existing predeploy receipt contract; never manufacture a cloud occurrence."""
    import validate_predeploy_receipts as policy
    used = set()
    def raw(path):
        path = Path(path)
        if (not path.is_absolute() or path.resolve() != path or path.is_symlink()
                or not path.is_file() or path.stat().st_size > MAX_RECEIPT_BYTES):
            raise ValueError('standing skip: invalid native evidence path')
        value = path.read_bytes()
        if proof['files'].get(str(path)) != hashlib.sha256(value).hexdigest():
            raise ValueError('standing skip: native evidence hash changed')
        used.add(str(path))
        return value
    def document(path):
        return policy.strict_json(raw(path))
    summary = document(proof['summary'])
    directory = Path(proof['run_dir'])
    run_raw, card_raw = raw(directory / 'run.json'), raw(directory / 'report-card.json')
    run, card = policy.strict_json(run_raw), policy.strict_json(card_raw)
    benchmark = document(directory / 'local-benchmark-owner.json')
    document(directory / 'local-stack-owner.json')
    raw(directory / ('benchmark-cleanup-' + benchmark['token'] + '.status'))
    raw(directory / 'local-stack-cleanup.status')
    confirmations, bindings = document(proof['confirmations']), document(proof['bindings'])
    if (summary.get('tasks') != ['claude-code-agent'] or summary.get('git_sha') != proof['source']['head']
            or summary.get('exit_code') != 0 or len(confirmations) != 1
            or confirmations[0].get('reason_code') != 'standing_claude_credential_unavailable'):
        raise ValueError('standing skip: only the exact native Claude standing policy is supported')
    bundle = {'run': run, 'card': card, 'sha256': hashlib.sha256(run_raw).hexdigest(),
              'card_sha256': hashlib.sha256(card_raw).hexdigest(), 'evidence': str(directory / 'run.json'),
              'cleanup_verified': policy.verify_cleanup(directory)}
    result = policy.validate(summary, [bundle], confirmations, bindings)
    if (result['status'] != 'SKIPPED_WITH_WARNING' or result['counts'] != {'passed':0, 'skipped':1, 'blocked':0}
            or len(result['warnings']) != 1 or result['warnings'][0].get('exception_kind') != 'standing_policy'
            or used != set(proof['files'])):
        raise ValueError('standing skip: native receipt/cleanup/source/catalog/confirmation refused')
    # Re-read after the native validator, which consumes the cleanup owner records directly.
    for path in tuple(used):
        raw(path)
    return result


def standing_skip(state: dict, proof: dict, root: Path) -> None:
    if (CANCEL.is_set() or state.get('phase') in {'interrupted','stale','ready'} or 'live_failures' in state
            or state.get('resume_phase') or proof.get('source') != state['source']
            or state['source'] != source(root) or state['environment'] != environment_digest()
            or state['input_fingerprints'] != input_fingerprints(state['plan'], root)):
        raise ValueError('standing skip requires quiescent exact frozen source/environment')
    if state.get('plan_digest') != digest(state['plan']):
        raise ValueError('standing skip frozen plan changed')
    validate_plan(state['plan'], root)
    gate = next((g for g in state['plan']['gates'] if g['name'] == proof.get('gate')), None)
    if not gate or gate.get('native_cloud') is not True or 'claude-code-agent' not in gate['checks']:
        raise ValueError('standing skip requires the selected native cloud Claude check')
    key = gate['name'] + '/claude-code-agent'
    if key in state['skips']:
        raise ValueError('standing skip cannot overwrite an existing qualification')
    result = standing_claude_bundle(proof)  # Atomic: every native input validates before state changes.
    state['skips'][key] = {'source': state['source'], 'disposition': 'standing / warned',
        'input_fingerprint': state['input_fingerprints'][gate['name']], 'standing_skip': copy.deepcopy(proof),
        'rca': {'attribution':'NOT_INTRODUCED', 'description':result['warnings'][0]['reason'],
                'evidence':str(Path(proof['run_dir']) / 'run.json'), 'policy_source':result['warnings'][0]['policy_source']}}


def revalidate_standing_skips(state: dict) -> None:
    for key, entry in state.get('skips', {}).items():
        if 'standing_skip' in entry:
            if (entry['source'] != state['source'] or entry.get('input_fingerprint')
                    != state['input_fingerprints'].get(key.split('/',1)[0])):
                raise ValueError('standing skip input/source binding changed')
            standing_claude_bundle(entry['standing_skip'])


def validate_resource_skip(entry: dict, failure: dict) -> None:
    """Third-party compute-token exhaustion, or the standing AgentCard release stall of a sandbox lifecycle
    smoke task: the native SKIPPED row stays FAIL in the record and is projected as a warning, never a pass.
    The confirmation must bind the exact row the same way scripts/validate_predeploy_receipts.py does (its
    receipt predicate, lines 141-152), restricted to reason_code compute_quota_exhausted or
    agentcard_release_stall.
    """
    from validate_predeploy_receipts import RESOURCE_CODES, finite
    proof = entry.get("resource_skip")
    if not isinstance(proof, dict):
        raise ValueError("resource_skip must be the typed resource confirmation object")
    if any(entry.get(k) for k in RESOURCE_EXCLUSIVE):
        raise ValueError("resource_skip cannot be combined with a repair link, provider waiver, post-merge packet, "
                         "execution recovery or assigned repair")
    if entry.get("attribution") not in {"NOT_INTRODUCED", "NOT INTRODUCED"}:
        raise ValueError("a resource skip is NOT_INTRODUCED attribution only")
    evidence = failure.get("worker_evidence") if isinstance(failure.get("worker_evidence"), dict) else {}
    row = evidence.get("native_task") if isinstance(evidence.get("native_task"), dict) else {}
    if (failure.get("native_result") != "FAIL" or not failure.get("complete") or row.get("passed") is not False
            or row.get("benchmark_status") != "SKIPPED" or row.get("status") != "SKIPPED"):
        raise ValueError("only a complete, natively SKIPPED compute-token row can be qualified; assertion failures "
                         "and unverified occurrences stay blocking")
    reason, sha = row.get("failure_reason"), evidence.get("sha256")
    finished = failure.get("finished_at")
    if finished is None:
        finished = sidecar_finished_at(failure)
    if proof.get("reason_code") == AGENTCARD_RELEASE_STALL_CODE:
        # A sandbox AgentCard lifecycle smoke task's exact standing release stall: same warning projection.
        cause = (isinstance(reason, str) and reason.startswith(AGENTCARD_RELEASE_STALL_REASON)
                 and agentcard_release_stall_task(row.get("name")))
    else:
        cause = (proof.get("reason_code") in RESOURCE_CODES and proof.get("reason_code") == "compute_quota_exhausted")
    allowed = (isinstance(sha, str) and bool(sha) and proof.get("receipt_sha256") == sha
               and isinstance(reason, str) and bool(reason.strip()) and proof.get("receipt_reason") == reason
               and proof.get("resource_scope") == "third_party" and cause
               and proof.get("exclusive_cause") is True
               and isinstance(proof.get("provider"), str) and bool(proof["provider"].strip())
               and isinstance(proof.get("evidence"), str) and bool(proof["evidence"].strip())
               and finite(proof.get("confirmed_at")) and finite(finished) and proof["confirmed_at"] >= finished)
    if not allowed:
        raise ValueError("resource confirmation does not bind the exact native SKIPPED row "
                         "(receipt sha, exact reason, third_party compute_quota_exhausted or the sandbox "
                         "agentcard_release_stall, exclusive cause, provider, evidence, confirmed_at after the row "
                         "finished)")


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
        if 'standing_policy' in entry:
            # A refresh renewal retains the original native failure, never fabricates a new FAIL.
            prior = failure.get('prior_waiver')
            if (entry.get('prior_waiver') != prior
                    or (prior is not None and failure.get('phase') != 'refresh')):
                raise ValueError('standing treasury renewal differs from its recorded prior qualification')
            finished = failure.get('finished_at')
            if (finished is not None and entry['standing_policy']['evidence_at'] < finished):
                raise ValueError('standing treasury evidence predates the native failure')
        if entry.get("assigned_repair") is not None:
            validate_assigned_repair(entry, disposition)
        if entry.get("resource_skip") is not None:
            validate_resource_skip(entry, failure)
            disposition = RESOURCE_SKIP
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
    repair, renewals = set(), []
    for failure, entry, disposition in decisions:
        failure["rca"] = entry
        failure["disposition"] = disposition
        if failure['source'] != state['source'] and disposition not in {'blocking', 'execution required'}:
            # Same renewal semantics as refresh: old native facts never become a new-source exclusion.
            prior = {'source': failure['source'], 'rca': entry, 'disposition': disposition}
            state.setdefault('superseded_skips', []).append(prior)
            if disposition in {RESOURCE_SKIP, 'pending post-merge'}:
                repair.add(failure['gate'])  # same changed-input execution route as refresh
            else:
                renewals.append({'id': uuid.uuid4().hex, 'check': failure['check'], 'gate': failure['gate'],
                    'source': state['source'], 'native_result': 'prior waived failure; changed inputs',
                    'command': next(g['command'] for g in state['plan']['gates'] if g['name'] == failure['gate']),
                    'complete': True, 'phase': 'refresh', 'prior_waiver': prior})
            continue
        if disposition in {"blocking", "execution required"}:
            repair.add(failure["gate"])
        elif disposition == RESOURCE_SKIP:
            # Keep the outer FAIL and native SKIPPED row as warning evidence, with no pass credit.
            # Only this source/input-bound qualification excludes the case from a later request.
            state.setdefault("resource_warnings", []).append({
                "id": failure["id"], "check": failure["check"], "gate": failure["gate"],
                "native_result": failure["native_result"], "native_row": failure["worker_evidence"]["native_task"],
                "receipt_sha256": entry["resource_skip"]["receipt_sha256"], "confirmation": entry["resource_skip"],
                "source": state["source"], "input_fingerprint": state["input_fingerprints"][failure["gate"]]})
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
    if renewals:
        state['failures'].extend(renewals)
        state['pending'] = [f['id'] for f in renewals]
        state.update(phase='triage', ready=False, failure_phase='refresh')
        if repair:
            state['repair_gates'] = sorted(set(state['repair_gates']) | repair)
            state['triage_repair_gates'] = sorted(repair)
        return
    if repair:
        state["repair_gates"] = sorted(set(state["repair_gates"]) | repair)
        state["phase"] = "needs-focused-plan"
    else:
        # Waivers never trigger a rerun. Continue precisely where this round
        # would have gone if the waived cases had been SKIP initially.
        prior = state["failure_phase"]
        state["phase"] = {"quick": state.get("next_after_quick", "initial"), "initial": "ready",
                          "focused": "failed-gates", "failed-gates": "quick", "final": "ready",
                          "refresh": "needs-focused-plan" if state["repair_gates"] else "final",
                          "needs-focused-plan": "needs-focused-plan"}[prior]
        if prior == "failed-gates":
            state["next_after_quick"] = "final"
        if state["phase"] == "triage":
            state["phase"] = "needs-focused-plan" if state["repair_gates"] else "final"
        state["ready"] = state["phase"] == "ready"


def latest_receipts(state: dict) -> dict:
    """Most recent recorded result per gate, in attempt order (source receipts stay immutable)."""
    latest = {}
    for attempt in state.get("attempts", []):
        for result in attempt.get("results", []):
            latest[result["gate"]] = result
    return latest


OWNER_IDENTITY = ("worker_thread", "worker_host", "worker_root", "turn_id")
OWNER_FIELDS = OWNER_IDENTITY + ("request_token", "message_id", "remote_dir", "pgid")
RECONCILE_EXCLUSIVE = ("repair_agent", "external_provider", "post_merge", "execute_unverified", "assigned_repair", "resource_skip", "standing_policy")
RESULT_BEGIN, RESULT_END = "DEPLOY_GATE_RESULT_JSON_BEGIN", "DEPLOY_GATE_RESULT_JSON_END"


def sha_file(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _finite(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def bounded_read(path, label: str) -> dict:
    """Read a receipt/adapter/proof JSON object within MAX_RECEIPT_BYTES; anything else is a clear refusal."""
    path = Path(path)
    try:
        if path.stat().st_size > MAX_RECEIPT_BYTES:
            raise ValueError("exceeds the receipt transport limit")
        return read(path)
    except (OSError, ValueError) as error:
        raise ValueError(f"{label}: {path} is missing, oversize or not a JSON object ({error})")


def receipt_owner(gate: str, receipt: dict):
    """Owner retained by a gate's latest receipt. New receipts carry it directly; a legacy incomplete
    receipt without one is resolved from its recorded adapter result, identity-checked, failing closed."""
    if receipt.get("lingering_group") or receipt.get("cleanup_owner"):
        owner = receipt.get("cleanup_owner") or {}
        return owner.get("worker_cleanup_owner") if isinstance(owner.get("worker_cleanup_owner"), dict) else (owner or {"lingering": True})
    if receipt.get("complete") is not False or not receipt.get("worker_result"):
        return None  # complete, or no adapter result was ever recorded: nothing to resolve
    if not isinstance(receipt, dict):
        raise ValueError(f"{gate}: recorded receipt is not an object; owner unknown, refuse launch")
    try:
        adapter = bounded_read(receipt["worker_result"], f"{gate}: legacy adapter result")
    except ValueError as error:
        raise ValueError(f"{error}; owner unknown, refuse launch")
    if any(adapter.get(k) != receipt.get(k) for k in ("token", "source", "gate")):
        raise ValueError(f"{gate}: legacy adapter result identity mismatch (token/source/gate); owner unknown, refuse launch")
    owner = adapter.get("cleanup_owner")
    if owner is None:
        if adapter.get("cleanup_complete") is not True:
            raise ValueError(f"{gate}: adapter cleanup state unknown; refuse launch")
        return None  # no retained owner and cleanup is explicitly complete
    if not isinstance(owner, dict) or not all(isinstance(owner.get(k), str) and owner[k] for k in OWNER_IDENTITY):
        raise ValueError(f"{gate}: adapter cleanup owner identity incomplete; refuse launch")
    return owner


def _reconciled(state: dict, receipt: dict, owner: dict) -> bool:
    """A reconciliation is valid only for the exact receipt bytes, token, adapter bytes and owner (re-hashed now)."""
    log = receipt.get("log")
    if not log or not isinstance(owner, dict):
        return False
    try:
        entry = state.get("reconciled_owners", {}).get(sha_file(Path(log).parent / "receipt.json"))
        if entry and entry.get('kind') == 'cloud-source-refusal-cleanup-v1':
            from deploy_test_cloud_refusal import still_bound
            return still_bound(state, receipt, entry)
        if entry and entry.get('kind') == 'interrupted-preallocation-cleanup-v1':
            from deploy_test_interrupted_cleanup import still_bound
            return still_bound(state, receipt, entry)
        if entry and entry.get("kind") == "native-cloud-cleanup-v1":
            from deploy_test_native_cleanup import still_bound
            return still_bound(entry, receipt, owner)
        return bool(entry) and entry.get("token") == receipt.get("token") and receipt.get("worker_result") \
            and entry.get("worker_result_sha256") == sha_file(receipt["worker_result"]) \
            and entry.get("owner") == {k: owner.get(k) for k in OWNER_FIELDS}
    except OSError:
        return False


def isolated_admissions(state: dict, gate: str):
    from deploy_test_native_cleanup import still_bound
    entries = [e for e in state.get('reconciled_owners', {}).values()
               if e.get('purpose') == 'isolated-validation' and e.get('gate') == gate]
    for entry in entries:
        receipts = [r for a in state.get('attempts', []) for r in a.get('results', [])
                    if r.get('gate') == gate and r.get('token') == entry.get('token')]
        if len(receipts) != 1 or not still_bound(entry, receipts[0], receipt_owner(gate, receipts[0])):
            raise ValueError(f'{gate}: original isolated-validation obligation changed; refuse launch/completion')
    return entries


def isolated_request(state: dict, gate: dict, request: dict, root: Path, env: dict) -> list[dict]:
    entries = isolated_admissions(state, gate['name'])
    if not entries:
        return []
    from deploy_test_native_cleanup import need
    need(gate.get('native_cloud') is True and len(gate['command']) == 2
         and Path(gate['command'][1]) == root / 'scripts/deploy_test_cloud.py'
         and (root / gate.get('cwd', '.')).resolve() == root.resolve()
         and not env.get('CLOUDBENCH_ARCHIVED_REUSE_REQUEST'), 'fresh native adapter required')
    requested = request['checks'] + list(request['skips'])
    need(len(set(requested)) == len(requested) and set(requested) == set(gate['checks']), 'full next inventory')
    new_root = root / '.context/deploy-cloud' / hashlib.sha256(request['token'].encode()).hexdigest()
    need(not new_root.exists() and not new_root.is_symlink(), 'new request root already exists')
    bindings = []
    for entry in entries:
        old = bounded_read(Path(entry['proof']['owner']['native_cleanup_reference']['result']).parent / 'request.json', 'old request')
        need(entry['validation_source'] == request['source'] and request['token'] != entry['token']
             and set(old['checks']) | set(old.get('skips', {})) == set(gate['checks']), 'next source/inventory binding')
        bindings.append({'original_receipt_sha256': entry['proof']['receipt_sha256'],
                         'original_request_token': entry['token'], 'new_request_token': request['token'],
                         'source': request['source'], 'new_native_root': str(new_root),
                         'excluded_resources': entry['excluded_resources'], 'credit_granted': False})
    return bindings


def retained_owners(state: dict, gates) -> list[str]:
    latest = latest_receipts(state)
    owned = []
    for name in gates:
        isolated_admissions(state, name)
    for gate in gates:
        receipt = latest.get(gate)
        if not receipt:
            continue
        local = [e for e in state.get('reconciled_owners', {}).values()
                 if e.get('kind') == 'local-supervisor-cleanup-v1'
                 and e.get('gate') == gate and e.get('token') == receipt.get('token')]
        if local:
            from deploy_test_local_cleanup import still_bound
            if len(local) != 1:
                raise ValueError('ambiguous local cleanup reconciliation')
            still_bound(state, receipt, local[0])
            continue  # launch eligibility only; original incomplete cases stay immutable
        owner = receipt_owner(gate, receipt)
        if owner and not _reconciled(state, receipt, owner):
            owned.append(gate)
    return sorted(owned)


def reconcile(state: dict, occurrence_id: str, proof: dict) -> None:
    """Typed, receipt-backed cleanup reconciliation for a boxes-thread owner: clears the owner for launch
    purposes only. Original receipt, adapter result, cases and outcome stay immutable; no test credit."""
    if not isinstance(proof, dict) or any(k in proof for k in RECONCILE_EXCLUSIVE):
        raise ValueError("reconcile input is a cleanup proof only; waivers, links, packets and flags are refused")
    if proof.get('kind') == 'cloud-source-refusal-cleanup-v1':
        from deploy_test_cloud_refusal import reconcile as reconcile_refusal
        reconcile_refusal(state, occurrence_id, proof)
        return
    if proof.get('kind') == 'interrupted-policy-witness-renewal-v1':
        from deploy_test_interrupted_cleanup import renew_policy_witness
        renew_policy_witness(state, occurrence_id, proof)
        return
    if proof.get('kind') == 'interrupted-preallocation-cleanup-v1':
        from deploy_test_interrupted_cleanup import reconcile as reconcile_interrupted
        reconcile_interrupted(state, occurrence_id, proof)
        return
    if proof.get('kind') == 'local-supervisor-cleanup-v1':
        from deploy_test_local_cleanup import reconcile as reconcile_local
        reconcile_local(state, occurrence_id, proof)
        return
    if proof.get("kind") == "native-cloud-cleanup-v1":
        from deploy_test_native_cleanup import reconcile as reconcile_native
        reconcile_native(state, occurrence_id, proof)
        return
    required = ("receipt_sha256", "worker_result_sha256", "request_token", "owner", "platform_result", "native_audit",
                "process", "confirmed_at", "observed_by")
    if any(k not in proof for k in required) or not isinstance(proof.get("observed_by"), str) or not proof["observed_by"].strip():
        raise ValueError("reconcile proof is missing a required field")
    failure = next((f for f in state["failures"] if f["id"] == occurrence_id), None)
    if failure is None:
        raise ValueError("unknown occurrence")
    gate, case = failure["gate"], failure["check"].split("/", 1)[1]
    receipt = latest_receipts(state).get(gate)
    if (not receipt or receipt.get("complete") is not False or receipt.get("cases", {}).get(case) != "UNVERIFIED"
            or failure.get("native_result") != "UNVERIFIED" or failure.get("complete")):
        raise ValueError(f"{gate}: occurrence is not the gate's latest incomplete UNVERIFIED receipt")
    owner = receipt_owner(gate, receipt)
    if (not isinstance(owner, dict)
            or not all(isinstance(owner.get(k), str) and owner[k] for k in OWNER_IDENTITY if k != "turn_id")
            or not (isinstance(owner.get("turn_id"), str) and owner["turn_id"]
                    or owner.get("turn_id") is None and "send_receipt" in proof)):
        raise ValueError(f"{gate}: no retained boxes-thread owner to reconcile (reconcile supports boxes-thread owners only)")
    receipt_path = Path(receipt.get("log", "")).parent / "receipt.json"
    adapter_path = Path(receipt.get("worker_result") or "")
    try:
        on_disk, adapter = bounded_read(receipt_path, "coordinator receipt"), bounded_read(adapter_path, "adapter result")
        platform, audit, process = (bounded_read(proof[k]["path"], k) for k in ("platform_result", "native_audit", "process"))
        receipt_sha, adapter_sha = sha_file(receipt_path), sha_file(adapter_path)
        platform_sha, audit_sha, process_sha = (sha_file(proof[k]["path"]) for k in ("platform_result", "native_audit", "process"))
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise ValueError(f"reconcile proof file unreadable: {error}")
    token = receipt.get("token")
    if on_disk != receipt:
        raise ValueError("on-disk coordinator receipt differs from the recorded receipt for this occurrence")
    if (proof["receipt_sha256"] != receipt_sha or proof["worker_result_sha256"] != adapter_sha
            or proof["request_token"] != token or adapter.get("token") != token
            or adapter.get("source") != receipt.get("source") or adapter.get("gate") != gate):
        raise ValueError("reconcile proof does not bind the exact receipt/adapter bytes and request token")
    if (not isinstance(proof["owner"], dict) or {k: proof["owner"].get(k) for k in OWNER_FIELDS} != {k: owner.get(k) for k in OWNER_FIELDS}
            or owner.get("request_token") != token):
        raise ValueError("reconcile proof owner differs from the adapter cleanup owner (all fields, request token)")
    if proof["platform_result"].get("sha256") != platform_sha or proof["native_audit"].get("sha256") != audit_sha \
            or proof["process"].get("sha256") != process_sha:
        raise ValueError("reconcile proof file hashes do not match the files on disk")
    resolved_owner, send_proof = dict(owner), None
    if "send_receipt" in proof:
        try:
            send_proof = proof["send_receipt"]
            send = bounded_read(send_proof["path"], "send receipt")
            if send_proof["sha256"] != sha_file(send_proof["path"]):
                raise ValueError("send receipt hash mismatch")
        except (OSError, ValueError, TypeError, KeyError) as error:
            raise ValueError(f"invalid send receipt proof: {error}")
        if (send.get("ok") is not True or send.get("operation") != "send"
                or send.get("threadId") != owner["worker_thread"]
                or send.get("disposition") not in {"started", "queued"}
                or not isinstance(owner.get("remote_dir"), str) or not owner["remote_dir"]
                or not any(owner.get(k) is None for k in ("turn_id", "message_id"))):
            raise ValueError("send receipt does not resolve a missing identity for the original worker")
        for key, native_key in (("turn_id", "turnId"), ("message_id", "messageId")):
            value = send.get(native_key)
            if not isinstance(value, str) or not value or owner.get(key) not in (None, value):
                raise ValueError("send receipt identity is missing or conflicts with the original owner")
            resolved_owner[key] = value
    data = platform.get("data") if isinstance(platform.get("data"), dict) else {}
    text = (data.get("output") or {}).get("text") if isinstance(data.get("output"), dict) else None
    completed = data.get("completedAt")
    if (platform.get("ok") is not True or data.get("status") != "completed" or data.get("executionInstanceId") != owner["worker_host"]
            or data.get("turnId") != resolved_owner["turn_id"] or not _finite(completed) or not isinstance(text, str)):
        raise ValueError("platform result is not a completed same-turn terminal result for the owner's host and turn")
    lines = text.split("\n")
    if (f"DEPLOY_GATE_RESULT_SHA256 {audit_sha}" not in lines or RESULT_BEGIN not in lines or RESULT_END not in lines
            or lines.index(RESULT_BEGIN) >= lines.index(RESULT_END)):
        raise ValueError("platform text does not carry the native audit sha marker and embedded result")
    try:
        embedded = json.loads("\n".join(lines[lines.index(RESULT_BEGIN) + 1:lines.index(RESULT_END)]))
    except ValueError:
        raise ValueError("embedded platform result is not valid JSON")
    if embedded != audit:
        raise ValueError("embedded platform result is not identical to the native audit object")
    if (audit.get("token") != token or audit.get("source") != receipt.get("source") or audit.get("gate") != gate
            or audit.get("worker_root") != owner["worker_root"] or audit.get("complete") is not True
            or audit.get("cleanup_complete") is not True or not isinstance(audit.get("evidence"), dict)
            or any(not isinstance(e, dict) or e.get("timed_out") is not False or e.get("cancelled") is not False
                   or e.get("lingering_group") is not False for e in audit["evidence"].values())):
        raise ValueError("native audit is not a clean, complete, cleanup-complete same-token result")
    if (process.get("quiescent") is not True or process.get("orphaned_children") is not False or process.get("remaining") != []
            or process.get("cancelled") is not False or process.get("timed_out") is not False or process.get("error") is not None):
        raise ValueError("process sidecar does not prove a quiescent, fully reaped worker")
    finished = receipt.get("finished_at")
    if (not _finite(proof["confirmed_at"]) or not _finite(finished) or proof["confirmed_at"] < finished
            or proof["confirmed_at"] < completed / 1000):
        raise ValueError("confirmed_at must be finite and after both the receipt and the platform completion")
    existing = [k for k, e in state.get("reconciled_owners", {}).items() if e.get("token") == token and k != receipt_sha]
    if existing:
        raise ValueError("a reconciliation for this token already binds a different receipt")
    state.setdefault("reconciled_owners", {})[receipt_sha] = {
        "occurrence": occurrence_id, "gate": gate, "token": token, "owner": {k: owner.get(k) for k in OWNER_FIELDS},
        "worker_result_sha256": adapter_sha, "native_audit_sha256": audit_sha, "platform_turn_id": data["turnId"],
        "proof": {"platform_result": {"path": proof["platform_result"]["path"], "sha256": platform_sha},
                  "native_audit": {"path": proof["native_audit"]["path"], "sha256": audit_sha},
                  "process": {"path": proof["process"]["path"], "sha256": process_sha}},
        "confirmed_at": proof["confirmed_at"], "observed_by": proof["observed_by"], "credit_granted": False}
    if send_proof is not None:
        entry = state["reconciled_owners"][receipt_sha]
        entry["resolved_owner"] = {k: resolved_owner.get(k) for k in OWNER_FIELDS}
        entry["proof"]["send_receipt"] = {"path": send_proof["path"], "sha256": send_proof["sha256"]}


def interrupted_receipt(state: dict, request_token: str) -> dict:
    """Identify a terminal interrupted operation, without inventing an RCA occurrence."""
    if (state.get('phase') != 'interrupted' or not state.get('attempts')
            or state['attempts'][-1].get('interrupted') is not True
            or state.get('running') or 'live_failures' in state
            or not isinstance(request_token, str) or not request_token):
        raise ValueError('a quiescent interrupted operation token is required')
    rows = [r for r in state['attempts'][-1]['results'] if r.get('token') == request_token]
    if (len(rows) != 1 or latest_receipts(state).get(rows[0]['gate']) != rows[0]
            or rows[0].get('source') != state['source'] or rows[0].get('complete') is not False
            or rows[0].get('executed') is not True or 'UNVERIFIED' not in rows[0].get('cases', {}).values()):
        raise ValueError('token must identify the exact latest incomplete interrupted receipt')
    return rows[0]


def interrupted_boundary(state: dict) -> None:
    """All original ownership must be accounted before resume or source refresh."""
    if (state.get('phase') != 'interrupted' or state.get('resume_phase') not in
            {'quick', 'initial', 'focused', 'failed-gates', 'final'}
            or not state.get('attempts') or state['attempts'][-1].get('interrupted') is not True
            or CANCEL.is_set() or state.get('running') or 'live_failures' in state):
        raise ValueError('quiescent interrupted repair boundary required')
    owned = retained_owners(state, [r['gate'] for r in state['attempts'][-1]['results']])
    if owned:
        raise ValueError('worker ownership remains; reconcile exact cleanup before recovery: ' + ', '.join(owned))


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
    if retained_owners(state, [failure["gate"]]):
        raise ValueError(f"{failure['gate']}: its source receipt still carries a remote/native cleanup owner; "
                         "reconcile that owner before re-executing (finding 4450239861)")
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


RCA_INSTRUCTION = ("/RCA: diagnose this occurrence; return the evidence-backed "
                   "INTRODUCED/NOT_INTRODUCED gate under .claude/shared/deploy-failure-policy.md. "
                   "UNKNOWN blocks. Group with an existing root cause only after reading evidence. "
                   "Do not deploy or weaken assertions/timeouts. Independent failures run concurrently.")
EARLY_POLL_SECONDS = 10.0
EARLY_LIMIT = 10  # early occurrences per gate per round; later failures arrive with the gate's result


def rca_request(directory: Path, failure: dict) -> Path:
    path = directory / "rca" / (failure["id"] + ".json")
    write(path, {**failure, "instruction": RCA_INSTRUCTION})
    return path


def rca_requests(state: dict, directory: Path) -> list[Path]:
    paths = []
    for failure in [*state["failures"], *state.get("live_failures", [])]:
        if failure["id"] not in [*state.get("pending", []), *[f["id"] for f in state.get("live_failures", [])]]:
            continue
        paths.append(rca_request(directory, failure))
    return paths


def early_check(gate: dict, row: dict) -> str | None:
    """The gate check a progress row belongs to, so its early occurrence and the final failure match.

    None for a row naming no check of this gate: an early occurrence exists only for a check the
    final result can fail. The final result reuses it, or supersedes it when that check passes.
    """
    for candidate in (row["unit"], "blackbox:" + row["unit"], row.get("case") or ""):
        if candidate in gate["checks"]:
            return candidate
    return gate["checks"][0] if len(gate["checks"]) == 1 else None


def early_failures(state: dict, gate: dict, rows: list[dict], directory: Path,
                   limit: int | None = None) -> list[tuple[dict, Path, dict]]:
    """Open one occurrence (and RCA request) per newly failing check of a still-running gate.

    Progress rows are advisory: they open an occurrence early, the gate's final result decides it
    (a final failure of the same check reuses this id; a final PASS or an omitted check supersedes it).
    Later rows for an already-open check open nothing and print nothing.
    """
    seen = {(f["gate"], f["check"]) for f in state.get("early_failures", []) if f.get("round") == state["round"]}
    limit = EARLY_LIMIT if limit is None else limit
    opened = []
    for row in progress.failures(rows):
        if len(seen) >= limit:
            break  # bounded like a notice budget: the gate's final result reports the rest
        mapped = early_check(gate, row)
        if mapped is None:
            continue
        check = gate["name"] + "/" + mapped
        if (gate["name"], check) in seen:
            continue
        seen.add((gate["name"], check))
        occurrence = {"id": uuid.uuid4().hex, "check": check, "gate": gate["name"], "early": True,
                      "native_result": row["status"], "scope": row["scope"], "unit": row["unit"],
                      "detail": row.get("detail", ""), "evidence": row.get("log") or None,
                      "source": state["source"], "phase": state["phase"], "round": state["round"],
                      "complete": False, "detected_at": time.time(), "unit_finished_at": row["at"]}
        state.setdefault("early_failures", []).append(occurrence)
        opened.append((occurrence, rca_request(directory, occurrence), row))
    return opened


def settle_early(state: dict, result: dict, fresh: list[dict]) -> list[dict]:
    """Bind a gate's final failures to its early occurrences: same id (one RCA), or superseded on PASS.

    Returns the superseded occurrences, whose RCA (if one was started) should stop.
    """
    early = {f["check"]: f for f in state.get("early_failures", [])
             if f["gate"] == result["gate"] and f.get("round") == state["round"] and "settled" not in f}
    for failure in fresh:
        match = early.pop(failure["check"], None)
        if match is not None:
            failure.update(id=match["id"], early_detected_at=match["detected_at"], early_unit=match["unit"])
            match["settled"] = "reused by final " + failure["native_result"]
    for match in early.values():
        verdict = result["cases"].get(match["check"].split("/", 1)[1])
        match["settled"] = (f"superseded: final {verdict}" if verdict
                            else "superseded: final result omitted this check")
    return list(early.values())


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


CLOUD_SMOKE, CLOUD_SMOKE_PREREQUISITE = 'smoke', 'cloudbench-controller'


def cloud_smoke_prerequisite(plan: dict, state: dict, selected: list[dict]) -> dict | None:
    """The one cross-gate order in a phase: paid cloud smoke waits for the cloudbench-controller gate.

    Original /deploy Step 4cb (DEPRECATED_deploy.md): when the cloudbench-controller gate is planned (it is selected only when
    cloud benchmark scripts changed), its regressions must pass on this source before any paid cloud
    run. Returns that planned gate while it is not already credited for this source and the phase runs
    smoke; None otherwise. Every other gate stays unordered.
    """
    if not any(g.get('category') == CLOUD_SMOKE for g in selected):
        return None
    gate = next((g for g in plan['gates'] if g.get('category') == CLOUD_SMOKE_PREREQUISITE), None)
    return None if gate is None or reusable_full_pass(state, gate) else gate


def prerequisite_passed(result: dict, state: dict) -> bool:
    """This phase's prerequisite receipt is a complete, clean PASS on the cycle's source."""
    return (result.get('status') == 'PASS' and result.get('complete') is True
            and result.get('executed') is not False and result.get('source') == state['source']
            and not any(result.get(k) for k in ('timed_out', 'cancelled', 'lingering_group', 'cleanup_owner')))


def cloud_smoke_held(gate: dict, why: str) -> dict:
    """Trace of a smoke gate that was not started this phase (no paid cloud run, no pass credit)."""
    return {"gate": gate["name"], "prerequisite": CLOUD_SMOKE_PREREQUISITE,
            "reason": f"paid cloud smoke not started: {CLOUD_SMOKE_PREREQUISITE} has not passed on this source "
                      f"({why}; the controller gate guards paid cloud smoke)"}


def cloud_smoke_blocked(gate: dict, state: dict, held: dict) -> dict:
    """Blocking, unexecuted smoke receipt for a prerequisite that neither passed cleanly nor failed a case,
    so the phase cannot advance to READY without the paid run."""
    return {"gate": gate["name"], "status": "FAIL", "complete": False, "executed": False,
            "cases": {c: "UNVERIFIED" for c in gate["checks"]}, "source": state["source"],
            "prerequisite": held["prerequisite"], "reason": held["reason"]}


def run_phase(plan: dict, state: dict, directory: Path, root: Path,
              launcher: list[str] | None = None, *, independent: bool = False,
              excluded_roots=(), repair_independent: bool = False,
              include_repair_local: bool = False) -> None:
    if (source(root) != state["source"] or digest(plan) != state["plan_digest"]
            or environment_digest() != state["environment"]
            or input_fingerprints(plan, root) != state["input_fingerprints"]):
        raise ValueError("source/plan changed; refresh after RCA before running")
    origin_phase = state.get('phase')
    if repair_independent and not independent:
        raise ValueError('repair observation requires independent full execution')
    if include_repair_local and not repair_independent:
        raise ValueError('local repair observation requires the explicit repair-independent action')
    if independent:
        boundary = (origin_phase == 'needs-focused-plan' and not state.get('pending')
                    and bool(state.get('repair_gates'))) if repair_independent else (
                        origin_phase == 'triage' and bool(state.get('pending')))
        if (not boundary or state.get('ready') or CANCEL.is_set() or 'live_failures' in state
                or state.get('running') or state.get('resume_phase')):
            raise ValueError('independent FULL observation requires a quiescent focused-repair boundary'
                             if repair_independent else
                             'independent FULL observation requires quiescent unresolved triage')
        validate_plan(plan, root)
        excluded = {Path(p).resolve() for p in excluded_roots}
        pending_gates = {f['gate'] for f in state['failures'] if f['id'] in state.get('pending', [])}
        if repair_independent and not include_repair_local:
            pending_gates.update(state['repair_gates'])
        selected = [g for g in plan['gates'] if not g.get('quick') and g['name'] not in pending_gates
                    and not (repair_independent and (g.get('native_cloud')
                             or g.get('worker_transport') != 'local-isolated'
                             or g.get('category') == CLOUD_SMOKE))
                    and not reusable_full_pass(state, g)
                    and (g.get('worker_transport') != 'local-isolated'
                         or local_admission_root(g, root) not in excluded)]
        for gate in selected:
            if any(not (p.parent / 'receipt.json').is_file() for p in
                   (directory / 'attempts').glob('*/' + '*/' + gate['name'] + '/request.json')):
                raise ValueError('prior independent worker request has no terminal receipt')
    else:
        selected = records(plan, state)
    held_rows = []
    prerequisite = cloud_smoke_prerequisite(plan, state, selected)
    held = next((g for g in selected if g.get('category') == CLOUD_SMOKE), None) if prerequisite else None
    if prerequisite is not None and all(g['name'] != prerequisite['name'] for g in selected):
        if independent:
            # The prerequisite is itself under unresolved triage: observe everything else, never pay
            # for cloud smoke on a source whose controller regressions have not passed.
            selected = [g for g in selected if g is not held]
            held_rows.append(cloud_smoke_held(held, 'it is pending triage'))
            held = prerequisite = None
        else:
            selected = [*selected, prerequisite]  # run it first: smoke is held until it passes
    if state['phase'] in {'initial', 'failed-gates', 'final'}:
        selected_names = {g['name'] for g in selected}
        for gate in plan['gates']:
            if gate['name'] in selected_names or gate.get('quick') or carried_pass(state, gate):
                continue
            binding = full_pass_binding(state, gate)
            if binding and binding['native_source'] == state['source']:
                entry = {'native_binding': binding, 'from_source': state['source'],
                         'validated_source': state['source'], 'input_fingerprint': state['input_fingerprints'][gate['name']],
                         'contract_digest': digest(gate), 'basis': 'same-source identical FULL execution reused'}
                state.setdefault('carried_passes', {})[gate['name']] = entry
                state.setdefault('pass_carryover_history', []).append({gate['name']: copy.deepcopy(entry)})
    owned = retained_owners(state, [g["name"] for g in selected])
    if owned:
        # Universal launch guard: a gate whose latest receipt still owns remote/native cleanup is
        # never relaunched on the same worker until that owner is reconciled (finding 4450239861).
        raise ValueError("gates still own unreconciled cleanup; refuse launch: " + ", ".join(owned))
    if independent and not selected:
        return  # No worker ran: do not invent an empty full attempt.
    state["round"] += 1
    state["live_failures"] = []
    results = []
    launched = []
    # A retained/unknown cleanup blocks siblings sharing that exact root, not isolated workers.
    local_failures = {local_admission_root(g, root): threading.Event() for g in selected
                      if g.get('worker_transport') == 'local-isolated'}
    with ThreadPoolExecutor(max_workers=max(1, len(selected))) as rc_pool:
        with ThreadPoolExecutor(max_workers=max(1, len(selected))) as pool:
            def submit(gate):
                return pool.submit(execute, gate, state, directory, root,
                    local_failure=local_failures.get(local_admission_root(gate, root))
                        if gate.get('worker_transport') == 'local-isolated' else None)

            def record(result):
                results.append(result)
                fresh = failed_cases(state, [result])
                for match in settle_early(state, result, fresh):
                    if not launcher:  # only the agent started an RCA it must stop
                        print(f"DEPLOY_GATE_EARLY_SUPERSEDED gate={match['gate']} check={match['check']} "
                              f"id={match['id']} {match['settled']}: stop its /RCA", flush=True)
                state["live_failures"].extend(fresh)
                write(directory / "cycle.json", state)
                # Publish and dispatch each failure while healthy siblings run.
                for path in rca_requests(state, directory):
                    # A smoke gate blocked by its prerequisite has nothing of its own to diagnose.
                    if (launcher and not CANCEL.is_set() and not result.get('prerequisite')
                            and path.stem in {f["id"] for f in fresh}):
                        launched.append(rc_pool.submit(launch_rca, path, launcher))

            offsets = {}
            def scan(running):
                # A still-running gate's first failing test opens its occurrence and RCA now.
                for gate in running:
                    path = (directory / "attempts" / str(state["round"]) / state["phase"] / gate["name"]
                            / "progress.jsonl")
                    rows, offsets[gate["name"]] = progress.read_new(path, offsets.get(gate["name"], 0))
                    opened = early_failures(state, gate, rows, directory)
                    if opened:
                        write(directory / "cycle.json", state)
                    for occurrence, path, row in opened:
                        if launcher:
                            # The cycle owns this RCA: launch it now; the deploy agent is not asked to.
                            if not CANCEL.is_set():
                                launched.append(rc_pool.submit(launch_rca, path, launcher))
                        else:
                            print(progress.describe(gate["name"], row, check=occurrence["check"],
                                                    occurrence=occurrence["id"], request=str(path))
                                  + " (start /RCA on this request now)", flush=True)
                    if not launcher and opened and len([f for f in state.get("early_failures", [])
                                                        if f["gate"] == gate["name"] and f.get("round") == state["round"]]) >= EARLY_LIMIT:
                        print(f"DEPLOY_GATE_EARLY_LIMIT gate={gate['name']} limit={EARLY_LIMIT}: "
                              "further failures of this gate arrive with its result", flush=True)

            futures = {submit(gate): gate for gate in selected if gate is not held}
            pending = set(futures)
            while pending:
                done, pending = wait(pending, timeout=EARLY_POLL_SECONDS, return_when=FIRST_COMPLETED)
                scan([futures[f] for f in pending])
                for future in done:
                    gate = futures[future]
                    try:
                        result = future.result()
                    except (ValueError, OSError) as error:
                        result = {"gate": gate["name"], "status": "FAIL", "complete": False,
                                  "cases": {c: "UNVERIFIED" for c in gate["checks"]},
                                  "source": state["source"], "reason": str(error)}
                    record(result)
                    if held is None or gate["name"] != prerequisite["name"]:
                        continue
                    if prerequisite_passed(result, state) and not CANCEL.is_set():
                        started = submit(held)
                        futures[started] = held
                        pending.add(started)
                    elif CANCEL.is_set():
                        held_rows.append(cloud_smoke_held(held, 'the cycle was interrupted'))
                    elif failed_cases(state, [result]):
                        # The prerequisite's own failure blocks this phase; no smoke failure of its own.
                        held_rows.append(cloud_smoke_held(held, f'its result was {result.get("status")}'))
                    else:
                        # Neither a clean pass nor a failed case: block, never advance to READY unpaid.
                        reason = cloud_smoke_held(held, 'its receipt was not a complete clean pass')
                        held_rows.append(reason)
                        record(cloud_smoke_blocked(held, state, reason))
        failures = state.pop("live_failures")
        if independent:
            changed = (source(root) != state['source'] or environment_digest() != state['environment']
                       or input_fingerprints(plan, root) != state['input_fingerprints'])
            state['attempts'].append({'phase': 'triage', 'source': state['source'], 'results': results,
                                     'independent_full': True, 'excluded_roots': sorted(str(p) for p in excluded),
                                     'interrupted': CANCEL.is_set(), 'stale': changed})
            if repair_independent:
                state['attempts'][-1].update(origin_phase=origin_phase,
                    original_repair_gates=list(state['repair_gates']),
                    include_repair_local=include_repair_local, cloud_execution_allowed=False)
            for result in results:
                state.get('carried_passes', {}).pop(result['gate'], None)
            state['failures'].extend(failures)
            pending = list(dict.fromkeys([*state.get('pending', []), *[f['id'] for f in failures]]))
            if pending:
                state.update(pending=pending, phase='triage', ready=False)
                if repair_independent:
                    state['failure_phase'] = origin_phase
            else:
                state.pop('pending', None)
                state.update(phase=origin_phase, ready=False)
        elif CANCEL.is_set():
            state["attempts"].append({"phase": state["phase"], "results": results, "interrupted": True})
            state.update(resume_phase=state["phase"], phase="interrupted", ready=False)
        elif (source(root) != state["source"] or environment_digest() != state["environment"]
              or input_fingerprints(plan, root) != state["input_fingerprints"]):
            state["attempts"].append({"phase": state["phase"], "results": results, "stale": True})
            state.update(phase="stale", ready=False)
        else:
            advance(state, results, failures)
        if held_rows:
            state['attempts'][-1]['held'] = held_rows
        for job in launched:
            try:
                job.result()
            except (ValueError, OSError, subprocess.SubprocessError) as error:
                state.setdefault("rca_launch_errors", []).append(str(error))
        write(directory / "cycle.json", state)


def triage_quick(plan: dict, state: dict, directory: Path, root: Path) -> None:
    """Observe only the fixed quick recipes; keep unresolved triage on its original source."""
    if (CANCEL.is_set() or state.get('phase') != 'triage' or not state.get('pending') or state.get('ready')
            or 'live_failures' in state or state.get('resume_phase')):
        raise ValueError('quick triage refresh requires quiescent unresolved triage')
    old = state['plan']
    if digest(old) != state['plan_digest'] or environment_digest() != state['environment']:
        raise ValueError('original triage plan/environment changed')
    validate_plan(plan, root)
    if plan['source'] != source(root) or plan['source'] == state['source']:
        raise ValueError('quick triage refresh requires exact changed source')
    before, after = ({g['name']: g for g in p['gates']} for p in (old, plan))
    if set(before) != set(after):
        raise ValueError('quick refresh must preserve the full gate inventory')
    for name, gate in before.items():
        preserve_contract(gate, after[name])
        if gate['checks'] != after[name]['checks']:
            raise ValueError('quick refresh must preserve every original check')
    required = {'eslint', 'format', 'typescript', 'backend-structural'}
    quick = [g for g in plan['gates'] if g.get('quick')]
    names = {g['name'] for g in quick}
    # A darwin plan whose mac-app/ changed adds the conditional mac-app-static verifier (deploy_test_plan.py).
    if names not in (required, required | {'mac-app-static'}) or len(quick) != len(names):
        raise ValueError('only the four fixed non-live quick gates (plus mac-app-static) are allowed')
    typescript = ['bash', '-c', 'mkdir -p ../.context/tsbuildinfo && npx tsc --noEmit --incremental '
                  '--tsBuildInfoFile ../.context/tsbuildinfo/back-end.tsbuildinfo']
    mac_static = ['bash', '-c', 'npm run format:check && npm run lint && npm run type-check']
    for gate in quick:
        name, argv = gate['name'], gate['command']
        expected = (typescript if name == 'typescript' else mac_static if name == 'mac-app-static'
                    else ['npm', 'run', 'test:structural'])
        if name in {'eslint', 'format'}:
            expected = [argv[0], 'scripts/check_deploy_static.py', 'lint' if name == 'eslint' else 'format']
            if len(argv) == 5 and argv[3:] == ['--base', plan.get('base')]:
                expected.extend(argv[3:])
            if argv[0] not in {sys.executable, '/usr/bin/python3'}:
                raise ValueError('quick static interpreter changed')
        if (gate.get('category') != name or gate['checks'] != [name] or argv != expected
                or gate.get('cwd', '.') != ('.' if name in {'eslint', 'format'}
                                            else 'mac-app' if name == 'mac-app-static' else 'back-end')
                or gate.get('env', {}) or any(gate.get(k) for k in
                    ('worker', 'worker_transport', 'worker_recipe', 'native_cloud', 'native_backend', 'case_protocol'))):
            raise ValueError('quick recipe is not the fixed non-live command')
    if retained_owners(state, names):
        raise ValueError('quick gate still owns unreconciled cleanup')
    # A killed coordinator may leave requests before any receipt or final summary exists.
    for prior in (directory / 'triage-quick').glob('*'):
        if not (prior / 'summary.json').is_file() or any(
                not (p.parent / 'receipt.json').is_file() for p in prior.glob('attempts/*/quick/*/request.json')):
            raise ValueError('prior quick observation is incomplete; owned work unknown')
    # Failed observation artifacts never authorize another launch over an unknown quick owner.
    for path in (directory / 'triage-quick').glob('*/attempts/*/quick/*/receipt.json'):
        if receipt_owner(path.parent.name, bounded_read(path, 'prior quick observation')):
            raise ValueError('prior quick observation still owns cleanup')
    original = digest(state)
    saved = (directory / 'cycle.json').read_bytes()
    if json.loads(saved) != state:
        raise ValueError('original triage changed before quick observation')
    working = initialize(plan, root)
    working['round'] = state['round'] + 1
    observation = directory / 'triage-quick' / uuid.uuid4().hex
    results = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(execute, gate, working, observation, root) for gate in quick]
        for future in as_completed(futures):
            results.append(future.result())
    write(observation / 'summary.json', {'source': plan['source'], 'plan_digest': digest(plan),
          'results': results, 'original_pending': state['pending'], 'credit': 'quick gates only'})
    if (CANCEL.is_set() or source(root) != plan['source'] or environment_digest() != working['environment']
            or input_fingerprints(plan, root) != working['input_fingerprints']
            or digest(state) != original or (directory / 'cycle.json').read_bytes() != saved):
        raise ValueError('quick observation changed source/environment or original triage')
    if (len(results) != len(names) or {r['gate'] for r in results} != names or any(
            r.get('status') != 'PASS' or r.get('complete') is not True or r.get('executed') is not True
            or r.get('source') != plan['source'] or r.get('lingering_group') or r.get('cleanup_owner')
            or r.get('cancelled') or r.get('timed_out') or r.get('cases') != {r['gate']: 'PASS'} for r in results)):
        raise ValueError('every quick observation must complete; original triage retained')
    state['attempts'].append({'phase': 'quick', 'source': plan['source'], 'results': results,
                              'triage_refresh': True, 'plan_digest': digest(plan)})
    # No source/plan/round/pending/owner rebinding and no advance() or readiness credit.


def local_worker_gate(gate: dict, root: Path, worker_root: str, workspace: str, port: str) -> dict:
    """Construct the sole allowed boxes-to-native relocation; no workload substitutions."""
    old_root = gate.get('worker_root')
    if (gate.get('worker_transport') != 'boxes-thread' or not gate.get('worker_recipe')
            or not isinstance(old_root, str) or not Path(old_root).is_absolute()
            or not isinstance(worker_root, str) or not Path(worker_root).is_absolute()
            or str(Path(worker_root)) != worker_root or not isinstance(workspace, str) or not workspace
            or not isinstance(port, str) or not port.isdigit()):
        raise ValueError('local rebind requires an explicit boxes recipe and absolute local root/identity')
    python = Path(gate['remote_python'])
    if Path(old_root) not in python.parents:
        raise ValueError('original worker Python is outside its checkout')
    def relocate(value):
        if isinstance(value, str):
            return worker_root + value[len(old_root):] if value == old_root or value.startswith(old_root + '/') else value
        if isinstance(value, list):
            return [relocate(item) for item in value]
        if isinstance(value, dict):
            return {key: (workspace if key == 'CONDUCTOR_WORKSPACE_NAME' else
                          port if key == 'CONDUCTOR_PORT' else relocate(item))
                    for key, item in value.items()}
        return value
    result = relocate(gate)
    for key in ('worker_host', 'worker_thread', 'remote_python', 'coordinator_thread'):
        result.pop(key, None)
    result.update(worker=gate['worker'] + '-native-local', worker_root=worker_root, cwd=worker_root,
                  worker_transport='local-isolated', result_transport='stdout')
    result['command'] = [str(Path(worker_root) / python.relative_to(old_root)),
                         str(Path(worker_root) / 'scripts/deploy_test_worker.py'), '--root', worker_root, '--stdio']
    if gate.get('native_backend'):
        result.update(command=[gate['command'][0], str(root / 'scripts/deploy_test_backend.py'),
                               '--root', worker_root], result_transport='file')
    return result


def rebind_local(state: dict, old: dict, new: dict, root: Path) -> None:
    """Explicit same-source native fallback. Ordinary refresh remains contract-strict."""
    if (CANCEL.is_set() or state.get('pending') or 'live_failures' in state or state.get('resume_phase') or state.get('running')
            or state.get('phase') not in {'ready', 'needs-focused-plan', 'failed-gates', 'triage', 'stale'}):
        raise ValueError('local rebind requires quiescent adjudicated state')
    if (old != state['plan'] or digest(old) != state['plan_digest']
            or state['source'] != source(root) or new.get('source') != state['source']
            or state['environment'] != environment_digest()
            or state['input_fingerprints'] != input_fingerprints(old, root)):
        raise ValueError('local rebind requires the exact frozen source, plan, inputs and environment')
    if ({k: v for k, v in old.items() if k != 'gates'} != {k: v for k, v in new.items() if k != 'gates'}
            or [g['name'] for g in old['gates']] != [g['name'] for g in new.get('gates', [])]):
        raise ValueError('local rebind must preserve the complete plan inventory and provenance')
    validate_plan(old, root)
    validate_plan(new, root)  # Includes all roots, database/workspace identities and listener footprints.
    if retained_owners(state, [g['name'] for g in old['gates']]):
        raise ValueError('reconcile existing execution owners before local rebind')
    changed = []
    for before, after in zip(old['gates'], new['gates']):
        if before == after:
            continue
        expected = local_worker_gate(before, root, after.get('worker_root', ''),
                                     after.get('env', {}).get('CONDUCTOR_WORKSPACE_NAME', ''),
                                     after.get('env', {}).get('CONDUCTOR_PORT', ''))
        if after != expected:
            raise ValueError('local rebind changed a check, recipe, deadline or non-identity setting')
        name = before['name']
        if (any(key.startswith(name + '/') for key in state['skips'])
                or any(w.get('gate') == name for w in state.get('resource_warnings', []))):
            raise ValueError('qualified cases require their existing policy renewal, not a transport rebind')
        if source(Path(after['worker_root'])) != state['source']:
            raise ValueError('local worker checkout is not prepared at the exact frozen source')
        for rel in ('.env', 'env.sh', 'back-end/.env', 'agents/.env', 'agents/.env.benchmark-temporal',
                    'front-end/.env', 'front-end/.env.local'):
            origin, destination = root / rel, Path(after['worker_root']) / rel
            if (origin.is_file() != destination.is_file()
                    or origin.is_file() and runtime_config_sha256(origin) != runtime_config_sha256(destination)):
                raise ValueError('local worker runtime configuration differs from the frozen inputs')
        changed.append(name)
    if not changed:
        raise ValueError('local rebind requires at least one boxes-to-local migration')
    fingerprints = input_fingerprints(new, root)
    if source(root) != state['source'] or environment_digest() != state['environment']:
        raise ValueError('source/environment changed during local rebind')
    # Commit only after every binding and obligation validates. No old native record is rewritten.
    state.setdefault('worker_rebind_history', []).append({
        'source': state['source'], 'from_plan': copy.deepcopy(old), 'to_plan_digest': digest(new),
        'from_phase': state['phase'], 'from_focused': copy.deepcopy(state.get('focused', {})),
        'gates': changed, 'at': time.time(), 'credit_granted': False})
    state['carried_passes'] = {name: entry for name, entry in state.get('carried_passes', {}).items()
                              if name not in changed}
    state.update(plan=new, plan_digest=digest(new), input_fingerprints=fingerprints,
                 phase='quick', next_after_quick='initial', focused={}, ready=False)


def refresh(state: dict, old: dict, new: dict, root: Path, *, election_proof: dict | None = None,
            historical_no_retry_proof: dict | None = None) -> None:
    from deploy_test_historical_custody import known, prepare, apply, verify
    if historical_no_retry_proof is not None and election_proof is not None:
        raise ValueError('historical custody cannot mix election flags')
    if historical_no_retry_proof is not None:
        if digest(historical_no_retry_proof) in state.get('historical_custody_refreshes', []):
            from deploy_test_historical_custody import binding, verify
            if (state['plan'] != new or historical_no_retry_proof['current_binding'] != binding(new, root)):
                raise ValueError('historical custody replay differs from current binding')
            verify(state, root)
            return
        rows = prepare(state, old, new, historical_no_retry_proof, root)
        candidate = copy.deepcopy(state)
        pending = copy.deepcopy(state.get('pending_post_merge', []))
        _refresh(candidate, old, new, root)
        protected = {r['original_failure']['id'] for r in rows}
        candidate['pending_post_merge'] = [p for p in candidate.get('pending_post_merge', []) if p['id'] not in protected] + [p for p in pending if p['id'] in protected]
        candidate['superseded_pending_post_merge'] = [p for p in candidate.get('superseded_pending_post_merge', [])
                                                       if p['id'] not in protected]
        for r in rows:
            candidate['skips'].pop(r['original_failure']['check'], None)
        candidate['resource_warnings'] = [w for w in candidate.get('resource_warnings', []) if w['id'] not in protected]
        apply(candidate, rows, root)
        candidate.setdefault('historical_custody_refreshes', []).append(digest(historical_no_retry_proof))
        verify(candidate, root)  # Re-read native/current bindings before the one atomic publication.
        state.clear(); state.update(candidate)
        return
    if known(state, root):
        # Preserve ordinary same-input carry; changed inputs require explicit custody.
        same = input_fingerprints(new, root) == state['input_fingerprints']
        if not same or state.get('historical_no_retry_custody'):
            raise ValueError('historical custody proof required before source refresh')
    _refresh(state, old, new, root, election_proof=election_proof)


def _refresh(state: dict, old: dict, new: dict, root: Path, *, election_proof=None) -> None:
    if digest(old) != state["plan_digest"]:
        raise ValueError("previous plan does not match the frozen selection")
    validate_plan(new, root)
    interrupted_refresh = state.get('phase') == 'interrupted'
    if interrupted_refresh:
        interrupted_boundary(state)
        if state.get('pending'):
            raise ValueError('interrupted pending triage must resume before refresh')
    pending_refresh = bool(state.get('pending'))
    if pending_refresh and (state.get('phase') != 'triage' or CANCEL.is_set()
            or 'live_failures' in state or state.get('running') or state.get('resume_phase')):
        raise ValueError("adjudicate pending occurrences or reach quiescent triage before binding a changed source")
    unstarted_quick = (state["phase"] == "quick" and not state.get('pending')
                       and 'live_failures' not in state and not state.get('resume_phase')
                       and not state.get('running'))
    unstarted_final = (state['phase'] == 'final' and not state.get('pending')
                       and 'live_failures' not in state and not state.get('resume_phase')
                       and not state.get('running')
                       and not any(a.get('phase') == 'final' and a.get('source') == state['source']
                                   and not a.get('stale') for a in state.get('attempts', [])))
    if state["phase"] not in {"ready", "needs-focused-plan", "focused", "failed-gates", "triage", "stale"} and not unstarted_quick and not unstarted_final and not interrupted_refresh:
        raise ValueError("source refresh only at the repair boundary")
    if new["source"] != source(root):
        raise ValueError("new plan is not bound to current source")
    old_gates = {g["name"]: g for g in old["gates"]}
    new_gates = {g["name"]: g for g in new["gates"]}
    from deploy_test_election import prepare as prepare_election
    election = prepare_election(state, old, new, election_proof)
    removed = {election['gate']} if election else set()
    if not old_gates.keys() <= new_gates.keys() | removed:
        raise ValueError("repair cannot silently remove originally selected gates")
    for name, gate in old_gates.items():
        if name in removed:
            continue
        preserve_contract(gate, new_gates[name])
        if not set(gate["checks"]) <= set(new_gates[name]["checks"]):
            raise ValueError("repair cannot silently remove originally selected checks")
    fingerprints = input_fingerprints(new, root)
    if (new["source"] == state["source"] and digest(new) == state["plan_digest"]
            and fingerprints == state["input_fingerprints"]):
        raise ValueError("refresh requires actual changed source or plan")
    # No scope is inferred: absent input_paths means '*' and any source-file change reruns that gate.
    # History-only/tree-identical syncs work for the current broad production plan; declared scopes may be selective.
    carried, completed_repairs = {}, set()
    pending_gates = {f['gate'] for f in state['failures'] if f['id'] in state.get('pending', [])}
    pending_gates.update(state.get('triage_repair_gates', []))
    if state['environment'] == environment_digest():
        for name, gate in old_gates.items():
            if name in removed:
                continue
            binding = full_pass_binding(state, gate, root=root, custody_refresh=True)
            if (binding and (binding['native_source'] == state['source'] or carried_pass(state, gate, root=root, custody_refresh=True))
                    and digest(gate) == digest(new_gates[name])):
                # Retire historical repair routing using the OLD validated FULL
                # receipt. This grants no new-source credit: changed inputs
                # remain selected by FINAL's ordinary full-coverage predicate.
                if (name in state['repair_gates'] and name not in pending_gates
                        and not any(key in state for key in ('live_failures', 'running', 'resume_phase'))):
                    try:
                        if not retained_owners(state, [name]):
                            completed_repairs.add(name)
                    except (OSError, ValueError, KeyError, TypeError, StopIteration):
                        pass  # Unknown execution ownership cannot retire a repair.
                if state['input_fingerprints'].get(name) == fingerprints.get(name):
                    carried[name] = {'native_binding': binding, 'from_source': state['source'],
                        'validated_source': new['source'], 'input_fingerprint': fingerprints[name],
                        'contract_digest': digest(new_gates[name]), 'basis': 'identical gate inputs and full execution contract'}
    carry, revisit, superseded_pending = {}, [], []
    for key, skip in state["skips"].items():
        gate = key.split("/", 1)[0]
        if gate in removed:
            continue  # Original qualification remains in superseded_skips below.
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
    kept_warnings, stale_warnings = [], []
    for warning in state.get("resource_warnings", []):
        if warning.get("input_fingerprint") == fingerprints.get(warning["gate"]):
            # Same inputs on a new head: the exclusion follows the active source; the native
            # SKIPPED row keeps its immutable original binding.
            kept_warnings.append({**warning, "original_source": warning.get("original_source", warning["source"]),
                                  "source": new["source"]})
        else:  # the original native SKIPPED row keeps its source; a new sweep needs a renewed confirmation
            stale_warnings.append({**warning, "superseded": "changed inputs; renewed confirmation required"})
    if stale_warnings:
        state["superseded_resource_warnings"] = [*state.get("superseded_resource_warnings", []), *stale_warnings]
    if "resource_warnings" in state or stale_warnings:
        state["resource_warnings"] = kept_warnings
    if superseded_pending:
        done = {p["id"] for p in superseded_pending}
        state["superseded_pending_post_merge"] = [*state.get("superseded_pending_post_merge", []), *superseded_pending]
        state["pending_post_merge"] = [p for p in state.get("pending_post_merge", []) if p["id"] not in done]
    state["failures"].extend(revisit)
    if revisit:
        state["pending"] = list(dict.fromkeys([*state.get("pending", []), *[f["id"] for f in revisit]]))
        state["failure_phase"] = "refresh"
    if pending_refresh:
        # Original occurrences keep their old source; a new source still requires final full coverage.
        state['failure_phase'] = 'refresh'
    state['carried_passes'] = carried
    if carried:
        state.setdefault('pass_carryover_history', []).append(copy.deepcopy(carried))
    state['repair_gates'] = [name for name in state['repair_gates']
                            if name not in carried and name not in completed_repairs]
    from deploy_test_election import apply as apply_election
    apply_election(state, election)
    if interrupted_refresh:
        state.pop('resume_phase')
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
    try:
        from deploy_test_election import completion_block as election_block
        blocked = election_block(state)
        if blocked:
            return blocked
        for gate in {e['gate'] for e in state.get('reconciled_owners', {}).values()
                     if e.get('purpose') == 'isolated-validation'}:
            isolated_admissions(state, gate)
            latest = latest_receipts(state).get(gate, {})
            full = next(g for g in state['plan']['gates'] if g['name'] == gate)
            if (set(latest.get('cases', {})) != set(full['checks'])
                    or latest.get('source') != state['source'] and not carried_pass(state, full)
                    or latest.get('complete') is not True
                    or receipt_owner(gate, latest)):
                return 'isolated validation still requires complete current-source full coverage; original obligations preserved'
    except (OSError, ValueError, KeyError, TypeError) as error:
        return str(error)
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
        revalidate_standing_skips(state)
        from deploy_test_historical_custody import verify as verify_custody
        verify_custody(state, root)
        from deploy_test_election import verify as verify_elections
        verify_elections(state)
        for gate in plan['gates']:
            if gate['name'] in state.get('carried_passes', {}) and not carried_pass(state, gate):
                return 5
        for gate in {e['gate'] for e in state.get('reconciled_owners', {}).values()
                     if e.get('purpose') == 'isolated-validation'}:
            isolated_admissions(state, gate)
        return 0
    except (OSError, ValueError, KeyError, TypeError):
        return 2


def main(argv: list[str] | None = None) -> int:
    """Dispatch a validated cycle transition and persist its evidence."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["init", "run", "resume", "status", "triage", "focus", "refresh", "rebind-local", "triage-quick", "triage-independent", "repair-independent", "rca", "verify", "report", "resolve", "complete", "reexecute", "reconcile", "standing-skip", "accept-omitted-custody", "prepare-agentcard-renewal", "renew-agentcard-warning", "prepare-historical-no-retry", "prepare-historical-import", "import-historical-custody", "import-historical-no-retry"])
    parser.add_argument('--donor-state', type=Path,
                        help='import-historical-no-retry: immutable independent donor cycle snapshot')
    parser.add_argument('--exclude-root', type=Path, action='append', default=[],
                        help='triage-independent: currently leased worker roots to leave untouched')
    parser.add_argument('--donor-index', type=Path)
    parser.add_argument('--donor-sha256')
    parser.add_argument('--donor-index-sha256')
    parser.add_argument("--historical-no-retry-proof", type=Path)
    parser.add_argument('--include-repair-local', action='store_true',
                        help='repair-independent: also observe complete original local repair gates; cloud stays deferred')
    parser.add_argument("--proof", type=Path, help="reconcile: typed cleanup proof JSON")
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
        if args.include_repair_local and args.action != 'repair-independent':
            raise ValueError('--include-repair-local requires repair-independent')
        plan = read(args.plan)
        directory = args.state_dir.resolve()
        with exclusive(directory):
            journal = directory / 'settlement-journal.json'
            if journal.exists():
                committed = directory / 'settlement-committed.json'
                if not committed.is_file() or read(committed) != {'journal_sha256': sha_file(journal)}:
                    raise ValueError('pending settlement journal; resume its exact recovery before normal actions')
            state_path = directory / "cycle.json"
            state = initialize(plan, args.root) if args.action == "init" else read(state_path)
            if args.action == "init" and state_path.exists():
                raise ValueError("existing cycle must not be reset")
            if args.action in {"run", "resume"}:
                if args.action == "resume":
                    if state["phase"] != "interrupted":
                        raise ValueError("resume requires an interrupted cycle")
                    interrupted_boundary(state)
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
            elif args.action in {'triage-independent', 'repair-independent'}:
                with cancellation_handlers():
                    run_phase(plan, state, directory, args.root, args.rca_launcher,
                              independent=True, excluded_roots=args.exclude_root,
                              repair_independent=args.action == 'repair-independent',
                              include_repair_local=args.include_repair_local)
            elif args.action == "triage-quick":
                with cancellation_handlers():
                    triage_quick(plan, state, directory, args.root)
            elif args.action == 'prepare-agentcard-renewal':
                if digest(plan) != state['plan_digest']:
                    raise ValueError('renewal plan differs from frozen selection')
                from deploy_test_agentcard_renewal import binding
                if not args.occurrence:
                    raise ValueError('--occurrence original warning id required')
                print(json.dumps({**binding(state, args.occurrence, args.root), 'prepared_at': time.time()}))
                return 0
            elif args.action == 'renew-agentcard-warning':
                if digest(plan) != state['plan_digest']:
                    raise ValueError('renewal plan differs from frozen selection')
                from deploy_test_agentcard_renewal import renew
                if args.proof is None:
                    raise ValueError('--proof read-only provider confirmation required')
                renew(state, bounded_read(args.proof, 'AgentCard renewal'), args.root)
            elif args.action in {'prepare-historical-import', 'import-historical-custody'}:
                from deploy_test_historical_custody import import_proof, import_history
                if (args.donor_state is None or args.donor_index is None
                        or not args.donor_sha256 or not args.donor_index_sha256
                        or plan != state['plan'] or args.historical_no_retry_proof is not None):
                    raise ValueError('custody import requires explicit pinned donor, index and exact current plan')
                donor_args = (args.donor_state.absolute(), args.donor_index.absolute(),
                              args.donor_sha256, args.donor_index_sha256)
                if args.action == 'prepare-historical-import':
                    print(json.dumps(import_proof(state, *donor_args, args.root)))
                    return 0
                if args.proof is None:
                    raise ValueError('custody import requires exact prepared --proof')
                import_history(state, *donor_args, read(args.proof), args.root)
            elif args.action == 'prepare-historical-no-retry':
                if args.input is None:
                    raise ValueError('--input previous plan required')
                from deploy_test_historical_custody import build
                print(json.dumps(build(state, read(args.input), plan, args.root)))
                return 0
            elif args.action == 'import-historical-no-retry':
                if args.input is None or args.donor_state is None or args.historical_no_retry_proof is None:
                    raise ValueError('--input donor plan, --donor-state and --historical-no-retry-proof required')
                if plan != state['plan']:
                    raise ValueError('custody transfer plan differs from fresh selection')
                from deploy_test_historical_custody import adopt
                adopt(state, read(args.donor_state), read(args.input), read(args.historical_no_retry_proof), args.root)
            elif args.action == "refresh":
                if args.input is None:
                    raise ValueError("--input previous plan required")
                refresh(state, read(args.input), plan, args.root,
                        election_proof=bounded_read(args.proof, 'AgentCard election custody') if args.proof else None,
                        historical_no_retry_proof=read(args.historical_no_retry_proof) if args.historical_no_retry_proof else None)
            elif args.action == 'rebind-local':
                if args.input is None:
                    raise ValueError('--input previous frozen plan required')
                rebind_local(state, read(args.input), plan, args.root)
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
            elif args.action == 'accept-omitted-custody':
                if args.input is None:
                    raise ValueError('--input native operational acceptance required')
                from deploy_test_election import accept
                accept(state, bounded_read(args.input, 'omitted operational acceptance'))
            elif args.action == "reexecute":
                reexecute(state, args.occurrence)
            elif args.action == "standing-skip":
                if args.proof is None:
                    raise ValueError('--proof native standing-skip input required')
                standing_skip(state, bounded_read(args.proof, 'standing skip proof'), args.root)
            elif args.action == "reconcile":
                if args.proof is None:
                    raise ValueError("--proof cleanup proof required")
                reconcile(state, args.occurrence, bounded_read(args.proof, "cleanup proof"))
            elif args.action == "complete":
                # Post-merge completion (Step 12a / before the final scorecard): every packet dispatched and resolved.
                blocked = pending_completion_block(state)
                if blocked:
                    print(f"DEPLOY_CYCLE INCOMPLETE: {blocked}", file=sys.stderr)
                    return 1
            elif args.action == "verify":
                from deploy_test_historical_custody import verify as verify_custody
                verify_custody(state, args.root)
                from deploy_test_election import verify as verify_elections
                verify_elections(state)
                if args.require_resolved and pending_completion_block(state):
                    raise ValueError(pending_completion_block(state))
                if (not state["ready"] or state["phase"] != "ready"
                        or source(args.root) != state["source"] or digest(plan) != state["plan_digest"]
                        or environment_digest() != state["environment"]
                        or input_fingerprints(plan, args.root) != state["input_fingerprints"]):
                    raise ValueError("cycle not complete on exact current source and plan")
            elif args.action == "report":
                from deploy_test_historical_custody import verify as verify_custody
                verify_custody(state, args.root)
                from deploy_failure_report import render
                failures = [{**f["rca"], "disposition": f["disposition"]}
                            for f in state["failures"] if "rca" in f]
                header = (f"Deploy validation: {state['phase']}\nSource: {state['source']['head']}\n"
                          f"Pending RCA: {len(state.get('pending', []))}\n"
                          f"Pending post-merge: {len(state.get('pending_post_merge', []))}\n"
                          f"Resource warnings: {len(state.get('resource_warnings', []))}\n")
                # The header is not a scorecard: pass none so BLOCKING failures render (finding 4447557591).
                text = header + render({"failures": failures})
                for election in state.get('elected_omissions', []):
                    text += ('\nOPTIONAL COVERAGE SKIPPED (no task or cleanup credit)\n'
                             + election['reason'] + '\nNative: ' + election['native_result']
                             + '\nOriginal financial/custody obligations remain recorded.\n')
                for row in state.get('historical_no_retry_custody', []):
                    f = row['original_failure']
                    text += (f"\n{f['check']}: SKIPPED — historical no-retry custody; current-source behavior "
                             f"and financial state UNVERIFIED. Original native {f['worker_evidence']['native_task']['benchmark_status']}; "
                             f"historical unreleased {row['original_amount_cents']} cents. No execution or financial credit.\n")
                warnings = state.get("resource_warnings", [])
                if warnings:
                    text += "\nRESOURCE WARNINGS (third-party resource skipped with warning; no pass credit)\n"
                    for w in warnings:
                        proof = w["confirmation"]
                        text += (f"- {w['check']} — {proof['provider']}: {proof['receipt_reason']} [{proof['reason_code']}]"
                                 f" · Evidence: {proof['evidence']} · Confirmed at: {proof['confirmed_at']}"
                                 f" · Receipt: {w['receipt_sha256']} · Native: {w['native_result']}")
                        if proof['reason_code'] == AGENTCARD_RELEASE_STALL_CODE:
                            text += f" · {agentcard_unreleased_text(state, w)} (followup: unreleased funds stay open)"
                        if 'renewal' in w:
                            renewal = w['renewal']
                            text += (f" · Current-input exclusion renewed at: {renewal['finished_at']}"
                                     f" · No new execution or financial cleanup credit")
                        text += "\n"
                (directory / "report.md").write_text(text)
                print(text, end="")
                return 0
            write(state_path, state)
            print(json.dumps({"phase": state["phase"], "ready": state["ready"],
                              "failures": len(state.get("pending", [])), "source": state["source"],
                              "pending_post_merge": len(state.get("pending_post_merge", [])),
                              "resource_warnings": len(state.get("resource_warnings", []))}))
            return 1 if args.action in {"run", "resume"} and not state["ready"] else 0
    except (ImportError, ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        print(f"DEPLOY_CYCLE BLOCKED: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
