import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Follow-up y (2026-10-30): run-blackbox-tests.sh refused its per-workspace
// system-Postgres fallback whenever ANY victoria-db-* container was running,
// so on a system-PG deploy worktree (which owns no container by design) the
// live probes and the coverage lane's trailing teardown test found no
// database. Replay the production selection branch with a fake docker/
// pg_isready: a prepared isolated deploy worktree (ROSE_DEPLOY_WORKTREE=1,
// its own .context/deploy-system-pg.db marker) must select victoria_<hint>
// on the marker's server regardless of other workspaces' containers, never
// the shared `victoria`; every other case keeps the refusal.
const runnerScript = readFileSync(join(process.cwd(), 'scripts', 'run-blackbox-tests.sh'), 'utf8');
const start = runnerScript.indexOf('# Try Docker container first');
const end = runnerScript.indexOf('if $STACK_DB_EXPECTED && ! $DB_FOUND; then');
assert.ok(start >= 0 && end > start, 'production database selection branch must exist');
const selectionBranch = runnerScript.slice(start, end);

const root = mkdtempSync(join(tmpdir(), 'blackbox-runner-db-'));
try {
  const identity = 'descend-I99-fixture';
  const fakeBin = join(root, 'bin');
  const state = join(root, 'state');
  mkdirSync(fakeBin);
  mkdirSync(state);
  mkdirSync(join(root, '.context'));
  // Fake docker: daemon up, no container owned by this worktree, another
  // workspace's victoria-db-* container running (FAKE_DOCKER_OTHERS lists it).
  writeFileSync(
    join(fakeBin, 'docker'),
    `#!/usr/bin/env bash
case "$1" in
  info) exit 0 ;;
  ps) printf '%s' "\${FAKE_DOCKER_OTHERS:-}"; [ -z "\${FAKE_DOCKER_OTHERS:-}" ] || printf '\\n' ;;
  inspect|port|exec) exit 1 ;;
  *) echo "unexpected docker $*" >&2; exit 97 ;;
esac
`
  );
  // Fake pg_isready: every local port answers; the selection must still pick
  // the marker's server (5432) on a deploy worktree. Records the ports probed.
  writeFileSync(
    join(fakeBin, 'pg_isready'),
    `#!/usr/bin/env bash
port=""
while [ "$#" -gt 0 ]; do case "$1" in -p) port="$2"; shift 2 ;; *) shift ;; esac; done
echo "$port" >> "\${FAKE_PG_STATE:?}/probed"
exit 0
`
  );
  chmodSync(join(fakeBin, 'docker'), 0o755);
  chmodSync(join(fakeBin, 'pg_isready'), 0o755);

  const select = (overrides: Record<string, string>) => {
    rmSync(join(state, 'probed'), { force: true });
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
source "$SCRIPT_DIR/local-db-container.sh"
WORKTREE_HINT="$(basename "$ROOT_DIR")"
WORKSPACE_HINT="\${CONDUCTOR_WORKSPACE_NAME:-$WORKTREE_HINT}"
LOCAL_DB_PORT=""
if [[ -n "\${CONDUCTOR_PORT:-}" ]]; then LOCAL_DB_PORT=$(($CONDUCTOR_PORT + 5)); fi
DB_CONTAINER="victoria-db-\${WORKSPACE_HINT}"
DB_FOUND=false
STACK_DB_EXPECTED=false
SELECTED_DB_URL=""
ENSURE_SYSTEM_DB_NAME=""
ISOLATED_DB_RESOLVED=false
${selectionBranch}
printf 'SELECTED=%s\\nENSURE=%s\\nFOUND=%s\\n' "$SELECTED_DB_URL" "$ENSURE_SYSTEM_DB_NAME" "$DB_FOUND"`,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          HOME: process.env.HOME ?? root,
          SCRIPT_DIR: join(process.cwd(), 'scripts'),
          ROOT_DIR: root,
          CONDUCTOR_WORKSPACE_NAME: identity,
          CONDUCTOR_PORT: '20010',
          FAKE_PG_STATE: state,
          FAKE_DOCKER_OTHERS: 'victoria-db-other-workspace',
          DOCKER_PROBE_TICKS: '25',
          ...overrides,
        },
      }
    );
    let probed: string[] = [];
    try {
      probed = readFileSync(join(state, 'probed'), 'utf8').trim().split('\n').filter(Boolean);
    } catch {
      probed = [];
    }
    return { ...result, probed };
  };

  const marker = join(root, '.context', 'deploy-system-pg.db');
  writeFileSync(marker, 'victoria_deploy_descend_I99_fixture\n');
  const deployEnv = {
    ROSE_DEPLOY_WORKTREE: '1',
    ROSE_DEPLOY_WORKTREE_PATH: root,
    ROSE_USE_SYSTEM_PG: 'true',
  };

  // Prepared deploy worktree + a foreign container running: its own database on 5432.
  const prepared = select(deployEnv);
  assert.equal(
    prepared.status,
    0,
    `prepared deploy worktree refused: ${prepared.stdout}${prepared.stderr}`
  );
  assert.match(
    prepared.stdout,
    /SELECTED=postgresql:\/\/postgres:postgres@localhost:5432\/victoria_descend-I99-fixture\n/
  );
  assert.match(
    prepared.stdout,
    /ENSURE=victoria_descend-I99-fixture\n/,
    'created on demand like every workspace database'
  );
  assert.match(prepared.stdout, /FOUND=true/);
  assert.deepEqual(
    prepared.probed,
    ['5432'],
    "only the marker's server is probed, never CONDUCTOR_PORT+5"
  );
  assert.doesNotMatch(
    prepared.stdout,
    /\/victoria\n/,
    'the shared victoria database is never selected'
  );

  // The same checkout without ROSE_DEPLOY_WORKTREE keeps the refusal.
  const plain = select({ ROSE_DEPLOY_WORKTREE: '0', ROSE_DEPLOY_WORKTREE_PATH: root });
  assert.notEqual(
    plain.status,
    0,
    'a non-deploy worktree must still refuse while other workspace DBs run'
  );
  assert.match(
    plain.stderr,
    /Refusing shared system Postgres while other workspace DBs are active/
  );
  assert.deepEqual(plain.probed, [], 'refused before any system server is probed');

  // A deploy worktree whose marker names another checkout, or has no marker, keeps the refusal.
  const foreignPath = join(root, 'elsewhere');
  mkdirSync(foreignPath);
  assert.notEqual(
    select({ ...deployEnv, ROSE_DEPLOY_WORKTREE_PATH: foreignPath }).status,
    0,
    'foreign worktree path'
  );
  rmSync(marker);
  const unprepared = select(deployEnv);
  assert.notEqual(
    unprepared.status,
    0,
    'a deploy worktree without the system-PG marker keeps the refusal'
  );
  assert.match(unprepared.stderr, /Refusing shared system Postgres/);
  writeFileSync(marker, 'victoria_deploy_descend_I99_fixture\n');

  // No other workspace container: the generic fallback is unchanged (CONDUCTOR_PORT+5 first).
  const alone = select({ FAKE_DOCKER_OTHERS: '', ROSE_DEPLOY_WORKTREE: '0' });
  assert.equal(alone.status, 0, `generic fallback refused: ${alone.stdout}${alone.stderr}`);
  assert.match(
    alone.stdout,
    /SELECTED=postgresql:\/\/postgres:postgres@localhost:20015\/victoria_descend-I99-fixture\n/
  );
  assert.deepEqual(alone.probed, ['20015']);

  // A deploy worktree also wins when no other container runs: still the marker's server.
  const aloneDeploy = select({ ...deployEnv, FAKE_DOCKER_OTHERS: '' });
  assert.equal(aloneDeploy.status, 0, aloneDeploy.stderr);
  assert.deepEqual(aloneDeploy.probed, ['5432']);
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.stdout.write('blackbox runner database selection on a deploy worktree: PASS\n');
