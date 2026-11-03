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
  kind: string;
  file_pointer: {
    storage_path: string;
    mime_type: string;
    original_filename: string;
    kind: string;
    usercontent_url?: string;
    bundle?: { hash: string; entry: string; source: string; file_count: number };
  };
}
export interface Question {
  request_id: string | null;
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

/** A `bundle` display item from path → content. */
export const bundleItem = (entry: string, files: Record<string, string | Buffer>) => ({
  bundle: {
    entry,
    files: Object.entries(files).map(([path, content]) => ({
      path,
      content_base64: (typeof content === 'string' ? Buffer.from(content) : content).toString(
        'base64'
      ),
    })),
  },
});

/**
 * A minimal valid binary glTF: one unit cube (24 vertices with normals, 36
 * indices) with a solid PBR base colour. `tag` lands in asset.extras so every
 * call can get a fresh content hash.
 */
export function cubeGlb(rgba: [number, number, number, number] = [1, 0, 0, 1], tag = ''): Buffer {
  const faces: [number[], number[], number[]][] = [
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [0, 1, 0],
      [1, 0, 0],
    ],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  faces.forEach(([n, u, v], face) => {
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      for (let k = 0; k < 3; k += 1) positions.push(0.5 * (n[k] + a * u[k] + b * v[k]));
      normals.push(...n);
    }
    const o = face * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  const bin = Buffer.concat([
    Buffer.from(new Float32Array(positions).buffer),
    Buffer.from(new Float32Array(normals).buffer),
    Buffer.from(new Uint16Array(indices).buffer),
  ]);
  const json = {
    asset: { version: '2.0', generator: 'rose-blackbox', extras: { tag } },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: rgba, metallicFactor: 0, roughnessFactor: 0.6 } },
    ],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 288, target: 34962 },
      { buffer: 0, byteOffset: 288, byteLength: 288, target: 34962 },
      { buffer: 0, byteOffset: 576, byteLength: 72, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 24,
        type: 'VEC3',
        min: [-0.5, -0.5, -0.5],
        max: [0.5, 0.5, 0.5],
      },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
  };
  const pad = (buf: Buffer, fill: number) =>
    Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4, fill)]);
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const binChunk = pad(bin, 0);
  const chunk = (type: number, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(body.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, body]);
  };
  const body = Buffer.concat([chunk(0x4e4f534a, jsonChunk), chunk(0x004e4942, binChunk)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'latin1');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

/** A tiny one-page PDF. */
export function minimalPdf(text = 'Rose'): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Fetch a usercontent URL through this test's backend (same path, any configured host). */
export function usercontentFetch(url: string): Promise<Response> {
  const parsed = new URL(url);
  return fetch(`${BASE_URL}${parsed.pathname}${parsed.search}`);
}

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
