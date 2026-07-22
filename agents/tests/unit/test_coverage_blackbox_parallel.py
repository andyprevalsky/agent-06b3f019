import asyncio
import importlib.util
import sys
from pathlib import Path


def load_runner():
    path = Path(__file__).resolve().parents[2] / "scripts" / "run_coverage_blackbox_parallel.py"
    spec = importlib.util.spec_from_file_location("coverage_blackbox_runner", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_each_domain_runs_in_its_own_coverage_process(tmp_path: Path, monkeypatch):
    runner = load_runner()
    calls = []

    class FakeProcess:
        returncode = 0

        async def communicate(self):
            return b"passed", None

    async def fake_create_subprocess_exec(*args, **kwargs):
        calls.append((args, kwargs))
        return FakeProcess()

    monkeypatch.setattr(runner.asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(runner, "ROOT_DIR", tmp_path)
    coverage_bin = tmp_path / "coverage"
    coverage_bin.touch()
    semaphore = asyncio.Semaphore(2)

    async def run_domains():
        return await asyncio.gather(
            *(runner.run_domain(domain, semaphore, coverage_bin, tmp_path) for domain in ("workflow", "trace-archive"))
        )

    results = asyncio.run(run_domains())

    assert [result.domain for result in results] == ["workflow", "trace-archive"]
    assert [call[0][-1] for call in calls] == ["workflow", "trace-archive"]
    assert all(len(call[0]) == 5 for call in calls)


def test_domain_timeout_kills_child_and_returns_failure(tmp_path: Path, monkeypatch):
    runner = load_runner()

    class HangingProcess:
        returncode = None

        def __init__(self):
            self.killed = False
            self.finished = asyncio.Event()

        async def communicate(self):
            await self.finished.wait()
            return b"partial output", None

        def kill(self):
            self.killed = True
            self.returncode = -9
            self.finished.set()

    process = HangingProcess()

    async def fake_create_subprocess_exec(*args, **kwargs):
        return process

    monkeypatch.setattr(runner.asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(runner, "ROOT_DIR", tmp_path)
    monkeypatch.setenv("AGENTS_COVERAGE_DOMAIN_TIMEOUT", "1")
    coverage_bin = tmp_path / "coverage"
    coverage_bin.touch()

    result = asyncio.run(runner.run_domain("hung-domain", asyncio.Semaphore(1), coverage_bin, tmp_path))

    assert process.killed is True
    assert result.passed is False
    assert result.exit_code == 124
    assert "TIMEOUT" in (tmp_path / "hung-domain.log").read_text()
