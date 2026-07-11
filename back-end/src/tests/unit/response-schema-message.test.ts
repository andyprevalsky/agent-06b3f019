#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { buildUserMessageSignalValue } from '../../domains/agents/agentMessageService';
import { createMessage } from '../../providers/messages';
import { prisma } from '../../providers/database';

async function main(): Promise<void> {
  const agentId = randomUUID();
  const idempotencyKey = randomUUID();
  const metadata = {
    hidden: true,
    isResponseSchemaUpdate: true,
    responseSchemaRevision: 1,
    idempotencyKey,
  };

  await prisma.agent.create({
    data: {
      id: agentId,
      userId: `unit-user-${agentId}`,
      goal: 'response schema message test',
      status: 'ACTIVE',
      busId: agentId,
    },
  });

  try {
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () =>
        createMessage({
          agentId,
          text: 'schema update',
          role: 'USER',
          metadata,
        })
      )
    );
    const first = attempts[0];

    assert.ok(attempts.every((message) => message.id === first.id));
    assert.match(first.id, /^[a-f0-9-]{36}$/);
    assert.strictEqual(
      await prisma.message.count({ where: { agentId, id: first.id } }),
      1,
      'activity retries must not duplicate the hidden USER message'
    );

    assert.deepStrictEqual(JSON.parse(buildUserMessageSignalValue('schema update', metadata)), {
      internal_type: 'response_schema_update',
      idempotency_key: idempotencyKey,
    });
    assert.strictEqual(
      buildUserMessageSignalValue('ordinary feedback', undefined),
      'ordinary feedback'
    );
  } finally {
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.$disconnect();
  }

  process.stdout.write('1/1 response schema message tests passed\n');
}

main().catch(async (err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  await prisma.$disconnect();
  process.exit(1);
});
