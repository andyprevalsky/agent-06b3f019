/** Real local database integration, with external workflow execution disabled. */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
execFileSync(
  process.execPath,
  [
    '--import',
    'tsx',
    join(__dirname, '../../../scripts/fixtures/agent-account-postgres.fixture.cjs'),
  ],
  { stdio: 'inherit', timeout: 180_000 }
);
