"""Offline ownership and complete-log preservation at worker retirement."""

import argparse
import importlib.util
import io
import json
import os
import subprocess
import sys
import tarfile
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/cloudbench-worker-evidence.py"
WRAPPER = ROOT / "scripts/cloudbench-worker.sh"


def test_worker_wrapper_supervises_before_bootstrap(tmp_path):
    """Even a bootstrap failure must enter the evidence lifecycle first."""
    probe = tmp_path / "supervisor.py"
    receipt = tmp_path / "called.json"
    probe.write_text(
        "import json,os,sys\nopen(os.environ['PROBE_RECEIPT'],'w').write(json.dumps(sys.argv[1:]))\nsys.exit(42)\n"
    )
    environment = os.environ.copy()
    environment.update(
        CLOUDBENCH_WORKER_RUN_TOKEN="owned-run",
        CLOUDBENCH_WORKER_MACHINE_ID="1234abcd",
        CLOUDBENCH_WORKER_EVIDENCE_HELPER=str(probe),
        PROBE_RECEIPT=str(receipt),
    )
    environment.pop("CLOUDBENCH_WORKER_SUPERVISED", None)
    result = subprocess.run(["bash", str(WRAPPER)], env=environment, capture_output=True, timeout=10)
    assert receipt.exists(), "worker bootstrap escaped the evidence supervisor"
    assert result.returncode == 42
    assert json.loads(receipt.read_text()) == [
        "run",
        "--run-token",
        "owned-run",
        "--machine-id",
        "1234abcd",
        "--",
        "bash",
        str(WRAPPER),
    ]


