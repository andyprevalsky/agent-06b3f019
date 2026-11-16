"""Daily team tasks must exercise real authorized grep; fixture mutation is local only."""
import json
import re
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest

from benchmarks.team_data import TASK_FIXTURES, apply_team_fixture

ROOT = Path(__file__).resolve().parents[2]
BLACKBOX = ROOT / 'back-end/src/tests/blackbox'
# label -> (seeder, the marker constant team_data_fixture.ts dispatches on; None = the default seeder)
SEEDERS = {
    'team_data_v1': (BLACKBOX / 'data-teams.fixture.ts', None),
    'team_integrations_v1': (BLACKBOX / 'team-integrations.fixture.ts', 'TEAM_INTEGRATIONS_MARKER'),
    'team_repo_v1': (BLACKBOX / 'team-integrations.fixture.ts', 'TEAM_REPO_MARKER'),
    'team_mcp_v1': (BLACKBOX / 'team-integrations.fixture.ts', 'TEAM_MCP_MARKER'),
}
GREP_FIXTURES = {'team_data_v1', 'team_integrations_v1'}


def _catalog() -> dict:
    return {task['name']: task for task in json.loads(Path(__file__).with_name('tasks.json').read_text())}


def test_daily_catalog_requires_real_grep_and_grounded_judging():
    tasks = _catalog()
    for name, (marker, fixture) in TASK_FIXTURES.items():
        task = tasks[name]
        assert task['group'] == 'daily' and task['status'] == 'ready'
        assert task['demo_cache'] == 'off' and task['enforce_declared_evaluators'] is True
        if fixture in GREP_FIXTURES:
            assert task['min_tool_counts']['grep'] >= 3
        else:
            assert task['requires_claude_code'] is True and task['min_tool_counts']['spawn_claude_code_agent'] >= 1
        assert marker in task['prompt']
        assert {'message_person', 'send_email', 'spawn_browser_agent'} <= set(task['forbidden_tools'])
        assert task['environment']['db_fixtures'] == [fixture]
        assert any(e['method'] == 'single_turn_llm_judge' and 'tool evidence' in e['judge_prompt'].lower() for e in task['evaluators'])
        assert any(c.get('type') == 'no_tool_failures' for e in task['evaluators'] for c in e.get('checks', []))


def test_each_fixture_label_has_one_seeder_and_markers_are_distinct():
    markers = [marker for marker, _ in TASK_FIXTURES.values()]
    assert len(set(markers)) == len(markers)
    assert {fixture for _, fixture in TASK_FIXTURES.values()} == set(SEEDERS)
    entrypoint = Path(__file__).with_name('team_data_fixture.ts').read_text()
    for label, (seeder, constant) in SEEDERS.items():
        if constant is None:
            continue
        seeded = re.search(rf"{constant} = '([^']+)'", seeder.read_text())
        assert seeded and f'marker === {constant}' in entrypoint
        # The entrypoint seeds this label only for its marker; every other marker keeps data-teams.
        assert [name for name, (marker, _) in TASK_FIXTURES.items() if marker == seeded.group(1)] == [
            name for name, (_, fixture) in TASK_FIXTURES.items() if fixture == label]


def test_shared_integrations_task_judges_every_seeded_value_and_private_record():
    task = _catalog()['team-daily-shared-integrations']
    seeder = SEEDERS['team_integrations_v1'][0].read_text()
    judge = next(e['judge_prompt'] for e in task['evaluators'] if e['method'] == 'single_turn_llm_judge')
    assert task['min_tool_counts']['grep'] >= 4
    assert task['tags'] == _catalog()['team-daily-investor-email-count']['tags']
    assert task['environment'] == {**_catalog()['team-daily-investor-email-count']['environment'],
                                   'db_fixtures': ['team_integrations_v1'],
                                   'context_notes': task['environment']['context_notes']}
    for shared in ('ORCHID-41', 'CEDAR-77', 'HARBOR-12', 'transactions=4', '1,134.60'):
        assert shared in judge
    for value in ('ORCHID-41', 'CEDAR-77', 'HARBOR-12', 'transactions: 4', "total: '1134.60'"):
        assert value in seeder
    shared_rows = seeder.split('const SHARED_TRANSACTIONS', 1)[1].split('];', 1)[0]
    amounts = re.findall(r"'(\d+\.\d{2})'\]", shared_rows)
    assert len(amounts) == 4 and f'{sum(map(Decimal, amounts)):.2f}' == '1134.60'
    for private in ('EMBER-93', 'GLACIER-58', 'Juniper Private Bank'):
        assert private in judge and private in seeder and private not in task['prompt']
    assert 'owner_user_id' in task['prompt'] and 'owner_user_id' in judge
    assert {'whatsapp', 'linkedin', 'granola'} <= set(re.findall(r'[a-z]+', judge))


