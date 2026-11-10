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

def check_fake_provider_compilation(source: Path) -> None:
    """Reuse checked bytecode, preserving startup hooks and source invalidation."""
    import importlib.util
    import marshal
    import shlex
    text = source.read_text()
    start = text.index('cat > "$FAKE_DIR/flyctl.py"')
    fake_source = text[text.index('\n', start) + 1:text.index('\nPY\n', start)]
    marker = '# Compile the immutable fixture helper once;'
    start = text.index(marker) if marker in text else text.index('cat > "$FAKE_BIN/flyctl" <<SH')
    block = text[start:text.index('# Controllers also reach Fly', start)]
    with tempfile.TemporaryDirectory(prefix='compiled-fake-provider-') as directory:
        root = Path(directory)
        fake = root / 'fake'
        binary = root / 'bin'
        hooks = root / 'hooks'
        for path in (fake, binary, hooks):
            path.mkdir()
        script = fake / 'flyctl.py'
        script.write_text(fake_source)
        (fake / 'state.json').write_text(json.dumps({'machines': [{'id': 'fixture'}], 'volumes': [], 'secrets': []}))
        (fake / 'journal.log').touch()
        (fake / 'markers').mkdir()
        (fake / 'machines').mkdir()
        # The existing storage fixture also uses sitecustomize: it must load in
        # every fresh interpreter, while code compilation itself is reusable.
        marker_file = root / 'startup'
        (hooks / 'sitecustomize.py').write_text(
            'import os,importlib.machinery\n'
            'with open(os.environ["STARTUP_RECEIPT"], "a") as f: f.write("loaded\\n")\n'
            '_compile=importlib.machinery.SourceFileLoader.source_to_code\n'
            'def counted(self,*args,**kwargs):\n'
            ' if self.path.endswith("/flyctl.py"):\n'
            '  with open(os.environ["COMPILE_RECEIPT"],"a") as f: f.write("compiled\\n")\n'
            ' return _compile(self,*args,**kwargs)\n'
            'importlib.machinery.SourceFileLoader.source_to_code=counted\n')
        environment = dict(__import__('os').environ,
                           PATH=str(Path(sys.executable).parent) + __import__('os').pathsep + __import__('os').environ.get('PATH', ''),
                           PYTHONDONTWRITEBYTECODE='1',
                           PYTHONPATH=str(hooks), STARTUP_RECEIPT=str(marker_file),
                           CLOUDBENCH_FAKE_DIR=str(fake), COMPILE_RECEIPT=str(root / 'compilations'))
        command = ('FAKE_DIR=' + shlex.quote(str(fake)) + '\nFAKE_BIN=' + shlex.quote(str(binary))
                   + '\nfail() { exit 1; }\n' + block)
        prepared = subprocess.run(['bash', '-c', command], env=environment, capture_output=True, text=True)
        assert prepared.returncode == 0, prepared.stderr
        cache = Path(importlib.util.cache_from_source(str(script)))
        assert cache.is_file(), 'fixture helper is recompiled from source by every CLI invocation'
        before = cache.read_bytes()
        (root / 'compilations').write_text('')
        assert before[:4] == importlib.util.MAGIC_NUMBER and int.from_bytes(before[4:8], 'little') == 3
        assert marshal.loads(before[16:]) == compile(fake_source, str(script), 'exec')
        wrapper = binary / 'flyctl'
        def call(*arguments):
            return subprocess.run([str(wrapper), *arguments], env=environment, capture_output=True, text=True)
        results = [call('machines', 'list', '--json') for _ in range(3)]
        assert all(x.returncode == 0 for x in results)
        assert all(json.loads(x.stdout) == [{'id': 'fixture'}] for x in results)
        assert call('secrets', 'set', 'EXACT_FAKE=value').returncode == 0
        listed = call('secrets', 'list')
        assert listed.returncode == 0 and {'Name': 'EXACT_FAKE'} in json.loads(listed.stdout)
        rejected = call('apps', 'list', '-a', 'navi-whisper-lux')
        assert rejected.returncode == 2 and 'PRODUCTION' in rejected.stderr
        assert (fake / 'journal.log').read_text().splitlines() == [
            'machines list --json', 'machines list --json', 'machines list --json',
            'secrets set EXACT_FAKE=value', 'secrets list', 'apps list -a navi-whisper-lux']
        assert marker_file.read_text().count('loaded\n') >= 6
        assert cache.read_bytes() == before, 'ordinary calls rewrote compiled bytecode'
        assert (root / 'compilations').read_text() == '', 'ordinary CLI calls recompiled source'
        # CHECKED_HASH must refuse stale bytecode even with inherited -B.
        script.write_text(fake_source + '\nprint("fresh-source-marker")\n')
        changed = call('apps', 'list')
        assert changed.returncode == 0 and changed.stdout.endswith('fresh-source-marker\n')
        assert (root / 'compilations').read_text() == 'compiled\n', 'source change did not invalidate checked bytecode'
        assert cache.read_bytes() == before, 'read-only interpreter rewrote stale cache'
        script.write_text('syntax error !\n')
        invalid = call('apps', 'list')
        assert invalid.returncode != 0 and 'SyntaxError' in invalid.stderr


