#!/usr/bin/env python3
"""Run every selected pre-merge deploy gate in parallel on isolated workers.

run (default): refuse uncommitted source, write this host's gate template
(deploy_test_plan.standard_template() with --structural-workers concurrent
structural suites and --semantic-worker-processes semantic-stack agent workers;
every gate, check and assertion is kept), select gates with deploy_test_plan.py
--list-selected --template, provision one linked worktree per selected local
gate (cloud smoke uses the benchmark CLI slot), write the worker inventory,
plan, then init/run/resume the staged cycle and verify it on the exact HEAD.
--sample-memory writes MemAvailable and per-worker RSS/PSS every 5 s;
--abort-below-mb TERMs only the cycle child after 3 consecutive low samples.
retire: remove this repository's clean, idle worker worktrees. Never forces.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time

from deploy_test_cycle import digest
from deploy_test_plan import standard_template
from deploy_test_process import cancellation_handlers, run_command

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WORKER_ROOT = '/var/tmp/rose-deploy-workers'
DEFAULT_STATE_DIR = '.context/deploy-pipeline'
OUTPUT_LEDGER = 'agents/benchmarks/history/'  # same exclusion as deploy_test_worker.prepare_checkout
# No standard gate declares its own deadline. Local transports need a finite one, so every
# slot carries the existing backend handoff deadline (deploy_test_backend.handoff_recipe).
GATE_DEADLINE_SECONDS = 14400
PREPARE_TIMEOUT_SECONDS = 3600
PROVISION_JOBS = 4
BACKEND_GATE = 'backend-coverage-blackbox'
CLOUD_GATE = 'smoke'
CLOUD_SLOT = {'id': 'cloud-smoke-worker', 'transport': 'benchmark-cloud-cli'}
SLOT_ENV = ('CONDUCTOR_WORKSPACE_NAME', 'CONDUCTOR_PORT')
# Carried when prepare-deploy-worktree.sh sets them: system-Postgres mode, trust in the hashed
# identity (otherwise workspace-env.sh renames it to the bare gate-name basename), and the
# worker's own deploy-worktree identity. Gates inherit the coordinator's environment, so a
# missing identity key would silently name the coordinator checkout instead (the backend's
# prepared-database guards then refuse the worker's database).
OPTIONAL_ENV = ('ROSE_USE_SYSTEM_PG', 'ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME', 'ROSE_DEPLOY_WORKTREE',
                'ROSE_DEPLOY_WORKTREE_PATH', 'ROSE_DEPLOY_SOURCE_WORKSPACE', 'CONDUCTOR_WORKSPACE_PATH')
# Stage receipts (scripts/run-deploy-stage) go to the coordinator's one active timing run.
RUN_ROOT_ENV, CURRENT_RUN = 'DEPLOY_RUN_ROOT', 'current'
SYSTEM_PG_MARKER = '.context/deploy-system-pg.db'
RUNNABLE = {'quick', 'initial', 'focused', 'failed-gates', 'final'}
# Host concurrency cuts (2026-11-05, 16 GB / 8-core devbox): the gates, checks and assertions
# are unchanged; only how many structural suites and semantic-stack agent workers run at once.
STRUCTURAL_GATE, SEMANTIC_GATE = 'deploy-command-structural', 'semantic-stack'
STRUCTURAL_WORKERS = 2  # standard template: run-deploy-structural-gates.py --max-workers 5
SEMANTIC_WORKER_PROCESSES = 2  # run-deploy-semantic-stack.sh default: WORKER_PROCESSES=8
SEMANTIC_ENV = 'DEPLOY_SEMANTIC_WORKER_PROCESSES'
SAMPLE_SECONDS = 5.0
LOW_MEMORY_SAMPLES = 3
LOW_MEMORY_EXIT = 3
NAME = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.-]*$')
ENV_NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')


class Blocked(Exception):
    def __init__(self, stage: str, reason: str, code: int = 2):
        super().__init__(reason)
        self.stage, self.code = stage, code


def git(root: Path, *args: str) -> str:
    return subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True, text=True).stdout


def dirty_paths(root: Path) -> list[str]:
    paths = git(root, 'diff', '--name-only', 'HEAD').splitlines()
    paths += git(root, 'ls-files', '--others', '--exclude-standard').splitlines()
    return sorted({p for p in paths if p and not p.startswith(OUTPUT_LEDGER)})


def repo_id(root: Path) -> str:
    common = Path(git(root, 'rev-parse', '--git-common-dir').strip())
    common = (common if common.is_absolute() else root / common).resolve()
    label = re.sub(r'[^A-Za-z0-9_.-]', '-', (common.parent if common.name == '.git' else common).name)
    return f"{label or 'repo'}-{hashlib.sha256(str(common).encode()).hexdigest()[:12]}"


def worker_base(root: Path) -> Path:
    base = Path(os.environ.get('DEPLOY_WORKER_ROOT') or DEFAULT_WORKER_ROOT).expanduser()
    if not base.is_absolute():
        raise Blocked('workers', f'DEPLOY_WORKER_ROOT must be absolute: {base}')
    base, root = base.resolve(), root.resolve()
    if base == root or root in base.parents:
        raise Blocked('workers', f'worker root {base} must be outside the coordinator checkout {root}')
    return base


def worker_path(base: Path, repo: str, head: str, gate: str) -> Path:
    if not NAME.fullmatch(gate):
        raise Blocked('workers', f'unsafe gate name {gate!r}')
    return base / repo / head[:12] / gate


def parse_env_file(path: Path) -> dict:
    """Read prepare-deploy-worktree.sh's `export NAME=<printf %q>` lines; later lines win."""
    values = {}
    for number, line in enumerate(path.read_text().splitlines(), 1):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        name, sep, raw = line.removeprefix('export ').partition('=')
        tokens = shlex.split(raw) if sep and '$' not in raw.replace('\\$', '') else None
        if not line.startswith('export ') or not ENV_NAME.fullmatch(name) or tokens is None or len(tokens) > 1:
            raise ValueError(f'{path}:{number}: expected export NAME=VALUE')
        values[name] = tokens[0] if tokens else ''
    return values


