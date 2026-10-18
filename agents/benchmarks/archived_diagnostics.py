"""Authenticate forensic originals before projecting duplicated HTTP diagnostics."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import tarfile
from pathlib import Path

from benchmarks.hub_upload import HubVisibilityError, project_archived_diagnostics


def _digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def verify_diagnostic_archive(bundle: dict, canonical_path: Path, receipt: dict, archive) -> tuple:
    """Read every authenticated member; derive bindings from recovered originals."""
    client, bucket, aes, key_id = archive.connection()
    if receipt.get("bucket") != bucket or receipt.get("encryption_key_id") != key_id:
        raise HubVisibilityError("Forensic archive configuration identity differs")
    canonical_name = str(canonical_path.resolve().relative_to(Path.home()))
    desired = {}
    for task in bundle.get("tasks", []):
        diagnostic = (task.get("logs") or {}).get("wmh_retirement")
        if diagnostic is not None:
            session = diagnostic.get("session_id")
            if not isinstance(session, str) or not session or not session.isalnum():
                raise HubVisibilityError("Forensic native session identity is invalid")
            desired[session] = task["agent_id"]
    observed, native, canonical, manifest_bytes = {}, {}, None, None
    with io.BufferedReader(archive.FrameReader(archive.frames(client, aes, receipt))) as stream:
        with tarfile.open(fileobj=stream, mode="r|gz") as contents:
            for info in contents:
                if not info.isfile():
                    raise HubVisibilityError("Unexpected forensic archive member")
                source = contents.extractfile(info)
                if info.name == "MIGRATION_MANIFEST.json":
                    if manifest_bytes is not None:
                        raise HubVisibilityError("Duplicate forensic manifest")
                    manifest_bytes = source.read()
                    continue
                if info.name in observed:
                    raise HubVisibilityError("Duplicate forensic member")
                session = next((s for s in desired if info.name.endswith(
                    "/native-retirements/" + s + ".json"
                )), None)
                keep = info.name == canonical_name or session is not None
                digest, data = hashlib.sha256(), bytearray() if keep else None
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
                    if data is not None:
                        data.extend(chunk)
                observed[info.name] = {"path": info.name, "size": info.size,
                                       "sha256": digest.hexdigest()}
                if info.name == canonical_name:
                    canonical = json.loads(data)
                if session is not None:
                    if session in native:
                        raise HubVisibilityError("Ambiguous native retirement member")
                    native[session] = (observed[info.name], json.loads(data))
        # Exhaust the encrypted frame iterator, including ciphertext/stream hashes.
        while stream.read(1024 * 1024):
            pass
    if manifest_bytes is None or hashlib.sha256(manifest_bytes).hexdigest() != receipt.get("manifest_sha256"):
        raise HubVisibilityError("Forensic manifest digest differs")
    manifest = json.loads(manifest_bytes)
    expected = {row["path"]: row for row in manifest}
    if len(expected) != len(manifest) or observed != expected or len(observed) != receipt.get("files"):
        raise HubVisibilityError("Forensic member hashes differ")
    if canonical is None or _digest(canonical) != _digest(bundle):
        raise HubVisibilityError("Recovered canonical bundle differs")
    verified_receipt = {**receipt, "full_readback_verified": True}
    canonical_member = observed[canonical_name]
    bindings = {"canonical": canonical_member, "bundle_sha256": _digest(canonical),
                "run_id": canonical["run_id"], "retirements": {}}
    for task in canonical.get("tasks", []):
        diagnostic = (task.get("logs") or {}).get("wmh_retirement")
        if diagnostic is None:
            continue
        session, root = diagnostic["session_id"], task["agent_id"]
        if session not in native:
            raise HubVisibilityError("Recovered native retirement is missing")
        member, recovered = native[session]
        if (_digest(recovered) != _digest(diagnostic)
                or recovered.get("session_scope_id") != root):
            raise HubVisibilityError("Recovered native root/content differs")
        bindings["retirements"][root] = {"run_id": canonical["run_id"],
            "member": member, "diagnostic_sha256": _digest(recovered)}
    return verified_receipt, manifest, bindings


def project_verified_diagnostics(bundle: dict, canonical_path: Path, receipt_path: Path) -> dict:
    """Opt-in transport projection; ordinary publication keeps its existing path."""
    helper = Path(__file__).resolve().parents[2] / "docs/handoffs/whm-b07d9037-preservation/private_archive.py"
    spec = importlib.util.spec_from_file_location("rose_private_archive", helper)
    archive = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(archive)
    receipt = json.loads(receipt_path.read_bytes())
    verified, manifest, bindings = verify_diagnostic_archive(bundle, canonical_path, receipt, archive)
    reference = {key: verified[key] for key in (
        "bucket", "key", "encryption_key_id", "ciphertext_sha256", "manifest_sha256"
    )}
    reference.update(canonical=bindings["canonical"], retirements=bindings["retirements"])
    return project_archived_diagnostics(
        bundle, reference, verify_archive=lambda _: (verified, manifest, bindings)
    )
