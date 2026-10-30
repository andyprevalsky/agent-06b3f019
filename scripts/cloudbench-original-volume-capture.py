#!/usr/bin/env python3
"""Capture a stopped cloudbench guest's original volume files without rerunning it.

Generic post-service recovery for one failed fresh-clone or pool fleet owner
whose guest stopped before sealing runtime evidence. Exact-owner recovery then
reports "original-volume runtime archive required". This helper:

1. checks the exact owner, run, task, Machine and volume against the durable
   registry/audit records and the native Fly Machines API. It refuses a foreign
   or live owner, a held recovery lock, changed or unsupported configs, running
   or destroyed resources and any existing capture, before any provider mutation;
2. saves the exact original Machine config privately;
3. replaces ``init.cmd`` with ``sleep infinity`` while the Machine is
   stopped, then boots it. Explicit ``--isolate-services`` also removes network
   services for this inert boot; default admission still refuses services.
   No inherited ``init.exec``/``init.entrypoint`` is
   allowed, and the guest must show no driver process, so the original driver
   cannot run again;
4. copies the original ``/data`` files read-only into ``<machine-id>.tar.gz``
   using the same file contract as ``cloudbench-startup-failure-archive.py``
   (``original_files``), so members match what
   ``cloudbench-build-interrupted-pool-archive.py`` consumes. Absent files are
   recorded as missing and never created;
5. stops the Machine, restores the exact original config without starting it,
   proves the native stopped state and attached volume, and writes a
   zero-credit provenance receipt.

It never deletes, releases or reaps a Machine, volume, claim or receipt. If
any step fails after the inert config was applied, the helper stops the
Machine, restores the original config once stopped, and writes
``<machine-id>.capture-failure.json`` instead of a capture. If that cleanup
cannot finish, ``--restore-original-config`` with the same capture directory
completes only the stop and restore steps.

Usage (from the controller's workspace):
  python3 scripts/cloudbench-original-volume-capture.py \\
    --registry <git-common>/cloudbench-fleet-ownership/<owner-token> \\
    --bench <task> --machine-id <id> --volume-id <vol_id> \\
    --capture-dir <absolute-private-directory> [--preflight-only]
"""

from __future__ import annotations

import argparse
import base64
import copy
import ctypes
import errno
import fcntl
import hashlib
import io
import json
import os
import re
import runpy
import shutil
import signal
import socket
import shlex
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

SCHEMA = "cloudbench-original-volume-capture-v1"
DRIVER_CMD = ["bash", "/cloudbench-boot.sh"]
INERT_CMD = ["sleep", "infinity"]
DATA_PATH = "/data"
INVENTORY_MARKER = "CLOUDBENCH_ORIGINAL_VOLUME_INVENTORY="
ERROR_MARKER = "CLOUDBENCH_ORIGINAL_VOLUME_ERROR="
MAX_TOTAL_BYTES = 512 * 1024 * 1024
# The archive builder admits regular members whose names match this pattern.
MEMBER_NAME = re.compile(r"[A-Za-z0-9._/-]+")
SAFE_TOKEN = re.compile(r"[A-Za-z0-9._-]+")
LOG_NAME = re.compile(r"[A-Za-z0-9._-]+\.log")
CONTEXT = "repo/.context/cloudbench/"
LOG_DIR = CONTEXT + "logs/"
# Any live process carrying one of these markers means the guest is not inert.
FORBIDDEN_GUEST_MARKERS = (
    "cloudbench-boot",
    "cloudbench-run.sh",
    "cloudbench-status-server",
    "cloudbench-worker",
    "/data/repo",
)
EXIT_REFUSED = 3
EXIT_FAILED = 1


STARTUP_ARCHIVE = "cloudbench-startup-failure-archive.py"
# Driver-written interrupt receipts and live progress beyond the shared set.
EXTRA_ORIGINALS = (
    "cloudbench-interrupt-cleanup-{token}.status",
    CONTEXT + "cloudbench-interrupt-cleanup-{token}.status",
    CONTEXT + "report-card.json",
)


def extra_names(token: str) -> list[str]:
    return [name.format(token=token) for name in EXTRA_ORIGINALS]


def sibling(name: str) -> dict:
    return runpy.run_path(str(Path(__file__).resolve().with_name(name)))


def original_file_contract() -> dict:
    """The original guest file set shared with the startup-failure capture."""
    return sibling(STARTUP_ARCHIVE)


def expected_names(token: str, configured_old: bool = False) -> set[str]:
    names = original_file_contract()["original_names"](token) | set(extra_names(token))
    if configured_old:
        names |= {f"cloudbench-prelaunch-{token}.sealed", f"cloudbench-prestack-{token}.sealed"}
    return names


def allowed_name(name: str, fixed: set[str]) -> bool:
    if name in fixed:
        return True
    return name.startswith(LOG_DIR) and LOG_NAME.fullmatch(name[len(LOG_DIR):]) is not None


# ── Guest side: runs on the inert guest from an ephemeral /tmp directory ────


class GuestRefusal(Exception):
    pass


def _scan_processes(proc: Path) -> tuple[int, list[dict[str, object]]]:
    own = {os.getpid(), os.getppid()}
    sleepers = 0
    forbidden = []
    for entry in os.listdir(proc):
        if not entry.isdigit() or int(entry) in own:
            continue
        try:
            raw = (proc / entry / "cmdline").read_bytes()
        except TimeoutError:
            raise
        except OSError:
            continue
        argv = [part.decode("utf-8", "replace") for part in raw.split(b"\0") if part]
        if argv in (INERT_CMD, ["/bin/sleep", "infinity"], ["/usr/bin/sleep", "infinity"]):
            sleepers += 1
        if any(marker in arg for arg in argv for marker in FORBIDDEN_GUEST_MARKERS):
            forbidden.append({"pid": int(entry), "argv0": os.path.basename(argv[0]) if argv else ""})
    return sleepers, forbidden


def configured_data_mount(data: Path, machine: str) -> dict:
    """Reuse the canonical mounted-/data proof, bound to this exact guest."""
    if not re.fullmatch(r"[0-9a-f]{14}", machine or "") or os.environ.get("FLY_MACHINE_ID") != machine:
        raise GuestRefusal("configured capture guest Machine identity differs")
    try:
        proof = original_file_contract()["current_cold_mount"](data)
        root_device = Path("/").stat().st_dev
        result = dict(schema="cloudbench-configured-data-mount-v1", machine_id=machine,
                      path=str(data), root_device=root_device, **proof)
        validate_configured_data_mount(result, machine)
        return result
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise GuestRefusal("configured capture requires the distinct mounted original /data") from error


def validate_configured_data_mount(value: object, machine: str) -> None:
    if (not isinstance(value, dict) or set(value) != {
            "schema", "machine_id", "path", "device", "inode", "root_device", "mount_device"}
            or value.get("schema") != "cloudbench-configured-data-mount-v1"
            or value.get("machine_id") != machine or value.get("path") != DATA_PATH
            or any(type(value.get(key)) is not int or value[key] < 0 for key in ("device", "inode", "root_device"))
            or value["inode"] == 0 or value["device"] == value["root_device"]
            or value.get("mount_device") != f'{os.major(value["device"])}:{os.minor(value["device"])}'):
        raise ValueError("configured original data mount attestation differs")