def registered_worktrees(root: Path) -> dict:
    entries, current = {}, None
    for line in git(root, 'worktree', 'list', '--porcelain').splitlines() + ['']:
        if line.startswith('worktree '):
            current = {'path': line[len('worktree '):]}
        elif line == '' and current is not None:
            entries[Path(current['path']).resolve()] = current
            current = None
        elif current is not None:
            key, _, value = line.partition(' ')
            current[key] = value or True
    return entries


def worker_status(path: Path, head: str, registered: dict) -> str:
    """'create' a new worker, 'reuse' a clean one at this HEAD; refuse anything else."""
    if path.resolve() not in registered:
        if path.is_symlink() or path.exists() and (not path.is_dir() or any(path.iterdir())):
            raise Blocked('workers', f'{path} exists but is not a worktree of this repository; refusing to adopt it')
        return 'create'
    if not path.is_dir():
        raise Blocked('workers', f'{path} is a registered worktree whose directory is missing; '
                                 'inspect it and run git worktree prune')
    actual = git(path, 'rev-parse', 'HEAD').strip()
    if actual != head:
        raise Blocked('workers', f'{path} is at {actual[:12]}, not {head[:12]}; refusing to reuse it')
    dirty = git(path, 'status', '--porcelain', '--untracked-files=all').splitlines()
    if dirty:
        raise Blocked('workers', f'{path} is dirty ({len(dirty)} paths, e.g. {dirty[0][3:]}); refusing to reuse it')
    return 'reuse'


def provision_commands(root: Path, path: Path, head: str, mode: str) -> list[list[str]]:
    add = [['git', '-C', str(root), 'worktree', 'add', '--detach', str(path), head]] if mode == 'create' else []
    return add + [['bash', str(root / 'scripts/prepare-deploy-worktree.sh'), '--worktree', str(path),
                   '--source', str(root)]]


def run_logged(argv: list[str], cwd: Path, log: Path, timeout: float) -> None:
    """Owned process group, bounded and cancellable; output goes to the worker's prepare log."""
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open('ab') as output:
        output.write(('$ ' + shlex.join(argv) + '\n').encode())
        output.flush()
        code, timed_out, cancelled, _ = run_command(argv, cwd=cwd, env=None, output=output, timeout=timeout)
    if code != 0 or timed_out or cancelled:
        why = 'timed out' if timed_out else 'cancelled' if cancelled else f'exited {code}'
        raise Blocked('workers', f'{shlex.join(argv[:3])} {why}; see {log}')


def backend_recipe(root: Path, env: dict, timeout: float) -> dict:
    """The native backend slot needs its frozen multi-case recipe (deploy_test_backend --handoff-slot)."""
    from deploy_test_backend import RUNNER, handoff_recipe, selection
    aggregate = {'cases': {BACKEND_GATE: {'command': list(RUNNER), 'cwd': 'back-end', 'env': dict(env),
                                          'aggregate': True}}}
    return handoff_recipe(aggregate, selection(root)[1], timeout)


def run_root(root: Path) -> Path:
    """The coordinator's deploy timing-run root (run-deploy-stage's DEPLOY_RUN_ROOT default)."""
    value = os.environ.get(RUN_ROOT_ENV)
    return Path(value).resolve() if value else (root / '.context/deploy-runs').resolve()


def local_slot(root: Path, gate: str, path: Path, values: dict) -> dict:
    missing = [key for key in SLOT_ENV if not values.get(key)]
    if missing:
        raise Blocked('workers', f'{gate}: prepared worker env lacks {", ".join(missing)}')
    if values.get('ROSE_DEPLOY_WORKTREE_PATH', str(path)) != str(path):
        raise Blocked('workers', f'{gate}: prepared env belongs to {values["ROSE_DEPLOY_WORKTREE_PATH"]}, not {path}')
    env = {key: values[key] for key in (*SLOT_ENV, *OPTIONAL_ENV) if values.get(key)}
    env[RUN_ROOT_ENV] = str(run_root(root))
    marker = path / SYSTEM_PG_MARKER
    if gate == BACKEND_GATE and values.get('ROSE_USE_SYSTEM_PG') == 'true' and marker.is_file():
        # run-coverage.sh refuses an isolated system-Postgres worktree without this exact prepared database.
        env['BACKEND_COVERAGE_DATABASE_URL'] = ('postgresql://postgres:postgres@localhost:5432/'
                                                + marker.read_text().strip())
    slot = {'id': f'{gate}-local', 'transport': 'local-isolated', 'worker_root': str(path), 'cwd': str(path),
            'env': env, 'timeout_seconds': GATE_DEADLINE_SECONDS}
    if gate == BACKEND_GATE:
        slot['recipe'] = backend_recipe(root, env, GATE_DEADLINE_SECONDS)
    return slot


