"""Owned DEMO recording must survive fixture resets without changing other runs."""

import hashlib
import json

import pytest

from benchmarks.benchmark_tasks import get_task_by_name
from benchmarks.local import REPO_ROOT, apply_owned_wmh_recording


def admitted(env, *, workspace="wmh-iteration-owner", **options):
    return apply_owned_wmh_recording(
        env,
        isolated=options.get("isolated", True),
        simulate=options.get("simulate", True),
        tasks=[get_task_by_name("raise-5m-rose-labs-brex")],
        workspace=workspace,
        fixture_database="victoria_bench_iteration_owner",
    )


def owned_env(tmp_path):
    url = "postgresql://offline@localhost:5432/victoria_wmh_recording_offline"
    manifest = tmp_path / "owner.json"
    owner = {
        "checkout": str(REPO_ROOT.resolve()),
        "owner_workspace": "wmh-iteration-owner",
        "database": "victoria_wmh_recording_offline",
        "host": "localhost",
        "url_sha256": hashlib.sha256(url.encode()).hexdigest(),
        "retained_across_iterations": True,
    }
    manifest.write_text(json.dumps(owner))
    return (
        {
            "FAST_MODE_CACHE_RECORD_DEMO": "1",
            "FAST_MODE_CACHE_USE_LOCAL": "1",
            "FAST_MODE_CACHE_DATABASE_URL": "postgresql://offline@localhost/fixture",
            "WMH_OWNED_RECORDING_CACHE_DATABASE_URL": url,
            "WMH_OWNED_RECORDING_CACHE_MANIFEST": str(manifest),
        },
        owner,
        manifest,
    )


def test_recording_routes_to_retained_owner_instead_of_resettable_fixture(tmp_path):
    env, _, _ = owned_env(tmp_path)
    assert admitted(env)
    assert env["FAST_MODE_CACHE_DATABASE_URL"] == env["WMH_OWNED_RECORDING_CACHE_DATABASE_URL"]
    assert env["FAST_MODE_CACHE_DISABLE_WRITE_THROUGH"] == "0"
    assert "FAST_MODE_CACHE_USE_LOCAL" not in env


@pytest.mark.parametrize("options", [{"isolated": False}])
def test_other_run_modes_preserve_their_environment(tmp_path, options):
    env, _, _ = owned_env(tmp_path)
    before = dict(env)
    assert admitted(env, **options) is False
    assert env == before


def test_ordinary_demo_recording_without_retained_selectors_is_unchanged():
    env = {"FAST_MODE_CACHE_RECORD_DEMO": "1", "FAST_MODE_CACHE_DISABLE_WRITE_THROUGH": "1"}
    before = dict(env)
    assert admitted(env) is False
    assert env == before


@pytest.mark.parametrize(
    "field", ["checkout", "owner_workspace", "database", "host", "url_sha256", "retained_across_iterations"]
)
def test_wrong_retained_store_owner_fails_closed_without_env_mutation(tmp_path, field):
    env, owner, manifest = owned_env(tmp_path)
    owner[field] = False if field == "retained_across_iterations" else "wrong-owner"
    manifest.write_text(json.dumps(owner))
    before = dict(env)
    with pytest.raises(ValueError):
        admitted(env)
    assert env == before


@pytest.mark.parametrize("missing", ["WMH_OWNED_RECORDING_CACHE_MANIFEST", "WMH_OWNED_RECORDING_CACHE_DATABASE_URL"])
def test_partial_retained_store_selection_fails_closed(tmp_path, missing):
    env, _, _ = owned_env(tmp_path)
    env.pop(missing)
    with pytest.raises(ValueError):
        admitted(env)


def test_iteration_cannot_claim_another_iteration_manifest(tmp_path):
    env, _, _ = owned_env(tmp_path)
    with pytest.raises(ValueError):
        admitted(env, workspace="another-iteration-owner")

@pytest.mark.parametrize('conflict', ['database', 'record', 'write', 'readonly'])
def test_fresh_recording_conflicts_fail_before_mutation(tmp_path, conflict):
    env, _, _ = owned_env(tmp_path)
    if conflict == 'database': env['DEMO_CACHE_DATABASE_URL'] = 'postgresql://offline@localhost/other'
    if conflict == 'record': env['DEMO_CACHE_RECORD_DEMO'] = '0'
    if conflict == 'write':
        env['FAST_MODE_CACHE_DISABLE_WRITE_THROUGH'] = '0'
        env['DEMO_CACHE_DISABLE_WRITE_THROUGH'] = '1'
    if conflict == 'readonly': env['BENCHMARK_DEMO_CACHE_READ_ONLY'] = '1'
    before = dict(env)
    with pytest.raises(ValueError): admitted(env)
    assert env == before


