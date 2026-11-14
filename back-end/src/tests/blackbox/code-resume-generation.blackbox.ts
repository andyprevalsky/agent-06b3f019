#!/usr/bin/env tsx
/**
 * Black-box: writes from a CodeAgentResumeWorkflow (a stopped code agent the
 * person resumed, agents/workflows/code_agent_resume.py) are accepted on the
 * owner's rows. Its activities stamp X-Agent-Workflow-Generation with
 * `code-resume:<agentId>:<turn row id>`, never the owner's temporalWorkflowId.
 *
 * The worker message route attributes the write with workerWriteGeneration and
 * stores it through postMessage (the same calls routes.messages.ts makes):
 *   - bound to this agent, owner live → stored under the owner's live
 *     generation, never "Tool interrupted by deployment" and never a 409
 *   - bound to this agent, owner finished (no workflow) → stored
 *   - bound to ANOTHER agent → still fenced as a stale worker's write
 *
 * Real Postgres (the runner's isolated database); nothing is mocked.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { prisma } from '../../providers/database';
import { workerWriteGeneration } from '../../providers/codeResumeGeneration';
import { postMessage } from '../../domains/agents/agentMessageService';

const created: { users: string[]; agents: string[] } = { users: [], agents: [] };

async function seedAgent(temporalWorkflowId: string | null): Promise<string> {
  const userId = randomUUID();
  const agentId = randomUUID();
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: 'Remove the rose border',
      status: temporalWorkflowId === null ? 'COMPLETED' : 'ACTIVE',
      temporalWorkflowId,
      verifier: { create: {} },
    },
  });
  created.users.push(userId);
  created.agents.push(agentId);
  return agentId;
}

function codeRow(toolCallId: string, status: 'IN_PROGRESS' | 'FINISHED') {
  return {
    role: 'TOOL',
    message: status === 'FINISHED' ? 'Changelog updated.' : 'Claude Code Started',
    metadata: {
      toolName: 'spawn_claude_code_agent',
      toolCallId,
      toolStatus: status,
      title: status === 'FINISHED' ? '✓ Task Completed' : 'Claude Code Started',
      excludeFromModel: true,
      codeAgentResume: 'supervised',
    },
  };
}

async function postAsResume(
  agentId: string,
  header: string,
  toolCallId: string,
  status: 'IN_PROGRESS' | 'FINISHED'
) {
  return postMessage(
    agentId,
    codeRow(toolCallId, status) as never,
    true,
    undefined,
    await workerWriteGeneration(agentId, header)
  );
}

after(async () => {
  await prisma.message.deleteMany({ where: { agentId: { in: created.agents } } });
  await prisma.verifier.deleteMany({ where: { agent: { id: { in: created.agents } } } });
  await prisma.agent.deleteMany({ where: { id: { in: created.agents } } });
  await prisma.user.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.$disconnect();
});

test('a resume workflow write joins the live owner generation (never fenced)', async () => {
  const agentId = await seedAgent('wf-owner-live');
  const header = `code-resume:${agentId}:row-1`;
  assert.equal(await workerWriteGeneration(agentId, header), 'wf-owner-live');
  const started = await postAsResume(agentId, header, 'tc-resume', 'IN_PROGRESS');
  assert.ok(!('error' in started), JSON.stringify(started));
  const done = await postAsResume(agentId, header, 'tc-resume', 'FINISHED');
  assert.ok(!('error' in done), JSON.stringify(done));
  const rows = await prisma.message.findMany({ where: { agentId }, orderBy: { timestamp: 'asc' } });
  assert.ok(rows.length >= 1, 'rows stored');
  for (const row of rows) {
    const metadata = row.metadata as Record<string, unknown>;
    assert.equal(metadata.workflowGeneration, 'wf-owner-live');
    assert.notEqual(metadata.title, 'Tool interrupted by deployment', JSON.stringify(metadata));
    assert.ok(!String(row.text).includes('new code version deployed'), row.text);
  }
  assert.ok(
    rows.some((row) => (row.metadata as Record<string, unknown>).toolStatus === 'FINISHED')
  );
});

test('a resume workflow write is stored when the owner finished', async () => {
  const agentId = await seedAgent(null);
  const result = await postAsResume(agentId, `code-resume:${agentId}:row-2`, 'tc-done', 'FINISHED');
  assert.ok(!('error' in result), JSON.stringify(result));
});

test("another agent's resume generation is still a stale worker write", async () => {
  const agentId = await seedAgent('wf-owner-live-2');
  const other = randomUUID();
  const header = `code-resume:${other}:row-3`;
  assert.equal(await workerWriteGeneration(agentId, header), header, 'not rebound to this agent');
  const result = await postAsResume(agentId, header, 'tc-foreign', 'IN_PROGRESS');
  assert.ok(!('error' in result) || result.status === 409, JSON.stringify(result));
  const rows = await prisma.message.findMany({ where: { agentId } });
  const fenced =
    'error' in result ||
    rows.every((row) => {
      const metadata = row.metadata as Record<string, unknown>;
      return metadata.toolStatus === 'ERROR' || metadata.workflowGeneration !== header;
    });
  assert.ok(fenced, `a foreign generation must not write live rows: ${JSON.stringify(rows)}`);
  assert.ok(
    !rows.some(
      (row) =>
        (row.metadata as Record<string, unknown>).toolStatus === 'IN_PROGRESS' &&
        (row.metadata as Record<string, unknown>).workflowGeneration === 'wf-owner-live-2'
    ),
    'never attributed to the live owner'
  );
});
