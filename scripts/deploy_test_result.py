"""Strict case-result validation shared by staged deploy coordinators."""
import hashlib
import json


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
            or result.get('reused', False) is not False):
        raise ValueError('worker result identity/inventory mismatch')
    complete = all(status != 'UNVERIFIED' for status in cases.values())
    if result.get('complete') is not complete:
        raise ValueError('worker result completeness mismatch')
    if 'worker_recipe' in request:
        expected = hashlib.sha256(json.dumps(request['worker_recipe'], sort_keys=True,
            separators=(',', ':')).encode()).hexdigest()
        if result.get('recipe_digest') != expected:
            raise ValueError('worker recipe changed')
    if invalid_process or code not in (0, 1) or (code == 0) != all(v == 'PASS' for v in cases.values()):
        raise ValueError('worker exit and test results disagree')
    return cases, complete