def load_helper():
    spec = importlib.util.spec_from_file_location("worker_evidence", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_bundle(tmp_path):
    helper = load_helper()
    data = tmp_path / "data"
    agents = tmp_path / "agents"
    data.mkdir()
    agents.mkdir()
    state = data / "cloudbench-worker-evidence"
    state.mkdir()
    expected = helper.authority("owned-run", "1234abcd")
    owner = {
        **expected,
        "supervisor": {"pid": 2147483646, "birth": "linux:11111111-1111-1111-1111-111111111111:1"},
        "agents_dir": str(agents),
        "primary_log": str(agents / "navi-worker-log.txt"),
        "expected_worker_logs": ["navi-worker-log.txt", "navi-worker-log.1.txt"],
    }
    terminal = {
        **expected,
        "supervisor": owner["supervisor"],
        "child": {"pid": 2147483645, "birth": "linux:11111111-1111-1111-1111-111111111111:2"},
        "exit_code": 0,
        "stop_requested": True,
        "term_sent": True,
        "quiescent": True,
        "children_reaped": True,
        "streams_closed": True,
        "worker_started": True,
        "adopted_children": [],
    }
    helper.write_json(state / "owner.json", owner)
    helper.write_json(state / "terminal.json", terminal)
    (data / "worker.log").write_bytes(b"full bootstrap\nfull primary mirror\nfinal stdout\n")
    for name in owner["expected_worker_logs"]:
        (agents / name).write_bytes((name + "\nfinal recording finished\n").encode())
    return helper, data, agents, state, expected


def capture_fixture(tmp_path, monkeypatch):
    helper, data, agents, state, expected = make_bundle(tmp_path)
    monkeypatch.setenv("FLY_MACHINE_ID", expected["machine_id"])
    archive = tmp_path / "evidence.tar"
    args = argparse.Namespace(
        **{k: expected[k] for k in ("run_token", "machine_id")}, data_dir=str(data), output=str(archive)
    )
    helper.capture(args)
    return helper, archive, data, agents, state, expected


def test_worker_capture_complete_and_repeat_verification(tmp_path, monkeypatch):
    helper, archive, data, agents, state, expected = capture_fixture(tmp_path, monkeypatch)
    output = tmp_path / "capture"
    manifest = helper.check_archive(archive, expected, output)
    assert manifest["worker_logs"] == ["navi-worker-log.1.txt", "navi-worker-log.txt"]
    assert (output / "logs/worker.log").read_bytes() == (data / "worker.log").read_bytes()
    for path in agents.iterdir():
        assert (output / "logs/agents" / path.name).read_bytes() == path.read_bytes()
    assert helper.check_archive(archive, expected, output) == manifest
    archive.unlink()
    assert helper.verify_directory(output, expected) == manifest


@pytest.mark.parametrize(
    "defect",
    [
        "wrong-run",
        "wrong-machine",
        "missing-terminal",
        "missing-log",
        "unclosed-stream",
        "wrong-supervisor",
        "native-machine",
        "symlink-log",
        "oversize",
    ],
)
def test_worker_capture_rejects_incomplete_or_unowned(tmp_path, monkeypatch, defect):
    helper, data, agents, state, expected = make_bundle(tmp_path)
    monkeypatch.setenv("FLY_MACHINE_ID", expected["machine_id"])
    args = argparse.Namespace(
        run_token=expected["run_token"],
        machine_id=expected["machine_id"],
        data_dir=str(data),
        output=str(tmp_path / "rejected.tar"),
    )
    if defect == "wrong-run":
        args.run_token = "other-run"
    elif defect == "wrong-machine":
        args.machine_id = "abcdef12"
    elif defect == "missing-terminal":
        (state / "terminal.json").unlink()
    elif defect == "missing-log":
        (agents / "navi-worker-log.1.txt").unlink()
    elif defect in ("unclosed-stream", "wrong-supervisor"):
        terminal = json.loads((state / "terminal.json").read_bytes())
        if defect == "unclosed-stream":
            terminal["streams_closed"] = False
        else:
            terminal["supervisor"]["birth"] = "linux:other:1"
        (state / "terminal.json").write_text(json.dumps(terminal))
    elif defect == "native-machine":
        monkeypatch.setenv("FLY_MACHINE_ID", "abcdef12")
    elif defect == "symlink-log":
        path = agents / "navi-worker-log.1.txt"
        path.unlink()
        path.symlink_to(agents / "navi-worker-log.txt")
    elif defect == "oversize":
        monkeypatch.setattr(helper, "MAX_BYTES", 32)
    with pytest.raises((ValueError, FileNotFoundError)):
        helper.capture(args)
    assert not Path(args.output).exists()
    assert (data / "worker.log").exists()


def test_worker_capture_mutation_fails_without_deleting_source(tmp_path, monkeypatch):
    helper = load_helper()
    source = tmp_path / "source.log"
    source.write_bytes(b"before\n")
    actual_open = Path.open

    class MutatingWriter:
        def __init__(self, stream):
            self.stream = stream
            self.mutated = False

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return self.stream.__exit__(*exc)

        def write(self, block):
            if not self.mutated:
                self.mutated = True
                with actual_open(source, "ab") as changed:
                    changed.write(b"late\n")
            return self.stream.write(block)

    def opened(path, mode="r", *args, **kwargs):
        result = actual_open(path, mode, *args, **kwargs)
        return MutatingWriter(result) if mode == "xb" else result

    monkeypatch.setattr(Path, "open", opened)
    with pytest.raises(ValueError, match="mutated"):
        helper.stable_copy(source, tmp_path / "destination")
    assert source.read_bytes() == b"before\nlate\n"


@pytest.mark.parametrize("defect", ["bytes", "extra", "missing", "symlink", "terminal", "identity"])
def test_worker_verified_directory_detects_changes(tmp_path, monkeypatch, defect):
    helper, archive, data, agents, state, expected = capture_fixture(tmp_path, monkeypatch)
    output = tmp_path / "capture"
    helper.check_archive(archive, expected, output)
    if defect == "bytes":
        (output / "logs/worker.log").write_bytes(b"changed")
    elif defect == "extra":
        (output / "extra.log").touch()
    elif defect == "missing":
        (output / "logs/agents/navi-worker-log.1.txt").unlink()
    elif defect == "symlink":
        path = output / "logs/worker.log"
        path.unlink()
        path.symlink_to(data / "worker.log")
    elif defect == "terminal":
        (output / "receipts/terminal.json").write_text("{}")
    else:
        expected = {**expected, "run_token": "other-run"}
    with pytest.raises((ValueError, FileNotFoundError)):
        helper.verify_directory(output, expected)
    with pytest.raises((ValueError, FileNotFoundError)):
        helper.check_archive(archive, expected, output)


@pytest.mark.parametrize("kind", ["traversal", "duplicate", "symlink", "unlisted", "digest"])
def test_worker_archive_rejects_untrusted_entries_before_output(tmp_path, monkeypatch, kind):
    helper, archive, data, agents, state, expected = capture_fixture(tmp_path, monkeypatch)
    malformed = tmp_path / "malformed.tar"
    with tarfile.open(archive) as source, tarfile.open(malformed, "w") as target:
        for entry in source:
            block = source.extractfile(entry).read()
            if kind == "digest" and entry.name == "logs/worker.log":
                block = b"X" * len(block)
            target.addfile(entry, io.BytesIO(block))
        if kind != "digest":
            name = {
                "traversal": "../escaped",
                "duplicate": "logs/worker.log",
                "symlink": "linked",
                "unlisted": "extra",
            }[kind]
            extra = tarfile.TarInfo(name)
            if kind == "symlink":
                extra.type = tarfile.SYMTYPE
                extra.linkname = "/etc/passwd"
            target.addfile(extra, io.BytesIO())
    output = tmp_path / "capture"
    with pytest.raises(ValueError):
        helper.check_archive(malformed, expected, output)
    assert not output.exists()


def test_worker_stop_request_bound_and_deadline_retains_files(tmp_path, monkeypatch):
    helper, data, agents, state, expected = make_bundle(tmp_path)
    monkeypatch.setenv("FLY_MACHINE_ID", expected["machine_id"])
    (state / "terminal.json").unlink()
    owner = json.loads((state / "owner.json").read_bytes())
    owner["supervisor"] = {"pid": os.getpid(), "birth": helper.identity(os.getpid())}
    (state / "owner.json").write_text(json.dumps(owner))
    monkeypatch.setattr(helper, "CAPTURE_SECONDS", 0)
    with pytest.raises(ValueError, match="deadline"):
        helper.capture_owned(
            argparse.Namespace(
                run_token="owned-run", machine_id="1234abcd", data_dir=str(data), output=str(tmp_path / "out.tar")
            )
        )
    request = json.loads((state / "stop.json").read_bytes())
    assert request == {**expected, "supervisor": owner["supervisor"]}
    assert (data / "worker.log").exists()
    assert not (tmp_path / "out.tar").exists()


def test_worker_native_supervisor_closes_every_log_before_terminal(tmp_path):
    """Actual Linux subreaper + unchanged local worker supervisor, no providers.

    On Darwin the production helper must reject unsupported supervision. The
    same owning test executes the full descendant lifecycle in the Linux gate.
    """
    data = tmp_path / "data"
    agents = tmp_path / "agents"
    data.mkdir()
    agents.mkdir()
    env = dict(os.environ, FLY_MACHINE_ID="1234abcd", WORKER_PROCESSES="2")
    command = [
        sys.executable,
        str(HELPER),
        "run",
        "--run-token",
        "owned-run",
        "--machine-id",
        "1234abcd",
        "--data-dir",
        str(data),
        "--agents-dir",
        str(agents),
        "--",
    ]
    if sys.platform != "linux":
        result = subprocess.run(
            command + [sys.executable, "-c", "raise RuntimeError('must not start')"],
            env=env,
            capture_output=True,
            timeout=5,
        )
        assert result.returncode == 1
        assert b"requires Linux subreaping" in result.stderr
        assert not (data / "cloudbench-worker-evidence/owner.json").exists()
        return
    import shutil

    scripts = agents / "scripts"
    scripts.mkdir()
    helpers = agents / "helpers"
    helpers.mkdir()
    shutil.copyfile(ROOT / "agents/scripts/local_worker_supervisor.py", scripts / "local_worker_supervisor.py")
    shutil.copyfile(ROOT / "agents/helpers/generation_handoff.py", helpers / "generation_handoff.py")
    (agents / "worker.py").write_text(
        "import os,signal,time,sys\n"
        "def stop(*args):\n"
        " print('FINAL-ONE-TERM',flush=True)\n"
        " sys.exit(0)\n"
        "signal.signal(signal.SIGTERM,stop)\n"
        "print('START-'+os.environ['WORKER_INDEX'],flush=True)\n"
        "while True: time.sleep(.02)\n"
    )
    ready = tmp_path / "ready"
    ready.touch()
    env["WORKER_READY_FILE"] = str(ready)
    process = subprocess.Popen(
        command + [sys.executable, str(scripts / "local_worker_supervisor.py")],
        env=env,
        cwd=agents,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 10
        logs = [agents / "navi-worker-log.txt", agents / "navi-worker-log.1.txt"]
        while not all(p.exists() and b"START" in p.read_bytes() for p in logs):
            assert process.poll() is None
            assert time.monotonic() < deadline
            time.sleep(0.02)
        archive = tmp_path / "capture.tar"
        result = subprocess.run(
            [
                sys.executable,
                str(HELPER),
                "capture",
                "--run-token",
                "owned-run",
                "--machine-id",
                "1234abcd",
                "--data-dir",
                str(data),
                "--output",
                str(archive),
            ],
            env=env,
            capture_output=True,
            timeout=15,
        )
        assert result.returncode == 0, result.stderr.decode()
        assert process.wait(timeout=5) == 0
        helper = load_helper()
        manifest = helper.check_archive(archive, helper.authority("owned-run", "1234abcd"))
        assert manifest["terminal"]["term_sent"] is True
        for path in logs:
            assert path.read_bytes().count(b"FINAL-ONE-TERM") == 1
    finally:
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=10)
        process.stderr.close()


@pytest.mark.parametrize("error", [PermissionError("denied"), ValueError("malformed native identity")])
def test_worker_unknown_process_identity_cannot_prove_retirement(tmp_path, monkeypatch, error):
    helper, data, agents, state, expected = make_bundle(tmp_path)
    monkeypatch.setenv("FLY_MACHINE_ID", expected["machine_id"])
    owner = json.loads((state / "owner.json").read_bytes())
    owner["supervisor"] = {"pid": os.getpid(), "birth": helper.identity(os.getpid())}
    (state / "owner.json").write_text(json.dumps(owner))

    def unreadable(_pid):
        raise error

    monkeypatch.setattr(helper, "identity", unreadable)
    archive = tmp_path / "refused.tar"
    with pytest.raises(type(error)):
        helper.capture(
            argparse.Namespace(run_token="owned-run", machine_id="1234abcd", data_dir=str(data), output=str(archive))
        )
    assert not archive.exists()
    assert (data / "worker.log").exists()


def test_worker_verified_directory_rejects_large_sparse_file_before_read(tmp_path, monkeypatch):
    helper, archive, data, agents, state, expected = capture_fixture(tmp_path, monkeypatch)
    output = tmp_path / "capture"
    helper.check_archive(archive, expected, output)
    with (output / "logs/worker.log").open("r+b") as stream:
        stream.truncate(helper.MAX_BYTES + 1)
    with pytest.raises(ValueError, match="size mismatch"):
        helper.verify_directory(output, expected)


@pytest.mark.parametrize("scenario", ["orphan-writer", "late-journal-failure"])
def test_worker_linux_adopted_child_and_diagnostic_stream(tmp_path, scenario):
    helper = load_helper()
    if sys.platform != "linux":
        with pytest.raises(ValueError, match="requires Linux"):
            helper.enable_subreaper()
        return
    data = tmp_path / "data"
    agents = tmp_path / "agents"
    data.mkdir()
    agents.mkdir()
    marker = tmp_path / "orphan-started"
    env = dict(os.environ, FLY_MACHINE_ID="1234abcd", WORKER_PROCESSES="1")
    args = [
        "run",
        "--run-token",
        "owned-run",
        "--machine-id",
        "1234abcd",
        "--data-dir",
        str(data),
        "--agents-dir",
        str(agents),
        "--",
    ]
    if scenario == "orphan-writer":
        child = (
            "import os,time;from pathlib import Path\n"
            "Path('navi-worker-log.txt').write_text('INITIAL\\n')\n"
            "pid=os.fork()\n"
            "if pid == 0:\n"
            " os.setsid()\n"
            f" Path({str(marker)!r}).write_text(str(os.getpid()))\n"
            " time.sleep(.5)\n"
            " with open('navi-worker-log.txt','a') as f: f.write('FINAL-ORPHAN\\n')\n"
            " print('FINAL-ORPHAN-STDOUT',flush=True)\n"
            " os._exit(0)\n"
            "print('PRIMARY-EXIT',flush=True)\n"
        )
        command = [sys.executable, str(HELPER), *args, sys.executable, "-c", child]
    else:
        # Actual launch-shell truncate descriptor, followed by child append.
        # A failing journal write must append diagnostics, preserving PREFIX.
        shim = (
            "import runpy,sys\n"
            f"m=runpy.run_path({str(HELPER)!r});g=m['main'].__globals__\n"
            "original=g['write_json']\n"
            "def write(path,value):\n"
            " if path.name=='terminal.json': raise ValueError('INJECTED JOURNAL FAILURE')\n"
            " return original(path,value)\n"
            "g['write_json']=write\n"
            f"sys.argv=[{str(HELPER)!r},*{args!r},sys.executable,'-c',\"print('PREFIX-MUST-SURVIVE',flush=True)\"]\n"
            "raise SystemExit(m['main']())\n"
        )
        command = [sys.executable, "-c", shim]
    with (data / "worker.log").open("wb") as launch_stream:
        process = subprocess.Popen(command, env=env, cwd=agents, stdout=launch_stream, stderr=subprocess.STDOUT)
    try:
        if scenario == "orphan-writer":
            deadline = time.monotonic() + 5
            while not marker.exists():
                assert process.poll() is None
                assert time.monotonic() < deadline
                time.sleep(0.01)
            assert not (data / "cloudbench-worker-evidence/terminal.json").exists()
            assert process.wait(timeout=10) == 0
            terminal = helper.read_json(data / "cloudbench-worker-evidence/terminal.json")
            assert terminal["children_reaped"] is True
            assert len(terminal["adopted_children"]) == 1
            assert terminal["adopted_children"][0]["pid"] == int(marker.read_text())
            assert (agents / "navi-worker-log.txt").read_text().endswith("FINAL-ORPHAN\n")
            assert b"FINAL-ORPHAN-STDOUT" in (data / "worker.log").read_bytes()
        else:
            assert process.wait(timeout=10) == 1
            assert not (data / "cloudbench-worker-evidence/terminal.json").exists()
            assert (data / "worker.log").read_bytes().startswith(b"PREFIX-MUST-SURVIVE\n")
            assert b"INJECTED JOURNAL FAILURE" in (data / "worker.log").read_bytes()
    finally:
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=10)


