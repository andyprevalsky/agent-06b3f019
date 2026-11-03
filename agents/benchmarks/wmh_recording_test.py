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


@pytest.mark.parametrize("options", [{"isolated": False}, {"simulate": False}])
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
