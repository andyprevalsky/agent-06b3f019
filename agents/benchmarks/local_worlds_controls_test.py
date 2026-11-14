"""Coordinator controls at its child boundary; no services, provider, DB, or paid work."""

from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from benchmarks import local, local_worlds

AGENTS_DIR = Path(__file__).resolve().parents[1]

SETUP = "agent-payment-setup-resume"
ABANDON = "agent-payment-abandonment"


class CoordinatorFixture:
    """Real coordinator/receipt validators; deterministic child lifecycle and files."""

    def __init__(self, root: Path, *, fault: str | None = None, cancel: bool = False, stack_version: str = "1"):
        self.root = root
        self.fault = fault
        self.cancel = cancel
        self.stack_version = stack_version
        self.processes = []
        self.events = []
        self.max_live = 0
        self.signals = []
        self.api = SimpleNamespace(
            AGENTS_DIR=local.AGENTS_DIR,
            BENCHMARK_CONTEXT_ROOT=root,
            make_run_id=lambda value: value or "control",
            _benchmark_python=lambda: sys.executable,
            _owned_shutdown_timeout=lambda: 1,
            _process_identity_tools=lambda: {"current_identity": self.identity},
            _pid_is_alive=lambda pid: self.fault in {"live-stack", "unreadable-live-stack"} and pid == 900001,
            _signal_owned_process=self.send_signal,
            _write_owner_record=self.write_record,
            _read_cleanup_receipt=local._read_cleanup_receipt,
            _validate_stack_cleanup_receipt=local._validate_stack_cleanup_receipt,
            failed_tasks_from_run=local.failed_tasks_from_run,
            service_base_environ=local.service_base_environ,
        )

    def write_record(self, path, value):
        if self.fault == "journal-failure" and any(row.get("status") == "running" for row in value.get("tasks", [])):
            raise OSError("injected owner journal publication failure")
        local._write_owner_record(path, value)

    def identity(self, pid):
        if pid == os.getpid():
            return "fixture-coordinator"
        if self.fault == "identity-failure" and pid == 800001:
            raise OSError("injected child native identity failure")
        for process in self.processes:
            if process.pid == pid and process.returncode is None:
                return f"fixture-child-{pid}"
        if self.fault == "live-stack" and pid == 900001:
            return "fixture-stack"
        raise OSError("fixture process absent")

    def send_signal(self, process, identity, signum):
        assert identity == f"fixture-child-{process.pid}"
        self.signals.append((process.pid, signum))
        process.finish(143)

    def publish(self, process, code):
        context = self.root / process.run_id
        context.mkdir(parents=True, exist_ok=True)
        token = "fixture-benchmark-token"
        receipt = context / "benchmark-cleanup.status"
        receipt.write_text(f"version=1\ntoken={token}\nstate=clean\n")
        owner = {
            "version": 1,
            "run_id": process.run_id,
            "state": "cleanup_verified",
            "pid": process.pid + 1000,
            "native_identity": "fixture-benchmark",
            "token": token,
            "receipt": str(receipt),
        }
        stack = {
            "version": 1,
            "run_id": process.run_id,
            "pid": 900001,
            "native_identity": "fixture-stack",
            "birth": "fixture-birth",
            "token": "fixture-stack-token",
        }
        stack_receipt = context / "local-stack-cleanup.status"
        stack_receipt.write_text(
            f"version={self.stack_version}\ntoken=fixture-stack-token\nstate=clean\nstack_pid=900001\nstack_birth=fixture-birth\n"
            + ("stack_native_identity=fixture-stack\n" if self.stack_version == "2" else "")
        )
        passed = self.fault not in {"failed-task", "false-zero"} or process.ordinal != 0
        result = context / "result.json"
        result.write_text(
            json.dumps(
                {"tasks": [{"name": process.task, "passed": passed, "status": "PASSED" if passed else "FAILED"}]}
            )
        )
        index = {
            "version": 1,
            "run_id": process.run_id,
            "results": [{"path": str(result), "sha256": hashlib.sha256(result.read_bytes()).hexdigest()}],
        }
        if process.ordinal == 0:
            if self.fault == "missing-cleanup":
                receipt.unlink()
            elif self.fault == "wrong-cleanup-token":
                receipt.write_text("version=1\ntoken=foreign\nstate=clean\n")
            elif self.fault == "foreign-benchmark-owner":
                owner["run_id"] = "foreign-world"
            elif self.fault == "foreign-stack-owner":
                stack["run_id"] = "foreign-world"
            elif self.fault == "wrong-stack-pid":
                stack_receipt.write_text(stack_receipt.read_text().replace("900001", "900002"))
            elif self.fault == "wrong-stack-birth":
                stack_receipt.write_text(stack_receipt.read_text().replace("fixture-birth", "foreign-birth"))
            elif self.fault == "missing-stack-native":
                stack_receipt.write_text(stack_receipt.read_text().replace("stack_native_identity=fixture-stack\n", ""))
            elif self.fault == "foreign-stack-native":
                stack_receipt.write_text(
                    stack_receipt.read_text().replace("stack_native_identity=fixture-stack", "stack_native_identity=foreign")
                )
            elif self.fault == "malformed-stack-receipt":
                stack_receipt.write_text(stack_receipt.read_text() + "stack_pid=900001\n")
            elif self.fault == "wrong-stack-token":
                stack_receipt.write_text(stack_receipt.read_text().replace("token=fixture-stack-token", "token=foreign"))
            elif self.fault == "v2-benchmark-receipt":
                receipt.write_text(receipt.read_text().replace("version=1", "version=2"))
            elif self.fault == "foreign-result-index":
                index["run_id"] = "foreign-world"
            elif self.fault == "changed-result":
                result.write_text(result.read_text() + "\n")
        for name, value in [
            ("local-benchmark-owner.json", owner),
            ("local-stack-owner.json", stack),
            ("local-benchmark-results.json", index),
        ]:
            local._write_owner_record(context / name, value)

    def popen(self, command, **kwargs):
        fixture = self

        class Child:
            def __init__(self):
                self.pid = 800001 + len(fixture.processes)
                self.ordinal = int(command[command.index("--run-id") + 1].rsplit("-", 1)[1])
                self.returncode = None
                self.polls = 0
                self.admitted = False
                self.command = list(command)
                self.task = command[3]
                self.run_id = command[command.index("--run-id") + 1]
                # Keep the modeled child's inherited read ends alive across parent
                # pipe publication. No actual OS child or resource allocation occurs.
                self.descriptors = [os.dup(fd) for fd in kwargs.get("pass_fds", ())]
                fixture.processes.append(self)
                fixture.events.append(("start", self.task, self.ordinal))
                fixture.max_live = max(fixture.max_live, sum(p.returncode is None for p in fixture.processes))
                if fixture.cancel and self.ordinal == 0:
                    signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)

            def finish(self, code):
                if self.returncode is not None:
                    return
                fixture.publish(self, code)
                self.returncode = code
                fixture.events.append(("end", self.task, self.ordinal))
                for fd in self.descriptors:
                    os.close(fd)
                self.descriptors.clear()

            def poll(self):
                if not self.admitted and self.returncode is None:
                    assert len(self.descriptors) == 1, "child must inherit one ownership gate"
                    payload = os.read(self.descriptors[0], 2)
                    if payload == b"":
                        self.returncode = 2
                        fixture.events.append(("unadmitted", self.task, self.ordinal))
                        return self.returncode
                    assert payload == b"1"
                    journal = json.loads((fixture.root / "control-worlds" / "local-worlds.json").read_text())
                    row = journal["tasks"][self.ordinal]
                    assert row["pid"] == self.pid and row["native_identity"] == f"fixture-child-{self.pid}"
                    assert row["status"] == "running", "work admitted before durable ownership"
                    self.admitted = True
                self.polls += 1
                if self.returncode is None and self.polls >= 3:
                    code = 1 if self.ordinal == 0 and fixture.fault in {"failed-task", "post-run-failure"} else 0
                    self.finish(code)
                return self.returncode

            def wait(self, timeout=None):
                assert self.returncode is not None, "coordinator waited before child completion"
                return self.returncode

        return Child()

    def run(self, tasks, *, width=2):
        args = local.parse_args([*tasks, "--max-concurrency", str(width), "--no-dashboard"])
        original_term = signal.getsignal(signal.SIGTERM)
        original_int = signal.getsignal(signal.SIGINT)
        with patch.object(local_worlds.subprocess, "Popen", self.popen):
            try:
                code = local_worlds.run_task_worlds(self.api, args, tasks)
            finally:
                # A failing assertion never leaves a fixture FD pending. No OS
                # process was started, and no broad signal fallback is possible.
                for process in self.processes:
                    for fd in process.descriptors:
                        os.close(fd)
                    process.descriptors.clear()
        assert signal.getsignal(signal.SIGTERM) == original_term
        assert signal.getsignal(signal.SIGINT) == original_int
        report = json.loads((self.root / "control-worlds" / "local-worlds.json").read_text())
        return code, report