def test_admission_binds_both_aliases_and_accepts_mass_task(tmp_path):
    env, _, _ = owned_env(tmp_path)
    assert apply_owned_wmh_recording(env, isolated=True, simulate=True, tasks=[get_task_by_name('test-mass-agent-run-0')], workspace='wmh-iteration-owner', fixture_database='fixture')
    assert env['DEMO_CACHE_DATABASE_URL'] == env['FAST_MODE_CACHE_DATABASE_URL']
    assert env['DEMO_CACHE_DISABLE_WRITE_THROUGH'] == env['FAST_MODE_CACHE_DISABLE_WRITE_THROUGH'] == '0'


def test_reverse_record_alias_conflict_is_not_silently_ordinary(tmp_path):
    env, _, _ = owned_env(tmp_path)
    env['FAST_MODE_CACHE_RECORD_DEMO'] = '0'
    env['DEMO_CACHE_RECORD_DEMO'] = '1'
    before = dict(env)
    with pytest.raises(ValueError): admitted(env)
    assert env == before


@pytest.mark.parametrize('change', ['symlink', 'oversized', 'empty_workspace', 'remote', 'fixture'])
def test_owned_recording_manifest_and_database_guards(tmp_path, change):
    env, owner, manifest = owned_env(tmp_path)
    workspace = 'wmh-iteration-owner'
    fixture = 'fixture'
    if change == 'symlink':
        linked = tmp_path / 'linked.json'; linked.symlink_to(manifest); env['WMH_OWNED_RECORDING_CACHE_MANIFEST'] = str(linked)
    elif change == 'oversized': manifest.write_text(' ' * 17000)
    elif change == 'empty_workspace':
        owner['owner_workspace'] = None; manifest.write_text(json.dumps(owner)); workspace = None
    else:
        url = ('postgresql://offline@remote/' if change == 'remote' else 'postgresql://offline@localhost/') + owner['database']
        env['WMH_OWNED_RECORDING_CACHE_DATABASE_URL'] = url
        owner['url_sha256'] = hashlib.sha256(url.encode()).hexdigest(); owner['host'] = 'remote' if change == 'remote' else 'localhost'
        manifest.write_text(json.dumps(owner))
        if change == 'fixture': fixture = owner['database']
    before = dict(env)
    with pytest.raises(ValueError):
        apply_owned_wmh_recording(env, isolated=True, simulate=True, tasks=[get_task_by_name('test-mass-agent-run-0')], workspace=workspace, fixture_database=fixture)
    assert env == before


def test_owned_real_recording_admission_preserves_actual_mode(tmp_path):
    env, _, _ = owned_env(tmp_path)
    env['BENCHMARK_WORLD_MODEL_MODE']='real'
    assert apply_owned_wmh_recording(env,isolated=True,simulate=False,tasks=[get_task_by_name('test-mass-agent-run-0')],workspace='wmh-iteration-owner',fixture_database='fixture')
    assert env['BENCHMARK_WORLD_MODEL_MODE']=='real'
    assert env['DEMO_CACHE_DATABASE_URL']==env['WMH_OWNED_RECORDING_CACHE_DATABASE_URL']


@pytest.mark.parametrize('mode', ['unsupported', 'simulate', ''])
def test_owned_real_recording_rejects_conflicting_or_unknown_mode_before_mutation(tmp_path, mode):
    env, _, _ = owned_env(tmp_path)
    env['BENCHMARK_WORLD_MODEL_MODE']=mode
    before=dict(env)
    with pytest.raises(ValueError):
        apply_owned_wmh_recording(env,isolated=True,simulate=False,tasks=[get_task_by_name('test-mass-agent-run-0')],workspace='wmh-iteration-owner',fixture_database='fixture')
    assert env==before


def test_owned_admission_sets_explicit_real_or_simulate_without_inheriting(tmp_path):
    for simulate, expected in [(False,'real'),(True,'simulate')]:
        env, _, _ = owned_env(tmp_path)
        assert apply_owned_wmh_recording(env,isolated=True,simulate=simulate,tasks=[get_task_by_name('test-mass-agent-run-0')],workspace='wmh-iteration-owner',fixture_database='fixture')
        assert env['BENCHMARK_WORLD_MODEL_MODE']==expected
