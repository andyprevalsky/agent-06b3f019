import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const coverageScript = readFileSync(join(process.cwd(), 'scripts', 'run-coverage.sh'), 'utf8');
const blackboxScript = readFileSync(
  join(process.cwd(), 'scripts', 'run-blackbox-tests.sh'),
  'utf8'
);
const codexBlackbox = readFileSync(
  join(process.cwd(), 'src', 'tests', 'blackbox', 'codex-code.blackbox.ts'), // pragma: allowlist secret
  'utf8'
);

for (const [name, harness] of [
  ['coverage', coverageScript],
  ['blackbox', blackboxScript],
] as const) {
  assert.match(
    harness,
    /TRACE_ARCHIVE_BACKEND='\$\{TRACE_ARCHIVE_BACKEND:-\}' is not a local blackbox backend; forcing local/,
    `${name} harness must force local archives when Cloud injects TRACE_ARCHIVE_BACKEND=r2`
  );
  assert.doesNotMatch(
    harness,
    /TRACE_ARCHIVE_BACKEND="\$\{TRACE_ARCHIVE_BACKEND:-local\}"/,
    `${name} harness must not keep an injected R2 backend via \${TRACE_ARCHIVE_BACKEND:-local}`
  );
  assert.match(
    harness,
    /BACKEND_CODEX_TOKEN_SYNC_SKIP/,
    `${name} harness must support preserving pre-seeded Codex credentials`
  );
  assert.doesNotMatch(
    harness,
    /if \[\[ "\$\{BACKEND_CODEX_SMOKE_SKIP:-0\}" != "1" \]\]; then\s+echo "Syncing local Codex credentials/,
    `${name} harness must not couple credential sync to live-smoke execution`
  );
  assert.match(
    harness,
    /CODEX_AUTH_MODE=.*auth_mode/,
    `${name} harness must inspect the local Codex auth mode before importing it`
  );
  assert.match(
    harness,
    /SEEDED_CODEX_COUNT=.*Integration.*gpt_code/s,
    `${name} harness must preserve a connected isolated gpt_code credential when local auth is incompatible`
  );

  const prepSql = /<<'SQL'\n([\s\S]*?)\nSQL\n/.exec(harness)?.[1] ?? '';
  const scrub =
    /DELETE FROM "Integration"\s+WHERE "userId" = '00000000-0000-0000-0000-000000000000'\s+AND name IN \('gpt_api_key_cooldown', 'anthropic_api_key_cooldown', 'codex_funded_cooldown'\);/;
  assert.match(
    prepSql,
    scrub,
    `${name} harness must clear funded-key cooldowns a local stack persisted in the shared test database`
  );
  assert.ok(
    harness.indexOf(prepSql) < harness.indexOf('Syncing Prisma schema to local test database'),
    `${name} harness must clear funded-key cooldowns before any test starts`
  );
}

assert.match(
  blackboxScript,
  /FAST_MODE_ANTHROPIC_PROXY_URL="\$\{BLACKBOX_FAST_MODE_ANTHROPIC_PROXY_URL:-\}"/,
  'isolated blackbox backend must not inherit a developer Fast Mode Anthropic tunnel'
);
assert.ok(
  !blackboxScript.includes('FAST_MODE_CODEX_PROXY_URL='),
  'Codex never routes through a Rose proxy (S30): no Codex tunnel to export'
);

const codexSmokeIndex = codexBlackbox.indexOf('fn: testSmoke_codexCompletesE2bTask');
assert.ok(codexSmokeIndex >= 0, 'Codex blackbox must register the real E2B smoke');
for (const coolingCase of [
  'fn: testPersistOutput_coolsExhaustedOAuthCredential',
  'fn: testPersistOutput_coolsBothCredentialsAfterFailedFallback',
]) {
  const coolingIndex = codexBlackbox.indexOf(coolingCase);
  assert.ok(coolingIndex >= 0, `Codex blackbox must register ${coolingCase}`);
  assert.ok(
    codexSmokeIndex < coolingIndex,
    `Codex real E2B smoke must run before ${coolingCase}: the backend caches the funded-key cooldown in-process, so the smoke would see no usable credential`
  );
}

process.stdout.write('coverage script part 2 contracts passed\n');

// Exercise the actual isolated-backend launch/trap boundary without DB or providers.
execFileSync(
  'python3',
  [
    join(process.cwd(), '..', 'scripts', 'tests', 'blackbox-process-cleanup.test.py'),
    join(process.cwd(), '..'),
    join(process.cwd(), 'scripts', 'run-blackbox-tests.sh'),
  ],
  { stdio: 'inherit', timeout: 60_000 }
);
