import assert from 'node:assert/strict';
import { mock } from 'node:test';

async function main() {
  let checks = 0;
  await mock.module('../../providers/cliTemplateReferences', {
    namedExports: {
      isCliTemplateSession: async () => {
        checks += 1;
        return true;
      },
    },
  });
  const { retireCodeSession } = await import('../../providers/codeSessions/lifecycle');
  const template = {
    id: 'protected-template',
    userId: 'owner',
    sandboxKind: 'e2b',
    sandboxId: 'must-not-contact-provider',
  };
  // The guard must reject before any provider call, checkpoint deletion or DB mutation.
  await assert.rejects(
    retireCodeSession(template as Parameters<typeof retireCodeSession>[0]),
    /Disconnect the CLI integration/
  );
  assert.equal(checks, 1);
  process.stdout.write(
    'Published CLI template retirement guard passed without contacting sandbox or storage\n'
  );
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
