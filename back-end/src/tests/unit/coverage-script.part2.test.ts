import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const coverageScript = readFileSync(join(process.cwd(), 'scripts', 'run-coverage.sh'), 'utf8');
const blackboxScript = readFileSync(
  join(process.cwd(), 'scripts', 'run-blackbox-tests.sh'),
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

process.stdout.write('coverage script part 2 contracts passed\n');
