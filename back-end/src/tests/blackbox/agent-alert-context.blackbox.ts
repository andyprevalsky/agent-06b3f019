#!/usr/bin/env tsx
/** Black-box contract for the internal agent alert-context endpoint. */

import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { z } from 'zod';
import { prisma } from '../../providers/database';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';

const AlertContextResponse = z.object({
  agent_id: z.string().uuid(),
  affected_user_name: z.string().nullable(),
  current_agent_status: z.string(),
});

async function request(agentId: string, authenticated = true) {
  const response = await fetch(`${BASE_URL}/api/agents/${agentId}/alert-context`, {
    headers: authenticated ? { 'X-API-Key': API_KEY } : undefined,
  });
  const data = (await response.json()) as unknown;
  return { status: response.status, data };
}

async function main(): Promise<void> {
  const userId = `alert-context-${randomUUID()}`;
  const agentId = randomUUID();

  await prisma.user.create({ data: { userId, name: 'Ada Lovelace' } });
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: 'Exercise the alert context contract',
      status: 'FAILED',
    },
  });

  try {
    const happy = await request(agentId);
    if (happy.status !== 200) {
      throw new Error(`expected API-key request to return 200, got ${happy.status}`);
    }
    const body = AlertContextResponse.parse(happy.data);
    if (body.agent_id !== agentId) throw new Error('alert context returned the wrong agent');
    if (body.affected_user_name !== 'Ada Lovelace') {
      throw new Error(`expected affected user Ada Lovelace, got ${body.affected_user_name}`);
    }
    if (body.current_agent_status !== 'FAILED') {
      throw new Error(`expected FAILED status, got ${body.current_agent_status}`);
    }

    const missing = await request(randomUUID());
    if (missing.status !== 404) {
      throw new Error(`expected unknown agent to return 404, got ${missing.status}`);
    }

    const unauthenticated = await request(agentId, false);
    if (unauthenticated.status !== 401) {
      throw new Error(
        `expected unauthenticated request to return 401, got ${unauthenticated.status}`
      );
    }
  } finally {
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  }

  process.stdout.write('agent alert context blackbox passed\n');
}

main().catch(async (error: unknown) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.stderr.write('\n');
  await prisma.$disconnect();
  process.exit(1);
});
