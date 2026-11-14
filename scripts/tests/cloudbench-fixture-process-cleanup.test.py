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
        for mode, failure, wanted_status, wanted, shard in (
            ('1', '', 0, [], ''),
            ('0', '', 0, expected, ''),
            ('', '', 0, expected, ''),
            ('0', expected[3], 1, expected[:4], ''),
            # A numbered scenario shard is a child of the parent that already
            # ran every prerequisite; an explicit serial run still runs them.
            ('0', '', 0, [], '2'),
            ('', '', 0, expected, 'all'),
        ):
            record = folder / 'calls'
            record.write_text('')
            prefix = ('ROOT_DIR=/fixture\nCALL_RECORD=' + shlex.quote(str(record)) +
                      '\nFAIL_NAME=' + shlex.quote(failure) +
                      '\nCLOUDBENCH_TEST_CLEANUP_EXIT_SELF_TEST=' + shlex.quote(mode) +
                      '\nCLOUDBENCH_TEST_SHARD=' + shlex.quote(shard) +
                      '\npython3() { local name="${1##*/}"; printf "%s\\n" "$name" >> "$CALL_RECORD"; '
                      '[ "$name" != "$FAIL_NAME" ]; }\n')
            result = subprocess.run(['bash', '-c', prefix + prerequisite_block], capture_output=True, text=True)
            actual = record.read_text().splitlines()
            assert result.returncode == wanted_status, (mode, failure, shard, result.returncode, result.stderr)
            assert actual == wanted, (mode, failure, shard, actual, wanted)


check_cleanup_selftest_does_not_repeat_prerequisites(ROOT / 'scripts/tests/cloudbench-multi-workstream.test.sh')


