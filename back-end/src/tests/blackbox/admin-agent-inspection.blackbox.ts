#!/usr/bin/env tsx
/** Black-box contract for read-only admin inspection of another user's run. */

import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import jwt from 'jsonwebtoken';

import { prisma } from '../../providers/database';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const ADMIN_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

interface AgentDetailResponse {
  inspection_context?: {
    user_id: string;
    name: string | null;
    phone: string | null;
    email: string | null;
  } | null;
}

function tokenFor(userId: string): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!secret || !supabaseUrl) {
    throw new Error('SUPABASE_JWT_SECRET and SUPABASE_URL are required');
  }
  return jwt.sign({ sub: userId }, secret, {
    algorithm: 'HS256',
    issuer: `${supabaseUrl}/auth/v1`,
    expiresIn: '1h',
  });
}

async function request(
  agentId: string,
  userId: string,
  options: { method?: string; body?: Record<string, unknown> } = {}
) {
  const response = await fetch(`${BASE_URL}/api/agents/${agentId}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${tokenFor(userId)}`,
      'Content-Type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = (await response.json()) as unknown;
  return { status: response.status, data };
}

function readDetail(data: unknown): AgentDetailResponse {
  if (typeof data !== 'object' || data === null) throw new Error('Expected an object response');
  return data as AgentDetailResponse;
}

async function main(): Promise<void> {
  const ownerUserId = `inspection-owner-${randomUUID()}`;
  const outsiderUserId = `inspection-outsider-${randomUUID()}`;
  const agentId = randomUUID();
  // User.phone is unique: a per-run number keeps concurrent runs on a shared
  // local database from colliding.
  const ownerPhone = `+1555${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;

  await prisma.user.create({
    data: {
      userId: ownerUserId,
      name: 'Ada Lovelace',
      phone: ownerPhone,
      email: 'ada@example.com',
    },
  });
  await prisma.agent.create({
    data: {
      id: agentId,
      userId: ownerUserId,
      goal: 'Inspect this run without changing it',
      status: 'ACTIVE',
    },
  });
  await prisma.message.create({
    data: { agentId, role: 'USER', text: 'Private run context' },
  });

  try {
    const admin = await request(agentId, ADMIN_USER_ID);
    if (admin.status !== 200) throw new Error(`expected admin read 200, got ${admin.status}`);
    const context = readDetail(admin.data).inspection_context;
    if (context?.user_id !== ownerUserId) throw new Error('admin response omitted owner user id');
    if (context.name !== 'Ada Lovelace') throw new Error('admin response omitted owner name');
    if (context.phone !== ownerPhone) throw new Error('admin response omitted owner phone');
    if (context.email !== 'ada@example.com') throw new Error('admin response omitted owner email');

    const owner = await request(agentId, ownerUserId);
    if (owner.status !== 200) throw new Error(`expected owner read 200, got ${owner.status}`);
    const ownerInspectionContext = readDetail(owner.data).inspection_context;
    if (ownerInspectionContext !== null && ownerInspectionContext !== undefined) {
      throw new Error('owner response must not be marked as cross-account inspection');
    }

    const outsider = await request(agentId, outsiderUserId);
    if (outsider.status !== 404) {
      throw new Error(`expected unrelated account read 404, got ${outsider.status}`);
    }

    const adminWrite = await request(agentId, ADMIN_USER_ID, {
      method: 'PATCH',
      body: { write_lock_enabled: false },
    });
    if (adminWrite.status !== 404) {
      throw new Error(`expected cross-account admin write 404, got ${adminWrite.status}`);
    }
  } finally {
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.user.deleteMany({ where: { userId: { in: [ownerUserId, outsiderUserId] } } });
    await prisma.$disconnect();
  }

  process.stdout.write('admin agent inspection blackbox passed\n');
}

main().catch(async (error: unknown) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.stderr.write('\n');
  await prisma.$disconnect();
  process.exit(1);
});
