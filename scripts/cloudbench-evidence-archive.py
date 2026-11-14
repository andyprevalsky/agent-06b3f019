#!/usr/bin/env python3
"""Archive a stopped cloudbench guest's evidence to R2, then destroy the guest.

Default disposition for a terminal, failed or cancelled cloud smoke guest whose
runtime evidence was never sealed (Andy, 2026-11-14: "save the logs somehow and
then destroy as the default so we stop getting stale machines"). Before this, such
guests were stopped and retained with their ~40 GB volume indefinitely.

``capture-destroy`` for one exact Machine:

1. preflight, no mutation: the Machine is a ``stopped`` cloudbench guest on the
   original boot driver with exactly one ``/data`` volume attached to it; never a
   protected warm donor (683e47df5094d8, ``cloudbench-warm-*``);
2. boots it inert (``init.cmd`` = ``sleep infinity``, services removed) through
   the same functions as ``cloudbench-original-volume-capture.py``, so the
   original driver can never run again;
3. archives the original-file contract shared with the startup-failure capture
   plus a bounded sweep of every other log on the volume into ``evidence.tar.gz``
   with a per-file sha256 inventory, downloads and verifies it, and stops the guest;
4. uploads ``evidence.tar.gz``, ``inventory.json``, the secret-redacted Machine
   config and ``manifest.json`` (last) to the private trace-archive bucket under
   ``smoke-evidence/<machine>/<utc-ts>/``. Keys are never overwritten and R2
   objects are never deleted; every object is read back and its sha256 checked;
5. only after the read-back: destroys the Machine, then its volume, proving each
   terminal state natively, and records ``destroy-receipt.json`` (local + R2).
   With ``--capture-only`` (fleet teardown) it instead restores the exact original
   config and leaves the stopped guest to the fleet's audited exact-owner reap.

If anything fails before the read-back succeeds, the guest is stopped, its exact
original config restored, and it is RETAINED (exit 2, loud). Exit 3 is a
preflight refusal (nothing mutated); exit 4 means the evidence is archived but
the destroy was not proven.

Usage:
  python3 scripts/cloudbench-evidence-archive.py capture-destroy \\
    --app navi-whisper-lux-bench --machine-id <id> [--volume-id vol_...] \\
    [--run-token <token>] --receipt-dir <dir> [--env-file agents/.env] \\
    [--capture-only] [--protected-machine <id>]...
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import io
import json
import os
import re
import runpy
import signal
import stat
import sys
import tarfile
import time
from pathlib import Path

SCHEMA = "cloudbench-smoke-evidence-v1"
KEY_PREFIX = "smoke-evidence"
BOOT_CMD = ["bash", "/cloudbench-boot.sh"]
DATA_PATH = "/data"
PROTECTED_MACHINES = frozenset({"683e47df5094d8"})
PROTECTED_VOLUMES = frozenset({"vol_vwnym366kn7k8mmv"})
# Guest names are cloudbench-<hex>; any "warm" name (cloudbench-warm-*, deploy-warm-pool-*,
# warmpool_* volumes) is a donor or pool member.
PROTECTED_NAME_MARKER = "warm"
MACHINE_ID = re.compile(r"[0-9a-f]{14}")
VOLUME_ID = re.compile(r"vol_[0-9a-z]{16}")
SAFE_TOKEN = re.compile(r"[A-Za-z0-9._-]+")
MEMBER_NAME = re.compile(r"[A-Za-z0-9._/@+=,-]+")
SECRET_ENV = re.compile(r"TOKEN|SECRET|PASSWORD|PASSWD|KEY|AUTH|COOKIE|CREDENTIAL|_URL$", re.I)
MARKER = "CLOUDBENCH_EVIDENCE_ARCHIVE="
ERROR_MARKER = "CLOUDBENCH_EVIDENCE_ARCHIVE_ERROR="
# Bounded like the original-file contract; the controller holds a few copies per in-flight guest.
PER_FILE_MAX = 128 * 1024 * 1024
TOTAL_MAX = 512 * 1024 * 1024
SWEEP_TREES = ("repo/.context/cloudbench", "repo/agents/.llm-dumps", "repo/.llm-dumps")
SWEEP_LOG_DEPTH = 3
# Repo-wide sweep takes service logs only; checked-in .jsonl ledgers are not runtime evidence.
SWEEP_LOG = re.compile(r".*(\.log|-log\.txt|-logs\.txt)")
PRUNE = {"node_modules", ".git", "venv", ".venv", "__pycache__", "lost+found", "cloudbench-cache", "site-packages"}
HELPERS = ("cloudbench-evidence-archive.py", "cloudbench-original-volume-capture.py",
           "cloudbench-startup-failure-archive.py")
EXIT_OK, EXIT_RETAINED, EXIT_REFUSED, EXIT_DESTROY_UNPROVEN = 0, 2, 3, 4


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


_SIBLINGS: dict[str, dict] = {}


def sibling(name: str) -> dict:
    # One namespace per helper, so the Fly client and every caller share its exception classes.
    if name not in _SIBLINGS:
        _SIBLINGS[name] = runpy.run_path(str(Path(__file__).resolve().with_name(name)))
    return _SIBLINGS[name]


# ── Guest side: runs on the inert guest from an ephemeral /tmp directory ────


class GuestRefusal(Exception):
    pass


def _read_regular(path: Path, limit: int) -> tuple[bytes, os.stat_result]:
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise ValueError("not a bounded regular file")
        data = source.read(before.st_size + 1)
    if len(data) != before.st_size:
        raise ValueError("file changed while reading")
    return data, before


def sweep_candidates(data: Path) -> list[str]:
    """Every other evidence-like file, by priority; symlinks are never followed."""
    names: list[str] = []
    for entry in sorted(os.scandir(data), key=lambda e: e.name):
        if entry.is_file(follow_symlinks=False):
            names.append(entry.name)
    for tree in SWEEP_TREES:
        root = data / tree
        if root.is_dir() and not root.is_symlink():
            for current, dirs, files in os.walk(root, followlinks=False):
                dirs[:] = sorted(d for d in dirs if d not in PRUNE)
                names += sorted(str((Path(current) / f).relative_to(data)) for f in files)
    repo = data / "repo"
    if repo.is_dir() and not repo.is_symlink():
        for current, dirs, files in os.walk(repo, followlinks=False):
            depth = len(Path(current).relative_to(repo).parts)
            dirs[:] = sorted(d for d in dirs if d not in PRUNE and depth < SWEEP_LOG_DEPTH)
            names += sorted(str((Path(current) / f).relative_to(data)) for f in files if SWEEP_LOG.fullmatch(f))
    seen: set[str] = set()
    return [n for n in names if not (n in seen or seen.add(n))]


def guest_collect(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="cloudbench-evidence-archive guest-collect")
    parser.add_argument("--data", required=True)
    parser.add_argument("--run-token", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--inventory", required=True)
    parser.add_argument("--proc", default="/proc")
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        if not SAFE_TOKEN.fullmatch(args.run_token):
            raise GuestRefusal("unsafe run token")
        capture = sibling("cloudbench-original-volume-capture.py")
        sleepers, forbidden = capture["_scan_processes"](Path(args.proc))
        if forbidden or sleepers < 1:
            raise GuestRefusal(f"guest is not inert: sleepers={sleepers} forbidden={forbidden}")
        data = Path(args.data)
        contract = capture["original_file_contract"]()
        extra = list(capture["expected_names"](args.run_token) - contract["original_names"](args.run_token))
        # The exact original-file contract is mandatory; a refusal here retains the guest.
        files, missing = contract["original_files"](data, args.run_token, extra)
        rows: dict[str, dict] = {}
        skipped: list[dict] = []
        total = 0
        stats: dict[str, tuple] = {}
        output = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(output, "wb") as raw, tarfile.open(fileobj=raw, mode="w:gz") as archive:
            def add(name: str, content: bytes, status: os.stat_result | None, kind: str) -> None:
                nonlocal total
                info = tarfile.TarInfo(name)
                info.size, info.mode = len(content), 0o600
                info.mtime = int(status.st_mtime) if status else 0
                archive.addfile(info, io.BytesIO(content))
                rows[name] = {"bytes": len(content), "sha256": sha(content), "class": kind}
                total += len(content)
            for name in sorted(files):
                add(name, files[name], None, "contract")
            for name in sweep_candidates(data):
                if name in rows:
                    continue
                path = data / name
                try:
                    if not MEMBER_NAME.fullmatch(name) or ".." in Path(name).parts:
                        raise ValueError("unsafe member name")
                    if any(p.is_symlink() for p in path.parents if p.is_relative_to(data)) or path.is_symlink():
                        raise ValueError("symlink")
                    size = path.lstat().st_size
                    if size > PER_FILE_MAX or total + size > TOTAL_MAX:
                        raise ValueError(f"over budget ({size} bytes)")
                    content, status = _read_regular(path, PER_FILE_MAX)
                except (OSError, ValueError) as error:
                    skipped.append({"name": name if MEMBER_NAME.fullmatch(name) else repr(name)[:200],
                                    "reason": str(error)[:120]})
                    continue
                add(name, content, status, "sweep")
                stats[name] = (status.st_ino, status.st_size, status.st_mtime_ns)
        if contract["original_files"](data, args.run_token, extra) != (files, missing):
            raise GuestRefusal("original files changed during capture")
        for name, before in stats.items():
            after = (data / name).lstat()
            if (after.st_ino, after.st_size, after.st_mtime_ns) != before:
                raise GuestRefusal(f"swept file changed during capture: {name}")
        archive_bytes = Path(args.output).read_bytes()
        inventory = {
            "schema": SCHEMA, "run_token": args.run_token, "files": rows, "missing_contract": sorted(missing),
            "skipped": skipped, "archive_bytes": len(archive_bytes), "archive_sha256": sha(archive_bytes),
            "inert_sleepers": sleepers,
        }
        encoded = json.dumps(inventory, sort_keys=True, indent=1).encode() + b"\n"
        descriptor = os.open(args.inventory, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
        print(MARKER + json.dumps({"archive_sha256": inventory["archive_sha256"],
                                    "inventory_sha256": sha(encoded)}, sort_keys=True), flush=True)
        return 0
    except (GuestRefusal, OSError, ValueError, tarfile.TarError) as error:
        print(ERROR_MARKER + json.dumps({"error": str(error)[:500]}), flush=True)
        return EXIT_REFUSED


# ── Controller side ──────────────────────────────────────────────────────────


class Refusal(Exception):
    """Preflight refusal: nothing was mutated."""


class R2Store:
    """Write-once R2 objects with read-back; deliberately has no delete."""

    def __init__(self, client, bucket: str) -> None:
        if not bucket:
            raise Refusal("R2_BUCKET_TRACE_ARCHIVE is not set")
        self.client, self.bucket = client, bucket

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except Exception as error:  # botocore ClientError carries the HTTP status
            code = str(getattr(error, "response", {}).get("Error", {}).get("Code", ""))
            if code in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    def put_verified(self, key: str, data: bytes, content_type: str) -> dict:
        if self.exists(key):
            raise RuntimeError(f"R2 key already exists, refusing to overwrite: {key}")
        digest = sha(data)
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type,
                               Metadata={"sha256": digest})
        body = self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        if sha(body) != digest or len(body) != len(data):
            raise RuntimeError(f"R2 read-back mismatch for {key}")
        return {"key": key, "bytes": len(data), "sha256": digest}


def r2_store(env_file: str | None) -> R2Store:
    values = dict(os.environ)
    if env_file:
        from dotenv import dotenv_values  # agents/venv; already-set env vars win
        values = {**{k: v for k, v in dotenv_values(env_file).items() if v is not None}, **values}
    missing = [k for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_TRACE_ARCHIVE")
               if not values.get(k)]
    if missing:
        raise Refusal("R2 credentials missing: " + ", ".join(missing))
    import boto3
    from botocore.config import Config

    client = boto3.client(
        "s3", endpoint_url=f"https://{values['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=values["R2_ACCESS_KEY_ID"], aws_secret_access_key=values["R2_SECRET_ACCESS_KEY"],
        region_name="auto", config=Config(retries={"max_attempts": 5, "mode": "standard"}))
    return R2Store(client, values["R2_BUCKET_TRACE_ARCHIVE"])


def protected(ident: str, name: str | None, extra: frozenset[str] = frozenset()) -> bool:
    return ident in PROTECTED_MACHINES | PROTECTED_VOLUMES | extra or PROTECTED_NAME_MARKER in (name or "").lower()


def preflight(fly, capture: dict, machine_id: str, volume_id: str | None, run_token: str | None,
              extra_protected: frozenset[str] = frozenset()) -> dict:
    if not MACHINE_ID.fullmatch(machine_id or ""):
        raise Refusal("malformed Machine id")
    if protected(machine_id, None, extra_protected):
        raise Refusal(f"Machine {machine_id} is a protected warm donor; never touched")
    try:
        machine = fly.machine(machine_id)
    except capture["NotFound"]:
        raise Refusal(f"Machine {machine_id} does not exist") from None
    config = machine.get("config") or {}
    if protected(machine_id, machine.get("name")):
        raise Refusal(f"Machine {machine_id} ({machine.get('name')}) is a protected warm donor; never touched")
    if machine.get("state") != "stopped":
        raise Refusal(f"Machine {machine_id} is {machine.get('state')!r}, not stopped; only a stopped guest is archived")
    if (config.get("init") or {}).get("cmd") != BOOT_CMD or not str(machine.get("name", "")).startswith("cloudbench-"):
        raise Refusal(f"Machine {machine_id} is not a cloudbench guest on the original boot driver")
    mounts = config.get("mounts") or []
    if len(mounts) != 1 or mounts[0].get("path") != DATA_PATH or not VOLUME_ID.fullmatch(mounts[0].get("volume", "")):
        raise Refusal(f"Machine {machine_id} does not mount exactly one /data volume")
    volume_ref = mounts[0]["volume"]
    if volume_id and volume_id != volume_ref:
        raise Refusal(f"Machine {machine_id} mounts {volume_ref}, not {volume_id}")
    volume = fly.volume(volume_ref)
    if volume.get("attached_machine_id") != machine_id or volume.get("state") != "created":
        raise Refusal(f"volume {volume_ref} is {volume.get('state')!r} attached to {volume.get('attached_machine_id')!r}")
    if protected(volume_ref, volume.get("name"), extra_protected):
        raise Refusal(f"volume {volume_ref} ({volume.get('name')}) is a protected warm volume; never touched")
    token = (config.get("env") or {}).get("CLOUDBENCH_RUN_TOKEN", "")
    if not SAFE_TOKEN.fullmatch(token or "") or (run_token and run_token != token):
        raise Refusal(f"Machine {machine_id} run token {token!r} differs from the expected guest")
    return {"machine": machine, "volume": volume, "volume_id": volume_ref, "token": token}


def guest_capture(fly, capture: dict, app: str, machine_id: str, token: str, work: Path,
                  journal, attempts: int, ssh_seconds: int) -> tuple[bytes, dict, bytes]:
    here = Path(__file__).resolve()
    base = ["-a", app, "--machine", machine_id]
    last = "no attempt"
    for attempt in range(1, attempts + 1):
        if attempt > 1:
            time.sleep(float(os.environ.get("CLOUDBENCH_CAPTURE_POLL_SECONDS", "2")) * 2.5 * attempt)
        remote = f"/tmp/cloudbench-evidence-archive-{os.urandom(8).hex()}"
        rc, _, err = fly.flyctl(ssh_seconds, "ssh", "console", *base, "-C", f"mkdir -m 700 {remote}")
        for helper in HELPERS if rc == 0 else ():
            rc, _, err = fly.flyctl(ssh_seconds, "ssh", "sftp", "put", *base, "-q", "-m", "0600",
                                    str(here.with_name(helper)), f"{remote}/{helper}")
            if rc != 0:
                break
        if rc != 0:
            last = f"collector upload failed (exit {rc}): {err.strip()[:200]}"
            journal("guest-retry", attempt=attempt, reason=last)
            continue
        rc, out, err = fly.flyctl(ssh_seconds, "ssh", "console", *base, "-C",
                                  f"python3 -I -B {remote}/{HELPERS[0]} guest-collect --data {DATA_PATH} "
                                  f"--run-token {token} --output {remote}/evidence.tar.gz "
                                  f"--inventory {remote}/inventory.json")
        lines = [line.strip() for line in out.splitlines() if line.startswith((MARKER, ERROR_MARKER))]
        if len(lines) == 1 and lines[0].startswith(ERROR_MARKER):
            raise capture["CaptureFailure"]("guest refused capture: " + json.loads(lines[0][len(ERROR_MARKER):])["error"])
        if rc != 0 or len(lines) != 1:
            last = f"collector failed (exit {rc}): {err.strip()[:200]}"
            journal("guest-retry", attempt=attempt, reason=last)
            continue
        marker = json.loads(lines[0][len(MARKER):])
        tag = remote.rsplit("-", 1)[-1]
        local_archive, local_inventory = work / f".{machine_id}.{tag}.tar.gz", work / f".{machine_id}.{tag}.inventory.json"
        ok = True
        for remote_name, local in (("evidence.tar.gz", local_archive), ("inventory.json", local_inventory)):
            rc, _, err = fly.flyctl(ssh_seconds, "ssh", "sftp", "get", *base, f"{remote}/{remote_name}", str(local))
            if rc != 0 or not local.is_file() or local.is_symlink():
                last, ok = f"download of {remote_name} failed (exit {rc}): {err.strip()[:200]}", False
                break
        if not ok:
            journal("guest-retry", attempt=attempt, reason=last)
            continue
        archive, inventory_bytes = local_archive.read_bytes(), local_inventory.read_bytes()
        if sha(archive) != marker["archive_sha256"] or sha(inventory_bytes) != marker["inventory_sha256"]:
            last = "downloaded bytes differ from the guest's sha256"
            journal("guest-retry", attempt=attempt, reason=last)
            continue
        inventory = json.loads(inventory_bytes)
        verify_archive(archive, inventory, token)
        journal("downloaded", attempt=attempt, archive_sha256=marker["archive_sha256"])
        return archive, inventory, inventory_bytes
    raise capture["CaptureFailure"](f"guest capture failed after {attempts} attempts: {last}")


def verify_archive(archive: bytes, inventory: dict, token: str) -> None:
    if (inventory.get("schema") != SCHEMA or inventory.get("run_token") != token
            or inventory.get("archive_sha256") != sha(archive) or inventory.get("archive_bytes") != len(archive)):
        raise ValueError("inventory does not describe this archive")
    seen = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for member in tar.getmembers():
            if not member.isreg() or not MEMBER_NAME.fullmatch(member.name) or member.name in seen:
                raise ValueError(f"unexpected archive member {member.name!r}")
            seen[member.name] = sha(tar.extractfile(member).read())
    if seen != {name: row["sha256"] for name, row in inventory["files"].items()}:
        raise ValueError("archive members differ from the inventory")


def redacted_config(config: dict) -> dict:
    value = json.loads(json.dumps(config))
    for key in list((value.get("env") or {})):
        if SECRET_ENV.search(key) and key != "CLOUDBENCH_RUN_TOKEN":
            value["env"][key] = "<redacted>"
    for item in value.get("files") or []:  # boot payloads can embed credentials
        if "raw_value" in item:
            item["raw_value"] = "<redacted sha256:" + sha(str(item["raw_value"]).encode()) + ">"
    return value


def wait_gone(fly, capture: dict, kind: str, ident: str, terminal: set[str], seconds: int) -> dict:
    deadline = time.monotonic() + seconds
    while True:
        try:
            row = fly.machine(ident) if kind == "machine" else fly.volume(ident)
        except capture["NotFound"]:
            return {"http_status": 404, "state": "absent"}
        if row.get("state") in terminal and not (kind == "volume" and row.get("attached_machine_id")):
            return {"http_status": 200, "state": row.get("state")}
        if time.monotonic() >= deadline:
            raise RuntimeError(f"{kind} {ident} did not reach {sorted(terminal)} (state={row.get('state')!r})")
        time.sleep(float(os.environ.get("CLOUDBENCH_CAPTURE_POLL_SECONDS", "2")))


def destroy(fly, capture: dict, machine_id: str, volume_id: str, inert: dict, seconds: int) -> dict:
    current = fly.machine(machine_id)
    mounts = (current.get("config") or {}).get("mounts") or []
    if current.get("state") != "stopped" or current.get("config") != inert or [m.get("volume") for m in mounts] != [volume_id]:
        raise RuntimeError("Machine changed after capture; refusing to destroy")
    fly.api("DELETE", f"/machines/{machine_id}")
    machine_final = wait_gone(fly, capture, "machine", machine_id, {"destroyed"}, seconds)
    deadline = time.monotonic() + seconds
    while True:  # the volume detaches asynchronously after its Machine is destroyed
        try:
            fly.api("DELETE", f"/volumes/{volume_id}")
            break
        except capture["NotFound"]:
            break
        except capture["CaptureFailure"]:
            if time.monotonic() >= deadline:
                raise
            time.sleep(float(os.environ.get("CLOUDBENCH_CAPTURE_POLL_SECONDS", "2")) * 2)
    volume_final = wait_gone(fly, capture, "volume", volume_id, {"pending_destroy", "destroyed"}, seconds)
    return {"machine": machine_final, "volume": volume_final}


def restore_original(fly, app: str, machine_id: str, original_config: Path, wait_seconds: int = 240) -> int:
    """Return a guest left in this helper's inert config (e.g. after SIGKILL) to its saved original."""
    capture = sibling("cloudbench-original-volume-capture.py")
    original = json.loads(original_config.read_text())
    journal = capture["Journal"](original_config.with_name("journal.jsonl").resolve())
    try:
        restored = capture["stop_and_restore"](fly, {"machine_id": machine_id, "app": app}, original, journal, wait_seconds)
    except (capture["CaptureFailure"], capture["NotFound"]) as error:
        print(f"❌ restore of {machine_id} failed: {str(error)[:300]}", file=sys.stderr)
        return EXIT_RETAINED
    ok = restored.get("state") in ("stopped", "created") and restored.get("config") == original
    print(json.dumps({"machine_id": machine_id, "restored": ok, "state": restored.get("state")}, sort_keys=True))
    return EXIT_OK if ok else EXIT_RETAINED