def provision(root: Path, gate: str, path: Path, head: str, mode: str, logs: Path, add_lock) -> dict:
    log = logs / f'{gate}.prepare.log'
    for argv in provision_commands(root, path, head, mode):
        if argv[0] == 'git':
            path.parent.mkdir(parents=True, exist_ok=True)
            with add_lock:  # worktree admin entries are created one at a time
                run_logged(argv, root, log, PREPARE_TIMEOUT_SECONDS)
        else:  # the script locks the shared port registry itself
            run_logged(argv, root, log, PREPARE_TIMEOUT_SECONDS)
    return local_slot(root, gate, path, parse_env_file(path / '.context/deploy-worktree.env'))


def layout(root: Path, head: str, needs_worker: list[str]) -> list[dict]:
    base, repo, registered = worker_base(root), repo_id(root), registered_worktrees(root)
    workers = []
    for gate in needs_worker:
        if gate == CLOUD_GATE:
            workers.append({'gate': gate, 'mode': 'cloud', 'slot': dict(CLOUD_SLOT)})
            continue
        path = worker_path(base, repo, head, gate)
        try:
            mode, reason = worker_status(path, head, registered), None
        except Blocked as error:
            mode, reason = 'refuse', str(error)
        workers.append({'gate': gate, 'mode': mode, 'path': str(path), 'reason': reason,
                        'commands': provision_commands(root, path, head, mode) if mode != 'refuse' else []})
    return workers


def build_inventory(root: Path, head: str, workers: list[dict], logs: Path, jobs: int = PROVISION_JOBS) -> dict:
    refused = [w['reason'] for w in workers if w['mode'] == 'refuse']
    if refused:  # nothing is created while any worker would be refused
        raise Blocked('workers', '; '.join(refused))
    local = [w for w in workers if w['mode'] != 'cloud']
    lock, results, errors = threading.Lock(), {}, []
    with cancellation_handlers(), ThreadPoolExecutor(max_workers=max(1, min(jobs, len(local) or 1))) as pool:
        futures = {w['gate']: pool.submit(provision, root, w['gate'], Path(w['path']), head, w['mode'], logs, lock)
                   for w in local}
        for gate, future in futures.items():  # every peer finishes; failures are reported together
            try:
                results[gate] = future.result()
            except (Blocked, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
                errors.append(f'{gate}: {error}')
    if errors:
        raise Blocked('workers', '; '.join(errors))
    return {w['gate']: w['slot'] if w['mode'] == 'cloud' else results[w['gate']] for w in workers}


def footprint_conflicts(inventory: dict) -> list[str]:
    """The planner's isolation rule, reported per pair before planning (it only says 'share a port')."""
    from deploy_test_isolation import _ports
    seen, conflicts = {}, []
    for gate, slot in inventory.items():
        if slot.get('transport') != 'local-isolated':
            continue
        base = int(slot['env']['CONDUCTOR_PORT'])
        ports = {base + offset for offset in _ports.LISTENER_OFFSETS}
        conflicts += [f'{other}({other_base}) and {gate}({base}) share {len(ports & theirs)} listener ports'
                      for other, (other_base, theirs) in seen.items() if ports & theirs]
        seen[gate] = (base, ports)
    return conflicts


def build_template(structural_workers: int, semantic_worker_processes: int, standard=None) -> dict:
    """The standard full-suite template with this host's concurrency; nothing else changes."""
    template, found = copy.deepcopy((standard or standard_template)()), set()
    for gate in template['gates']:
        if gate['name'] == STRUCTURAL_GATE:
            command = list(gate['command'])
            if command.count('--max-workers') != 1 or command.index('--max-workers') + 1 >= len(command):
                raise Blocked('template', f'{STRUCTURAL_GATE} command has no single --max-workers value: '
                                          f'{shlex.join(command)}')
            command[command.index('--max-workers') + 1] = str(structural_workers)
            gate['command'] = command
        elif gate['name'] == SEMANTIC_GATE:
            gate['env'] = {**gate.get('env', {}), SEMANTIC_ENV: str(semantic_worker_processes)}
        else:
            continue
        found.add(gate['name'])
    missing = sorted({STRUCTURAL_GATE, SEMANTIC_GATE} - found)
    if missing:
        raise Blocked('template', 'standard template lacks ' + ', '.join(missing) + '; refusing to plan without '
                                  'the host concurrency cut')
    return template


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    os.replace(temporary, path)


def list_selected(root: Path, base: str, skip_agentcard: str | None, template: Path) -> dict:
    argv = [sys.executable, str(root / 'scripts/deploy_test_plan.py'), '--list-selected', '--base', base,
            '--template', str(template)]
    if skip_agentcard is not None:
        argv += ['--skip-agentcard', skip_agentcard]
    out = subprocess.run(argv, cwd=root, stdout=subprocess.PIPE, text=True)
    if out.returncode:
        raise Blocked('select', f'deploy_test_plan.py --list-selected exited {out.returncode}', out.returncode)
    selection = json.loads(out.stdout)
    if not all(isinstance(selection.get(k), list) for k in ('selected', 'quick', 'needs_worker', 'omitted')):
        raise Blocked('select', 'deploy_test_plan.py --list-selected returned an incomplete selection')
    return selection


def stream(argv: list[str], cwd: Path, on_start=None) -> int:
    """Inherit stdout/stderr; forward TERM/INT so the cycle records `interrupted` itself.

    on_start(proc) receives this exact child (the memory sampler's only abort target)."""
    proc = subprocess.Popen(argv, cwd=cwd)
    previous = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGINT)}
    for s in previous:
        signal.signal(s, lambda number, _frame: proc.send_signal(number))
    try:
        if on_start is not None:
            on_start(proc)
        return proc.wait()
    finally:
        if on_start is not None:
            on_start(None)
        for s, handler in previous.items():
            signal.signal(s, handler)