def guest_collect(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="cloudbench-original-volume-capture guest-collect")
    parser.add_argument("--data", required=True)
    parser.add_argument("--run-token", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--proc", default="/proc")
    parser.add_argument("--configured-old-member", action="store_true")
    parser.add_argument("--machine-id")
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        if not SAFE_TOKEN.fullmatch(args.run_token):
            raise GuestRefusal("unsafe run token")
        sleepers, forbidden = _scan_processes(Path(args.proc))
        if forbidden or sleepers < 1:
            raise GuestRefusal(f"guest is not inert: sleepers={sleepers} forbidden={forbidden}")
        mount = configured_data_mount(Path(args.data), args.machine_id or os.environ.get("FLY_MACHINE_ID")) if args.configured_old_member else None
        contract = original_file_contract()
        extra = list(expected_names(args.run_token, args.configured_old_member)
                     - contract["original_names"](args.run_token))
        # Read-only originals; absent files are reported, never created.
        files, missing = contract["original_files"](args.data, args.run_token, extra)
        descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as raw:
            with tarfile.open(fileobj=raw, mode="w:gz") as archive:
                for name in sorted(files):
                    info = tarfile.TarInfo(name)
                    info.size, info.mode, info.mtime = len(files[name]), 0o600, 0
                    archive.addfile(info, io.BytesIO(files[name]))
            raw.flush()
            os.fsync(raw.fileno())
        if contract["original_files"](args.data, args.run_token, extra) != (files, missing):
            raise GuestRefusal("original files changed during capture")
        if mount is not None and configured_data_mount(Path(args.data), args.machine_id or os.environ.get("FLY_MACHINE_ID")) != mount:
            raise GuestRefusal("configured original data mount changed during capture")
        with open(args.output, "rb") as built:
            data = built.read()
        inventory = {
            "version": 1,
            "run_token": args.run_token,
            "files": {name: {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
                      for name, content in sorted(files.items())},
            "missing": sorted(missing),
            "archive_bytes": len(data),
            "archive_sha256": hashlib.sha256(data).hexdigest(),
            "inert_sleepers": sleepers,
            **({"data_mount": mount} if mount is not None else {}),
        }
        print(INVENTORY_MARKER + json.dumps(inventory, sort_keys=True, separators=(",", ":")), flush=True)
        return 0
    except (GuestRefusal, OSError, ValueError, tarfile.TarError) as error:
        print(ERROR_MARKER + json.dumps({"error": str(error)[:500]}), flush=True)
        return EXIT_REFUSED


# ── Controller side ──────────────────────────────────────────────────────────


class Refusal(Exception):
    """Preflight refusal: no provider mutation was attempted."""


class CaptureFailure(Exception):
    """A failure after the first provider mutation."""


class NotFound(Exception):
    pass


def regular_bytes(path: Path, limit: int = 1048576) -> bytes:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as error:
        raise Refusal(f"missing or unsafe file: {path} ({error.strerror})") from None
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise Refusal(f"unsafe or oversized file: {path}")
        data = stream.read(info.st_size + 1)
    if len(data) != info.st_size:
        raise Refusal(f"file changed during read: {path}")
    return data


def fields(path: Path) -> dict[str, str]:
    pairs = [line.split("=", 1) for line in regular_bytes(path, 65536).decode().splitlines()]
    if any(len(pair) != 2 for pair in pairs) or len(dict(pairs)) != len(pairs):
        raise Refusal(f"malformed record: {path}")
    return dict(pairs)


def json_file(path: Path, limit: int = 1048576):
    try:
        return json.loads(regular_bytes(path, limit))
    except json.JSONDecodeError:
        raise Refusal(f"malformed JSON: {path}") from None


def lexists(path: Path) -> bool:
    return os.path.lexists(path)


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def exact_directory(path: Path, label: str) -> Path:
    if not path.is_absolute() or path.resolve() != path or not path.is_dir() or path.is_symlink():
        raise Refusal(f"{label} is not an exact absolute directory: {path}")
    return path


def bash_lib(library: str, call: list[str], *, cwd: Path | None = None, timeout: int = 30) -> str:
    """Call an existing scripts/lib primitive instead of reimplementing it."""
    root = Path(__file__).resolve().parent
    script = root / "lib" / library
    if not lexists(script):
        script = root / library  # The canonical fleet snapshot flattens scripts/lib.
    regular_bytes(script)
    result = subprocess.run(
        ["bash", "-c", 'source "$1" >/dev/null || exit; shift; "$@"', "cloudbench-capture", str(script), *call],
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=cwd,
        check=False,
    )
    if result.returncode != 0:
        raise Refusal(f"{call[0]} failed (exit {result.returncode})")
    return result.stdout.strip()


def pid_birth_state(pid: str, start: str) -> str:
    return bash_lib("cloudbench-env.sh", ["cloudbench_pid_birth_state", pid, start])


def run_bounded(argv: list[str], seconds: float, env: dict[str, str]) -> tuple[int, bytes, bytes]:
    """Bounded child with process-group cleanup; 142 on deadline like fly_with_timeout."""
    process = subprocess.Popen(
        argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=env, start_new_session=True,
    )

    def terminate() -> None:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                return
            try:
                process.wait(timeout=2)
                return
            except subprocess.TimeoutExpired:
                continue

    try:
        stdout, stderr = process.communicate(timeout=seconds)
        return process.returncode, stdout, stderr
    except subprocess.TimeoutExpired:
        terminate()
        stdout, stderr = process.communicate()
        return 142, stdout, stderr
    except BaseException as error:
        # An interrupt must not strand a detached flyctl session.
        terminate()
        # Preserve already captured private bytes on the original exception.
        # The deadline has fired: do not wait again for inherited pipe handles.
        try:
            error.stdout, error.stderr = process.communicate(timeout=0)
        except subprocess.TimeoutExpired as partial:
            error.stdout, error.stderr = partial.output or b"", partial.stderr or b""
        finally:
            process.stdout.close()
            process.stderr.close()
        raise


def flyctl_binary() -> str:
    found = shutil.which("flyctl")
    if not found:
        fallback = Path.home() / ".fly/bin/flyctl"
        if os.access(fallback, os.X_OK):
            found = str(fallback)
    if not found:
        raise Refusal("flyctl not found on PATH")
    return found


class Fly:
    """Raw Machines API for exact config reads/writes; flyctl for guest SSH/SFTP."""

    def __init__(self, app: str, token: str) -> None:
        import urllib.parse

        self.app = app
        self.binary = flyctl_binary()
        self.env = {**os.environ, "FLY_API_TOKEN": token}
        host = os.environ.get("FLY_API_HOSTNAME", "https://api.machines.dev").rstrip("/")
        if not host.startswith(("https://", "http://")):
            host = "https://" + host
        endpoint = urllib.parse.urlsplit(host)
        self.loopback = endpoint.hostname in {"localhost", "127.0.0.1", "::1"}
        if endpoint.scheme != "https" and not (endpoint.scheme == "http" and self.loopback):
            raise Refusal("Machines API endpoint must use HTTPS")
        self.base = host
        self.authorization = self._authorization(token)

    def _authorization(self, token: str) -> str:
        # Same credential handling as cloudbench_publish_warm_deps_state: session
        # tokens are refreshed through the selected flyctl session, never logged.
        scheme = "Bearer"
        for prefix in ("Bearer ", "FlyV1 "):
            if token.startswith(prefix):
                scheme, token = prefix.strip(), token[len(prefix):].strip()
                break
        if token.startswith(("fm1r_", "fm1a_", "fm2_")):
            env = {**self.env}
            env.pop("FLY_ACCESS_TOKEN", None)
            rc, stdout, _ = run_bounded([self.binary, "auth", "token", "--json", "--quiet"], 60, env)
            try:
                refreshed = json.loads(stdout).get("token") if rc == 0 else None
            except (ValueError, AttributeError):
                refreshed = None
            if not isinstance(refreshed, str) or not refreshed.strip():
                raise Refusal("could not refresh the selected Fly session")
            token, scheme = refreshed.strip(), "FlyV1"
            for prefix in ("Bearer ", "FlyV1 "):
                if token.startswith(prefix):
                    scheme, token = prefix.strip(), token[len(prefix):].strip()
                    break
        if not token:
            raise Refusal("empty Fly credential")
        return f"{scheme} {token}"

    def api(self, method: str, path: str, body: object | None = None, timeout: int = 60, headers: dict | None = None, observer=None):
        import urllib.error
        import urllib.parse
        import urllib.request

        url = self.base + "/v1/apps/" + urllib.parse.quote(self.app, safe="") + path
        data = (b"" if method == "POST" else None) if body is None else json.dumps(body).encode()
        request = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": self.authorization, "Content-Type": "application/json", **(headers or {})})
        handlers = [urllib.request.ProxyHandler({})] if self.loopback else []
        opener = urllib.request.build_opener(*handlers)
        try:
            with opener.open(request, timeout=timeout) as response:
                payload = response.read(256 * 1024 * 1024)
                if observer is not None: observer(method, path, response.status, payload)
        except urllib.error.HTTPError as error:
            error_body = error.read(256 * 1024 * 1024)
            if observer is not None: observer(method, path, error.code, error_body)
            if error.code == 404:
                raise NotFound(path) from None
            detail = error_body[:200].decode("utf-8", "replace")
            raise CaptureFailure(f"Machines API {method} {path} returned HTTP {error.code}: {detail}") from None
        except (urllib.error.URLError, OSError) as error:
            raise CaptureFailure(f"Machines API {method} {path} failed: {error}") from None
        return json.loads(payload) if payload.strip() else {}

    def machine(self, machine_id: str) -> dict:
        value = self.api("GET", f"/machines/{machine_id}")
        if not isinstance(value, dict) or value.get("id") != machine_id:
            raise CaptureFailure("native Machine read is not exact")
        return value

    def volume(self, volume_id: str) -> dict:
        value = self.api("GET", f"/volumes/{volume_id}")
        if not isinstance(value, dict) or value.get("id") != volume_id:
            raise CaptureFailure("native volume read is not exact")
        return value

    def flyctl(self, seconds: int, *args: str) -> tuple[int, str, str]:
        rc, stdout, stderr = run_bounded([self.binary, *args], seconds, self.env)
        return rc, stdout.decode("utf-8", "replace"), stderr.decode("utf-8", "replace")


    def machine_exec_json(self, seconds: int, machine_id: str, command: str, *,
                          max_command_bytes: int, validate_ack,
                          max_response_bytes: int = 1048576) -> dict:
        """Opt-in receipt delivery; byte budget is caller policy, not provider capacity.

        Never stage, retry, print private output, or infer guest success from the
        raw CLI exit. The caller must authenticate its own source/nonce/ACK.
        """
        if (type(seconds) is not int or seconds <= 0
                or type(max_command_bytes) is not int or max_command_bytes <= 0
                or type(max_response_bytes) is not int or max_response_bytes <= 0
                or not callable(validate_ack) or not isinstance(command, str)
                or not command or "\0" in command
                or not isinstance(machine_id, str) or not SAFE_TOKEN.fullmatch(machine_id)):
            raise Refusal("invalid bounded machine exec arguments")
        if seconds > 600:
            raise Refusal("Machine exec timeout must not exceed 600 seconds")
        if len(command.encode("utf-8")) > max_command_bytes:
            raise Refusal("Machine exec command exceeds caller delivery budget")
        rc, stdout, _ = self.flyctl(seconds, "machine", "exec", machine_id, command,
                                   "--timeout", str(seconds), "-a", self.app, "--json")
        if rc != 0 or len(stdout.encode("utf-8")) > max_response_bytes:
            raise CaptureFailure("Machine exec transport or response bound failed")
        try:
            envelope = json.loads(stdout)
            if (not isinstance(envelope, dict) or set(envelope) - {"stdout", "stderr", "exit_code"}
                    or envelope.get("stderr") not in (None, "")
                    or not isinstance(envelope.get("stdout"), str)
                    or not envelope["stdout"].strip()):
                raise ValueError("unconfirmed guest output")
            if "exit_code" in envelope and (type(envelope["exit_code"]) is not int or envelope["exit_code"] != 0):
                raise ValueError("unconfirmed guest exit")
            value = json.loads(envelope["stdout"])
            if not isinstance(value, dict) or validate_ack(value) is not True:
                raise ValueError("unconfirmed caller acknowledgement")
        except Exception:
            # Error strings can contain private stdout, env or credentials.
            raise CaptureFailure("Machine exec acknowledgement refused") from None
        return value


def validate_original_config(config: object, ident: dict) -> None:
    readiness = sibling("cloudbench-machine-readiness.py")
    if not isinstance(config, dict) or not readiness["startup_command_overridable"](config):
        raise Refusal("Machine startup cannot be made inert by replacing init.cmd alone")
    init, env, mounts = config.get("init") or {}, config.get("env"), config.get("mounts")
    if init.get("cmd") != DRIVER_CMD:
        raise Refusal(f"Machine config changed: init.cmd is {init.get('cmd')!r}, not the original boot driver")
    if not isinstance(env, dict) or env.get("CLOUDBENCH_RUN_TOKEN") != ident["token"]:
        raise Refusal("native Machine config belongs to a different guest run token")
    if (
        not isinstance(mounts, list) or len(mounts) != 1 or not isinstance(mounts[0], dict)
        or mounts[0].get("volume") != ident["volume_id"] or mounts[0].get("path") != DATA_PATH
    ):
        raise Refusal("native Machine does not mount exactly the owned volume at /data")
    if "@sha256:" not in str(config.get("image", "")):
        raise Refusal("native Machine image is not digest-pinned")
    for key in ("services", "containers", "processes", "standbys", "schedule"):
        if config.get(key):
            if key == "services" and ident.get("isolate_services"):
                # Only network listeners are isolated. Other startup mechanisms
                # remain unsupported under this explicit capture option.
                services = config[key]
                if isinstance(services, list) and all(isinstance(s, dict) for s in services):
                    continue
            raise Refusal(f"unsupported Machine config: {key} is set")
    if config.get("auto_destroy"):
        raise Refusal("unsupported Machine config: auto_destroy is set")


def configured_old_member_identity(args: argparse.Namespace) -> dict:
    """Diagnostic capture only; never consume the replaced member's obligation."""
    registry = exact_directory(args.registry, "registry")
    meta = fields(registry / "meta")
    if (meta.get("host") != socket.gethostname()
            or not re.fullmatch(r"[0-9]+", meta.get("pid", ""))
            or not meta.get("pid_start")
            or pid_birth_state(meta["pid"], meta["pid_start"]) != "absent"):
        raise Refusal("configured old-member owner is not proven dead on this host")
    if not SAFE_TOKEN.fullmatch(args.bench) or not re.fullmatch(r"[0-9a-f]{14}", args.machine_id):
        raise Refusal("unsafe configured old-member identity")
    run = exact_directory(Path(meta["runs_root"]) / meta["run_id"], "run")
    output = exact_directory(run / args.bench / ("host-replaced-" + args.machine_id), "old output")
    workspace = exact_directory(Path(meta["workspace_root"]), "workspace")
    helper = sibling(STARTUP_ARCHIVE)
    try:
        members = helper["replaced_preconfig_members"](registry)
        matches = [row for row in members if row[0] == args.bench and row[1] == args.machine_id
                   and row[3] == str(output)]
        if len(matches) != 1:
            raise ValueError("old member is not uniquely enumerated")
        token = matches[0][2]
        original_meta, original, files = helper["preconfig_files"](registry, output, args.machine_id, token)
    except (ValueError, KeyError, OSError, AssertionError, StopIteration) as error:
        raise Refusal("configured old-member custody is invalid") from error
    if (original_meta != meta or original["volume_id"] != args.volume_id
            or not re.fullmatch(r"vol_[A-Za-z0-9]+", args.volume_id)):
        raise Refusal("configured old-member volume differs")
    for name in ("guest-cleanup-unconfirmed", "runtime-evidence-unconfirmed"):
        regular_bytes(registry / name, 65536)
    if lexists(output / "failed-preconfig-runtime-archive/consumed.json"):
        raise Refusal("old member already has a consumed phase")
    return dict(registry=registry, owner=registry.name, meta=meta, run=run, run_id=meta["run_id"],
                out=output, audit=Path(meta["audit_dir"]), workspace=workspace, app=meta["app"],
                bench=args.bench, ordinal=int(token.rsplit("-", 1)[1]), token=token, kind="clone",
                machine_id=args.machine_id, volume_id=args.volume_id, clone_name=original["clone_name"],
                isolate_services=args.isolate_services, undelivered_native_stop=None,
                configured_old_member=True,
                custody_sha256=sha(canonical({name: sha(data) for name, data in files.items()})),
                capture_helper_sha256=sha(Path(__file__).resolve().read_bytes()))


def revalidate_configured_old_member(ident: dict) -> None:
    if not ident.get("configured_old_member"):
        return
    args = argparse.Namespace(registry=ident["registry"], bench=ident["bench"],
                              machine_id=ident["machine_id"], volume_id=ident["volume_id"],
                              isolate_services=ident["isolate_services"])
    if configured_old_member_identity(args) != ident:
        raise Refusal("configured old-member custody changed during capture")


def configured_old_source(config: dict, ident: dict) -> tuple[str, str, str]:
    env = config.get("env", {})
    expected = {"CLOUDBENCH_BOOT": "1", "CLOUDBENCH_FRESH_VOLUME": "1",
                "CLOUDBENCH_RUN_TOKEN": ident["token"],
                "BENCH_TASKS_B64": base64.b64encode(ident["bench"].encode()).decode()}
    if (any(env.get(key) != value for key, value in expected.items())
            or any(env.get(key, value) != value for key, value in {
                "CLOUDBENCH_DATA_DIR": "/data", "CLOUDBENCH_REPO_DIR": "/data/repo"}.items())):
        raise Refusal("configured old-member native task or data path differs")
    try:
        source = sibling("cloudbench-prestack-recovery.py")["native_recipe"](ident["meta"], config)
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        raise Refusal("configured old-member native source recipe differs") from error
    original = json_file(ident["run"] / "execution-provenance.json")
    if source[0] != original.get("base_sha"):
        raise Refusal("configured old-member native source differs from original run")
    return source


def local_identity(args: argparse.Namespace) -> dict:
    """Exact durable owner/run/task/resource binding; read-only."""
    if getattr(args, "configured_old_member", False):
        if getattr(args, "undelivered_native_stop", False):
            raise Refusal("configured old-member and undelivered modes conflict")
        return configured_old_member_identity(args)
    registry = exact_directory(args.registry, "registry")
    owner = registry.name
    if not re.fullmatch(r"[0-9a-f]{32}", owner):
        raise Refusal("registry is not an exact fleet owner token")
    meta = fields(registry / "meta")
    if meta.get("version") != "2" or meta.get("fleet_owner_token") != owner:
        raise Refusal("registry belongs to a foreign owner")
    undelivered = getattr(args, "undelivered_native_stop", False)
    if undelivered:
        # A guest the controller natively stopped because its authenticated
        # shutdown was never delivered: the owner is quarantined (retain plus
        # guest-cleanup-unconfirmed) and its provider-session identity exists
        # only on this stopped volume. Admission is bound below to the exact
        # verified guest-native-stop.json for this Machine and volume.
        if meta.get("cleanup_policy") != "retain":
            raise Refusal("undelivered native-stop capture requires the retained quarantine policy")
        sentinel = registry / "guest-cleanup-unconfirmed"
        if not sentinel.is_file() or sentinel.is_symlink():
            raise Refusal("undelivered native-stop capture requires the guest-cleanup-unconfirmed latch")
    elif meta.get("cleanup_policy") != "reap":
        raise Refusal("owner cleanup policy is not reap")
    if meta.get("host") != socket.gethostname():
        raise Refusal("owner belongs to another host")
    if not re.fullmatch(r"[0-9]+", meta.get("pid", "")) or not meta.get("pid_start"):
        raise Refusal("owner process identity is invalid")
    if pid_birth_state(meta["pid"], meta["pid_start"]) != "absent":
        raise Refusal("original owner controller is not proven dead")
    if not undelivered:
        if lexists(registry / "guest-cleanup-unconfirmed"):
            raise Refusal("guest cleanup is unconfirmed; run exact-owner recovery first")
        latch = registry / "runtime-evidence-unconfirmed"
        if not latch.is_file() or latch.is_symlink():
            raise Refusal("runtime evidence latch is not retained; no capture is required")
    run_id = meta.get("run_id", "")
    if not SAFE_TOKEN.fullmatch(run_id):
        raise Refusal("unsafe run id")
    run = exact_directory(Path(meta.get("runs_root", "")) / run_id, "run")
    audit = exact_directory(Path(meta.get("audit_dir", "")), "audit")
    workspace = exact_directory(Path(meta.get("workspace_root", "")), "workspace")
    audit_meta = fields(audit / "meta")
    if audit.name != owner or any(audit_meta.get(k) != meta.get(k) for k in ("fleet_owner_token", "run_id", "app")):
        raise Refusal("audit record belongs to a foreign owner")
    if not SAFE_TOKEN.fullmatch(meta.get("app", "")):
        raise Refusal("unsafe Fly app")
    lifecycle = json_file(run / "_batch/lifecycle.json")
    if (
        not isinstance(lifecycle, dict) or lifecycle.get("status") != "failed" or lifecycle.get("fleet_owner_token") != owner
        or lifecycle.get("run_id") != run_id or type(lifecycle.get("controller_exit_code")) is not int
        or lifecycle["controller_exit_code"] == 0
    ):
        raise Refusal("fleet run is not terminal and failed")
    tasks = json_file(run / "_batch/benches.json")
    names = [row.get("name") for row in tasks if isinstance(row, dict)] if isinstance(tasks, list) else []
    if not isinstance(tasks, list) or len(names) != len(tasks):
        raise Refusal("run task catalog is malformed")
    if not names or len(set(names)) != len(names) or args.bench not in names or not SAFE_TOKEN.fullmatch(args.bench):
        raise Refusal("task is not exactly one slot of this run")
    ordinal = names.index(args.bench)
    token = f"{owner}-{ordinal}"
    out = exact_directory(run / args.bench, "task output")
    cid = regular_bytes(out / ".cid", 256).decode().split()
    if len(cid) != 2 or cid[0] not in {"clone", "pool"} or not re.fullmatch(r"[0-9a-f]{14}", cid[1]):
        raise Refusal("task is not bound to one fresh-clone or pool Machine")
    kind, machine = cid
    if machine != args.machine_id:
        raise Refusal("requested Machine is not the task's exact Machine")
    if regular_bytes(out / "post-config-start.accepted", 256) != (machine + "\n").encode():
        raise Refusal("guest was never admitted with its boot config; not a post-start capture")
    if undelivered:
        native_stop = undelivered_native_stop_record(out, owner, run_id, args.bench, machine, args.volume_id)
    else:
        native_stop = None
        record = {"version": 1, "machine_id": machine, "run_token": token}
        if json_file(out / "runtime-evidence.owner.json") != record or json_file(out / "runtime-evidence.pending") != record:
            raise Refusal("runtime evidence ownership is not exactly this guest")
        if regular_bytes(out / "guest-shutdown.confirmed", 256) != (run_id + "\n").encode():
            raise Refusal("guest shutdown is not confirmed for this run")
    if lexists(out / "remote-logs/runtime-evidence/manifest.json"):
        raise Refusal("sealed runtime evidence exists; original-volume capture is not required")
    if lexists(run / "_forensic"):
        raise Refusal("a forensic archive already exists for this run")
    clone = None
    if kind == "clone":
        clone = regular_bytes(audit / "by-machine-id" / machine, 256).decode().strip()
        if not re.fullmatch(r"cloudbench-[A-Za-z0-9._-]+", clone):
            raise Refusal("unsafe clone index")
        fresh = fields(audit / "fresh" / clone)
        volume = fresh.get("volume_id", "")
        expected = {"version": "1", "fleet_owner_token": owner, "run_id": run_id, "app": meta["app"],
                    "source": "fresh-clone", "clone_name": clone, "machine_id": machine, "disposition": "owned"}
        if any(fresh.get(k) != v for k, v in expected.items()):
            raise Refusal("fresh-clone audit record is not exactly owned by this run")
        if fields(registry / "clones" / clone) != {"name": clone, "id": machine, "volume_id": volume}:
            raise Refusal("registry clone claim is not exact")
    else:
        pool = fields(audit / "pool" / machine)
        volume = pool.get("volume_id", "")
        expected = {"fleet_owner_token": owner, "run_id": run_id, "app": meta["app"],
                    "source": "borrowed-pool", "disposition": "claimed"}
        if any(pool.get(k) != v for k, v in expected.items()):
            raise Refusal("pool audit record is not exactly claimed by this run")
    if not re.fullmatch(r"vol_[A-Za-z0-9]+", volume) or volume != args.volume_id:
        raise Refusal("requested volume is not the task's exact owned volume")
    return {
        "registry": registry, "owner": owner, "meta": meta, "run": run, "run_id": run_id, "out": out,
        "audit": audit, "workspace": workspace, "app": meta["app"], "bench": args.bench,
        "ordinal": ordinal, "token": token, "kind": kind, "machine_id": machine,
        "volume_id": volume, "clone_name": clone,
        "isolate_services": getattr(args, "isolate_services", False),
        "undelivered_native_stop": native_stop,
    }


# Recovery evidence the capture publishes for an undelivered native stop. Their
# absence is part of admission: an existing manifest, receipt or confirmation
# means recovery already holds guest evidence and must not be fed a second copy.
UNDELIVERED_RECOVERY_OUTPUTS = (
    "guest-shutdown.confirmed",
    "guest-cleanup.backend.log",
    "guest-cleanup.provider-manifest.json",
    "guest-cleanup.recovery-receipt.json",
    "guest-cleanup.machine-stopped.json",
    "guest-cleanup.undelivered-capture.json",
)


def undelivered_native_stop_record(out: Path, owner: str, run_id: str, bench: str, machine: str,
                                   volume: str) -> dict:
    """The controller's exact verified native stop of a never-delivered guest."""
    path = out / "guest-native-stop.json"
    if not lexists(path):
        raise Refusal("no guest-native-stop.json: this guest was not natively stopped as undelivered")
    data = regular_bytes(path, 65536)
    record = json.loads(data)
    expected = {
        "version": 1, "kind": "guest-native-stop", "fleet_owner_token": owner, "run_id": run_id,
        "bench": bench, "machine_id": machine, "volume_id": volume, "ownership": "fresh",
        "delivery_receipt": "absent", "stop_requested": True, "verified": True,
        "verified_state": "stopped", "destroyed": False,
    }
    try:
        record = json.loads(data)
    except ValueError:
        raise Refusal("guest-native-stop.json is malformed") from None
    if not isinstance(record, dict) or any(record.get(k) != v or type(record.get(k)) is not type(v)
                                           for k, v in expected.items()):
        raise Refusal("guest-native-stop.json is not an exact verified undelivered stop of this Machine and volume")
    for name in UNDELIVERED_RECOVERY_OUTPUTS:
        if lexists(out / name):
            raise Refusal(f"{name} already exists; run exact-owner recovery instead")
    return {"sha256": sha(data)}


def native_preflight(fly: Fly, ident: dict) -> tuple[dict, dict]:
    try:
        machine = fly.machine(ident["machine_id"])
    except NotFound:
        raise Refusal("Machine is already destroyed") from None
    except CaptureFailure as error:
        raise Refusal(str(error)) from None
    if ident.get("configured_old_member") and (machine.get("id") != ident["machine_id"]
            or not isinstance(machine.get("instance_id"), str) or not machine["instance_id"]):
        raise Refusal("configured old-member native Machine identity differs")
    if machine.get("state") != "stopped":
        raise Refusal(f"Machine state is {machine.get('state')!r}, not stopped")
    if ident["clone_name"] is not None and machine.get("name") != ident["clone_name"]:
        raise Refusal("native Machine name is not the owned clone name")
    validate_original_config(machine.get("config"), ident)
    if ident.get("configured_old_member"):
        configured_old_source(machine["config"], ident)
    try:
        volume = fly.volume(ident["volume_id"])
    except NotFound:
        raise Refusal("volume is already destroyed") from None
    except CaptureFailure as error:
        raise Refusal(str(error)) from None
    if ident.get("configured_old_member") and volume.get("id") != ident["volume_id"]:
        raise Refusal("configured old-member native volume identity differs")
    if volume.get("state") not in sibling("cloudbench-machine-readiness.py")["MOUNTABLE_VOLUME_STATES"]:
        raise Refusal(f"volume state is {volume.get('state')!r}")
    if volume.get("attached_machine_id") != ident["machine_id"]:
        raise Refusal("volume is not attached to the exact Machine")
    return machine, volume


def private_capture_dir(path: Path, create: bool) -> Path:
    if not path.is_absolute():
        raise Refusal("capture directory must be absolute")
    if not create and not lexists(path):
        return path
    if create and not lexists(path):
        os.makedirs(path, mode=0o700)
    info = path.lstat() if lexists(path) else None
    if info is None or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise Refusal("capture directory must be a private (0700) directory owned by this user")
    return path


def rename_noreplace(source: Path, target: Path) -> None:
    # Same exclusive publication as cloudbench-worker-evidence.py: complete
    # bytes appear once, never replace an existing file, and never hard-link.
    libc = ctypes.CDLL(None, use_errno=True)
    src, dst = ctypes.c_char_p(os.fsencode(source)), ctypes.c_char_p(os.fsencode(target))
    if sys.platform == "linux":
        result = libc.renameat2(-100, src, -100, dst, 1)
    elif sys.platform == "darwin":
        result = libc.renamex_np(src, dst, 4)
    else:
        raise OSError(errno.ENOSYS, "exclusive publication requires Linux or Darwin")
    if result != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(target))


def fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish_bytes(path: Path, data: bytes) -> None:
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        rename_noreplace(Path(temporary), path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    fsync_directory(path.parent)


class Journal:
    def __init__(self, path: Path) -> None:
        self.path = path

    def __call__(self, event: str, **detail: object) -> None:
        line = json.dumps({"at": int(time.time()), "event": event, **detail}, sort_keys=True) + "\n"
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "a") as stream:
            stream.write(line)
            stream.flush()
            os.fsync(stream.fileno())


class RecoveryLock:
    """The same <registry>/recovery-lock exact-owner recovery holds."""

    def __init__(self, registry: Path) -> None:
        self.lock = registry / "recovery-lock"
        self.payload = b""
        self.guard_fd = -1

    def acquire(self) -> None:
        host = socket.gethostname()
        start = bash_lib("cloudbench-env.sh", ["cloudbench_pid_start_time", str(os.getpid())])
        if not start:
            raise Refusal("could not record this helper's process birth")
        # Share one persistent inode with the normal fleet recoverer. It lives
        # outside the removable registry and is never unlinked on release.
        guards = self.lock.parent.parent.parent / "cloudbench-fleet-recovery-locks"
        guards.mkdir(mode=0o700, exist_ok=True)
        if guards.is_symlink():
            raise Refusal("recovery guard directory is a symlink")
        guard = guards / self.lock.parent.name
        try:
            self.guard_fd = os.open(guard, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        except OSError:
            raise Refusal("could not open one regular recovery guard") from None
        try:
            opened, current = os.fstat(self.guard_fd), guard.lstat()
            if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                    or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)):
                raise Refusal("recovery guard is not one persistent regular inode")
            try:
                fcntl.flock(self.guard_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refusal("exact-owner recovery guard is held; retry after it exits") from None
            for _ in range(2):
                try:
                    os.mkdir(self.lock, 0o700)
                except FileExistsError:
                    holder = fields(self.lock / "meta")
                    state = (pid_birth_state(holder.get("pid", ""), holder.get("pid_start", ""))
                             if holder.get("host") == host else "unknown")
                    if state != "absent":
                        raise Refusal(f"exact-owner recovery lock is held ({state}); retry after it exits") from None
                    (self.lock / "meta").unlink()
                    os.rmdir(self.lock)
                    continue
                self.payload = f"host={host}\npid={os.getpid()}\npid_start={start}\n".encode()
                temporary = self.lock / f"meta.tmp.{os.getpid()}"
                temporary.write_bytes(self.payload)
                os.replace(temporary, self.lock / "meta")
                return
            raise Refusal("could not acquire the exact-owner recovery lock")
        except BaseException:
            os.close(self.guard_fd)
            self.guard_fd = -1
            raise

    def release(self) -> None:
        # Remove only this helper's exact lock; never another holder's.
        try:
            if self.payload and regular_bytes(self.lock / "meta", 4096) == self.payload:
                (self.lock / "meta").unlink()
                os.rmdir(self.lock)
        except (Refusal, OSError) as error:
            print(f"⚠️ recovery lock was not released: {error}", file=sys.stderr)
        self.payload = b""
        if self.guard_fd >= 0:
            os.close(self.guard_fd)
            self.guard_fd = -1


def wait_for(fly: Fly, machine_id: str, predicate, seconds: int, label: str) -> dict:
    deadline = time.monotonic() + seconds
    last = None
    while True:
        try:
            last = fly.machine(machine_id)
        except NotFound:
            raise CaptureFailure(f"Machine disappeared while waiting for {label}") from None
        if predicate(last):
            return last
        if time.monotonic() >= deadline:
            raise CaptureFailure(f"Machine did not reach {label} within {seconds}s (state={last.get('state')!r})")
        time.sleep(float(os.environ.get("CLOUDBENCH_CAPTURE_POLL_SECONDS", "2")))


def inert_variant(original: dict) -> dict:
    inert = copy.deepcopy(original)
    inert["init"]["cmd"] = list(INERT_CMD)
    # Accepted service isolation prevents proxy traffic from waking or exposing
    # the temporary capture guest. The saved original remains byte-for-byte intact.
    if original.get("services"):
        inert.pop("services")
    return inert


def stop_and_restore(fly: Fly, ident: dict, original: dict, journal: Journal, seconds: int) -> dict:
    """Return this helper's inert boot to the exact original stopped config.

    It only stops a Machine running the inert config and never updates a live
    Machine; any other native state is reported untouched.
    """
    machine_id = ident["machine_id"]
    current = fly.machine(machine_id)
    # A config-only update can leave a never-started replacement "created";
    # that state runs nothing, so only a live state needs an explicit stop.
    idle = ("stopped", "created")
    if current.get("config") == original:
        if current.get("state") not in idle:
            raise CaptureFailure("Machine is live with its original config; refusing to act on it")
        journal("restored", instance_id=current.get("instance_id"))
        return current
    if current.get("config") != inert_variant(original):
        raise CaptureFailure("Machine config is neither the original nor this helper's inert config")
    if current.get("state") not in idle:
        journal("stop-requested", state=current.get("state"))
        fly.api("POST", f"/machines/{machine_id}/stop", {})
        current = wait_for(fly, machine_id, lambda m: m.get("state") == "stopped", seconds, "stopped")
    journal("stopped", instance_id=current.get("instance_id"))
    if current.get("config") != original:
        if current.get("state") not in idle:
            raise CaptureFailure("refusing to restore the original config on a live Machine")
        fly.api("POST", f"/machines/{machine_id}", {"config": original, "skip_launch": True})
        journal("restore-requested")
        current = wait_for(
            fly, machine_id, lambda m: m.get("state") in idle and m.get("config") == original,
            seconds, "idle with the exact original config",
        )
    journal("restored", instance_id=current.get("instance_id"))
    return current


def guest_capture(fly: Fly, ident: dict, capture_dir: Path, journal: Journal,
                  attempts: int, ssh_seconds: int) -> tuple[Path, dict]:
    """Mirror the startup-failure capture transport on the inert guest's rootfs /tmp."""
    machine_id, token = ident["machine_id"], ident["token"]
    here = Path(__file__).resolve()
    helpers = (here, here.with_name(STARTUP_ARCHIVE))
    base = ["-a", ident["app"], "--machine", machine_id]
    poll = float(os.environ.get("CLOUDBENCH_CAPTURE_POLL_SECONDS", "2"))
    last_error = "no attempt"
    for attempt in range(1, attempts + 1):
        if attempt > 1:
            time.sleep(poll * 2.5 * attempt)
        remote = f"/tmp/cloudbench-original-capture-{os.urandom(8).hex()}"
        rc, _, err = fly.flyctl(ssh_seconds, "ssh", "console", *base, "-C", f"mkdir -m 700 {remote}")
        for helper in helpers if rc == 0 else ():
            rc, _, err = fly.flyctl(ssh_seconds, "ssh", "sftp", "put", *base, "-q", "-m", "0600",
                                    str(helper), f"{remote}/{helper.name}")
            if rc != 0:
                break
        if rc != 0:
            last_error = f"collector upload failed (exit {rc}): {err.strip()[:200]}"
            journal("guest-retry", attempt=attempt, reason=last_error)
            continue
        command = (f"python3 -I -B {remote}/{here.name} guest-collect --data {DATA_PATH} "
                   f"--run-token {token} --output {remote}/originals.tar.gz"
                   + (" --configured-old-member --machine-id " + machine_id if ident.get("configured_old_member") else ""))
        rc, out, err = fly.flyctl(ssh_seconds, "ssh", "console", *base, "-C", command)
        lines = [line.strip() for line in out.splitlines() if line.startswith((INVENTORY_MARKER, ERROR_MARKER))]
        if len(lines) == 1 and lines[0].startswith(ERROR_MARKER):
            raise CaptureFailure("guest refused capture: " + json.loads(lines[0][len(ERROR_MARKER):])["error"])
        if rc != 0 or len(lines) != 1:
            last_error = f"collector failed (exit {rc}): {err.strip()[:200]}"
            journal("guest-retry", attempt=attempt, reason=last_error)
            continue
        inventory = json.loads(lines[0][len(INVENTORY_MARKER):])
        local = capture_dir / f".{machine_id}.{remote.rsplit('-', 1)[-1]}.tar.gz.unverified"
        rc, _, err = fly.flyctl(ssh_seconds, "ssh", "sftp", "get", *base, f"{remote}/originals.tar.gz", str(local))
        if rc != 0 or not local.is_file() or local.is_symlink():
            last_error = f"capture download failed (exit {rc}): {err.strip()[:200]}"
            journal("guest-retry", attempt=attempt, reason=last_error)
            continue
        os.chmod(local, 0o600)
        journal("downloaded", attempt=attempt, archive_sha256=inventory.get("archive_sha256"))
        return local, inventory
    raise CaptureFailure(f"guest capture failed after {attempts} attempts: {last_error}")


def verify_capture(local: Path, inventory: dict, ident: dict) -> dict[str, bytes]:
    token = ident["token"]
    data = local.read_bytes()
    files, missing = inventory.get("files"), inventory.get("missing")
    if (
        inventory.get("version") != 1 or inventory.get("run_token") != token
        or not isinstance(files, dict) or not isinstance(missing, list)
        or len(data) != inventory.get("archive_bytes") or sha(data) != inventory.get("archive_sha256")
    ):
        raise CaptureFailure("downloaded capture differs from the guest inventory")
    if ident.get("configured_old_member"):
        validate_configured_data_mount(inventory.get("data_mount"), ident["machine_id"])
    fixed = expected_names(token, bool(ident.get("configured_old_member")))
    if set(missing) - fixed or set(missing) & set(files) or len(set(missing)) != len(missing):
        raise CaptureFailure("guest missing-file inventory is invalid")
    originals: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            name = member.name
            if (
                not member.isfile() or name in originals or not MEMBER_NAME.fullmatch(name)
                or ".." in Path(name).parts or name.startswith("/") or not allowed_name(name, fixed)
            ):
                raise CaptureFailure(f"unsafe capture member: {name!r}")
            stream = archive.extractfile(member)
            content = stream.read(member.size + 1) if stream else b""
            row = files.get(name) or {}
            if len(content) != member.size or row.get("bytes") != member.size or row.get("sha256") != sha(content):
                raise CaptureFailure(f"capture member differs from the guest inventory: {name}")
            originals[name] = content
    if (set(originals) != set(files) or sum(map(len, originals.values())) > MAX_TOTAL_BYTES
            or (ident.get("configured_old_member") and not fixed <= set(files) | set(missing))):
        raise CaptureFailure("capture members differ from the guest inventory")
    if not ident.get("configured_old_member") and not originals.get("bench.log", b"").startswith(f"RUNSTAMP-{token}\n".encode()):
        raise CaptureFailure("original bench.log is absent or not stamped with this guest run token")
    return originals


def cross_check_receipts(out: Path, ident: dict, originals: dict[str, bytes]) -> dict[str, str]:
    """Bind the capture to the earlier exact recovery observation of the same guest."""
    checks: dict[str, str] = {}
    state_path = out / "guest-cleanup.state.json"
    if lexists(state_path):
        state = json_file(state_path)
        if state.get("machine_id") == ident["machine_id"] and state.get("guest_run_token") == ident["token"]:
            for key, name in (("services_manifest", CONTEXT + "services.json"), ("run_json", CONTEXT + "run.json"),
                              ("backend_log", LOG_DIR + "backend.log")):
                if key not in state:
                    continue
                observed = state.get(key) or {}
                if observed.get("exists") is not (name in originals) or (
                    name in originals and observed.get("bytes") != len(originals[name])
                ):
                    raise CaptureFailure(f"capture contradicts the recovery observation of {name}")
            checks["guest-cleanup.state.json"] = sha(regular_bytes(state_path))
    manifest_path = out / "guest-cleanup.provider-manifest.json"
    if lexists(manifest_path):
        manifest = json_file(manifest_path)
        if manifest.get("machine_id") == ident["machine_id"] and manifest.get("guest_run_token") == ident["token"]:
            evidence = manifest.get("evidence") or {}
            for key, name in (("backend_log_sha256", LOG_DIR + "backend.log"), ("run_json_sha256", CONTEXT + "run.json")):
                if evidence.get(key) and (name not in originals or sha(originals[name]) != evidence[key]):
                    raise CaptureFailure(f"capture contradicts the recovery manifest hash of {name}")
            checks["guest-cleanup.provider-manifest.json"] = sha(regular_bytes(manifest_path))
    return checks


def final_native_proof(fly: Fly, ident: dict, original: dict) -> tuple[dict, dict]:
    machine = fly.machine(ident["machine_id"])
    volume = fly.volume(ident["volume_id"])
    if ident.get("configured_old_member") and (machine.get("id") != ident["machine_id"]
            or machine.get("name") != ident["clone_name"] or volume.get("id") != ident["volume_id"]):
        raise CaptureFailure("final configured old-member native identity differs")
    if machine.get("state") not in ("stopped", "created") or machine.get("config") != original:
        raise CaptureFailure("final native Machine is not idle with the exact original config")
    if volume.get("attached_machine_id") != ident["machine_id"] or volume.get("state") != "created":
        raise CaptureFailure("final native volume is not attached to the exact Machine")
    return machine, volume


def resolve_token(ident: dict) -> str:
    token = bash_lib("cloudbench-inventory.sh", ["resolve_fly_token"], cwd=ident["workspace"])
    if not token:
        raise Refusal("no Fly credential is available")
    return token


def capture(args: argparse.Namespace) -> int:
    ident = local_identity(args)
    if ident.get("configured_old_member") and any(
            args.capture_dir.resolve().is_relative_to(path)
            for path in (ident["run"], ident["registry"], ident["audit"])):
        raise Refusal("diagnostic capture directory overlaps original custody")
    capture_dir = private_capture_dir(args.capture_dir, create=not args.preflight_only)
    machine_id = ident["machine_id"]
    artifacts = {name: capture_dir / f"{machine_id}.{name}" for name in (
        "tar.gz", "provenance.json", "original-config.private.json", "capture-failure.json")}
    if any(lexists(path) for path in artifacts.values()):
        raise Refusal("capture directory already holds artifacts for this Machine; use a fresh directory "
                      "or --restore-original-config")
    fly = Fly(ident["app"], resolve_token(ident))
    if args.preflight_only:
        # Read-only: no recovery lock, capture directory or provider mutation.
        native_preflight(fly, ident)
        print(json.dumps({"preflight": "ok", "machine_id": machine_id, "volume_id": ident["volume_id"],
                          "run_token": ident["token"], "kind": ident["kind"], "proof_credit": 0}))
        return 0
    lock = RecoveryLock(ident["registry"])
    lock.acquire()
    try:
        # Recheck durable latches and native state under the lock before mutating.
        if local_identity(args)["machine_id"] != machine_id:
            raise Refusal("owner records changed during preflight")
        machine, _ = native_preflight(fly, ident)
        return mutate_and_capture(fly, ident, args, capture_dir, artifacts, machine, machine["config"])
    finally:
        lock.release()


def mutate_and_capture(fly: Fly, ident: dict, args, capture_dir: Path, artifacts: dict, machine: dict,
                       original: dict) -> int:
    machine_id = ident["machine_id"]
    journal = Journal(capture_dir / f"{machine_id}.capture-journal.jsonl")
    config_bytes = canonical(original)
    try:
        publish_bytes(artifacts["original-config.private.json"], config_bytes + b"\n")
        journal("original-config-saved", sha256=sha(config_bytes), instance_id=machine.get("instance_id"))
    except OSError as error:
        raise Refusal(f"could not save the original config privately: {error}") from None
    inert = inert_variant(original)
    stage, mutated, local = "inert-config", False, None
    restore_hint = ("--restore-original-config" + (" --isolate-services" if ident.get("isolate_services") else "")
                    + (" --undelivered-native-stop" if ident.get("undelivered_native_stop") else "")
                    + (" --configured-old-member" if ident.get("configured_old_member") else ""))
    mutations: list[str] = []
    revalidate_configured_old_member(ident)
    source_recipe = configured_old_source(original, ident) if ident.get("configured_old_member") else None

    def interrupted(signum, _frame):
        raise CaptureFailure(f"interrupted by signal {signum}")

    previous = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
    try:
        mutated = True
        mutations.append("config-inert")
        fly.api("POST", f"/machines/{machine_id}", {"config": inert, "skip_launch": True})
        wait_for(fly, machine_id, lambda m: m.get("state") in ("stopped", "created") and m.get("config") == inert,
                 args.wait_seconds, "idle with the inert config")
        journal("inert-config-applied")
        stage = "inert-start"
        mutations.append("start")
        fly.api("POST", f"/machines/{machine_id}/start")
        started = wait_for(fly, machine_id, lambda m: m.get("state") == "started", args.wait_seconds, "started")
        if started.get("config") != inert:
            raise CaptureFailure("started Machine is not running the exact inert config")
        journal("inert-started", instance_id=started.get("instance_id"))
        stage = "guest-capture"
        local, inventory = guest_capture(fly, ident, capture_dir, journal, args.attempts, args.ssh_seconds)
        originals = verify_capture(local, inventory, ident)
        checks = cross_check_receipts(ident["out"], ident, originals)
        journal("capture-verified", files=len(originals), missing=len(inventory["missing"]))
        revalidate_configured_old_member(ident)
        stage = "stop-and-restore"
        mutations += ["stop", "config-restore"]
        stop_and_restore(fly, ident, original, journal, args.wait_seconds)
        stage = "final-native-proof"
        final_machine, final_volume = final_native_proof(fly, ident, original)
        revalidate_configured_old_member(ident)
    except BaseException as error:
        for sig in previous:
            signal.signal(sig, signal.SIG_IGN)
        outcome = {"stopped": None, "restored": False}
        if mutated:
            try:
                restored = stop_and_restore(fly, ident, original, journal, args.wait_seconds)
                outcome = {"stopped": restored.get("state") == "stopped",
                           "restored": restored.get("config") == original}
            except BaseException as cleanup_error:  # keep the original failure visible
                outcome["cleanup_error"] = str(cleanup_error)[:300]
        failure = {
            "schema": SCHEMA, "kind": "original-volume-capture-failed", "proof_credit": 0,
            "fleet_owner_token": ident["owner"], "run_id": ident["run_id"], "bench": ident["bench"],
            "machine_id": machine_id, "volume_id": ident["volume_id"], "guest_run_token": ident["token"],
            "stage": stage, "error": str(error)[:500], "provider_mutations_attempted": mutations, **outcome,
            "unverified_download": local.name if local else None,
            "next_step": (restore_hint if not outcome.get("restored") else
                          "investigate; rerun with a fresh capture directory"),
        }
        publish_bytes(artifacts["capture-failure.json"], canonical(failure) + b"\n")
        journal("failed", stage=stage, **{k: v for k, v in outcome.items() if k != "cleanup_error"})
        print(f"❌ original-volume capture failed at {stage}: {str(error)[:300]}", file=sys.stderr)
        if not outcome.get("restored"):
            print("❌ the exact original config is NOT proven restored; rerun with "
                  f"{restore_hint} and the same capture directory", file=sys.stderr)
        return EXIT_FAILED
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    archive_bytes = local.read_bytes()
    provenance = {
        "schema": SCHEMA, "version": 1, "kind": "original-volume-inert-capture",
        "direct_original_volume": True, "proof_credit": 0, "native_release_verified": False,
        "fleet_owner_token": ident["owner"], "run_id": ident["run_id"], "app": ident["app"],
        "bench": ident["bench"], "ordinal": ident["ordinal"], "guest_run_token": ident["token"],
        "allocation_kind": ident["kind"], "clone_name": ident["clone_name"],
        "machine_id": machine_id, "source_machine_id": machine_id,
        "volume_id": ident["volume_id"], "source_volume_id": ident["volume_id"],
        "archive_name": f"{machine_id}.tar.gz", "archive_bytes": len(archive_bytes),
        "archive_sha256": sha(archive_bytes), "files": inventory["files"], "missing": inventory["missing"],
        "native_original_config_sha256": sha(config_bytes),
        "native_original_instance_id": machine.get("instance_id"),
        "native_final_instance_id": final_machine.get("instance_id"),
        "native_final_state": final_machine.get("state"),
        "native_final_volume_state": final_volume.get("state"),
        "inert_command": INERT_CMD, "guest_inert_sleepers": inventory.get("inert_sleepers"),
        "services_isolated": bool(ident.get("isolate_services") and original.get("services")),
        "provider_mutations": mutations, "receipt_cross_checks": checks,
        **({"admission": "undelivered-native-stop",
            "guest_native_stop_sha256": ident["undelivered_native_stop"]["sha256"]}
           if ident.get("undelivered_native_stop") else {}),
        "capture_helper_sha256": sha(Path(__file__).resolve().read_bytes()),
        "captured_at": int(time.time()),
        **({"admission": "configured-old-member-diagnostic", "custody_sha256": ident["custody_sha256"],
            "source_ref": source_recipe[0], "source_recipe_sha256": source_recipe[1],
            "source_fingerprint": source_recipe[2], "data_mount": inventory["data_mount"],
            "runtime_evidence_complete": False,
            "phase_consumption_authorized": False} if source_recipe is not None else {}),
    }
    publish_bytes(artifacts["provenance.json"], canonical(provenance) + b"\n")
    rename_noreplace(local, artifacts["tar.gz"])
    fsync_directory(capture_dir)
    journal("published", archive_sha256=provenance["archive_sha256"])
    if ident.get("undelivered_native_stop"):
        try:
            manifest = publish_undelivered_recovery_inputs(ident, originals, capture_dir,
                                                           provenance["archive_sha256"])
        except (CaptureFailure, Refusal, OSError, ValueError) as error:
            journal("recovery-inputs-failed", error=str(error)[:300])
            print(f"❌ capture published, but its recovery inputs were refused: {str(error)[:300]}", file=sys.stderr)
            return EXIT_FAILED
        journal("recovery-inputs-published", manifest_kind=manifest.get("kind"))
    print(json.dumps({"captured": True, "machine_id": machine_id, "archive": str(artifacts["tar.gz"]),
                      "files": len(inventory["files"]), "missing": inventory["missing"],
                      "native_final_state": final_machine.get("state"), "proof_credit": 0}, sort_keys=True))
    return 0


def publish_undelivered_recovery_inputs(ident: dict, originals: dict[str, bytes],
                                        capture_dir: Path | None = None, archive_sha: str | None = None) -> dict:
    """Hand exact-owner recovery the stopped guest's original backend log and manifest.

    These are the same two files recovery fetches from a started guest before
    it stops it. Recovery then proves the Machine stopped, releases every
    logged provider session and validates the receipt as for any stopped
    guest. Nothing here confirms cleanup or changes a latch.
    """
    backend = originals.get(LOG_DIR + "backend.log")
    out = ident["out"]
    if any(lexists(out / name) for name in UNDELIVERED_RECOVERY_OUTPUTS):
        raise CaptureFailure("recovery evidence appeared during capture")
    helper = sibling("cloudbench-exact-session-cleanup.py")
    target = out / "guest-cleanup.backend.log"
    if backend is None:
        # No backend ever ran. Recovery may still prove zero provider sessions,
        # but only from this exact capture; the session helper re-verifies it.
        if capture_dir is None or archive_sha is None:
            raise CaptureFailure("original backend.log is absent; provider-session identity is unrecoverable")
        pointer = out / helper["UNDELIVERED_CAPTURE_POINTER"]
        publish_bytes(pointer, canonical(
            {"version": 1, "capture_dir": str(capture_dir), "archive_sha256": archive_sha}) + b"\n")
        try:
            helper["undelivered_prestack_zero_manifest"](argparse.Namespace(
                owner=ident["owner"], fleet_run_id=ident["run_id"], bench=ident["bench"],
                machine_id=ident["machine_id"], output_dir=str(out), guest_run_token=ident["token"]))
        except helper["CleanupEvidenceError"] as error:
            # Retract only the pointer this call just published.
            pointer.unlink()
            fsync_directory(out)
            raise CaptureFailure(f"capture does not prove zero provider sessions: {error}") from None
    else:
        publish_bytes(target, backend)
    namespace = argparse.Namespace(
        owner=ident["owner"], fleet_run_id=ident["run_id"], bench=ident["bench"],
        machine_id=ident["machine_id"], output_dir=str(out), guest_run_token=ident["token"],
        backend_log=str(target), manifest=str(out / "guest-cleanup.provider-manifest.json"),
        state_receipt=None,
    )
    try:
        return helper["publish_active_manifest"](namespace)
    except helper["CleanupEvidenceError"] as error:
        raise CaptureFailure(f"provider manifest refused: {error}") from None


def publish_existing_capture_inputs(args: argparse.Namespace) -> int:
    """Hand recovery an already published undelivered capture; no provider call."""
    args.undelivered_native_stop = True
    ident = local_identity(args)
    capture_dir = private_capture_dir(args.capture_dir, create=False)
    machine_id = ident["machine_id"]
    archive = regular_bytes(capture_dir / f"{machine_id}.tar.gz", MAX_TOTAL_BYTES)
    provenance = json_file(capture_dir / f"{machine_id}.provenance.json")
    if (
        not isinstance(provenance, dict) or provenance.get("admission") != "undelivered-native-stop"
        or provenance.get("guest_native_stop_sha256") != ident["undelivered_native_stop"]["sha256"]
        or provenance.get("archive_sha256") != sha(archive) or provenance.get("machine_id") != machine_id
        or provenance.get("volume_id") != ident["volume_id"] or provenance.get("guest_run_token") != ident["token"]
    ):
        raise Refusal("existing capture is not this exact undelivered native-stop capture")
    inventory = {"version": 1, "run_token": ident["token"], "files": provenance.get("files"),
                 "missing": provenance.get("missing"), "archive_bytes": len(archive), "archive_sha256": sha(archive)}
    local = capture_dir / f"{machine_id}.tar.gz"
    try:
        originals = verify_capture(local, inventory, ident)
        manifest = publish_undelivered_recovery_inputs(ident, originals, capture_dir, sha(archive))
    except CaptureFailure as error:
        print(f"❌ recovery inputs refused: {error}", file=sys.stderr)
        return EXIT_FAILED
    print(json.dumps({"recovery_inputs": True, "manifest_kind": manifest.get("kind"),
                      "machine_id": machine_id, "proof_credit": 0}, sort_keys=True))
    return 0


def next_step(args: argparse.Namespace) -> int:
    """Print the supported next command for a refused stopped undelivered guest (read-only)."""
    args.undelivered_native_stop = True
    try:
        ident = local_identity(args)
    except Refusal as error:
        print(f"❌ undelivered native-stop capture is not admissible: {error}", file=sys.stderr)
        return EXIT_REFUSED
    print("🧭 next supported step: capture the stopped guest's original volume, then repeat exact-owner recovery:")
    print("   python3 scripts/cloudbench-original-volume-capture.py --registry " + shlex.quote(str(ident["registry"]))
          + " --bench " + shlex.quote(ident["bench"]) + " --machine-id " + ident["machine_id"]
          + " --volume-id " + ident["volume_id"] + " --capture-dir <new-private-0700-dir>"
          + " --undelivered-native-stop [--isolate-services]")
    print("   scripts/run-bench --recover-stale-owner " + ident["owner"])
    return 0


def restore_only(args: argparse.Namespace) -> int:
    """Finish an interrupted capture's stop and exact-config restore; nothing else."""
    ident = local_identity(args)
    capture_dir = private_capture_dir(args.capture_dir, create=False)
    machine_id = ident["machine_id"]
    snapshot = capture_dir / f"{machine_id}.original-config.private.json"
    original = json_file(snapshot, 16 * 1024 * 1024)
    validate_original_config(original, ident)
    if ident.get("configured_old_member"):
        configured_old_source(original, ident)
    lock = RecoveryLock(ident["registry"])
    lock.acquire()
    try:
        fly = Fly(ident["app"], resolve_token(ident))
        try:
            current = fly.machine(machine_id)
        except NotFound:
            raise Refusal("Machine is already destroyed") from None
        if current.get("config") not in (original, inert_variant(original)):
            raise Refusal("native config is neither the saved original nor its inert variant")
        journal = Journal(capture_dir / f"{machine_id}.capture-journal.jsonl")
        try:
            stop_and_restore(fly, ident, original, journal, args.wait_seconds)
            final_machine, _ = final_native_proof(fly, ident, original)
        except CaptureFailure as error:
            print(f"❌ restore did not verify: {error}", file=sys.stderr)
            return EXIT_FAILED
        print(json.dumps({"restored": True, "machine_id": machine_id, "native_final_state": final_machine.get("state"),
                          "proof_credit": 0}, sort_keys=True))
        return 0
    finally:
        lock.release()


BILLING_GUEST = r'''from pathlib import Path
import os,json,hashlib,stat,time,signal
signal.alarm(20)
assert os.getuid()==0 and os.environ.get('FLY_MACHINE_ID')==TARGET
boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip();assert len(boot)==36
expected_sleep=Path('/bin/sleep').resolve(strict=True);sleep_stat=expected_sleep.stat();assert stat.S_ISREG(sleep_stat.st_mode)and sleep_stat.st_uid==0
def stable(p,first):
 last=(p/'stat').read_text().split(') ',1)[1].split();assert last[19]==first[19]and last[0]!='Z'
 return True
ancestors={os.getpid()};pid=os.getpid()
while pid>1:
 raw=Path('/proc',str(pid),'stat').read_text().split(') ',1)[1].split();pid=int(raw[1]);ancestors.add(pid)
def hallpass_identity(uid,ppid,pgid,args,path,digest,birth_stable,regular,owner):
 return uid==0 and ppid==1 and pgid==0 and args==[b'/.fly/hallpass']and path=='/.fly/hallpass'and digest in {'7e42662dc2361058814d06b80bafbed13b7e8d6da4f477604001b54dc905ce52','02f70fcb946d386f697ad7fbe16d91a2f9243f85c6db583e3778582cd23b35c0','1fc252c042a279787eb1a83a15c7e19d634fc0059ad8abf4acaa9a752f5684a2'}and birth_stable is True and regular is True and owner==0
def hallpass_binary(exe):
 if exe!=Path('/.fly/hallpass'):return 'UNMEASURED',False,-1
 fd=os.open(exe,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  a=os.fstat(fd)
  if not stat.S_ISREG(a.st_mode)or a.st_uid!=0 or a.st_size>16777216:return 'UNMEASURED',False,a.st_uid
  h=hashlib.sha256();count=0
  while count<a.st_size:
   b=os.read(fd,min(65536,a.st_size-count));assert b;count+=len(b);h.update(b)
  z=os.fstat(fd);assert(a.st_dev,a.st_ino,a.st_mode,a.st_uid,a.st_gid,a.st_nlink,a.st_size,a.st_mtime_ns)==(z.st_dev,z.st_ino,z.st_mode,z.st_uid,z.st_gid,z.st_nlink,z.st_size,z.st_mtime_ns)and stat.S_ISREG(z.st_mode)and z.st_uid==0
  return h.hexdigest(),True,a.st_uid
 finally:os.close(fd)
entries=[p for p in Path('/proc').iterdir()if p.name.isdigit()];assert len(entries)<=4096
unknown=[];allowed_sleep=[];idle_agents=[];platform_hallpass=[]
for p in entries:
 if int(p.name)in ancestors:continue
 try:
  st=(p/'stat').read_text().split(') ',1)[1].split()
  if st[0]=='Z':continue
  args=[x for x in (p/'cmdline').read_bytes().split(b'\0')if x];uid=p.stat().st_uid
  if not args and uid==0 and int(st[6])&0x200000:continue
  exe=(p/'exe').resolve(strict=True)
  if args in [[b'sleep',b'infinity'],[b'/bin/sleep',b'infinity'],[b'/usr/bin/sleep',b'infinity']]and exe==expected_sleep and uid in [0,1001]and (exe.stat().st_dev,exe.stat().st_ino)==(sleep_stat.st_dev,sleep_stat.st_ino)and stable(p,st):allowed_sleep.append({'pid':int(p.name),'birth':st[19]});continue
  if uid==1001 and st[1]=='1'and args[1:]==[b'agent',b'run']and exe.name=='flyctl'and hashlib.sha256(exe.read_bytes()).hexdigest()=='5041b9a563fff170fda4238b47048e9a5e714fc7ed2304668fd44bcdcd3bef83'and stable(p,st):idle_agents.append({'pid':int(p.name),'birth':st[19]});continue
  if uid==0 and st[1]=='1'and st[2]=='0'and args==[b'/.fly/hallpass']and exe==Path('/.fly/hallpass'):
   digest,regular,owner=hallpass_binary(exe)
   if hallpass_identity(uid,int(st[1]),int(st[2]),args,str(exe),digest,stable(p,st),regular,owner):
    assert not platform_hallpass,'multiple platform hallpass processes'
    platform_hallpass.append({'pid':int(p.name),'birth':st[19],'role':'exact-pinned-platform-hallpass'});continue
  unknown.append({'pid':int(p.name),'birth':st[19],'uid':uid})
 except FileNotFoundError:
  try:still=(p/'stat').read_text().split(') ',1)[1].split()
  except FileNotFoundError:continue
  assert still[0]=='Z','unreadable still-live process'
assert not unknown and allowed_sleep
print(json.dumps({'kind':'exact-inert-quiescence-v1','machine':TARGET,'nonce':NONCE,'boot':boot,'unknown':unknown,'inert_sleepers':allowed_sleep,'idle_pinned_agents':idle_agents,'idle_platform_hallpass':platform_hallpass,'observed_epoch':time.time()}))
'''


# Billing custody is deliberately separate from recovery/evidence acceptance.
# Exact fresh inert or provenance-bound configured allocations only; no pool credit.
BILLING_SCHEMA = 'cloudbench-billing-stop-retain-v1'


def _billing_require(ok, reason):
    if not ok:
        raise Refusal(reason)


def _billing_file(path, limit=65536):
    path = Path(path)
    _billing_require(path.resolve() == path, 'unsafe ownership pathname')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        _billing_require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
                         and before.st_nlink == 1 and before.st_size <= limit,
                         'unsafe ownership file')
        data = b''
        while len(data) <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - len(data)))
            if not chunk:
                break
            data += chunk
        after, current = os.fstat(fd), path.lstat()
        identity = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid,
                              s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        _billing_require(len(data) == before.st_size and identity(before) == identity(after)
                         == identity(current), 'ownership file changed')
        return data
    finally:
        os.close(fd)


