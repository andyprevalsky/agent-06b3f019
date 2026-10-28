#!/usr/bin/env tsx
/**
 * Backend-native shared compute authority contract.
 * Three real local PostgreSQL stores/routers; real TypeScript Foundry consumer;
 * all provider responses are sealed fixtures. Python cross-language evidence
 * remains separately pinned to 22ef/edd86 and is NOT claimed by this domain.
 */
import assert from 'assert';
import { type ChildProcess, execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';

import {
  AUTHORITY_KEY,
  GUEST_KEY,
  USER_ID,
  backendDir,
  localServerUrl,
  databaseUrl,
  encryptEnvelope,
  startBackend,
  fetchLease,
  post,
  foundryCall,
  assertInvalidFoundryInputs,
} from './compute-token-authority.support';

async function main() {
  if (process.argv.includes('--read-only-production')) {
    const { runReadOnlyProductionAuthority } = await import('./compute-token-authority.readonly');
    await runReadOnlyProductionAuthority();
    return;
  }
  if (process.argv.includes('--read-only-fixtures')) {
    const { testReadOnlyAuthority } = await import('./compute-token-authority.readonly');
    await testReadOnlyAuthority();
    return;
  }
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
  let primaryFailure: unknown;
  let failed = false;
  const cleanupErrors: unknown[] = [];
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

    const authority = await startBackend(
      'authority',
      urls.authority,
      decryptionKey,
      {
        BACKEND_API_KEY: AUTHORITY_KEY,
      },
      children
    );
    const guestEnv = {
      BACKEND_API_KEY: GUEST_KEY,
      COMPUTE_TOKEN_AUTHORITY_URL: authority.baseUrl,
      COMPUTE_TOKEN_AUTHORITY_API_KEY: AUTHORITY_KEY,
    };
    const guestA = await startBackend('guest A', urls.guestA, decryptionKey, guestEnv, children);
    const guestB = await startBackend('guest B', urls.guestB, decryptionKey, guestEnv, children);

    // First assertion must expose the actual missing-route regression on old runtime.
    const initialRead = await fetch(
      `${guestA.baseUrl}/api/integrations/compute-code/foundry-deployment/cooldown?keys=probe.example.test:deployment`,
      { headers: { 'X-API-Key': GUEST_KEY } }
    );
    assert.strictEqual(initialRead.status, 200, 'authenticated shared cooldown GET must exist');
    assert.deepStrictEqual(await initialRead.json(), { cooldowns: {} });
    const { GPT_LINEAGE_CAPACITY } = await import('../../providers/computeCredentials');
    const { testReadOnlyAuthority } = await import('./compute-token-authority.readonly');
    await testReadOnlyAuthority();

    const deniedRead = await fetch(
      `${guestA.baseUrl}/api/integrations/compute-code/foundry-deployment/cooldown?keys=auth.example.test:deployment`,
      { headers: { 'X-API-Key': 'invalid-fixture-key' } }
    );
    assert.strictEqual(deniedRead.status, 401, 'invalid key cannot read shared authority');
    const deniedWrite = await fetch(
      `${guestA.baseUrl}/api/integrations/compute-code/token/rate-limited`,
      {
        method: 'POST',
        headers: { 'X-API-Key': 'invalid-fixture-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'foundry',
          source: 'pool',
          region: 'auth.example.test',
          deployment: 'deployment',
        }),
      }
    );
    assert.strictEqual(deniedWrite.status, 401, 'invalid key cannot mark shared authority');
    assert.strictEqual(
      await authorityDb.integration.count({ where: { name: 'foundry_deployment_cooldown' } }),
      0
    );
    console.log('PASS invalid internal keys cannot read or mutate authority');

    const cooldownRows = () =>
      authorityDb.integration.findMany({
        where: { name: 'foundry_deployment_cooldown' },
        orderBy: { id: 'asc' },
      });
    await assertInvalidFoundryInputs(authority.baseUrl, cooldownRows);

    // A served reset must join the same per-deployment lock as a mark.
    let resetSettled = false;
    let pendingReset: Promise<unknown> | undefined;
    await authorityDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'foundry-cooldown:serialization.example.test:deployment'}))`;
      pendingReset = foundryCall(guestA.baseUrl, 'foundry-deployment/served', {
        region: 'serialization.example.test',
        deployment: 'deployment',
      }).then((value) => {
        resetSettled = true;
        return value;
      });
      let waiting = false;
      for (let i = 0; i < 100 && !waiting && !resetSettled; i++) {
        const rows = await authorityDb.$queryRaw<
          Array<{ waiting: boolean }>
        >`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid::bigint=(hashtext(${'foundry-cooldown:serialization.example.test:deployment'})::bigint & 4294967295)) AS waiting`;
        waiting = rows[0].waiting;
        if (!waiting) await delay(20);
      }
      assert.strictEqual(resetSettled, false, 'served reset bypassed the mark transaction lock');
      assert(waiting, 'backend reset must be observed waiting on the exact deployment lock');
    });
    await pendingReset;
    console.log('PASS real backend reset serializes with mark lock');

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

    // 3. A real TS consumer on guest A cools guest B and the production-store consumer.
    const tsInvoke = (baseUrl: string, apiKey: string, body: Record<string, unknown> = {}) =>
      fetch(`${baseUrl}/test-foundry`, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const rejected = await tsInvoke(guestA.baseUrl, GUEST_KEY, { reject: true });
    const rejectedBody = (await rejected.json()) as { hits: string[] };
    assert.strictEqual(rejected.status, 200, JSON.stringify(rejectedBody));
    assert.strictEqual(
      rejectedBody.hits.length,
      2,
      'TS must report 429 then use the other deployment'
    );
    assert.deepStrictEqual(
      [...rejectedBody.hits].sort(),
      ['gpt-6.1-sol-a', 'gpt-6.1-sol-b'],
      'Ultra must rotate through both configured GPT-6.1 fixture deployments'
    );
    const cooledDeployment = rejectedBody.hits[0];
    for (const [baseUrl, apiKey] of [
      [guestB.baseUrl, GUEST_KEY],
      [authority.baseUrl, AUTHORITY_KEY],
    ]) {
      const response = await tsInvoke(baseUrl, apiKey);
      const result = (await response.json()) as { hits: string[] };
      assert.strictEqual(response.status, 200, JSON.stringify(result));
      assert(result.hits.length > 0, 'fixture must exercise mocked Azure transport');
      assert(!result.hits.includes(cooledDeployment), 'TS consumer bypassed shared cooldown');
    }
    await authorityDb.integration.updateMany({
      where: {
        name: 'foundry_deployment_cooldown',
        accountId: `foundry-cta.example.test:${cooledDeployment}`,
      },
      data: { rateLimitedUntil: new Date(Date.now() - 1000) },
    });
    const reopened = await tsInvoke(guestB.baseUrl, GUEST_KEY);
    const reopenedBody = (await reopened.json()) as { hits: string[] };
    assert.strictEqual(reopened.status, 200, JSON.stringify(reopenedBody));
    assert.strictEqual(reopenedBody.hits[0], cooledDeployment, 'expiry must reopen the same route');
    console.log('PASS TypeScript guest/authority consumers share cooldown and observe expiry');

    const prepareExpiredRoutes = async () => {
      for (const deployment of ['gpt-6.1-sol-a', 'gpt-6.1-sol-b']) {
        await foundryCall(guestA.baseUrl, 'token/rate-limited', {
          type: 'foundry',
          source: 'pool',
          region: 'foundry-cta.example.test',
          deployment,
        });
      }
      await authorityDb.integration.updateMany({
        where: { name: 'foundry_deployment_cooldown' },
        data: { rateLimitedUntil: new Date(Date.now() - 1000) },
      });
    };
    for (const resetFailure of ['malformed', '500', 'throw']) {
      await prepareExpiredRoutes();
      const before = await cooldownRows();
      const response = await tsInvoke(guestA.baseUrl, GUEST_KEY, { resetFailure });
      const result = (await response.json()) as {
        hits: string[];
        visible: string[];
        resets: number;
        fallbackRequests: number;
      };
      assert.strictEqual(response.status, 200, JSON.stringify(result));
      assert.deepStrictEqual(
        result.visible,
        ['ok'],
        'reset failure must retain the successful answer'
      );
      assert.strictEqual(result.hits.length, 1, 'reset failure must not replay provider output');
      assert.strictEqual(result.fallbackRequests, 0);
      assert.strictEqual(result.resets, 1);
      assert.deepStrictEqual(
        await cooldownRows(),
        before,
        'failed reset must retain shared strikes'
      );
      for (const guest of clients.slice(1)) {
        assert.strictEqual(
          await guest.integration.count({
            where: { name: 'foundry_deployment_cooldown' },
          }),
          0,
          'remote reset failure must not create guest-local authority state'
        );
      }
    }
    await prepareExpiredRoutes();
    const beforeLocalReset = await cooldownRows();
    const localResponse = await tsInvoke(authority.baseUrl, AUTHORITY_KEY);
    const localResult = (await localResponse.json()) as {
      hits: string[];
      visible: string[];
      fallbackRequests: number;
    };
    assert.strictEqual(localResponse.status, 200, JSON.stringify(localResult));
    assert.deepStrictEqual(localResult.visible, ['ok']);
    assert.strictEqual(localResult.hits.length, 1);
    assert.strictEqual(localResult.fallbackRequests, 0);
    const resetAccount = `foundry-cta.example.test:${localResult.hits[0]}`;
    const afterLocalReset = await cooldownRows();
    const resetRow = afterLocalReset.find((row) => row.accountId === resetAccount);
    assert(resetRow);
    assert.strictEqual((resetRow.config as { strikes: number }).strikes, 0);
    assert.deepStrictEqual(
      resetRow.rateLimitedUntil,
      beforeLocalReset.find((row) => row.accountId === resetAccount)?.rateLimitedUntil
    );
    assert(resetRow.rateLimitedUntil && resetRow.rateLimitedUntil.getTime() <= Date.now());
    const localResetRead = await fetch(
      `${authority.baseUrl}/api/integrations/compute-code/foundry-deployment/cooldown?keys=${encodeURIComponent(resetAccount)}`,
      { headers: { 'X-API-Key': AUTHORITY_KEY } }
    );
    assert.strictEqual(localResetRead.status, 200);
    const localResetWire = (await localResetRead.json()) as {
      cooldowns: Record<
        string,
        { rateLimitedUntil: string | null; remainingSeconds: number; strikes: number }
      >;
    };
    assert.deepStrictEqual(localResetWire.cooldowns[resetAccount], {
      rateLimitedUntil: null,
      remainingSeconds: 0,
      strikes: 0,
    });
    assert.deepStrictEqual(
      afterLocalReset.filter((row) => row.accountId !== resetAccount),
      beforeLocalReset.filter((row) => row.accountId !== resetAccount),
      'local successful reset must not change another deployment'
    );
    console.log(
      'PASS successful output survives failed reset and direct-store success resets only its deployment'
    );

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
    const testFoundry = (body: Record<string, unknown>) =>
      fetch(`${guestA.baseUrl}/test-foundry`, {
        method: 'POST',
        headers: { 'X-API-Key': GUEST_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const directOverflow = await testFoundry({ invalidHint: 1e100 });
    assert.strictEqual(
      directOverflow.status,
      400,
      'direct service rejects impossible dates as validation errors'
    );
    assert.deepStrictEqual(await directOverflow.json(), { invalidRequest: true });
    const rejectOverflow = async () => {
      const before = await authorityDb.integration.findMany({
        where: { name: 'foundry_deployment_cooldown', accountId },
        select: { rateLimitedUntil: true, config: true },
      });
      const response = await fetch(
        `${guestA.baseUrl}/api/integrations/compute-code/token/rate-limited`,
        {
          method: 'POST',
          headers: { 'X-API-Key': GUEST_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'foundry',
            source: 'pool',
            ...target,
            retryAfterSeconds: 1e100,
          }),
        }
      );
      assert.strictEqual(
        response.status,
        400,
        'unrepresentable provider deadline must be a request error'
      );
      assert.deepStrictEqual(
        await authorityDb.integration.findMany({
          where: { name: 'foundry_deployment_cooldown', accountId },
          select: { rateLimitedUntil: true, config: true },
        }),
        before,
        'invalid provider deadline must not create or modify shared state'
      );
    };
    await rejectOverflow();
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
    await rejectOverflow();
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
    // A subsequent backend rejection remains shared across independent guest consumers.
    await authorityDb.integration.updateMany({
      where: { name: 'foundry_deployment_cooldown' },
      data: { rateLimitedUntil: new Date(Date.now() - 1000) },
    });
    const tsResponse = await fetch(`${guestA.baseUrl}/test-foundry`, {
      method: 'POST',
      headers: { 'X-API-Key': GUEST_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reject: true }),
    });
    const tsResult = (await tsResponse.json()) as { hits: string[] };
    assert.strictEqual(tsResponse.status, 200, JSON.stringify(tsResult));
    assert.strictEqual(
      tsResult.hits.length,
      2,
      'TypeScript must report rate limit then use another deployment'
    );
    const peerAfterTs = await tsInvoke(guestB.baseUrl, GUEST_KEY);
    const peerBody = (await peerAfterTs.json()) as { hits: string[] };
    assert.strictEqual(peerAfterTs.status, 200, JSON.stringify(peerBody));
    assert(!peerBody.hits.includes(tsResult.hits[0]), 'peer TS guest bypassed shared cooldown');
    const tsMark = await authorityDb.integration.findFirst({
      where: {
        name: 'foundry_deployment_cooldown',
        accountId: `foundry-cta.example.test:${tsResult.hits[0]}`,
      },
    });
    assert(
      tsMark?.rateLimitedUntil && tsMark.rateLimitedUntil.getTime() - Date.now() > 890000,
      'TypeScript must preserve provider 900-second advice'
    );
    console.log('PASS independent TypeScript guests share cooldowns and preserve long hints');
    for (const rejectKind of ['http', 'sse', 'visible']) {
      for (const reportFailure of ['500', 'malformed', 'throw']) {
        await authorityDb.integration.updateMany({
          where: { name: 'foundry_deployment_cooldown' },
          data: { rateLimitedUntil: new Date(Date.now() - 1000) },
        });
        const response = await testFoundry({ rejectKind, reportFailure });
        const result = (await response.json()) as {
          hits: string[];
          reports: number;
          visible: string[];
          isRoseServerError: boolean;
        };
        assert.strictEqual(response.status, 500);
        assert.strictEqual(
          result.isRoseServerError,
          true,
          `${rejectKind}/${reportFailure}: reporting error classification`
        );
        assert.strictEqual(result.reports, 1, 'report the actual rejection once');
        assert.strictEqual(
          result.hits.length,
          1,
          'do not retry a provider after authority failure'
        );
        assert.deepStrictEqual(result.visible, rejectKind === 'visible' ? ['partial'] : []);
      }
    }
    console.log(
      'PASS HTTP/SSE report failures preserve server-error type and visible-output safety'
    );
    for (const rejectKind of ['http', 'visible']) {
      await authorityDb.integration.updateMany({
        where: { name: 'foundry_deployment_cooldown' },
        data: { rateLimitedUntil: new Date(Date.now() - 1000) },
      });
      const response = await testFoundry({ rejectKind, reportFailure: '500', waterfall: true });
      const result = (await response.json()) as {
        hits: string[];
        reports: number;
        visible: string[];
        fallbackRequests: number;
      };
      assert.strictEqual(result.hits.length, 1);
      assert.strictEqual(result.reports, 1);
      if (rejectKind === 'visible') {
        assert.strictEqual(response.status, 500);
        assert.strictEqual(
          result.fallbackRequests,
          0,
          'visible output forbids outer waterfall replay'
        );
        assert.deepStrictEqual(result.visible, ['partial']);
      } else {
        assert.strictEqual(response.status, 200);
        assert.strictEqual(
          result.fallbackRequests,
          1,
          'pre-content server error permits normal waterfall'
        );
        assert.deepStrictEqual(result.visible, ['fallback']);
      }
    }
    console.log('PASS outer waterfall never replays visible output after a report failure');
  } catch (error) {
    primaryFailure = error;
    failed = true;
  } finally {
    const capture = async (operation: () => Promise<unknown> | unknown) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await Promise.all(
      children.map((child) =>
        capture(
          () =>
            new Promise<void>((resolve, reject) => {
              if (!child.pid || child.exitCode !== null || child.signalCode !== null)
                return resolve();
              const timer = setTimeout(() => {
                child.kill('SIGKILL');
              }, 5_000);
              child.once('exit', () => {
                clearTimeout(timer);
                resolve();
              });
              child.once('error', (error) => {
                clearTimeout(timer);
                reject(error);
              });
            })
        )
      )
    );
    await Promise.all(clients.map((client) => capture(() => client.$disconnect())));
    for (const name of Object.values(names)) {
      await capture(() =>
        admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      );
    }
    await capture(() => admin.$disconnect());
    await capture(() => fs.rmSync(tmp, { recursive: true, force: true }));
  }
  if (failed) {
    if (cleanupErrors.length > 0) console.error('Cleanup also failed:', cleanupErrors);
    throw primaryFailure;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Compute authority fixture cleanup failed');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