def meminfo(proc: Path = Path('/proc')) -> dict:
    """MemTotal/MemAvailable in MB from /proc/meminfo (kB lines)."""
    values = {}
    for line in (proc / 'meminfo').read_text().splitlines():
        name, _, rest = line.partition(':')
        if name in ('MemTotal', 'MemAvailable'):
            values[name] = int(rest.split()[0]) / 1024
    if set(values) != {'MemTotal', 'MemAvailable'}:
        raise ValueError(f'{proc / "meminfo"} lacks MemTotal/MemAvailable')
    return {'mem_total_mb': round(values['MemTotal'], 1), 'mem_available_mb': round(values['MemAvailable'], 1)}


def process_table(proc: Path = Path('/proc'), page_size: int | None = None) -> dict:
    """pid -> ppid, comm, cwd (None when unreadable), rss_kb, pss_kb (None when unreadable)."""
    page_kb = (page_size or os.sysconf('SC_PAGE_SIZE')) / 1024
    table = {}
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / 'stat').read_text()
            comm, fields = stat[stat.index('(') + 1:stat.rindex(')')], stat[stat.rindex(')') + 2:].split()
            rss_kb = int((entry / 'statm').read_text().split()[1]) * page_kb
        except (OSError, ValueError, IndexError):
            continue  # exited between listing and reading
        try:
            cwd = os.readlink(entry / 'cwd').removesuffix(' (deleted)')
        except OSError:
            cwd = None  # another user's process, or a kernel thread
        pss_kb = None
        try:
            for line in (entry / 'smaps_rollup').read_text().splitlines():
                if line.startswith('Pss:'):
                    pss_kb = int(line.split()[1])
                    break
        except (OSError, ValueError, IndexError):
            pass
        table[int(entry.name)] = {'ppid': int(fields[1]), 'comm': comm, 'cwd': cwd, 'rss_kb': rss_kb, 'pss_kb': pss_kb}
    return table


def attribute(table: dict, roots: dict) -> dict:
    """pid -> bucket: the deepest root containing its cwd, else its nearest such ancestor's
    (fixtures that chdir to /tmp stay with their gate), else 'postgres' by name, else 'other'."""
    ordered = sorted(((name, str(Path(path))) for name, path in roots.items()), key=lambda item: -len(item[1]))

    def direct(pid):
        cwd = table[pid]['cwd']
        if cwd is None:
            return None
        return next((name for name, root in ordered if cwd == root or cwd.startswith(root + os.sep)), None)

    buckets = {}
    for pid in table:
        chain, current, found = [], pid, None
        while current in table and current not in buckets and len(chain) < 4096:
            chain.append(current)
            found = direct(current)
            if found:
                break
            current = table[current]['ppid']
        if found is None and current in buckets and buckets[current] not in ('postgres', 'other'):
            found = buckets[current]
        for member in chain:
            buckets[member] = found or ('postgres' if table[member]['comm'] == 'postgres' else 'other')
    return buckets


def summarize(table: dict, buckets: dict) -> dict:
    out = {}
    for pid, bucket in buckets.items():
        row = out.setdefault(bucket, {'processes': 0, 'rss_kb': 0.0, 'pss_kb': 0.0, 'pss_unreadable': 0})
        row['processes'] += 1
        row['rss_kb'] += table[pid]['rss_kb']
        if table[pid]['pss_kb'] is None:
            row['pss_unreadable'] += 1
        else:
            row['pss_kb'] += table[pid]['pss_kb']
    return {bucket: {'processes': row['processes'], 'rss_mb': round(row['rss_kb'] / 1024, 1),
                     'pss_mb': round(row['pss_kb'] / 1024, 1), 'pss_unreadable': row['pss_unreadable']}
            for bucket, row in sorted(out.items())}


def low_memory(samples: list[dict], threshold_mb: float, count: int = LOW_MEMORY_SAMPLES) -> bool:
    """True when each of the last `count` samples had MemAvailable strictly below the threshold."""
    recent = samples[-count:]
    return len(recent) == count and all(s['mem_available_mb'] < threshold_mb for s in recent)