def _billing_fields(path):
    result = {}
    for line in _billing_file(path).decode().splitlines():
        key, sep, value = line.partition('=')
        _billing_require(sep and key and key not in result, 'malformed ownership record')
        result[key] = value
    return result


def _billing_tree(root):
    """Bounded metadata originals, including latches; never edit their contents."""
    result, total = {}, 0
    paths = [root]
    while paths:
        path = paths.pop()
        _billing_require(len(result) < 8192 and path.resolve() == path, 'ownership tree bound/path')
        info = path.lstat()
        _billing_require(info.st_uid == os.getuid(), 'foreign ownership tree')
        if stat.S_ISDIR(info.st_mode):
            result[str(path)] = ('directory', info.st_dev, info.st_ino, info.st_mode)
            paths.extend(sorted(path.iterdir()))
        else:
            _billing_require(stat.S_ISREG(info.st_mode), 'unsupported ownership file type')
            _billing_require(info.st_size <= min(65536, 8388608-total), 'ownership aggregate bound')
            raw = _billing_file(path)
            total += len(raw)
            result[str(path)] = ('file', info.st_dev, info.st_ino, info.st_mode, sha(raw))
    return result


def _billing_lock(path):
    """Share canonical recovery/claim inodes; never unlink or replace them."""
    if not path.parent.exists():
        path.parent.mkdir(mode=0o700)
        fsync_directory(path.parent.parent)
    exact_directory(path.parent, 'billing guard parent')
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info, current = os.fstat(fd), path.lstat()
        _billing_require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                         and info.st_nlink == 1 and (info.st_dev, info.st_ino)
                         == (current.st_dev, current.st_ino), 'unsafe billing guard')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fsync_directory(path.parent)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _billing_local(registry, audit, run_dir, owner, owner_pid, owner_birth, joins_verified, *, allow_descendant=False):
    _billing_require(joins_verified is True, 'producer joins are unconfirmed')
    registry, audit, run_dir = [exact_directory(Path(p), 'billing owner path')
                                for p in (registry, audit, run_dir)]
    _billing_require(re.fullmatch(r'[0-9a-f]{32}', owner) and registry.name == audit.name == owner
                     and registry.parent.name == 'cloudbench-fleet-ownership', 'foreign owner path')
    meta, am = _billing_fields(registry/'meta'), _billing_fields(audit/'meta')
    _billing_require(meta.get('version') == '2' and am.get('version') == '1'
                     and meta.get('cleanup_policy') == 'reap', 'protected or unsupported policy')
    _billing_require(meta.get('fleet_owner_token') == owner and am.get('fleet_owner_token') == owner
                     and meta.get('run_id') == am.get('run_id') == run_dir.name
                     and meta.get('app') == am.get('app') and SAFE_TOKEN.fullmatch(meta.get('app', ''))
                     and meta.get('workspace_root') == am.get('workspace_root')
                     and Path(meta.get('audit_dir', '')) == audit
                     and Path(meta.get('runs_root', '')) / run_dir.name == run_dir,
                     'owner/audit/run mismatch')
    _billing_require(str(owner_pid) == meta.get('pid') and owner_birth == meta.get('pid_start')
                     and meta.get('host') == socket.gethostname()
                     and pid_birth_state(str(owner_pid), owner_birth) == 'live', 'caller birth mismatch')
    # The caller is the current joined controller, not a successor guessing that
    # an old PID is idle. Recovery and migration authority must remain separate.
    _billing_require(int(owner_pid) == os.getppid() or
                     (allow_descendant and _billing_caller_descends_from(int(owner_pid))),
                     'not the current cleanup caller')
    for name in ('recovery-lock', 'cold-handoff-outgoing'):
        _billing_require(not lexists(registry/name), 'recovery/migration authority present')
    _billing_require(am.get('status') == 'incomplete', 'audit is not current')
    return registry, audit, run_dir, meta


