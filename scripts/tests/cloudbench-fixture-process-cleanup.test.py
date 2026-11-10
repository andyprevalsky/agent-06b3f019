#!/usr/bin/env python3
"""A timed-out allocator tree cannot mask the primary failure or skip peers."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import select

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('allocation', ROOT / 'scripts/tests/cloudbench-fixture-port-allocation.test.py')
allocation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(allocation)
original_receipt = allocation.receipt

with tempfile.TemporaryDirectory(prefix='allocator-cleanup-control-') as folder:
    folder = Path(folder)
    workers = []
    native_methods = {}
    try:
        for index in range(2):
            record = folder / f'{index}.json'
            code = ("import os,signal,subprocess,sys; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                    "p=subprocess.Popen([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'],start_new_session=True); "
                    "print(str(os.getpid())+':'+str(p.pid),flush=True); sys.stdin.read(); p.terminate(); p.wait()") if index == 0 else "import sys; print('ready',flush=True); sys.stdin.readline()"
            child = subprocess.Popen([sys.executable, str(ROOT / 'scripts/cloudbench-local-supervisor.py'), '--receipt', str(record), '--', sys.executable, '-c', code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            child.owner_receipt = record
            workers.append(child)
            native_methods[child] = child.communicate
            assert select.select([child.stdout], [], [], 10)[0], "control child did not start"
            assert child.stdout.readline().strip()
        native_communicate = workers[0].communicate
        calls = []
        def timed_out_once(*args, **kwargs):
            calls.append(kwargs.get('timeout'))
            if len(calls) == 1:
                assert kwargs['timeout'] == 10
                # Start real pipe communication, then inject expiration without
                # spending the ten-second primary budget in the control.
                if workers[0].poll() is None:
                    return native_communicate(*args, **{**kwargs, 'timeout': 0})
                raise subprocess.TimeoutExpired(workers[0].args, 10)
            return native_communicate(*args, **kwargs)
        workers[0].communicate = timed_out_once
        pending = iter(workers)
        allocation.launch = lambda *args, **kwargs: next(pending)
        def primary_failure(child):
            raise AssertionError('primary fixture failure')
        allocation.receipt = primary_failure
        failure = None
        try:
            allocation.main()
        except BaseException as error:
            failure = error
        assert isinstance(failure, AssertionError) and str(failure) == 'primary fixture failure', (type(failure).__name__, str(failure))
        assert any('retire' in note for note in getattr(failure, '__notes__', [])), 'timeout cleanup must remain visible'
        for child in workers:
            assert child.poll() is not None, 'a later child was skipped'
            result = json.loads(child.owner_receipt.read_text())
            assert result['quiescent'] and not result['remaining'] and result['error'] is None, result
        assert json.loads(workers[0].owner_receipt.read_text())['kill_sent'], 'stuck tree did not exercise native escalation'
        print('PASS: stuck native tree reaped, later child retired, primary assertion retained with cleanup refusal')
        # Without a primary assertion, the same timeout must still be a failure.
        calls.clear()
        later_calls = []
        later_communicate = native_methods[workers[1]]
        def later(*args, **kwargs):
            later_calls.append(True)
            return later_communicate(*args, **kwargs)
        workers[1].communicate = later
        try:
            allocation.retire_all(workers)
        except AssertionError as error:
            assert 'retirement timed out' in str(error), error
        else:
            raise AssertionError('retirement timeout was silently accepted')
        assert later_calls, 'cleanup failure skipped a later child'
        print('PASS: retirement timeout fails closed after attempting every later child')
        # A partial line must not escape the unchanged ten-second startup
        # budget through TextIO.readline. Only the clock advance is controlled.
        child = subprocess.Popen([sys.executable, str(ROOT / 'scripts/cloudbench-local-supervisor.py'), '--receipt', str(folder / 'partial.json'), '--', sys.executable, '-c', "import sys; sys.stdout.write('partial'); sys.stdout.flush(); sys.stdin.readline()"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        child.owner_receipt = folder / 'partial.json'
        workers.append(child)
        native_methods[child] = child.communicate
        native_clock = allocation.time.monotonic
        ticks = iter((0, 0, 11))
        allocation.time.monotonic = lambda: next(ticks)
        try:
            try:
                original_receipt(child)
            except AssertionError as error:
                assert str(error) == 'allocator did not publish within 10 seconds', error
            else:
                raise AssertionError('partial publication bypassed startup deadline')
        finally:
            allocation.time.monotonic = native_clock
            allocation.retire(child)
        print('PASS: partial startup publication retains the original ten-second bound')
    finally:
        # The regression itself also drains every exact owner on RED.
        primary = sys.exc_info()[1]
        errors = []
        for child in workers:
            try:
                if child.poll() is None:
                    child.terminate()
                native_methods[child](timeout=10)
            except BaseException as error:
                errors.append(error)
        if errors:
            if primary is not None:
                primary.add_note('control cleanup failed: ' + repr(errors))
            else:
                raise AssertionError(errors)


def check_failed_fixture_dumps_task_bench_log(source: Path) -> None:
    """Run only real fail(), preserving its primary failure and five-second dumps."""
    import shlex
    text = source.read_text()
    start = text.index('\nfail() {\n') + 1
    end = text.index('\ntest_tcp_listener_absent() {', start)
    fail_function = text[start:end]
    with tempfile.TemporaryDirectory(prefix='cloudbench failure-log-') as folder:
        temporary = Path(folder)
        log = temporary / 'ws/.context/fleet/runs/current/readiness/remote-logs/bench.log'
        log.parent.mkdir(parents=True)
        reason = 'FATAL: readiness boundary phase=healthy-retry failed_worker=owned ready_workers=[]'
        log.write_text(reason + '\n')
        command = fail_function + '\nTMP_ROOT=' + shlex.quote(folder) + "\nfail 'original primary fixture failure'\n"
        result = subprocess.run(['bash', '-c', command], capture_output=True, text=True, timeout=10)
        assert result.returncode == 1, result
        assert 'FAIL: original primary fixture failure' in result.stderr, result.stderr
        assert reason in result.stderr, 'task bench.log reason was lost before fixture cleanup'
        assert log.read_text() == reason + '\n', 'diagnostic dump changed original evidence'


check_failed_fixture_dumps_task_bench_log(ROOT / 'scripts/tests/cloudbench-multi-workstream.test.sh')


def check_cleanup_selftest_does_not_repeat_prerequisites(source: Path) -> None:
    """Only the internal cleanup-exit probe skips prerequisites; normal errors remain hard."""
    import shlex
    text = source.read_text()
    begin = text.index('export CLOUDBENCH_CLEANUP_DISK_RESERVE_MB=')
    end = text.index('# Resolve the fleet APP', begin)
    prerequisite_block = text[begin:end]
    expected = [
        'cloudbench-worker-readiness-publication.test.py',
        'cloudbench-fixture-port-allocation.test.py',
        'cloudbench-fixture-process-cleanup.test.py',
        'cloudbench-fixture-catalog.test.py',
        'cloudbench-hub-reaping.test.py',
        'cloudbench-fake-volume-contract.test.py',
        'cloudbench-undelivered-native-stop-capture.test.py',
        'cloudbench-runtime-evidence-collector.test.py',
        'cloudbench-failed-runtime-evidence.test.py',
        'cloudbench-bench-log-backlog.test.py',
    ]
    with tempfile.TemporaryDirectory(prefix='cleanup-prerequisite-control-') as folder:
        folder = Path(folder)
        for mode, failure, wanted_status, wanted in (
            ('1', '', 0, []),
            ('0', '', 0, expected),
            ('', '', 0, expected),
            ('0', expected[3], 1, expected[:4]),
        ):
            record = folder / 'calls'
            record.write_text('')
            prefix = ('ROOT_DIR=/fixture\nCALL_RECORD=' + shlex.quote(str(record)) +
                      '\nFAIL_NAME=' + shlex.quote(failure) +
                      '\nCLOUDBENCH_TEST_CLEANUP_EXIT_SELF_TEST=' + shlex.quote(mode) +
                      '\npython3() { local name="${1##*/}"; printf "%s\\n" "$name" >> "$CALL_RECORD"; '
                      '[ "$name" != "$FAIL_NAME" ]; }\n')
            result = subprocess.run(['bash', '-c', prefix + prerequisite_block], capture_output=True, text=True)
            actual = record.read_text().splitlines()
            assert result.returncode == wanted_status, (mode, failure, result.returncode, result.stderr)
            assert actual == wanted, (mode, failure, actual, wanted)


check_cleanup_selftest_does_not_repeat_prerequisites(ROOT / 'scripts/tests/cloudbench-multi-workstream.test.sh')


def check_cleanup_fixture_registration(root: Path) -> None:
    """The cleanup regression must have exactly one direct native structural recipe."""
    import ast
    tree = ast.parse((root / 'scripts/run-deploy-structural-gates.py').read_text())
    name = 'cloudbench-fixture-process-cleanup'
    commands = []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id == 'Gate' and len(node.args) >= 2
                and isinstance(node.args[0], ast.Constant) and node.args[0].value == name):
            commands.append(ast.literal_eval(node.args[1]))
    assert commands == [('python3', 'scripts/tests/cloudbench-fixture-process-cleanup.test.py')], commands


check_cleanup_fixture_registration(ROOT)
