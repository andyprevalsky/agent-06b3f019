"""WMH build cache round trip: encrypted parts, manifest-last publish, verified restore."""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from benchmarks import wmh_build_cache


class _FakeBucket:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.put_order: list[str] = []

    def put_object(self, *, Bucket: str, Key: str, Body: bytes) -> None:
        self.objects[Key] = bytes(Body)
        self.put_order.append(Key)

    def get_object(self, *, Bucket: str, Key: str) -> dict:
        if Key not in self.objects:
            raise KeyError(f"NoSuchKey: {Key}")
        return {"Body": io.BytesIO(self.objects[Key])}


def _build_dir(root: Path) -> Path:
    build = root / "world-model-native"
    (build / "sessions").mkdir(parents=True)
    (build / "delta-index.json").write_text(json.dumps({"bundles": {"a": {}, "b": {}}}))
    (build / "sessions" / "a.json").write_text("secret trajectory a " * 200)
    (build / "sessions" / "b.json").write_text("secret trajectory b " * 200)
    return build


def _quiet(_: str) -> None:
    return None


def test_round_trip_restores_identical_tree_and_encrypts_parts(tmp_path: Path) -> None:
    bucket = _FakeBucket()
    store = (bucket, "test-bucket")
    source = _build_dir(tmp_path / "src")
    manifest = wmh_build_cache.push(source, store=store, part_bytes=4096, log=_quiet)

    assert manifest["indexed_bundles"] == 2
    assert len(manifest["parts"]) > 1, "small part size must split the tarball"
    # Manifest is published last, after every part.
    assert bucket.put_order[-1] == "wmh-build-cache/rose-archive/manifest.json"
    # Parts are ciphertext: no plaintext trajectory leaks into the bucket.
    for part in manifest["parts"]:
        assert b"secret trajectory" not in bucket.objects[part["key"]]
        assert part["metadata"]["encryption"] == "aes-256-gcm"

    target = tmp_path / "dst" / "world-model-native"
    restored = wmh_build_cache.pull(target, store=store, log=_quiet)
    assert restored is not None
    for rel in ("delta-index.json", "sessions/a.json", "sessions/b.json"):
        assert (target / rel).read_bytes() == (source / rel).read_bytes()


def test_pull_rejects_tampered_part_and_keeps_target_untouched(tmp_path: Path) -> None:
    bucket = _FakeBucket()
    store = (bucket, "test-bucket")
    manifest = wmh_build_cache.push(_build_dir(tmp_path / "src"), store=store, part_bytes=4096, log=_quiet)
    key = manifest["parts"][1]["key"]
    corrupted = bytearray(bucket.objects[key])
    corrupted[0] ^= 0xFF
    bucket.objects[key] = bytes(corrupted)

    target = tmp_path / "dst" / "world-model-native"
    with pytest.raises(ValueError):
        wmh_build_cache.pull(target, store=store, log=_quiet)
    assert not target.exists()


def test_pull_refuses_non_empty_target_without_force_and_missing_cache_returns_none(tmp_path: Path) -> None:
    bucket = _FakeBucket()
    store = (bucket, "test-bucket")
    target = tmp_path / "world-model-native"
    assert wmh_build_cache.pull(target, store=store, log=_quiet) is None

    wmh_build_cache.push(_build_dir(tmp_path / "src"), store=store, part_bytes=4096, log=_quiet)
    target.mkdir()
    (target / "local.txt").write_text("keep me")
    with pytest.raises(FileExistsError):
        wmh_build_cache.pull(target, store=store, log=_quiet)
    assert (target / "local.txt").read_text() == "keep me"

    wmh_build_cache.pull(target, store=store, force=True, log=_quiet)
    assert (target / "delta-index.json").is_file()
    assert not (target / "local.txt").exists()


def test_push_refuses_non_build_directory(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        wmh_build_cache.push(tmp_path, store=(_FakeBucket(), "b"), log=_quiet)
