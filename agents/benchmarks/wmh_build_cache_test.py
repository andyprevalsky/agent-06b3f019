"""WMH build cache round trip: encrypted parts, manifest-last publish, verified restore."""

from __future__ import annotations

import io
import json
import time
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


def test_pull_streams_extraction_without_staging_the_whole_archive(tmp_path: Path) -> None:
    """A cloud volume cannot hold the archive and its extraction at once, so
    extraction must already be writing files while later parts download."""
    bucket = _FakeBucket()
    manifest = wmh_build_cache.push(_build_dir(tmp_path / "src"), store=(bucket, "b"), part_bytes=4096, log=_quiet)
    assert len(manifest["parts"]) >= 3
    last_key = manifest["parts"][-1]["key"]
    extracted_before_last: list[int] = []
    staged_tars: list[Path] = []
    original_get = bucket.get_object

    def observing_get(*, Bucket: str, Key: str) -> dict:
        if Key == last_key:
            # Hold the last part back and give the extractor a bounded window: a
            # streaming pull writes files from the earlier parts meanwhile, while a
            # staging pull cannot extract anything until this part arrives. A single
            # instantaneous sample raced the extractor thread on a loaded host.
            deadline = time.monotonic() + 10
            while True:
                staging = list((tmp_path / "dst").glob(".wmh-cache-*"))
                count = sum(1 for root in staging for p in root.rglob("*") if p.is_file() and p.suffix != ".tar")
                if count or time.monotonic() >= deadline:
                    break
                time.sleep(0.05)
            staged_tars.extend(path for root in staging for path in root.rglob("*.tar"))
            extracted_before_last.append(count)
        return original_get(Bucket=Bucket, Key=Key)

    bucket.get_object = observing_get
    target = tmp_path / "dst" / "world-model-native"
    wmh_build_cache.pull(target, store=(bucket, "b"), log=_quiet)
    assert staged_tars == []
    assert extracted_before_last and extracted_before_last[0] >= 1
    assert (target / "sessions" / "b.json").read_text() == "secret trajectory b " * 200


