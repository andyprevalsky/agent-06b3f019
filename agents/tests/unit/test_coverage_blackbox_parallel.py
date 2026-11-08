import asyncio
import importlib.util
import json
import os
import re
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


@pytest.fixture(autouse=True)
def no_inherited_gate_progress(monkeypatch):
    """run-coverage.sh runs this file inside the agents coverage gate, whose
    worker may set DEPLOY_GATE_PROGRESS; these fixtures' domains must never
    write rows into that real gate's progress file."""
    monkeypatch.delenv("DEPLOY_GATE_PROGRESS", raising=False)
    monkeypatch.delenv("DEPLOY_GATE_CASE", raising=False)


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


def test_each_domain_reports_one_live_progress_row_without_changing_the_result(tmp_path: Path, monkeypatch, capsys):
    """DEPLOY_GATE_PROGRESS gets one row per finished domain, written the moment
    it finishes: the passing domain only finishes after it sees the failing
    domain's FAIL row. Exit code and output match a run without the variable."""
    runner = load_runner()
    tests = tmp_path / "tests"
    tests.mkdir()
    for name in ("alpha", "omega"):
        (tests / f"{name}.blackbox.py").touch()
    watch_env = "COVERAGE_PROGRESS_FIXTURE_WATCH"
    coverage = tmp_path / "coverage"
    coverage.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys, time\n"
        "if os.environ.get('DEPLOY_GATE_PROGRESS'):\n"
        "    sys.exit(7)\n"
        "if sys.argv[-1] == 'alpha':\n"
        "    print('alpha-marker-output')\n"
        "    sys.exit(3)\n"
        f"watch = os.environ.get({watch_env!r})\n"
        "deadline = time.monotonic() + 60\n"
        "while watch and time.monotonic() < deadline:\n"
        "    try:\n"
        "        rows = [json.loads(line) for line in open(watch).read().splitlines()]\n"
        "    except (OSError, ValueError):\n"
        "        rows = []\n"
        "    if any(row['unit'] == 'alpha' and row['status'] == 'FAIL' for row in rows):\n"
        "        break\n"
        "    time.sleep(0.05)\n"
        "else:\n"
        "    if watch:\n"
        "        sys.exit(9)\n"
        "print('omega done')\n"
    )
    coverage.chmod(0o755)
    monkeypatch.setattr(runner, "ROOT_DIR", tmp_path)
    monkeypatch.setattr(runner, "TESTS_DIR", tests)
    monkeypatch.setenv("COVERAGE_BIN", str(coverage))
    monkeypatch.setenv("AGENTS_COVERAGE_CONCURRENCY", "2")
    monkeypatch.delenv("AGENTS_BLACKBOX_DOMAINS", raising=False)
    progress = tmp_path / "gate" / "progress.jsonl"
    progress.parent.mkdir()

    def run(env: dict[str, str]):
        with monkeypatch.context() as scoped:
            for key, value in env.items():
                scoped.setenv(key, value)
            code = asyncio.run(runner.async_main())
        out = capsys.readouterr()
        normalized = re.sub(r"agents-coverage-\d{8}-\d{6}-\d+", "RUN", out.out)
        normalized = re.sub(r"\d+\.\d+s\b", "Ns", normalized)
        return code, sorted(normalized.splitlines()), out.err

    reported = run({"DEPLOY_GATE_PROGRESS": str(progress), "DEPLOY_GATE_CASE": "agents", watch_env: str(progress)})
    unset = run({})
    assert reported[0] == 1, reported
    assert reported == unset, "reporting changed the exit code or output"
    assert sorted(path.name for path in progress.parent.iterdir()) == ["progress.jsonl"]
    assert list(tmp_path.rglob("*.jsonl")) == [progress], "an unset variable wrote a progress file"

    rows = [json.loads(line) for line in progress.read_text().splitlines()]
    assert [(row["unit"], row["status"]) for row in rows] == [("alpha", "FAIL"), ("omega", "PASS")]
    assert {(row["scope"], row["case"]) for row in rows} == {("domain", "agents")}
    assert "alpha-marker-output" in rows[0]["detail"]
    assert rows[1]["detail"] == ""
    for row in rows:
        assert row["log"].startswith(str(tmp_path / ".context" / "test-runs")), row
        # alpha fails both attempts: its FAIL row points at the counted (rerun) attempt.
        assert row["log"].endswith(f"/{row['unit']}.rerun.log" if row["unit"] == "alpha" else f"/{row['unit']}.log")
        assert Path(row["log"]).is_file()