def billing_stop_retained_owned(fly, registry, audit, run_dir, receipt_root,
                                expected_owner, owner_pid, owner_birth, *, joins_verified=False):
    """One whole-call 180s ceiling, shortened by any existing caller deadline."""
    import threading
    pending = {'schema': BILLING_SCHEMA, 'owner': expected_owner, 'status': 'PENDING',
               'results': [], 'evidence_or_task_credit': False, 'native_release': False,
               'all_ownership_records_retained': True}
    if threading.current_thread() is not threading.main_thread():
        return dict(pending, reason='main-thread-deadline-required')
    timer, handler = signal.getitimer(signal.ITIMER_REAL), signal.getsignal(signal.SIGALRM)
    if timer[1] != 0:
        return dict(pending, reason='periodic-caller-timer-unsupported')
    started = time.monotonic()
    budget = min(180, timer[0]) if timer[0] > 0 else 180
    def expired(*unused):
        raise TimeoutError('billing whole-call deadline')
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, budget)
    try:
        return _billing_stop_retained_owned(fly, registry, audit, run_dir, receipt_root,
            expected_owner, owner_pid, owner_birth, joins_verified=joins_verified,
            deadline=started+budget)
    except TimeoutError:
        return dict(pending, reason='whole-call-deadline-receipts-retained')
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, handler)
        if timer[0] > 0:
            signal.setitimer(signal.ITIMER_REAL, max(0.000001, timer[0]-(time.monotonic()-started)))