class MemorySampler(threading.Thread):
    """Background JSONL sampler. Its only action is TERM to the watched deploy_test_cycle child."""

    def __init__(self, path: Path, roots: dict, abort_below_mb: float | None = None,
                 interval: float = SAMPLE_SECONDS, proc: Path = Path('/proc')):
        super().__init__(name='deploy-gates-memory', daemon=True)
        self.path, self.abort_below_mb, self.interval, self.proc = path, abort_below_mb, interval, proc
        self.roots, self.lock, self.stopping = dict(roots), threading.Lock(), threading.Event()
        self.target, self.aborted, self.samples, self.errors = None, None, [], 0
        self.peaks, self.started = {}, time.time()

    def set_roots(self, roots: dict) -> None:
        with self.lock:
            self.roots.update(roots)

    def watch(self, target) -> None:
        with self.lock:
            self.target = target

    def emit(self, record: dict) -> None:
        with self.path.open('a') as output:
            output.write(json.dumps(record, sort_keys=True) + '\n')

    def sample(self) -> dict:
        now = time.time()
        with self.lock:
            roots = dict(self.roots)
        table = process_table(self.proc)
        groups = summarize(table, attribute(table, roots))
        memory = meminfo(self.proc)
        tracked = [name for name in roots if name in groups]
        record = {'kind': 'sample', 'ts': datetime.fromtimestamp(now, timezone.utc).isoformat(timespec='seconds'),
                  'epoch': round(now, 3), **memory,
                  'used_mb': round(memory['mem_total_mb'] - memory['mem_available_mb'], 1),
                  'tracked_rss_mb': round(sum(groups[n]['rss_mb'] for n in tracked), 1),
                  'tracked_pss_mb': round(sum(groups[n]['pss_mb'] for n in tracked), 1), 'groups': groups}
        self.observe(record)
        return record

    def observe(self, record: dict) -> None:
        def peak(key, value, lower=False):
            best = self.peaks.get(key)
            if best is None or (value < best['value'] if lower else value > best['value']):
                self.peaks[key] = {'value': value, 'ts': record['ts']}
        peak('min_available_mb', record['mem_available_mb'], lower=True)
        for key in ('used_mb', 'tracked_rss_mb', 'tracked_pss_mb'):
            peak('max_' + key, record[key])
        for name, row in record['groups'].items():
            peak(f'{name}.rss_mb', row['rss_mb'])
            peak(f'{name}.pss_mb', row['pss_mb'])

    def check_abort(self) -> None:
        if self.abort_below_mb is None or self.aborted or not low_memory(self.samples, self.abort_below_mb):
            return
        with self.lock:
            target = self.target
            if target is None or target.poll() is not None:
                return  # only a live deploy_test_cycle child this command launched is ever signalled
            target.send_signal(signal.SIGTERM)
            self.aborted = {'kind': 'abort', 'status': 'ABORTED_LOW_MEMORY', 'target_pid': target.pid,
                            'threshold_mb': self.abort_below_mb, 'consecutive': LOW_MEMORY_SAMPLES,
                            'ts': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                            'last_samples': self.samples[-LOW_MEMORY_SAMPLES:]}
        self.emit(self.aborted)
        print(f"DEPLOY_GATES ABORTED_LOW_MEMORY: MemAvailable stayed below {self.abort_below_mb:g} MB for "
              f"{LOW_MEMORY_SAMPLES} samples ({', '.join(str(s['mem_available_mb']) for s in self.aborted['last_samples'])}"
              f" MB); sent TERM to deploy_test_cycle pid {target.pid}", flush=True)

    def run(self) -> None:
        while True:
            try:
                self.samples.append(self.sample())
                self.samples = self.samples[-LOW_MEMORY_SAMPLES:]
                self.emit(self.samples[-1])
                self.check_abort()
            except (OSError, ValueError) as error:
                self.errors += 1
                try:
                    self.emit({'kind': 'error', 'ts': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                               'error': str(error)})
                except OSError:
                    pass
            if self.stopping.wait(self.interval):
                return

    def begin(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.emit({'kind': 'start', 'ts': datetime.fromtimestamp(self.started, timezone.utc).isoformat(
            timespec='seconds'), 'pid': os.getpid(), 'interval_seconds': self.interval,
            'abort_below_mb': self.abort_below_mb, 'roots': {k: str(v) for k, v in self.roots.items()}})
        self.start()

    def finish(self) -> dict:
        self.stopping.set()
        if self.is_alive():
            self.join()
        summary = {'kind': 'summary', 'ts': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                   'wall_seconds': round(time.time() - self.started, 1), 'errors': self.errors,
                   'aborted': bool(self.aborted), 'roots': {k: str(v) for k, v in self.roots.items()},
                   'peaks': self.peaks}
        self.emit(summary)
        low = self.peaks.get('min_available_mb', {})
        high = self.peaks.get('max_used_mb', {})
        print(f"DEPLOY_GATES MEMORY samples={self.path} min_available_mb={low.get('value')} at {low.get('ts')} "
              f"max_used_mb={high.get('value')} at {high.get('ts')} errors={self.errors}", flush=True)
        return summary


def next_step(state_dir: Path, plan: dict) -> tuple[str, str | None]:
    """Never reset a cycle: init only when none exists; an existing one must be for this plan."""
    cycle = state_dir / 'cycle.json'
    if not cycle.exists():
        return 'init', None
    state = json.loads(cycle.read_text())
    phase = state.get('phase')
    if state.get('plan_digest') != digest(plan):
        raise Blocked('cycle', f'{cycle} (phase {phase}) is bound to a different plan or source; it was kept '
                               'unchanged. Use deploy_test_cycle.py refresh --input <its plan>, or a new --state-dir')
    if phase == 'interrupted':
        return 'resume', phase
    if phase == 'ready' and state.get('ready') is True:
        return 'verify', phase
    return ('run' if phase in RUNNABLE else 'status'), phase


def state_directory(root: Path, value: Path | None) -> Path:
    path = Path(value or os.environ.get('DEPLOY_TEST_CYCLE_STATE_DIR') or DEFAULT_STATE_DIR)
    return (path if path.is_absolute() else root / path).resolve()


def run(args, root: Path) -> int:
    root, head, sampler = root.resolve(), 'unknown', None
    try:
        head = git(root, 'rev-parse', 'HEAD').strip()
        dirty = dirty_paths(root)
        if dirty:
            raise Blocked('source', f'commit the frozen source before preparing workers ({len(dirty)} uncommitted, '
                                    f'e.g. {", ".join(dirty[:5])}); only {OUTPUT_LEDGER} may differ')
        state_dir = state_directory(root, args.state_dir)
        timing = run_root(root) / CURRENT_RUN
        if not args.dry_run and not timing.is_file():
            raise Blocked('timing', f'no active deploy timing run ({timing} is missing); start one with '
                                    'bash scripts/run-deploy-stage --start before running gates')
        template = build_template(args.structural_workers, args.semantic_worker_processes)
        template_path, candidate_template = state_dir / 'template.json', state_dir / 'template.candidate.json'
        if args.dry_run:  # the template goes to a scratch file; the state directory is not created
            with tempfile.TemporaryDirectory(prefix='deploy-gates-dry-run-') as scratch:
                write_json(Path(scratch) / 'template.json', template)
                selection = list_selected(root, args.base, args.skip_agentcard, Path(scratch) / 'template.json')
        else:
            write_json(candidate_template, template)
            if args.sample_memory is not None:
                target = args.sample_memory if args.sample_memory.is_absolute() else root / args.sample_memory
                sampler = MemorySampler(target.resolve(), {'coordinator': root}, args.abort_below_mb)
                sampler.begin()
            selection = list_selected(root, args.base, args.skip_agentcard, candidate_template)
        workers = layout(root, head, selection['needs_worker'])
        if sampler is not None:
            sampler.set_roots({w['gate']: Path(w['path']) for w in workers if w['mode'] in ('create', 'reuse')})
        py = sys.executable
        plan_path, inventory_path = state_dir / 'plan.json', state_dir / 'inventory.json'
        candidate_plan, candidate_inventory = state_dir / 'plan.candidate.json', state_dir / 'inventory.candidate.json'
        planner = [py, str(root / 'scripts/deploy_test_plan.py'), '--inventory', str(candidate_inventory),
                   '--base', args.base, '--template', str(candidate_template), '--output', str(candidate_plan)]
        if args.skip_agentcard is not None:
            planner += ['--skip-agentcard', args.skip_agentcard]
        cycle = [py, str(root / 'scripts/deploy_test_cycle.py')]
        bound = ['--plan', str(plan_path), '--state-dir', str(state_dir)]
        launcher = ['--rca-launcher', *args.rca_launcher] if args.rca_launcher else []
        verify = [py, str(root / 'scripts/run_deploy_pipeline.py'), 'verify', '--require-staged',
                  '--state-dir', str(state_dir), '--expect-head', head]
        if args.dry_run:
            print(json.dumps({'head': head, 'selection': selection, 'state_dir': str(state_dir),
                              'timing_run': {'current': str(timing), 'active': timing.is_file()},
                              'template': {'path': str(template_path), 'structural_workers': args.structural_workers,
                                           'semantic_worker_processes': args.semantic_worker_processes},
                              'inventory': str(inventory_path), 'workers': workers,
                              'then': [planner, [*cycle, 'init', *bound], [*cycle, 'run', *bound, *launcher], verify]},
                             indent=2))
            refused = [w['reason'] for w in workers if w['mode'] == 'refuse']
            if refused:
                raise Blocked('workers', '; '.join(refused))
            print(f"DEPLOY_GATES DRY-RUN head={head[:12]} gates={len(selection['selected'])} "
                  f"workers={sum(w['mode'] != 'cloud' for w in workers)}")
            return 0
        inventory = build_inventory(root, head, workers, state_dir / 'workers', args.provision_jobs)
        conflicts = footprint_conflicts(inventory)
        if conflicts:
            raise Blocked('workers', 'prepared port claims overlap the isolation footprint '
                                     '(deploy-worktree-port.py claims bases whose whole LISTENER_OFFSETS footprints '
                                     'are disjoint, as deploy_test_isolation requires; these registry claims are '
                                     'not): ' + '; '.join(conflicts))
        state_dir.mkdir(parents=True, exist_ok=True)
        candidate_inventory.write_text(json.dumps(inventory, indent=2) + '\n')
        code = stream(planner, root)
        if code:
            raise Blocked('plan', f'deploy_test_plan.py exited {code}', code)
        step, phase = next_step(state_dir, json.loads(candidate_plan.read_text()))
        os.replace(candidate_template, template_path)
        os.replace(candidate_inventory, inventory_path)
        os.replace(candidate_plan, plan_path)

        def cycle_stream(argv: list[str]) -> int:
            code = stream(argv, root, on_start=sampler.watch if sampler is not None else None)
            if sampler is not None and sampler.aborted:
                raise Blocked('memory', f"ABORTED_LOW_MEMORY: MemAvailable stayed below {args.abort_below_mb:g} MB "
                                        f'for {LOW_MEMORY_SAMPLES} consecutive samples; TERM sent to '
                                        f"deploy_test_cycle.py {argv[2]} (pid {sampler.aborted['target_pid']}), "
                                        f'which exited {code}; see {sampler.path} and {state_dir}/cycle.json',
                              LOW_MEMORY_EXIT)
            return code

        if step == 'status':
            cycle_stream([*cycle, 'status', *bound])
            raise Blocked('cycle', f'existing cycle is in phase {phase}; continue it with deploy_test_cycle.py '
                                   '(triage/focus/refresh) before rerunning gates', 1)
        if step == 'init':
            code = cycle_stream([*cycle, 'init', *bound])
            if code:
                raise Blocked('init', f'deploy_test_cycle.py init exited {code}', code)
        if step != 'verify':
            action = 'resume' if step == 'resume' else 'run'
            code = cycle_stream([*cycle, action, *bound, *launcher])
            if code:
                raise Blocked('cycle', f'deploy_test_cycle.py {action} exited {code} (see {state_dir}/cycle.json)', code)
        code = stream(verify, root)
        if code:
            raise Blocked('verify', f'run_deploy_pipeline.py verify --require-staged exited {code}', code)
        print(f"DEPLOY_GATES PASS head={head[:12]} gates={len(selection['selected'])}")
        return 0
    except Blocked as error:
        print(f'DEPLOY_GATES BLOCKED head={head[:12]} stage={error.stage} exit={error.code}: {error}')
        return error.code
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f'DEPLOY_GATES BLOCKED head={head[:12]} stage=internal exit=2: {error}')
        return 2
    finally:
        if sampler is not None:
            sampler.finish()


