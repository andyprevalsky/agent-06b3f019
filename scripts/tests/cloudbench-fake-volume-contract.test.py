#!/usr/bin/env python3
"""Admit the lifecycle fixture's real provider inventories through snapshot preflight."""

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

        def clone(source: str, name: str) -> str:
            subprocess.run(
                [
                    str(fly),
                    "machine",
                    "clone",
                    source,
                    "--name",
                    name,
                    "-a",
                    app,
                    "--json",
                ],
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
    main()
