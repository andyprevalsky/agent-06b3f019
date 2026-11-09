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
    'seed-cache-decision': ['back-end/*', 'agents/*', 'scripts/*'],
    'canonical-seed-whatsapp-content': ['back-end/*', 'agents/*', 'scripts/*'],
    'seed-memory-ratchet': ['back-end/*', 'agents/*', 'scripts/*'],
    'mac-app-static': ['mac-app/*'],
}
# Quick static checks that run only when triggered; every other quick category is mandatory.
CONDITIONAL_QUICK = {'mac-app-static'}
# Original /deploy Step 4m-lint (the former /deploy skill): the Mac-app verifier when mac-app/ changed.
# Darwin-only; elsewhere a triggered run is recorded as a platform omission, never a pass.
MAC_APP_STATIC = {'name': 'mac-app-static', 'category': 'mac-app-static',
                  'command': ['bash', '-c', 'npm run format:check && npm run lint && npm run type-check'],
                  'cwd': 'mac-app', 'platform': 'darwin', 'timeout_seconds': 600, 'checks': ['mac-app-static']}
# Categories selected on every deploy regardless of the diff, with the reason recorded as evidence.
ALWAYS = {
    'e2b-smoke': ('every deploy: the Claude Code E2B sandbox smoke is never diff-skipped '
                  '(the former /deploy skill 6c L2226; measured ~106 s, ~840 MB)'),
}


def select(template: dict, changed: list[str], result: dict, binding: dict | None,
           base: str = 'origin/main') -> dict:
    """binding=None is selection-only: the same inclusions/omissions, no worker checks or plan validation."""
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
        evidence = []
        if quick and category not in CONDITIONAL_QUICK:
            evidence.append('mandatory quick check')
        if result['all']:
            evidence.extend(result['reasons'] or ['dependency graph fallback ALL'])
        for lane in GRAPH_LANES.get(category, []):
            if lane not in result['lanes']:
                raise ValueError(f"{gate['name']}: graph lane {lane!r} is not defined by select_affected_tests")
            if result['lanes'][lane]:
                evidence.append(f"dependency graph {lane}: {len(result['lanes'][lane])} affected test units")
        if category in ALWAYS:
            evidence.append(ALWAYS[category])
        if any(fnmatchcase(path, pattern) for path in changed for pattern in PATHS.get(category, [])):
            evidence.append('runtime/contract path trigger')
        # A new/unregistered category is not silently dropped.
        if category not in GRAPH_LANES and category not in PATHS and not quick:
            evidence.append('unknown category: conservative inclusion')
        if not evidence:
            omitted.append({'gate': gate['name'], 'reason': 'no dependency or runtime-path trigger',
                            'changed_files': changed})
            continue
        if gate.get("platform") and gate["platform"] != sys.platform and gate["name"] not in (binding or {}):
            omitted.append({"gate": gate["name"], "category": category,
                            "reason": "platform not available; not a test pass",
                            "disposition": "PLATFORM_OMITTED", "executed": False,
                            "platform": gate["platform"], "selection_evidence": evidence})
            continue
        gate.update(category=category, quick=quick, selection_evidence=evidence)
        gate.pop('after', None)  # no sibling gate is a prerequisite
        if not quick and binding is not None:
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
    planned = {'version': 1, 'base': base, 'source': source(ROOT) if binding is not None else None,
               'changed_files': changed, 'selection': result, 'gates': gates, 'omitted': omitted,
               'policy': 'quick-parallel / selected-parallel / RCA / focus / failed-gates / final'}
    if binding is not None:
        validate_plan(planned)
    return planned


# Blacksmith gates run on their own VMs, so their worker counts must not follow the coordinating host's live
# MemAvailable: a few hundred MB of drift flipped the structural gate's --max-workers between 4 and 5, so a
# regenerated plan no longer matched the staged cycle ("bound to a different plan or source") and a refresh could
# not be resumed. This is the 8-CPU / 16 GB devbox profile with healthy headroom (structural gate: 4 workers, the count the first sweep of PR #1751 ran).
BLACKSMITH_REFERENCE_HOST = ("--host-cpus", "8", "--host-mem-mb", "13500", "--host-total-mem-mb", "16000",
                             "--host-watchdog-mb", "14400")


def standard_template(host: tuple = ()) -> dict:
    result = subprocess.run([sys.executable, str(ROOT / "scripts/run_deploy_pipeline.py"),
        "plan", "--group", "all", "--backend", "--frontend", "--agents", "--smoke", "cloud",
        "--live-probes", "--semantic-stack", "--e2b-smoke", *host],
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
        if gate['name'] == 'live-probes':
            from run_deploy_live_probes import recipe
            gate.update(checks=list(recipe()['cases']), native_live_probes=True, case_protocol=True)
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
        dict(MAC_APP_STATIC, command=list(MAC_APP_STATIC['command']), checks=list(MAC_APP_STATIC['checks'])),
    ]
    return {"gates": gates}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--template', type=Path, help='optional case-aware recipes; default existing full gate commands')
    workers = parser.add_mutually_exclusive_group()
    workers.add_argument('--workers', type=Path, help='explicit existing adapter bindings')
    workers.add_argument('--inventory', type=Path, help='prepared worker identities; generate full-suite bindings')
    parser.add_argument('--base', default='origin/main')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--list-selected', action='store_true',
                        help='print the same selection as JSON (selected/quick/needs_worker/omitted) '
                             'without worker bindings; writes nothing')
    args = parser.parse_args(argv)
    if args.list_selected and (args.workers or args.inventory or args.output):
        parser.error('--list-selected takes no --workers, --inventory or --output')
    if not args.list_selected and not (args.workers or args.inventory):
        parser.error('one of the arguments --workers --inventory is required')
    if not args.list_selected and args.output is None:
        parser.error('the following arguments are required: --output')
    changed = changed_files(args.base, None)
    selected = Selector().select(changed)
    result = {'all': selected.all_lanes, 'reasons': selected.reasons,
              'lanes': {k: sorted(v) for k, v in selected.selected.items()}}
    template = json.loads(args.template.read_text()) if args.template else standard_template()
    if args.list_selected:
        selection = select(template, changed, result, None, base=args.base)
        gates = selection['gates']
        print(json.dumps({'selected': [g['name'] for g in gates], 'quick': [g['name'] for g in gates if g['quick']],
                          'needs_worker': [g['name'] for g in gates if not g['quick']],
                          'omitted': selection['omitted']}))
        return 0
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