def check_scenario_shards(source: Path) -> None:
    """Every scenario runs in exactly one concurrent shard; the parent fails if any shard fails."""
    import os
    import re

    text = source.read_text()
    lines = text.splitlines()
    shards = re.search(r'^CLOUDBENCH_TEST_SHARDS=\(([0-9 ]+)\)$', text, re.M)
    assert shards, 'scenario shard list is missing'
    declared = shards.group(1).split()
    # Column-0 if/fi pairs carry the top-level scenario structure; a shard gate
    # is an if whose (possibly continued) condition names its shard.
    stack, used, owners_seen = [], set(), []
    start = next(i for i, line in enumerate(lines) if line.startswith('# Scenario 1 '))
    function_end = heredoc_end = None
    for index in range(start, len(lines)):
        line = lines[index]
        # Embedded heredoc programs are data to the shell structure.
        if heredoc_end is not None:
            if line.strip() == heredoc_end:
                heredoc_end = None
            continue
        heredoc = re.search(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?", line)
        if heredoc:
            heredoc_end = heredoc.group(1)
        # Function bodies run where they are called, not where they are defined.
        if function_end is not None:
            if line == function_end:
                function_end = None
            continue
        definition = re.match(r'^[a-z_]+\(\) *([{(])', line)
        if definition:
            function_end = '}' if definition.group(1) == '{' else ')'
            continue
        if line.startswith('if ') and re.search(r';\s*fi$', line):
            continue  # a one-line conditional opens no scenario block
        if line.startswith('if '):
            condition, cursor = line, index
            while not re.search(r'\bthen$', lines[cursor]):
                cursor += 1
                condition += lines[cursor]
            gate = re.search(r'cloudbench_test_shard_selected ([0-9]+)', condition)
            stack.append(gate.group(1) if gate else None)
            if gate:
                used.add(gate.group(1))
        elif line == 'fi' or line.startswith('fi '):
            assert stack, f'unbalanced top-level fi at line {index + 1}'
            stack.pop()
        elif line.startswith('echo "PASS: scenario '):
            owners = [item for item in stack if item is not None]
            assert len(owners) == 1, (index + 1, line, owners)
            owners_seen.append(owners[0])
        elif line.startswith('echo "PASS: every controller, including fail-closed runs'):
            assert not [item for item in stack if item is not None], 'final reaping check must run in every shard'
    assert not stack, 'unbalanced scenario shard gates'
    assert used == set(declared), (used, declared)
    assert set(owners_seen) == set(declared), owners_seen
    assert len(owners_seen) >= 30, len(owners_seen)

    begin = text.index('CLOUDBENCH_TEST_SHARDS=(')
    end = text.index('# macOS maps /var to /private/var.', begin)
    count = str(len(declared))
    # A child records its start and proves concurrency by waiting until every
    # declared shard has started, then fails only when selected to fail.
    child = (
        'touch "$SHARD_DIR/started-$CLOUDBENCH_TEST_SHARD"\n'
        'if [ "$CLOUDBENCH_TEST_SHARD" != all ]; then\n'
        '    for _ in $(seq 1 100); do\n'
        '        [ "$(find "$SHARD_DIR" -name "started-[0-9]*" | wc -l)" -ge ' + count + ' ] && break\n'
        '        sleep 0.1\n'
        '    done\n'
        '    [ "$(find "$SHARD_DIR" -name "started-[0-9]*" | wc -l)" -ge ' + count + ' ] || exit 7\n'
        'fi\n'
        'echo "child $CLOUDBENCH_TEST_SHARD ran"\n'
        '[ "$CLOUDBENCH_TEST_SHARD" != "${FAIL_SHARD:-}" ]\n'
    )
    with tempfile.TemporaryDirectory(prefix='scenario-shards-') as folder:
        folder = Path(folder)
        script = folder / 'suite.sh'
        script.write_text('set -uo pipefail\n' + text[begin:end] + child)

        def run(**overrides):
            for item in folder.glob('started-*'):
                item.unlink()
            env = {k: v for k, v in os.environ.items() if not k.startswith('CLOUDBENCH_TEST_')}
            env.update(SHARD_DIR=str(folder), **overrides)
            return subprocess.run(['bash', str(script)], capture_output=True, text=True, env=env, timeout=60)

        result = run()
        assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
        for shard in declared:
            assert f'[shard {shard}] child {shard} ran' in result.stdout, result.stdout
            assert f'shard {shard} exit=0' in result.stdout, result.stdout
        assert 'PASS: all multi-workstream scenario shards passed' in result.stdout, result.stdout
        result = run(FAIL_SHARD=declared[-1])
        assert result.returncode == 1, (result.returncode, result.stdout, result.stderr)
        assert f'shard {declared[-1]} exit=1' in result.stdout, result.stdout
        assert 'PASS: all multi-workstream' not in result.stdout, result.stdout
        result = run(CLOUDBENCH_TEST_GROUP_TERM_ONLY='1')
        assert result.returncode == 0 and result.stdout == 'child all ran\n', (result.stdout, result.stderr)
        result = run(CLOUDBENCH_TEST_SHARD='9')
        assert result.returncode == 2 and 'unknown CLOUDBENCH_TEST_SHARD' in result.stderr, result.stderr
    print('PASS: multi-workstream scenarios run in exactly one concurrent shard and any shard failure fails the suite')


check_scenario_shards(ROOT / 'scripts/tests/cloudbench-multi-workstream.test.sh')

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
        # Direct script startup omits the working directory from its import
        # search path. Module startup must not retain -c's empty cwd entry.
        foreign = root / 'foreign-cwd'
        foreign.mkdir()
        (foreign / 'ipaddress.py').write_text('raise RuntimeError("foreign cwd shadow imported")\n')
        shadowed = subprocess.run([str(wrapper), 'apps', 'list'], cwd=foreign,
                                  env=environment, capture_output=True, text=True)
        assert shadowed.returncode == 0, shadowed.stderr
        assert 'foreign cwd shadow' not in shadowed.stderr
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

def check_fake_primary_ready_channel(source: Path) -> None:
    """Execute the real fake-driver prefix and real HTTP/barrier consumers."""
    import ast
    import base64
    import http.client
    import http.server
    import importlib.util
    import io
    import os
    import re
    import shlex
    import threading
    import time
    from types import SimpleNamespace
    from pathlib import PurePosixPath
    sys.path.insert(0, str(ROOT / "scripts/lib"))
    from condition_wait import WaitTimeout, wait_until
    from urllib.parse import parse_qs, urlsplit

    text = source.read_text()
    marker = 'cat > "$FAKE_DIR/flyctl.py" <<\'PY\'\n'
    start = text.index(marker) + len(marker)
    fake = text[start:text.index('\nPY\n', start)]
    tree = ast.parse(fake)
    driver_node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_fake_driver')
    export_node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'rb_export')
    proxy_node = next(n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == 'ProxyHandler')
    boundary = next(n.lineno for n in driver_node.body if isinstance(n, ast.Assign)
                    and any(isinstance(t, ast.Name) and t.id == 'benchmark_started' for t in n.targets))
    # The executing function is unchanged; stop immediately after its real
    # barrier lifecycle, before unrelated benchmark-result work.
    class BarrierComplete(Exception):
        pass

    with tempfile.TemporaryDirectory(prefix='fake-ready-protocol-') as folder:
        root = Path(folder)
        guest = root / 'guest'; (guest / 'data').mkdir(parents=True); (guest / 'tmp').mkdir()
        run = 'ready-protocol-current'; token = 'native-token'
        wrapper = '\n'.join(['export CLOUDBENCH_START_BARRIER='+run, 'export CLOUDBENCH_RUN_TOKEN='+token,
                             'export REF='+'a'*40, 'export BENCH_TASKS_B64='+base64.b64encode(b'ready-control').decode()])+'\n'
        (guest/'tmp/rb.sh').write_text(wrapper)
        scope = dict(os=os, json=json, re=re, Path=Path, base64=base64, time=time,
                     subprocess=subprocess, sys=sys, PurePosixPath=PurePosixPath, FAKE_DIR=str(root), MARKERS=str(root/'markers'))
        exec(compile(ast.Module(body=[export_node, driver_node], type_ignores=[]), str(source), 'exec'), scope)
        driver = scope['run_fake_driver']; outcomes=[]; begin=threading.Event()
        def trace(frame, event, arg):
            if event == 'line' and frame.f_code is driver.__code__ and frame.f_lineno == boundary:
                outcomes.append(frame.f_locals['exit_code']); raise BarrierComplete()
            return trace
        def worker():
            begin.wait()
            sys.settrace(trace)
            try: driver(str(guest))
            except BarrierComplete: pass
            except BaseException as error: outcomes.append(error)
            finally: sys.settrace(None)

        # Use exactly the production Handler factory that the fake proxy uses.
        spec = importlib.util.spec_from_file_location('ready_native_status', ROOT/'scripts/cloudbench-status-server.py')
        status = importlib.util.module_from_spec(spec); spec.loader.exec_module(status)
        captured=[]
        class CaptureServer:
            def __init__(self, address, handler): captured.append(handler)
            def serve_forever(self): pass
        status.ThreadingHTTPServer=CaptureServer
        status.parse_args=lambda: SimpleNamespace(directory=str(guest/'data'),barrier='',bind='127.0.0.1',port=0,ready_file='',run_token=token)
        status.main()
        scope.update(captured_handlers=captured,mdir=str(guest),rb_text=wrapper,urlsplit=urlsplit,parse_qs=parse_qs,
                     hashlib=__import__('hashlib'),http=__import__('http'),SimpleNamespace=SimpleNamespace)
        exec(compile(ast.Module(body=[proxy_node],type_ignores=[]),str(source),'exec'),scope)
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),scope['ProxyHandler'])
        thread=threading.Thread(target=server.serve_forever);thread.start()
        started=False;actor=threading.Thread(target=worker)
        def get(path):
            con=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=2)
            try: con.request('GET',path);response=con.getresponse();body=response.read();return response.status,body
            finally:con.close()
        ready=guest/'data'/('cloudbench-start-'+run+'.ready')
        release=guest/'data'/('cloudbench-start-'+run+'.release')
        try:
            assert get('/'+ready.name)[0]==404, 'pre-readiness accepted'
            assert get('/cloudbench-start-foreign.ready')[0]==404
            outside=root/'outside';outside.write_text('private outside')
            ready.symlink_to(outside)
            assert get('/'+ready.name)[0]==404, 'ready symlink served'
            ready.unlink()
            assert get('/../outside')[0]==404 and get('/%2e%2e/outside')[0]==404
            actor.start();started=True
            # A real, late producer must remain unready until it actually runs.
            assert get('/'+ready.name)[0]==404
            begin.set()
            try:
                wait_until(lambda: ready.exists() or not actor.is_alive(), timeout=3,
                           description="actual fake ready marker or driver termination")
            except WaitTimeout:
                pass  # Preserve the original marker assertion and its diagnostic.
            assert ready.is_file(), 'actual fake driver omitted primary ready marker'
            published=ready.stat().st_mtime_ns
            assert get('/'+ready.name)==(200,b''), 'exact primary ready URL not served by native handler'
            assert get('/cloudbench-start-foreign.ready')[0]==404
            # Execute the actual controller barrier function with real curl.
            fleet=(ROOT/'scripts/run-bench-fleet').read_text();a=fleet.index('release_start_barrier() {');b=fleet.index('\nif ! release_start_barrier;',a)
            output=root/'output';output.mkdir();(output/'status-proxy.port').write_text(str(server.server_port));(output/'fleet-child.log').write_text('')
            grep_calls=root/'fallback-calls'
            setup='\n'.join(['set -uo pipefail','SYNCHRONIZED_START=1','RUN_ID='+shlex.quote(run),
                'CHILD_PIDS=('+str(os.getpid())+')','CHILD_OUT=('+shlex.quote(str(output))+')','CHILD_MACHINE=(fixture)',
                'CHILD_BENCH=(fixture)','START_BARRIER_WAIT_SECONDS=5','PER_BOX_BARRIER_WAIT_SECONDS=5','STRICT_BARRIER=1',
                'INFRA_PROBE=1','SKIP_AUTOSCALER=0','CLOUDBENCH_BARRIER_TOKEN=fixture-token',
                'fleet_infra_stop_check() { :; }','grep() { printf "fallback\\n" >> '+shlex.quote(str(grep_calls))+'; command grep "$@"; }'])
            before=time.monotonic();result=subprocess.run(['bash','-c',setup+'\n'+fleet[a:b]+'\nrelease_start_barrier'],capture_output=True,text=True,timeout=8)
            assert result.returncode==0,(result.stdout,result.stderr)
            consumer_elapsed=time.monotonic()-before
            assert not grep_calls.exists(), 'ready HTTP path still fell back to streamed log'
            actor.join(timeout=3)
            assert not actor.is_alive() and outcomes==[0],outcomes
            assert not ready.exists() and not release.exists(), 'ready/release files survived native barrier completion'
            # Existing compatibility fallback remains valid when its current-token log exists.
            (output/'fleet-child.log').write_text('synchronized start barrier ready: '+run+'\n')
            fallback=subprocess.run(['bash','-c',setup+'\n'+fleet[a:b]+'\nrelease_start_barrier'],capture_output=True,text=True,timeout=8)
            assert fallback.returncode==0 and grep_calls.exists(),fallback.stderr
            release.unlink(missing_ok=True)
            # An actual driver error before readiness may never publish it.
            (guest/'tmp/rb.sh').write_text(wrapper+'export LOCAL_PATCH_FILE=missing.patch\n')
            try: driver(str(guest))
            except FileNotFoundError: pass
            else: raise AssertionError('pre-readiness error did not occur')
            assert not ready.exists()
            print('PASS: actual fake ready publisher/native HTTP/controller, zero compatibility fallback; publication_ns='+str(published)+' observation_seconds='+str(consumer_elapsed))
        finally:
            begin.set();release.touch()
            if started:actor.join(timeout=3)
            server.shutdown();server.server_close();thread.join(timeout=3)
            assert not thread.is_alive() and (not started or not actor.is_alive()), 'protocol fixture leaked a thread'


