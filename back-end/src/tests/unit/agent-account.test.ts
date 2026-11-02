/** Isolated module mocking stays in the owned subprocess, never the shared unit runner. */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
execFileSync(
  process.execPath,
  ['--import', 'tsx', join(__dirname, '../../../scripts/fixtures/agent-account.fixture.cjs')],
  { stdio: 'inherit', timeout: 60_000 }
);
