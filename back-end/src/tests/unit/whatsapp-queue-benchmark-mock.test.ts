import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { prisma } from '../../providers/database';
import { sendWhatsAppMessage } from '../../providers/whatsappCloud';

async function run() {
  const runId = randomUUID();
  const agentId = randomUUID();
  await prisma.agent.create({
    data: {
      id: agentId,
      userId: runId,
      goal: 'benchmark whatsapp transport mock unit test',
      status: 'ACTIVE',
      busId: agentId,
      isBenchmark: true,
      verifier: { create: {} },
    },
  });

  try {
    const result = await sendWhatsAppMessage('+19729777432', 'benchmark whatsapp mock smoke test', {
      archiveRootAgentId: agentId,
      archiveContext: { source: 'unit-test' },
    });

    assert.equal(result.success, true);
    assert.match(result.messageSid ?? '', /^wamid\.[0-9a-f]{16}$/);
  } finally {
    await prisma.agent.deleteMany({ where: { userId: runId } });
  }

  process.stdout.write('whatsapp-queue-benchmark-mock: 1 passed, 0 failed\n');
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