check_fake_primary_ready_channel(ROOT / 'scripts/tests/cloudbench-multi-workstream.test.sh')

def check_controller_phase_observability(source: Path) -> None:
    """Observe real invocation boundaries without changing child status or streams."""
    import os
    import re
    import shlex
    import signal
    import time
    sys.path.insert(0, str(ROOT / 'scripts/lib'))
    from condition_wait import wait_until

    text = source.read_text()
    start = text.index('\nrun_controller() {') + 1
    function = text[start:text.index('\nwrite_dead_registry() {', start)]
    pattern = re.compile(
        r'^CLOUDBENCH_FIXTURE_CONTROLLER (START|END) pid=([0-9]+) '
        r'started=([0-9]+\.[0-9]+) at=([0-9]+\.[0-9]+) '
        r'label=([A-Za-z0-9_-]+\.log)(?: status=([0-9]+))?$')

    def events(stderr):
        rows = []
        for line in stderr.splitlines():
            assert len(line) <= 320, 'phase event exceeded its fixed bound'
            match = pattern.fullmatch(line)
            assert match, ('invalid or private phase output', line)
            rows.append(match.groups())
        return rows

    with tempfile.TemporaryDirectory(prefix='controller-phase-control-') as folder:
        root = Path(folder)
        ws = root / 'ws'; (ws / 'scripts').mkdir(parents=True)
        child = ws / 'scripts/run-bench-fleet'
        child.write_text('''#!/usr/bin/env bash
printf '%s\\n' "$@" > "$CONTROL_DIR/argv"
printf '%s' "$CONDUCTOR_PORT:$CLOUDBENCH_POLL_INTERVAL" > "$CONTROL_DIR/environment"
printf 'child stdout\\n'
printf 'child stderr\\n' >&2
if [ "$1" = hold ]; then
    : > "$CONTROL_DIR/ready"
    IFS= read -r _ < "$CONTROL_DIR/release"
    exit 0
fi
exit "$1"
''')
        prefix = ('set -uo pipefail\n' + function + '\n' + '\n'.join(
            name + '=' + shlex.quote(str(root)) for name in (
                'FIXTURE_STORAGE', 'FAKE_BIN', 'TMP_ROOT', 'SCRIPT_SNAPSHOT_TMP', 'FAKE_DIR'))
            + '\nFIXTURE_STORAGE_DEVICE=1\nFAKE_FLY_TOKEN=synthetic\n')

        def command(directory, label, status, extra=''):
            return (prefix + '\nexport CONTROL_DIR=' + shlex.quote(str(directory)) + '\n' + extra
                    + '\nrun_controller ' + shlex.quote(str(ws)) + ' 32123 '
                    + shlex.quote(str(directory / label)) + ' ' + shlex.quote(str(status)))

        for status, label in ((0, 'controller-exit.log'), (1, 'controller-exit.log'),
                              (143, 'controller-exit.log'), (0, 'disposable-success-ws-a.log')):
            directory = root / ('exit-' + str(status) + '-' + label); directory.mkdir()
            before = time.time()
            result = subprocess.run(['bash', '-c', command(directory, label, status)],
                                    capture_output=True, text=True, timeout=10)
            after = time.time()
            assert result.returncode == status, (status, result.returncode, result.stderr)
            rows = events(result.stderr)
            assert len(rows) == 2, 'controller invocation lacks bounded START/END timing events'
            first, last = rows
            assert first[0] == 'START' and last[0] == 'END' and first[1:3] == last[1:3]
            assert first[5] is None and last[5] == str(status)
            assert before - 1 <= float(first[2]) <= float(last[3]) <= after + 1
            assert first[2] == first[3] and first[4] == last[4] == label
            assert str(root) not in result.stderr and 'synthetic' not in result.stderr
            assert result.stdout == ''
            assert (directory / label).read_text() == 'child stdout\nchild stderr\n'
            assert (directory / 'argv').read_text().splitlines() == [str(status), '--foreground']
            assert (directory / 'environment').read_text() == '32123:2'

        for label in ('private secret.log', 'controller-' + 'x' * 130 + '.log', 'controller-..log'):
            directory = root / 'invalid'; directory.mkdir(exist_ok=True)
            result = subprocess.run(['bash', '-c', command(directory, label, 0)],
                                    capture_output=True, text=True, timeout=10)
            assert result.returncode != 0 and not (directory / 'argv').exists()
            assert label not in result.stderr and str(root) not in result.stderr

        directory = root / 'broken-start'; directory.mkdir()
        with open('/dev/full', 'w') as sink:
            result = subprocess.run(['bash', '-c', command(directory, 'controller-broken.log', 0)],
                                    stdout=subprocess.PIPE, stderr=sink, text=True, timeout=10)
        assert result.returncode != 0 and not (directory / 'argv').exists(), 'failed START logger launched child'
        # Inject only the builtin logger write failure after the real child boundary.
        # A child failure must survive it, and child success may not mask it.
        for status, expected in ((0, 1), (7, 7)):
            directory = root / ('broken-end-' + str(status)); directory.mkdir()
            extra = ("builtin() { if [[ ${2:-} == *' END '* ]]; then return 1; fi; command builtin \"$@\"; }")
            result = subprocess.run(['bash', '-c', command(directory, 'controller-broken.log', status, extra)],
                                    capture_output=True, text=True, timeout=10)
            assert result.returncode == expected, ('failed END logger status', result.returncode, expected)
            assert len(events(result.stderr)) == 1, 'failed logger fabricated END'

        children = []
        try:
            for index in range(2):
                directory = root / ('parallel-' + str(index)); directory.mkdir()
                os.mkfifo(directory / 'release')
                descriptor = os.open(directory / 'release', os.O_RDWR | os.O_NONBLOCK)
                process = subprocess.Popen(['bash', '-c', command(directory, 'controller-parallel.log', 'hold')],
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           text=True, start_new_session=True)
                children.append((process, directory, descriptor))
            wait_until(lambda: all((d / 'ready').exists() for _, d, _ in children),
                       timeout=5, description='both real fixture children started concurrently')
            for _, _, descriptor in children:
                os.write(descriptor, b'release\n')
            pairs = []
            for process, directory, _ in children:
                stdout, stderr = process.communicate(timeout=5)
                assert process.returncode == 0 and stdout == ''
                rows = events(stderr); assert len(rows) == 2
                assert rows[0][0] == 'START' and rows[1][0] == 'END' and rows[0][1:3] == rows[1][1:3]
                assert int(rows[0][1]) == process.pid
                pairs.append(rows)
            assert pairs[0][0][1] != pairs[1][0][1], 'parallel invocations share an identity'
            assert max(float(x[0][3]) for x in pairs) <= min(float(x[1][3]) for x in pairs), 'phase logger serialized children'
        finally:
            for process, _, descriptor in children:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=5)
                os.close(descriptor)

        for signum in (signal.SIGTERM, signal.SIGKILL):
            directory = root / ('signal-' + str(signum)); directory.mkdir()
            os.mkfifo(directory / 'release')
            descriptor = os.open(directory / 'release', os.O_RDWR | os.O_NONBLOCK)
            process = subprocess.Popen(['bash', '-c', command(directory, 'controller-signal.log', 'hold')],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, start_new_session=True)
            try:
                wait_until(lambda: (directory / 'ready').exists(), timeout=5,
                           description='signal control reached its real child')
                os.killpg(process.pid, signum)
                stdout, stderr = process.communicate(timeout=5)
                assert process.returncode == -signum and stdout == ''
                rows = events(stderr)
                assert len(rows) == 1 and rows[0][0] == 'START', 'signal fabricated a completed phase'
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=5)
                os.close(descriptor)
    print('PASS: bounded controller START/END preserves status, streams, parallel identity and interrupted phases')


