import assert from 'node:assert/strict';

import { sendSms } from '../../providers/smsQueue';

async function run() {
  const oldFakeSurge = process.env.BLACKBOX_TEST_FAKE_SURGE;
  process.env.BLACKBOX_TEST_FAKE_SURGE = '1';
  process.env.SURGE_API_KEY = process.env.SURGE_API_KEY || 'blackbox-surge-key';
  process.env.SURGE_ACCOUNT_ID = process.env.SURGE_ACCOUNT_ID || 'blackbox-surge-account';

  const result = await sendSms('+19729777432', 'benchmark mock smoke test', {
    archiveRootAgentId: '00000000-0000-4000-8000-000000000001',
    archiveContext: { source: 'unit-test' },
  });

  assert.equal(result.success, true);
  assert.match(result.messageSid ?? '', /^msg_01[0-9a-f]{26}$/);

  if (oldFakeSurge === undefined) delete process.env.BLACKBOX_TEST_FAKE_SURGE;
  else process.env.BLACKBOX_TEST_FAKE_SURGE = oldFakeSurge;

  process.stdout.write('sms-queue-benchmark-mock: 1 passed, 0 failed\n');
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