def _billing_stop_retained_owned(fly, registry, audit, run_dir, receipt_root,
                                 expected_owner, owner_pid, owner_birth, *, joins_verified, deadline):
    """Physical STOP only. No recovery, grade, latch, claim or policy acceptance.

    Call synchronously from the current fleet cleanup child after all producers
    and collectors have joined. Receipts use one stable private run directory;
    an existing per-Machine directory always prevents a repeated STOP attempt.
    Pool/warm and unbound configured or incomplete allocation phases stay PENDING.
    """
    summary = {'schema': BILLING_SCHEMA, 'owner': expected_owner, 'results': [],
               'evidence_or_task_credit': False, 'native_release': False,
               'all_ownership_records_retained': True}
    guard = -1
    try:
        import threading
        _billing_require(threading.current_thread() is threading.main_thread(),
                         'billing must own a main-thread deadline')
        registry, audit, run_dir, meta = _billing_local(
            registry, audit, run_dir, expected_owner, owner_pid, owner_birth, joins_verified)
        _billing_require(getattr(fly, 'app', None) == meta['app'], 'client app mismatch')
        common = registry.parent.parent
        guard = _billing_lock(common/'cloudbench-fleet-recovery-locks'/expected_owner)
        original = (_billing_tree(registry), _billing_tree(audit))
        receipts = Path(receipt_root)
        _billing_require(receipts.parent == run_dir/'_batch' and receipts.name == 'billing-stop-retain',
                         'receipt root is not the stable run billing namespace')
        exact_directory(receipts.parent, 'batch')
        private_capture_dir(receipts, True)
        _billing_require(receipts.resolve() == receipts, 'unsafe receipt root')
        # No pool claim is billing-stop authority; preserve those warm resources.
        fresh = exact_directory(audit/'fresh', 'fresh audit')
        entries = sorted(fresh.iterdir())
        _billing_require(len(entries) <= 2048, 'audit cardinality bound')
        clones = exact_directory(registry/'clones', 'registry clones')
        _billing_require({p.name for p in clones.iterdir()} <= {p.name for p in entries},
                         'registry allocation has no audit record')
        owned_rows = [_billing_fields(record) for record in entries]
        ids = [row['machine_id'] for row in owned_rows if row.get('machine_id')]
        volumes = [row['volume_id'] for row in owned_rows if row.get('volume_id')]
        _billing_require(len(ids) == len(set(ids)) and len(volumes) == len(set(volumes)),
                         'duplicate allocation ownership')
        seen = set()
        for record, row in zip(entries, owned_rows):
            result = {'record': record.name, 'status': 'PENDING', 'stop_issued': False,
                      'native_release': False, 'evidence_or_task_credit': False}
            if time.monotonic() >= deadline:
                summary['results'].append(dict(result, reason='whole-call-deadline'))
                continue
            try:
                mid, vol = row.get('machine_id', ''), row.get('volume_id', '')
                _billing_require(row.get('disposition') == 'owned' and row.get('version') == '1'
                                 and row.get('source') == 'fresh-clone'
                                 and row.get('fleet_owner_token') == expected_owner
                                 and row.get('run_id') == run_dir.name and row.get('app') == meta['app']
                                 and row.get('clone_name') == record.name
                                 and re.fullmatch(r'cloudbench-[A-Za-z0-9._-]+', record.name)
                                 and re.fullmatch(r'[0-9a-f]{14}', mid)
                                 and re.fullmatch(r'vol_[A-Za-z0-9]+', vol)
                                 and mid not in seen, 'unsupported or ambiguous allocation')
                seen.add(mid)
                _billing_require(_billing_file(audit/'by-machine-id'/mid).decode().strip() == record.name
                                 and _billing_fields(registry/'clones'/record.name)
                                 == {'name': record.name, 'id': mid, 'volume_id': vol}, 'clone binding mismatch')
                result['machine'] = mid
                _billing_stop_one(fly, registry, audit, meta, original, common,
                                  mid, vol, record.name, receipts, result)
            except (Refusal, OSError, ValueError, TimeoutError, CaptureFailure, NotFound) as error:
                result['reason_class'] = type(error).__name__
            summary['results'].append(result)
        pool = audit/'pool'
        if lexists(pool):
            exact_directory(pool, 'pool audit')
            for path in sorted(pool.iterdir()):
                summary['results'].append({'record': path.name, 'status': 'PENDING',
                                           'reason': 'unsupported-pool-or-warm', 'stop_issued': False})
        summary['status'] = 'COMPLETE' if summary['results'] and all(
            r['status'] in ('STOPPED_RETAINED', 'ALREADY_STOPPED_RETAINED')
            for r in summary['results']) else 'PENDING'
    except (Refusal, OSError, ValueError, TimeoutError) as error:
        summary.update(status='PENDING', reason_class=type(error).__name__)
    finally:
        if guard >= 0:
            os.close(guard)
    return summary