def test_local_worlds_propagates_task_and_post_run_failures():
    for fault in ("failed-task", "post-run-failure"):
        with tempfile.TemporaryDirectory(prefix="rose-worlds-result-") as temporary:
            fixture = CoordinatorFixture(Path(temporary), fault=fault)
            code, report = fixture.run([SETUP, ABANDON])
            assert code == 1, (fault, report)
            assert report["status"] == "failed"
            assert [row["status"] for row in report["tasks"]] == ["failed", "passed"]
            assert not fixture.signals, "ordinary failed task must not cancel its independent sibling"


def test_local_worlds_rejects_missing_or_foreign_cleanup_and_results():
    faults = (
        "missing-cleanup",
        "wrong-cleanup-token",
        "foreign-benchmark-owner",
        "foreign-stack-owner",
        "wrong-stack-pid",
        "wrong-stack-birth",
        "live-stack",
        "foreign-result-index",
        "changed-result",
        "false-zero",
    )
    for fault in faults:
        with tempfile.TemporaryDirectory(prefix="rose-worlds-receipt-") as temporary:
            fixture = CoordinatorFixture(Path(temporary), fault=fault)
            code, report = fixture.run([SETUP, ABANDON], width=1)
            assert code != 0, (fault, report)
            assert report["status"] == "failed"
            assert report["tasks"][0]["status"] == "failed-retained", (fault, report)
            assert report["tasks"][1]["status"] == "cancelled-before-start"
            assert len(fixture.processes) == 1, "failed ownership must not admit queued work"