@pytest.mark.parametrize("retained", ["empty-admission", "completed-owner"])
def test_worker_repeated_launch_preserves_old_owner_and_never_starts_child(tmp_path, retained):
    data = tmp_path / "data"
    agents = tmp_path / "agents"
    data.mkdir()
    agents.mkdir()
    state = data / "cloudbench-worker-evidence"
    state.mkdir()
    old = b'{"run_token":"prior-owned-run","retained":true}\n'
    if retained == "completed-owner":
        (state / "owner.json").write_bytes(old)
        (state / "terminal.json").write_bytes(old)
    marker = tmp_path / "must-not-run"
    environment = dict(os.environ, FLY_MACHINE_ID="1234abcd")
    result = subprocess.run(
        [
            sys.executable,
            str(HELPER),
            "run",
            "--run-token",
            "owned-run",
            "--machine-id",
            "1234abcd",
            "--data-dir",
            str(data),
            "--agents-dir",
            str(agents),
            "--",
            sys.executable,
            "-c",
            f"from pathlib import Path;Path({str(marker)!r}).touch()",
        ],
        env=environment,
        capture_output=True,
        timeout=5,
    )
    assert result.returncode == 1
    assert b"File exists" in result.stderr
    assert not marker.exists()
    assert not (data / "worker.log").exists()
    if retained == "completed-owner":
        assert (state / "owner.json").read_bytes() == old
        assert (state / "terminal.json").read_bytes() == old
    else:
        assert not list(state.iterdir())