def _billing_configured_source(registry, meta, mid, config):
    """Bind a configured fresh task without requiring its missing runtime archive."""
    _billing_require(config.get('init') == {'cmd': DRIVER_CMD}, 'unsupported configured init')
    env = config.get('env')
    barrier = os.environ.get('CLOUDBENCH_BARRIER_TOKEN')
    _billing_require(isinstance(env, dict) and 'GATE_REF' not in env
                     and isinstance(barrier, str) and SAFE_TOKEN.fullmatch(barrier)
                     and env.get('CLOUDBENCH_BARRIER_TOKEN') == barrier,
                     'configured caller credential mismatch')
    run = Path(meta['runs_root'])/meta['run_id']
    files = {}
    def read(path, limit=1048576):
        raw = _billing_file(path, limit)
        files[str(path)] = sha(raw)
        return raw
    contract = sibling('cloudbench_execution_provenance.py')
    provenance = json.loads(read(run/'execution-provenance.json'))
    matrix = json.loads(read(run/'execution-task-matrix.json'))
    _billing_require(not contract['validate_task_matrix_binding'](provenance, matrix),
                     'configured source provenance mismatch')
    _billing_require(provenance['config']['values'].get('app') == meta['app']
                     and env.get('REF') == provenance['base_sha'], 'configured source ref mismatch')
    matches = []
    for index, task in enumerate(matrix['tasks']):
        out = run/task['name']
        if not lexists(out/'.cid'):
            continue
        source, machine = read(out/'.cid', 4096).decode().split()
        if machine == mid:
            _billing_require(source == 'clone', 'configured task is not fresh-owned')
            matches.append((index, out))
    _billing_require(len(matches) == 1, 'configured task identity is ambiguous')
    index, out = matches[0]
    token = registry.name+'-'+str(index)
    _billing_require(env.get('CLOUDBENCH_RUN_TOKEN') == token,
                     'configured task token mismatch')
    owner = json.loads(read(out/'runtime-evidence.owner.json', 65536))
    _billing_require(owner == {'version': 1, 'machine_id': mid, 'run_token': token},
                     'configured runtime owner mismatch')
    _billing_require(config['mounts'][0].get('path') == DATA_PATH, 'configured data mount mismatch')
    return files