check_controller_phase_observability(ROOT / 'scripts/tests/cloudbench-multi-workstream.test.sh')

def check_failed_autoscaler_barrier_uses_current_token(source: Path) -> None:
    """A prior failure cannot satisfy this real fake-driver invocation's barrier."""
    import ast
    import glob
    import os
    import threading
    import time
    from types import SimpleNamespace
    sys.path.insert(0, str(ROOT / 'scripts/lib'))
    from condition_wait import wait_until

    text = source.read_text()
    marker = 'cat > "$FAKE_DIR/flyctl.py" <<\'PY\'\n'
    start = text.index(marker) + len(marker)
    tree = ast.parse(text[start:text.index('\nPY\n', start)])
    driver = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_fake_driver')
    current = next(n for n in driver.body if isinstance(n, ast.FunctionDef) and n.name == 'current_task_output')
    gate = next(n for n in driver.body if isinstance(n, ast.If)
                and 'fail-worker-destroy-once' in ast.unparse(n.test))
    assert any(isinstance(n, ast.Constant) and n.value == 30 for n in ast.walk(gate)), 'original barrier deadline changed'
    wrapper = ast.FunctionDef(name='barrier', args=ast.arguments(posonlyargs=[],args=[ast.arg(arg='initial_status')],kwonlyargs=[],kw_defaults=[],defaults=[]),
                              body=[ast.Assign(targets=[ast.Name(id='exit_code',ctx=ast.Store())],value=ast.Name(id='initial_status',ctx=ast.Load())),gate,ast.Return(value=ast.Name(id='exit_code',ctx=ast.Load()))],decorator_list=[])
    executable = compile(ast.fix_missing_locations(ast.Module(body=[current,wrapper],type_ignores=[])), str(source), 'exec')
    with tempfile.TemporaryDirectory(prefix='current-autoscaler-barrier-') as directory:
        root = Path(directory)
        for mode in ('stale-prior', 'foreign-current', 'missing-current', 'current-ready', 'failed-input'):
            case = root / mode; fake = case / 'fake'; fake.mkdir(parents=True)
            (fake / 'fail-worker-destroy-once').touch()
            workspace = case / 'workspace'; runs = workspace / '.context/fleet/runs'
            bench = 'autoscaler-worker-destroy-failure'; token = 'current-token'
            prior = runs / 'prior' / bench; prior.mkdir(parents=True)
            (prior / 'runtime-evidence.owner.json').write_text(json.dumps({'run_token':'prior-token'}))
            (prior / 'autoscaler.failed').write_text('prior failure')
            own = runs / 'current' / bench; own.mkdir(parents=True)
            if mode != 'missing-current':
                (own / 'runtime-evidence.owner.json').write_text(json.dumps({'run_token':'foreign-token' if mode == 'foreign-current' else token}))
            if mode in ('foreign-current','current-ready'):
                (own / 'autoscaler.failed').write_text('published current-path failure')
            waiting = threading.Event(); done = threading.Event(); outcomes = []; logs = []
            delays = []
            def observe_sleep(seconds):
                delays.append(seconds)
                waiting.set()
                time.sleep(seconds)  # Observe the unchanged real delay; do not advance a fake clock.
            clock = SimpleNamespace(time=time.time, sleep=observe_sleep)
            scope = dict(Path=Path,glob=glob,time=clock,json=json,bench=bench,token=token,FAKE_DIR=str(fake),
                         os=SimpleNamespace(path=os.path,environ={'CLOUDBENCH_FAKE_CONTROLLER_WS':str(workspace)}),log=logs.append)
            exec(executable,scope)
            if mode in ('current-ready','failed-input'):
                initial = 1 if mode == 'failed-input' else 0
                assert scope['barrier'](initial) == initial and not logs
                continue
            def execute():
                try: outcomes.append(scope['barrier'](0))
                except BaseException as error: outcomes.append(error)
                finally: done.set()
            child = threading.Thread(target=execute); child.start()
            try:
                wait_until(lambda: done.is_set() or waiting.is_set(),timeout=3,
                           description='actual barrier probe or premature completion')
                assert not any(isinstance(value, BaseException) for value in outcomes), outcomes
                assert not done.is_set(), 'prior or foreign autoscaler.failed released the current run'
                # Only the current invocation's exact owner and terminal marker release it.
                (own / 'runtime-evidence.owner.json').write_text(json.dumps({'run_token':token}))
                (own / 'autoscaler.failed').write_text('current failure')
                child.join(timeout=3)
                assert not child.is_alive() and outcomes == [0] and not logs, outcomes
                assert delays and all(delay == 0.1 for delay in delays), delays
                assert (prior / 'autoscaler.failed').read_text() == 'prior failure'
            finally:
                (own / 'runtime-evidence.owner.json').write_text(json.dumps({'run_token':token}))
                (own / 'autoscaler.failed').write_text('current failure')
                child.join(timeout=3)
                assert not child.is_alive(), 'barrier control thread did not finish'
    print('PASS: real fake-driver failure barrier ignores prior/foreign state and waits for current owner token')


