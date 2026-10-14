/** Offline, actual-router credential cases, registered in the integration suite. */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { generateKeyPairSync, createPublicKey, randomUUID } from 'node:crypto';
import express from 'express';
import { prisma } from '../../providers/database';
import { encryptPasswordForStorage } from '../../providers/credentialEnvelope';
import { decryptCredentialEnvelope } from '../../providers/claudeCredentials';
import { generateSupabaseSession } from '../../providers/sessionTokens';
import integrationRoutes from '../../domains/integrations/routes';
import { assertLocalDatabase } from './assertLocalDatabase';
import { runLanternSmallPoolRegression } from './integrations.lantern-pool.cases';
import { testLanternImportCommand } from './integrations.lantern-import.cases';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address !== null && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

export async function testLanternCredentials(): Promise<void> {
  assertLocalDatabase();
  const original = { ...process.env };
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(privateKey).toString('base64');
  process.env.BACKEND_API_KEY = 'lantern-fixture-internal-key';
  const users = [`lantern-fixture-${randomUUID()}`, `lantern-fixture-${randomUUID()}`];
  let refreshes = 0;
  let checks = 0;
  let responseMode = 'success';
  let checkAllowed = true;
  const readyCheck = {
    connected: true,
    ready: true,
    workspace: { id: 'fixture-workspace', name: 'Fixture workspace' },
    blockers: [],
  };
  let checkData: unknown = readyCheck;
  let holdRefresh = false;
  let releaseRefresh: (() => void) | undefined;
  let receivedForm: URLSearchParams | undefined;
  const constraint = `lantern_fixture_${randomUUID().replaceAll('-', '')}`;
  let constraintInstalled = false;
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/operations/connection_check') {
        checks++;
        if (!checkAllowed) {
          res.statusCode = 401;
          res.end('{}');
          return;
        }
        res.end(JSON.stringify({ ok: true, data: checkData }));
        return;
      }
      if (req.url !== '/oauth/token') {
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      refreshes++;
      receivedForm = new URLSearchParams(Buffer.concat(chunks).toString());
      if (holdRefresh) {
        releaseRefresh = () =>
          res.end(
            JSON.stringify({
              access_token: 'fixture-rotated-access',
              refresh_token: 'lantern_rt_rotated',
              expires_in: 3600,
              connection_id: 'grant_fixture',
            })
          );
        return;
      }
      if (responseMode === 'timeout') return;
      if (responseMode === 'redirect') {
        res.statusCode = 307;
        res.setHeader('location', '/oauth/token');
        res.end('{}');
        return;
      }
      if (responseMode === '401') res.statusCode = 401;
      res.end(
        JSON.stringify(
          responseMode === 'malformed'
            ? {}
            : {
                access_token: 'fixture-rotated-access',
                refresh_token: 'lantern_rt_rotated',
                expires_in: 3600,
                connection_id: responseMode === 'different-grant' ? 'grant_other' : 'grant_fixture',
              }
        )
      );
    });
  });
  const origin = await listen(upstream);
  process.env.LANTERN_PEOPLE_API_ORIGIN = origin;
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', integrationRoutes);
  const backend = createServer(app);
  const base = await listen(backend);
  const headers = {
    'content-type': 'application/json',
    'x-api-key': process.env.BACKEND_API_KEY,
    'x-user-id': users[0],
  };
  const connection = () => ({
    apiUrl: origin,
    token: 'fixture-original-access',
    refreshToken: 'lantern_rt_original',
    expiresAt: Date.now() + 3600000,
    connectionId: 'grant_fixture',
  });
  const envelope = (value: unknown) => encryptPasswordForStorage(JSON.stringify(value), publicKey);
  const upload = (value: unknown, auth: Record<string, string> = headers) =>
    fetch(`${base}/api/integrations/lantern-people/credentials/upload`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ encryptedCredentials: envelope(value) }),
    });
  const token = (auth: Record<string, string> = headers) =>
    fetch(`${base}/api/integrations/lantern-people/credentials/token`, { headers: auth });
  try {
    assert.equal((await upload(connection(), { 'content-type': 'application/json' })).status, 401);
    assert.equal((await token({ 'x-api-key': headers['x-api-key'] })).status, 400);
    assert.equal((await upload({ ...connection(), apiUrl: 'https://unsafe.example' })).status, 400);
    assert.equal((await upload({ ...connection(), expiresAt: Date.now() - 1 })).status, 400);
    assert.equal((await upload({ ...connection(), refreshToken: '' })).status, 400);
    assert.equal((await upload({ ...connection(), token: 'people-demo-local' })).status, 400);
    assert.equal(checks, 0);
    checkAllowed = false;
    assert.equal((await upload(connection())).status, 400);
    assert.equal(
      await prisma.integration.count({ where: { userId: { in: users }, name: 'lantern_people' } }),
      0
    );
    checkAllowed = true;
    for (checkData of [
      {},
      { ...readyCheck, connected: false },
      { ...readyCheck, ready: false },
      { connected: true, ready: true },
      { ...readyCheck, workspace: {} },
      { ...readyCheck, workspace: { id: ' ' } },
    ]) {
      assert.equal(
        (await upload(connection())).status,
        400,
        'Import must reject an unready connection_check'
      );
      assert.equal(
        await prisma.integration.count({
          where: { userId: { in: users }, name: 'lantern_people' },
        }),
        0
      );
    }
    checkData = readyCheck;
    assert.equal((await upload(connection())).status, 200);
    assert.equal(checks, 8);
    const find = () =>
      prisma.integration.findUniqueOrThrow({
        where: {
          userId_name_accountId: { userId: users[0], name: 'lantern_people', accountId: '' },
        },
      });
    const row = await find();
    assert.equal(row.type, 'TOOL_SETUP');
    assert.equal(row.status, 'CONNECTED');
    assert.equal(row.isActive, true);
    assert(!JSON.stringify(row.config).includes('fixture-original-access'));
    const fresh = await token();
    assert.equal(fresh.status, 200);
    assert.equal(fresh.headers.get('cache-control'), 'no-store');
    const freshBody = (await fresh.json()) as Record<string, unknown>;
    assert.equal(freshBody.accessToken, 'fixture-original-access');
    assert(!('refreshToken' in freshBody));
    assert.equal(refreshes, 0);
    assert.equal((await find()).updatedAt.getTime(), row.updatedAt.getTime());
    assert.equal((await token({ ...headers, 'x-user-id': users[1] })).status, 404);
    const session = generateSupabaseSession(users[0], '');
    const ownerHeaders = {
      'content-type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
      'x-user-id': users[1],
    };
    assert.equal((await upload(connection(), ownerHeaders)).status, 200);
    assert.equal(
      await prisma.integration.count({ where: { userId: users[1], name: 'lantern_people' } }),
      0
    );
    const impersonated = generateSupabaseSession(users[0], '', { actorUserId: users[1] });
    assert.equal(
      (
        await upload(connection(), {
          ...ownerHeaders,
          Authorization: `Bearer ${impersonated.access_token}`,
        })
      ).status,
      403
    );
    assert.equal(
      (await token({ Authorization: `Bearer ${session.access_token}`, 'x-user-id': users[0] }))
        .status,
      403
    );
    const listed = await fetch(`${base}/api/integrations`, { headers });
    const listedText = await listed.text();
    assert.equal(listed.status, 200);
    assert(!listedText.includes('encryptedCredentials'));
    assert(!listedText.includes('fixture-original-access'));
    const genericPatch = await fetch(`${base}/api/integrations/lantern_people`, {
      method: 'PATCH',
      headers: ownerHeaders,
      body: JSON.stringify({ config: { token: 'forbidden-plaintext' } }),
    });
    assert.equal(genericPatch.status, 400);
    const stale = () =>
      prisma.integration.update({
        where: { id: row.id },
        data: {
          status: 'CONNECTED',
          isActive: true,
          failureReason: null,
          config: {
            encryptedCredentials: envelope({ ...connection(), expiresAt: Date.now() + 1000 }),
          },
        },
      });
    await stale();
    holdRefresh = true;
    const burst = Promise.all(Array.from({ length: 8 }, () => token()));
    let observedLocks = 0;
    try {
      // The upstream response is held while the real database admits callers.
      // Count native advisory owners AND waiters for this exact tenant key.
      await delay(500);
      assert(releaseRefresh !== undefined, 'Refresh must reach the loopback fixture');
      const locks = await prisma.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) AS count FROM pg_locks WHERE locktype = 'advisory' AND classid::bigint = ((hashtextextended(${`lantern_people:${users[0]}`}, 0) >> 32) & 4294967295) AND objid::bigint = (hashtextextended(${`lantern_people:${users[0]}`}, 0) & 4294967295) AND objsubid = 1`;
      observedLocks = Number(locks[0].count);
    } finally {
      holdRefresh = false;
      releaseRefresh?.();
    }
    const concurrent = await burst;
    assert.equal(observedLocks, 0, 'Refresh HTTP must hold zero native locks');
    assert(concurrent.every((result) => result.status === 200));
    assert.equal(refreshes, 1);
    assert.equal(receivedForm?.get('client_id'), 'lantern-cli');
    assert.equal(receivedForm?.get('resource'), `${origin}/mcp`);
    assert.equal(receivedForm?.get('grant_type'), 'refresh_token');
    const rotated = (await find()).config as { encryptedCredentials: string };
    const saved = JSON.parse(
      decryptCredentialEnvelope(
        rotated.encryptedCredentials,
        process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY!
      )!
    ) as Record<string, unknown>;
    assert.equal(saved.refreshToken, 'lantern_rt_rotated');
    assert.equal(saved.connectionId, 'grant_fixture');
    await stale();
    const beforePersistenceFailure = refreshes;
    // Only this random fixture user is constrained. Reject final persistence
    // after the real HTTP refresh while allowing the durable EXPIRED marker.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Integration" ADD CONSTRAINT "${constraint}" CHECK ("userId" <> '${users[0]}' OR "status" <> 'CONNECTED') NOT VALID`
    );
    constraintInstalled = true;
    try {
      assert.equal((await token()).status, 503);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "Integration" DROP CONSTRAINT "${constraint}"`);
      constraintInstalled = false;
    }
    assert.equal((await find()).status, 'EXPIRED');
    assert.equal((await token()).status, 409);
    assert.equal(refreshes, beforePersistenceFailure + 1);
    for (responseMode of ['malformed', '401', 'different-grant', 'redirect', 'timeout']) {
      await stale();
      const before: number = refreshes;
      const failed = await token();
      assert.equal(failed.status, 409);
      const failure = (await failed.json()) as { error: string; code: string };
      assert.equal(failure.code, 'LANTERN_RECONNECT_REQUIRED');
      assert(!JSON.stringify(failure).includes('lantern_rt_'));
      assert.equal((await token()).status, 409);
      assert.equal(refreshes, before + 1);
      assert.equal((await find()).status, 'EXPIRED');
    }
    // Reimporting the consumed grant cannot clear a reconnect fence.
    assert.equal((await upload(connection())).status, 409);
    assert.equal(
      (await upload({ ...connection(), connectionId: 'grant_reconnected' })).status,
      200
    );
    assert.equal((await token()).status, 200);
    await testLanternImportCommand({
      base,
      userId: users[0],
      connection: { ...connection(), connectionId: 'grant_imported' },
      readSaved: async () => {
        const imported = (await find()).config as { encryptedCredentials: string };
        return JSON.parse(
          decryptCredentialEnvelope(
            imported.encryptedCredentials,
            process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY!
          )!
        ) as Record<string, unknown>;
      },
    });
    await runLanternSmallPoolRegression();
    // A durable pre-request marker from an interrupted process cannot replay.
    await prisma.integration.update({
      where: { id: row.id },
      data: {
        status: 'EXPIRED',
        isActive: false,
        failureReason: 'lantern_refresh_outcome_unknown',
      },
    });
    const before: number = refreshes;
    assert.equal((await token()).status, 409);
    assert.equal(refreshes, before);
  } finally {
    if (constraintInstalled)
      await prisma.$executeRawUnsafe(`ALTER TABLE "Integration" DROP CONSTRAINT "${constraint}"`);
    backend.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => backend.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
    await prisma.integration.deleteMany({
      where: { userId: { in: users }, name: 'lantern_people' },
    });
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
