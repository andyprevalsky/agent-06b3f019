/** Run in a separate process with the real application pool limited to one. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createServer } from 'node:http';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import express from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import { prisma } from '../../providers/database';
import routes from '../../domains/integrations/routes';
import { withLanternCredentialLock } from '../../domains/integrations/repo.lantern';
import { encryptPasswordForStorage } from '../../providers/credentialEnvelope';
import { assertLocalDatabase } from './assertLocalDatabase';

async function child(code: string, args: string[] = []) {
  await new Promise<void>((fulfill, reject) => {
    const processChild = spawn(process.execPath, ['--import', 'tsx', '-e', code, ...args], {
      env: { ...process.env, DB_CONNECTION_LIMIT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    processChild.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    processChild.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    processChild.on('error', reject);
    processChild.on('exit', (status) => (status === 0 ? fulfill() : reject(new Error(output))));
  });
}

/** Registered by the owning fixture; isolation ensures a genuine small pool. */
export async function runLanternSmallPoolRegression() {
  await child(
    `require(${JSON.stringify(resolve(__dirname, 'integrations.lantern-pool.cases.ts'))}).testLanternSmallPool().catch(e => { console.error(e); process.exitCode = 1; })`
  );
}

export async function testLanternSmallPool() {
  assertLocalDatabase();
  const admin = new PrismaClient();
  const original = { ...process.env };
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
    pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  ).toString('base64');
  process.env.BACKEND_API_KEY = 'fixture-pool-key';
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const users = Array.from({ length: 4 }, () => `lantern-pool-${randomUUID()}`);
  let refreshes = 0;
  const releases: (() => void)[] = [];
  const upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/operations/connection_check') {
      res.end(
        JSON.stringify({
          ok: true,
          data: { connected: true, ready: true, workspace: { id: 'fixture' } },
        })
      );
      return;
    }
    if (req.url !== '/oauth/token') {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    req.resume();
    refreshes++;
    releases.push(() =>
      res.end(
        JSON.stringify({
          access_token: 'fixture-rotated-access',
          refresh_token: 'lantern_rt_rotated',
          expires_in: 3600,
          connection_id: 'grant_fixture',
        })
      )
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const addr = upstream.address();
  assert(addr && typeof addr !== 'string');
  const origin = `http://127.0.0.1:${addr.port}`;
  process.env.LANTERN_PEOPLE_API_ORIGIN = origin;
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', routes);
  const backend = createServer(app);
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/integrations/lantern-people/credentials`;
  const headers = (id: string) => ({
    'x-api-key': 'fixture-pool-key',
    'x-user-id': id,
    'content-type': 'application/json',
  });
  const envelope = (grant = 'grant_fixture', expiresAt = Date.now() + 1000) =>
    encryptPasswordForStorage(
      JSON.stringify({
        apiUrl: origin,
        token: 'fixture-original-access',
        refreshToken: 'lantern_rt_original',
        expiresAt,
        connectionId: grant,
      }),
      publicKey
    );
  let pending: Promise<Response[]> | undefined;
  try {
    await admin.integration.createMany({
      data: users.map((userId) => ({
        userId,
        name: 'lantern_people',
        accountId: '',
        type: 'TOOL_SETUP',
        status: 'CONNECTED',
        isActive: true,
        config: { encryptedCredentials: envelope() },
      })),
    });
    pending = Promise.all(users.map((id) => fetch(`${base}/token`, { headers: headers(id) })));
    const deadline = Date.now() + 2500;
    while (refreshes < users.length && Date.now() < deadline) await delay(20);
    assert.equal(
      refreshes,
      users.length,
      'Four stale tenants must reach HTTP with one application connection'
    );
    assert.equal(
      (await prisma.$queryRaw<{ value: number }[]>`SELECT 1::int AS value`)[0].value,
      1,
      'The sole application connection must remain available while every HTTP response is held'
    );
    const marker = await admin.integration.findFirstOrThrow({
      where: { userId: users[0], name: 'lantern_people' },
    });
    await child(
      `
      const assert = require('node:assert/strict');
      const service = require(${JSON.stringify(resolve(__dirname, '../../domains/integrations/service.lantern.ts'))});
      service.getLanternToken(process.argv[1]).then(() => { throw Error('Unexpected duplicate refresh'); }, error => {
        assert.equal(error.status, 503);
        assert.equal(error.code, 'LANTERN_REFRESH_IN_PROGRESS');
        assert(error.details.retryAfterSeconds > 0);
      }).catch(e => { console.error(e); process.exitCode = 1; }).finally(() => require(${JSON.stringify(resolve(__dirname, '../../providers/database.ts'))}).prisma.$disconnect());
    `,
      [users[0]]
    );
    assert.equal(
      refreshes,
      users.length,
      'Another backend instance must not refresh the claimed token'
    );
    const uploaded = await fetch(`${base}/upload`, {
      method: 'POST',
      headers: headers(users[0]),
      body: JSON.stringify({ encryptedCredentials: envelope('grant_new', Date.now() + 3600000) }),
      signal: AbortSignal.timeout(2500),
    });
    assert.equal(uploaded.status, 200, 'Upload must not wait for old refresh HTTP');
    for (const release of releases) release();
    const responses = await pending;
    assert(responses.slice(1).every((response) => response.status === 200));
    // Delayed claim from an old exact credential version must be harmless.
    await withLanternCredentialLock(users[0], async (store) => {
      await Reflect.apply(store.markRefreshPending, store, [
        marker.id,
        (marker.config as { encryptedCredentials: string }).encryptedCredentials,
        `lantern_refresh_pending:${Date.now() + 20000}:${randomUUID()}`,
      ]);
    });
    const fresh = await fetch(`${base}/token`, { headers: headers(users[0]) });
    assert.equal(fresh.status, 200, 'Late old fence/finalization must preserve replacement grant');
    assert.equal(((await fresh.json()) as { connectionId: string }).connectionId, 'grant_new');
    assert.equal(refreshes, users.length);
    // A crashed/expired owner is never replaced by another refresh attempt.
    await admin.integration.updateMany({
      where: { userId: users[1], name: 'lantern_people' },
      data: {
        status: 'EXPIRED',
        failureReason: `lantern_refresh_pending:${Date.now() - 1}:${randomUUID()}`,
      },
    });
    const expired = await fetch(`${base}/token`, { headers: headers(users[1]) });
    assert.equal(expired.status, 409);
    assert.equal(((await expired.json()) as { code: string }).code, 'LANTERN_RECONNECT_REQUIRED');
    assert.equal(refreshes, users.length, 'Expired claims must never replay a one-time refresh');
  } finally {
    for (const release of releases) release();
    await pending?.catch(() => undefined);
    backend.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => backend.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
    await admin.integration.deleteMany({
      where: { userId: { in: users }, name: 'lantern_people' },
    });
    await admin.$disconnect();
    await prisma.$disconnect();
    for (const key of [
      'CLAUDE_CREDENTIAL_DECRYPTION_KEY',
      'BACKEND_API_KEY',
      'LANTERN_PEOPLE_API_ORIGIN',
    ]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}
