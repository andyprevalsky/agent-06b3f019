#!/usr/bin/env tsx
/**
 * Black-box tests for POST /api/display/:agentId (the `display` tool and the
 * sandbox `rose-display` CLI).
 *
 * Invariants covered:
 *   - internal (agents worker) call posts ONE ASSISTANT message per item with an
 *     image/video file_pointer the FE renders inline; bytes land in storage
 *   - idempotent per (agent, content hash): sequential and concurrent repeats
 *     never post twice; the same bytes in another agent post there once
 *   - caps: > 20 items → 400; disallowed content (HTML renamed .png, SVG) → 400;
 *     one bad item rejects the whole call (nothing posted)
 *   - SSRF: loopback / non-http URLs are refused before any fetch
 *   - `file` resolves a pointer already in the agent's tree (child → root)
 *   - CLI token: scoped to one agent (other agent → 403), tampered / expired /
 *     wrong-scope → 401; owner mismatch via API key → 403
 *   - the shipped `rose-display` CLI posts, then reports "already displayed"
 *
 * Usage: bash scripts/run-blackbox-tests.sh display
 */
import { execFile } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { DISPLAY_CLI_SCRIPT } from '../../providers/display/cli';
import { mintDisplayToken } from '../../providers/display/displayToken';
import { DISPLAY_CLI_PATH, withDisplayCli } from '../../providers/display/workspace';
import { mintUserUiPublishToken } from '../../providers/userUi/publishToken';
import { materializeUserUiInLocalHome } from '../../providers/userUi/workspace';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const execFileAsync = promisify(execFile);

