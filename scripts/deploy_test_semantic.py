#!/usr/bin/env python3
"""One native semantic-stack sweep, exact per-Playwright-case evidence. No aggregate credit."""
import argparse
import hashlib
import json
import math
import os
import re
from pathlib import Path
import subprocess
import sys
import time

import deploy_gate_progress as progress

from deploy_test_cycle import ROOT, exclusive, read, source, write
from deploy_test_process import cancellation_handlers, run_command

RUNNER = ['bash', 'scripts/run-deploy-semantic-stack.sh']
LANES = ('ui', 'latency')
REPORTER = 'scripts/deploy-semantic-reporter.cjs'


def case_key(lane, item):
    # Human-readable, unambiguous JSON tuple; native IDs remain in the evidence.
    return 'playwright:' + json.dumps([lane, item['project'], item['file'], item['title']],
                                     ensure_ascii=True, separators=(',', ':'))


def inventory(events):
    if not events or events[0].get('event') != 'begin':
        raise ValueError('missing native begin inventory')
    rows = events[0]['tests']
    if (not isinstance(rows, list) or not rows or any(not isinstance(r, dict)
            or not all(isinstance(r.get(k), str) and r[k] for k in ('id', 'project', 'file'))
            or not isinstance(r.get('title'), list) or not r['title']
            or not all(isinstance(t, str) for t in r['title']) for r in rows)
            or len({r['id'] for r in rows}) != len(rows)
            or len({case_key('inventory', r) for r in rows}) != len(rows)):
        raise ValueError('invalid or duplicate native case inventory')
    return rows


def specs(suites):
    for suite in suites:
        yield from suite.get('specs', [])
        yield from specs(suite.get('suites', []))


def report_specs(suites, parents=()):
    """Keep the native suite/title path while matching the inventory's IDs."""
    for suite in suites:
        titles = parents + ((suite['title'],) if suite.get('title') else ())
        for row in suite.get('specs', []):
            yield row, list(titles) + [row.get('title')]
        yield from report_specs(suite.get('suites', []), titles)


