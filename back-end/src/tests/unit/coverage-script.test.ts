import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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

const coverageScript = readFileSync(join(process.cwd(), 'scripts', 'run-coverage.sh'), 'utf8');
const localRuntimeSqlHooks = readFileSync(
  join(process.cwd(), 'scripts', 'apply-local-runtime-sql-hooks.sh'),
  'utf8'
);
const blackboxScript = readFileSync(
  join(process.cwd(), 'scripts', 'run-blackbox-tests.sh'),
  'utf8'
);
const blackboxRunner = readFileSync(
  join(process.cwd(), 'src', 'tests', 'blackbox', 'run.ts'),
  'utf8'
);
const agentCardLockWrapper = readFileSync(
  join(process.cwd(), 'scripts', 'with-agentcard-lock.py'),
  'utf8'
);
const gateResolutionProvider = readFileSync(
  join(process.cwd(), 'src', 'providers', 'gateResolution.ts'),
  'utf8'
);
const unitRunner = readFileSync(join(process.cwd(), 'scripts', 'run-unit-tests.ts'), 'utf8');
const adminHealthBlackbox = readFileSync(
  join(process.cwd(), 'src', 'tests', 'blackbox', 'admin-health.blackbox.ts'),
  'utf8'
);
const autoRcaEnvPath = join(process.cwd(), 'scripts', 'blackbox-auto-rca-env.sh');

assert.ok(
  existsSync(autoRcaEnvPath),
  'backend launchers must share the deterministic Slack auto-RCA environment'
);
const autoRcaEnv = readFileSync(autoRcaEnvPath, 'utf8');

for (const [name, harness] of [
  ['coverage', coverageScript],
  ['blackbox', blackboxScript],
] as const) {
  assert.match(
    harness,
    /source .*blackbox-auto-rca-env\.sh/,
    `${name} launcher must source the shared Slack auto-RCA fixture environment`
  );
  assert.ok(
    harness.indexOf('source "$SCRIPT_DIR/blackbox-auto-rca-env.sh"') <
      harness.indexOf('src/bootstrap.ts'),
    `${name} launcher must load the shared Slack auto-RCA environment before backend boot`
  );
}
for (const variable of [
  'SLACK_SIGNING_SECRET',
  'SLACK_BOT_TOKEN',
  'SLACK_ERROR_CHANNEL_ID',
  'GITHUB_DISPATCH_TOKEN',
  'AUTO_RCA_ENABLED',
  'SLACK_AUTO_RCA_OWNER_USER_ID',
  'SLACK_AUTO_RCA_FEEDBACK_USER_IDS',
  'SLACK_AUTO_RCA_REPO_URL',
  'BLACKBOX_TEST_FAKE_SLACK',
  'STRIPE_SECRET_KEY',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'BLACKBOX_TEST_FAKE_WHATSAPP',
  'BENCHMARK_SHARE_SECRET',
]) {
  assert.equal(
    autoRcaEnv.match(new RegExp(`^export ${variable}=`, 'gm'))?.length ?? 0,
    1,
    `shared auto-RCA environment must export ${variable} exactly once`
  );
}
assert.match(
  autoRcaEnv,
  /BLACKBOX_TEST_CAPTURE_OUTBOUND[\s\S]*BLACKBOX_TEST_REPLAY_OUTBOUND/,
  'shared auto-RCA fixtures must fail closed outside capture/replay mode'
);
for (const explicitFixture of [
  '',
  JSON.stringify({
    reasoning: 'explicit fixture',
    reaction_emoji: '🦊',
    tool_calls: [{ tool: 'send_user_message', arguments: { message: 'explicit reply' } }],
  }),
]) {
  const inherited = execFileSync(
    'bash',
    [
      '-c',
      'set -e; source "$1"; node --import tsx --eval "$2"',
      'supervisor-fixture-child',
      autoRcaEnvPath,
      `const assert = require('node:assert/strict');
     const { loadBlackboxSupervisorResponseFixture: load } = require('./src/providers/smsSupervisor/supervisorFixtures.ts');
     const reaction = load('new-user-without-override', true);
     assert.ok(reaction, 'new-user reaction must inherit the launcher fixture before backend boot');
     process.stdout.write(JSON.stringify({ reaction, reply: load('new-user-without-override') }));`,
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        BLACKBOX_TEST_CAPTURE_OUTBOUND: '1',
        BLACKBOX_TEST_REPLAY_OUTBOUND: '1',
        BLACKBOX_SMS_SUPERVISOR_RESPONSE_JSON: explicitFixture,
      },
    }
  );
  const fixture = JSON.parse(inherited);
  assert.equal(fixture.reaction.response.tool_calls[0].tool, 'react_to_message');
  assert.equal(
    fixture.reaction.response.tool_calls[0].arguments.emoji,
    explicitFixture ? '🦊' : '👍'
  );
  assert.equal(
    fixture.reply.response.tool_calls[0].arguments.message,
    explicitFixture ? 'explicit reply' : 'Blackbox SMS smoke reply'
  );
}
for (const [name, harness] of [
  ['coverage', coverageScript],
  ['blackbox', blackboxScript],
] as const) {
  assert.ok(
    harness.indexOf('node "$SCRIPT_DIR/assert-prisma-client-current.mjs"') > 0 &&
      harness.indexOf('node "$SCRIPT_DIR/assert-prisma-client-current.mjs"') <
        harness.indexOf('npx prisma db push'),
    `${name} launcher must verify Prisma freshness before syncing or starting test children`
  );
  assert.ok(
    !harness.includes('npx prisma generate'),
    `${name} launcher must not regenerate a fresh Prisma client under concurrent lint/type checks`
  );
  assert.doesNotMatch(harness, /prisma generate/, `${name} must not rewrite shared dependencies`);
}

