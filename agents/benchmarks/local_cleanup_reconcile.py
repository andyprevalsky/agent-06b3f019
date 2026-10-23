"""Reconcile an isolated local stack whose owner exited after publishing state=pending.

run.sh publishes ``local-stack-cleanup.status`` as ``pending`` when its EXIT
trap starts and ``clean`` when teardown finishes. If the owner dies inside the
trap (killed, host suspended, wedged worker drain), the receipt stays
``pending`` and ``stop_services`` keeps refusing with "cleanup remains
unverified". This module re-establishes the clean state from real checks only:

  owner record ─┬─ owner pid gone (native identity no longer live)
                ├─ no process carries the stack token, runs from or names its run dir
                ├─ no listener on the stack's recorded service ports
                └─ its recorded owned database (system PG db / Docker container+volume) absent
     all pass → atomic receipt: same schema-2 fields bound to the original owner,
                state=clean plus reconciled_* evidence; then stop_services re-reads it
     any fail → receipt untouched (pending), each failed check reported

CLI: ``scripts/run-bench --local --run-id <id> --reconcile-cleanup``.
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

RECEIPT_NAME = "local-stack-cleanup.status"
OWNER_NAME = "local-stack-owner.json"
SYSTEM_PG_PORT = 5432


@dataclass
class ReconcileResult:
    state: str  # clean | pending | already_clean
    evidence: dict[str, str] = field(default_factory=dict)
    failures: list[str] = field(default_factory=list)


def _read_receipt(path: Path) -> dict[str, str]:
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f"cleanup receipt is missing or unsafe: {path}")
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        key, separator, value = line.partition("=")
        if not separator or key in values:
            raise RuntimeError(f"cleanup receipt is malformed: {path}")
        values[key] = value
    return values


def _ancestors(pid: int) -> set[int]:
    seen = {pid}
    current = pid
    for _ in range(64):
        try:
            out = subprocess.run(["ps", "-o", "ppid=", "-p", str(current)], capture_output=True, text=True, timeout=5)
            parent = int(out.stdout.strip())
        except (ValueError, OSError, subprocess.SubprocessError):
            break
        if parent <= 1 or parent in seen:
            break
        seen.add(parent)
        current = parent
    return seen


def _process_table() -> list[tuple[int, str, str, str]]:
    """(pid, argv, environ, cwd) for every readable same-user process; raises when unobservable."""
    rows: list[tuple[int, str, str, str]] = []
    if platform.system() == "Linux":
        uid = os.getuid()
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                if entry.stat().st_uid != uid:
                    continue
                argv = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
                environ = (entry / "environ").read_bytes().replace(b"\0", b"\n").decode(errors="replace")
                cwd = os.readlink(entry / "cwd")
            except FileNotFoundError:
                continue  # exited during the scan
            except ProcessLookupError:
                continue
            rows.append((int(entry.name), argv, environ, cwd))
        return rows
    out = subprocess.run(["ps", "-axeww", "-o", "pid=,command="], capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError("process table is unreadable")
    for line in out.stdout.splitlines():
        pid, _, rest = line.strip().partition(" ")
        if pid.isdigit():
            rows.append((int(pid), rest, rest, ""))
    return rows


def _listening_ports() -> set[int]:
    if platform.system() == "Linux":
        ports: set[int] = set()
        for name in ("/proc/net/tcp", "/proc/net/tcp6"):
            try:
                lines = Path(name).read_text().splitlines()[1:]
            except FileNotFoundError:
                continue
            for line in lines:
                parts = line.split()
                if len(parts) > 3 and parts[3] == "0A":  # TCP_LISTEN
                    ports.add(int(parts[1].rsplit(":", 1)[1], 16))
        return ports
    out = subprocess.run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"], capture_output=True, text=True, timeout=30)
    if out.returncode not in (0, 1):
        raise RuntimeError("listening sockets are unreadable")
    return {int(line.rsplit(":", 1)[1]) for line in out.stdout.splitlines() if line.startswith("n") and ":" in line}


def _database_present(database: dict) -> str | None:
    """None when absent; a description when present. Raises when absence cannot be proven."""
    name = database.get("name")
    if database.get("use_system_postgres"):
        if not isinstance(name, str) or not name:
            raise RuntimeError("recorded system database has no name")
        out = subprocess.run(
            ["psql", "-h", "localhost", "-p", str(SYSTEM_PG_PORT), "-U", "postgres", "-At", "-v", f"name={name}"],
            input="select datname from pg_database where datname = :'name';\n",
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "PGPASSWORD": "postgres"},
        )
        if out.returncode != 0:
            raise RuntimeError(f"system database query failed: {out.stderr.strip()[:200]}")
        return f"system database {name}" if out.stdout.strip() else None
    container = database.get("container") or ""
    volume = database.get("volume") or ""
    present = []
    if container:
        out = subprocess.run(
            [
                "docker",
                "container",
                "ls",
                "--all",
                "--no-trunc",
                "--filter",
                f"name=^{container}$",
                "--format",
                "{{.ID}}",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if out.returncode != 0:
            raise RuntimeError("docker container query failed")
        if out.stdout.strip():
            present.append(f"container {container}")
    if volume:
        out = subprocess.run(
            ["docker", "volume", "ls", "--filter", f"name=^{volume}$", "--format", "{{.Name}}"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if out.returncode != 0:
            raise RuntimeError("docker volume query failed")
        if out.stdout.strip():
            present.append(f"volume {volume}")
    return ", ".join(present) or None


def reconcile_stack_cleanup(
    local,
    stack,
    *,
    process_table: Callable[[], list[tuple[int, str, str, str]]] = _process_table,
    listening_ports: Callable[[], set[int]] = _listening_ports,
    database_present: Callable[[dict], str | None] = _database_present,
) -> ReconcileResult:
    context = Path(stack.context_dir)
    owner_path = context / OWNER_NAME
    receipt_path = context / RECEIPT_NAME
    if owner_path.is_symlink() or not owner_path.is_file():
        raise RuntimeError(f"stack ownership is unverified: {owner_path}")
    owner = json.loads(owner_path.read_text())
    for key in ("pid", "token", "native_identity", "birth"):
        if not owner.get(key):
            raise RuntimeError(f"stack owner record is missing {key}: {owner_path}")
    if owner.get("run_id") != stack.run_id:
        raise RuntimeError("stack owner record belongs to another run")
    receipt = _read_receipt(receipt_path)
    if receipt.get("token") != owner["token"]:
        raise RuntimeError("cleanup receipt token does not match the stack owner")
    if receipt.get("state") == "clean":
        return ReconcileResult("already_clean")
    if receipt.get("state") != "pending":
        raise RuntimeError(f"only a pending receipt is reconciled; found state={receipt.get('state')}")
    if receipt.get("stack_pid") != str(owner["pid"]):
        raise RuntimeError("pending receipt does not match its original process")

    result = ReconcileResult("pending")
    pid = int(owner["pid"])
    tools = local._process_identity_tools()
    try:
        current = tools["current_identity"](pid)
    except (OSError, ValueError, IndexError):
        current = None
        if local._pid_is_alive(pid):
            result.failures.append(f"owner pid {pid} is alive and its identity is unreadable")
    if current == owner["native_identity"]:
        result.failures.append(f"owner pid {pid} is still running")
    elif not any(f.startswith("owner") for f in result.failures):
        result.evidence["owner"] = f"pid {pid} identity {owner['native_identity']} gone" + (
            f" (pid reused as {current})" if current else ""
        )

    token_marker = f"RUN_STACK_CLEANUP_TOKEN={owner['token']}"
    dir_markers = {str(context.resolve()), f"benchmarks/{stack.run_id}/"}
    skip = _ancestors(os.getpid())
    try:
        leftovers = []
        for proc_pid, argv, environ, cwd in process_table():
            if proc_pid in skip:
                continue
            if (
                token_marker in environ.split("\n")
                or any(marker in argv for marker in dir_markers)
                or (argv.rstrip().endswith(f"benchmarks/{stack.run_id}"))
                or (cwd and (cwd == str(context.resolve()) or cwd.startswith(str(context.resolve()) + "/")))
            ):
                leftovers.append(proc_pid)
        if leftovers:
            result.failures.append(f"processes still carry the stack token or run dir: {sorted(leftovers)}")
        else:
            result.evidence["processes"] = "none carry the stack token or run dir"
    except Exception as error:  # an unobservable table is not proof of absence
        result.failures.append(f"process table unverifiable: {error}")

    manifest_path = Path(stack.manifest_path)
    manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else None
    if not isinstance(manifest, dict):
        result.failures.append(f"services manifest is missing: {manifest_path}")
    else:
        database = manifest.get("database") if isinstance(manifest.get("database"), dict) else {}
        ports = manifest.get("ports") if isinstance(manifest.get("ports"), dict) else {}
        recorded = sorted({int(p) for p in ports.values() if isinstance(p, int) and p > 0})
        if database.get("use_system_postgres"):
            recorded = [p for p in recorded if p != SYSTEM_PG_PORT]  # shared server, not stack-owned
        try:
            busy = sorted(set(recorded) & listening_ports())
            if busy:
                result.failures.append(f"recorded ports still listening: {busy}")
            else:
                result.evidence["ports"] = "free:" + ",".join(map(str, recorded))
        except Exception as error:
            result.failures.append(f"listening ports unverifiable: {error}")
        if not database.get("owned_by_run_sh"):
            result.evidence["database"] = "none owned by the stack"
        else:
            try:
                present = database_present(database)
                if present:
                    result.failures.append(f"recorded database still exists: {present}")
                else:
                    label = database.get("name") if database.get("use_system_postgres") else database.get("container")
                    result.evidence["database"] = f"absent:{label}"
            except Exception as error:
                result.failures.append(f"database absence unverifiable: {error}")

    if result.failures:
        return result
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    lines = [
        "version=2",
        f"token={owner['token']}",
        "state=clean",
        f"stack_pid={owner['pid']}",
        f"stack_birth={owner['birth']}",
        f"stack_native_identity={owner['native_identity']}",
        "reconciled_by=local.py --reconcile-cleanup",
        f"reconciled_at={stamp}",
        f"reconciled_from_state={receipt.get('state')}",
        *(f"reconciled_{key}={value.replace(chr(10), ' ')}" for key, value in result.evidence.items()),
    ]
    temporary = receipt_path.with_name(f"{receipt_path.name}.tmp.{os.getpid()}")
    temporary.write_text("\n".join(lines) + "\n")
    os.replace(temporary, receipt_path)
    # The normal reader must now accept the receipt for this exact owner.
    local.stop_services(stack=stack)
    result.state = "clean"
    return result


def main(local, args) -> int:
    if not args.run_id:
        print("❌ --reconcile-cleanup requires --run-id <stack-run-id>")
        return 2
    stack = local.build_service_stack(args)
    try:
        result = reconcile_stack_cleanup(local, stack)
    except RuntimeError as error:
        print(f"❌ reconcile refused for {stack.run_id}: {error}")
        return 1
    for key, value in result.evidence.items():
        print(f"  ✓ {key}: {value}")
    for failure in result.failures:
        print(f"  ✗ {failure}")
    if result.state == "pending":
        print(f"❌ {stack.run_id}: cleanup still unverified; receipt left pending")
        return 1
    print(f"✅ {stack.run_id}: cleanup receipt state=clean ({result.state})")
    return 0
