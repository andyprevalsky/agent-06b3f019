"""A failed isolated system-Postgres startup must not invoke Docker cleanup."""

import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from _test_utils import BlackboxResult
from benchmarks.local import ServiceStack, stop_services


def test_pre_manifest_system_postgres_cleanup_avoids_docker() -> None:
    with TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        stack = ServiceStack(
            run_id="system-pg-blackbox",
            context_dir=root,
            manifest_path=root / "missing-services.json",
            service_log=root / "services.log",
            isolated=True,
            workspace_name="system-pg-blackbox",
        )
        with (
            patch.dict("benchmarks.local.os.environ", {}, clear=False) as parent_environment,
            patch("benchmarks.local._manifest_status", return_value=None),
            patch("benchmarks.local._manifest_run_sh_pid", return_value=None),
            patch("benchmarks.local._stop_owned_db_from_manifest"),
            patch("benchmarks.local._kill_scoped_processes_by_run_id"),
            patch("benchmarks.local.subprocess.run") as docker,
        ):
            # start_services sets this only in the child environment by default.
            parent_environment.pop("ROSE_USE_SYSTEM_PG", None)
            stop_services(stack=stack)
        docker.assert_not_called()


async def run_all_tests() -> bool:
    print("benchmark local cleanup blackbox tests:")
    result = BlackboxResult()
    result.record("pre_manifest_system_postgres_skips_docker", test_pre_manifest_system_postgres_cleanup_avoids_docker)
    return result.all_passed


if __name__ == "__main__":
    raise SystemExit(0 if asyncio.run(run_all_tests()) else 1)