def classify_lane(lane, expected, report, events, flaky=None, *, log=''):
    """Classify complete native attempt chains; uncertain evidence stays unknown."""
    cases = {case_key(lane, row): 'UNVERIFIED' for row in expected}
    recovered = []
    try:
        if (not isinstance(report, dict) or not isinstance(events, list)
                or any(not isinstance(event, dict) for event in events)):
            return cases
        observed = inventory(events)
        ids = {r['id'] for r in expected}
        if (observed != expected or len([e for e in events if e.get('event') == 'begin']) != 1
                or len([e for e in events if e.get('event') == 'end']) != 1
                or events[-1].get('event') != 'end'
                or events[-1].get('status') not in ('passed', 'failed')
                or any(e.get('event') not in ('begin', 'testBegin', 'hookEnd', 'testEnd', 'end')
                       or ('id' in e and e['id'] not in ids) for e in events)
                or report.get('errors')):
            return cases
        if any(event.get('event') in ('testBegin', 'hookEnd', 'testEnd')
               and event.get('id') not in ids for event in events):
            return cases
        rows = list(report_specs(report['suites']))
        if len(rows) != len(expected) or {r['id'] for r, _ in rows} != ids:
            return cases
        by_id = {row['id']: (row, titles) for row, titles in rows}
        events_by_id = {key: [] for key in ids}
        for event in events:
            if event.get('id') in ids:
                events_by_id[event['id']].append(event)
        config = report.get('config')
        if (not isinstance(config, dict)
                or any(not isinstance(config.get(key), str) or not config[key]
                       or not Path(config[key]).is_absolute() for key in ('rootDir', 'configFile'))
                or not isinstance(config.get('projects'), list) or not config['projects']
                or any(not isinstance(project, dict)
                       or any(not isinstance(project.get(key), str) or not project[key] for key in ('name', 'id'))
                       or type(project.get('retries')) is not int or project['retries'] not in (0, 1)
                       for project in config['projects'])
                or len({project['name'] for project in config['projects']}) != len(config['projects'])
                or len({project['id'] for project in config['projects']}) != len(config['projects'])):
            return cases  # Missing native policy/identity cannot authorize a zero-retry fallback.
        projects = {project['name']: project for project in config['projects']}
        for item in expected:
            row, titles = by_id[item['id']]
            tests = row['tests']
            own = events_by_id[item['id']]
            if len(tests) != 1 or tests[0].get('expectedStatus') != 'passed':
                continue
            test = tests[0]
            # Every case is bound to the complete native policy and identity.
            project = projects.get(item['project'])
            if (project is None or test.get('projectName') != item['project']
                    or test.get('projectId') != project['id']
                    or row.get('file') != item['file'] or titles != item['title']):
                continue
            retries = project['retries']
            results = test['results']
            if (not isinstance(results, list) or not 1 <= len(results) <= retries + 1
                    or any(not isinstance(result, dict) for result in results)
                    or any(type(r.get('retry')) is not int or r['retry'] != i
                           for i, r in enumerate(results))
                    or any(r.get('status') not in ('passed', 'failed', 'timedOut') for r in results)
                    or any(r['status'] == 'passed' for r in results[:-1])
                    or (results[-1]['status'] != 'passed' and len(results) != retries + 1)):
                continue
            # Every attempt must execute the body between successful before/after hooks.
            shape = [('testBegin', None), ('hookEnd', 'Before Hooks'),
                     ('hookEnd', 'After Hooks'), ('testEnd', None)]
            if len(own) != 4 * len(results):
                continue
            valid = True
            for i, result in enumerate(results):
                attempt = own[4 * i:4 * (i + 1)]
                if ([(e.get('event'), e.get('title')) for e in attempt] != shape
                        or any(type(e.get('retry')) is not int or e['retry'] != i for e in attempt)
                        or not all(e.get('ok') is True for e in attempt if e['event'] == 'hookEnd')
                        or attempt[-1].get('status') != result['status']):
                    valid = False
                    break
            if not valid:
                continue
            status = ('FLAKY' if len(results) == 2 and results[-1]['status'] == 'passed'
                      else {'passed': 'PASS', 'failed': 'FAIL', 'timedOut': 'FAIL'}[results[-1]['status']])
            native_status = {'PASS': 'expected', 'FAIL': 'unexpected', 'FLAKY': 'flaky'}[status]
            if 'status' in test and test['status'] != native_status:
                continue
            if status == 'FLAKY':
                if flaky is None:
                    continue  # Recovered passes require the native attribution-evidence channel.
                errors = results[0].get('errors')
                if not isinstance(errors, list) or not errors:
                    continue  # A recovered failure without its original evidence is incomplete.
                detail = '\n\n'.join(str(e.get('stack') or e.get('message') or e.get('value') or '')
                                       for e in errors)
                detail = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', detail)
                if not detail.strip():
                    continue
                relative = os.path.relpath(Path(config['rootDir']) / item['file'],
                                           Path(config['configFile']).parent)
                unit = relative + ' > ' + ' > '.join(item['title'][1:])
                recovered.append((case_key(lane, item), progress.row(unit, 'FLAKY', scope='test',
                                  case='semantic-stack', detail=detail, log=log, attempts=2)))
            cases[case_key(lane, item)] = status
    except (AttributeError, KeyError, TypeError, ValueError):
        return dict.fromkeys(cases, 'UNVERIFIED')
    if flaky is not None:
        flaky.extend(recovered)
    return cases