def live_processes(path: Path, proc: Path = Path('/proc')) -> list[int] | None:
    """PIDs whose cwd is inside path; None when this host cannot be observed."""
    if not proc.is_dir():
        return None
    target, pids = str(path.resolve()), []
    for entry in proc.iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            cwd = os.readlink(entry / 'cwd').removesuffix(' (deleted)')
        except OSError:
            continue  # exited, or another user's process (a worker runs as this user)
        if cwd == target or cwd.startswith(target + os.sep):
            pids.append(int(entry.name))
    return sorted(pids)


def retire_blocker(path: Path, entry: dict, proc: Path) -> str | None:
    if entry.get('locked'):
        return 'worktree is locked'
    if not path.is_dir():
        return 'registered directory is missing; inspect it and run git worktree prune'
    dirty = git(path, 'status', '--porcelain', '--untracked-files=all').splitlines()
    if dirty:
        return f'dirty: {len(dirty)} changed or untracked paths (e.g. {dirty[0][3:]})'
    pids = live_processes(path, proc)
    if pids is None:
        return 'process working directories cannot be observed on this host'
    if pids:
        return 'live process cwd inside: pid ' + ', '.join(map(str, pids))
    return None


def resources(path: Path) -> str:
    try:
        values = parse_env_file(path / '.context/deploy-worktree.env')
    except (OSError, ValueError):
        return 'no prepared env; no port claim or database recorded'
    marker = path / '.context/deploy-system-pg.db'
    name = values.get('CONDUCTOR_WORKSPACE_NAME', '?')
    database = (f'system Postgres database {marker.read_text().strip()}' if marker.is_file()
                else f'Docker container victoria-db-{name} and volume victoria-pgdata-{name}')
    return (f'port claim {values.get("CONDUCTOR_PORT", "?")} is released by the registry once its owner '
            f'directory is gone; {database} retained (no owned teardown tool)')


