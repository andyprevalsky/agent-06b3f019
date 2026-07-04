#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { resumeAgentWorkflow } from '../../providers/agentResume';
import { prisma } from '../../providers/database';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

async function createAgent(overrides: { temporalWorkflowId?: string | null }) {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId: `unit-user-${id}`,
      goal: 'unit resume test',
      status: 'PAUSED',
      busId: id,
      temporalWorkflowId: overrides.temporalWorkflowId,
    },
  });
  return id;
}

async function withoutTemporalEnv(fn: () => Promise<void>): Promise<void> {
  const previousNamespace = process.env.TEMPORAL_NAMESPACE;
  const previousApiKey = process.env.TEMPORAL_API_KEY;
  delete process.env.TEMPORAL_NAMESPACE;
  delete process.env.TEMPORAL_API_KEY;
  try {
    await fn();
  } finally {
    if (previousNamespace === undefined) delete process.env.TEMPORAL_NAMESPACE;
    else process.env.TEMPORAL_NAMESPACE = previousNamespace;
    if (previousApiKey === undefined) delete process.env.TEMPORAL_API_KEY;
    else process.env.TEMPORAL_API_KEY = previousApiKey;
  }
}

async function main(): Promise<void> {
  await test('resumeAgentWorkflow marks ACTIVE when no workflow signal is required', async () => {
    const agentId = await createAgent({ temporalWorkflowId: null });
    try {
      const result = await resumeAgentWorkflow(agentId);
      assert.deepStrictEqual(result, { success: true });
      const agent = await prisma.agent.findUnique({ where: { id: agentId } });
      assert.strictEqual(agent?.status, 'ACTIVE');
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('resumeAgentWorkflow leaves DB PAUSED when workflow signal fails', async () => {
    const agentId = await createAgent({ temporalWorkflowId: `wf-${randomUUID()}` });
    try {
      await withoutTemporalEnv(async () => {
        const result = await resumeAgentWorkflow(agentId);
        assert.deepStrictEqual(result, {
          error: 'Cannot resume agent because its workflow is not running',
          status: 409,
        });
      });
      const agent = await prisma.agent.findUnique({ where: { id: agentId } });
      assert.strictEqual(agent?.status, 'PAUSED');
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  if (failures.length > 0) {
    console.error('\nFailures:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`\n${passed}/2 agent resume tests passed`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
