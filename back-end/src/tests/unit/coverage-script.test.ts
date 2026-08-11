import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  'STRIPE_SECRET_KEY',
]) {
  assert.match(
    autoRcaEnv,
    new RegExp(`export ${variable}=`),
    `shared auto-RCA environment is missing ${variable}`
  );
}
assert.match(
  autoRcaEnv,
  /BLACKBOX_TEST_CAPTURE_OUTBOUND[\s\S]*BLACKBOX_TEST_REPLAY_OUTBOUND/,
  'shared auto-RCA fixtures must fail closed outside capture/replay mode'
);

assert.match(
  coverageScript,
  /lsof -tiTCP:"\$candidate" -sTCP:LISTEN/,
  'coverage port preflight must ignore outbound connections using the same local port'
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
      'time.sleep(30)',
    ].join('\n'),
    occupiedPortFile,
  ],
  { stdio: 'ignore' }
);
try {
  waitForPath(occupiedPortFile, true);
  const occupiedPort = Number(readFileSync(occupiedPortFile, 'utf8'));
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
  /spawn\(process\.execPath, \['--import', 'tsx', file\]/,
  'blackbox domains must avoid npm and tsx wrapper processes under V8 coverage'
);
assert.match(
  unitRunner,
  /spawn\(process\.execPath, \['--import', 'tsx', file\]/,
  'unit files must avoid npm and tsx wrapper processes under V8 coverage'
);
assert.match(
  unitRunner,
  /BACKEND_UNIT_CONCURRENCY/,
  'unit runner must expose its bounded process-pool size'
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
  /NODE_V8_COVERAGE: coverageDir/,
  'every isolated unit child must retain V8 coverage instrumentation'
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
  /BACKEND_TEST_DB_CONNECTION_LIMIT:-4[\s\S]*connection_limit=\$TEST_DB_CONNECTION_LIMIT&pool_timeout=30/,
  'parallel coverage children must use bounded Prisma pools'
);
assert.ok(
  coverageScript.indexOf('npx prisma db push --skip-generate --accept-data-loss') <
    coverageScript.indexOf('bash "$SCRIPT_DIR/apply-local-runtime-sql-hooks.sh"'),
  'coverage must install migration-owned database triggers after Prisma schema sync'
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
