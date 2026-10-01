#!/usr/bin/env python3
"""Admit the lifecycle fixture's real provider inventories through snapshot preflight."""

import ipaddress
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / "scripts/tests/cloudbench-multi-workstream.test.sh").read_text()


def shell_function(name: str) -> str:
    match = re.search(rf"^{name}\(\).*?^}}(?=\n\n)", SOURCE, re.MULTILINE | re.DOTALL)
    assert match, f"missing owning fixture function: {name}"
    return match.group(0)


def assert_private_ip_proxies(base: Path) -> None:
    """Bind both tunnels to the primary's actual retained provider index row."""
    calls = [line.split() for line in (base / "journal.log").read_text().splitlines()]
    warm = [
        row["id"]
        for row in json.loads((base / "state.json").read_text())["machines"]
        if row["name"] == "cloudbench-warm"
    ]
    assert len(warm) == 1, "missing or ambiguous warm provider identity"
    primaries = set()
    for call in calls:
        if call[:3] == ["machine", "clone", warm[0]]:
            name = call[call.index("--name") + 1]
            primaries.add((base / "markers" / name).read_text().strip())
    assert len(primaries) == 1, "missing or ambiguous scenario primary identity"
    primary = next(iter(primaries))
    addresses: dict[ipaddress.IPv6Address, list[str]] = {}
    for path in (base / "machines").glob("*/provider-machine.json"):
        row = json.loads(path.read_text())
        assert row["id"] == path.parent.name, "provider row identity mismatch"
        address = ipaddress.IPv6Address(row["private_ip"])
        addresses.setdefault(address, []).append(row["id"])
    targets: dict[str, set[ipaddress.IPv6Address]] = {"8011": set(), "3003": set()}
    for call in calls:
        if call[:1] != ["proxy"]:
            continue
        remote_port = call[1].rsplit(":", 1)[-1]
        if remote_port in targets:
            address = ipaddress.IPv6Address(call[2])
            assert addresses.get(address) == [primary], (
                "tunnel must select only the indexed scenario primary"
            )
            targets[remote_port].add(address)
    assert all(len(values) == 1 for values in targets.values()), (
        "both status and mandatory-autoscaler tunnels must target the indexed private IP"
    )


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="cloudbench-volume-contract-") as temporary:
        base = Path(temporary)
        (base / "markers").mkdir()
        fake_source = SOURCE.split("cat > \"$FAKE_DIR/flyctl.py\" <<'PY'\n", 1)[
            1
        ].split("\nPY\n", 1)[0]
        fake = base / "flyctl.py"
        fake.write_text(fake_source)
        fly = base / "flyctl"
        fly.write_text(f'#!/bin/sh\nexec {sys.executable!r} {str(fake)!r} "$@"\n')
        fly.chmod(0o700)
        env = {
            **os.environ,
            "FAKE_DIR": str(base),
            "CLOUDBENCH_FAKE_DIR": str(base),
            "CLOUDBENCH_TEST_BARRIER_MIN": "1",
        }
        subprocess.run(
            ["bash", "-c", shell_function("reset_fake_state") + "\nreset_fake_state"],
            env=env,
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
        app = re.search(r'^BENCH_APP = "([^"]+)"', fake_source, re.MULTILINE).group(1)

        def clone(source: str, name: str, *, identity: str | None = None) -> str:
            command = [
                str(fly),
                "machine",
                "clone",
                source,
                "--name",
                name,
                "-a",
                app,
                "--json",
            ]
            if identity is not None:
                # Execute the actual provider with distinct machine UUIDs that
                # share the historical four-digit address prefix. The second
                # UUID supplies a distinct volume identity, as a real clone does.
                command = [
                    sys.executable,
                    "-c",
                    "import runpy,sys,uuid; "
                    f"machine=uuid.UUID({identity!r}); "
                    "identities=iter((machine,uuid.UUID(int=machine.int^(1<<127)))); "
                    "uuid.uuid4=lambda:next(identities); "
                    "sys.argv=sys.argv[1:]; runpy.run_path(sys.argv[0],run_name='__main__')",
                    str(fake),
                    *command[1:],
                ]
            subprocess.run(
                command,
                env=env,
                check=True,
                capture_output=True,
                text=True,
                timeout=15,
            )
            machine_id = (base / "markers" / name).read_text()
            state = json.loads((base / "state.json").read_text())
            assert any(
                row["id"] == machine_id and row["name"] == name
                for row in state["machines"]
            )
            return machine_id

        def preflight(machine_id: str, *, accepted: bool = True) -> None:
            pool = base / "pool.ids"
            pool.write_text(machine_id + "\n")
            state_path = base / "state.json"
            before = json.loads(state_path.read_text())
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/cloudbench-worker-snapshot.py"),
                    "--pool-ids",
                    str(pool),
                    "--cache",
                    str(base / "snapshot.json"),
                    "--app",
                    app,
                    "--fly",
                    str(fly),
                    "--warm-volume-id",
                    "vol_aaaa0001",
                    "--warm-snapshot-id",
                    "snap_0001",
                    "--ready-attempts",
                    "1",
                    "--poll-seconds",
                    "0",
                ],
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
            )
            assert json.loads(state_path.read_text()) == before, (
                "inventory preflight mutated provider state"
            )
            if accepted:
                assert (
                    result.returncode == 0 and result.stdout.strip() == "40 snap_0001"
                ), (
                    "valid lifecycle fixture rejected before claiming its Machine",
                    result.stderr.strip(),
                )
            else:
                assert (
                    result.returncode != 0
                    and "pooled volume size is missing or inconsistent" in result.stderr
                )

        preflight("aaaa0000000001")
        first = clone("aaaa0000000001", "cloudbench-volume-contract-primary")
        preflight(first)
        preflight(clone(first, "cloudbench-volume-contract-worker"))
        left = clone(
            "aaaa0000000001",
            "cloudbench-address-contract-left",
            identity="f5319f05-e70a-4500-8000-000000000001",
        )
        right = clone(
            "aaaa0000000001",
            "cloudbench-address-contract-right",
            identity="f5311cec-e893-4200-8000-000000000002",
        )
        machines = json.loads((base / "state.json").read_text())["machines"]
        addresses = {
            row["id"]: ipaddress.IPv6Address(row["private_ip"])
            for row in machines
            if row["id"] in {left, right}
        }
        assert left != right and left[:4] == right[:4]
        assert addresses[left] != addresses[right], (
            "distinct fake machines share a private address and misroute their status proxies"
        )
        for machine_id in (left, right):
            matches = [
                row
                for row in machines
                if row.get("private_ip")
                and ipaddress.IPv6Address(row["private_ip"]) == addresses[machine_id]
            ]
            assert len(matches) == 1 and matches[0]["id"] == machine_id, (
                "the proxy private-address selector must resolve the intended machine"
            )

        # Execute the owning scenario's assertions verbatim, including on the
        # baseline where a valid full-identity IPv6 address fails the old grep.
        assertion_block = (
            SOURCE.split("private_ip_status=0", 1)[1]
            .split("\n}\n", 1)[1]
            .split("\ngrep -Eq '^machine start", 1)[0]
        )
        primary_call = next(
            line
            for line in (base / "journal.log").read_text().splitlines()
            if line.startswith("machine clone aaaa0000000001 ")
            and "--name cloudbench-address-contract-left " in line
        )

        def proxy_assertions(target: str, *, accepted: bool) -> None:
            (base / "journal.log").write_text(
                primary_call
                + "\n"
                + f"machine start {left}\n"
                + f"machine start {right}\n"
                + f"proxy 12345:8011 {target} -a {app}\n"
                + f"proxy 12346:3003 {target} -a {app}\n"
            )
            result = subprocess.run(
                ["bash", "-c", 'fail() { echo "$*" >&2; exit 1; }\n' + assertion_block],
                env={**env, "ROOT_DIR": str(ROOT)},
                capture_output=True,
                text=True,
                timeout=15,
            )
            assert (result.returncode == 0) == accepted, (
                "scenario 2a must accept its primary's actual provider IPv6 row "
                "and reject hostname, unknown, foreign or ambiguous addresses",
                result.stderr.strip(),
            )

        proxy_assertions(str(addresses[left]), accepted=True)
        for target in (left + ".vm.internal", "fdaa::dead", str(addresses[right])):
            proxy_assertions(target, accepted=False)
        right_row = base / "machines" / right / "provider-machine.json"
        original_row = right_row.read_bytes()
        ambiguous = json.loads(original_row)
        ambiguous["private_ip"] = str(addresses[left])
        right_row.write_text(json.dumps(ambiguous))
        proxy_assertions(str(addresses[left]), accepted=False)
        right_row.write_bytes(original_row)
        proxy_assertions(str(addresses[left]), accepted=True)
        subprocess.run(
            [
                "bash",
                "-c",
                shell_function("add_fake_machine")
                + "\nadd_fake_machine aaaa0000000002 cloudbench-volume-contract-added stopped 0",
            ],
            env=env,
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
        preflight("aaaa0000000002")

        state_path = base / "state.json"
        original = json.loads(state_path.read_text())
        for mutation in (
            "missing-volume-size",
            "missing-mount-size",
            "mismatched-size",
        ):
            state = json.loads(json.dumps(original))
            machine = next(row for row in state["machines"] if row["id"] == first)
            mount = machine["config"]["mounts"][0]
            volume = next(
                row for row in state["volumes"] if row["id"] == mount["volume"]
            )
            if mutation == "missing-volume-size":
                volume.pop("size_gb", None)
            elif mutation == "missing-mount-size":
                mount.pop("size_gb", None)
            else:
                volume["size_gb"] = 41
            state_path.write_text(json.dumps(state))
            preflight(first, accepted=False)
        print(
            "PASS: all lifecycle fixture volume writers pass real snapshot admission; malformed sizes fail closed"
        )


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--assert-private-ip-proxies":
        assert_private_ip_proxies(Path(sys.argv[2]))
    else:
        main()