interface Res {
  status: number;
  data: Record<string, unknown>;
}
interface DisplayItem {
  status: string;
  message_id: string;
  sha256: string;
  mime_type: string;
  file_pointer: { storage_path: string; mime_type: string; original_filename: string };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectStatus(res: Res, status: number, label: string): void {
  if (res.status !== status) {
    throw new Error(
      `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.data).slice(0, 400)}`
    );
  }
}

async function post(
  agentId: string,
  body: unknown,
  auth: { apiKeyUser?: string; bearer?: string } = {}
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth.bearer !== undefined) headers.Authorization = `Bearer ${auth.bearer}`;
  else {
    headers['X-API-Key'] = API_KEY;
    if (auth.apiKeyUser !== undefined) headers['X-User-Id'] = auth.apiKeyUser;
  }
  const response = await fetch(`${BASE_URL}/api/display/${agentId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
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

const items = (res: Res) => res.data.items as DisplayItem[];

/** Valid magic bytes + random tail so every call has a fresh content hash. */
function png(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(64),
  ]);
}
function mp4(): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom', 'latin1'),
    randomBytes(64),
  ]);
}
const b64 = (bytes: Buffer, filename = 'shot.png') => ({
  content_base64: bytes.toString('base64'),
  filename,
});

async function displayMessages(agentId: string) {
  const rows = await prisma.message.findMany({
    where: { agentId, role: 'ASSISTANT' },
    orderBy: { timestamp: 'asc' },
  });
  return rows.filter((row) => (row.metadata as Record<string, unknown> | null)?.source === 'display');
}

const RUN = randomUUID().slice(0, 8);
const userA = `display-a-${RUN}`;
const userB = `display-b-${RUN}`;
const rootA = randomUUID();
const childA = randomUUID();
const otherA = randomUUID();
const agentB = randomUUID();

async function seed(): Promise<void> {
  await prisma.user.create({ data: { userId: userA, name: 'Display A' } });
  await prisma.user.create({ data: { userId: userB, name: 'Display B' } });
  await prisma.agent.create({
    data: { id: rootA, userId: userA, goal: 'display root', status: 'ACTIVE' },
  });
  await prisma.agent.create({
    data: {
      id: childA,
      userId: userA,
      goal: 'display child',
      status: 'ACTIVE',
      parentAgentId: rootA,
    },
  });
  await prisma.agent.create({
    data: { id: otherA, userId: userA, goal: 'display other', status: 'ACTIVE' },
  });
  await prisma.agent.create({
    data: { id: agentB, userId: userB, goal: 'display b', status: 'ACTIVE' },
  });
}

async function cleanup(): Promise<void> {
  await prisma.agent.deleteMany({ where: { id: { in: [childA, rootA, otherA, agentB] } } });
  await prisma.user.deleteMany({ where: { userId: { in: [userA, userB] } } });
}

function storedBytes(storagePath: string): Buffer | null {
  const dir = process.env.DISPLAY_STORAGE_LOCAL_DIR;
  if (!dir) return null;
  return readFileSync(join(dir, storagePath));
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  {
    name: 'internal call posts inline ASSISTANT media messages with file pointers',
    fn: async () => {
      const image = png();
      const video = mp4();
      const res = await post(
        rootA,
        { items: [b64(image, 'before.png'), b64(video, 'demo.mp4')], caption: 'Before / demo' },
        { apiKeyUser: userA }
      );
      expectStatus(res, 201, 'display');
      assert(res.data.posted_count === 2, `posted_count 2: ${JSON.stringify(res.data)}`);
      const [first, second] = items(res);
      assert(first.mime_type === 'image/png' && second.mime_type === 'video/mp4', 'sniffed types');
      assert(
        first.file_pointer.storage_path === `${userA}/display/${first.sha256}.png`,
        `content-addressed path under owner: ${first.file_pointer.storage_path}`
      );
      const rows = await displayMessages(rootA);
      assert(rows.length === 2, `two display messages, got ${rows.length}`);
      assert(rows[0].text === 'Before / demo' && rows[1].text === '', 'caption on first item only');
      const pointer = rows[0].filePointer as Record<string, unknown>;
      assert(pointer.mime_type === 'image/png', 'file_pointer mime');
      assert(pointer.original_filename === 'before.png', 'file_pointer filename');
      const stored = storedBytes(first.file_pointer.storage_path);
      if (stored) assert(stored.equals(image), 'stored bytes equal the displayed bytes');
    },
  },
  {
    name: 'same content is never posted twice (sequential, concurrent, in-call)',
    fn: async () => {
      const image = png();
      const first = await post(rootA, { items: [b64(image)] }, { apiKeyUser: userA });
      expectStatus(first, 201, 'first');
      const again = await post(rootA, { items: [b64(image)] }, { apiKeyUser: userA });
      expectStatus(again, 200, 'retry');
      assert(items(again)[0].status === 'duplicate', 'retry reports duplicate');
      assert(items(again)[0].message_id === items(first)[0].message_id, 'same message id');

      const fresh = png();
      const burst = await Promise.all(
        [0, 1, 2, 3].map(() => post(rootA, { items: [b64(fresh)] }, { apiKeyUser: userA }))
      );
      for (const res of burst) assert(res.status === 200 || res.status === 201, 'burst ok');
      const inCall = await post(rootA, { items: [b64(png()), b64(image)] }, { apiKeyUser: userA });
      expectStatus(inCall, 201, 'in-call');
      assert(items(inCall)[1].status === 'duplicate', 'already-displayed item in a new call');

      const rows = await displayMessages(rootA);
      const shas = rows.map((row) => (row.metadata as { display: { sha256: string } }).display.sha256);
      assert(new Set(shas).size === shas.length, `no duplicate display rows: ${shas.join(',')}`);
      assert(rows.length === 5, `2 + 1 + 1 + 1 rows, got ${rows.length}`);

      const elsewhere = await post(otherA, { items: [b64(image)] }, { apiKeyUser: userA });
      expectStatus(elsewhere, 201, 'same bytes, other agent');
      assert((await displayMessages(otherA)).length === 1, 'posted once in the other agent');
    },
  },
  {
    name: 'caps and content-type allowlist reject the whole call',
    fn: async () => {
      const before = (await displayMessages(otherA)).length;
      const tooMany = await post(
        otherA,
        { items: Array.from({ length: 21 }, () => b64(png())) },
        { apiKeyUser: userA }
      );
      expectStatus(tooMany, 400, '21 items');
      const html = await post(
        otherA,
        { items: [b64(Buffer.from('<html><script>alert(1)</script>'), 'x.png')] },
        { apiKeyUser: userA }
      );
      expectStatus(html, 400, 'html renamed png');
      assert(JSON.stringify(html.data).includes('not an image or video'), 'type error detail');
      const svg = await post(
        otherA,
        { items: [b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'a.svg')] },
        { apiKeyUser: userA }
      );
      expectStatus(svg, 400, 'svg');
      const mixed = await post(
        otherA,
        { items: [b64(png()), b64(Buffer.from('plain text'), 'notes.png')] },
        { apiKeyUser: userA }
      );
      expectStatus(mixed, 400, 'mixed valid + invalid');
      const neither = await post(otherA, { items: [{ filename: 'x.png' }] }, { apiKeyUser: userA });
      expectStatus(neither, 400, 'item without a source');
      assert((await displayMessages(otherA)).length === before, 'nothing posted by rejected calls');
    },
  },
  {
    name: 'URLs must be public http(s)',
    fn: async () => {
      for (const url of [
        'http://127.0.0.1:1/x.png',
        'http://localhost/x.png',
        'http://169.254.169.254/latest/meta-data',
        'file:///etc/passwd',
      ]) {
        const res = await post(otherA, { items: [{ url }] }, { apiKeyUser: userA });
        expectStatus(res, 400, url);
      }
    },
  },
  {
    name: 'file resolves a pointer already in the agent tree',
    fn: async () => {
      const image = png();
      const root = await post(rootA, { items: [b64(image, 'tree-shot.png')] }, { apiKeyUser: userA });
      expectStatus(root, 201, 'root display');
      const child = await post(childA, { items: [{ file: 'tree-shot.png' }] }, { apiKeyUser: userA });
      expectStatus(child, 201, 'child displays the root file by name');
      assert(items(child)[0].sha256 === items(root)[0].sha256, 'same content');
      const missing = await post(childA, { items: [{ file: 'nope.png' }] }, { apiKeyUser: userA });
      expectStatus(missing, 400, 'unknown file');
      const foreign = await post(
        agentB,
        { items: [{ file: items(root)[0].file_pointer.storage_path }] },
        { apiKeyUser: userB }
      );
      expectStatus(foreign, 400, "another user's storage path is not resolvable");
    },
  },
  {
    name: 'CLI token is scoped to one agent; owner enforced',
    fn: async () => {
      const { token } = mintDisplayToken(userA, childA);
      const ok = await post(childA, { items: [b64(png())] }, { bearer: token });
      expectStatus(ok, 201, 'token on its agent');
      const wrongAgent = await post(rootA, { items: [b64(png())] }, { bearer: token });
      expectStatus(wrongAgent, 403, 'token on a different agent');
      const forged = mintDisplayToken(userB, rootA).token;
      expectStatus(
        await post(rootA, { items: [b64(png())] }, { bearer: forged }),
        403,
        'token whose user does not own the agent'
      );
      const tampered = `${token.slice(0, -2)}xx`;
      expectStatus(await post(childA, { items: [b64(png())] }, { bearer: tampered }), 401, 'tampered');
      const expired = mintDisplayToken(userA, childA, { ttlSeconds: -10 }).token;
      expectStatus(await post(childA, { items: [b64(png())] }, { bearer: expired }), 401, 'expired');
      const wrongScope = mintDisplayToken(userA, childA, { scope: 'user-ui:publish' }).token;
      expectStatus(await post(childA, { items: [b64(png())] }, { bearer: wrongScope }), 401, 'scope');
      const publishToken = mintUserUiPublishToken(userA).token;
      expectStatus(
        await post(childA, { items: [b64(png())] }, { bearer: publishToken }),
        401,
        'rose-ui publish token is not a display token'
      );
      expectStatus(
        await post(rootA, { items: [b64(png())] }, { apiKeyUser: userB }),
        403,
        'API key with a non-owner user'
      );
    },
  },
  {
    name: 'shipped rose-display CLI posts once, then reports already displayed',
    fn: async () => {
      const home = mkdtempSync(join(tmpdir(), 'rose-display-'));
      try {
        const workspace = withDisplayCli(null, userA, otherA);
        assert(workspace !== null, 'workspace with CLI');
        assert(
          workspace.files.some((f) => f.path === DISPLAY_CLI_PATH),
          'CLI installed under ~/.rose/bin'
        );
        assert(
          workspace.envs.ROSE_DISPLAY_URL?.endsWith(`/api/display/${otherA}`) === true,
          'display URL bound to the session agent'
        );
        const local = await materializeUserUiInLocalHome(home, workspace, otherA);
        assert(local !== null, 'materialized locally');
        const cli = join(home, DISPLAY_CLI_PATH);
        assert((statSync(cli).mode & 0o111) !== 0, 'CLI is executable');
        assert(readFileSync(cli, 'utf8') === DISPLAY_CLI_SCRIPT, 'CLI bytes');
        const shot = join(home, 'shot.png');
        writeFileSync(shot, png());
        chmodSync(shot, 0o644);
        const env = {
          ...process.env,
          ROSE_DISPLAY_URL: `${BASE_URL}/api/display/${otherA}`,
          ROSE_DISPLAY_TOKEN: workspace.envs.ROSE_DISPLAY_TOKEN,
        };
        const before = (await displayMessages(otherA)).length;
        const first = await execFileAsync('node', [cli, shot, '--caption', 'from the CLI'], { env });
        assert(first.stdout.includes('displayed '), `first run: ${first.stdout}`);
        const second = await execFileAsync('node', [cli, shot], { env });
        assert(second.stdout.includes('already displayed'), `second run: ${second.stdout}`);
        const rows = await displayMessages(otherA);
        assert(rows.length === before + 1, 'CLI posted exactly once');
        assert(rows[rows.length - 1].text === 'from the CLI', 'CLI caption');
        const tooMany = await execFileAsync(
          'node',
          [cli, ...Array.from({ length: 21 }, () => shot)],
          { env }
        ).then(
          () => null,
          (err: { code?: number; stderr?: string }) => err
        );
        assert(tooMany !== null && tooMany.code === 1, 'CLI rejects > 20 items');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
];

async function main(): Promise<void> {
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

main().catch((err) => {
  console.error('\nCrashed:', err);
  process.exit(1);
});
