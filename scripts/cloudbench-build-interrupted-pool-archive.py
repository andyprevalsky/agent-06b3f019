#!/usr/bin/env python3
"""Preserve original files of a failed pool owner without claiming proof credit.

Sealed bundles come from the normal status-plane collector. Unsealed guests
must be captured separately from their exact stopped volumes and supplied as
<machine-id>.tar.gz. This helper never changes ownership or provider state.
"""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tarfile


def fields(path: Path) -> dict[str, str]:
    pairs = [line.split("=", 1) for line in path.read_text().splitlines()]
    assert all(len(pair) == 2 for pair in pairs)
    result = dict(pairs)
    assert len(result) == len(pairs)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--capture-dir", type=Path, required=True)
    args = parser.parse_args()
    registry = args.registry.resolve()
    owner = registry.name
    assert re.fullmatch(r"[0-9a-f]{32}", owner)
    meta = fields(registry / "meta")
    assert meta["fleet_owner_token"] == owner
    run = Path(meta["runs_root"]) / meta["run_id"]
    assert run.resolve() == run
    assert not (registry / "guest-cleanup-unconfirmed").exists()
    assert (registry / "runtime-evidence-unconfirmed").is_file()
    lifecycle = json.loads((run / "_batch/lifecycle.json").read_text())
    assert lifecycle["status"] == "failed" and lifecycle["controller_exit_code"] != 0
    tasks = json.loads((run / "_batch/benches.json").read_text())
    audit = Path(meta["audit_dir"])
    destination = run / "_forensic"
    destination.mkdir(mode=0o700, exist_ok=False)
    archive_path = destination / "originals.tar.gz"
    rows = []
    try:
        with tarfile.open(archive_path, "w:gz") as archive:
            for ordinal, task in enumerate(tasks):
                name = task["name"]
                assert re.fullmatch(r"[A-Za-z0-9._-]+", name)
                out = run / name
                kind, machine = (out / ".cid").read_text().split()
                assert kind == "pool" and re.fullmatch(r"[0-9a-f]+", machine)
                volume = fields(audit / "pool" / machine)["volume_id"]
                run_token = f"{owner}-{ordinal}"
                entry = {
                    "task": name, "ordinal": ordinal, "run_token": run_token,
                    "machine_id": machine, "volume_id": volume,
                    "proof_credit": 0, "files": {}, "missing": [],
                }

                def add(relative: str, data: bytes) -> None:
                    assert relative not in entry["files"]
                    entry["files"][relative] = {
                        "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                    info = tarfile.TarInfo(f"{name}/{relative}")
                    info.size = len(data)
                    info.mode = 0o600
                    info.mtime = 0
                    archive.addfile(info, io.BytesIO(data))

                sealed = out / "remote-logs/runtime-evidence"
                if (sealed / "manifest.json").is_file():
                    entry["kind"] = "sealed"
                    manifest_bytes = (sealed / "manifest.json").read_bytes()
                    manifest = json.loads(manifest_bytes)
                    assert manifest["machine_id"] == machine
                    assert manifest["run_token"] == run_token
                    add("sealed/manifest.json", manifest_bytes)
                    for relative, info in sorted(manifest["files"].items()):
                        data = (sealed / relative).read_bytes()
                        assert len(data) == info["bytes"]
                        assert hashlib.sha256(data).hexdigest() == info["sha256"]
                        add("sealed/" + relative, data)
                else:
                    entry["kind"] = "interrupted"
                    capture = args.capture_dir / f"{machine}.tar.gz"
                    assert capture.is_file() and not capture.is_symlink()
                    with tarfile.open(capture, "r:gz") as original:
                        seen = set()
                        for member in original:
                            assert member.isfile()
                            assert member.name not in seen
                            assert re.fullmatch(r"[A-Za-z0-9._/-]+", member.name)
                            assert ".." not in Path(member.name).parts
                            stream = original.extractfile(member)
                            assert stream is not None
                            add("original/" + member.name,
                                stream.read(member.size + 1))
                            assert entry["files"]["original/" + member.name]["bytes"] == member.size
                            seen.add(member.name)
                    run_json = "repo/.context/cloudbench/run.json"
                    if run_json not in seen:
                        entry["missing"].append("original/" + run_json)
                rows.append(entry)
        archive_bytes = archive_path.stat().st_size
        assert archive_bytes <= 512 * 1024 * 1024
        manifest = {
            "schema": "cloudbench-interrupted-pool-evidence-v1",
            "owner": owner, "run_id": meta["run_id"], "proof_credit": 0,
            "archive_bytes": archive_bytes,
            "archive_sha256": hashlib.sha256(archive_path.read_bytes()).hexdigest(),
            "tasks": rows,
        }
        with (destination / "manifest.json").open("x") as output:
            json.dump(manifest, output, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        print(json.dumps({"run_id": meta["run_id"], "tasks": len(rows),
                          "incomplete": sum(x["kind"] == "interrupted" for x in rows),
                          "archive_bytes": archive_bytes, "proof_credit": 0}))
    except BaseException:
        # Keep any partial archive for diagnosis; never publish a manifest that
        # could authorize release of the ownership latch.
        raise


if __name__ == "__main__":
    main()
