#!/usr/bin/env python3
"""Create a clone's Volume before its Machine so the controller owns the exact ID.

Pinned flyctl v0.4.115 `machine clone` (internal/command/machine/clone.go)
calls CreateVolume with the source mount and then Launch; it prints no Volume
ID, so a rejected launch left an unattributable Volume. This helper sends the
same CreateVolumeRequest (fly-go v0.11.3 volume_types.go) itself and returns a
one-line JSON receipt. The caller records the exact ID before attaching it.

Outcomes: created (exact id), rejected (complete 4xx response: no Volume),
ambiguous (sent but no complete success/4xx response) and refused (nothing was
sent). `find` lists Volumes once and returns exact-name matches for reconciling
an ambiguous create of a unique per-clone name. Credentials are never printed.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_BYTES = 8 * 1024 * 1024
VOLUME_ID = re.compile(r"vol_[A-Za-z0-9]+")
VOLUME_NAME = re.compile(r"[a-z0-9_]{1,30}")
PRESETS = {"shared-cpu": (1, 2, 4, 8), "performance": (1, 2, 4, 8, 16)}


class Refusal(Exception):
    pass


def emit(outcome: str, **fields) -> int:
    print(json.dumps(dict(outcome=outcome, **fields), sort_keys=True, separators=(",", ":")), flush=True)
    return 0


def machines_helper():
    path = Path(__file__).with_name("cloudbench-campaign-machines.py")
    spec = importlib.util.spec_from_file_location("cloudbench_campaign_machines", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def endpoint(app: str, suffix: str = "") -> str:
    base = os.environ.get("FLY_FLAPS_BASE_URL", "https://api.machines.dev").rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    loopback = parsed.hostname in ("127.0.0.1", "localhost", "::1")
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise Refusal("invalid selected Machines endpoint")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
        raise Refusal("Machines endpoint must use HTTPS")
    return base + "/v1/apps/" + urllib.parse.quote(app, safe="") + "/volumes" + suffix


def guest_for(source_guest: object, vm_size: str, vm_memory: str) -> dict:
    """flag.GetMachineGuest(source guest) with --vm-size and --vm-memory."""
    if source_guest is None:
        source_guest = {}  # flyctl starts from a default guest, then applies --vm-size.
    if not isinstance(source_guest, dict):
        raise Refusal("invalid source guest")
    match = re.fullmatch(r"(shared-cpu|performance)-([0-9]+)x", vm_size)
    if match is None or int(match.group(2)) not in PRESETS[match.group(1)]:
        raise Refusal("unsupported VM size")
    if re.fullmatch(r"[1-9][0-9]*", vm_memory) is None:
        raise Refusal("invalid VM memory")
    guest = {key: value for key, value in source_guest.items() if key not in ("gpus", "gpu_kind")}
    guest["cpu_kind"] = "shared" if match.group(1) == "shared-cpu" else "performance"
    guest["cpus"] = int(match.group(2))
    guest["memory_mb"] = int(vm_memory)
    return guest


def full_image_ref(machine: dict) -> str:
    ref = machine.get("image_ref") or {}
    if not isinstance(ref, dict):
        raise Refusal("invalid source image reference")
    image = "%s/%s" % (ref.get("registry") or "", ref.get("repository") or "")
    tag, digest = ref.get("tag") or "", ref.get("digest") or ""
    if tag and digest:
        return "%s:%s@%s" % (image, tag, digest)
    if digest:
        return image + "@" + digest
    return image + ":" + tag if tag else image


def build_request(args: argparse.Namespace) -> dict:
    machines = json.loads(Path(args.inventory).read_text())
    if not isinstance(machines, list):
        raise Refusal("invalid source inventory")
    sources = [m for m in machines if isinstance(m, dict) and m.get("id") == args.source]
    if len(sources) != 1:
        raise Refusal("source Machine absent from inventory")
    config = sources[0].get("config")
    mounts = config.get("mounts") if isinstance(config, dict) else None
    if not isinstance(mounts, list) or len(mounts) != 1 or not isinstance(mounts[0], dict):
        raise Refusal("source must have exactly one mount")
    mount = mounts[0]
    size, encrypted = mount.get("size_gb"), mount.get("encrypted", False)
    if type(size) is not int or size < 1 or type(encrypted) is not bool:
        raise Refusal("invalid source mount")
    # flyctl sends the source mount name verbatim (empty when absent).
    name = args.name if args.name is not None else mount.get("name", "")
    if not isinstance(name, str) or (name or args.name is not None) and VOLUME_NAME.fullmatch(name) is None:
        raise Refusal("invalid Volume name")
    return {
        "name": name,
        "region": args.region,
        "size_gb": size,
        "encrypted": encrypted,
        "require_unique_zone": args.require_unique_zone == "true",
        "unique_zone_app_wide": None,
        "snapshot_retention": None,
        "auto_backup_enabled": None,
        "fstype": None,
        "snapshot_id": args.snapshot_id,
        "source_volume_id": None,
        "compute": guest_for(config.get("guest"), args.vm_size, args.vm_memory),
        "compute_image": full_image_ref(sources[0]),
    }


def provider_message(raw: bytes) -> str:
    try:
        value = json.loads(raw.decode("utf-8", "replace"))
        text = value.get("error") if isinstance(value, dict) else None
    except ValueError:
        text = None
    text = text if isinstance(text, str) else raw.decode("utf-8", "replace")
    return " ".join(text.split())[:200]


def send(request: urllib.request.Request, deadline: float):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), machines_helper().NoRedirect())
    with opener.open(request, timeout=max(0.001, deadline - time.monotonic())) as response:
        raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise OSError("oversized response")
        return response.status, raw


def create(args: argparse.Namespace) -> int:
    deadline = time.monotonic() + args.timeout
    try:
        body = build_request(args)
        url = endpoint(args.app)
        header = machines_helper().authorization(os.environ.get("FLY_API_TOKEN", ""), deadline)
    except Exception as error:  # Nothing was sent.
        return emit("refused", reason=type(error).__name__ + ": " + str(error)[:200])
    request = urllib.request.Request(url, data=json.dumps(body, separators=(",", ":")).encode(), method="POST",
                                     headers={"Authorization": header, "Content-Type": "application/json",
                                              "Accept": "application/json"})
    try:
        status, raw = send(request, deadline)
    except urllib.error.HTTPError as error:
        try:
            raw = error.read(4096)
        except Exception as read_error:  # Incomplete error response: never a non-allocation proof.
            return emit("ambiguous", reason="HTTP %d: %s" % (error.code, type(read_error).__name__))
        if 400 <= error.code < 500:
            return emit("rejected", status=error.code, message=provider_message(raw))
        return emit("ambiguous", reason="HTTP %d: %s" % (error.code, provider_message(raw)))
    except Exception as error:  # Sent or possibly sent: never a non-allocation proof.
        return emit("ambiguous", reason=type(error).__name__)
    try:
        volume = json.loads(raw)
        volume_id = volume.get("id")
    except (ValueError, AttributeError):
        volume_id = None
    # 202 Accepted is how Fly answers a create that restores a large snapshot
    # (the volume is "restoring"); it is a created volume once its body verifies.
    if (status not in (200, 201, 202) or not isinstance(volume_id, str) or VOLUME_ID.fullmatch(volume_id) is None
            or volume.get("name") != body["name"] or volume.get("region") != body["region"]):
        return emit("ambiguous", reason="unverified create response status=%s" % status)
    return emit("created", id=volume_id, name=body["name"], region=body["region"])


def find(args: argparse.Namespace) -> int:
    deadline = time.monotonic() + args.timeout
    try:
        if VOLUME_NAME.fullmatch(args.name) is None:
            raise Refusal("invalid Volume name")
        header = machines_helper().authorization(os.environ.get("FLY_API_TOKEN", ""), deadline)
        status, raw = send(urllib.request.Request(endpoint(args.app), headers={
            "Authorization": header, "Accept": "application/json"}), deadline)
        volumes = json.loads(raw)
        if status != 200 or not isinstance(volumes, list) or any(not isinstance(v, dict) for v in volumes):
            raise Refusal("invalid Volume inventory")
    except Exception as error:
        return emit("unknown", reason=type(error).__name__)
    ids = sorted(v.get("id") for v in volumes if v.get("name") == args.name)
    if any(not isinstance(i, str) or VOLUME_ID.fullmatch(i) is None for i in ids):
        return emit("unknown", reason="invalid matching Volume identity")
    return emit("found", ids=ids)


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="action", required=True)
    one = sub.add_parser("create")
    one.add_argument("--app", required=True)
    one.add_argument("--source", required=True)
    one.add_argument("--inventory", required=True)
    one.add_argument("--region", required=True)
    one.add_argument("--name")
    one.add_argument("--vm-size", required=True)
    one.add_argument("--vm-memory", required=True)
    one.add_argument("--require-unique-zone", choices=("true", "false"), required=True)
    one.add_argument("--snapshot-id")
    one.add_argument("--timeout", type=float, required=True)
    two = sub.add_parser("find")
    two.add_argument("--app", required=True)
    two.add_argument("--name", required=True)
    two.add_argument("--timeout", type=float, required=True)
    args = parser.parse_args()
    if args.timeout <= 0:
        return emit("refused", reason="invalid timeout")
    return create(args) if args.action == "create" else find(args)


if __name__ == "__main__":
    sys.exit(main())
