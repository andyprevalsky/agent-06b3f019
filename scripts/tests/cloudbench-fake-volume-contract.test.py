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


def assert_private_cleanup_storage() -> None:
    """Actual launcher/reserve rejects shared foreign floors, isolates fake storage."""
    import ast
    import hashlib
    import select
    import shutil
    import time
    fixture = (ROOT / 'agents/benchmarks/fixtures/cloudbench_cleanup_reserve_cohort.py').read_text()
    constants = [n.value for n in ast.walk(ast.parse(fixture)) if isinstance(n, ast.Constant) and isinstance(n.value, str)]
    site = next(s for s in constants if 'def isolated_parent(' in s)
    df = next(s for s in constants if "free=d['capacity_mb']" in s)
    fleet = (ROOT / 'scripts/run-bench-fleet').read_text()
    reserve = fleet.split('reserve_cleanup_disk_space() {', 1)[1].split('\nrelease_cleanup_disk_reserve() {', 1)[0]
    reserve = 'reserve_cleanup_disk_space() {' + reserve
    start = SOURCE.index('    env -u CLOUDBENCH_SNAPSHOT_ID')
    launch = SOURCE[start:SOURCE.index('\n}', start)]
    launch = launch.rsplit('        "${session_leader[@]}" bash ', 1)[0] + '        bash "$RESERVE_PROBE" > "$log" 2>&1\n'
    prepare = (shell_function('prepare_fixture_storage_transport')
               if 'prepare_fixture_storage_transport() {' in SOURCE else '')
    with tempfile.TemporaryDirectory(prefix='multi-private-storage-') as temporary:
        base = Path(temporary); host = base / 'host'; host.mkdir(); foreign = host / 'foreign'; foreign.mkdir()
        ws = base / 'fixture'; ws.mkdir(); transport = base / 'host-transport'; transport.mkdir()
        (transport / 'sitecustomize.py').write_text(site)
        (transport / 'df').write_text(df); (transport / 'df').chmod(0o700)
        state = transport / 'storage.json'; state.write_text(json.dumps({'capacity_mb':500,'allocations':{}}))
        namespace = 2**49 + int(hashlib.sha256(str(base).encode()).hexdigest()[:12],16)
        owned_ledgers = {Path('/tmp') / ('rose-cloudbench-cleanup-admission-' + str(os.getuid())) / str(namespace)}
        env = {**os.environ, 'PATH':str(transport)+os.pathsep+os.environ['PATH'], 'PYTHONPATH':str(transport),
               'RESERVE_TRANSPORT_STATE':str(state),'RESERVE_TEST_DEVICE':str(namespace),
               'CLOUDBENCH_CLEANUP_DISK_RESERVE_MB':'32','CLOUDBENCH_MIN_CLEANUP_DISK_RESERVE_MB':'32',
               'CLOUDBENCH_CLEANUP_DISK_HEADROOM_MB':'256'}
        # Keep exactly one native foreign owner live; no provider/task/200-way workload.
        foreign_path = foreign / 'cleanup-disk-reserve'
        script = ('set -uo pipefail\nCLEANUP_DISK_RESERVE_FILE="$EXACT_RESERVE_PATH"\n' + reserve +
                  '\nreserve_cleanup_disk_space || exit $?\necho READY\nread -r release\nrm -f "$CLEANUP_DISK_RESERVE_FILE"\n')
        p = subprocess.Popen(['bash','-c',script], env={**env,'EXACT_RESERVE_PATH':str(foreign_path),
                             'RESERVE_TEST_PARENT':str(foreign)}, stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        try:
            assert p.stdout is not None
            assert select.select([p.stdout],[],[],15)[0], 'native foreign reserve did not start'
            first = p.stdout.readline()
            assert first.strip() == 'READY', first
            ledger = next(iter(owned_ledgers)) / 'state.json'
            before = ledger.read_bytes()
            probe = base / 'reserve-probe.sh'
            target = ws / 'cleanup-disk-reserve'
            probe.write_text('set -uo pipefail\nCLEANUP_DISK_RESERVE_FILE="$EXACT_RESERVE_PATH"\n' + reserve +
                             '\nreserve_cleanup_disk_space\n')
            run_env = {**env,'EXACT_RESERVE_PATH':str(target),'RESERVE_TEST_PARENT':str(ws),
                       'RESERVE_PROBE':str(probe),'TMP_ROOT':str(ws),'FAKE_BIN':str(transport),
                       'SCRIPT_SNAPSHOT_TMP':str(ws),'FAKE_FLY_TOKEN':'fixture-no-call','FAKE_DIR':str(base),
                       'port':'12000','ws':str(ws),'log':str(base/'probe.log')}
            bootstrap = prepare + ('\nprepare_fixture_storage_transport\nprintf \"%s\\n\" \"$FIXTURE_STORAGE_DEVICE\" > \"$TMP_ROOT/storage-device\"\n' if prepare else '\n')
            # This is the actual run_controller env command, with only its final
            # controller command replaced by the owning native reserve boundary.
            result = subprocess.run(['bash','-c',bootstrap+'\nsession_leader=()\n'+launch],
                                    env=run_env,capture_output=True,text=True,timeout=20)
            output = (base/'probe.log').read_text()
            device_file=ws/'storage-device'
            device=device_file.read_text().strip() if device_file.exists() else ''
            if device.isdigit(): owned_ledgers.add(ledger.parent.parent/device)
            assert result.returncode == 0, output + result.stderr
            assert ledger.read_bytes() == before, 'fixture changed foreign native ledger'
            assert target.stat().st_blocks * 512 < target.stat().st_size, 'fixture allocated real reserve blocks'
            child_state = ws/'reserve-transport/state.json'
            allocations = json.loads(child_state.read_text())['allocations']
            assert allocations[str(target)] == 32*1048576
            # The real allocator still refuses an insufficient private budget.
            data=json.loads(child_state.read_text());data['capacity_mb']=200;child_state.write_text(json.dumps(data))
            # Reuse this already prepared transport (not a newly reset disk).
            direct = {**run_env,'PATH':str(ws/'reserve-transport')+os.pathsep+run_env['PATH'],
                      'PYTHONPATH':str(ws/'reserve-transport'),
                      'CLOUDBENCH_TEST_STORAGE_SCOPE':str(ws),
                      'CLOUDBENCH_TEST_STORAGE_STATE':str(child_state)}
            assert device.isdigit()
            direct['CLOUDBENCH_TEST_STORAGE_DEVICE']=device
            # Retire the first synthetic file; a new admission must still fail
            # its native256MB floor against this deliberately insufficient disk.
            target.unlink()
            refused = subprocess.run(['bash','-c',script.split('\necho READY',1)[0]],env=direct,
                                     capture_output=True,text=True,timeout=15)
            assert refused.returncode != 0 and 'insufficient physical cleanup floors' in refused.stderr, refused.stderr
            assert ledger.read_bytes()==before
            print('PASS: native fake-controller disk is private/sparse; foreign ledger unchanged; real private floor refusal retained')
        finally:
            if p.poll() is None:
                p.communicate('release\n',timeout=10)
            else:
                p.communicate(timeout=10)
            # Only namespaces created by these exact private fake disks.
            for path in owned_ledgers: shutil.rmtree(path,ignore_errors=True)


def main() -> None:
    assert_private_cleanup_storage()
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

        def clone(source: str, name: str, *, identity: str | None = None,
                  override_cmd: str | None = None) -> str:
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
            if override_cmd is not None:
                command += ["--override-cmd", override_cmd]
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
        worker = clone(first, "cloudbench-volume-contract-worker", override_cmd="sleep infinity")
        preflight(worker)
        state = json.loads((base / "state.json").read_text())
        machine_inventory, volume_inventory = base / "machines.json", base / "volumes.json"
        machine_inventory.write_text(json.dumps(state["machines"]))
        volume_inventory.write_text(json.dumps(state["volumes"]))
        index = base / "index"
        subprocess.run(
            [sys.executable, str(ROOT / "scripts/cloudbench-machine-readiness.py"),
             "--publish-index", str(machine_inventory), str(volume_inventory), str(index)],
            env=env, check=True, capture_output=True, text=True, timeout=15,
        )
        for machine_id, expected in ((first, "0"), (worker, "1")):
            fields = dict(line.split("=", 1) for line in
                          (index / "current/machines" / machine_id).read_text().splitlines())
            assert fields["clone_cmd_inert"] == expected, (
                "fake clone must project only the requested native inert command", machine_id
            )
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
    elif len(sys.argv) == 2 and sys.argv[1] == "--assert-private-cleanup-storage":
        assert_private_cleanup_storage()
    else:
        main()
