#!/usr/bin/env python3
"""Claim durable, non-overlapping local port ranges for deploy worktrees."""

from __future__ import annotations

import argparse
from contextlib import ExitStack
import fcntl
import json
import os
from pathlib import Path
import socket
import sys
import tempfile


PORTS_PER_WORKTREE = 10
MAX_PORT = 65_535
# Ports a prepared worktree actually listens on relative to its base: the ten
# owned stack ports, run.sh's +20 collision rescan step, the coverage shards at
# +20+2i (back-end/scripts/run-coverage-sharded.sh), the blackbox backend at
# +100 (back-end/scripts/run-blackbox-tests.sh) and the cloud benchmark fleet's
# central hub, preferred at +5764 and searched up to 500 ports further
# (scripts/run-bench-fleet DASH_BASE, cloudbench_select_central_hub_port).
# Kernel autobind must not be able to reach any of them, and the whole
# footprint must exist below 65535: base 61000 put the hub at 66764 and the
# cloud smoke lane refused to start (2026-10-29).
HUB_PORT_OFFSET = 5_764
HUB_PORT_SEARCH = 500
# The exact ports a worktree listens on, relative to its base: the owned stack
# block, run.sh's +20 rescan step with the coverage shards at +20+2i, the
# blackbox backend at +100, an isolated local benchmark stack at +200..+209
# (agents/benchmarks/local.py PORT_RANGE_OFFSETS) and the hub search window.
# Reservations and the kernel window are judged against these, never against
# the unused gap up to the hub.
LISTENER_OFFSETS = (
    *range(0, PORTS_PER_WORKTREE),
    *range(20, 30),
    100,
    *range(200, 210),
    *range(HUB_PORT_OFFSET, HUB_PORT_OFFSET + HUB_PORT_SEARCH + 1),
)
FOOTPRINT_PORTS = HUB_PORT_OFFSET + HUB_PORT_SEARCH + 1  # span, for the 65535 bound
FIRST_BASE_PORT = 20_000
LAST_BASE_PORT = MAX_PORT - FOOTPRINT_PORTS + 1
# Linux publishes the range the kernel autobinds outbound connections from.
# Tests point ROSE_DEPLOY_PROC_SYS_NET_IPV4 at a fixture directory; production
# reads the live kernel tree.
PROC_SYS_NET_IPV4_ENV = "ROSE_DEPLOY_PROC_SYS_NET_IPV4"
LINUX_PROC_SYS_NET_IPV4 = Path("/proc/sys/net/ipv4")


def _record(path: Path) -> dict[str, object] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _parse_port_list(text: str) -> set[int]:
    """Parse the kernel's ``ip_local_reserved_ports`` syntax (``a,b-c``)."""
    ports: set[int] = set()
    for item in text.replace("\n", ",").split(","):
        item = item.strip()
        if not item:
            continue
        low, _, high = item.partition("-")
        try:
            start = int(low)
            end = int(high) if high else start
        except ValueError:
            continue
        ports.update(range(start, end + 1))
    return ports


def _kernel_autobind_ports() -> tuple[int, int, set[int]] | None:
    """Return (low, high, reserved) for ports the kernel may hand to clients.

    A deploy worktree's listen ports must not lie in this window: any outbound
    connection on the host can take one of them as its source port, and a later
    ``listen()`` fails with EADDRINUSE even though no listener exists
    (2026-10-28: coverage shard 1 lost 56022 that way). Platforms without this
    sysctl tree (macOS) return None: no exclusion can be derived there. On
    Linux, or whenever a fixture tree is configured, a missing tree or an
    unreadable or malformed range fails closed rather than silently handing
    out stealable ports.
    """
    override = os.environ.get(PROC_SYS_NET_IPV4_ENV)
    if override is None and not sys.platform.startswith("linux"):
        return None
    tree = Path(override) if override else LINUX_PROC_SYS_NET_IPV4
    range_path = tree / "ip_local_port_range"
    if not tree.is_dir():
        raise RuntimeError(
            f"{tree} is missing, so the kernel ephemeral port range ({range_path}) cannot "
            "be read; refusing to allocate deploy-worktree ports blind"
        )
    try:
        low_text, high_text = range_path.read_text(encoding="utf-8").split()
        low, high = int(low_text), int(high_text)
        if not 0 < low <= high <= 65_535:
            raise ValueError(f"{low} {high}")
    except (OSError, ValueError) as exc:
        raise RuntimeError(
            f"cannot read the kernel ephemeral port range from {range_path} ({exc}); "
            "refusing to allocate deploy-worktree ports blind"
        ) from exc
    try:
        reserved_text = (tree / "ip_local_reserved_ports").read_text(encoding="utf-8")
    except OSError:
        reserved_text = ""
    return low, high, _parse_port_list(reserved_text)


