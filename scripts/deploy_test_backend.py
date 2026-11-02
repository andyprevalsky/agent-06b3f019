#!/usr/bin/env python3
"""Case-aware staged adapter over the existing sharded backend coverage runner.

One unchanged full sweep (`npm run test:coverage:sharded`, or the existing
`--failed-first N` recipe for repair phases) produces per-domain, unit, fps,
threshold and teardown cases from its own native artifacts. Nothing is rerun
per domain; a partial-coverage threshold failure is inconclusive, never FAIL.
"""
import argparse
import hashlib
import json
import math
import shutil
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from deploy_test_cycle import ROOT, exclusive, read, source, write
from deploy_test_process import CANCEL, cancellation_handlers, run_command

RUNNER = ['npm', 'run', 'test:coverage:sharded']
FAILED_FIRST = ['bash', 'scripts/run-coverage-sharded.sh', '--failed-first']
TEARDOWN = 'scripts/tests/blackbox-backend-teardown.test.sh'
FIXED = ('units', 'fps', 'coverage-threshold', 'teardown')
UNIT_LINE = re.compile(r'^(✅ Unit pass passed|❌ Unit pass failed \(exit (\d+)\))', re.M)
FPS_LINE = re.compile(r'^(✅ fps probe pass passed|❌ fps probe pass failed \(exit (\d+)\))', re.M)


DOMAIN = re.compile(r'^[A-Za-z0-9_.-]+$')
LIST_FOOTER = re.compile(r'^Total: (\d+) domains$', re.M)


def list_domains(root):
    """Frozen inventory = the exact filesystem rule run.ts uses (readdirSync *.blackbox.ts); no subprocess, no env."""
    folder = Path(root) / 'back-end/src/tests/blackbox'
    names = sorted(p.name[:-len('.blackbox.ts')] for p in folder.iterdir() if p.name.endswith('.blackbox.ts'))
    return validate_inventory(names)


def validate_inventory(names):
    if not names or len(set(names)) != len(names) or any(not DOMAIN.fullmatch(n) for n in names):
        raise ValueError('inventory_invalid')
    return names


def parse_native_list(text, files):
    """Cross-check `run.ts --list` output: indented domain lines only, footer count, exact file-set equality."""
    names = [line.strip() for line in text.splitlines() if line.startswith((' ', '\t')) and line.strip()]
    footer = LIST_FOOTER.search(text)
    if footer is None or int(footer.group(1)) != len(names) or sorted(names) != sorted(files):
        raise ValueError('inventory_invalid')
    return validate_inventory(names)


SKIP_CALL = re.compile(r'^\s*append_blackbox_skip_domain\b.*?"([A-Za-z0-9_.-]+)"', re.M)
EXCLUSION_REASON = {'integration-health': 'owned by live-probes'}
SKIP_ENV = ('BLACKBOX_TEST_SKIP_DOMAINS', 'CONTRACT_TEST_SKIP_DOMAINS')


def producer_exclusions(root):
    """The sweep's own fixed exclusions, read from run-coverage.sh (append_blackbox_skip_domain … "<domain>")."""
    text = (Path(root) / 'back-end/scripts/run-coverage.sh').read_text()
    found = sorted(set(SKIP_CALL.findall(text)))
    if set(found) != set(EXCLUSION_REASON):
        raise ValueError(f'producer exclusions changed: {found}; update EXCLUSION_REASON deliberately')
    return found


def selection(root):
    inventory = list_domains(root)
    excluded = producer_exclusions(root)
    effective = [d for d in inventory if d not in excluded]
    return {'inventory': len(inventory), 'excluded': {d: EXCLUSION_REASON[d] for d in excluded},
            'effective': len(effective)}, effective


def refuse_env_skips(*envs):
    for env in envs:
        for key in SKIP_ENV:
            extra = {d for d in (env or {}).get(key, '').replace(';', ',').split(',') if d.strip()} - set(EXCLUSION_REASON)
            if extra:
                raise ValueError('skip_env_not_allowed')


