#!/usr/bin/env tsx
/**
 * Compute-token state must be ONE shared authority across isolated backends.
 *
 * RCA 2026-10-20-bench-guests-ran-independent-compute-token-semaphores: every
 * cloud benchmark guest restores its own loopback Postgres and overlays the
 * production compute-token rows into it. The lineage semaphore
 * (ComputeTokenLineageLease + pg_advisory_xact_lock, GPT capacity 16) and the
 * cooldown (`Integration.rateLimitedUntil`) live in that per-guest DB, so 58
 * guests each granted lease 1/16 on Andy's single ChatGPT token within one
 * minute (04:44Z) and 16 guests independently re-marked the same 429.
 *
 * This domain starts three real compute-token routers on three separate
 * databases that each hold the same token row (the guest overlay):
 *   - authority (one shared state, as production has one DB)
 *   - guest A and guest B, configured with COMPUTE_TOKEN_AUTHORITY_URL
 * and asserts, through the guests only, that
 *   1. lineage capacity is enforced across both guests together,
 *   2. a rate-limit mark reported through guest A stops guest B from serving,
 *   3. two real agent worker processes, one per guest, share one Azure Foundry
 *      deployment cooldown: after worker A sees an in-stream rate limit, worker B
 *      never sends a request to that deployment while it cools
 *      (RCA 2026-10-20-foundry-deployment-cooldown-per-process), and
 *   4. the shared cooldown length follows the provider hint, else 30/60/300 s,
 *      without escalating on rejections inside an active window.
 */
import assert from 'assert';
import { type ChildProcess, execFileSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';
import { GPT_LINEAGE_CAPACITY } from '../../providers/computeCredentials';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '../../..');
const serverScript = path.join(__dirname, 'compute-token-authority.server.ts');
const agentsDir = path.resolve(backendDir, '../agents');
const foundryWorkerFixture = path.join(
  agentsDir,
  'tests/blackbox/foundry_shared_cooldown_fixture.py'
);

const USER_ID = `cta-user-${crypto.randomUUID()}`;
const GUEST_KEY = `guest-key-${crypto.randomUUID()}`;
const AUTHORITY_KEY = `authority-key-${crypto.randomUUID()}`;

function localServerUrl(): URL {
  const raw = process.env.DATABASE_URL;
  assert(raw, 'DATABASE_URL is required for the compute-token authority blackbox');
  const url = new URL(raw);
  assert(
    ['localhost', '127.0.0.1', '::1'].includes(url.hostname),
    `compute-token authority blackbox requires local Postgres, got ${url.hostname}`
  );
  url.search = '';
  return url;
}

function databaseUrl(server: URL, name: string): string {
  const url = new URL(server.toString());
  url.pathname = `/${name}`;
  return url.toString();
}

function encryptEnvelope(plaintext: string, publicKeyPem: string): string {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]);
  const encryptedAesKey = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey
  );
  return Buffer.from(
    JSON.stringify({
      version: 1,
      encrypted_aes_key: encryptedAesKey.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }),
    'utf8'
  ).toString('base64');
}

async function startBackend(
  label: string,
  url: string,
  decryptionKey: string,
  extraEnv: Record<string, string>
): Promise<{ child: ChildProcess; baseUrl: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: url,
    DIRECT_URL: url,
    PORT: '0',
    CLAUDE_CREDENTIAL_DECRYPTION_KEY: decryptionKey,
    COMPUTE_TOKEN_AUTHORITY_URL: '',
    COMPUTE_TOKEN_AUTHORITY_API_KEY: '',
    ...extraEnv,
  };
  delete env.FLY_APP_NAME;
  const child = spawn(process.execPath, ['--import', 'tsx', serverScript], {
    cwd: backendDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} backend did not start within 60s: ${stderr}`)),
      60_000
    );
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /READY (\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} backend exited ${code} before READY: ${stderr}`));
    });
  });
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

async function fetchLease(baseUrl: string, lineageKey: string): Promise<number> {
  const params = new URLSearchParams({
    lineageKey,
    agentId: lineageKey,
    rootAgentId: lineageKey,
    tokenType: 'gpt',
  });
  const response = await fetch(
    `${baseUrl}/api/integrations/compute-code/credentials/token?${params}`,
    { headers: { 'X-API-Key': GUEST_KEY, 'X-User-Id': USER_ID } }
  );
  await response.text();
  return response.status;
}