execFileSync('python3', ['../scripts/tests/prisma-test-launcher-readonly.test.py'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  timeout: 90000,
});

assert.match(
  coverageScript,
  /dotenv_effective_value/,
  'coverage must prefer back-end/.env over stale Cursor-injected AgentCard/GitHub secrets'
);
assert.match(
  coverageScript,
  /AGENTCARD_ORG_OAUTH_CLIENT_ID/,
  'coverage must re-export AgentCard org OAuth client id from .env for blackbox gates'
);
assert.match(
  coverageScript,
  /GITHUB_DISPATCH_TOKEN/,
  'coverage must re-export GITHUB_DISPATCH_TOKEN from .env for external-http blackbox'
);

// The preflight must only ever count *listening* sockets: an outbound
// connection that happens to use the same local port must not make the port
// look taken. Each probe in the fallback chain has to preserve that, and the
// chain has to exist -- when lsof is absent, its "command not found" exit is
// indistinguishable from "port is free", which handed out occupied ports.
assert.match(
  coverageScript,
  /lsof -tiTCP:"\$port" -sTCP:LISTEN/,
  'coverage port preflight must ignore outbound connections using the same local port'
);
assert.match(
  coverageScript,
  /ss -ltnH/,
  'coverage port preflight ss fallback must list listening sockets only'
);
assert.match(
  coverageScript,
  /if port_in_use "\$candidate"; then/,
  'coverage port reservation must go through the portable port_in_use probe'
);
assert.match(
  coverageScript,
  /reserve_coverage_port/,
  'coverage must reserve an available port instead of assuming its preferred port is free'
);
assert.doesNotMatch(
  coverageScript,
  /COV_PORT=\$\(\(BASE_PORT \+ 200\)\)/,
  'coverage must not hard-code a port outside the workspace reserved range'
);
assert.match(
  coverageScript,
  /COV_PORT_START=.*BASE_PORT \+ 7[\s\S]*COV_PORT_END=.*BASE_PORT \+ 8/,
  'coverage port selection must stay inside the workspace-owned ten-port range'
);
assert.match(
  coverageScript,
  /coverage-process-lock\.py[\s\S]*Another backend coverage run is already active/,
  'coverage must lock the whole run before mutating shared artifacts or the test database'
);
assert.doesNotMatch(
  coverageScript,
  /mkdir "\$COVERAGE_RUN_LOCK/,
  'coverage must not use a staleable mkdir mutex for the run-wide lock'
);