def retire(args, root: Path, proc: Path = Path('/proc')) -> int:
    root = root.resolve()
    try:
        scope = worker_base(root) / repo_id(root)
        if args.head:
            if not NAME.fullmatch(args.head):
                raise Blocked('retire', f'invalid --head {args.head!r}')
            scope = scope / args.head[:12]
        registered = registered_worktrees(root)
    except Blocked as error:
        print(f'DEPLOY_GATES BLOCKED stage={error.stage} exit={error.code}: {error}')
        return error.code
    owned = sorted(p for p in registered if scope in p.parents and p != root)
    depth = 1 if args.head else 2
    strays = sorted(p.resolve() for p in scope.glob('/'.join(['*'] * depth))
                    if p.is_dir() and p.resolve() not in registered) if scope.is_dir() else []
    removed, retained = [], [(p, 'not a registered worktree of this repository') for p in strays]
    for path in owned:
        reason = retire_blocker(path, registered[path], proc)
        if reason:
            retained.append((path, reason))
            continue
        note = resources(path)
        if args.dry_run:
            print(f'WOULD REMOVE {path}: {note}')
            removed.append(path)
            continue
        out = subprocess.run(['git', '-C', str(root), 'worktree', 'remove', str(path)], capture_output=True, text=True)
        if out.returncode:
            retained.append((path, 'git worktree remove refused: ' + (out.stderr.strip() or f'exit {out.returncode}')))
            continue
        removed.append(path)
        print(f'REMOVED {path}: {note}')
        for parent in (path.parent, path.parent.parent):
            if parent != scope.parent and scope in (parent, *parent.parents):
                try:
                    parent.rmdir()  # only an empty HEAD/repository directory
                except OSError:
                    break
    for path, reason in retained:
        print(f'RETAINED {path}: {reason}')
    verb = 'RETIRE DRY-RUN would_remove' if args.dry_run else 'RETIRE removed'
    print(f'DEPLOY_GATES {verb}={len(removed)} retained={len(retained)}')
    return 1 if retained else 0