def _listener_ports(base_port: int) -> list[int]:
    return [base_port + offset for offset in LISTENER_OFFSETS]


def _footprint_reserved(base_port: int, window: tuple[int, int, set[int]]) -> bool:
    low, high, reserved = window
    return all(port < low or port > high or port in reserved for port in _listener_ports(base_port))


def _footprint_fits(base_port: int) -> bool:
    return base_port + FOOTPRINT_PORTS - 1 <= MAX_PORT


def _footprint_outside(base_port: int, window: tuple[int, int, set[int]]) -> bool:
    """Every listener port lies below or above the kernel window."""
    low, high, _ = window
    return all(port < low or port > high for port in _listener_ports(base_port))


def _reserve_remedy(first: int, last: int) -> str:
    return (
        f"sudo sysctl -w net.ipv4.ip_local_reserved_ports={first}-{last} "
        "(merge any existing value; persist it in /etc/sysctl.d to survive reboots)"
    )


def _ephemeral_conflict(base_port: int) -> str | None:
    """Why an already-recorded ``base_port`` is exposed on this kernel, or None.

    A recorded claim is safe when its whole footprint sits above the kernel
    window, or when the host reserved every footprint port. New claims never
    rely on a reservation (see ``Registry.claim``): it is host-local state that
    does not survive a reboot.
    """
    last = base_port + FOOTPRINT_PORTS - 1
    if not _footprint_fits(base_port):
        return (
            f"deploy-worktree ports {base_port}-{last} (owned ports, the +20/+22/+24 coverage shards, "
            f"the +100 blackbox backend and the +{HUB_PORT_OFFSET}..+{HUB_PORT_OFFSET + HUB_PORT_SEARCH} "
            f"benchmark hub) do not fit below {MAX_PORT}: the cloud smoke lane's central hub could not "
            "bind. Retire this worktree and prepare it again so it claims a range that fits."
        )
    window = _kernel_autobind_ports()
    if window is None or _footprint_outside(base_port, window) or _footprint_reserved(base_port, window):
        return None
    low, high, _ = window
    return (
        f"deploy-worktree ports {base_port}-{last} (owned ports, the +20/+22/+24 coverage "
        f"shards, the +100 blackbox backend and the +{HUB_PORT_OFFSET}..+{HUB_PORT_OFFSET + HUB_PORT_SEARCH} "
        f"benchmark hub) lie inside the kernel ephemeral port range {low}-{high} and "
        "are not all reserved: any outbound connection on this host can take one of them "
        "as its source port, after which listen() fails with EADDRINUSE although nothing "
        f"is listening. Reserve them with {_reserve_remedy(base_port, last)}, or retire "
        "this worktree and prepare it again so it claims a range outside that window."
    )


def _range_is_bindable(base_port: int) -> bool:
    sockets: list[socket.socket] = []
    try:
        for port in range(base_port, base_port + PORTS_PER_WORKTREE):
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sockets.append(sock)
            sock.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        for sock in sockets:
            sock.close()


def _foreign_claims(registries: tuple[Path, ...], owner: Path) -> set[int]:
    """Live base ports another owner holds in a registry this one must respect.

    Live claims in earlier (TMPDIR-scoped) registries reserve their ranges,
    because their stacks may not be listening when this claim runs.
    """
    ports: set[int] = set()
    for registry in registries:
        for path in registry.glob("*.json") if registry.is_dir() else ():
            value = _record(path)
            if value is None:
                continue
            claimant = Path(str(value.get("owner", "")))
            if str(claimant) == str(owner) or not claimant.is_dir():
                continue
            try:
                ports.add(int(value["base_port"]))
            except (KeyError, TypeError, ValueError):
                continue
    return ports


def _write_claim(root: Path, payload: dict[str, object]) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=".claim-", suffix=".tmp", dir=root)
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, root / f"{payload['base_port']}.json")
    finally:
        temp.unlink(missing_ok=True)


