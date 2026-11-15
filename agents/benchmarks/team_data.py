"""Isolated fixture dispatcher for daily team data benchmarks."""
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

# Each task's (record marker, db_fixtures label). team_data_fixture.ts picks the seeder by marker:
# ROSE-TEAM-SHARED seeds team-integrations.fixture.ts, every other marker data-teams.fixture.ts.
TASK_FIXTURES = {
    'team-daily-investor-email-count': ('ROSE-TEAM-INVESTORS', 'team_data_v1'),
    'team-daily-access-boundaries': ('ROSE-TEAM-BOUNDARIES', 'team_data_v1'),
    'team-daily-shared-integrations': ('ROSE-TEAM-SHARED', 'team_integrations_v1'),
}


def apply_team_fixture(task_name: str, base_url: str, user_id: str, database_url: str, *, owned_cloud: bool = False) -> dict:
    if task_name not in TASK_FIXTURES:
        raise ValueError('Unknown team data fixture')
    target = urlsplit(database_url)
    if owned_cloud:
        verified_url, verified_cloud = verified_fixture_database(
            None, Path(os.environ.get('BENCHMARK_CONTEXT_DIR', '')), base_url)
        if not verified_cloud or verified_url != database_url:
            raise ValueError('Cloud fixture database does not match its owned manifest')
    if urlsplit(base_url).hostname not in {'localhost', '127.0.0.1', '::1'} or target.hostname not in {'localhost', '127.0.0.1', '::1'} or not (target.path.startswith('/victoria_') or (owned_cloud and target.path == '/victoria')):
        raise ValueError('Team fixtures require an isolated local stack and database')
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        ['npx', 'tsx', 'agents/benchmarks/team_data_fixture.ts', user_id, TASK_FIXTURES[task_name][0]],
        cwd=root, env={**os.environ, 'DATABASE_URL': database_url, 'TEAM_BENCH_FIXTURE': '1', 'TEAM_BENCH_OWNED_CLOUD': '1' if owned_cloud else '0'},
        text=True, capture_output=True, timeout=60,
    )
    if result.returncode:
        raise RuntimeError(f'Team data fixture failed: {result.stderr[-2000:]}')
    return json.loads(result.stdout.strip().splitlines()[-1])


def verified_fixture_database(isolated_url: str | None, context_dir: Path, base_url: str) -> tuple[str, bool]:
    """Prefer the shared isolated-stack resolver; admit bare victoria only on the dedicated cloud guest."""
    if isolated_url:
        return isolated_url, False
    root = Path(__file__).resolve().parents[2]
    if (context_dir.resolve() != (root / '.context/cloudbench').resolve()
            or os.environ.get('BENCHMARK_ISOLATED_RUN', '').lower() not in {'1', 'true'}
            or not os.environ.get('FLY_MACHINE_ID')):
        raise ValueError('No verified owned team fixture database')
    manifest = json.loads((context_dir / 'services.json').read_text())
    db = manifest.get('database', {})
    pid = manifest.get('run_sh_pid')
    if (manifest.get('status') != 'running' or manifest.get('benchmark_mode') is not True
            or Path(manifest.get('worktree', '')).resolve() != root
            or db.get('use_system_postgres') is not True or db.get('name') != 'victoria'
            or db.get('port') != 5432 or not isinstance(pid, int) or pid <= 1
            or urlsplit(base_url).hostname not in {'localhost', '127.0.0.1'}
            or manifest.get('ports', {}).get('backend') != urlsplit(base_url).port):
        raise ValueError('Cloud team fixture manifest does not match its active isolated stack')
    os.kill(pid, 0)
    return 'postgresql://postgres:postgres@localhost:5432/victoria', True