def checks_for(domains):
    return [f'blackbox:{d}' for d in domains] + list(FIXED)


def phase(pattern, text):
    match = pattern.search(text)
    if not match:
        return 'UNVERIFIED', None
    return ('PASS', 0) if match.group(2) is None else ('FAIL', int(match.group(2)))


def domain_cases(root, domains, started):
    cases, seen, hashes, unknown = {f'blackbox:{d}': 'UNVERIFIED' for d in domains}, {}, {}, []
    for path in sorted((root / 'back-end/coverage').glob('blackbox-run-shard*/summary.json')):
        if path.stat().st_mtime < started - 1:
            continue  # stale summary from an earlier sweep
        hashes[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
        for row in read(path).get('results', []):
            domain = row.get('domain') if isinstance(row, dict) else None
            name = f'blackbox:{domain}'
            if domain in EXCLUSION_REASON:
                seen.setdefault('excluded_rows', []).append({'domain': domain, 'shard': str(path)})
                continue  # noted, never a case
            if name not in cases:
                unknown.append(domain)
                continue
            if name in seen:
                cases[name] = 'UNVERIFIED'; seen[name] = {'duplicate': True}
                continue
            seen[name] = {'shard': str(path), 'passed': row.get('passed'), 'aborted': row.get('aborted')}
            if type(row.get('passed')) is not bool or type(row.get('aborted')) is not bool or row['aborted']:
                cases[name] = 'UNVERIFIED'
            else:
                cases[name] = 'PASS' if row['passed'] else 'FAIL'
    if unknown:  # never silently add a domain outside the frozen inventory
        cases = dict.fromkeys(cases, 'UNVERIFIED')
    return cases, seen, hashes, unknown


def sha_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest() if Path(path).is_file() else None


ARCHIVE_LINE = re.compile(r"^Passing phases' raw coverage archived at (.+?/raw-v8)\.$", re.M)
FAILED_SHARD_LINE = re.compile(r"^\s+Raw V8 coverage: (.+?/raw-v8)\s*$", re.M)
SHARD_START_LINE = re.compile(r'^Started coverage shard ([1-9][0-9]*)/[1-9][0-9]* \(pid ([0-9]+), log coverage/shard-[0-9]+\.log\)$', re.M)


def current_shard_logs(root, text, started):
    """Read only children announced by this native sweep, where raw archives are printed."""
    logs = []
    for number, pid in dict.fromkeys(SHARD_START_LINE.findall(text)):
        path = root / 'back-end/coverage' / f'shard-{number}.log'
        if not path.is_file() or path.stat().st_mtime < started - 1:
            raise ValueError('current sweep shard log is missing or stale: ' + str(path))
        content = path.read_text(errors='replace')
        for archive in FAILED_SHARD_LINE.findall(content):
            if not Path(archive).parent.name.endswith('-' + pid):
                raise ValueError('failed shard archive does not match the announced process')
        logs.append((path, content))
    return logs


def owned_archive(root, candidate):
    archive = Path(candidate).resolve()
    if (root.resolve() / '.context/test-runs') not in archive.parents or not archive.is_dir():
        raise ValueError(f'announced archive is not an owned test-run directory: {candidate}')
    return archive


def archive_manifest(archive):
    rows = sorted((str(p.relative_to(archive)), sha_file(p)) for p in archive.rglob('*') if p.is_file())
    return hashlib.sha256(json.dumps(rows).encode()).hexdigest(), len(rows)


def union_archives(root, text, target):
    """Union THIS run's announced passing merged archive with its announced failed-shard raw-v8 dirs."""
    passing = ARCHIVE_LINE.search(text)
    if not passing:
        raise ValueError('runner did not announce the passing phases raw-v8 archive for this run')
    sources = [owned_archive(root, passing.group(1))] + [owned_archive(root, m) for m in FAILED_SHARD_LINE.findall(text)]
    target.mkdir(parents=True, exist_ok=False)
    seen = {}
    for archive in sources:
        for path in sorted(p for p in archive.rglob('*') if p.is_file()):
            name, digest = path.name, sha_file(path)
            if name in seen and seen[name] != digest:
                raise ValueError(f'raw-v8 filename collision with different content: {name}')
            if name not in seen:
                shutil.copyfile(path, target / name)
                seen[name] = digest
    return [{'path': str(a), 'manifest_sha256': archive_manifest(a)[0], 'files': archive_manifest(a)[1]} for a in sources]


def threshold_over_archive(root, text, log, target, timeout):
    try:
        sources = union_archives(root, text, target)
    except (ValueError, OSError) as error:
        return 'UNVERIFIED', None, str(error)
    argv = ['bash', '-c', 'source scripts/coverage-report-heap.sh && coverage_report_node npx c8 report '
            f'--temp-directory={target} --reporter=text-summary --check-coverage']
    code, timed_out, cancelled, lingering = run_command(argv, cwd=root / 'back-end', env=os.environ.copy(),
                                                       output=log, timeout=timeout)
    identity = {'union': str(target), 'union_manifest_sha256': archive_manifest(target)[0], 'sources': sources}
    if code == 0 and not (timed_out or cancelled or lingering):
        return 'PASS', identity, 'merged report over passing phases + failed shards met .c8rc.json thresholds (union: sound)'
    return 'UNVERIFIED', identity, 'threshold failed on partial coverage: inconclusive'


def handoff_recipe(old, domains, timeout_seconds=14400):
    """Replace the slot's single aggregate case by the frozen multi-case recipe; setup/cleanup verbatim."""
    cases = old.get('cases') if isinstance(old, dict) else None
    if not isinstance(cases, dict) or len(cases) != 1:
        raise ValueError('expected the existing single-case backend recipe')
    (name, sweep), = cases.items()
    if not sweep.get('aggregate') or sweep.get('command', [])[-3:] != RUNNER:
        raise ValueError('existing backend case must be the aggregate `npm run test:coverage:sharded` sweep')
    case = {k: v for k, v in sweep.items() if k != 'aggregate'}
    case.update(aggregate=False, sweep=name)
    recipe = {'cases': {check: dict(case) for check in checks_for(domains)},
              'execution_timeout_seconds': timeout_seconds}
    for key in ('setup', 'cleanup', 'services'):
        if key in old:
            recipe[key] = old[key]
    return recipe


def sweep_from_recipe(recipe, checks):
    cases = recipe.get('cases', {})
    if set(cases) != set(checks) or any(c.get('aggregate') or not c.get('sweep') for c in cases.values()):
        raise ValueError('slot still carries the single-case aggregate recipe; regenerate it with '
                         'scripts/deploy_test_backend.py --handoff-slot')
    commands = {tuple(c['command']) for c in cases.values()}
    if len(commands) != 1 or any((c.get('cwd'), tuple(sorted(c.get('env', {}).items()))) !=
                                 (next(iter(cases.values())).get('cwd'), tuple(sorted(next(iter(cases.values())).get('env', {}).items())))
                                 for c in cases.values()):
        raise ValueError('every backend case must share the one native sweep command, cwd and env')
    return next(iter(cases.values()))


def run_step(spec, root, env, log, timeout):
    code, timed_out, cancelled, lingering = run_command(spec['command'], cwd=root / spec.get('cwd', '.'),
                                                       env={**env, **spec.get('env', {})}, output=log,
                                                   timeout=timeout)
    return code == 0 and not (timed_out or cancelled or lingering), code


def execute(request, root, failed_first=False):
    # Keep signal ownership through the report and teardown tails too.
    with cancellation_handlers(), exclusive(root / '.context/deploy-backend'):
        return _execute(request, root, failed_first)


def _execute(request, root, failed_first=False):
    checks, skipped = request['checks'], request.get('skips', {})
    proof, domains = selection(root)
    expected = set(checks_for(domains))
    if (not checks or len(set(checks)) != len(checks) or set(checks) & set(skipped)
            or not set(checks) <= expected or not set(skipped) <= expected
            or (request['phase'] != 'focused' and set(checks) | set(skipped) != expected)):
        raise ValueError('backend case inventory does not match the frozen domain list')
    if request.get('worker_root', str(root.resolve())) != str(root.resolve()):
        raise ValueError('backend worker root differs from its prepared binding')
    if source(root) != request['source']:
        raise ValueError('backend source differs from the requested freeze')
    directory = root / '.context/deploy-backend' / hashlib.sha256(request['token'].encode()).hexdigest()
    directory.mkdir(parents=True, exist_ok=False)
    recipe = request.get('worker_recipe')
    if recipe and recipe.get('services') and not recipe.get('cleanup'):
        raise ValueError('service recipes require owned cleanup')
    budget = (recipe or {}).get('execution_timeout_seconds', 14400)
    if type(budget) not in (int, float) or not math.isfinite(budget) or budget <= 0:
        raise ValueError('invalid backend execution deadline')
    deadline = time.monotonic() + budget
    def remaining(spec=None):
        value = max(0.001, deadline - time.monotonic())
        own = (spec or {}).get('timeout_seconds')
        return min(value, own) if own is not None else value
    sweep = sweep_from_recipe(recipe, checks_for(domains)) if recipe else {'command': list(RUNNER), 'cwd': 'back-end'}
    refuse_env_skips(os.environ, sweep.get('env'), (recipe or {}).get('setup', {}).get('env'))
    env = {**os.environ, **sweep.get('env', {}), 'DEPLOY_LANE_SCOPED_REUSE': '0', 'DEPLOY_CYCLE_FRESH': '1'}
    shards = env.get('BACKEND_COVERAGE_SHARDS', '2')
    argv = list(sweep['command'])
    if failed_first:  # the existing repair recipe, under the same wrapper when present
        cut = argv.index('--') + 1 if '--' in argv else 0
        argv = [*argv[:cut], *FAILED_FIRST, shards]
    started = time.time()
    setup_ok, setup_rc = True, None
    cleaned, cleanup_rc = True, None
    code, timed_out, cancelled, lingering = None, False, False, False
    with cancellation_handlers(), (directory / 'runner.log').open('wb') as log:
        try:
            if recipe and recipe.get('setup'):
                setup_ok, setup_rc = run_step(recipe['setup'], root, env, log, remaining(recipe['setup']))
            if setup_ok:
                code, timed_out, cancelled, lingering = run_command(argv, cwd=root / sweep.get('cwd', 'back-end'), env=env,
                                                                   output=log, timeout=remaining(sweep))
            else:
                code = setup_rc
        finally:
            if recipe and recipe.get('cleanup'):
                # Teardown is allowed to finish after cancellation of its tests (as deploy_test_worker.py does).
                interrupted_before = CANCEL.is_set()
                CANCEL.clear()
                cleaned, cleanup_rc = run_step(recipe['cleanup'], root, env, log, remaining(recipe['cleanup']))
                if interrupted_before:
                    CANCEL.set()
    text = (directory / 'runner.log').read_text(errors='replace')
    interrupted = timed_out or cancelled or lingering or code not in (0, 1)
    active = [c for c in checks]
    cases, evidence, hashes, unknown = domain_cases(root, [c.split(':', 1)[1] for c in active if c.startswith('blackbox:')], started)
    units, unit_rc = phase(UNIT_LINE, text)
    fps, fps_rc = phase(FPS_LINE, text)
    evidence.update(units={'exit': unit_rc, 'log': str(root / 'back-end/coverage/units.log')},
                    fps={'exit': fps_rc, 'log': str(root / 'back-end/coverage/units-probe.log')})
    cases.update(units=units, fps=fps)
    if not setup_ok:
        cases = dict.fromkeys(cases, 'UNVERIFIED')
    if setup_ok and code == 0 and not interrupted:
        cases['coverage-threshold'] = 'PASS'
        evidence['coverage-threshold'] = {'native': 'merged c8 report enforced .c8rc.json in the runner'}
    else:
        with (directory / 'threshold.log').open('wb') as log:
            try:
                child_logs = current_shard_logs(root, text, started)
                archive_text = text + '\n' + '\n'.join(value for _, value in child_logs)
                status, identity, why = threshold_over_archive(root, archive_text, log, directory / 'raw-v8-union', remaining())
            except (OSError, ValueError) as error:
                child_logs = []
                status, identity, why = 'UNVERIFIED', None, str(error)
        cases['coverage-threshold'] = status
        evidence['coverage-threshold'] = {'identity': identity, 'reason': why, 'log': str(directory / 'threshold.log')}
        evidence['shard_logs'] = {str(path): sha_file(path) for path, _ in child_logs}
    with (directory / 'teardown.log').open('wb') as log:
        t_code, t_timeout, t_cancel, t_linger = run_command(['bash', TEARDOWN], cwd=root, env=env,
                                                           output=log, timeout=remaining())
    teardown_ok = cleaned and t_code == 0 and not (t_timeout or t_cancel or t_linger)
    cases['teardown'] = 'PASS' if teardown_ok else ('FAIL' if t_code in (1,) and not (t_timeout or t_cancel or t_linger) else 'UNVERIFIED')
    evidence['teardown'] = {'exit': t_code, 'command': ['bash', TEARDOWN], 'log': str(directory / 'teardown.log'),
                            'recipe_cleanup_exit': cleanup_rc, 'recipe_setup_exit': setup_rc}
    same_source = source(root) == request['source']
    if interrupted or not setup_ok or not same_source:
        cases = {k: ('UNVERIFIED' if k != 'teardown' else v) for k, v in cases.items()}
    evidence['artifacts'] = {'summaries': hashes, 'runner_log': sha_file(directory / 'runner.log'),
                             'units_log': sha_file(root / 'back-end/coverage/units.log'),
                             'fps_log': sha_file(root / 'back-end/coverage/units-probe.log'),
                             'teardown_log': sha_file(directory / 'teardown.log'),
                             'threshold_log': sha_file(directory / 'threshold.log')}
    evidence['unknown_domains'] = unknown
    cases = {k: v for k, v in cases.items() if k in active}
    result = {k: request[k] for k in ('token', 'source', 'gate')}
    result.update(cases=cases, complete=all(v != 'UNVERIFIED' for v in cases.values()),
                  cleanup_complete=teardown_ok, reused=False, native_exit=code, native_command=argv,
                  evidence=evidence, runner_log=str(directory / 'runner.log'), interrupted=interrupted,
                  source_unchanged=same_source, selection=proof, reason=None if same_source else 'source changed during the sweep',
                  recipe_digest=hashlib.sha256(json.dumps(recipe, sort_keys=True, separators=(',', ':')).encode()).hexdigest() if recipe else None,
                  worker_root=str(root.resolve()),
                  domains=domains, started_at=started, finished_at=time.time())
    write(directory / 'result.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--failed-first', action='store_true', help='existing repair recipe: full sweep, failed domains first')
    parser.add_argument('--list', action='store_true', help='print the frozen case inventory')
    parser.add_argument('--handoff-slot', type=Path, help='print the slot JSON with its recipe replaced by the frozen multi-case recipe')
    args = parser.parse_args()
    try:
        if args.list:
            print('\n'.join(checks_for(selection(args.root.resolve())[1])))
            return 0
        if args.handoff_slot:
            slot = read(args.handoff_slot)
            slot['recipe'] = handoff_recipe(slot['recipe'], selection(args.root.resolve())[1], slot['timeout_seconds'])
            print(json.dumps(slot, indent=2))
            return 0
        result = execute(read(Path(os.environ['DEPLOY_GATE_REQUEST'])), args.root.resolve(), args.failed_first)
        write(Path(os.environ['DEPLOY_GATE_RESULT']), result)
        return 0 if all(v == 'PASS' for v in result['cases'].values()) else 1
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f'DEPLOY_BACKEND BLOCKED: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