check_failed_autoscaler_barrier_uses_current_token(ROOT / 'scripts/tests/cloudbench-multi-workstream.test.sh')

def check_autoscaler_wait_wakes_only_for_child(source: Path) -> None:
    """Real terminal publication wakes finalization, never another capacity tick."""
    import os
    import shlex
    import signal
    import time
    import resource
    sys.path.insert(0, str(ROOT / 'scripts/lib'))
    from condition_wait import wait_until

    text = source.read_text()
    start = text.index('    complete_autoscaler_after_child() {')
    complete = text[start:text.index('    cleanup_autoscaler_jobs() {', start)]
    start = text.index('run_fleet_child_supervised() {')
    producer = text[start:text.index('\nmandatory_autoscaler_process_acceptable()', start)]
    marker = 'cloudbench_wait_for_autoscaler_terminal() {'
    if marker in text:
        a = text.index(marker)
        wait_function = text[a:text.index('\nbench_autoscaler()', a)]
        a = text.index('        terminal_poll_status=0\n', text.index('bench_autoscaler()'))
        wait_block = text[a:text.index('\n    done\n}', a)]
    else:
        wait_function = ''
        a = text.rindex('        sleep "$AUTOSCALE_POLL"', text.index('bench_autoscaler()'), text.index('# ── Epoch-0 substrate preflight'))
        wait_block = text[a:text.index('\n', a)+1]
    if wait_function:
        with tempfile.TemporaryDirectory(prefix='zero-terminal-poll-') as directory:
            marker_path = Path(directory)/'benchmark-child.finished'
            for interval in ('0', '0.0', '0e0', '.001', '1e-3'):
                command = wait_function+'\ncloudbench_wait_for_autoscaler_terminal "$1" "$2"'
                result = subprocess.run(['bash','-c',command,'wait',str(marker_path),interval],capture_output=True,text=True,timeout=3)
                assert result.returncode==0, ('previously valid poll interval rejected',interval,result.returncode,result.stderr)
            marker_path.write_text('0\n')
            result = subprocess.run(['bash','-c',command,'wait',str(marker_path),'0'],capture_output=True,text=True,timeout=3)
            assert result.returncode==10, 'zero poll omitted its existing terminal predicate'
    prefix = r'''set -uo pipefail
out="$CONTROL_DIR"
bench=terminal-wait-control
AUTOSCALE_POLL=10
AUTOSCALER_FINALIZATION_WAIT_SECONDS=300
FLEET_NATIVE_REAP_ENABLED=0
reconcile_worker_ready_outcomes() { : > "$out/reconcile-observed"; return 0; }
reconcile_worker_failure_outcomes() {
    if [ -e "$out/injected-failure" ]; then
        printf 'original worker failure\n' > "$out/autoscaler.failed"
        return 1
    fi
}
_pool_ids() { if [ -e "$out/worker.pending" ]; then printf 1; else printf 0; fi; }
_ready_pool_ids() { printf 0; }
fail_autoscaler() { printf '%s\n' "$1" > "$out/autoscaler.failed"; return 1; }
'''
    loop = r'''
probe_loop() {
    local terminal_poll_status=0 count=0
    while :; do
        if [ -e "$out/benchmark-child.finished" ]; then
            complete_autoscaler_after_child
            return $?
        fi
        count=$((count+1))
        printf '%s\n' "$count" >> "$out/metrics-count"
        [ "$count" -lt 2 ] || return 77
        : > "$out/wait-entering"
WAIT_BLOCK
    done
}
probe_loop
'''.replace('WAIT_BLOCK',wait_block)
    with tempfile.TemporaryDirectory(prefix='terminal-only-wait-') as folder:
        root = Path(folder)
        def setup(name):
            d = root/name;d.mkdir();(d/'desired-worker-count').write_text('0\n');return d
        def launch(directory, hook=None, supervised=False):
            env = dict(os.environ,CONTROL_DIR=str(directory),PYTHONDONTWRITEBYTECODE='1')
            if hook:
                env.update(PYTHONPATH=str(hook),HOOK_MARKER=str(directory/'benchmark-child.finished'),HOOK_STATE=str(directory/'hook-count'))
            program = 'printf \"%s\\n\" \"$BASHPID\" > \"$CONTROL_DIR/controller.pid\"\n'+prefix+complete+'\n'+wait_function+'\n'+loop
            command = ['bash','-c',program]
            if supervised:
                command = [sys.executable, str(ROOT/'scripts/cloudbench-local-supervisor.py'), '--receipt', str(directory/'supervisor.json'), '--', sys.executable, '-c', 'import os,sys; os.setsid(); os.execvp(sys.argv[1],sys.argv[1:])', *command]
            child = subprocess.Popen(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
            child.supervised = supervised
            return child
        def retire(process):
            if process.poll() is None:
                if getattr(process, 'supervised', False):process.terminate()
                else:os.killpg(process.pid,signal.SIGKILL)
            process.communicate(timeout=5)
        def ready(process,directory):
            wait_until(lambda:(directory/'wait-entering').exists(),timeout=3,description='consumer entered the unchanged idle boundary')
            # Require its real sleep/waiter child to have reached a sleeping state.
            def sleeping_child():
                try:
                    controller_pid = (directory/'controller.pid').read_text().strip()
                    children=(Path('/proc')/controller_pid/'task'/controller_pid/'children').read_text().split()
                except OSError:return False
                for pid in children:
                    try:
                        row=(Path('/proc')/pid/'stat').read_text().rsplit(')',1)[1].split()
                        if row[0]=='S':return True
                    except OSError:pass
                return False
            wait_until(sleeping_child,timeout=3,description='actual idle child blocked before terminal publication')
        def publish(directory,status):
            # Exercise the exact source producer: real child exits, its group is
            # joined, then the finished status is atomically renamed into place.
            result=subprocess.run(['bash','-c',producer+'\nrun_fleet_child_supervised "$1" bash -c "exit $2"','producer',str(directory/'benchmark-child.finished'),str(status)],
                                  env=dict(os.environ,FLEET_NATIVE_REAP_ENABLED='0'),capture_output=True,text=True,timeout=5)
            assert result.returncode==status,(result.returncode,result.stderr)
            assert (directory/'benchmark-child.finished').read_text()==str(status)+'\n'
        d=setup('late-real-producer');p=launch(d)
        try:
            ready(p,d);publish(d,0);published=time.monotonic()
            stdout,stderr=p.communicate(timeout=12);delay=time.monotonic()-published
            assert p.returncode==0,(p.returncode,stderr)
            assert delay<2,'terminal publication waited for idle poll instead of finalization: '+str(delay)
            assert (d/'metrics-count').read_text()=='1\n'
            assert (d/'autoscaler.completed-after-child').read_text()=='0\n'
            print('TERMINAL_WAKE_MEASUREMENT '+json.dumps({'marker_to_finalization_seconds':delay,'metrics_ticks':1}))
        finally:retire(p)
        # Foreign markers and a nonterminal signal are not completion authority.
        d=setup('foreign-and-no-marker');(d/'foreign-child.finished').write_text('0\n');cpu_before=resource.getrusage(resource.RUSAGE_CHILDREN);p=launch(d);start=time.monotonic()
        try:
            ready(p,d);os.kill(p.pid,signal.SIGCONT)
            stdout,stderr=p.communicate(timeout=13);elapsed=time.monotonic()-start
            assert p.returncode==77 and elapsed>=10,(p.returncode,elapsed,stderr)
            assert (d/'metrics-count').read_text()=='1\n2\n'
            assert not (d/'autoscaler.completed-after-child').exists()
            cpu_after=resource.getrusage(resource.RUSAGE_CHILDREN)
            print('NONTERMINAL_POLL_MEASUREMENT '+json.dumps({'seconds':elapsed,'metrics_ticks':2,'child_cpu_seconds':(cpu_after.ru_utime+cpu_after.ru_stime)-(cpu_before.ru_utime+cpu_before.ru_stime)}))
        finally:retire(p)
        for name,status,failure in [('failed-child',1,False),('worker-failure',0,True),('pending-worker',0,False)]:
            d=setup(name)
            if failure:(d/'injected-failure').touch()
            if name=='pending-worker':(d/'worker.pending').touch()
            p=launch(d)
            try:
                ready(p,d);publish(d,status)
                if name=='pending-worker':
                    wait_until(lambda:(d/'reconcile-observed').exists(),timeout=3,description='unchanged finalizer saw committed pending worker')
                    assert p.poll() is None and not (d/'autoscaler.completed-after-child').exists()
                    (d/'worker.pending').unlink()
                stdout,stderr=p.communicate(timeout=5)
                assert p.returncode==(1 if failure else 0),(name,p.returncode,stderr)
                assert (d/'metrics-count').read_text()=='1\n'
                if failure:
                    assert (d/'autoscaler.failed').read_text()=='original worker failure\n'
                    assert not (d/'autoscaler.completed-after-child').exists()
                else:assert (d/'autoscaler.completed-after-child').read_text()==str(status)+'\n'
            finally:retire(p)
        # Transient stat errors are not a notification; a disappearing hint is
        # rechecked by the original finalizer and must fail closed before ticks.
        for mode in ['transient','persistent','disappeared']:
            d=setup(mode);hook=d/'hooks';hook.mkdir()
            (hook/'sitecustomize.py').write_text('''import os
from pathlib import Path
original=os.path.exists
def observed(path):
 if str(path)!=os.environ.get('HOOK_MARKER'):return original(path)
 state=Path(os.environ['HOOK_STATE'])
 count=int(state.read_text()) if state.exists() else 0
 state.write_text(str(count+1))
 if MODE=='persistent' or (MODE=='transient' and count<3):raise OSError('injected stat failure')
 value=original(path)
 if MODE=='disappeared' and value:os.unlink(path)
 return value
os.path.exists=observed
'''.replace('MODE',repr(mode)))
            p=launch(d,hook)
            try:
                ready(p,d);published=time.monotonic();publish(d,0)
                stdout,stderr=p.communicate(timeout=13)
                if mode=='persistent':assert time.monotonic()-published>=9, 'stat errors advanced the original poll deadline'
                assert p.returncode==(1 if mode=='disappeared' else 0),(mode,p.returncode,stderr)
                assert (d/'metrics-count').read_text()=='1\n'
                if mode=='disappeared':assert not (d/'autoscaler.completed-after-child').exists()
                else:assert int((d/'hook-count').read_text())>=4
            finally:retire(p)
        for signum in [signal.SIGTERM,signal.SIGKILL]:
            d=setup('signal-'+str(signum));p=launch(d,supervised=True)
            try:
                ready(p,d);controller_pid=int((d/'controller.pid').read_text());os.killpg(controller_pid,signum);p.communicate(timeout=10)
                receipt=json.loads((d/'supervisor.json').read_text())
                assert p.returncode==78 and receipt['native_exit']==-signum and receipt['quiescent'] and receipt['remaining']==[]
                assert not (d/'autoscaler.completed-after-child').exists()
            finally:retire(p)
    print('PASS: terminal-only idle wait preserves metrics cadence, real producer, failures, pending work and cancellation')


check_autoscaler_wait_wakes_only_for_child(ROOT / 'scripts/run-bench-fleet')


def check_autoscaler_extractor_includes_terminal_wait(source: Path, extractor_source: Path) -> None:
    """Exercise the actual shared extractor used by existing autoscaler fixtures."""
    import ast
    import re

    node = next(node for node in ast.parse(extractor_source.read_text()).body
                if isinstance(node, ast.FunctionDef) and node.name == '_extract_fleet_function')
    namespace = {'re': re}
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(extractor_source), 'exec'), namespace)
    bundle = namespace['_extract_fleet_function'](source.read_text(), 'bench_autoscaler() {')
    assert bundle.count('cloudbench_wait_for_autoscaler_terminal() {') == 1, 'extracted autoscaler omitted terminal waiter'
    with tempfile.TemporaryDirectory(prefix='extracted-terminal-wait-') as directory:
        marker = Path(directory) / 'benchmark-child.finished'
        command = bundle + '\ncloudbench_wait_for_autoscaler_terminal "$1" "$2"'
        for interval in ('0', '0.0', '0e0', '.001', '1e-3'):
            result = subprocess.run(['bash', '-c', command, 'wait', str(marker), interval], capture_output=True, text=True, timeout=3)
            assert result.returncode == 0, (interval, result.returncode, result.stderr)
        marker.write_text('1\n')
        result = subprocess.run(['bash', '-c', command, 'wait', str(marker), '0'], capture_output=True, text=True, timeout=3)
        assert result.returncode == 10, result.stderr


check_autoscaler_extractor_includes_terminal_wait(
    ROOT / 'scripts/run-bench-fleet', ROOT / 'agents/benchmarks/cloudbench_dependency_sync_test.py')
