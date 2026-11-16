"""Strict case-result validation shared by staged deploy coordinators."""
import hashlib
import json

MAX_RECEIPT_BYTES = 64 * 1024 * 1024


def preserve_contract(old, new):
    """A repair may add cases, but cannot replace the gate it must prove."""
    fields = ('category', 'quick', 'env', 'input_paths', 'timeout_seconds', 'case_protocol',
              'command', 'cwd', 'worker', 'worker_root', 'worker_host', 'worker_thread', 'remote_python', 'coordinator_thread',
              'worker_transport', 'result_transport')
    if any(old.get(k) != new.get(k) for k in fields):
        raise ValueError('repair changed the full gate command or execution contract')
    if 'worker_recipe' not in old:
        if old.get('command') != new.get('command') or 'worker_recipe' in new:
            raise ValueError('repair replaced the full gate command')
        return
    before, after = old['worker_recipe'], new.get('worker_recipe', {})
    if any(before.get(k) != after.get(k) for k in (before.keys() | after.keys()) - {'cases'}):
        raise ValueError('repair changed worker setup/cleanup contract')
    if any(after.get('cases', {}).get(k) != value for k, value in before['cases'].items()):
        raise ValueError('repair replaced an original case command or deadline')


def aggregate_resplit(old, new):
    """True when a planner re-split one legacy aggregate case into its per-check cases.

    The old gate ran a single aggregate case named after the gate (one exit for every
    constituent, so a failure was never attributable). The new gate keeps every other
    contract field and setup/cleanup unchanged and lists one non-aggregate case per check.
    No old PASS is carried for such a gate: it is a new inventory and must run again.
    """
    if not isinstance(new, dict) or 'worker_recipe' not in old or 'worker_recipe' not in new:
        return False
    before, after = old['worker_recipe'], new['worker_recipe']
    cases, split = before.get('cases', {}), after.get('cases', {})
    return (old.get('checks') == [old.get('name')] == list(cases) and new.get('name') == old.get('name')
            and cases[old['name']].get('aggregate') is True
            and isinstance(split, dict) and len(split) > 1 and set(split) == set(new.get('checks', []))
            and old['name'] not in split
            and all(isinstance(case, dict) and case.get('aggregate') is False for case in split.values())
            and all(case.get(k) == cases[old['name']].get(k) for case in split.values() for k in ('cwd', 'env'))
            and all({k: v for k, v in old.items() if k not in {'checks', 'worker_recipe'}}.get(k) == v
                    for k, v in new.items() if k not in {'checks', 'worker_recipe'})
            and set(old) == set(new)
            and {k: v for k, v in before.items() if k != 'cases'} == {k: v for k, v in after.items() if k != 'cases'})


def validate_recipe(recipe, checks):
    if not isinstance(recipe, dict) or set(recipe.get('cases', {})) != set(checks):
        raise ValueError('worker recipe must cover the full registered check inventory')
    for spec in [*recipe['cases'].values(), recipe.get('setup'), recipe.get('cleanup')]:
        if not spec:
            continue
        args = spec.get('command')
        if not isinstance(args, list) or not args or not all(isinstance(a, str) and a for a in args):
            raise ValueError('worker command must be a nonempty argv list')
        if any('--reuse-passed' in arg for arg in args):
            raise ValueError('worker recipes must execute fresh checks')


def validate(result, request, code, *, invalid_process=False):
    cases = result.get('cases')
    if (not isinstance(cases, dict) or set(cases) != set(request['checks'])
            or any(status not in ('PASS', 'FAIL', 'UNVERIFIED') for status in cases.values())
            or any(result.get(k) != request[k] for k in ('token', 'source', 'gate'))
            or result.get('reused', False) is not False
            or result.get('cleanup_complete') is not True):
        raise ValueError('worker result identity/inventory mismatch')
    complete = all(status != 'UNVERIFIED' for status in cases.values())
    if result.get('complete') is not complete:
        raise ValueError('worker result completeness mismatch')
    if 'worker_recipe' in request:
        if request.get('worker_root') is not None and result.get('worker_root') != request['worker_root']:
            raise ValueError('worker execution root differs from its isolation binding')
        expected = hashlib.sha256(json.dumps(request['worker_recipe'], sort_keys=True,
            separators=(',', ':')).encode()).hexdigest()
        if result.get('recipe_digest') != expected:
            raise ValueError('worker recipe changed')
    if invalid_process or code not in (0, 1) or (code == 0) != all(v == 'PASS' for v in cases.values()):
        raise ValueError('worker exit and test results disagree')
    return cases, complete