def test_local_worlds_accepts_native_v2_stack_cleanup_and_preserves_guards():
    """Native coordinator consumes the stack's current schema, with custody intact."""
    with tempfile.TemporaryDirectory(prefix="rose-worlds-v2-clean-") as temporary:
        fixture = CoordinatorFixture(Path(temporary), stack_version="2")
        code, report = fixture.run([SETUP, ABANDON], width=1)
        assert code == 0, report
        assert all(row["status"] == "passed" for row in report["tasks"]), report

    faults = (
        "missing-stack-native",
        "foreign-stack-native",
        "wrong-stack-pid",
        "wrong-stack-token",
        "malformed-stack-receipt",
        "foreign-stack-owner",
        "live-stack",
        "unreadable-live-stack",
        "v2-benchmark-receipt",
        "foreign-result-index",
        "changed-result",
    )
    for fault in faults:
        with tempfile.TemporaryDirectory(prefix="rose-worlds-v2-guard-") as temporary:
            fixture = CoordinatorFixture(Path(temporary), fault=fault, stack_version="2")
            code, report = fixture.run([SETUP, ABANDON], width=1)
            assert code != 0, (fault, report)
            assert report["tasks"][0]["status"] == "failed-retained", (fault, report)
            assert report["tasks"][1]["status"] == "cancelled-before-start", (fault, report)
            assert len(fixture.processes) == 1, fault


def test_local_worlds_preserves_duplicate_task_occurrences():
    tasks = [SETUP, ABANDON, SETUP]
    with tempfile.TemporaryDirectory(prefix="rose-worlds-duplicates-") as temporary:
        fixture = CoordinatorFixture(Path(temporary))
        code, report = fixture.run(tasks)
        rows = report["tasks"]
        assert code == 0
        assert [row["task"] for row in rows] == tasks
        for field in ("ordinal", "run_id", "context_dir", "pid", "native_identity"):
            assert len({row[field] for row in rows}) == 3, field
        assert [p.task for p in fixture.processes] == [SETUP, SETUP, ABANDON]
        assert fixture.max_live == 1
        assert all(row["status"] == "passed" for row in rows)