function waitForPath(path: string, shouldExist: boolean): void {
  for (let attempt = 0; attempt < 100 && existsSync(path) !== shouldExist; attempt++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert.equal(existsSync(path), shouldExist, `Timed out waiting for ${path}`);
}

const portFixtureRoot = mkdtempSync(join(tmpdir(), 'coverage-port-reservation-'));
const occupiedPortFile = join(portFixtureRoot, 'occupied-port');
const listener = spawn(
  'python3',
  [
    '-c',
    [
      'import socket, sys, time',
      'sock = socket.socket()',
      'sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
      'for port in range(58000, 59000):',
      '    try:',
      "        sock.bind(('127.0.0.1', port))",
      '        break',
      '    except OSError:',
      '        continue',
      'sock.listen()',
      "with open(sys.argv[1], 'w', encoding='utf-8') as handle:",
      '    handle.write(str(sock.getsockname()[1]))',
      // Hold the port until the finally block kills the fixture; a fixed
      // lifetime freed it mid-test on a loaded host.
      'while True:',
      '    time.sleep(3600)',
    ].join('\n'),
    occupiedPortFile,
  ],
  { stdio: 'ignore' }
);
try {
  waitForPath(occupiedPortFile, true);
  let occupiedPort = 0;
  for (let attempt = 0; attempt < 100 && occupiedPort === 0; attempt++) {
    occupiedPort = Number(readFileSync(occupiedPortFile, 'utf8'));
    if (occupiedPort === 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert.ok(occupiedPort > 0, 'fixture listener must publish a port before selection');
  const lockRoot = join(portFixtureRoot, 'locks');
  const endPort = occupiedPort + 20;
  const selectedPort = Number(
    execFileSync('bash', ['scripts/run-coverage.sh', '--print-coverage-port'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BACKEND_COVERAGE_START_PORT: String(occupiedPort),
        BACKEND_COVERAGE_END_PORT: String(endPort),
        BACKEND_COVERAGE_PORT_LOCK_ROOT: lockRoot,
        BACKEND_COVERAGE_RUN_LOCK_DIR: join(portFixtureRoot, 'selection-run-lock'),
      },
    })
      .trim()
      .split('\n')
      .at(-1)
  );
  assert.ok(
    selectedPort > occupiedPort,
    `coverage selected occupied port ${occupiedPort} instead of advancing (${selectedPort})`
  );
  assert.ok(selectedPort <= endPort, 'coverage selected a port outside its owned range');
  const selectedAgain = Number(
    execFileSync('bash', ['scripts/run-coverage.sh', '--print-coverage-port'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BACKEND_COVERAGE_START_PORT: String(occupiedPort),
        BACKEND_COVERAGE_END_PORT: String(endPort),
        BACKEND_COVERAGE_PORT_LOCK_ROOT: lockRoot,
        BACKEND_COVERAGE_RUN_LOCK_DIR: join(portFixtureRoot, 'selection-run-lock'),
      },
    })
      .trim()
      .split('\n')
      .at(-1)
  );
  assert.equal(selectedAgain, selectedPort, 'print-only coverage must release its process lock');
} finally {
  listener.kill('SIGTERM');
  rmSync(portFixtureRoot, { recursive: true, force: true });
}
assert.match(
  coverageScript,
  /export AMPLITUDE_API_KEY=""[\s\S]*export AMPLITUDE_SECRET_KEY=""/,
  'coverage must isolate external analytics from deterministic instrumentation'
);
assert.match(
  adminHealthBlackbox,
  /ADMIN_HEALTH_LIVE_ONLY[\s\S]*await runPool\(\[strictLiveTests\[2\]\], 1\)/,
  'the focused live stage must retain the strict weekly endpoint assertion'
);
assert.match(
  coverageScript,
  /READINESS_STARTED_AT=\$SECONDS/,
  'coverage readiness must measure a wall-clock start time'
);
assert.match(
  coverageScript,
  /READINESS_DEADLINE=\$\(\(READINESS_STARTED_AT \+ 300\)\)/,
  'coverage readiness must use the five-minute deadline ceiling'
);
assert.match(
  coverageScript,
  /REMAINING_READINESS_SECONDS=\$\(\(READINESS_DEADLINE - SECONDS\)\)/,
  'coverage readiness must compute the actual time remaining'
);
assert.match(
  coverageScript,
  /curl -fsS -m "\$CURL_TIMEOUT_SECONDS"/,
  'coverage readiness must clip each health request to its remaining deadline'
);
assert.doesNotMatch(
  coverageScript,
  /for attempt in \$\(seq 1 600\)/,
  'coverage readiness must not use a fixed attempt-count timeout'
);
assert.match(
  coverageScript,
  /launch_coverage_process_group env[\s\S]*bash scripts\/run-blackbox-tests\.sh[\s\S]*launch_coverage_process_group env[\s\S]*node --import tsx scripts\/run-unit-tests\.ts/,
  'backend blackbox and isolated unit pools must overlap in dedicated process groups'
);
assert.match(
  coverageScript,
  /BLACKBOX_ADMIN_HEALTH_LIVE_AMPLITUDE_SLICES="\$\{BLACKBOX_ADMIN_HEALTH_LIVE_AMPLITUDE_SLICES:-weekly\}"/,
  'coverage must reserve the live Amplitude budget for the strict weekly assertion'
);
assert.match(
  blackboxScript,
  /BLACKBOX_TEST_CAPTURE_OUTBOUND="\$\{BLACKBOX_TEST_CAPTURE_OUTBOUND:-1\}"/,
  'blackbox runs must activate the configured live-slice filter by default'
);
assert.match(
  blackboxRunner,
  /const paymentDomain = domain === 'treasury-rails';[\s\S]*const command = paymentDomain \? 'python3' : process\.execPath;[\s\S]*: \['--import', 'tsx', file\];[\s\S]*spawn\(command, args/,
  'ordinary blackbox domains must avoid npm wrappers; only the treasury rail takes the Python lock'
);
assert.match(
  blackboxRunner,
  /AGENTCARD_LOCK_ACQUIRED[\s\S]*timeout = armTimeout\(timeoutMs, 'Domain'\)/,
  'treasury rail test timeout must begin after acquiring the sandbox payment lock'
);
assert.match(
  agentCardLockWrapper,
  /fcntl\.flock\(fd, fcntl\.LOCK_EX\)[\s\S]*AGENTCARD_LOCK_ACQUIRED[\s\S]*os\.set_inheritable\(fd, True\)[\s\S]*os\.execvp/,
  'the treasury rail must keep the benchmark lock through the test process'
);
assert.match(
  unitRunner,
  /spawn\(\s*process\.execPath,\s*\['--experimental-test-module-mocks', '--import', 'tsx', file\]/,
  'unit files must avoid npm and tsx wrapper processes under V8 coverage'
);
assert.match(
  unitRunner,
  /BACKEND_UNIT_CONCURRENCY/,
  'unit runner must expose its bounded process-pool size'
);
assert.match(
  unitRunner,
  /SERIAL_FIRST_FILES = new Set\(\['regex-safety\.test\.ts'\]\)/,
  'regex-safety must run isolated before the parallel unit pool so recheck is not starved'
);
assert.match(
  unitRunner,
  /if \(interrupted\) process\.exit\(130\);[\s\S]*const failures = results\.filter/,
  'unit runner must report interruption before killed children as failures'
);
assert.match(
  unitRunner,
  /fileLabel\.replace\(\/\\\.test\\\.ts\$\/, '\.log'\)[\s\S]*mkdir\(dirname\(logPath\)/,
  'unit logs must preserve nested paths instead of colliding on basenames'
);
assert.match(
  coverageScript,
  /BACKEND_UNIT_COVERAGE_DIR="\$COV_TMP"[\s\S]*node --import tsx scripts\/run-unit-tests\.ts/,
  'coverage must be passed to unit children without instrumenting the scheduler itself'
);
assert.match(
  unitRunner,
  /SERIAL_FIRST_FILES\.has\(basename\(file\)\)[\s\S]*delete childEnv\.NODE_V8_COVERAGE/,
  'serial-first analyzer files must omit inherited NODE_V8_COVERAGE so recheck stays inside the 1s budget'
);
assert.match(
  unitRunner,
  /else if \(coverageDir !== undefined\) \{\s*childEnv\.NODE_V8_COVERAGE = coverageDir/,
  'parallel unit children must retain V8 coverage instrumentation'
);
assert.ok(
  blackboxRunner.indexOf('runWithConcurrency(parallelDomains') <
    blackboxRunner.indexOf('runWithConcurrency(lateExclusiveDomains'),
  'aggregate blackbox domains must run after parallel fixture writers'
);
assert.match(
  blackboxRunner,
  /lateExclusiveDomainNames = new Set\(\[[\s\S]*'admin-health',[\s\S]*'benchmarks',[\s\S]*'benchmarks-hub',[\s\S]*'benchmarks-test-prompts',[\s\S]*\]\)/,
  'whole-database and mutable-catalog readers must be isolated from fixture writers'
);
assert.match(
  blackboxRunner,
  /lateExclusiveDomainNames = new Set\(\[[\s\S]*'code-preview',[\s\S]*'codex-code',[\s\S]*\]\)/,
  'the HMR latency domain must run uncontended, before the cooldown-setting codex-code domain'
);
assert.match(
  blackboxRunner,
  /domainWeights[\s\S]*\.sort\(/,
  'parallel blackbox domains must schedule measured long poles first'
);
// resolveAndSignal deliberately runs a raw interactive transaction rather than
// runTransactionWithRetry: it must take lockAgentWorkflowGeneration BEFORE the
// row mutation so a gate response and deploy cleanup acquire the same locks in
// the same order, and a retry wrapper would re-run that acquisition — the exact
// interleaving the ordering exists to prevent. (The raw transaction carries a
// documented entry in the interactive-transaction policy allowlist.) What must
// not regress is the ordering itself.
assert.match(
  gateResolutionProvider,
  /resolveAndSignal\([\s\S]*lockAgentWorkflowGeneration\(tx, request\.agentId\)[\s\S]*UPDATE "AgentAttentionRequest"/,
  'gate resolution must take the generation lock before mutating the attention row'
);
assert.match(
  blackboxRunner,
  /\['benchmarks-hub-pipeline', 90\]/,
  'deadline-sensitive Hub lifecycle must start in the first parallel wave'
);
assert.match(
  coverageScript,
  /export FAST_MODE_CACHE_DATABASE_URL="\$LOCAL_DB_URL"/,
  'coverage must isolate Fast Mode cache fixtures in the local test database'
);
assert.match(
  coverageScript,
  /BACKEND_TEST_DB_CONNECTION_LIMIT:-16[\s\S]*connection_limit=\$TEST_DB_CONNECTION_LIMIT&pool_timeout=30/,
  'parallel coverage children must use bounded Prisma pools'
);
assert.ok(
  coverageScript.indexOf('npx prisma db push --skip-generate --accept-data-loss') <
    coverageScript.indexOf('bash "$SCRIPT_DIR/apply-local-runtime-sql-hooks.sh"'),
  'coverage must install migration-owned database triggers after Prisma schema sync'
);
assert.match(
  localRuntimeSqlHooks,
  /pg_advisory_xact_lock\(hashtext\('rose-local-runtime-sql-hooks'\)\)[\s\S]*psql "\$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction/,
  'concurrent runners sharing one local database must apply the trigger hooks in one advisory-locked transaction'
);
assert.match(
  coverageScript,
  /DATABASE_URL="\$LOCAL_PSQL_URL" DIRECT_URL="\$LOCAL_PSQL_URL"[\s\\]+bash "\$SCRIPT_DIR\/apply-local-runtime-sql-hooks\.sh"/,
  'the psql-backed runtime hook installer must receive the plain libpq URL'
);
assert.match(
  blackboxScript,
  /EXPLICIT_TEST_PSQL_URL="\$\{EXPLICIT_TEST_DB_URL%%\\\?\*\}"[\s\S]*psql "\$EXPLICIT_TEST_PSQL_URL"/,
  'existing-backend reachability probes must strip Prisma-only URL parameters before invoking psql'
);
assert.ok(
  coverageScript.indexOf('bash "$SCRIPT_DIR/apply-local-runtime-sql-hooks.sh"') <
    coverageScript.indexOf('node --import tsx src/bootstrap.ts'),
  'coverage must install workflow cleanup triggers before backend and unit tests start'
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
      join(migrations, '20261026210001_tool_side_effect_operation_key_trgm', 'migration.sql'),
      'CREATE INDEX CONCURRENTLY tool_side_effect_trgm;\n'
    );
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
  /pg_advisory_xact_lock[\s\S]*CREATE TRIGGER workflow_guard;[\s\S]*SELECT utc_cleanup;[\s\S]*SELECT trajectory_search;[\s\S]*SELECT trajectory_agent;[\s\S]*CREATE INDEX tool_side_effect_trgm;/,
  'the advisory lock, the marked workflow block, the UTC cleanup, the trajectory search projection, its per-agent supersession and the non-concurrent trigram index must reach psql in order'
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
assert.doesNotMatch(
  coverageScript,
  /ENV_DATABASE_URL=.*DATABASE_URL/,
  'coverage must not derive its Fast Mode cache database from the production .env'
);
assert.match(
  coverageScript,
  /export AMPLITUDE_API_KEY=""\s+export AMPLITUDE_SECRET_KEY=""/,
  'coverage must not consume the live Amplitude chart-query budget'
);

process.stdout.write('coverage script contracts passed\n');
