/**
 * Shared fixtures for the agent-tools black-box suites (agent-tools.blackbox.ts
 * and agent-tools-requests.blackbox.ts): HTTP helpers, media bytes, a seeded
 * agent tree (root → child → grandchild, plus an unrelated agent and a second
 * user) and the suite runner.
 */
import { execFile } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { mintAgentToolsToken } from '../../providers/agentTools/token';
config();

export const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
export const API_KEY = process.env.BACKEND_API_KEY || '';
export const execFileAsync = promisify(execFile);

export interface Res {
  status: number;
  data: Record<string, unknown>;
}
export interface DisplayItem {
  status: string;
  message_id: string;
  sha256: string;
  mime_type: string;
  file_pointer: { storage_path: string; mime_type: string; original_filename: string };
}
export interface Question {
  request_id: string;
  status: string;
  deliver_to: string;
  agent_id: string;
  message_id: string | null;
}

export type Auth = { apiKeyUser?: string; bearer?: string; noAuth?: boolean };

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function expectStatus(res: Res, status: number, label: string): void {
  if (res.status !== status) {
    throw new Error(
      `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.data).slice(0, 400)}`
    );
  }
}

export async function call(
  method: string,
  path: string,
  body: unknown,
  auth: Auth = {}
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth.bearer !== undefined) headers.Authorization = `Bearer ${auth.bearer}`;
  else if (auth.noAuth !== true) {
    headers['X-API-Key'] = API_KEY;
    if (auth.apiKeyUser !== undefined) headers['X-User-Id'] = auth.apiKeyUser;
  }
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data };
}

export const display = (agentId: string, body: unknown, auth: Auth = {}) =>
  call('POST', `/api/agent-tools/${agentId}/display`, body, auth);
export const items = (res: Res) => res.data.items as DisplayItem[];
export const questionOf = (res: Res) => res.data.question as Question;

/** Valid magic bytes + random tail so every call has a fresh content hash. */
export function png(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(64),
  ]);
}
export function mp4(): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom', 'latin1'),
    randomBytes(64),
  ]);
}
export const b64 = (bytes: Buffer, filename = 'shot.png') => ({
  content_base64: bytes.toString('base64'),
  filename,
});

export async function displayMessages(agentId: string) {
  const rows = await prisma.message.findMany({
    where: { agentId, role: 'ASSISTANT' },
    orderBy: { timestamp: 'asc' },
  });
  return rows.filter(
    (row) => (row.metadata as Record<string, unknown> | null)?.source === 'display'
  );
}

export async function toolRows(agentId: string, toolCallId: string) {
  return prisma.message.findMany({
    where: { agentId, role: 'TOOL', metadata: { path: ['toolCallId'], equals: toolCallId } },
    orderBy: { timestamp: 'asc' },
  });
}

export const respond = (requestId: string, userId: string, response: string) =>
  call(
    'POST',
    `/api/attention-requests/${requestId}/respond`,
    { response },
    { apiKeyUser: userId }
  );

export const RUN = randomUUID().slice(0, 8);
export const userA = `agent-tools-a-${RUN}`;
export const userB = `agent-tools-b-${RUN}`;
export const rootA = randomUUID();
export const childA = randomUUID();
export const grandchildA = randomUUID();
export const otherA = randomUUID();
export const agentB = randomUUID();
export const uiVersion = randomUUID();

export async function seed(): Promise<void> {
  await prisma.user.create({ data: { userId: userA, name: 'Agent Tools A' } });
  await prisma.user.create({ data: { userId: userB, name: 'Agent Tools B' } });
  await prisma.agent.create({
    data: { id: rootA, userId: userA, goal: 'agent tools root', status: 'ACTIVE' },
  });
  await prisma.agent.create({
    data: {
      id: childA,
      userId: userA,
      goal: 'agent tools child',
      title: 'Research child',
      status: 'ACTIVE',
      parentAgentId: rootA,
      depth: 1,
    },
  });
  await prisma.agent.create({
    data: {
      id: grandchildA,
      userId: userA,
      goal: 'agent tools grandchild',
      status: 'ACTIVE',
      parentAgentId: childA,
      depth: 2,
    },
  });
  await prisma.agent.create({
    data: { id: otherA, userId: userA, goal: 'agent tools other', status: 'ACTIVE' },
  });
  await prisma.agent.create({
    data: { id: agentB, userId: userB, goal: 'agent tools b', status: 'ACTIVE' },
  });
}

export async function cleanup(): Promise<void> {
  const agentIds = [grandchildA, childA, rootA, otherA, agentB];
  await prisma.message.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.agentAttentionRequest.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.userUiVersion.deleteMany({ where: { userId: { in: [userA, userB] } } });
  await prisma.user.deleteMany({ where: { userId: { in: [userA, userB] } } });
}

export function storedBytes(storagePath: string): Buffer | null {
  const dir = process.env.DISPLAY_STORAGE_LOCAL_DIR;
  if (!dir) return null;
  return readFileSync(join(dir, storagePath));
}

export const codeToken = (agentId: string, userId = userA) =>
  mintAgentToolsToken(userId, agentId, {
    provider: 'claude',
    taskId: `task-${agentId.slice(0, 8)}`,
  }).token;

export interface BlackboxTest {
  name: string;
  fn: () => Promise<void>;
}

/** Seed, run every case in order, clean up, exit non-zero on any failure. */
export async function runSuite(tests: BlackboxTest[]): Promise<void> {
  await seed();
  let failed = 0;
  try {
    for (const test of tests) {
      const start = Date.now();
      try {
        await test.fn();
        console.log(`  PASS  ${test.name} (${Date.now() - start}ms)`);
      } catch (err) {
        failed++;
        console.log(`  FAIL  ${test.name} -- ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  console.log(
    `\nResults: ${tests.length - failed} passed, ${failed} failed, ${tests.length} total`
  );
  process.exit(failed > 0 ? 1 : 0);
}

/** A bounded wait between observations (not a retry). */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