@pytest.mark.parametrize("boundary", ["archive", "extracted-files", "existing-files", "directory"])
def test_worker_durability_failure_cannot_acknowledge_capture(tmp_path, monkeypatch, boundary):
    import stat

    helper, data, agents, state, expected = make_bundle(tmp_path)
    monkeypatch.setenv("FLY_MACHINE_ID", expected["machine_id"])
    archive = tmp_path / "evidence.tar"
    output = tmp_path / "capture"
    args = argparse.Namespace(run_token="owned-run", machine_id="1234abcd", data_dir=str(data), output=str(archive))
    if boundary != "archive":
        helper.capture(args)
    if boundary in ("existing-files", "directory"):
        helper.check_archive(archive, expected, output)
    original = os.fsync

    def failed_sync(fd):
        info = os.fstat(fd)
        if boundary == "archive":
            fail = archive.exists() and info.st_ino == archive.stat().st_ino
        elif boundary == "directory":
            fail = stat.S_ISDIR(info.st_mode)
        elif boundary == "extracted-files":
            target = output / "logs/worker.log"
            fail = target.exists() and (info.st_dev, info.st_ino) == (target.stat().st_dev, target.stat().st_ino)
        else:
            fail = stat.S_ISREG(info.st_mode)
        if fail:
            raise OSError("injected durability barrier failure")
        return original(fd)

    monkeypatch.setattr(helper.os, "fsync", failed_sync)
    with pytest.raises(OSError, match="durability barrier"):
        if boundary == "archive":
            helper.capture(args)
        elif boundary == "extracted-files":
            helper.check_archive(archive, expected, output)
        else:
            helper.verify_directory(output, expected)
    assert (data / "worker.log").exists()
    assert all((agents / name).exists() for name in ("navi-worker-log.txt", "navi-worker-log.1.txt"))


def test_worker_capture_outer_deadline_interrupts_blocked_inner_operation(monkeypatch):
    import signal

    helper = load_helper()
    monkeypatch.setattr(helper, "CAPTURE_SECONDS", 0.01)
    monkeypatch.setattr(helper, "capture_owned", lambda _args: time.sleep(1))
    before = signal.getsignal(signal.SIGALRM)
    started = time.monotonic()
    with pytest.raises(TimeoutError, match="deadline"):
        helper.capture(None)
    assert time.monotonic() - started < 0.5
    assert signal.getsignal(signal.SIGALRM) == before
    assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)
