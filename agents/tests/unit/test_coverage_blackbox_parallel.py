import asyncio
import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest


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


def write_owned_domain_fixture(tmp_path: Path):
    handles_path = tmp_path / "owned-child.json"
    child = tmp_path / "owned-child.py"
    child.write_text(
        "import json,os,socket,subprocess,time\n"
        "from pathlib import Path\n"
        "listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen()\n"
        "birth=subprocess.check_output(['ps','-p',str(os.getpid()),'-o','lstart='],text=True).strip()\n"
        f"Path({str(handles_path)!r}).write_text(json.dumps({{'pid':os.getpid(),'birth':birth,'port':listener.getsockname()[1]}}))\n"
        "while True:time.sleep(1)\n"
    )
    coverage_bin = tmp_path / "coverage"
    coverage_bin.write_text(
        f"#!{sys.executable}\n"
        "import subprocess,time\n"
        f"subprocess.Popen([{sys.executable!r},{str(child)!r}],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n"
        "print('partial output',flush=True)\n"
        "while True:time.sleep(1)\n"
    )
    coverage_bin.chmod(0o700)
    return coverage_bin, child, handles_path


def live(pid: int) -> bool:
    result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
    return result.returncode == 0 and bool(result.stdout.strip()) and not result.stdout.strip().startswith("Z")


def retire_owned_descendant(owned: dict, child: Path):
    if live(owned["pid"]):
        identity = subprocess.run(
            ["ps", "-p", str(owned["pid"]), "-o", "lstart=,command="],
            capture_output=True,
            text=True,
        ).stdout.strip()
        if identity.startswith(owned["birth"]) and str(child) in identity:
            os.kill(owned["pid"], signal.SIGKILL)


def test_domain_timeout_kills_child_and_returns_failure(tmp_path: Path, monkeypatch):
    runner = load_runner()
    coverage_bin, child, handles_path = write_owned_domain_fixture(tmp_path)
    monkeypatch.setattr(runner, "ROOT_DIR", tmp_path)
    monkeypatch.setenv("AGENTS_COVERAGE_DOMAIN_TIMEOUT", "5")

    owned = None
    try:
        result = asyncio.run(runner.run_domain("hung-domain", asyncio.Semaphore(1), coverage_bin, tmp_path))
        assert handles_path.is_file(), "the actual descendant never acquired its test resource"
        owned = json.loads(handles_path.read_text())
        assert result.passed is False
        assert result.exit_code == 124
        assert "partial output" in (tmp_path / "hung-domain.log").read_text()
        assert "TIMEOUT" in (tmp_path / "hung-domain.log").read_text()
        deadline = time.monotonic() + 5
        while live(owned["pid"]) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not live(owned["pid"]), "timed-out domain left its exact descendant running"
        with socket.socket() as probe:
            probe.settimeout(5)
            assert probe.connect_ex(("127.0.0.1", owned["port"])) != 0
    finally:
        if owned is None and handles_path.is_file():
            owned = json.loads(handles_path.read_text())
        if owned is not None:
            retire_owned_descendant(owned, child)


def test_domain_cancellation_retires_owned_descendants(tmp_path: Path, monkeypatch):
    runner = load_runner()
    coverage_bin, child, handles_path = write_owned_domain_fixture(tmp_path)
    monkeypatch.setattr(runner, "ROOT_DIR", tmp_path)
    monkeypatch.setenv("AGENTS_COVERAGE_DOMAIN_TIMEOUT", "300")
    create_process = runner.asyncio.create_subprocess_exec
    parent = None
    parent_birth = None

    async def capture_process(*args, **kwargs):
        nonlocal parent, parent_birth
        parent = await create_process(*args, **kwargs)
        parent_birth = subprocess.check_output(["ps", "-p", str(parent.pid), "-o", "lstart="], text=True).strip()
        return parent

    monkeypatch.setattr(runner.asyncio, "create_subprocess_exec", capture_process)

    async def cancel_domain():
        task = asyncio.create_task(runner.run_domain("cancelled-domain", asyncio.Semaphore(1), coverage_bin, tmp_path))
        owned = None
        try:
            deadline = time.monotonic() + 5
            while not handles_path.is_file() and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
            assert handles_path.is_file(), "the actual descendant never acquired its test resource"
            owned = json.loads(handles_path.read_text())
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            else:
                raise AssertionError("domain cancellation was swallowed")
            deadline = time.monotonic() + 5
            while live(owned["pid"]) and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
            assert not live(owned["pid"]), "cancelled domain left its exact descendant running"
            with socket.socket() as probe:
                probe.settimeout(5)
                assert probe.connect_ex(("127.0.0.1", owned["port"])) != 0
            assert parent.returncode is not None
        finally:
            if not task.done():
                task.cancel()
            if owned is None and handles_path.is_file():
                owned = json.loads(handles_path.read_text())
            if owned is not None:
                retire_owned_descendant(owned, child)
            if parent is not None and live(parent.pid):
                identity = subprocess.run(
                    ["ps", "-p", str(parent.pid), "-o", "lstart=,command="], capture_output=True, text=True
                ).stdout.strip()
                if identity.startswith(parent_birth) and str(coverage_bin) in identity:
                    os.killpg(parent.pid, signal.SIGKILL)
            if parent is not None:
                await asyncio.wait_for(parent.wait(), 5)

    asyncio.run(cancel_domain())