async function post(baseUrl: string, route: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/integrations/compute-code/${route}`, {
    method: 'POST',
    headers: { 'X-API-Key': GUEST_KEY, 'X-User-Id': USER_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.strictEqual(response.status, 200, `${route} returned ${response.status}: ${text}`);
}

interface FoundryWorkerResult {
  first: string;
  hits: string[];
  served: string | null;
}

/** One real agent worker process whose backend is `baseUrl` (its guest). */
function runFoundryWorker(baseUrl: string, phase: 'reject' | 'observe'): FoundryWorkerResult {
  const stdout = execFileSync(
    path.join(agentsDir, 'venv/bin/python'),
    [foundryWorkerFixture, phase],
    {
      cwd: agentsDir,
      env: {
        ...process.env,
        PYTHONPATH: agentsDir,
        BACKEND_API_URL: baseUrl,
        BACKEND_API_KEY: GUEST_KEY,
      },
      encoding: 'utf8',
      timeout: 60_000,
    }
  );
  const line = stdout
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith('{"first"'));
  assert(line, `Foundry worker (${phase}) printed no result: ${stdout}`);
  return JSON.parse(line) as FoundryWorkerResult;
}

/** Keep the second process alive with a healthy cached read before A marks. */
async function warmFoundryWorker(baseUrl: string): Promise<{
  child: ChildProcess;
  observe: () => Promise<FoundryWorkerResult>;
}> {
  const child = spawn(path.join(agentsDir, 'venv/bin/python'), [foundryWorkerFixture, 'warm'], {
    cwd: agentsDir,
    env: {
      ...process.env,
      PYTHONPATH: agentsDir,
      BACKEND_API_URL: baseUrl,
      BACKEND_API_KEY: GUEST_KEY,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  async function waitForLine(prefix: string): Promise<string> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const line = stdout.split('\n').find((candidate) => candidate.startsWith(prefix));
      if (line) return line;
      assert(child.exitCode === null, `warm Foundry worker exited ${child.exitCode}: ${stderr}`);
      await delay(20);
    }
    child.kill('SIGTERM');
    throw new Error(`warm Foundry worker timeout: ${stderr}`);
  }
  try {
    await waitForLine('{"ready"');
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
  return {
    child,
    observe: async () => {
      child.stdin?.end('observe\n');
      return JSON.parse(await waitForLine('{"first"')) as FoundryWorkerResult;
    },
  };
}

async function foundryCall(
  baseUrl: string,
  route: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/api/integrations/compute-code/${route}`, {
    method: 'POST',
    headers: { 'X-API-Key': GUEST_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.strictEqual(response.status, 200, `${route} returned ${response.status}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function main() {
  const server = localServerUrl();
  const suffix = crypto.randomBytes(4).toString('hex');
  const names = {
    authority: `cta_${suffix}_authority`,
    guestA: `cta_${suffix}_guest_a`,
    guestB: `cta_${suffix}_guest_b`,
  };
  const admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const clients: PrismaClient[] = [];
  const children: ChildProcess[] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cta-'));
  try {
    for (const name of Object.values(names)) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    }
    const schemaSql = execFileSync(
      'npx',
      [
        'prisma',
        'migrate',
        'diff',
        '--from-empty',
        '--to-schema-datamodel',
        'prisma/schema.prisma',
        '--script',
      ],
      { cwd: backendDir, encoding: 'utf8' }
    );
    const schemaFile = path.join(tmp, 'schema.sql');
    fs.writeFileSync(schemaFile, schemaSql);

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const decryptionKey = Buffer.from(privatePem, 'utf8').toString('base64');
    // One real token, copied into every database exactly as the guest overlay does.
    const encryptedCredentials = encryptEnvelope(
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: `gpt-${suffix}` } }),
      publicPem
    );

    const urls = Object.fromEntries(
      Object.entries(names).map(([key, name]) => [key, databaseUrl(server, name)])
    ) as Record<keyof typeof names, string>;
    for (const url of Object.values(urls)) {
      execFileSync('npx', ['prisma', 'db', 'execute', '--url', url, '--file', schemaFile], {
        cwd: backendDir,
        stdio: 'pipe',
      });
      const client = new PrismaClient({ datasources: { db: { url } } });
      clients.push(client);
      await client.integration.create({
        data: {
          id: `cta-gpt-${suffix}`,
          userId: USER_ID,
          name: 'gpt_code',
          type: 'TOOL_SETUP',
          status: 'CONNECTED',
          isActive: true,
          config: { encryptedCredentials },
        },
      });
    }
    const authorityDb = clients[0];

    const authority = await startBackend('authority', urls.authority, decryptionKey, {
      BACKEND_API_KEY: AUTHORITY_KEY,
    });
    children.push(authority.child);
    const guestEnv = {
      BACKEND_API_KEY: GUEST_KEY,
      COMPUTE_TOKEN_AUTHORITY_URL: authority.baseUrl,
      COMPUTE_TOKEN_AUTHORITY_API_KEY: AUTHORITY_KEY,
    };
    const guestA = await startBackend('guest A', urls.guestA, decryptionKey, guestEnv);
    children.push(guestA.child);
    const guestB = await startBackend('guest B', urls.guestB, decryptionKey, guestEnv);
    children.push(guestB.child);

    // 1. Capacity is one budget across guests.
    const perGuest = GPT_LINEAGE_CAPACITY / 2 + 1;
    const lineages: Array<{ base: string; key: string; status: number }> = [];
    for (let i = 0; i < perGuest; i++) {
      for (const [label, guest] of [
        ['a', guestA],
        ['b', guestB],
      ] as const) {
        const key = `agent:cta-${suffix}-${label}-${i}`;
        lineages.push({ base: guest.baseUrl, key, status: await fetchLease(guest.baseUrl, key) });
      }
    }
    const granted = lineages.filter((l) => l.status === 200).length;
    const authorityLeases = await authorityDb.computeTokenLineageLease.count({
      where: { tokenIdentity: USER_ID, releasedAt: null },
    });
    assert.strictEqual(
      granted,
      GPT_LINEAGE_CAPACITY,
      `two guests sharing one token granted ${granted} of ${lineages.length} lineages; ` +
        `the shared capacity is ${GPT_LINEAGE_CAPACITY} (authority holds ${authorityLeases} leases)`
    );
    assert.strictEqual(authorityLeases, GPT_LINEAGE_CAPACITY, 'leases must live in the authority');
    console.log(`PASS lineage capacity ${GPT_LINEAGE_CAPACITY} holds across two isolated guests`);

    for (const lineage of lineages.filter((l) => l.status === 200)) {
      await post(lineage.base, 'token/lineage-release', { lineageKey: lineage.key });
    }

    // 2. A cooldown reported through guest A is visible to guest B.
    await post(guestA.baseUrl, 'token/rate-limited', {
      type: 'gpt',
      source: 'user',
      userId: USER_ID,
      rateLimitedUntil: new Date(Date.now() + 120_000).toISOString(),
    });
    const afterMark = await fetchLease(guestB.baseUrl, `agent:cta-${suffix}-after-mark`);
    assert.strictEqual(
      afterMark,
      404,
      `guest B still served the token guest A reported rate-limited (status ${afterMark})`
    );
    console.log(
      'PASS a rate-limit mark through one guest stops every guest from serving the token'
    );

    // 3. Two worker processes on two guests share one Foundry deployment cooldown.
    const warmWorker = await warmFoundryWorker(guestB.baseUrl);
    children.push(warmWorker.child);
    const workerA = runFoundryWorker(guestA.baseUrl, 'reject');
    assert.strictEqual(workerA.hits[0], workerA.first, `worker A hits: ${workerA.hits.join(',')}`);
    assert(
      workerA.served !== null && workerA.served !== workerA.first,
      `worker A must fall through to the other deployment: ${JSON.stringify(workerA)}`
    );
    const workerB = runFoundryWorker(guestB.baseUrl, 'observe');
    const sharedRows = await authorityDb.integration.findMany({
      where: { name: 'foundry_deployment_cooldown' },
      select: { accountId: true, rateLimitedUntil: true },
    });
    assert(
      !workerB.hits.includes(workerA.first),
      `worker B (guest B) sent ${workerB.hits.filter((hit) => hit === workerA.first).length} ` +
        `request(s) to ${workerA.first}, which worker A (guest A) saw rate limited; ` +
        `worker B hits=${workerB.hits.join(',')}; authority cooldown rows=${sharedRows.length}`
    );
    assert.strictEqual(workerB.served, workerB.hits[0], `worker B: ${JSON.stringify(workerB)}`);
    // A previously healthy cache may lag by at most the production 5 s TTL.
    // Keep B alive across A's mark, then re-enter routing after that interval.
    await delay(5_100);
    const warmedB = await warmWorker.observe();
    assert(
      !warmedB.hits.includes(workerA.first),
      `warmed worker ignored shared cooldown: ${JSON.stringify(warmedB)}`
    );

    // Expiry reopens exactly the same deployment in a fresh worker process.
    await authorityDb.integration.updateMany({
      where: {
        name: 'foundry_deployment_cooldown',
        accountId: `foundry-cta.example.test:${workerA.first}`,
      },
      data: { rateLimitedUntil: new Date(Date.now() - 1_000) },
    });
    const workerAfterExpiry = runFoundryWorker(guestB.baseUrl, 'observe');
    assert.strictEqual(workerAfterExpiry.hits[0], workerA.first);
    console.log('PASS a Foundry rate limit seen by one worker process stops another until expiry');

    // 4. Cooldown length: provider hint, else 30 s, 60 s, 300 s; no in-window escalation.
    const target = { region: 'ladder.example.test', deployment: `ladder-${suffix}` };
    const accountId = `${target.region}:${target.deployment}`;
    const expire = () =>
      authorityDb.integration.updateMany({
        where: { name: 'foundry_deployment_cooldown', accountId },
        data: { rateLimitedUntil: new Date(Date.now() - 1_000) },
      });
    const mark = (extra: Record<string, unknown> = {}) =>
      foundryCall(guestA.baseUrl, 'token/rate-limited', {
        type: 'foundry',
        source: 'pool',
        ...target,
        ...extra,
      });
    const seconds: number[] = [];
    const first = await mark();
    seconds.push(Number(first.cooldownSeconds));
    const inWindow = await mark();
    assert.strictEqual(inWindow.strikes, 1, 'a rejection inside the window must not escalate');
    assert.strictEqual(inWindow.rateLimitedUntil, first.rateLimitedUntil);
    for (let i = 0; i < 3; i++) {
      await expire();
      seconds.push(Number((await mark()).cooldownSeconds));
    }
    assert.deepStrictEqual(seconds, [30, 60, 300, 300], `ladder ${seconds.join(',')}`);
    await expire();
    assert.strictEqual(Number((await mark({ retryAfterSeconds: 7 })).cooldownSeconds), 7);
    await expire();
    const longHint = await mark({ retryAfterSeconds: 900 });
    assert.strictEqual(
      Number(longHint.cooldownSeconds),
      900,
      'provider retry advice must not be capped to 300 s'
    );
    await expire();
    assert.strictEqual(
      (await foundryCall(guestB.baseUrl, 'foundry-deployment/served', target)).reset,
      true
    );
    assert.strictEqual(Number((await mark()).cooldownSeconds), 30, 'served must reset the ladder');
    const read = await fetch(
      `${guestB.baseUrl}/api/integrations/compute-code/foundry-deployment/cooldown?keys=${encodeURIComponent(accountId)}`,
      { headers: { 'X-API-Key': GUEST_KEY } }
    );
    const readBody = (await read.json()) as {
      cooldowns: Record<string, { rateLimitedUntil: string | null; strikes: number }>;
    };
    assert.strictEqual(readBody.cooldowns[accountId]?.strikes, 1);
    assert(readBody.cooldowns[accountId]?.rateLimitedUntil !== null, 'guest B reads the cooldown');
    console.log('PASS Foundry cooldown uses the provider hint, else 30/60/300 s, reset on serve');
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null) return resolve();
            const timer = setTimeout(() => {
              child.kill('SIGKILL');
              resolve();
            }, 5_000);
            child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
          })
      )
    );
    await Promise.all(clients.map((client) => client.$disconnect()));
    for (const name of Object.values(names)) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    await admin.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