def _billing_caller_descends_from(owner_pid):
    """A live controller may delegate to its exact collector/autoscaler child."""
    pid = os.getppid()
    for _ in range(128):
        if pid == owner_pid:
            return True
        if pid <= 1:
            return False
        if sys.platform == 'linux':
            path = Path('/proc', str(pid), 'stat')
            first = path.read_text().rsplit(') ', 1)[1].split()
            second = path.read_text().rsplit(') ', 1)[1].split()
            _billing_require((first[1], first[19]) == (second[1], second[19]),
                             'caller ancestor birth changed')
            pid = int(first[1])
        else:
            command = ['ps', '-o', 'ppid=,lstart=', '-p', str(pid)]
            first = subprocess.check_output(command, timeout=2).strip()
            _billing_require(first == subprocess.check_output(command, timeout=2).strip(),
                             'caller ancestor birth changed')
            pid = int(first.split(None, 1)[0])
    return False


def _billing_current_source(registry, meta, output, mid, role):
    run = Path(meta['runs_root'])/meta['run_id']
    _billing_require(output.parent == run and role in ('primary', 'worker'), 'foreign idle-stop output')
    source = {}
    def read(path, limit=1048576):
        raw = _billing_file(path, limit)
        source[str(path)] = sha(raw)
        return raw
    contract = sibling('cloudbench_execution_provenance.py')
    provenance = json.loads(read(run/'execution-provenance.json'))
    matrix = json.loads(read(run/'execution-task-matrix.json'))
    _billing_require(not contract['validate_task_matrix_binding'](provenance, matrix)
                     and provenance['config']['values'].get('app') == meta['app'], 'idle-stop source mismatch')
    names = [r['name'] for r in matrix['tasks']]
    _billing_require(output.name in names, 'idle-stop task missing')
    token = registry.name+'-'+str(names.index(output.name))
    kind, primary = read(output/'.cid', 4096).decode().split()
    _billing_require(kind in ('clone', 'pool') and re.fullmatch('[0-9a-f]+', primary), 'idle-stop primary mismatch')
    if role == 'primary':
        _billing_require(kind == 'clone' and primary == mid, 'not the owned primary')
        _billing_require(read(output/'guest-shutdown.confirmed') == (meta['run_id']+'\n').encode(),
                         'primary shutdown unconfirmed')
        finished = read(output/'benchmark-child.finished')
        _billing_require(finished in (b'0\n', b'1\n')
                         and read(output/'autoscaler.completed-after-child') == finished,
                         'primary producer completion unconfirmed')
        owner = json.loads(read(output/'runtime-evidence.owner.json', 65536))
        _billing_require(owner == {'version':1, 'machine_id':mid, 'run_token':token}, 'primary runtime owner mismatch')
    else:
        owner = json.loads(read(output/'worker-runtime-evidence'/mid/'owner.json', 65536))
        _billing_require(set(owner) == {'version','machine_id','primary_machine_id','run_token','workspace'}
                         and owner['version'] == 1 and owner['machine_id'] == mid
                         and owner['primary_machine_id'] == primary and primary != mid
                         and owner['run_token'] == token and isinstance(owner['workspace'], str)
                         and SAFE_TOKEN.fullmatch(owner['workspace']), 'worker runtime owner mismatch')
    name = read(Path(meta['audit_dir'])/'by-machine-id'/mid, 4096).decode().strip()
    _billing_require(re.fullmatch('cloudbench-[A-Za-z0-9._-]+', name), 'idle-stop clone name')
    record = _billing_fields(Path(meta['audit_dir'])/'fresh'/name)
    _billing_require(record.get('version') == '1' and record.get('disposition') == 'owned'
                     and record.get('source') == 'fresh-clone' and record.get('fleet_owner_token') == registry.name
                     and record.get('run_id') == meta['run_id'] and record.get('app') == meta['app']
                     and record.get('clone_name') == name and record.get('machine_id') == mid,
                     'idle-stop allocation owner mismatch')
    if role == 'worker':
        _billing_require(record.get('source_machine_id') == primary, 'worker source primary mismatch')
    volume = record.get('volume_id', '')
    _billing_require(re.fullmatch('vol_[A-Za-z0-9]+', volume)
                     and _billing_fields(registry/'clones'/name)
                     == {'name':name,'id':mid,'volume_id':volume}, 'idle-stop registry binding mismatch')
    source[str(Path(meta['audit_dir'])/'fresh'/name)] = sha(_billing_file(Path(meta['audit_dir'])/'fresh'/name))
    return name, volume, token, source


