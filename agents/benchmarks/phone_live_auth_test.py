from argparse import Namespace

import pytest


def test_live_auth_catalog_requires_real_phone_and_authenticated_target():
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.run_benchmark import resolve_tasks
    task = get_task_by_name('browser-auth-doordash-cloud-iphone')
    assert task is not None
    assert {'auth', 'daily', 'LIVE'} <= set(task.tags)
    assert task.group == 'daily' and task.demo_cache == 'off'
    assert task.browser_profile_mode == 'fresh'
    assert task.environment['fresh_auth_realms'] == ['doordash.com', 'google.com']
    assert task.enforce_declared_evaluators
    criteria = ' '.join(c for e in task.evaluators for c in e['criteria'])
    assert 'authenticated DoorDash' in criteria and 'cloud iPhone' in criteria
    assert 'not exercised' in criteria
    args = Namespace(task=None, tasks=None, suite='daily', prod=False, exclude_task=[])
    assert task.name in {t.name for t in resolve_tasks(args)}


def test_fresh_auth_realms_preserves_default_and_validates_explicit_list():
    from benchmarks.phone_live_auth import fresh_auth_realms
    assert fresh_auth_realms(Namespace(browser_auth_realm='example.com', environment={})) == ('example.com',)
    assert fresh_auth_realms(Namespace(browser_auth_realm='doordash.com', environment={'fresh_auth_realms':['doordash.com','google.com']})) == ('doordash.com','google.com')
    with pytest.raises(ValueError):
        fresh_auth_realms(Namespace(browser_auth_realm='doordash.com', environment={'fresh_auth_realms':['google.com']}))
