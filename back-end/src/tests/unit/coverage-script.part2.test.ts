import assert from 'node:assert/strict';
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
}

// Blackbox suites write and assert local archive artifacts. Cloud VMs inject the prod
// TRACE_ARCHIVE_BACKEND=r2, which `${TRACE_ARCHIVE_BACKEND:-local}` would hand to the isolated backend.
for (const [name, harness] of [
  ['coverage', coverageScript],
  ['blackbox', blackboxScript],
] as const) {
  assert.match(
    harness,
    /export TRACE_ARCHIVE_BACKEND="\$\{BLACKBOX_TRACE_ARCHIVE_BACKEND:-local\}"/,
    `${name} harness must not inherit an injected archive backend`
  );
}

assert.match(
  blackboxScript,
  /FAST_MODE_ANTHROPIC_PROXY_URL="\$\{BLACKBOX_FAST_MODE_ANTHROPIC_PROXY_URL:-\}"/,
  'isolated blackbox backend must not inherit a developer Fast Mode Anthropic tunnel'
);
assert.match(
  blackboxScript,
  /FAST_MODE_CODEX_PROXY_URL="\$\{BLACKBOX_FAST_MODE_CODEX_PROXY_URL:-\}"/,
  'isolated blackbox backend must not inherit a developer Fast Mode Codex tunnel'
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
