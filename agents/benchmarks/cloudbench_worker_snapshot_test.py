"""Exact-size, once-per-pool worker snapshot regression checks."""

import argparse
import importlib.util
from pathlib import Path
from unittest.mock import patch

import pytest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/cloudbench-worker-snapshot.py"
spec = importlib.util.spec_from_file_location("cloudbench_worker_snapshot", SCRIPT)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)


def fixture(tmp_path, *, pool_size=20, warm_size=40, second_size=None):
    pool_ids = tmp_path / "pool.ids"
    ids = ["a0123456789abcde"]
    if second_size is not None:
        ids.append("b0123456789abcde")
    pool_ids.write_text("\n".join(ids) + "\n")
    machines = [
        {"id": machine_id, "state": "stopped",
         "config": {"mounts": [{"volume": f"vol_{n}", "size_gb": size}]}}
        for n, (machine_id, size) in enumerate(
            zip(ids, [pool_size, second_size] if second_size is not None else [pool_size])
        )
    ]
    volumes = [{"id": "warm", "size_gb": warm_size}]
    volumes.extend({"id": f"vol_{n}", "size_gb": size} for n, size in enumerate(
        [pool_size, second_size] if second_size is not None else [pool_size]
    ))
    args = argparse.Namespace(
        pool_ids=pool_ids, cache=tmp_path / "worker-snapshot.json", app="bench-app",
        fly="flyctl", warm_volume_id="warm", warm_snapshot_id="vs_warm",
        ready_attempts=2, poll_seconds=0,
    )
    return args, machines, volumes


def test_pool_snapshot_created_once_then_reused(tmp_path):
    args, machines, volumes = fixture(tmp_path)
    calls = []
    snapshots = []

    def provider(_fly, _app, *command):
        calls.append(command)
        if command == ("machines", "list"):
            return machines
        if command == ("volumes", "list"):
            return volumes
        if command == ("volumes", "snapshots", "create", "vol_0"):
            snapshots.append({"id": "vs_pool20", "status": "complete", "size": 1})
            return {}
        if command == ("volume", "snapshots", "list", "vol_0"):
            return list(snapshots)
        raise AssertionError(command)

    with patch.object(module, "provider", side_effect=provider):
        assert module.ensure(args) == "20 vs_pool20"
        assert module.ensure(args) == "20 vs_pool20"
    assert calls.count(("volumes", "snapshots", "create", "vol_0")) == 1


def test_equal_size_uses_proven_warm_snapshot_without_copy(tmp_path):
    args, machines, volumes = fixture(tmp_path, pool_size=40)

    def provider(_fly, _app, *command):
        if command == ("machines", "list"):
            return machines
        if command == ("volumes", "list"):
            return volumes
        raise AssertionError("equal-size pool must not create a snapshot")

    with patch.object(module, "provider", side_effect=provider):
        assert module.ensure(args) == "40 vs_warm"


def test_mixed_pool_sizes_fail_before_any_snapshot(tmp_path):
    args, machines, volumes = fixture(tmp_path, second_size=40)
    with pytest.raises(ValueError, match="mixed volume sizes"):
        module.pool_sources(machines, volumes, args.pool_ids.read_text().splitlines())


def test_ambiguous_new_snapshots_are_never_adopted(tmp_path):
    args, machines, volumes = fixture(tmp_path)
    snapshots = []

    def provider(_fly, _app, *command):
        if command == ("machines", "list"):
            return machines
        if command == ("volumes", "list"):
            return volumes
        if command == ("volumes", "snapshots", "create", "vol_0"):
            snapshots.extend([
                {"id": "vs_a", "status": "complete", "size": 1},
                {"id": "vs_b", "status": "complete", "size": 1},
            ])
            return {}
        if command == ("volume", "snapshots", "list", "vol_0"):
            return list(snapshots)
        raise AssertionError(command)

    with patch.object(module, "provider", side_effect=provider):
        with pytest.raises(ValueError, match="ambiguous"):
            module.ensure(args)
    assert not args.cache.exists()