def test_local_worlds_preserves_exclusive_phase_concurrency_and_sms_guard():
    ordinary = "parallel-tool-calls"
    sms_a, sms_b = "sms-supervisor-open-spawns-agent", "sms-supervisor-closed-no-spawn"
    exclusive = "browser-biometrics-webdecoy"
    tasks = [sms_a, ordinary, exclusive, sms_b]
    with tempfile.TemporaryDirectory(prefix="rose-worlds-scheduler-") as temporary:
        fixture = CoordinatorFixture(Path(temporary))
        code, report = fixture.run(tasks)
        assert code == 0, report
        events = fixture.events

        def position(kind, name):
            return next(i for i, row in enumerate(events) if row[:2] == (kind, name))

        assert position("end", exclusive) < min(position("start", t) for t in (sms_a, sms_b, ordinary))
        assert position("end", sms_a) < position("start", sms_b)
        assert position("start", ordinary) < position("end", sms_a)
        assert position("start", sms_a) < position("end", ordinary)
        assert fixture.max_live == 2


def test_local_worlds_cancellation_does_not_admit_queued_children():
    with tempfile.TemporaryDirectory(prefix="rose-worlds-cancel-") as temporary:
        fixture = CoordinatorFixture(Path(temporary), cancel=True)
        code, report = fixture.run([SETUP, ABANDON, SETUP], width=1)
        assert code == 143
        assert len(fixture.processes) == 1
        assert [row["status"] for row in report["tasks"]] == [
            "interrupted",
            "cancelled-before-start",
            "cancelled-before-start",
        ]
        assert fixture.signals == [(fixture.processes[0].pid, signal.SIGTERM)]
        assert report["stop_signal"] == signal.SIGTERM


def test_local_worlds_child_preserves_options_and_effective_cohort_configuration():
    tasks = [SETUP, ABANDON, "parallel-tool-calls", "spawn-sub-agents", SETUP]
    args = local.parse_args(
        [
            *tasks,
            "--max-concurrency",
            "2",
            "--bootstrap",
            "--anon",
            "--simulate",
            "--world-model-name",
            "fixture-world",
            "--keep-services",
            "--no-clean",
            "--no-dashboard",
            "--base-port",
            "24000",
        ]
    )
    command = local_worlds._child_command(local, args, SETUP, "fixture-child", tasks, 1)
    child = local.parse_args(command[3:])
    assert local.tasks_from_args(child) == [SETUP]
    assert child.cohort_tasks == tasks
    for field in (
        "max_concurrency",
        "bootstrap",
        "anon",
        "simulate",
        "world_model_name",
        "keep_services",
        "no_clean",
        "no_dashboard",
    ):
        assert getattr(child, field) == getattr(args, field), field
    assert child.run_id == "fixture-child"
    assert child.base_port == 24010
    with patch.dict(os.environ, {}, clear=True):
        local.configure_task_environment(tasks, isolated=True)
        cohort = dict(os.environ)
    with patch.dict(os.environ, {}, clear=True):
        local.configure_task_environment(child.cohort_tasks, isolated=True)
        assert dict(os.environ) == cohort
    assert cohort["ROSE_DISABLE_GENERAL_PURPOSE_AGENT"] == "0"
    assert cohort["BENCHMARK_AGENT_PAYMENT_USER_ID"] == local.AGENT_PAYMENT_BENCHMARK_USER_ID
    assert cohort["BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH"] == "1"
    assert cohort["BENCHMARK_FAST_MODE_CACHE"] == "false"


def test_local_worlds_withholds_admission_after_identity_or_journal_failure():
    for fault in ("identity-failure", "journal-failure"):
        with tempfile.TemporaryDirectory(prefix="rose-worlds-admission-") as temporary:
            fixture = CoordinatorFixture(Path(temporary), fault=fault)
            code, report = fixture.run([SETUP, ABANDON], width=1)
            assert code != 0
            assert len(fixture.processes) == 1
            assert not fixture.processes[0].admitted
            assert fixture.processes[0].returncode == 2
            assert report["tasks"][0]["status"] == "failed-retained"
            assert report["tasks"][1]["status"] == "cancelled-before-start"
            assert not Path(report["tasks"][0]["context_dir"]).exists()
            assert not fixture.signals, "unknown identity must not be signalled"


