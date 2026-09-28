"""Offline owning-boundary regressions for exact recovery review findings."""

import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
ROOT_AGENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"


def load_script(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def cleanup():
    return load_script("cloudbench-exact-session-cleanup")


@pytest.fixture
def guest():
    return load_script("cloudbench-guest-recovery")


def query_fixture(tmp_path, **digests):
    args = SimpleNamespace(
        zero_query_proof=tmp_path / "zero-query.json",
        quiescence_receipt=tmp_path / "quiescence.json",
        machine_id="deadbeef000020",
        guest_run_token="zero-allocated-token",
    )
    query = {
        "schema_version": "cloudbench-guest-zero-allocation-v1",
        "version": 1,
        "machine_id": args.machine_id,
        "guest_run_token": args.guest_run_token,
        "root_agent_id": ROOT_AGENT,
        "root_disposition": "root-absent",
        "database_name": "victoria_bench_exact_zero",
        "database_state": "present",
        "tree_agent_ids": [],
        "browser_sessions": [],
        "services_sha256": "a" * 64,
        "run_json_sha256": "b" * 64,
        "backend_log_sha256": "c" * 64,
        "quiescence_receipt_sha256": "d" * 64,
        **digests,
    }
    args.zero_query_proof.write_text(json.dumps(query) + "\n")
    args.quiescence_receipt.write_text(json.dumps({"services_sha256": "a" * 64}))
    return args, query


def test_zero_query_digest_covers_the_validated_bytes(cleanup, tmp_path, monkeypatch):
    args, query = query_fixture(tmp_path)
    validated_payload = args.zero_query_proof.read_bytes()
    replacement = json.dumps({**query, "root_agent_id": "unvalidated-root"}).encode()
    original_read = cleanup.read_bytes
    query_reads = []

    def republished_read(path, **kwargs):
        payload = original_read(path, **kwargs)
        if path == args.zero_query_proof:
            query_reads.append(payload)
            path.write_bytes(replacement)
        return payload

    monkeypatch.setattr(cleanup, "read_bytes", republished_read)
    parsed, digest = cleanup.validate_zero_query_proof(
        args, ROOT_AGENT, "b" * 64, "c" * 64, "d" * 64
    )
    assert parsed == query
    assert digest == hashlib.sha256(validated_payload).hexdigest()
    assert len(query_reads) == 1


@pytest.mark.parametrize("run_upper,log_upper", [(True, False), (False, True), (True, True)])
def test_zero_recovery_uses_canonical_uuid_across_run_log_and_query(
    cleanup, guest, tmp_path, run_upper, log_upper
):
    run = tmp_path / "run.json"
    run.write_text(json.dumps({"tasks": [{
        "name": "fixture", "agent_id": ROOT_AGENT.upper() if run_upper else ROOT_AGENT,
    }]}))
    backend = tmp_path / "backend.log"
    backend.write_text(f"agent_id={ROOT_AGENT.upper() if log_upper else ROOT_AGENT}\n")
    root, run_sha = cleanup.parse_run_identity(run, "fixture")
    assert (root, run_sha) == guest.parse_zero_run(run)
    _, backend_sha = cleanup.read_backend_evidence(backend, root)
    args, query = query_fixture(
        tmp_path, run_json_sha256=run_sha, backend_log_sha256=backend_sha
    )
    parsed, _ = cleanup.validate_zero_query_proof(
        args, root, run_sha, backend_sha, query["quiescence_receipt_sha256"]
    )
    assert parsed["root_agent_id"] == ROOT_AGENT
    assert run_sha == hashlib.sha256(run.read_bytes()).hexdigest()
    assert backend_sha == hashlib.sha256(backend.read_bytes()).hexdigest()


@pytest.mark.parametrize("root", ["not-a-uuid", "aaaaaaaa-bbbb-4ccc-0ddd-eeeeeeeeeeee"])
def test_exact_recovery_rejects_invalid_root_uuid(cleanup, tmp_path, root):
    run = tmp_path / "run.json"
    run.write_text(json.dumps({"tasks": [{"name": "fixture", "agent_id": root}]}))
    with pytest.raises(cleanup.CleanupEvidenceError, match="exact root agent"):
        cleanup.parse_run_identity(run, "fixture")


def backend_payload(event):
    return (
        "[Server] Server started mode=fixture port=3001\n"
        f"agent_id={ROOT_AGENT}\n{event}\n"
        "[Server] SIGTERM received, closing server...\n"
    ).encode()


def test_runless_zero_session_guest_needs_complete_deleted_root(cleanup, tmp_path):
    """An evaluated run may hang before run.json despite having no browser sessions."""
    output = tmp_path / "exact-output"
    output.mkdir()
    backend = tmp_path / "backend.log"
    args = SimpleNamespace(
        owner="a" * 32,
        fleet_run_id="fixture-run",
        bench="planner-memory-blue-bottle-on",
        machine_id="deadbeef000019",
        output_dir=str(output),
        guest_run_token="fixture-run-0",
        backend_log=backend,
    )
    prefix = (
        "[Server] Server started mode=fixture port=3001\n"
        "[HTTP] POST /api/agents -> 201\n"
        f"path=/api/agents/{ROOT_AGENT}\n"
    )
    terminal = "[Server] SIGTERM received, closing server...\n"
    backend.write_text(
        prefix
        + f"[HTTP] DELETE /api/agents/{ROOT_AGENT} -> 204\n"
        + terminal
    )
    manifest = cleanup.active_provider_manifest(args)
    assert manifest["root_agent_id"] == ROOT_AGENT
    assert manifest["sessions"] == {"kernel": [], "steel": []}
    assert manifest["evidence"]["allocation_event_count"] == 0
    assert manifest["evidence"]["browser_session_mutation_count"] == 0
    assert manifest["evidence"]["root_delete_count"] == 1

    # A failed isolated DB can leave only a local root behind. The complete
    # backend log proves no external allocation; the recovery receipt still
    # requires an exact stopped-Machine proof before the volume can be reaped.
    backend.write_text(prefix + terminal)
    assert cleanup.active_provider_manifest(args)["evidence"]["root_delete_count"] == 0
    backend.write_text(prefix + terminal + terminal)
    assert cleanup.active_provider_manifest(args)["evidence"]["root_delete_count"] == 0

    for incomplete in (
        prefix + f"[HTTP] DELETE /api/agents/{ROOT_AGENT} -> 500\n" + terminal,
        prefix + f"[HTTP] DELETE /api/agents/{ROOT_AGENT} -> 204\n",
        prefix + terminal + "[HTTP] GET /health -> 200\n",
        prefix + "[Prisma] model=BrowserSession operation=create status=ok\n"
        + f"[HTTP] DELETE /api/agents/{ROOT_AGENT} -> 204\n" + terminal,
        prefix + "[Prisma] model=Purchase operation=create status=ok\n" + terminal,
    ):
        backend.write_text(incomplete)
        with pytest.raises(cleanup.CleanupEvidenceError):
            cleanup.active_provider_manifest(args)


def test_sealed_zero_session_run_allows_exact_cleanup_after_archive_timeout(cleanup, tmp_path, monkeypatch):
    output = tmp_path / "exact-output"
    output.mkdir()
    run = tmp_path / "run.json"
    backend = tmp_path / "backend.log"
    backend.write_text(
        "[Server] Server started mode=fixture port=3001\n"
        "[HTTP] POST /api/agents -> 201\n"
        f"agent_id={ROOT_AGENT}\n"
        f"[HTTP] DELETE /api/agents/{ROOT_AGENT} -> 204\n"
        "[Server] SIGTERM received, closing server...\n"
    )
    before = {
        "root_exists": True, "root_deleted": False,
        "tree_agent_ids": [ROOT_AGENT], "unsealed_tree_agent_ids": [ROOT_AGENT],
        "browser_sessions": [], "purchase_cleanup": [],
    }
    after = {**before, "root_deleted": True, "unsealed_tree_agent_ids": []}
    logs = {
        "cloud_cleanup_evidence": {
            "root_agent_id": ROOT_AGENT, "before": before, "after": after,
            "final": after, "errors": ["archive: TimeoutError"],
        },
        "cloud_provider_cleanup": {
            "root_agent_id": ROOT_AGENT, "root_deleted": True,
            "tree_sealed": True, "provider_receipts": [],
        },
        "cloud_payment_cleanup": {"root_agent_id": ROOT_AGENT, "purchases": []},
    }
    run.write_text(json.dumps({"tasks": [{"name": "fixture", "agent_id": ROOT_AGENT, "logs": logs}]}))
    args = SimpleNamespace(
        owner="a" * 32, fleet_run_id="fixture-run", bench="fixture",
        machine_id="deadbeef000019", output_dir=str(output),
        guest_run_token="fixture-run-0", run_json=run, backend_log=backend,
        quiescence_receipt=tmp_path / "quiescence.json",
    )
    monkeypatch.setattr(cleanup, "validate_quiescence", lambda *_: "d" * 64)
    assert cleanup.provider_manifest(args)["sessions"] == {"kernel": [], "steel": []}

    for invalid_logs in (
        {**logs, "cloud_provider_cleanup": {}},
        {**logs, "cloud_cleanup_evidence": {**logs["cloud_cleanup_evidence"], "after": before}},
        {**logs, "cloud_payment_cleanup": {"root_agent_id": ROOT_AGENT, "purchases": [{}]}},
    ):
        run.write_text(json.dumps({"tasks": [{"name": "fixture", "agent_id": ROOT_AGENT, "logs": invalid_logs}]}))
        with pytest.raises(cleanup.CleanupEvidenceError, match="no exact provider session"):
            cleanup.provider_manifest(args)


def test_stopped_machine_status_accepts_fly_colorized_section_headers(cleanup, tmp_path):
    status = tmp_path / "machine-status.txt"
    status.write_text(
        "Machine ID: deadbeef000019\n"
        "State: stopped\n\n"
        "\x1b[1mVM\x1b[0m\n"
        " ID │ deadbeef000019\n"
        " State │ stopped\n"
        " Name │ cloudbench-exact-guest\n"
        "\x1b[1mEvent Logs\x1b[0m\n"
    )
    assert cleanup.parse_stopped_machine_status(
        status, "deadbeef000019", "cloudbench-exact-guest"
    ) == hashlib.sha256(status.read_bytes()).hexdigest()


@pytest.mark.parametrize("event", [
    "Created Ker\x1b[32mnel\x1b[0m browser session sessionId=fixture123",
    "Created Ste\x1b[32mel\x1b[0m session: fixture123",
    "Kernel session fixture123 failed CDP val\x1b[31midation\x1b[0m",
    "[Prisma] model=Browser\x1b[32mSession\x1b[0m operation=create status=ok",
    "[Prisma] model=BrowserSession operation=up\x1b[32mdateMany\x1b[0m status=ok",
])
def test_colored_provider_or_mutation_evidence_cannot_prove_zero(guest, tmp_path, event):
    backend = tmp_path / "backend.log"
    backend.write_bytes(backend_payload(event))
    with pytest.raises(guest.GuestRecoveryError, match="allocation events|BrowserSession mutations"):
        guest.validate_zero_backend(backend, ROOT_AGENT)


def test_colored_zero_backend_keeps_digest_of_raw_evidence(guest, tmp_path):
    backend = tmp_path / "backend.log"
    payload = backend_payload("[Prisma] model=BrowserSession operation=findMany status=ok")
    payload = payload.replace(b"[Server]", b"[Ser\x1b[32mver\x1b[0m]")
    backend.write_bytes(payload)
    text, digest = guest.validate_zero_backend(backend, ROOT_AGENT)
    assert "\x1b" not in text
    assert digest == hashlib.sha256(payload).hexdigest()


@pytest.mark.parametrize("unsafe_update", [
    None,
    {"live_service_pids": [99999991]},
    {"backend_closed": False},
    {"services_status": None},
    {"stopped_service_pids": []},
    {"reason": "unrelated evidence error"},
    {"run_json": {"exists": True, "regular": True, "symlink": False, "bytes": 100, "within_limit": True}},
    {"backend_log": {"exists": False, "regular": False, "symlink": False, "bytes": None, "within_limit": False}},
])
def test_runless_classification_accepts_custom_path_only_with_complete_fence(
    guest, tmp_path, capsys, unsafe_update
):
    available = {"exists": True, "regular": True, "symlink": False, "bytes": 100, "within_limit": True}
    value = {
        "schema_version": "cloudbench-guest-state-v1", "version": 1, "state": "exited",
        "machine_id": "deadbeef000019", "guest_run_token": "runless-exited-token",
        "reason": "missing regular exact guest evidence: /custom/workspace/run.json",
        "driver_state": "exited", "driver_pid": None, "driver_process_state": None,
        "driver_token_match": False, "driver_descendants": [],
        "services_manifest": available, "backend_log": available,
        "run_json": {"exists": False, "regular": False, "symlink": False, "bytes": None, "within_limit": False},
        "services_status": "stopped", "stopped_service_pids": [99999991, 99999992],
        "live_service_pids": [], "backend_port": 3001, "backend_closed": True,
        **(unsafe_update or {}),
    }
    receipt = tmp_path / "state.json"
    receipt.write_text(json.dumps(value))
    args = SimpleNamespace(
        receipt=receipt, machine_id=value["machine_id"], guest_run_token=value["guest_run_token"]
    )
    assert guest.describe_state(args) == 0
    expected = "exited" if unsafe_update else "exited-no-run"
    assert capsys.readouterr().out.startswith(f"{expected}\texited\t0\t")