def main(argv: list[str] | None = None, prog: str | None = None) -> int:
    parser = argparse.ArgumentParser(prog=prog, description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', nargs='?', choices=('run', 'retire'), default='run')
    parser.add_argument('--base', default='origin/main', help='selection diff base (default: origin/main)')
    parser.add_argument('--state-dir', type=Path,
                        help='cycle state directory (default: $DEPLOY_TEST_CYCLE_STATE_DIR or .context/deploy-pipeline)')
    parser.add_argument('--skip-agentcard', metavar='REASON',
                        help='explicitly skip the AgentCard lifecycle category, recording why')
    parser.add_argument('--dry-run', action='store_true',
                        help='print the selection, worker paths and commands (retire: decisions); change nothing')
    parser.add_argument('--provision-jobs', type=int, default=PROVISION_JOBS,
                        help=f'concurrent worker preparations (default: {PROVISION_JOBS}); gates still all run at once')
    parser.add_argument('--head', help='retire: only workers prepared for this commit (default: every HEAD)')
    parser.add_argument('--structural-workers', type=int, metavar='N',
                        help=f'run: concurrent suites for {STRUCTURAL_GATE} (--max-workers; default: '
                             f'{STRUCTURAL_WORKERS})')
    parser.add_argument('--semantic-worker-processes', type=int, metavar='N',
                        help=f'run: agent worker processes for the {SEMANTIC_GATE} stack ({SEMANTIC_ENV}; '
                             f'default: {SEMANTIC_WORKER_PROCESSES})')
    parser.add_argument('--sample-memory', type=Path, metavar='PATH',
                        help=f'run: append MemAvailable and per-worker RSS/PSS JSONL every {SAMPLE_SECONDS:g} s')
    parser.add_argument('--abort-below-mb', type=float, metavar='N',
                        help=f'run (with --sample-memory): after {LOW_MEMORY_SAMPLES} consecutive samples below N MB '
                             f'MemAvailable, TERM only the deploy_test_cycle child and exit {LOW_MEMORY_EXIT}')
    parser.add_argument('--rca-launcher', nargs=argparse.REMAINDER,
                        help='run: remaining argv passed to deploy_test_cycle.py --rca-launcher (must be last)')
    args = parser.parse_args(argv)
    if args.skip_agentcard is not None and not args.skip_agentcard.strip():
        parser.error('--skip-agentcard requires a nonempty reason')
    if args.provision_jobs < 1:
        parser.error('--provision-jobs must be at least 1')
    if args.action == 'retire' and (args.rca_launcher or args.skip_agentcard is not None):
        parser.error('retire takes no --rca-launcher or --skip-agentcard')
    if args.action == 'run' and args.head:
        parser.error('--head applies to retire only')
    run_only = ('structural_workers', 'semantic_worker_processes', 'sample_memory', 'abort_below_mb')
    if args.action == 'retire' and any(getattr(args, key) is not None for key in run_only):
        parser.error('retire takes no --structural-workers, --semantic-worker-processes, --sample-memory or '
                     '--abort-below-mb')
    if args.dry_run and (args.sample_memory is not None or args.abort_below_mb is not None):
        parser.error('--dry-run runs no gates to sample or abort')
    if args.abort_below_mb is not None and (args.sample_memory is None or not args.abort_below_mb > 0):
        parser.error('--abort-below-mb requires --sample-memory and a positive MB value')
    if args.structural_workers is None:
        args.structural_workers = STRUCTURAL_WORKERS
    if args.semantic_worker_processes is None:
        args.semantic_worker_processes = SEMANTIC_WORKER_PROCESSES
    if args.structural_workers < 1:
        parser.error('--structural-workers must be at least 1')
    if not 1 <= args.semantic_worker_processes <= 999:
        parser.error('--semantic-worker-processes must be 1..999')
    return retire(args, ROOT) if args.action == 'retire' else run(args, ROOT)


if __name__ == '__main__':
    raise SystemExit(main())
