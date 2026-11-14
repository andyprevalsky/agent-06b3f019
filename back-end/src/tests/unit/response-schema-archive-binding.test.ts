#!/usr/bin/env tsx
/**
 * Schema-generation LLM calls bind to the agent they are generated for, never
 * into another user's bundle (POST /api/agents/generate-response-schema).
 *
 *   own agent (or internal caller) ─► that tree's root (busId ?? id)
 *   unknown / pre-allocated / foreign id ─► caller's user-<userId> root + requested_agent_id link
 *   no agent id ─► caller's user-<userId> root
 */
import { getEphemeral } from '../../providers/sharedState';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { schemaArchiveBinding } from '../../domains/agents/agentMessageLookupService';

async function main(): Promise<void> {
  const owner = `schema-owner-${randomUUID()}`;
  const other = `schema-other-${randomUUID()}`;
  const root = randomUUID();
  const child = randomUUID();
  await prisma.user.createMany({ data: [{ userId: owner }, { userId: other }] });
  try {
    await prisma.agent.create({ data: { id: root, userId: owner, goal: 'root', busId: root } });
    await prisma.agent.create({
      data: { id: child, userId: owner, goal: 'child', parentAgentId: root, busId: root },
    });
    assert.deepEqual(await schemaArchiveBinding({ agentId: child, userId: owner }), {
      agent_id: child,
      root_agent_id: root,
    });
    assert.deepEqual(await schemaArchiveBinding({ agentId: child, isInternal: true }), {
      agent_id: child,
      root_agent_id: root,
    });
    const foreign = await schemaArchiveBinding({ agentId: child, userId: other });
    assert.deepEqual(
      { ...foreign, on_record: undefined },
      {
        agent_id: `user-${other}`,
        root_agent_id: `user-${other}`,
        extra: { requested_agent_id: child },
        on_record: undefined,
      }
    );
    const preAllocated = randomUUID();
    const preBinding = await schemaArchiveBinding({ agentId: preAllocated, userId: owner });
    assert.deepEqual(
      { ...preBinding, on_record: undefined },
      {
        agent_id: `user-${owner}`,
        root_agent_id: `user-${owner}`,
        extra: { requested_agent_id: preAllocated },
        on_record: undefined,
      }
    );
    // Each stored record is linked to (owner, preAllocated) for the creation-time copy.
    await preBinding?.on_record?.('llm/pre-allocated.json.gz.enc');
    await preBinding?.on_record?.('llm/pre-allocated.json.gz.enc');
    assert.deepEqual(
      await getEphemeral('schema-generation-archive-links', `${owner}:${preAllocated}`),
      { paths: ['llm/pre-allocated.json.gz.enc'] }
    );
    assert.deepEqual(await schemaArchiveBinding({ userId: owner }), {
      agent_id: `user-${owner}`,
      root_agent_id: `user-${owner}`,
    });
    process.stdout.write('response-schema-archive-binding: all checks passed\n');
  } finally {
    await prisma.agent.deleteMany({ where: { id: { in: [child, root] } } });
    await prisma.user.deleteMany({ where: { userId: { in: [owner, other] } } });
    await prisma.sharedEphemeralState.deleteMany({
      where: { namespace: 'schema-generation-archive-links', key: { startsWith: owner } },
    });
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