def test_shared_repo_task_requires_a_code_agent_on_the_shared_ref():
    task = _catalog()['team-daily-shared-repo']
    seeder = SEEDERS['team_repo_v1'][0].read_text()
    judge = next(e['judge_prompt'] for e in task['evaluators'] if e['method'] == 'single_turn_llm_judge')
    assert task['requires_claude_code'] is True and task['min_tool_counts'] == {'spawn_claude_code_agent': 1}
    assert {'spawn_agent', 'spawn_claude_code_agent'} <= set(task['expected_tools'])
    # spawn_agent type=code runs as spawn_claude_code_agent, so forbidding it would fail every pass.
    assert 'spawn_claude_code_agent' not in task['forbidden_tools']
    assert 'e2b_code_sandbox' in task['environment']['services']
    repo_url = re.search(r"repoUrl: '([^']+)'", seeder).group(1)
    assert task['environment']['live_targets'] == [repo_url]
    shared_ref = 'gh:' + repo_url.removeprefix('https://github.com/').lower()
    for fact in (shared_ref, 'Hello World!', '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d', 'github_repo_ref', 'type=code'):
        assert fact in judge
    for fact in ("readmeFirstLine: 'Hello World!'", "headCommit: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d'",
                 "defaultBranch: 'master'"):
        assert fact in seeder
    for private in ('SECRET_REPO_FOLDER_DO_NOT_EXPOSE', 'gh:octocat/spoon-knife'):
        assert private in judge and private in seeder and private not in task['prompt']
    # The agent must find the repo in its shared data map; the prompt never names it.
    assert 'octocat' not in task['prompt'].lower() and 'github_repo_ref' in task['prompt']


def test_shared_mcp_task_requires_a_code_agent_calling_the_shared_server():
    task = _catalog()['team-daily-shared-mcp']
    seeder = SEEDERS['team_mcp_v1'][0].read_text()
    judge = next(e['judge_prompt'] for e in task['evaluators'] if e['method'] == 'single_turn_llm_judge')
    assert task['requires_claude_code'] is True and task['min_tool_counts'] == {'spawn_claude_code_agent': 1}
    assert {'spawn_agent', 'spawn_claude_code_agent'} <= set(task['expected_tools'])
    assert 'spawn_claude_code_agent' not in task['forbidden_tools']
    assert 'e2b_code_sandbox' in task['environment']['services']
    url = re.search(r"url: '([^']+)'", seeder).group(1)
    assert task['environment']['live_targets'] == [url]
    for fact in ('ROSE-TEAM-MCP Docs', 'resolve-library-id', 'type=code', 'react', 'tool evidence'):
        assert fact.lower() in judge.lower()
    assert "tool: 'resolve-library-id'" in seeder and 'name: `${marker} Docs`' in seeder
    # The reader must own no MCP server, so the code agent's tool can only come through the share.
    assert "the shared-MCP fixture needs a reader without one" in seeder
    for private in ('ROSE-TEAM-MCP Private Tools', 'tools.private.example.test'):
        assert private in judge and private in seeder and private not in task['prompt']
    # The agent must find the server in its shared data map; the prompt never names it.
    assert 'context7' not in task['prompt'].lower() and 'provider mcp' in task['prompt']


@pytest.mark.parametrize('base,database', [
    ('https://api.roselabs.ai', 'postgresql://localhost/victoria_test'),
    ('http://localhost:4001', 'postgresql://prod.example/victoria_test'),
    ('http://localhost:4001', 'postgresql://localhost/victoria'),
    ('http://localhost:4001', ''),
])
def test_fixture_never_mutates_remote_or_shared_database(base, database):
    with patch('benchmarks.team_data.subprocess.run') as run:
        with pytest.raises(ValueError):
            apply_team_fixture(next(iter(TASK_FIXTURES)), base, 'u', database)
        run.assert_not_called()


def test_fixture_passes_exact_local_identity_and_reports_failure():
    from types import SimpleNamespace
    with patch('benchmarks.team_data.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='{"marker":"ok"}\n')) as run:
        assert apply_team_fixture(next(iter(TASK_FIXTURES)), 'http://localhost:4001', 'reader', 'postgresql://localhost/victoria_owned') == {'marker': 'ok'}
        args, kwargs = run.call_args
        assert args[0][-2:] == ['reader', 'ROSE-TEAM-INVESTORS']
        assert kwargs['env']['DATABASE_URL'] == 'postgresql://localhost/victoria_owned'
        assert kwargs['env']['TEAM_BENCH_FIXTURE'] == '1'
    with patch('benchmarks.team_data.subprocess.run', return_value=SimpleNamespace(returncode=1, stderr='fixture denied')):
        with pytest.raises(RuntimeError, match='fixture denied'):
            apply_team_fixture(next(iter(TASK_FIXTURES)), 'http://localhost:4001', 'reader', 'postgresql://localhost/victoria_owned')


@pytest.mark.parametrize('task_name,marker', [
    ('team-daily-investor-email-count', 'ROSE-TEAM-INVESTORS'),
    ('team-daily-access-boundaries', 'ROSE-TEAM-BOUNDARIES'),
    ('team-daily-shared-integrations', 'ROSE-TEAM-SHARED'),
    ('team-daily-shared-repo', 'ROSE-TEAM-REPO'),
    ('team-daily-shared-mcp', 'ROSE-TEAM-MCP'),
])
def test_each_task_dispatches_its_own_marker(task_name, marker):
    from types import SimpleNamespace
    with patch('benchmarks.team_data.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=f'{{"marker":"{marker}"}}\n')) as run:
        assert apply_team_fixture(task_name, 'http://localhost:4001', 'reader', 'postgresql://localhost/victoria_owned') == {'marker': marker}
    assert run.call_args.args[0] == ['npx', 'tsx', 'agents/benchmarks/team_data_fixture.ts', 'reader', marker]
    with patch('benchmarks.team_data.subprocess.run') as never, pytest.raises(ValueError, match='Unknown'):
        apply_team_fixture(task_name + '-unknown', 'http://localhost:4001', 'reader', 'postgresql://localhost/victoria_owned')
    never.assert_not_called()


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
        apply_team_fixture(next(iter(TASK_FIXTURES)), 'http://localhost:3001', 'reader', 'postgresql://postgres:postgres@localhost:5432/victoria', owned_cloud=True)
    run.assert_not_called()
