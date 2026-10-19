#!/usr/bin/env python3
"""Check whether a Fly Machine's configured volumes are mountable."""

from __future__ import annotations

import json
import fcntl
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


MOUNTABLE_VOLUME_STATES = {"created"}
TERMINAL_FAILED_VOLUME_STATES = {"failed"}
SAFE_INDEX_KEY = re.compile(r"[A-Za-z0-9._-]+")


def _load_payload(argv: list[str]) -> dict[str, Any]:
    if len(argv) == 4:
        return {
            "machines": json.loads(Path(argv[2]).read_text()),
            "volumes": json.loads(Path(argv[3]).read_text()),
        }
    return json.load(sys.stdin)


def readiness(payload: dict[str, Any], machine_id: str) -> tuple[bool, str]:
    machines = payload.get("machines") or []
    volumes = payload.get("volumes") or []
    machine = next(
        (item for item in machines if item.get("id") == machine_id),
        None,
    )
    if machine is None:
        return False, "waiting:machine=missing"

    mounts = (machine.get("config") or {}).get("mounts") or []
    volume_ids = [mount.get("volume") for mount in mounts if mount.get("volume")]
    if not volume_ids:
        return True, "ready"

    states = {item.get("id"): item.get("state") for item in volumes}
    waiting = [
        f"{volume_id}={states.get(volume_id) or 'missing'}"
        for volume_id in volume_ids
        if states.get(volume_id) not in MOUNTABLE_VOLUME_STATES
    ]
    if waiting:
        return False, f"waiting:{','.join(waiting)}"
    return True, "ready"


def startup_command_overridable(config: Any) -> bool:
    """Whether replacing ``init.cmd`` alone fully controls guest startup.

    Fly runs ``init.exec`` or ``init.entrypoint`` in preference to ``init.cmd``,
    so an inert ``sleep infinity`` command is only authoritative when neither is
    inherited. Clone admission and original-volume capture share this predicate.
    """
    init = startup_init(config)
    return init is not None and not init.get("exec") and not init.get("entrypoint")


def startup_init(config: Any) -> dict[str, Any] | None:
    """The Machine's ``init`` mapping, ``{}`` when absent, or None when unusable."""
    if not isinstance(config, dict):
        return None
    init = config.get("init") or {}
    return init if isinstance(init, dict) else None


def startup_command_inert(config: Any) -> bool:
    """Whether the overridable startup command is the inert ``sleep infinity``."""
    init = startup_init(config)
    return startup_command_overridable(config) and init is not None and init.get("cmd") == ["sleep", "infinity"]


def _load_inventory_file(path: Path, label: str) -> list[dict[str, Any]]:
    value = json.loads(path.read_text())
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ValueError(f"{label} inventory must be a list of objects")
    return value


