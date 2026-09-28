"""The isolated system-Postgres cleanup must not wait on Docker."""

from pathlib import Path
from unittest.mock import patch

from benchmarks.local import ServiceStack, _stop_owned_db_from_stack_identity


def test_failed_system_postgres_startup_skips_docker(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ROSE_USE_SYSTEM_PG", "true")
    stack = ServiceStack(
        run_id="system-pg-probe",
        context_dir=tmp_path,
        manifest_path=tmp_path / "missing-manifest.json",
        service_log=tmp_path / "services.log",
        isolated=True,
        workspace_name="system-pg-probe",
    )
    with patch("benchmarks.local.subprocess.run") as run:
        _stop_owned_db_from_stack_identity(stack)
    run.assert_not_called()


def test_default_isolated_system_postgres_skips_docker_without_parent_env(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("ROSE_USE_SYSTEM_PG", raising=False)
    stack = ServiceStack(
        run_id="default-system-pg-probe",
        context_dir=tmp_path,
        manifest_path=tmp_path / "missing-manifest.json",
        service_log=tmp_path / "services.log",
        isolated=True,
        workspace_name="default-system-pg-probe",
    )
    with patch("benchmarks.local.subprocess.run") as run:
        _stop_owned_db_from_stack_identity(stack)
    run.assert_not_called()