def check_fake_state_noop_publication(source: Path) -> None:
    """No-op reads do not publish; nested mutations and locked updates still commit."""
    import ast
    import fcntl
    import os
    from types import SimpleNamespace
    text = source.read_text()
    start = text.index('cat > "$FAKE_DIR/flyctl.py"')
    fake_source = text[text.index('\n', start) + 1:text.index('\nPY\n', start)]
    node = next(n for n in ast.parse(fake_source).body if isinstance(n, ast.ClassDef) and n.name == 'locked_state')
    code = ast.get_source_segment(fake_source, node)
    with tempfile.TemporaryDirectory(prefix='fake-state-publish-') as folder:
        root = Path(folder)
        state = root / 'state.json'
        state.write_text(json.dumps({'nested': {'count': 0}}))
        replacements = []
        def replace(a, b):
            replacements.append((a, b))
            os.replace(a, b)
        scope = dict(os=SimpleNamespace(replace=replace), fcntl=fcntl, json=json,
                     STATE=str(state), LOCK=str(root / 'lock'))
        exec(code, scope)
        lock = scope['locked_state']
        for _ in range(30):
            with lock() as value:
                assert value['nested']['count'] == 0
        assert replacements == [], 'read-only queries published unchanged state'
        with lock() as value:
            value['nested']['count'] = 1
        assert len(replacements) == 1 and json.loads(state.read_text())['nested']['count'] == 1
        old = state.read_bytes()
        try:
            with lock() as value:
                value['nested']['count'] = 99
                raise RuntimeError('primary failure')
        except RuntimeError:
            pass
        assert state.read_bytes() == old and len(replacements) == 1
        # Independent processes still use the same exclusive file lock, so
        # skipping no-op publication must not lose any concurrent mutation.
        worker = ('import os,fcntl,json\nSTATE=' + repr(str(state)) + '\nLOCK='
                  + repr(str(root / 'lock')) + '\n' + code
                  + '\nfor _ in range(30):\n with locked_state() as row: row["nested"]["count"] += 1\n')
        children = [subprocess.Popen([sys.executable, '-c', worker]) for _ in range(3)]
        try:
            assert all(child.wait(timeout=15) == 0 for child in children)
        finally:
            for child in children:
                if child.poll() is None:
                    child.terminate()
                child.wait(timeout=15)
        assert json.loads(state.read_text())['nested']['count'] == 91


check_fake_provider_compilation(ROOT / 'scripts/tests/cloudbench-multi-workstream.test.sh')
check_fake_state_noop_publication(ROOT / 'scripts/tests/cloudbench-multi-workstream.test.sh')
