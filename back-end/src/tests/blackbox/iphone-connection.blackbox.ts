#!/usr/bin/env tsx
import { authLossCases } from './iphone-control.auth-loss.cases';
/** Normal registered connection + portrait owning boundary; external phone/launch are synthetic. */
import assert from 'node:assert/strict';
import { prisma } from '../../providers/database';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';
import { Harness } from './iphone-control.fixtures';
import { connectionCases } from './iphone-control.connection.cases';
import { portraitCases } from './iphone-control.portrait.cases';

async function main() {
  assert.equal(
    nonLocalDatabaseReason(process.env.DATABASE_URL),
    null,
    'Explicit local fixture DB required'
  );
  assert.equal(
    nonLocalDatabaseReason(process.env.DIRECT_URL),
    null,
    'Explicit local direct DB required'
  );
  let passed = 0;
  let failed = 0;
  let h: Harness | undefined;
  try {
    h = await Harness.start();
    for (const [name, run] of [...connectionCases, ...authLossCases, ...portraitCases]) {
      h.resetControls();
      const errors = h.fixtureErrors.length;
      try {
        await run(h);
        assert.equal(h.fixtureErrors.length, errors, 'Synthetic provider wire contract changed');
        console.log(`PASS ${name}`);
        passed++;
      } catch (error) {
        console.error(
          `FAIL ${name}: ${error instanceof Error ? error.message : 'Assertion failed'}`
        );
        failed++;
      }
    }
  } finally {
    await h?.close();
    await prisma.$disconnect();
  }
  console.log(`Passed ${passed}/${passed + failed} iphone-connection test(s).`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Connection suite failed');
  process.exitCode = 1;
});
