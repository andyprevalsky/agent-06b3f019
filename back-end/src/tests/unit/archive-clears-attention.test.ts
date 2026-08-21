#!/usr/bin/env tsx
/**
 * Soft-delete / archive must clear AgentAttentionRequest rows.
 *
 * UI archive already did this via agentLifecycleService.deleteAgentRecursive.
 * SMS kill (/clear + kill_agent) historically only set deletedAt and left inbox
 * orphans — these tests cement both paths wipe attention for the deleted tree.
 *
 * Run: DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria \
 *      npx tsx src/tests/unit/archive-clears-attention.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';

config();

import { prisma } from '../../providers/database';
import { softDeleteAgentAndChildren } from '../../domains/sms-webhook/repo';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.log(`  FAIL ${name} - ${message}`);
  }
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `missing export async function ${name}`);
  let depth = 0;
  let started = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      depth += 1;
      started = true;
    } else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

async function main(): Promise<void> {
  await test('UI + SMS deleteAgentRecursive both wipe attention requests', () => {
    const lifecycle = readFileSync(
      join(process.cwd(), 'src', 'domains', 'agents', 'agentLifecycleService.ts'),
      'utf8'
    );
    const smsHelper = readFileSync(
      join(process.cwd(), 'src', 'providers', 'smsSupervisor', 'supervisorTools.helpers.ts'),
      'utf8'
    );
    const uiDelete = extractFunction(lifecycle, 'deleteAgentRecursive');
    const smsDelete = extractFunction(smsHelper, 'deleteAgentRecursive');
    assert.match(uiDelete, /deleteAttentionRequests/);
    assert.match(smsDelete, /agentAttentionRequest\.deleteMany/);
  });

  await test('sms /clear softDeleteAgentAndChildren deletes attention in the same CTE', () => {
    const repo = readFileSync(
      join(process.cwd(), 'src', 'domains', 'sms-webhook', 'repo.ts'),
      'utf8'
    );
    const fn = extractFunction(repo, 'softDeleteAgentAndChildren');
    assert.match(fn, /DELETE FROM "AgentAttentionRequest"/);
    assert.match(fn, /deleted_agents/);
  });

  await test('softDeleteAgentAndChildren removes attention for parent + child', async () => {
    const userId = `archive-attn-${randomUUID()}`;
    const parentId = randomUUID();
    const childId = randomUUID();

    await prisma.user.create({
      data: { userId, phone: `+1555${String(Date.now()).slice(-7)}` },
    });
    await prisma.agent.create({
      data: {
        id: parentId,
        userId,
        goal: 'parent archive attention',
        status: 'ACTIVE',
        busId: parentId,
        verifier: { create: {} },
      },
    });
    await prisma.agent.create({
      data: {
        id: childId,
        userId,
        parentAgentId: parentId,
        goal: 'child archive attention',
        status: 'ACTIVE',
        busId: parentId,
        verifier: { create: {} },
      },
    });
    await prisma.agentAttentionRequest.createMany({
      data: [
        {
          userId,
          agentId: parentId,
          workflowId: `wf-parent-${parentId}`,
          question: 'parent?',
        },
        {
          userId,
          agentId: childId,
          workflowId: `wf-child-${childId}`,
          question: 'child?',
        },
      ],
    });

    try {
      const before = await prisma.agentAttentionRequest.count({
        where: { agentId: { in: [parentId, childId] } },
      });
      assert.equal(before, 2);

      await softDeleteAgentAndChildren(parentId);

      const after = await prisma.agentAttentionRequest.count({
        where: { agentId: { in: [parentId, childId] } },
      });
      assert.equal(after, 0, 'attention rows for the archived tree must be gone');

      const archived = await prisma.agent.findMany({
        where: { id: { in: [parentId, childId] } },
        select: { id: true, deletedAt: true },
      });
      assert.equal(archived.length, 2);
      assert.ok(archived.every((row) => row.deletedAt !== null));
    } finally {
      await prisma.agentAttentionRequest.deleteMany({
        where: { agentId: { in: [parentId, childId] } },
      });
      await prisma.agent.deleteMany({ where: { id: { in: [parentId, childId] } } });
      await prisma.user.deleteMany({ where: { userId } });
    }
  });

  console.log(`\nResults: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