def capture_destroy(fly, store: R2Store, *, app: str, machine_id: str, volume_id: str | None,
                    run_token: str | None, receipt_dir: Path, attempts: int = 3, ssh_seconds: int = 240,
                    wait_seconds: int = 240, now=None, capture_only: bool = False,
                    extra_protected: frozenset[str] = frozenset(), capture_seconds: int = 900) -> int:
    capture = sibling("cloudbench-original-volume-capture.py")
    try:
        ident = preflight(fly, capture, machine_id, volume_id, run_token, extra_protected)
    except (Refusal, capture["NotFound"], capture["CaptureFailure"]) as error:
        print(f"❌ evidence archive refused, nothing touched: {error}", file=sys.stderr)
        return EXIT_REFUSED
    stamp = (now or datetime.datetime.now(datetime.timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    prefix = f"{KEY_PREFIX}/{machine_id}/{stamp}"
    work = receipt_dir / machine_id / stamp
    work.mkdir(parents=True, exist_ok=False, mode=0o700)
    journal = capture["Journal"]((work / "journal.jsonl").resolve())
    original, volume = ident["machine"]["config"], ident["volume_id"]
    inert = capture["inert_variant"](original)
    restore_ident = {"machine_id": machine_id, "app": app}
    stage, mutated, objects = "inert-config", False, []
    # Private exact original (secret env and boot payload) before any mutation, so even a
    # SIGKILL mid-capture stays recoverable with the `restore` subcommand.
    saved = work / "original-config.private.json"
    with os.fdopen(os.open(saved, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "w") as stream:
        stream.write(json.dumps(original, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())

    def interrupted(signum, _frame):
        raise capture["CaptureFailure"](f"interrupted by signal {signum}")

    previous = {sig: signal.signal(sig, interrupted)
                for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGALRM)}
    # The whole capture is bounded so the restore below keeps its own budget inside any outer timeout.
    signal.alarm(max(1, capture_seconds))
    try:
        mutated = True
        fly.api("POST", f"/machines/{machine_id}", {"config": inert, "skip_launch": True})
        capture["wait_for"](fly, machine_id, lambda m: m.get("state") in ("stopped", "created") and m.get("config") == inert,
                            wait_seconds, "idle with the inert config")
        journal("inert-config-applied")
        stage = "inert-start"
        fly.api("POST", f"/machines/{machine_id}/start")
        started = capture["wait_for"](fly, machine_id, lambda m: m.get("state") == "started", wait_seconds, "started")
        if started.get("config") != inert:
            raise capture["CaptureFailure"]("started Machine is not running the exact inert config")
        journal("inert-started", instance_id=started.get("instance_id"))
        stage = "guest-capture"
        archive, inventory, inventory_bytes = guest_capture(
            fly, capture, app, machine_id, ident["token"], work, journal, attempts, ssh_seconds)
        stage = "stop"
        fly.api("POST", f"/machines/{machine_id}/stop", {})
        capture["wait_for"](fly, machine_id, lambda m: m.get("state") == "stopped", wait_seconds, "stopped")
        journal("stopped-after-capture")
        stage = "r2-upload"
        config_bytes = json.dumps(redacted_config(original), sort_keys=True, indent=1).encode() + b"\n"
        objects.append(store.put_verified(f"{prefix}/evidence.tar.gz", archive, "application/gzip"))
        objects.append(store.put_verified(f"{prefix}/inventory.json", inventory_bytes, "application/json"))
        objects.append(store.put_verified(f"{prefix}/machine-config.redacted.json", config_bytes, "application/json"))
        manifest = {
            "schema": SCHEMA, "app": app, "machine_id": machine_id, "machine_name": ident["machine"].get("name"),
            "region": ident["machine"].get("region"), "instance_id": ident["machine"].get("instance_id"),
            "image": original.get("image"), "volume_id": volume, "volume_name": ident["volume"].get("name"),
            "volume_size_gb": ident["volume"].get("size_gb"), "run_token": ident["token"],
            "fleet_owner_token": ident["token"].rsplit("-", 1)[0], "captured_at": stamp,
            "original_config_sha256": sha(canonical(original)), "files": len(inventory["files"]),
            "missing_contract": inventory["missing_contract"], "skipped": len(inventory["skipped"]),
            "objects": {Path(o["key"]).name: {"bytes": o["bytes"], "sha256": o["sha256"]} for o in objects},
            "helper_sha256": sha(Path(__file__).resolve().read_bytes()), "outcome_credit": False,
        }
        objects.append(store.put_verified(f"{prefix}/manifest.json",
                                          json.dumps(manifest, sort_keys=True, indent=1).encode() + b"\n",
                                          "application/json"))
        signal.alarm(0)
        journal("r2-verified", keys=[o["key"] for o in objects])
    except BaseException as error:
        signal.alarm(0)
        for sig in previous:
            signal.signal(sig, signal.SIG_IGN)
        outcome: dict = {"stopped": None, "restored": False}
        if mutated:
            try:
                restored = capture["stop_and_restore"](fly, restore_ident, original, journal, wait_seconds)
                outcome = {"stopped": restored.get("state") == "stopped", "restored": restored.get("config") == original}
            except BaseException as cleanup_error:  # keep the original failure visible
                outcome["cleanup_error"] = str(cleanup_error)[:300]
        failure = {"schema": SCHEMA, "kind": "capture-failed-retained", "machine_id": machine_id,
                   "volume_id": volume, "run_token": ident["token"], "stage": stage, "error": str(error)[:500],
                   "r2_objects_written": objects, **outcome}
        (work / "capture-failure.json").write_text(json.dumps(failure, sort_keys=True, indent=1) + "\n")
        journal("failed", stage=stage, restored=outcome.get("restored"))
        print(f"❌❌ EVIDENCE CAPTURE FAILED for Machine {machine_id} at {stage}: {str(error)[:300]}\n"
              f"❌❌ RETAINED: Machine {machine_id} and volume {volume} are kept "
              f"{'STOPPED with the original config' if outcome.get('restored') else 'in an UNPROVEN state'}; "
              f"see {work / 'capture-failure.json'}"
              + ("" if outcome.get("restored") else
                 f"\n❌❌ restore with: {Path(sys.argv[0]).name} restore --app {app} --machine-id {machine_id} "
                 f"--original-config {saved}"), file=sys.stderr)
        return EXIT_RETAINED
    finally:
        signal.alarm(0)
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    receipt = {"schema": SCHEMA, "kind": "archived-then-destroyed", "app": app, "machine_id": machine_id,
               "volume_id": volume, "volume_size_gb": ident["volume"].get("size_gb"), "run_token": ident["token"],
               "bucket": store.bucket, "prefix": prefix, "objects": objects, "captured_at": stamp}
    if capture_only:
        receipt["kind"] = "archived-original-restored-for-reap"
        try:
            restored = capture["stop_and_restore"](fly, restore_ident, original, journal, wait_seconds)
            if restored.get("state") != "stopped" or restored.get("config") != original:
                raise RuntimeError(f"restored Machine is {restored.get('state')!r}")
        except BaseException as error:
            receipt.update(kind="archived-restore-unproven", error=str(error)[:500])
            (work / "receipt.json").write_text(json.dumps(receipt, sort_keys=True, indent=1) + "\n")
            print(f"❌ evidence archived to {prefix}/ but the original config of {machine_id} was not proven "
                  f"restored: {str(error)[:300]}", file=sys.stderr)
            return EXIT_DESTROY_UNPROVEN
        (work / "receipt.json").write_text(json.dumps(receipt, sort_keys=True, indent=1) + "\n")
        print(json.dumps({"archived": True, "destroyed": False, "machine_id": machine_id, "volume_id": volume,
                          "prefix": prefix, "archive_sha256": objects[0]["sha256"],
                          "receipt": str(work / "receipt.json")}, sort_keys=True))
        return EXIT_OK
    try:
        receipt["final"] = destroy(fly, capture, machine_id, volume, inert, wait_seconds)
    except BaseException as error:
        receipt.update(kind="archived-destroy-unproven", error=str(error)[:500])
        (work / "receipt.json").write_text(json.dumps(receipt, sort_keys=True, indent=1) + "\n")
        print(f"❌ evidence archived to {prefix}/ but destroying {machine_id}/{volume} was not proven: "
              f"{str(error)[:300]}", file=sys.stderr)
        return EXIT_DESTROY_UNPROVEN
    receipt["destroyed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    journal("destroyed", machine=receipt["final"]["machine"], volume=receipt["final"]["volume"])
    encoded = json.dumps(receipt, sort_keys=True, indent=1).encode() + b"\n"
    (work / "receipt.json").write_bytes(encoded)
    try:
        store.put_verified(f"{prefix}/destroy-receipt.json", encoded, "application/json")
    except Exception as error:  # the evidence itself is already verified in R2
        print(f"⚠️  destroy receipt not uploaded ({str(error)[:200]}); local copy {work / 'receipt.json'}",
              file=sys.stderr)
    print(json.dumps({"archived": True, "destroyed": True, "machine_id": machine_id, "volume_id": volume,
                      "prefix": prefix, "archive_sha256": objects[0]["sha256"],
                      "receipt": str(work / "receipt.json")}, sort_keys=True))
    return EXIT_OK


def main(argv: list[str]) -> int:
    if argv[:1] == ["guest-collect"]:
        return guest_collect(argv[1:])
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("capture-destroy")
    run.add_argument("--app", required=True)
    run.add_argument("--machine-id", required=True)
    run.add_argument("--volume-id")
    run.add_argument("--run-token")
    run.add_argument("--receipt-dir", required=True, type=Path)
    run.add_argument("--env-file")
    run.add_argument("--attempts", type=int, default=3)
    run.add_argument("--ssh-seconds", type=int, default=240)
    run.add_argument("--wait-seconds", type=int, default=240)
    run.add_argument("--capture-only", action="store_true",
                     help="archive, restore the original config and leave the destroy to the fleet reap")
    run.add_argument("--protected-machine", action="append", default=[])
    run.add_argument("--capture-seconds", type=int, default=900,
                     help="bound on boot+capture+upload; the original-config restore runs after it")
    back = sub.add_parser("restore", help="return a guest stuck in the inert capture config to its saved original")
    back.add_argument("--app", required=True)
    back.add_argument("--machine-id", required=True)
    back.add_argument("--original-config", required=True, type=Path)
    back.add_argument("--env-file")
    args = parser.parse_args(argv)
    capture = sibling("cloudbench-original-volume-capture.py")
    try:
        store = r2_store(args.env_file) if args.command == "capture-destroy" else None
        token = os.environ.get("FLY_API_TOKEN")
        if not token and args.env_file:
            from dotenv import dotenv_values
            token = dotenv_values(args.env_file).get("FLY_API_TOKEN")
        if not token:
            raise Refusal("FLY_API_TOKEN is not set")
        fly = capture["Fly"](args.app, token)
    except (Refusal, capture["Refusal"], ImportError) as error:
        print(f"❌❌ evidence archive unavailable, guest RETAINED untouched: {error}", file=sys.stderr)
        return EXIT_REFUSED
    if args.command == "restore":
        return restore_original(fly, args.app, args.machine_id, args.original_config.resolve())
    return capture_destroy(fly, store, app=args.app, machine_id=args.machine_id, volume_id=args.volume_id,
                           run_token=args.run_token, receipt_dir=args.receipt_dir.resolve(), attempts=args.attempts,
                           ssh_seconds=args.ssh_seconds, wait_seconds=args.wait_seconds,
                           capture_only=args.capture_only, capture_seconds=args.capture_seconds,
                           extra_protected=frozenset(m for m in args.protected_machine if m))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
