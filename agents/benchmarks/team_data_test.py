"""Daily team tasks must exercise real authorized grep; fixture mutation is local only."""
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from benchmarks.team_data import TASK_MARKERS, apply_team_fixture


def test_daily_catalog_requires_real_grep_and_grounded_judging():
    tasks = {task['name']: task for task in json.loads(Path(__file__).with_name('tasks.json').read_text())}
    for name, marker in TASK_MARKERS.items():
        task = tasks[name]
        assert task['group'] == 'daily' and task['status'] == 'ready'
        assert task['demo_cache'] == 'off' and task['enforce_declared_evaluators'] is True
        assert task['min_tool_counts']['grep'] >= 3
        assert marker in task['prompt']
        assert {'message_person', 'send_email', 'spawn_browser_agent'} <= set(task['forbidden_tools'])
        assert task['environment']['db_fixtures'] == ['team_data_v1']
        assert any(e['method'] == 'single_turn_llm_judge' and 'tool evidence' in e['judge_prompt'].lower() for e in task['evaluators'])


@pytest.mark.parametrize('base,database', [
    ('https://api.roselabs.ai', 'postgresql://localhost/victoria_test'),
    ('http://localhost:4001', 'postgresql://prod.example/victoria_test'),
    ('http://localhost:4001', 'postgresql://localhost/victoria'),
    ('http://localhost:4001', ''),
])
def test_fixture_never_mutates_remote_or_shared_database(base, database):
    with patch('benchmarks.team_data.subprocess.run') as run:
        with pytest.raises(ValueError):
            apply_team_fixture(next(iter(TASK_MARKERS)), base, 'u', database)
        run.assert_not_called()


def test_fixture_passes_exact_local_identity_and_reports_failure():
    from types import SimpleNamespace
    with patch('benchmarks.team_data.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='{"marker":"ok"}\n')) as run:
        assert apply_team_fixture(next(iter(TASK_MARKERS)), 'http://localhost:4001', 'reader', 'postgresql://localhost/victoria_owned') == {'marker': 'ok'}
        args, kwargs = run.call_args
        assert args[0][-2:] == ['reader', 'ROSE-TEAM-INVESTORS']
        assert kwargs['env']['DATABASE_URL'] == 'postgresql://localhost/victoria_owned'
        assert kwargs['env']['TEAM_BENCH_FIXTURE'] == '1'
    with patch('benchmarks.team_data.subprocess.run', return_value=SimpleNamespace(returncode=1, stderr='fixture denied')):
        with pytest.raises(RuntimeError, match='fixture denied'):
            apply_team_fixture(next(iter(TASK_MARKERS)), 'http://localhost:4001', 'reader', 'postgresql://localhost/victoria_owned')


def test_verified_database_never_falls_back_to_workspace(tmp_path, monkeypatch):
    from benchmarks.team_data import verified_fixture_database
    monkeypatch.delenv('FLY_MACHINE_ID', raising=False)
    assert verified_fixture_database('postgresql://localhost/victoria_bench_owned', tmp_path, 'http://localhost:4401') == ('postgresql://localhost/victoria_bench_owned', False)
    with pytest.raises(ValueError, match='No verified owned'):
        verified_fixture_database(None, tmp_path, 'http://localhost:4401')


def test_verified_cloud_guest_requires_active_matching_manifest(monkeypatch):
    from benchmarks.team_data import verified_fixture_database
    root = Path(__file__).resolve().parents[2]
    context = root / '.context/cloudbench'
    monkeypatch.setenv('FLY_MACHINE_ID', 'fixture-machine')
    monkeypatch.setenv('BENCHMARK_ISOLATED_RUN', 'true')
    manifest = {'status': 'running', 'benchmark_mode': True, 'worktree': str(root), 'run_sh_pid': 123,
                'database': {'use_system_postgres': True, 'name': 'victoria', 'port': 5432}, 'ports': {'backend': 3001}}
    with patch.object(Path, 'read_text', return_value=json.dumps(manifest)), patch('benchmarks.team_data.os.kill') as alive:
        assert verified_fixture_database(None, context, 'http://localhost:3001') == ('postgresql://postgres:postgres@localhost:5432/victoria', True)
        alive.assert_called_once_with(123, 0)
    for field, value in [('status', 'stopped'), ('run_sh_pid', 1), ('benchmark_mode', False), ('worktree', '/other')]:
        bad = {**manifest, field: value}
        with patch.object(Path, 'read_text', return_value=json.dumps(bad)), pytest.raises(ValueError):
            verified_fixture_database(None, context, 'http://localhost:3001')
    with patch.object(Path, 'read_text', return_value=json.dumps(manifest)), pytest.raises(ValueError):
        verified_fixture_database(None, context, 'http://localhost:9999')


def test_direct_cloud_flag_cannot_authorize_workspace_database(monkeypatch):
    monkeypatch.delenv('FLY_MACHINE_ID', raising=False)
    with patch('benchmarks.team_data.subprocess.run') as run, pytest.raises(ValueError):
        apply_team_fixture(next(iter(TASK_MARKERS)), 'http://localhost:3001', 'reader', 'postgresql://postgres:postgres@localhost:5432/victoria', owned_cloud=True)
    run.assert_not_called()
