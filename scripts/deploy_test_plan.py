#!/usr/bin/env python3
"""Select whole gate categories from the existing dependency graph.

The template contains real, independently provisioned worker commands. This
planner never invents a remote executor or assumes a spare local machine.
"""
from __future__ import annotations

import argparse
from fnmatch import fnmatchcase
import json
import subprocess
import sys
from pathlib import Path

from deploy_test_cycle import ROOT, QUICK, source, validate_plan, write
from select_affected_tests import Selector, changed_files
from deploy_test_bindings import generate as generate_bindings

PLANNING_TIMEOUT_SECONDS = 300


GRAPH_LANES = {
    'backend-coverage-blackbox': ['backend-unit', 'backend-blackbox'],
    'frontend-coverage-blackbox': ['frontend-vitest'],
    'agents-coverage-blackbox': ['agents-blackbox', 'agents-pytest'],
    'mac-app-coverage-blackbox': ['mac-app-vitest'],
    'deploy-command-structural': ['deploy-structural-gates'],
    'cloudbench-controller': ['cloudbench-controller'],
}
# Integration categories have runtime dependencies not fully represented by the
# unit-test graph. Broad patterns deliberately include contract consumers.
PATHS = {
    'smoke': ['agents/*', 'back-end/*', 'front-end/*', 'scripts/*', '.github/*'],
    'semantic-stack': ['front-end/*', 'back-end/*', 'agents/*', 'scripts/*', '.github/*'],
    'live-probes': ['back-end/*', 'agents/*', 'scripts/*', '.github/*'],
    'e2b-smoke': ['agents/*', 'back-end/*', 'scripts/*', '.github/*'],
    'agentcard-lifecycle': ['back-end/src/domains/agentcard/*', 'back-end/src/domains/purchases/*',
                           'back-end/src/providers/*', 'agents/domains/request_payment_card/*',
                           'front-end/src/features/test-payment/*', 'agents/benchmarks/*',
                           'scripts/run*', 'back-end/prisma/*'],
    'seed-cache-decision': ['back-end/*', 'agents/*', 'scripts/*'],
    'canonical-seed-whatsapp-content': ['back-end/*', 'agents/*', 'scripts/*'],
    'seed-memory-ratchet': ['back-end/*', 'agents/*', 'scripts/*'],
}


def select(template: dict, changed: list[str], result: dict, binding: dict, base: str = 'origin/main') -> dict:
    gates, omitted = [], []
    for recipe in template['gates']:
        gate = dict(recipe)
        category = gate.get('category', gate['name'])
        if category in {'eslint', 'format'} and any(
                Path(arg).name == 'check_deploy_static.py' for arg in gate['command']):
            command = list(gate['command'])
            if '--base' in command:
                command[command.index('--base') + 1] = base
            else:
                command.extend(['--base', base])
            gate['command'] = command
        quick = category in QUICK
        if gate.get("platform") and gate["platform"] != sys.platform and gate["name"] not in binding:
            omitted.append({"gate": gate["name"], "reason": "platform not available; not a test pass"})
            continue
        evidence = []
        if quick:
            evidence.append('mandatory quick check')
        if result['all']:
            evidence.extend(result['reasons'] or ['dependency graph fallback ALL'])
        for lane in GRAPH_LANES.get(category, []):
            if lane not in result['lanes']:
                raise ValueError(f"{gate['name']}: graph lane {lane!r} is not defined by select_affected_tests")
            if result['lanes'][lane]:
                evidence.append(f"dependency graph {lane}: {len(result['lanes'][lane])} affected test units")
        if any(fnmatchcase(path, pattern) for path in changed for pattern in PATHS.get(category, [])):
            evidence.append('runtime/contract path trigger')
        # A new/unregistered category is not silently dropped.
        if category not in GRAPH_LANES and category not in PATHS and not quick:
            evidence.append('unknown category: conservative inclusion')
        if not evidence:
            omitted.append({'gate': gate['name'], 'reason': 'no dependency or runtime-path trigger',
                            'changed_files': changed})
            continue
        gate.update(category=category, quick=quick, selection_evidence=evidence)
        gate.pop('after', None)  # no sibling gate is a prerequisite
        if not quick:
            worker = binding.get(gate['name'])
            if not worker:
                raise ValueError(f"{gate['name']}: independent worker binding missing")
            if not isinstance(worker.get('id'), str) or not worker['id']:
                raise ValueError(f"{gate['name']}: worker binding requires an id")
            if category == 'smoke' and worker.get('transport') != 'benchmark-cloud-cli':
                raise ValueError('smoke must use the cloud benchmark CLI worker')
            # Explicit launcher commands; a label alone is not a provisioned worker.
            gate.update(worker=worker['id'], command=worker['command'], cwd=worker.get('cwd', str(ROOT)),
                        env={**gate.get('env', {}), **worker.get('env', {})})
            gate['worker_transport'] = worker.get('transport', 'explicit')
            for key in ('worker_host', 'worker_root', 'worker_thread', 'coordinator_thread'):
                if key in worker:
                    gate[key] = worker[key]
            if worker.get('transport') == 'boxes-thread':
                gate['remote_python'] = worker['python']
            if 'timeout_seconds' in worker:
                gate['timeout_seconds'] = worker['timeout_seconds']
            if worker.get('case_protocol'):
                gate.update(case_protocol=True, result_transport=worker.get('result_transport', 'file'))
            if gate.get('native_backend') and 'recipe' in worker and (
                    set(worker['recipe'].get('cases', {})) != set(gate['checks'])
                    or any(c.get('aggregate') for c in worker['recipe']['cases'].values())):
                raise ValueError(f"{gate['name']}: slot still carries the single-case aggregate recipe; "
                                 "regenerate it with scripts/deploy_test_backend.py --handoff-slot and init a new cycle")
            if 'recipe' in worker:
                gate.update(worker_recipe=worker['recipe'], case_protocol=True,
                            result_transport=worker.get('result_transport', 'file'))
        gates.append(gate)
    planned = {'version': 1, 'base': base, 'source': source(ROOT), 'changed_files': changed,
               'selection': result, 'gates': gates, 'omitted': omitted,
               'policy': 'quick-parallel / selected-parallel / RCA / focus / failed-gates / final'}
    validate_plan(planned)
    return planned


