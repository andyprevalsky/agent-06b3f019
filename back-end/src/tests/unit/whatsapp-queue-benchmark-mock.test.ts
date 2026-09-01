import assert from 'node:assert/strict';

import { sendWhatsAppMessage } from '../../providers/whatsappCloud';

async function run() {
  const oldFakeWhatsApp = process.env.BLACKBOX_TEST_FAKE_WHATSAPP;
  process.env.BLACKBOX_TEST_FAKE_WHATSAPP = '1';

  const result = await sendWhatsAppMessage('+19729777432', 'benchmark whatsapp mock smoke test', {
    archiveRootAgentId: '00000000-0000-4000-8000-000000000002',
    archiveContext: { source: 'unit-test' },
  });

  assert.equal(result.success, true);
  assert.match(result.messageSid ?? '', /^wamid\.[0-9a-f]{16}$/);

  if (oldFakeWhatsApp === undefined) delete process.env.BLACKBOX_TEST_FAKE_WHATSAPP;
  else process.env.BLACKBOX_TEST_FAKE_WHATSAPP = oldFakeWhatsApp;

  console.log('whatsapp-queue-benchmark-mock: 1 passed, 0 failed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
