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
