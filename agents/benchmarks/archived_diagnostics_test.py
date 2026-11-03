"""Owning archive authentication and diagnostic projection controls; no network."""

import copy
import gzip
import hashlib
import importlib.util
import io
import json
import struct
import tarfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from benchmarks.archived_diagnostics import verify_diagnostic_archive
from benchmarks.hub_upload import project_archived_diagnostics


def _fixture(*, root="root", omit=None, duplicate=False):
    helper = Path(__file__).resolve().parents[2] / "docs/handoffs/whm-b07d9037-preservation/private_archive.py"
    spec = importlib.util.spec_from_file_location("private_archive_control", helper)
    original = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(original)
    native = {"session_id": "session1", "session_scope_id": root, "history": ["original"], "join_verified": True}
    bundle = {"run_id": "run", "tasks": [{"agent_id": "root", "passed": False,
        "logs": {"messages": [{"text": "retained"}], "tree": {}, "wmh_retirement": native}}]}
    members = [("run.json", json.dumps(bundle).encode()),
               ("data/native-retirements/session1.json", json.dumps(native).encode()),
               ("unrelated.txt", b"every member must authenticate")]
    members = [(p, b) for p, b in members if p != omit]
    if duplicate:
        members.append(members[-1])
    manifest = [{"path": p, "size": len(b), "sha256": hashlib.sha256(b).hexdigest()} for p, b in members]
    manifest_bytes = json.dumps(manifest, sort_keys=True).encode()
    tar = io.BytesIO()
    with tarfile.open(fileobj=tar, mode="w") as contents:
        for p, b in members + [("MIGRATION_MANIFEST.json", manifest_bytes)]:
            info = tarfile.TarInfo(p)
            info.size = len(b)
            contents.addfile(info, io.BytesIO(b))
    compressed = gzip.compress(tar.getvalue(), mtime=0)
    aes, nonce, key = AESGCM(b"k" * 32), b"n" * 12, "private/control.enc"
    encrypted = aes.encrypt(nonce, compressed, (key + ":0").encode())
    wire = original.MAGIC + struct.pack(">I", len(encrypted)) + nonce + encrypted
    receipt = {"bucket": "control", "key": key, "encryption_key_id": "test-key",
        "frames": 1, "files": len(manifest), "full_readback_verified": True,
        "ciphertext_sha256": hashlib.sha256(wire).hexdigest(),
        "gzip_sha256": hashlib.sha256(compressed).hexdigest(),
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest()}
    class Client:
        def get_object(self, *, Bucket, Key):
            assert Bucket == receipt["bucket"] and Key == key
            return {"Body": io.BytesIO(wire)}
    archive = SimpleNamespace(connection=lambda: (Client(), "control", aes, "test-key"),
                              FrameReader=original.FrameReader, frames=original.frames)
    return bundle, receipt, archive


def test_authenticated_archive_projection_preserves_originals():
    bundle, receipt, archive = _fixture()
    before = copy.deepcopy(bundle)
    verified, manifest, bindings = verify_diagnostic_archive(bundle, Path.home() / "run.json", receipt, archive)
    ref = {key: verified[key] for key in ("bucket", "key", "encryption_key_id", "ciphertext_sha256", "manifest_sha256")}
    ref.update(canonical=bindings["canonical"], retirements=bindings["retirements"])
    result = project_archived_diagnostics(bundle, ref, verify_archive=lambda _: (verified, manifest, bindings))
    assert bundle == before
    assert result["tasks"][0]["passed"] is False
    assert result["tasks"][0]["logs"]["messages"] == before["tasks"][0]["logs"]["messages"]
    assert "wmh_retirement" not in result["tasks"][0]["logs"]
    assert result["tasks"][0]["logs"]["forensic_archive_ref"]["native_retirement"]["sha256"]


@pytest.mark.parametrize("field", ["ciphertext_sha256", "gzip_sha256", "manifest_sha256", "encryption_key_id"])
def test_archive_digest_and_key_identity_fail_closed(field):
    bundle, receipt, archive = _fixture()
    receipt[field] = "incorrect"
    with pytest.raises((RuntimeError, ValueError)):
        verify_diagnostic_archive(bundle, Path.home() / "run.json", receipt, archive)


@pytest.mark.parametrize("kwargs", [{"root": "wrong-root"}, {"omit": "run.json"},
    {"omit": "data/native-retirements/session1.json"}, {"duplicate": True}])
def test_member_root_missing_and_duplicate_fail_closed(kwargs):
    bundle, receipt, archive = _fixture(**kwargs)
    with pytest.raises((RuntimeError, ValueError)):
        verify_diagnostic_archive(bundle, Path.home() / "run.json", receipt, archive)


def test_caller_cannot_replace_archived_canonical_content():
    bundle, receipt, archive = _fixture()
    bundle["tasks"][0]["logs"]["messages"] = [{"text": "unarchived replacement"}]
    with pytest.raises(RuntimeError):
        verify_diagnostic_archive(bundle, Path.home() / "run.json", receipt, archive)