def billing_stop_current_owned(fly, registry, audit, run_dir, output, mid, role,
                               expected_owner, owner_pid, owner_birth):
    """Stop one exact current-owned role; preserve custody for later admission."""
    result = {'schema':BILLING_SCHEMA, 'role':role, 'machine':mid, 'status':'PENDING',
              'stop_issued':False, 'stopped_only':True, 'pool_credit':0, 'current_owner':expected_owner}
    guard = -1
    prior, handler = signal.getitimer(signal.ITIMER_REAL), signal.getsignal(signal.SIGALRM)
    started = time.monotonic()
    try:
        import threading
        _billing_require(isinstance(mid, str) and re.fullmatch('[0-9a-f]{14}', mid),
                         'invalid current idle-stop machine')
        _billing_require(threading.current_thread() is threading.main_thread() and prior[1] == 0,
                         'idle-stop requires main-thread bounded clock')
        budget = min(180, prior[0]) if prior[0] > 0 else 180
        def expired(*unused):
            raise TimeoutError('current idle-stop deadline')
        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, budget)
        registry, audit, run_dir, meta = _billing_local(registry, audit, run_dir, expected_owner,
            owner_pid, owner_birth, True, allow_descendant=True)
        _billing_require(getattr(fly, 'app', None) == meta['app'], 'idle-stop client app mismatch')
        output = exact_directory(Path(output), 'idle-stop output')
        name, vol, token, binding = _billing_current_source(registry, meta, output, mid, role)
        result.update(record=name, volume_id=vol, runtime_run_token=token)
        guard = _billing_lock(registry.parent.parent/'cloudbench-fleet-recovery-locks'/expected_owner)
        original = (_billing_tree(registry), _billing_tree(audit))
        receipts = private_capture_dir(run_dir/'_batch'/'current-idle-stop'/role, True)
        def unchanged():
            current = _billing_current_source(registry, meta, output, mid, role)
            _billing_require(current == (name, vol, token, binding), 'idle-stop source changed')
            return binding
        def worker_config(config):
            _billing_require(config.get('init') == {'cmd': INERT_CMD}, 'worker command is not inert')
            env = config.get('env')
            if env not in (None, {}):
                provenance = json.loads(_billing_file(run_dir/'execution-provenance.json', 1048576))
                barrier = os.environ.get('CLOUDBENCH_BARRIER_TOKEN')
                _billing_require(isinstance(env, dict) and 'GATE_REF' not in env
                                 and env.get('REF') == provenance['base_sha']
                                 and env.get('CLOUDBENCH_RUN_TOKEN') == token
                                 and isinstance(barrier, str) and SAFE_TOKEN.fullmatch(barrier)
                                 and env.get('CLOUDBENCH_BARRIER_TOKEN') == barrier,
                                 'worker inherited task environment mismatch')
        _billing_stop_one(fly, registry, audit, meta, original, registry.parent.parent,
                          mid, vol, name, receipts, result, source_check=unchanged,
                          config_check=worker_config if role == 'worker' else None)
    except (Refusal, OSError, ValueError, TimeoutError, CaptureFailure, NotFound) as error:
        result.update(status='PENDING', reason_class=type(error).__name__)
    finally:
        if guard >= 0:
            os.close(guard)
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, handler)
        if prior[0] > 0:
            signal.setitimer(signal.ITIMER_REAL, max(.000001, prior[0]-(time.monotonic()-started)))
    return result


def _billing_stop_one(fly, registry, audit, meta, original, common, mid, vol, name, receipts, result, *, source_check=None, config_check=None):
    import secrets
    # This shared per-Machine inode prevents concurrent claim publication. Any
    # existing claim, even a dead one, is left to its ordinary recovery owner.
    claims = common/'cloudbench-pool-claims'
    if not claims.exists():
        claims.mkdir(mode=0o700)
        fsync_directory(common)
    exact_directory(claims, 'claims')
    lock = _billing_lock(claims/'.locks'/(mid+'.lock'))
    prior_timer = signal.getitimer(signal.ITIMER_REAL)
    previous_handler = signal.getsignal(signal.SIGALRM)
    started = time.monotonic()
    target = receipts/mid
    created = False
    try:
        _billing_require(not lexists(claims/mid), 'claim is retained')
        # mkdir is the once-intent: never resume or retry ambiguous dispatches.
        target.mkdir(mode=0o700)
        created = True
        fsync_directory(receipts)
        nonce = secrets.token_hex(16)
        publish_bytes(target/'owner-snapshot.private.json', canonical(original))
        source_binding = source_check() if source_check else None
        if source_binding is not None:
            publish_bytes(target/'source-binding.private.json', canonical(source_binding))
        intent = canonical({'schema': BILLING_SCHEMA,
            'machine': mid, 'volume': vol, 'owner': registry.name, 'nonce': nonce,
            'owner_records_sha256': sha(canonical(original)), 'epoch': time.time(),
            'helper_sha256': sha(_billing_file(Path(__file__).resolve(), 4194304)),
            'guest_source_sha256': sha(BILLING_GUEST.encode())})
        publish_bytes(target/'intent.private.json', intent)
        _billing_require(prior_timer[1] == 0, 'periodic caller timer unsupported')
        duration = min(180, prior_timer[0]) if prior_timer[0] > 0 else 180
        deadline = started + duration
        def expired(*unused):
            raise TimeoutError('billing absolute deadline')
        # Publication above consumed the existing whole-call clock. Never add
        # that elapsed time back when installing the nested target handler.
        remaining = min(deadline-time.monotonic(), signal.getitimer(signal.ITIMER_REAL)[0])
        _billing_require(remaining > 0, 'billing deadline expired during publication')
        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, remaining)
        def api(method, path, body=None, bound=deadline):
            remaining = min(deadline, bound)-time.monotonic()
            _billing_require(remaining > 0, 'billing deadline expired')
            before = signal.getitimer(signal.ITIMER_REAL)[0]
            call_start = time.monotonic()
            signal.setitimer(signal.ITIMER_REAL, max(0.000001, min(before, remaining, 20)))
            try:
                answer = fly.api(method, path, body, timeout=min(20, remaining))
                _billing_require(time.monotonic() < min(deadline, bound), 'late API return')
                return answer
            finally:
                signal.setitimer(signal.ITIMER_REAL, max(0.000001, before-(time.monotonic()-call_start)))
        pinned = None
        final_pair = None
        configured_source = None
        configured_config = None
        def pair(bound=deadline):
            nonlocal pinned, final_pair, configured_source, configured_config
            machine = api('GET', '/machines/'+mid, bound=bound)
            volume = api('GET', '/volumes/'+vol, bound=bound)
            _billing_require(isinstance(machine, dict) and isinstance(volume, dict)
                             and isinstance(machine.get('config'), dict)
                             and isinstance(machine.get('image_ref'), dict), 'malformed native pair')
            cfg = machine.get('config', {})
            identity = (machine.get('id'), machine.get('name'), machine.get('instance_id'),
                        sha(canonical(cfg)), machine.get('image_ref', {}).get('digest'))
            _billing_require(identity[0:2] == (mid, name) and bool(identity[2])
                             and isinstance(identity[4], str) and bool(identity[4])
                             and machine.get('state') in ('started', 'stopping', 'stopped')
                             and volume.get('id') == vol and volume.get('attached_machine_id') == mid,
                             'native ownership mismatch')
            _billing_require(cfg.get('restart') == {'policy': 'no'}
                             and cfg.get('auto_destroy', False) is False
                             and isinstance(cfg.get('mounts'), list) and len(cfg['mounts']) == 1
                             and isinstance(cfg['mounts'][0], dict)
                             and cfg['mounts'][0].get('volume') == vol, 'unsupported billing config')
            if config_check:
                config_check(cfg)
            elif cfg.get('init') != {'cmd': INERT_CMD} or cfg.get('env') not in (None, {}):
                binding = _billing_configured_source(registry, meta, mid, cfg)
                if configured_source is None:
                    configured_source, configured_config = binding, cfg
                    publish_bytes(target/'configured-source.private.json', canonical(binding))
                _billing_require(binding == configured_source, 'configured source changed')
            if pinned is None:
                pinned = identity
                publish_bytes(target/'native-before.private.json', canonical({'machine': machine, 'volume': volume}))
            _billing_require(identity == pinned, 'native config/version/image changed')
            final_pair = {'machine': machine, 'volume': volume}
            return machine
        def local_unchanged():
            if source_check:
                _billing_require(source_check() == source_binding, 'idle-stop source changed')
            if configured_source is not None:
                _billing_require(_billing_configured_source(registry, meta, mid, configured_config)
                                 == configured_source, 'configured source changed')
            _billing_require((_billing_tree(registry), _billing_tree(audit)) == original
                             and not lexists(claims/mid)
                             and pid_birth_state(meta['pid'], meta['pid_start']) == 'live',
                             'owner/claim changed')
        local_unchanged()
        machine = pair()
        if machine['state'] == 'stopped':
            _billing_require(pair()['state'] == 'stopped', 'stopped state changed')
            local_unchanged()
            result['status'] = 'ALREADY_STOPPED_RETAINED'
        else:
            _billing_require(machine['state'] == 'started', 'not started')
            code = BILLING_GUEST.replace('TARGET', repr(mid)).replace('NONCE', repr(nonce))
            command = 'python3 -I -S -B -c '+shlex.quote(code)
            _billing_require(len(command.encode()) <= 7000, 'guest command size')
            def ack(row):
                return (isinstance(row, dict) and row.get('kind') == 'exact-inert-quiescence-v1'
                        and row.get('machine') == mid and row.get('nonce') == nonce
                        and isinstance(row.get('boot'), str) and len(row['boot']) == 36
                        and row.get('unknown') == [] and bool(row.get('inert_sleepers')))
            guest_seconds = int(min(30, deadline-time.monotonic()))
            _billing_require(guest_seconds > 0, 'insufficient guest deadline remaining')
            guest = fly.machine_exec_json(guest_seconds, mid, command, max_command_bytes=7000,
                                         max_response_bytes=65536, validate_ack=ack)
            _billing_require(time.monotonic() < deadline, 'late guest return')
            _billing_require(ack(guest), 'guest ACK mismatch')
            publish_bytes(target/'quiescence.private.json', canonical(guest))
            _billing_require(pair()['state'] == 'started', 'post-probe state changed')
            local_unchanged()
            publish_bytes(target/'stop.intent.private.json', canonical({'machine': mid, 'nonce': nonce,
                                                                        'instance': pinned[2]}))
            result['stop_issued'] = True
            api('POST', '/machines/'+mid+'/stop', {})
            confirmation = min(deadline, time.monotonic()+90)
            while True:
                machine = pair(confirmation)
                if machine['state'] == 'stopped':
                    break
                time.sleep(min(2, max(0, confirmation-time.monotonic())))
            local_unchanged()
            result['status'] = 'STOPPED_RETAINED'
        native_final = canonical(final_pair)
        publish_bytes(target/'native-final.private.json', native_final)
        result.update(all_config_and_volume_retained=True, native_release=False,
                      evidence_or_task_credit=False, native_final_sha256=sha(native_final),
                      intent_sha256=sha(intent), owner_records_sha256=sha(canonical(original)),
                      helper_sha256=json.loads(intent)['helper_sha256'],
                      guest_source_sha256=sha(BILLING_GUEST.encode()))
        if lexists(target/'quiescence.private.json'):
            result['quiescence_sha256'] = sha(_billing_file(target/'quiescence.private.json'))
        if source_binding is not None:
            result.update(source_binding_sha256=sha(canonical(source_binding)),
                          native_instance_id=pinned[2], native_config_sha256=pinned[3])
        if configured_source is not None:
            result['configured_source_sha256'] = sha(_billing_file(target/'configured-source.private.json'))
        publish_bytes(target/'result.private.json', canonical(result))
    except (Refusal, OSError, ValueError, TimeoutError, CaptureFailure, NotFound) as error:
        result['status'] = 'PENDING'
        if created and target.is_dir() and not lexists(target/'result.private.json'):
            # Diagnostic private originals never escape into the safe summary.
            publish_bytes(target/'failure.original.private.txt', str(error).encode()[:65536])
        raise
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if prior_timer[0] > 0:
            signal.setitimer(signal.ITIMER_REAL, max(0.000001, prior_timer[0]-(time.monotonic()-started)))
        os.close(lock)


def main(argv: list[str]) -> int:
    if argv[:1] == ["guest-collect"]:
        return guest_collect(argv[1:])
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--bench", required=True)
    parser.add_argument("--machine-id", required=True)
    parser.add_argument("--volume-id", required=True)
    parser.add_argument("--capture-dir", type=Path)
    parser.add_argument("--isolate-services", action="store_true",
                        help="explicitly remove network services during inert capture and restore them exactly")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--preflight-only", action="store_true")
    mode.add_argument("--restore-original-config", action="store_true")
    mode.add_argument("--publish-recovery-inputs", action="store_true",
                      help="no provider call: hand recovery an existing undelivered native-stop capture")
    mode.add_argument("--next-step", action="store_true",
                      help="read-only: print the supported capture command for an undelivered native stop")
    parser.add_argument("--undelivered-native-stop", action="store_true",
                        help="admit only a quarantined guest with an exact verified guest-native-stop.json "
                             "(delivery_receipt=absent); publish its backend log and provider manifest for recovery")
    parser.add_argument("--configured-old-member", action="store_true",
                        help="diagnostic-only capture of an exact retained host-replaced member; never consumes its pending obligation")
    parser.add_argument("--wait-seconds", type=int, default=300)
    parser.add_argument("--ssh-seconds", type=int, default=300)
    parser.add_argument("--attempts", type=int, default=5)
    args = parser.parse_args(argv)
    try:
        if args.configured_old_member and (args.undelivered_native_stop or args.publish_recovery_inputs or args.next_step):
            raise Refusal("configured old-member mode cannot publish recovery inputs or use another admission")
        if args.next_step:
            return next_step(args)
        if args.capture_dir is None:
            parser.error("--capture-dir is required")
        if args.publish_recovery_inputs:
            return publish_existing_capture_inputs(args)
        return restore_only(args) if args.restore_original_config else capture(args)
    except Refusal as error:
        print(f"❌ refused: {error}", file=sys.stderr)
        return EXIT_REFUSED


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
