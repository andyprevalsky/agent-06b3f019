import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Contracts of scripts/apply-local-runtime-sql-hooks.sh, the psql-backed installer
// of the migration-owned workflow cleanup triggers that coverage and the local
// stack apply before the backend starts. Split out of coverage-script.test.ts,
// which keeps the coverage/blackbox runner contracts (eslint max-lines).
const localRuntimeSqlHooks = readFileSync(
  join(process.cwd(), 'scripts', 'apply-local-runtime-sql-hooks.sh'),
  'utf8'
);

assert.match(
  localRuntimeSqlHooks,
  /20260723000000_add_workflow_iteration_offset[\s\S]*20260724002500_temporal_cleanup_utc_grace/,
  'the shared SQL-hook installer must retain both migration-owned trigger sources'
);

const START_MARKER = '-- Protect the rolling-deploy window';
const END_MARKER = '-- Prefer explicit logical-iteration checkpoints';
function runSqlHooks(workflowMigration: string): {
  status: number | null;
  psqlInput: string;
  stderr: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'runtime-sql-hooks-'));
  try {
    const backend = join(root, 'back-end');
    const migrations = join(backend, 'prisma', 'migrations');
    mkdirSync(join(backend, 'scripts'), { recursive: true });
    mkdirSync(join(migrations, '20260723000000_add_workflow_iteration_offset'), {
      recursive: true,
    });
    mkdirSync(join(migrations, '20260724002500_temporal_cleanup_utc_grace'), { recursive: true });
    mkdirSync(join(migrations, '20260929120000_agent_trajectory_search'), { recursive: true });
    mkdirSync(join(migrations, '20261026210002_agent_trajectory_agent'), { recursive: true });
    mkdirSync(join(migrations, '20261027020000_agent_trajectory_agent_skip_unchanged_lock'), {
      recursive: true,
    });
    mkdirSync(join(migrations, '20261026210001_tool_side_effect_operation_key_trgm'), {
      recursive: true,
    });
    copyFileSync(
      join(process.cwd(), 'scripts', 'apply-local-runtime-sql-hooks.sh'),
      join(backend, 'scripts', 'apply-local-runtime-sql-hooks.sh')
    );
    writeFileSync(
      join(migrations, '20260723000000_add_workflow_iteration_offset', 'migration.sql'),
      workflowMigration
    );
    writeFileSync(
      join(migrations, '20260724002500_temporal_cleanup_utc_grace', 'migration.sql'),
      'SELECT utc_cleanup;\n'
    );
    writeFileSync(
      join(migrations, '20260929120000_agent_trajectory_search', 'migration.sql'),
      'SELECT trajectory_search;\n'
    );
    writeFileSync(
      join(migrations, '20261026210002_agent_trajectory_agent', 'migration.sql'),
      'SELECT trajectory_agent;\n'
    );
    writeFileSync(
      join(
        migrations,
        '20261027020000_agent_trajectory_agent_skip_unchanged_lock',
        'migration.sql'
      ),
      'SELECT trajectory_agent_unchanged;\n'
    );
    writeFileSync(
      join(migrations, '20261026210001_tool_side_effect_operation_key_trgm', 'migration.sql'),
      'CREATE INDEX CONCURRENTLY tool_side_effect_trgm;\n'
    );
    for (const [name, sql] of [
      [
        '20261105233000_cloud_message_unresolved_task',
        'CREATE UNIQUE INDEX CONCURRENTLY "phone_pending_fixture" ON "ImessageQueue" ("phoneBrowserTaskId");\n',
      ],
      [
        '20261105233001_cloud_message_drop_historical_unique',
        'DROP INDEX CONCURRENTLY "phone_historical_fixture";\n',
      ],
      [
        '20261105233002_cloud_message_task_history_index',
        'CREATE INDEX CONCURRENTLY "phone_history_fixture" ON "ImessageQueue" ("phoneBrowserTaskId");\n',
      ],
    ] as const) {
      const directory = join(migrations, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'migration.sql'), sql);
    }
    const fakeBin = join(root, 'bin');
    const psqlInput = join(root, 'psql-input.sql');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'psql'), `#!/bin/sh\ncat > '${psqlInput}'\n`);
    chmodSync(join(fakeBin, 'psql'), 0o755);
    const result = spawnSync(
      'bash',
      [join(backend, 'scripts', 'apply-local-runtime-sql-hooks.sh')],
      {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/victoria',
        },
        encoding: 'utf8',
      }
    );
    return {
      status: result.status,
      psqlInput: existsSync(psqlInput) ? readFileSync(psqlInput, 'utf8') : '',
      stderr: result.stderr,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const appliedHooks = runSqlHooks(
  `SELECT before;\n${START_MARKER}\nCREATE TRIGGER workflow_guard;\n${END_MARKER}\nSELECT after;\n`
);
assert.equal(appliedHooks.status, 0, 'a well-formed workflow migration must apply');
assert.match(
  appliedHooks.psqlInput,
  /pg_advisory_xact_lock[\s\S]*CREATE TRIGGER workflow_guard;[\s\S]*SELECT utc_cleanup;[\s\S]*SELECT trajectory_search;[\s\S]*SELECT trajectory_agent;[\s\S]*SELECT trajectory_agent_unchanged;[\s\S]*CREATE INDEX tool_side_effect_trgm;/,
  'the advisory lock, the marked workflow block, the UTC cleanup, the trajectory search projection, its per-agent supersession, its unchanged-row lock skip and the non-concurrent trigram index must reach psql in order'
);
assert.match(
  appliedHooks.psqlInput,
  /CREATE TRIGGER workflow_guard;[\s\S]*CREATE UNIQUE INDEX IF NOT EXISTS "phone_pending_fixture"[\s\S]*DROP INDEX IF EXISTS "phone_historical_fixture"[\s\S]*CREATE INDEX IF NOT EXISTS "phone_history_fixture"[\s\S]*SELECT utc_cleanup;/,
  'all three cloud-message migrations must reach psql in order with transaction-safe index DDL'
);
assert.doesNotMatch(
  appliedHooks.psqlInput,
  /SELECT (before|after);/,
  'only the marked workflow block may be applied from the iteration-offset migration'
);
const MARKER_REASON = /workflow markers must each appear exactly once, in order/;
const EMPTY_REASON = /no workflow SQL between the markers/;
for (const [label, migration, reason] of [
  ['a missing end marker', `${START_MARKER}\nCREATE TRIGGER workflow_guard;\n`, MARKER_REASON],
  [
    'a duplicated start marker',
    `${START_MARKER}\nCREATE TRIGGER a;\n${START_MARKER}\nCREATE TRIGGER b;\n${END_MARKER}\n`,
    MARKER_REASON,
  ],
  [
    'markers in the wrong order',
    `${END_MARKER}\nCREATE TRIGGER a;\n${START_MARKER}\nCREATE TRIGGER b;\n`,
    MARKER_REASON,
  ],
  ['an empty marked block', `${START_MARKER}\n\n${END_MARKER}\n`, EMPTY_REASON],
  [
    'a comment-only marked block',
    `${START_MARKER}\n  -- nothing to apply\n${END_MARKER}\n`,
    EMPTY_REASON,
  ],
] as const) {
  const rejected = runSqlHooks(migration);
  assert.equal(rejected.status, 2, `${label} must be rejected before psql runs`);
  assert.equal(rejected.psqlInput, '', `${label} must not apply any SQL`);
  assert.match(rejected.stderr, reason, `${label} must report why it was rejected`);
}

process.stdout.write('local runtime SQL hook contracts passed\n');
