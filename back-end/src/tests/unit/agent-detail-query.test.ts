#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { getAgentDetailForPreview } from '../../providers/agentDetailQuery';

const userIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `preview-query-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  userIds.push(userId);
  return userId;
}

async function createAgent(
  userId: string,
  data: {
    goal?: string;
    status?: 'ACTIVE' | 'FAILED';
    parentAgentId?: string;
    structuredResponse?: object | null;
    withVerifier?: boolean;
  } = {}
): Promise<string> {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId,
      goal: data.goal ?? `preview ${id}`,
      status: data.status ?? 'ACTIVE',
      busId: id,
      parentAgentId: data.parentAgentId,
      structuredResponse: data.structuredResponse ?? undefined,
      ...(data.withVerifier === true ? { verifier: { create: {} } } : {}),
    },
  });
  return id;
}

async function testMissingAgent(): Promise<void> {
  const detail = await getAgentDetailForPreview(randomUUID());
  assert.equal(detail, null);
}

async function testRootAgentWithUsageAndMessages(): Promise<void> {
  const userId = await seedUser();
  const agentId = await createAgent(userId, { withVerifier: true });
  await prisma.message.create({
    data: { agentId, text: 'hello preview', role: 'USER' },
  });
  await prisma.toolUsage.create({
    data: {
      agentId,
      userId,
      toolName: 'web_search',
      totalCostCents: 7,
      usageItems: [
        { type: 'llm', number_of_tokens: 11, provider: 'OpenRouter' },
        { type: 'llm', number_of_tokens: 3, provider: 'OpenRouter Output' },
        { type: 'other', number_of_tokens: 99 },
      ],
    },
  });
  await prisma.toolUsage.create({
    data: {
      agentId,
      userId,
      toolName: 'notes',
      totalCostCents: 1,
      usageItems: { not: 'an-array' },
    },
  });
  const tool = await prisma.tool.upsert({
    where: { name: 'preview-query-web-search' },
    update: {},
    create: { name: 'preview-query-web-search', description: 'search the web' },
  });
  await prisma.agentTool.create({
    data: { agentId, toolId: tool.id },
  });

  const detail = await getAgentDetailForPreview(agentId);
  assert.ok(detail);
  assert.equal(detail.agent.agent_id, agentId);
  assert.equal(detail.agent.parent_goal, null);
  assert.equal(detail.agent.tool_tokens_in, 11);
  assert.equal(detail.agent.tool_tokens_out, 3);
  assert.equal(detail.agent.tool_cost_cents, 8);
  assert.equal(detail.agent.tools.length, 1);
  assert.equal(detail.agent.tools[0].name, 'preview-query-web-search');
  assert.equal(detail.agent.verifier?.type, 'FLOAT_LLM_JUDGE');
  assert.equal(detail.agent.failure_context, null);
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0].text, 'hello preview');
  assert.equal(detail.pagination.has_more, false);
}

async function testSubAgentParentGoalAndFailedStructured(): Promise<void> {
  const userId = await seedUser();
  const parentId = await createAgent(userId, { goal: 'parent goal text' });
  const childId = await createAgent(userId, {
    parentAgentId: parentId,
    status: 'FAILED',
    structuredResponse: { answer: 42 },
  });

  const detail = await getAgentDetailForPreview(childId);
  assert.ok(detail);
  assert.equal(detail.agent.parent_agent_id, parentId);
  assert.equal(detail.agent.parent_goal, 'parent goal text');
  assert.equal(detail.agent.verifier, null);
  assert.deepEqual(detail.agent.failure_context, {
    partial_structured_response: { answer: 42 },
  });
}

async function main(): Promise<void> {
  try {
    await testMissingAgent();
    await testRootAgentWithUsageAndMessages();
    await testSubAgentParentGoalAndFailedStructured();
    process.stdout.write('agent-detail-query unit tests passed\n');
  } finally {
    await prisma.agent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