def standard_template() -> dict:
    result = subprocess.run([sys.executable, str(ROOT / "scripts/run_deploy_pipeline.py"),
        "plan", "--group", "all", "--backend", "--frontend", "--agents", "--smoke", "cloud",
        "--agentcard", "--live-probes", "--semantic-stack", "--e2b-smoke"],
        cwd=ROOT, check=True, capture_output=True, text=True, timeout=PLANNING_TIMEOUT_SECONDS)
    lanes = json.loads(result.stdout)["lanes"]
    gates = [{"name": lane["name"], "category": lane["name"], "command": lane["command"],
              "cwd": lane.get("cwd", "."), "env": lane.get("env", {}), "checks": [lane["name"]]}
             for lane in lanes]
    for gate in gates:
        if gate['name'] == 'eslint':
            gate.update(command=[sys.executable, 'scripts/check_deploy_static.py', 'lint'], cwd='.')
        if gate['name'] == 'backend-coverage-blackbox':
            from deploy_test_backend import checks_for, selection
            gate.update(checks=checks_for(selection(ROOT)[1]), native_backend=True, case_protocol=True,
                        runner_command=gate['command'], cwd='.',
                        command=[sys.executable, str(ROOT / 'scripts/deploy_test_backend.py')])
        if gate['name'] == 'smoke':
            tasks = subprocess.run(['bash', 'scripts/run-predeploy-cloud', '--list'], cwd=ROOT,
                                   check=True, capture_output=True, text=True,
                                   timeout=PLANNING_TIMEOUT_SECONDS).stdout.splitlines()
            if not tasks or len(set(tasks)) != len(tasks):
                raise ValueError('cloud smoke selector did not return an exact task inventory')
            gate.update(checks=tasks, native_cloud=True, case_protocol=True,
                        command=[sys.executable, str(ROOT / 'scripts/deploy_test_cloud.py')])
    gates += [
        {"name": "format", "category": "format", "command": [sys.executable, "scripts/check_deploy_static.py", "format"],
         "checks": ["format"]},
        {"name": "cloudbench-controller", "command": [sys.executable, "scripts/run-cloudbench-controller-local.py"],
         "checks": ["cloudbench-controller"]},
        {"name": "seed-memory-ratchet", "command": ["bash", "scripts/measure-seed-memory.sh",
                                                   "5", "0", "0", "--enforce-budget"],
         "cwd": "back-end", "checks": ["seed-memory-ratchet"]},
        {"name": "mac-app-coverage-blackbox", "command": ["npm", "run", "test:coverage"],
         "cwd": "mac-app", "platform": "darwin", "checks": ["mac-app-coverage-blackbox"]},
    ]
    return {"gates": gates}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--template', type=Path, help='optional case-aware recipes; default existing full gate commands')
    workers = parser.add_mutually_exclusive_group(required=True)
    workers.add_argument('--workers', type=Path, help='explicit existing adapter bindings')
    workers.add_argument('--inventory', type=Path, help='prepared worker identities; generate full-suite bindings')
    parser.add_argument('--base', default='origin/main')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    changed = changed_files(args.base, None)
    selected = Selector().select(changed)
    result = {'all': selected.all_lanes, 'reasons': selected.reasons,
              'lanes': {k: sorted(v) for k, v in selected.selected.items()}}
    template = json.loads(args.template.read_text()) if args.template else standard_template()
    bindings = (generate_bindings(template, json.loads(args.inventory.read_text()), ROOT)
                if args.inventory else json.loads(args.workers.read_text()))
    plan = select(template, changed, result, bindings, base=args.base)
    write(args.output, plan)
    print(json.dumps({'selected': [g['name'] for g in plan['gates']], 'omitted': plan['omitted']}))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f'DEPLOY_PLAN BLOCKED: {error}', file=sys.stderr)
        raise SystemExit(2)