def test_local_worlds_child_requires_exact_parent_admission_before_stack_allocation():
    class AllocationReached(BaseException):
        pass

    for payload in (b"1", b"", b"0", b"11"):
        read_fd, write_fd = os.pipe()
        os.write(write_fd, payload)
        os.close(write_fd)
        reached = []

        def allocate(_args):
            reached.append(True)
            raise AllocationReached

        with (
            patch.object(local, "build_service_stack", allocate),
            patch.object(local, "validate_agentcard_org_credentials"),
        ):
            try:
                local.main([SETUP, "--cohort-task", SETUP, "--world-ready-fd", str(read_fd)])
            except AllocationReached:
                assert payload == b"1"
            except RuntimeError:
                assert payload != b"1"
        assert bool(reached) == (payload == b"1")
        try:
            os.fstat(read_fd)
        except OSError:
            pass
        else:
            os.close(read_fd)
            raise AssertionError("child left its admission descriptor open")


def test_local_worlds_not_started_receipt_is_only_valid_for_owned_startup_interruption():
    with tempfile.TemporaryDirectory(prefix="rose-worlds-not-started-") as temporary:
        root = Path(temporary)
        fixture = CoordinatorFixture(root)
        process = SimpleNamespace(run_id="startup", pid=800001, ordinal=0, task=SETUP)
        fixture.publish(process, 143)
        row = {"context_dir": str(root / "startup"), "run_id": "startup"}
        owner_path = root / "startup" / "local-benchmark-owner.json"
        original = json.loads(owner_path.read_text())
        original.update(state="not_started", pid=None, native_identity="", token="")
        (root / "startup" / "benchmark-cleanup.status").unlink()
        variants = [
            (False, {}, None),
            (True, {"pid": 800001}, None),
            (True, {"native_identity": "prior-native"}, None),
            (True, {"token": "prior-token"}, None),
            (True, {"run_id": "foreign-world"}, None),
            (True, {}, "live-stack"),
            (True, {}, None),
        ]
        for allowed, changed, fault in variants:
            fixture.fault = fault
            local._write_owner_record(owner_path, {**original, **changed})
            accepted = True
            try:
                local_worlds._verify_child_cleanup(fixture.api, row, keep_services=False, allow_not_started=allowed)
            except RuntimeError:
                accepted = False
            assert accepted == (allowed and not changed and fault is None), (allowed, changed, fault)


def test_local_worlds_console_failure_preserves_child_retirement():
    class AsyncRetirement(CoordinatorFixture):
        def send_signal(self, process, identity, signum):
            assert identity == f"fixture-child-{process.pid}"
            self.signals.append((process.pid, signum))

        def popen(self, command, **kwargs):
            child = super().popen(command, **kwargs)
            original_poll = child.poll
            child.after_signal_polls = 0

            def poll():
                if not child.admitted and child.returncode is None:
                    return original_poll()
                child.polls += 1
                if child.returncode is None:
                    if any(pid == child.pid for pid, _ in self.signals):
                        child.after_signal_polls += 1
                        if child.after_signal_polls >= 3:
                            child.finish(143)
                    elif child.polls >= 8:
                        child.finish(0)
                return child.returncode

            child.poll = poll
            return child

    for cancel in (False, True):
        with tempfile.TemporaryDirectory(prefix="rose-worlds-output-") as temporary:
            fixture = AsyncRetirement(Path(temporary), cancel=cancel)
            unavailable = False
            original_print = print

            def broken_output(*args, **kwargs):
                nonlocal unavailable
                if args and str(args[0]).startswith("Local world 0:") and "pid=" in str(args[0]):
                    unavailable = True
                if unavailable:
                    raise BrokenPipeError("injected coordinator stdout unavailable")
                return original_print(*args, **kwargs)

            with patch("builtins.print", broken_output):
                code, report = fixture.run([SETUP, ABANDON], width=1)
            assert unavailable, "control never reached the live child output boundary"
            assert code == (143 if cancel else 0), report
            assert all(child.returncode is not None for child in fixture.processes)
            if cancel:
                assert len(fixture.processes) == len(fixture.signals) == 1
                assert fixture.processes[0].after_signal_polls >= 3
                assert report["tasks"][0]["status"] == "interrupted"
                assert report["tasks"][1]["status"] == "cancelled-before-start"
            else:
                assert not fixture.signals, "optional console loss must not cancel healthy work"
                assert report["status"] == "passed"

    class LogReader:
        def __init__(self, error=None):
            self.error = error
            self.reads = []

        def read(self, size=-1):
            self.reads.append(size)
            assert 0 < size <= 65536, "live log tail read can escape the cleanup deadline"
            if self.error is not None:
                raise self.error
            return "retained child output"

    for error in (None, OSError("log unavailable"), ValueError("log closed")):
        reader = LogReader(error)
        with patch("builtins.print", side_effect=BrokenPipeError("console unavailable")):
            local_worlds._relay_child_output(reader)
        assert len(reader.reads) == 1, "one relay must not chase a moving EOF"