def events_at(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def playwright_command(root, env=None):
    """Match run-semantic-tests.sh: frontend bin, its resolved package, root bin."""
    frontend = root / 'front-end'
    local_bin = frontend / 'node_modules/.bin/playwright'
    if local_bin.is_file() and os.access(local_bin, os.X_OK):
        return [str(local_bin)]
    resolver = """
const path = require('path');
const pkgPath = require.resolve('@playwright/test/package.json');
const bin = require(pkgPath).bin;
const relative = typeof bin === 'string' ? bin : bin && bin.playwright;
if (!relative) process.exit(1);
console.log(path.join(path.dirname(pkgPath), relative));
"""
    try:
        resolved = subprocess.run(['node', '-e', resolver], cwd=frontend, env=env,
                                  capture_output=True, text=True, timeout=10)
        cli = Path(resolved.stdout.strip())
        if resolved.returncode == 0 and cli.is_file():
            return ['node', str(cli)]
    except subprocess.TimeoutExpired:
        pass
    root_bin = root / 'node_modules/.bin/playwright'
    if root_bin.is_file() and os.access(root_bin, os.X_OK):
        return [str(root_bin)]
    raise ValueError('Frontend Playwright is not installed (frontend bin/package and root bin missing)')


def native_inventory(root, directory, env=None):
    """Playwright --list loads the exact specs/config without running hooks or tests."""
    result = {}
    cli = playwright_command(root, env)
    for lane in LANES:
        path = directory / (lane + '-list.jsonl')
        argv = [*cli, 'test', '--list', '--reporter=' + str(root / REPORTER)]
        argv += (['--grep-invert=chat full-lifecycle latency'] if lane == 'ui'
                 else ['tests-e2e/chat-lifecycle-latency.spec.ts'])
        lane_env = {**(env or os.environ), 'DEPLOY_SEMANTIC_LIFECYCLE': str(path)}
        with (directory / (lane + '-list.log')).open('wb') as log:
            code, timeout, cancelled, lingering = run_command(argv, cwd=root / 'front-end', env=lane_env,
                                                             output=log, timeout=60)
        if code != 0 or timeout or cancelled or lingering:
            raise ValueError('native semantic inventory did not complete')
        result[lane] = inventory(events_at(path))
    ids = [r['id'] for lane in LANES for r in result[lane]]
    if len(set(ids)) != len(ids):
        raise ValueError('UI and latency native selections overlap')
    return result


def checks_for(selected):
    return [case_key(lane, row) for lane in LANES for row in selected[lane]]


def sweep_from_recipe(recipe):
    rows = (recipe or {}).get('cases', {})
    if set(rows) != {'semantic-stack'}:
        raise ValueError('semantic adapter preserves the original single aggregate recipe')
    first = rows['semantic-stack']
    if (first.get('command') != RUNNER or first.get('cwd', '.') != '.'
            or first.get('aggregate') is not True
            or set(recipe) != {'cases'}):
        raise ValueError('semantic adapter requires the original native stack-owned lifecycle')
    return first


def summary_status(statuses):
    if not statuses or 'UNVERIFIED' in statuses:
        return 'UNVERIFIED'
    return 'FAIL' if 'FAIL' in statuses else ('PASS' if all(s in ('PASS', 'FLAKY') for s in statuses) else 'UNVERIFIED')


def execute(request, root):
    with cancellation_handlers(), exclusive(root / '.context/deploy-semantic'):
        return _execute(request, root)


def _execute(request, root):
    """Run one source-bound sweep and retain invalid-lane diagnostics as unknown."""
    if source(root) != request['source'] or request.get('worker_root', str(root)) != str(root):
        raise ValueError('semantic source/worker root differs from request')
    directory = root / '.context/deploy-semantic' / hashlib.sha256(request['token'].encode()).hexdigest()
    directory.mkdir(parents=True, exist_ok=False)
    if request['checks'] != ['semantic-stack'] or request.get('skips', {}):
        raise ValueError('semantic adapter requires the original composite check')
    recipe = request['worker_recipe']
    sweep = sweep_from_recipe(recipe)
    budget = sweep.get('timeout_seconds')
    if budget is not None and (type(budget) not in (int, float) or not math.isfinite(budget) or budget <= 0):
        raise ValueError('semantic execution requires its original positive deadline')
    env = {**os.environ, **sweep.get('env', {}), 'DEPLOY_SEMANTIC_ARTIFACT_DIR': str(directory),
           'DEPLOY_SEMANTIC_TOKEN': request['token'], 'DEPLOY_SEMANTIC_SOURCE': json.dumps(request['source'], sort_keys=True),
           'DEPLOY_CYCLE_FRESH': '1', 'DEPLOY_LANE_SCOPED_REUSE': '0'}
    selected = native_inventory(root, directory, env)
    started = time.time()
    with (directory / 'runner.log').open('wb') as log:
        code, timeout, cancelled, lingering = run_command(RUNNER, cwd=root, env=env, output=log, timeout=budget)
    cases, errors, lane_ends, recovered = {}, [], {}, []
    hashes = {}
    for lane in LANES:
        try:
            paths = [directory / (lane + '.json'), directory / (lane + '.jsonl')]
            for path in paths:
                hashes[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
            events = events_at(paths[1])
            if any(not isinstance(event, dict) for event in events):
                raise ValueError('native lifecycle events must be JSON objects')
            cases.update(classify_lane(lane, selected[lane], read(paths[0]), events, recovered, log=str(paths[0])))
            lane_ends[lane] = events[-1].get('status') if events and events[-1].get('event') == 'end' else None
        except (OSError, ValueError, TypeError) as error:
            errors.append(lane + ': ' + type(error).__name__)
            cases.update(dict.fromkeys([case_key(lane, row) for row in selected[lane]], 'UNVERIFIED'))
    cleaned = False
    try:
        lifecycle = read(directory / 'stack.json')
        hashes['stack.json'] = hashlib.sha256((directory / 'stack.json').read_bytes()).hexdigest()
        cleaned = (lifecycle.get('token') == request['token'] and lifecycle.get('source') == request['source']
                   and lifecycle.get('cleanup_complete') is True and lifecycle.get('cleanup_exit') == 0)
        ready = lifecycle.get('ready') is True
    except (OSError, ValueError, TypeError):
        lifecycle, ready = None, False
    for lane in LANES:
        # Exit codes corroborate native reports; they never establish a case.
        native_exit = (lifecycle or {}).get(lane)
        if (type(native_exit) is not int or native_exit not in (0, 1)
                or (native_exit == 0) != (lane_ends.get(lane) == 'passed')
                or (all(cases[case_key(lane, item)] in ('PASS', 'FLAKY') for item in selected[lane])
                    and native_exit != 0)
                or (any(cases[case_key(lane, item)] == 'FAIL' for item in selected[lane])
                    and native_exit == 0)):
            for item in selected[lane]:
                cases[case_key(lane, item)] = 'UNVERIFIED'
    unchanged = source(root) == request['source']
    interrupted = timeout or cancelled or lingering or code not in (0, 1)
    reported_native_cases = dict(cases)
    if ((all(v in ('PASS', 'FLAKY') for v in cases.values()) and code != 0)
            or (any(v == 'FAIL' for v in cases.values()) and code == 0)):
        interrupted = True
    if not cleaned or not ready or not unchanged or interrupted:
        cases = dict.fromkeys(cases, 'UNVERIFIED')
    confirmed_flaky = []
    for key, row in recovered:
        if cases[key] != 'FLAKY':
            continue
        # The semantic fast path bypasses worker.case_outcomes. Use the same progress
        # protocol so the cycle opens its mandatory attribution before merge.
        if progress.report(row['unit'], 'FLAKY', scope='test', case='semantic-stack',
                           detail=row['detail'], log=row['log'], attempts=2,
                           path=os.environ.get(progress.ENV) or directory / 'progress.jsonl'):
            confirmed_flaky.append(row)
        else:
            cases[key] = 'UNVERIFIED'  # Never silently pass without the required RCA metadata.
    native_cases = cases
    cases = {'semantic-stack': summary_status(list(native_cases.values()))}
    for path in directory.iterdir():
        if path.is_file():
            hashes[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    evidence = {'artifacts': hashes, 'artifact_directory': str(directory),
                'artifact_paths': {name: str(directory / name) for name in hashes},
                'stack': lifecycle, 'errors': errors, 'inventory': selected,
                'native_cases': native_cases, 'reported_native_cases': reported_native_cases,
                'flaky': confirmed_flaky}
    result = {key: request[key] for key in ('token', 'source', 'gate')}
    result.update(cases=cases, complete=cases['semantic-stack'] != 'UNVERIFIED',
                  cleanup_complete=cleaned and not lingering, reused=False, native_exit=code,
                  native_command=RUNNER, source_unchanged=unchanged, interrupted=interrupted,
                  worker_root=str(root), recipe_digest=hashlib.sha256(json.dumps(recipe, sort_keys=True,
                  separators=(',', ':')).encode()).hexdigest(), evidence={'semantic-stack': evidence},
                  runner_log=str(directory / 'runner.log'), started_at=started, finished_at=time.time())
    write(directory / 'result.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--list', action='store_true')
    args = parser.parse_args()
    try:
        root = args.root.resolve()
        if args.list:
            import tempfile
            with tempfile.TemporaryDirectory(prefix='semantic-list-') as folder:
                print('\n'.join(checks_for(native_inventory(root, Path(folder)))))
            return 0
        result = execute(read(Path(os.environ['DEPLOY_GATE_REQUEST'])), root)
        write(Path(os.environ['DEPLOY_GATE_RESULT']), result)
        return 0 if all(v == 'PASS' for v in result['cases'].values()) else 1
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f'DEPLOY_SEMANTIC BLOCKED: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