def test_pull_restores_on_interpreters_without_tarfile_filters(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Cloud images run Python 3.11 builds older than 3.11.4, where extractall()
    has no ``filter``; restore must still work and still refuse escaping paths."""
    import tarfile

    bucket = _FakeBucket()
    wmh_build_cache.push(_build_dir(tmp_path / "src"), store=(bucket, "b"), part_bytes=4096, log=_quiet)
    monkeypatch.delattr(tarfile, "data_filter", raising=False)
    original_extractall = tarfile.TarFile.extractall

    def legacy_extractall(self, path=".", members=None, *, numeric_owner=False, **kwargs):
        if "filter" in kwargs:
            raise TypeError("TarFile.extractall() got an unexpected keyword argument 'filter'")
        return original_extractall(self, path, members, numeric_owner=numeric_owner)

    monkeypatch.setattr(tarfile.TarFile, "extractall", legacy_extractall)
    target = tmp_path / "dst" / "world-model-native"
    wmh_build_cache.pull(target, store=(bucket, "b"), log=_quiet)
    assert (target / "sessions" / "a.json").read_text() == "secret trajectory a " * 200

    evil = io.BytesIO()
    with tarfile.open(fileobj=evil, mode="w") as archive:
        info = tarfile.TarInfo("../escaped.txt")
        info.size = 1
        archive.addfile(info, io.BytesIO(b"x"))
    evil.seek(0)
    with tarfile.open(fileobj=evil, mode="r|") as archive, pytest.raises(ValueError, match="unsafe path"):
        wmh_build_cache._safe_extract(archive, tmp_path / "evil")
    assert not (tmp_path / "escaped.txt").exists()


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


def _native_build_dir(root: Path) -> Path:
    build = _build_dir(root)
    (build / "build.manifest.json").write_text(json.dumps({"engine": "experiential"}))
    (build / "conformance.json").write_text("{}")
    (build / "conformance.native.json").write_text("{}")
    (build / "prediction-audit.json").write_text("{}")
    (build / "models" / "rose-archive").mkdir(parents=True)
    (build / "models" / "rose-archive" / "experiential.json").write_text(json.dumps({"world_model_id": "w"}))
    (build / "experiential" / "artifacts").mkdir(parents=True)
    (build / "experiential" / "artifacts" / "w.json").write_text("native artifact")
    (build / "otel").mkdir()
    (build / "otel" / "a.otel.jsonl").write_text("secret trajectory a")
    (build / "sessions.json").write_text("{}")
    (build / "traces.otel.jsonl").write_text("secret trajectory")
    return build


def _restored_files(root: Path) -> set[str]:
    return {str(path.relative_to(root)) for path in root.rglob("*") if path.is_file()}


def test_serving_only_push_archives_exactly_what_native_serving_reads(tmp_path: Path) -> None:
    bucket = _FakeBucket()
    store = (bucket, "test-bucket")
    source = _native_build_dir(tmp_path / "src")
    manifest = wmh_build_cache.push(
        source, name="rose-archive-serving", store=store, part_bytes=4096, serving_only=True, log=_quiet
    )
    assert manifest["serving_only"] is True
    assert manifest["entries"] == [
        "build.manifest.json",
        "conformance.json",
        "conformance.native.json",
        "experiential",
        "models",
        "prediction-audit.json",
    ]
    assert manifest["indexed_bundles"] == 2
    assert bucket.put_order[-1] == "wmh-build-cache/rose-archive-serving/manifest.json"

    target = tmp_path / "dst" / "world-model"
    assert wmh_build_cache.pull(target, name="rose-archive-serving", store=store, log=_quiet) is not None
    assert _restored_files(target) == {
        "build.manifest.json",
        "conformance.json",
        "conformance.native.json",
        "prediction-audit.json",
        "models/rose-archive/experiential.json",
        "experiential/artifacts/w.json",
    }
    for rel in _restored_files(target):
        assert (target / rel).read_bytes() == (source / rel).read_bytes()


def test_serving_only_push_refuses_a_build_without_a_native_model(tmp_path: Path) -> None:
    source = _build_dir(tmp_path / "src")
    with pytest.raises(FileNotFoundError, match="native serving model"):
        wmh_build_cache.push(source, store=(_FakeBucket(), "b"), serving_only=True, log=_quiet)
    (source / "build.manifest.json").write_text("{}")
    (source / "experiential").mkdir()
    (source / "models" / "rose-archive").mkdir(parents=True)
    with pytest.raises(FileNotFoundError, match="native serving model"):
        wmh_build_cache.push(source, store=(_FakeBucket(), "b"), serving_only=True, log=_quiet)


def test_cli_serving_only_flag_reaches_push_and_is_push_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict] = []
    monkeypatch.setattr(wmh_build_cache, "push", lambda build_dir, **kwargs: calls.append(kwargs))
    assert (
        wmh_build_cache.main(["push", "--serving-only", "--name", "rose-archive-serving", "--build-dir", str(tmp_path)])
        == 0
    )
    assert calls == [{"name": "rose-archive-serving", "serving_only": True}]
    with pytest.raises(SystemExit):
        wmh_build_cache.main(["pull", "--serving-only", "--build-dir", str(tmp_path)])


def test_push_never_replaces_a_cache_of_the_other_kind(tmp_path: Path) -> None:
    # Shared names: the full cache seeds the next incremental build, the
    # serving cache is what every donor refresh restores. A push of the other
    # kind must not replace either; the same kind still republishes.
    bucket = _FakeBucket()
    store = (bucket, "test-bucket")
    full = _build_dir(tmp_path / "full")
    serving = tmp_path / "serving" / "build"
    (serving / "experiential").mkdir(parents=True)
    (serving / "models" / "rose-archive").mkdir(parents=True)
    (serving / "models" / "rose-archive" / "experiential.json").write_text("{}")
    (serving / "build.manifest.json").write_text("{}")
    wmh_build_cache.push(full, name="rose-archive-native", store=store, part_bytes=4096, log=_quiet)
    wmh_build_cache.push(serving, name="rose-archive-serving", serving_only=True, store=store, log=_quiet)
    before = dict(bucket.objects)
    with pytest.raises(ValueError, match="holds a full build"):
        wmh_build_cache.push(serving, name="rose-archive-native", serving_only=True, store=store, log=_quiet)
    with pytest.raises(ValueError, match="holds a serving-only build"):
        wmh_build_cache.push(full, name="rose-archive-serving", store=store, part_bytes=4096, log=_quiet)
    assert bucket.objects == before, "a refused push must not upload any part"
    republished = wmh_build_cache.push(full, name="rose-archive-native", store=store, part_bytes=4096, log=_quiet)
    assert wmh_build_cache.read_manifest("rose-archive-native", store=store) == republished


def test_pull_makes_every_restored_file_durable_before_the_swap(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """2026-10-20: a donor stopped and was snapshotted right after a 19.5 GB
    restore; one blob's unflushed tail was lost (truncated at a page boundary).
    Every restored file and directory is fsynced before the tree is swapped in,
    and the parent directory after the swap."""
    import os

    bucket = _FakeBucket()
    source = _build_dir(tmp_path / "src")
    wmh_build_cache.push(source, store=(bucket, "b"), part_bytes=4096, log=_quiet)
    synced: list[tuple[int, int]] = []
    renames: list[int] = []
    real_fsync, real_rename = os.fsync, Path.rename

    def recording_fsync(fd: int) -> None:
        info = os.fstat(fd)
        synced.append((info.st_dev, info.st_ino))
        real_fsync(fd)

    def recording_rename(self: Path, target):  # type: ignore[no-untyped-def]
        renames.append(len(synced))
        return real_rename(self, target)

    monkeypatch.setattr(os, "fsync", recording_fsync)
    monkeypatch.setattr(Path, "rename", recording_rename)
    target = tmp_path / "dst" / "world-model-native"
    wmh_build_cache.pull(target, store=(bucket, "b"), log=_quiet)
    restored = [path for path in target.rglob("*") if path.is_file()]
    assert restored
    before_swap = set(synced[: renames[-1]])
    for path in [*restored, *(p for p in target.rglob("*") if p.is_dir()), target]:
        info = path.stat()
        assert (info.st_dev, info.st_ino) in before_swap, f"{path} was not fsynced before the swap"
    parent = target.parent.stat()
    assert (parent.st_dev, parent.st_ino) in set(synced[renames[-1]:]), "the swapped-in parent was not fsynced"