def _safe_index_value(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SAFE_INDEX_KEY.fullmatch(value):
        raise ValueError(f"unsafe {label} for inventory index: {value!r}")
    return value


def _lock_token(handle: Any) -> str:
    handle.seek(0)
    values = {}
    for line in handle:
        key, separator, value = line.rstrip("\n").partition("=")
        if separator:
            values[key] = value
    return values.get("token", "")


def _publication_fence() -> tuple[Any | None, str]:
    lock_value = os.environ.get("CLOUDBENCH_INVENTORY_REFRESH_LOCK", "")
    token = os.environ.get("CLOUDBENCH_INVENTORY_REFRESH_LOCK_TOKEN", "")
    if not lock_value and not token:
        return None, ""
    if not lock_value or not token:
        raise ValueError("inventory publication fence is incomplete")
    handle = Path(lock_value).open("r")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        if _lock_token(handle) != token:
            raise ValueError("inventory publication fence ownership changed")
    except Exception:
        handle.close()
        raise
    return handle, token


def _current_generation_name(root: Path) -> str | None:
    current = root / "current"
    if not current.is_symlink():
        return None
    target = os.readlink(current)
    if not re.fullmatch(r"[.]generation-[A-Za-z0-9._-]+", target):
        raise ValueError(f"unsafe inventory current target: {target!r}")
    return target


def recover_lock(path: Path) -> int:
    """Atomically invalidate and unlink one unlocked refresh-lock inode.

    Returns 0 when recovered/absent, 1 while a publisher holds the inode, and
    2 when the pathname changed underneath this recovery attempt.
    """
    try:
        handle = path.open("r+")
    except FileNotFoundError:
        return 0
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 1
        inode = os.fstat(handle.fileno()).st_ino
        try:
            if path.stat().st_ino != inode:
                return 2
        except FileNotFoundError:
            return 0

        handle.seek(0)
        lines = handle.readlines()
        invalid_token = f"invalidated.{os.getpid()}.{time.time_ns()}"
        replaced = False
        for index, line in enumerate(lines):
            if line.startswith("token="):
                lines[index] = f"token={invalid_token}\n"
                replaced = True
        if not replaced:
            lines.append(f"token={invalid_token}\n")
        handle.seek(0)
        handle.writelines(lines)
        handle.truncate()
        handle.flush()
        os.fsync(handle.fileno())

        try:
            if path.stat().st_ino != inode:
                return 2
        except FileNotFoundError:
            return 0
        path.unlink()
        return 0
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        handle.close()


def publish_index(machines_path: Path, volumes_path: Path, root: Path) -> None:
    machines = _load_inventory_file(machines_path, "machine")
    volumes = _load_inventory_file(volumes_path, "volume")
    # Pre-index volume state once. Calling readiness() per machine rescanned the
    # complete Machines and Volumes arrays N times, turning each five-second
    # fleet publication into O(N²) work at app width.
    volume_states = {item.get("id"): item.get("state") for item in volumes}
    root.mkdir(parents=True, exist_ok=True)
    fence, fence_token = _publication_fence()
    generation: Path | None = None
    next_link: Path | None = None
    swap_committed = False
    try:
        current_before_name = _current_generation_name(root)
        # With the publication fence held, no live publisher can own any
        # non-current generation. Keep only the symlink-proven current_before;
        # early marker files are not proof that a killed publisher ever swapped
        # current, so every other generation is crash debris.
        for candidate in root.glob(".generation-*"):
            if candidate.name != current_before_name:
                shutil.rmtree(candidate, ignore_errors=True)

        generation = Path(tempfile.mkdtemp(prefix=".generation-", dir=root))
        machine_dir = generation / "machines"
        name_dir = generation / "names"
        machine_dir.mkdir()
        name_dir.mkdir()
        # Keep native originals private and exact; admission consumers need no
        # inline boot files or environment payload. Publish with this generation.
        admission_machines = []
        for machine in machines:
            config = machine.get("config")
            if config is not None and not isinstance(config, dict):
                raise ValueError("invalid admission machine config")
            guest = (config or {}).get("guest")
            if guest is not None and not isinstance(guest, dict):
                raise ValueError("invalid admission machine guest")
            projected = dict(machine)
            if config is not None:
                projected["config"] = {key: value for key, value in config.items()
                                       if key not in {"files", "env"}}
            admission_machines.append(projected)
        (generation / "admission-machines.json").write_text(
            json.dumps(admission_machines, separators=(",", ":")) + "\n"
        )
        for machine in machines:
            machine_id = _safe_index_value(machine.get("id"), "machine id")
            state = _safe_index_value(machine.get("state"), "machine state")
            instance_id = machine.get("instance_id") or ""
            if instance_id:
                instance_id = _safe_index_value(instance_id, "machine instance")
            private_ip = machine.get("private_ip") or ""
            if not isinstance(private_ip, str) or "\n" in private_ip:
                raise ValueError(f"unsafe private IP for {machine_id}")
            config = machine.get("config")
            mounts = (config.get("mounts") if isinstance(config, dict) else None) or []
            volume_ids = [mount.get("volume") for mount in mounts if mount.get("volume")]
            storage_ready = all(
                volume_states.get(volume_id) in MOUNTABLE_VOLUME_STATES
                for volume_id in volume_ids
            )
            storage_failed = any(
                volume_states.get(volume_id) in TERMINAL_FAILED_VOLUME_STATES
                for volume_id in volume_ids
            )
            clone_cmd_overridable = startup_command_overridable(config)
            (machine_dir / machine_id).write_text(
                f"state={state}\n"
                f"instance_id={instance_id}\n"
                f"private_ip={private_ip}\n"
                f"clone_cmd_overridable={int(clone_cmd_overridable)}\n"
                f"clone_cmd_inert={int(startup_command_inert(config))}\n"
                f"storage_ready={int(storage_ready)}\n"
                f"storage_failed={int(storage_failed)}\n"
            )
            name = machine.get("name")
            if name is not None:
                safe_name = _safe_index_value(name, "machine name")
                name_path = name_dir / safe_name
                if name_path.exists():
                    raise ValueError(f"duplicate machine name in inventory: {safe_name}")
                name_path.write_text(f"{machine_id}\n")

        # Consumers use this successful provider-publication timestamp together
        # with the exact loop process identity. A live-but-wedged or dead
        # publisher can therefore never serve positive state indefinitely.
        published_at = int(time.time())
        max_age = int(os.environ.get("CLOUDBENCH_INVENTORY_MAX_STALE_SECONDS", "300"))
        if max_age <= 0:
            raise ValueError("inventory max stale seconds must be positive")
        publisher_token = os.environ.get(
            "CLOUDBENCH_INVENTORY_PUBLISHER_TOKEN", "standalone"
        )
        _safe_index_value(publisher_token, "publisher token")
        (generation / "published_at").write_text(f"{published_at}\n")
        (generation / "health").write_text(
            f"publisher_token={publisher_token}\n"
            f"valid_until={published_at + max_age}\n"
            f"generation={generation.name}\n"
        )

        if fence is not None and _lock_token(fence) != fence_token:
            raise ValueError("inventory publication fence ownership changed")

        next_link = root / f".current-{os.getpid()}-{time.time_ns()}"
        next_link.symlink_to(generation.name)
        os.replace(next_link, root / "current")
        swap_committed = True

        # Keep exactly the new current plus the symlink-proven old current for
        # open-path races. Never infer predecessor status from marker mtimes.
        keep_names = {generation.name}
        if current_before_name is not None:
            keep_names.add(current_before_name)
        for candidate in root.glob(".generation-*"):
            if candidate.name not in keep_names:
                shutil.rmtree(candidate, ignore_errors=True)
    except Exception:
        if next_link is not None:
            try:
                next_link.unlink()
            except FileNotFoundError:
                pass
        if generation is not None and not swap_committed:
            shutil.rmtree(generation, ignore_errors=True)
        raise
    finally:
        if fence is not None:
            fcntl.flock(fence.fileno(), fcntl.LOCK_UN)
            fence.close()

def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "--recover-lock":
        try:
            return recover_lock(Path(argv[2]))
        except OSError as exc:
            print(f"inventory lock recovery failed: {exc}", file=sys.stderr)
            return 3
    if len(argv) == 5 and argv[1] == "--publish-index":
        try:
            publish_index(Path(argv[2]), Path(argv[3]), Path(argv[4]))
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"invalid Fly inventory index: {exc}", file=sys.stderr)
            return 2
        return 0
    if len(argv) not in {2, 4}:
        print(
            "usage: cloudbench-machine-readiness.py MACHINE_ID "
            "[MACHINES_JSON_PATH VOLUMES_JSON_PATH]",
            file=sys.stderr,
        )
        return 2
    try:
        payload = _load_payload(argv)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"invalid Fly lifecycle payload: {exc}", file=sys.stderr)
        return 2
    ready, detail = readiness(payload, argv[1])
    print(detail)
    return 0 if ready else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