CONTROL_TESTS = (
    test_local_worlds_propagates_task_and_post_run_failures,
    test_local_worlds_rejects_missing_or_foreign_cleanup_and_results,
    test_local_worlds_accepts_native_v2_stack_cleanup_and_preserves_guards,
    test_local_worlds_preserves_duplicate_task_occurrences,
    test_local_worlds_preserves_exclusive_phase_concurrency_and_sms_guard,
    test_local_worlds_cancellation_does_not_admit_queued_children,
    test_local_worlds_child_preserves_options_and_effective_cohort_configuration,
    test_local_worlds_withholds_admission_after_identity_or_journal_failure,
    test_local_worlds_child_requires_exact_parent_admission_before_stack_allocation,
    test_local_worlds_not_started_receipt_is_only_valid_for_owned_startup_interruption,
    test_local_worlds_console_failure_preserves_child_retirement,
)


def _run_control_child(receipt: Path) -> int:
    started = time.monotonic()
    results = []
    for test in CONTROL_TESTS:
        test_started = time.monotonic()
        outcome = {"name": test.__name__, "passed": False}
        try:
            test()
            outcome["passed"] = True
        except BaseException as error:
            outcome["error_type"] = type(error).__name__
            traceback.print_exc()
        outcome["seconds"] = round(time.monotonic() - test_started, 4)
        results.append(outcome)
    report = {
        "version": 1,
        "pid": os.getpid(),
        "seconds": round(time.monotonic() - started, 4),
        "tests": results,
        "status": "passed" if all(row["passed"] for row in results) else "failed",
        "resource_scope": "No OS children, service resources, DB, or provider calls inside these controls.",
    }
    local._write_owner_record(receipt, report)
    return 0 if report["status"] == "passed" else 1


def test_local_worlds_controls():
    """Blackbox entry: signal handlers must run on a fresh process's main thread."""
    artifact_root = Path(os.environ.get("BLACKBOX_TEST_ARTIFACT_DIR", str(AGENTS_DIR.parent / ".context/test-runs")))
    artifact_root.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix="local-worlds-controls-", dir=artifact_root))
    os.chmod(folder, 0o700)
    receipt = folder / "summary.json"
    output_path = folder / "controls.private.log"
    started = time.monotonic()
    with output_path.open("xb") as output:
        os.chmod(output_path, 0o600)
        result = subprocess.run(
            [sys.executable, "-m", "benchmarks.local_worlds_controls_test", "--control-child", str(receipt)],
            cwd=AGENTS_DIR,
            stdout=output,
            stderr=subprocess.STDOUT,
            timeout=30,
            check=False,
        )
    assert result.returncode == 0, f"Local world controls failed after {time.monotonic() - started:.2f}s: {output_path}"
    report = json.loads(receipt.read_text())
    assert report["status"] == "passed", receipt
    assert [row["name"] for row in report["tests"]] == [test.__name__ for test in CONTROL_TESTS]
    assert all(row["passed"] for row in report["tests"])
    print(f"Local world controls: {len(report['tests'])} passed in {report['seconds']}s; evidence: {receipt}")


if __name__ == "__main__":
    os.umask(0o077)
    if len(sys.argv) != 3 or sys.argv[1] != "--control-child":
        raise SystemExit("Use --control-child RECEIPT for the bounded controls subprocess")
    raise SystemExit(_run_control_child(Path(sys.argv[2])))