@pytest.mark.parametrize("stop_signal", [signal.SIGTERM, signal.SIGHUP])
def test_coverage_cli_signal_retires_owned_descendants(tmp_path: Path, monkeypatch, stop_signal):
    runner = load_runner()
    coverage_bin, child, handles_path = write_owned_domain_fixture(tmp_path)
    cli = tmp_path / "coverage-cli.py"
    cli.write_text(
        "import importlib.util,sys\nfrom pathlib import Path\n"
        f"spec=importlib.util.spec_from_file_location('actual_coverage_cli',{runner.__file__!r})\n"
        "runner=importlib.util.module_from_spec(spec);sys.modules[spec.name]=runner;spec.loader.exec_module(runner)\n"
        f"runner.ROOT_DIR=Path({str(tmp_path)!r});runner.AGENTS_ROOT=Path({str(tmp_path)!r})\n"
        "runner.discover_domains=lambda:['owned-stop-domain']\nrunner.main()\n"
    )
    monkeypatch.setenv("COVERAGE_BIN", str(coverage_bin))
    monkeypatch.setenv("AGENTS_COVERAGE_CONCURRENCY", "1")
    monkeypatch.setenv("AGENTS_COVERAGE_DOMAIN_TIMEOUT", "300")
    proc = subprocess.Popen([sys.executable, str(cli)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    cli_birth = subprocess.check_output(["ps", "-p", str(proc.pid), "-o", "lstart="], text=True).strip()
    owned = None
    domain_pid = None
    domain_birth = None
    try:
        deadline = time.monotonic() + 5
        while not handles_path.is_file() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert handles_path.is_file(), "the actual descendant never acquired its test resource"
        owned = json.loads(handles_path.read_text())
        domain_pid = os.getpgid(owned["pid"])
        domain_birth = subprocess.check_output(["ps", "-p", str(domain_pid), "-o", "lstart="], text=True).strip()
        proc.send_signal(stop_signal)
        proc.communicate(timeout=5)
        deadline = time.monotonic() + 5
        while live(owned["pid"]) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not live(owned["pid"]), "coverage CLI signal left its exact descendant running"
        with socket.socket() as probe:
            probe.settimeout(5)
            assert probe.connect_ex(("127.0.0.1", owned["port"])) != 0
        assert proc.returncode == 128 + stop_signal
    finally:
        if owned is None and handles_path.is_file():
            owned = json.loads(handles_path.read_text())
        if owned is not None:
            retire_owned_descendant(owned, child)
        for pid, birth, command_path in ((domain_pid, domain_birth, coverage_bin), (proc.pid, cli_birth, cli)):
            if pid is not None and live(pid):
                identity = subprocess.run(
                    ["ps", "-p", str(pid), "-o", "lstart=,command="], capture_output=True, text=True
                ).stdout.strip()
                if identity.startswith(birth) and str(command_path) in identity:
                    os.killpg(pid, signal.SIGKILL)
        proc.communicate(timeout=5)

def test_full_coverage_wrapper_ignores_inherited_domain_selector(tmp_path: Path):
    import shutil

    source = Path(__file__).resolve().parents[2] / "scripts" / "run-coverage.sh"
    agents = tmp_path / "agents"
    (agents / "scripts").mkdir(parents=True)
    shutil.copyfile(source, agents / "scripts" / source.name)
    installed = tmp_path / "chromium"
    installed.mkdir()
    (installed / "INSTALLATION_COMPLETE").touch()
    output = tmp_path / "selection.json"
    python = tmp_path / "fake-python"
    python.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        f"location = {str(installed)!r}\n"
        "if '--dry-run' in sys.argv:\n"
        " print('Install location: ' + location)\n"
        "else:\n"
        f" json.dump(os.environ.get('AGENTS_BLACKBOX_DOMAINS'), open({str(output)!r}, 'w'))\n"
    )
    python.chmod(0o755)
    coverage = tmp_path / "fake-coverage"
    coverage.write_text("#!/bin/sh\nexit 0\n")
    coverage.chmod(0o755)
    result = subprocess.run(
        ["bash", str(agents / "scripts" / source.name)],
        env={**os.environ, "PYTHON_BIN": str(python), "COVERAGE_BIN": str(coverage), "AGENTS_BLACKBOX_DOMAINS": "one-domain"},
        text=True, capture_output=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert not json.loads(output.read_text()), "full coverage inherited a partial selector"


def test_explicit_diagnostic_domain_selector_remains_supported(tmp_path: Path, monkeypatch):
    runner = load_runner()
    for name in ("alpha", "beta"):
        (tmp_path / f"{name}.blackbox.py").touch()
    monkeypatch.setattr(runner, "TESTS_DIR", tmp_path)
    monkeypatch.setenv("AGENTS_BLACKBOX_DOMAINS", "beta")
    assert runner.discover_domains() == ["beta"]
    monkeypatch.setenv("AGENTS_BLACKBOX_DOMAINS", "unknown")
    with pytest.raises(ValueError, match="unknown"):
        runner.discover_domains()


def test_explicit_diagnostic_coverage_reports_partial_scope(tmp_path: Path, monkeypatch):
    runner = load_runner()
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "alpha.blackbox.py").touch()
    (tests / "beta.blackbox.py").touch()
    coverage = tmp_path / "coverage"
    coverage.touch()
    monkeypatch.setattr(runner, "ROOT_DIR", tmp_path)
    monkeypatch.setattr(runner, "TESTS_DIR", tests)
    monkeypatch.setenv("COVERAGE_BIN", str(coverage))
    monkeypatch.setenv("AGENTS_BLACKBOX_DOMAINS", "alpha")

    async def run_domain(domain, semaphore, coverage_bin, artifact_dir):
        return runner.DomainResult(domain=domain, passed=True, duration_seconds=0, log="unused", exit_code=0)

    monkeypatch.setattr(runner, "run_domain", run_domain)
    assert asyncio.run(runner.async_main()) == 0
    summary = json.loads(next(tmp_path.glob(".context/test-runs/*/results.json")).read_text())
    assert summary["partial"] is True
    assert summary["selected_domains"] == ["alpha"]
    assert summary["total"] == 1