class Registry:
    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.lock = (root / ".lock").open("a+", encoding="utf-8")

    def __enter__(self) -> "Registry":
        fcntl.flock(self.lock.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, *_: object) -> None:
        fcntl.flock(self.lock.fileno(), fcntl.LOCK_UN)
        self.lock.close()

    def _records(self) -> list[tuple[Path, dict[str, object]]]:
        records: list[tuple[Path, dict[str, object]]] = []
        for path in self.root.glob("*.json"):
            value = _record(path)
            owner = Path(str(value.get("owner", ""))) if value else None
            if value is None or owner is None or not owner.is_dir():
                path.unlink(missing_ok=True)
                continue
            records.append((path, value))
        return records

    def claim(self, owner: Path, respected: tuple[Path, ...] = ()) -> int:
        owner = owner.resolve()
        records = self._records()
        for _, value in records:
            if value.get("owner") == str(owner):
                base_port = int(value["base_port"])
                # Never silently migrate a live identity, and never hand an
                # exposed one back as if it were usable: fail with the remedy.
                conflict = _ephemeral_conflict(base_port)
                if conflict is not None:
                    raise RuntimeError(f"existing claim: {conflict}")
                return base_port

        claimed = {int(value["base_port"]) for _, value in records}
        claimed |= _foreign_claims(respected, owner)
        window = _kernel_autobind_ports()
        candidates = [
            base_port
            for base_port in range(FIRST_BASE_PORT, LAST_BASE_PORT + 1, PORTS_PER_WORKTREE)
            if base_port not in claimed
        ]
        # Only ranges whose whole footprint lies outside the kernel window are
        # eligible for a new claim; a host-only ip_local_reserved_ports entry
        # is not inherited by the next boot. When none exist the claim fails
        # with the exact remedy: handing out a stealable range would only
        # recreate the EADDRINUSE race.
        safe = [base_port for base_port in candidates if window is None or _footprint_outside(base_port, window)]
        if candidates and not safe:
            low, high, _ = window
            raise RuntimeError(
                "no free deploy-worktree range lies outside the kernel ephemeral port range "
                f"{low}-{high} with its whole {FOOTPRINT_PORTS}-port listen footprint (claimable bases "
                f"{FIRST_BASE_PORT}-{LAST_BASE_PORT}); outbound connections would steal its ports and "
                "listen() would fail with EADDRINUSE. New claims never rely on ip_local_reserved_ports "
                "(host-local, lost on reboot). Narrow the kernel window so a footprint fits beside it, "
                "e.g. sudo sysctl -w net.ipv4.ip_local_port_range='32768 60999' (persist it in "
                "/etc/sysctl.d), or retire a deploy worktree whose claim sits outside the window, then claim again."
            )
        for base_port in safe:
            if not _range_is_bindable(base_port):
                continue
            payload = {
                "schema_version": 1,
                "owner": str(owner),
                "base_port": base_port,
            }
            _write_claim(self.root, payload)
            # Mirror the claim into each existing earlier registry so a claimant
            # still running the TMPDIR-scoped protocol observes this range too.
            for legacy in respected:
                if legacy.is_dir():
                    _write_claim(legacy, payload)
            return base_port
        raise RuntimeError("no free ten-port deploy-worktree range is available")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=("claim", "check"),
        help="claim: reserve a base port for --owner; check: exit 1 when --base-port "
        "is exposed to kernel ephemeral autobind (inside ip_local_port_range, unreserved)",
    )
    parser.add_argument("--registry", type=Path)
    parser.add_argument("--owner", type=Path)
    parser.add_argument("--base-port", type=int)
    parser.add_argument(
        "--respect-registry",
        type=Path,
        action="append",
        default=[],
        help="another registry whose live claims also reserve their ranges",
    )
    args = parser.parse_args()

    if args.action == "check":
        if args.base_port is None:
            parser.error("check requires --base-port")
        try:
            conflict = _ephemeral_conflict(args.base_port)
            window = _kernel_autobind_ports()
        except RuntimeError as exc:
            print(f"❌ {exc}", file=sys.stderr)
            return 1
        if conflict is not None:
            print(f"❌ {conflict}", file=sys.stderr)
            return 1
        last = args.base_port + FOOTPRINT_PORTS - 1
        if window is None:
            print(
                f"⚠️  deploy-worktree ports {args.base_port}-{last}: this platform does not "
                "publish ip_local_port_range, so no ephemeral exclusion could be applied; "
                "outbound connections may still take these ports as source ports",
                file=sys.stderr,
            )
        else:
            print(
                f"✅ deploy-worktree ports {args.base_port}-{last} are outside, or reserved "
                f"from, the kernel ephemeral port range {window[0]}-{window[1]}"
            )
        return 0

    if args.registry is None or args.owner is None:
        parser.error("claim requires --registry and --owner")
    if not args.owner.is_dir():
        parser.error(f"owner path is not a directory: {args.owner}")
    # Create every configured earlier registry and dedupe by resolved path, so
    # each .lock is held exactly once and a legacy claimant that starts later
    # still finds this claim mirrored there.
    own = args.registry.resolve()
    resolved: set[Path] = set()
    for path in args.respect_registry:
        path.mkdir(parents=True, exist_ok=True)
        resolved.add(path.resolve())
    respected = tuple(sorted(path for path in resolved if path != own))
    with ExitStack() as stack:
        # Earlier-protocol claimants serialize on their registry's .lock; hold
        # each one (in a fixed order) so neither side claims from a stale view.
        for legacy in respected:
            handle = stack.enter_context((legacy / ".lock").open("a+", encoding="utf-8"))
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        with Registry(args.registry) as registry:
            try:
                print(registry.claim(args.owner, respected))
            except RuntimeError as exc:
                print(f"❌ {exc}", file=sys.stderr)
                return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