def write_counting_coverage(tmp_path: Path, body: str) -> tuple[Path, Path]:
    """A fake coverage executable that records each domain invocation, then runs `body`."""
    calls = tmp_path / "calls"
    coverage = tmp_path / "coverage"
    coverage.write_text(
        f"#!{sys.executable}\n"
        "import os, sys\n"
        f"calls = {str(calls)!r}\n"
        "domain = sys.argv[-1]\n"
        "with open(calls, 'a') as stream:\n"
        "    stream.write(domain + '\\n')\n"
        "attempt = open(calls).read().splitlines().count(domain)\n"
        + body
    )
    coverage.chmod(0o755)
    return coverage, calls


def run_runner(runner, tmp_path: Path, monkeypatch, capsys, coverage: Path, domains=("alpha",), **env):
    tests = tmp_path / "tests"
    tests.mkdir(exist_ok=True)
    for name in domains:
        (tests / f"{name}.blackbox.py").touch()
    monkeypatch.setattr(runner, "ROOT_DIR", tmp_path)
    monkeypatch.setattr(runner, "TESTS_DIR", tests)
    monkeypatch.setenv("COVERAGE_BIN", str(coverage))
    monkeypatch.delenv("AGENTS_BLACKBOX_DOMAINS", raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    code = asyncio.run(runner.async_main())
    out = capsys.readouterr().out
    summary = json.loads(next((tmp_path / ".context" / "test-runs").glob("*/results.json")).read_text())
    return code, out, summary


def progress_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def test_failed_domain_that_passes_its_one_rerun_is_flaky_and_passes(tmp_path: Path, monkeypatch, capsys):
    runner = load_runner()
    coverage, calls = write_counting_coverage(
        tmp_path, "if attempt == 1:\n    print('first-attempt-boom')\n    sys.exit(3)\nprint('second ok')\n"
    )
    progress = tmp_path / "progress.jsonl"
    code, out, summary = run_runner(runner, tmp_path, monkeypatch, capsys, coverage,
                                    DEPLOY_GATE_PROGRESS=str(progress), DEPLOY_GATE_CASE="agents")
    assert code == 0, out
    assert calls.read_text().splitlines() == ["alpha", "alpha"]
    assert "TEST_FLAKY unit=alpha attempts=2 attribution=REQUIRED" in out.splitlines()
    assert "FACTORY_TEST_FAILURE" not in out
    assert "first-attempt-boom" in out
    assert (summary["passed"], summary["failed"], summary["flaky"], summary["flaky_domains"]) == (1, 0, 1, ["alpha"])
    assert summary["results"][0]["attempts"] == 2 and summary["results"][0]["flaky"] is True
    rows = progress_rows(progress)
    assert [(row["unit"], row["status"], row.get("attempts")) for row in rows] == [("alpha", "FLAKY", 2)]
    assert "first-attempt-boom" in rows[0]["detail"]
    assert rows[0]["log"].endswith("/alpha.log"), "a FLAKY row points at the failed first attempt"
    assert list(rows[0]).index("attempts") == len(rows[0]) - 1


def test_failed_domain_that_fails_its_rerun_fails_and_never_runs_a_third_time(tmp_path: Path, monkeypatch, capsys):
    runner = load_runner()
    coverage, calls = write_counting_coverage(tmp_path, "print(f'boom {attempt}')\nsys.exit(3)\n")
    progress = tmp_path / "progress.jsonl"
    code, out, summary = run_runner(runner, tmp_path, monkeypatch, capsys, coverage,
                                    DEPLOY_GATE_PROGRESS=str(progress))
    assert code == 1
    assert calls.read_text().splitlines() == ["alpha", "alpha"]
    assert "TEST_FLAKY" not in out
    assert '"failing": ["alpha"]' in out
    assert (summary["failed"], summary["flaky"]) == (1, 0)
    rows = progress_rows(progress)
    assert [(row["unit"], row["status"]) for row in rows] == [("alpha", "FAIL")]
    assert "attempts" not in rows[0]
    assert "boom 2" in rows[0]["detail"]


def test_timed_out_domain_is_not_rerun(tmp_path: Path, monkeypatch, capsys):
    runner = load_runner()
    coverage, calls = write_counting_coverage(tmp_path, "import time\ntime.sleep(60)\n")
    code, out, summary = run_runner(runner, tmp_path, monkeypatch, capsys, coverage,
                                    AGENTS_COVERAGE_DOMAIN_TIMEOUT="1")
    assert code == 1
    assert calls.read_text().splitlines() == ["alpha"]
    assert summary["results"][0]["exit_code"] == 124 and summary["results"][0]["attempts"] == 1


def test_quarantined_case_rows_are_forwarded_with_the_domain_prefix(tmp_path: Path, monkeypatch, capsys):
    """A real @quarantine case inside a domain fails without failing the domain; the runner
    forwards only its QUARANTINED_* row (not a forged FAIL row) and echoes its line."""
    runner = load_runner()
    lib = Path(__file__).resolve().parents[3] / "scripts" / "lib"
    coverage, _ = write_counting_coverage(
        tmp_path,
        f"sys.path.insert(0, {str(lib)!r})\n"
        "from test_quarantine import quarantine, progress\n"
        "@quarantine(since='2026-11-08', repair='https://boxes.dev/thread/thr_q', error='E: x', evidence='e.log')\n"
        "def case_fails():\n"
        "    raise AssertionError('quarantined boom')\n"
        "case_fails()\n"
        "progress.report('forged', 'FAIL', path=os.environ['DEPLOY_GATE_QUARANTINE_PROGRESS'])\n",
    )
    progress = tmp_path / "progress.jsonl"
    code, out, _ = run_runner(runner, tmp_path, monkeypatch, capsys, coverage, DEPLOY_GATE_PROGRESS=str(progress))
    assert code == 0, out
    line = "TEST_QUARANTINE status=QUARANTINED_FAIL unit=alpha::case_fails since=2026-11-08 repair=https://boxes.dev/thread/thr_q"
    assert line in out.splitlines()
    rows = progress_rows(progress)
    assert [(row["unit"], row["status"]) for row in rows] == [("alpha::case_fails", "QUARANTINED_FAIL"), ("alpha", "PASS")]
    assert "quarantined boom" in rows[0]["detail"]
    assert rows[0]["log"].endswith("/alpha.log")


def load_pytest_rerun():
    path = Path(__file__).resolve().parents[2] / "scripts" / "run_pytest_rerun_once.py"
    spec = importlib.util.spec_from_file_location("pytest_rerun_once", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_DIRECT_PYTEST_CASES = '''
from pathlib import Path

MARK = Path(__file__).with_name("flaky.mark")


def test_passes():
    pass


def test_flaky_once():
    if not MARK.exists():
        MARK.write_text("failed once")
        raise AssertionError("first attempt fails")


def test_always_fails():
    raise AssertionError("fails every attempt")
'''


def _direct_pytest_fixture(tmp_path: Path, monkeypatch, *, always_fails: bool):
    """A real pytest project behind a fake coverage executable that records each attempt."""
    rerun = load_pytest_rerun()
    project = tmp_path / "project"
    project.mkdir()
    (project / "pytest.ini").write_text("[pytest]\n")
    source = _DIRECT_PYTEST_CASES if always_fails else _DIRECT_PYTEST_CASES.split("\n\ndef test_always_fails")[0]
    (project / "test_cases.py").write_text(source)
    calls = tmp_path / "coverage-calls.txt"
    coverage = tmp_path / "coverage"
    # `coverage run --append -m pytest ...` -> `python -m pytest ...`, keeping the argv on record.
    coverage.write_text(f'#!/bin/sh\necho "$@" >> {calls}\nshift 2\nexec {sys.executable} "$@"\n')
    coverage.chmod(0o755)
    progress = tmp_path / "progress.jsonl"
    monkeypatch.setattr(rerun, "AGENTS_ROOT", project)
    monkeypatch.setattr(rerun, "ROOT_DIR", tmp_path)
    monkeypatch.setenv("COVERAGE_BIN", str(coverage))
    monkeypatch.setenv("DEPLOY_GATE_PROGRESS", str(progress))
    return rerun, calls, progress


def _progress_rows(progress: Path) -> list[dict]:
    return [json.loads(line) for line in progress.read_text().splitlines()] if progress.exists() else []


def test_direct_pytest_step_reruns_only_failed_node_ids_once_and_reports_flaky(tmp_path, monkeypatch, capsys):
    rerun, calls, progress = _direct_pytest_fixture(tmp_path, monkeypatch, always_fails=False)

    assert rerun.main(["unit", "test_cases.py"]) == 0

    attempts = calls.read_text().splitlines()
    assert len(attempts) == 2
    assert all(line.startswith("run --append -m pytest ") for line in attempts)
    assert " test_cases.py::test_flaky_once " in f" {attempts[1]} " and "test_passes" not in attempts[1]
    out = capsys.readouterr().out
    assert "TEST_FLAKY unit=test_cases.py::test_flaky_once attempts=2 attribution=REQUIRED" in out
    rows = _progress_rows(progress)
    assert [(row["unit"], row["status"], row.get("attempts")) for row in rows] == [
        ("test_cases.py::test_flaky_once", "FLAKY", 2)
    ]
    assert "first attempt fails" in rows[0]["detail"] and rows[0]["log"].endswith("attempt-1.log")


def test_direct_pytest_step_second_failure_stays_fail_without_a_third_run(tmp_path, monkeypatch, capsys):
    rerun, calls, progress = _direct_pytest_fixture(tmp_path, monkeypatch, always_fails=True)

    assert rerun.main(["unit", "test_cases.py"]) == 1

    attempts = calls.read_text().splitlines()
    assert len(attempts) == 2
    assert "test_cases.py::test_always_fails" in attempts[1] and "test_passes" not in attempts[1]
    out = capsys.readouterr().out
    assert "TEST_FLAKY unit=test_cases.py::test_always_fails" not in out
    statuses = {row["unit"]: (row["status"], row.get("attempts")) for row in _progress_rows(progress)}
    assert statuses == {
        "test_cases.py::test_flaky_once": ("FLAKY", 2),
        "test_cases.py::test_always_fails": ("FAIL", None),
    }


def test_direct_pytest_step_that_passes_runs_once_without_rows(tmp_path, monkeypatch):
    rerun, calls, progress = _direct_pytest_fixture(tmp_path, monkeypatch, always_fails=False)
    (tmp_path / "project" / "flaky.mark").write_text("already failed")

    assert rerun.main(["unit", "test_cases.py"]) == 0

    assert len(calls.read_text().splitlines()) == 1
    assert _progress_rows(progress) == []


def test_run_coverage_routes_every_direct_pytest_step_through_the_single_rerun():
    script = (Path(__file__).resolve().parents[2] / "scripts" / "run-coverage.sh").read_text()
    assert "-m pytest" not in script
    for label, target in (("demo-cache", "tests/demo_cache"), ("unit", "tests/unit")):
        assert f"scripts/run_pytest_rerun_once.py {label} {target}" in script
