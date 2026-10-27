#!/usr/bin/env tsx
/**
 * Multi-instance blackbox: the backend must stay correct when two Render
 * instances serve the same users from one Postgres database.
 *
 * Every case runs the real module code in two separate Node processes
 * (multi-instance.instance.ts), each with its own module memory, against the
 * runner's database. A READY/GO barrier makes their operations overlap.
 *
 *  - an AgentCard PKCE connect started on A completes on B
 *  - the per-user SMS commit lock serializes commits across instances
 *  - a WhatsApp redelivery that lands on the other instance is a duplicate
 *  - two instances' Gmail sync ticks claim one integration once
 *  - a Plaid item sync runs on one instance at a time
 *  - concurrent AgentCard token refreshes rotate the refresh token once
 *  - a compute connect session owned by A can be polled and cancelled from B
 *  - a held lease is renewed past its TTL, so no instance takes it over
 *  - a Plaid sync that lost its lease cannot overwrite the newer sync's cursor
 *
 * Usage: npx tsx src/tests/blackbox/multi-instance.blackbox.ts
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { saveUserToken } from '../../providers/agentcard/store';
import { claimPlaidItemSync } from '../../domains/integrations/service.plaidTransactions';
import { markPlaidItemSyncSucceeded } from '../../domains/integrations/repo.plaid';

config();

const INSTANCE_SCRIPT = join(__dirname, 'multi-instance.instance.ts');

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

interface Instance {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  result: Promise<Record<string, unknown>>;
}

function startInstance(op: string, args: string[], env: Record<string, string> = {}): Instance {
  const child = spawn(process.execPath, ['--import', 'tsx', INSTANCE_SCRIPT, op, ...args], {
    cwd: join(__dirname, '..', '..', '..'),
    env: { ...process.env, ...env },
  });
  let out = '';
  let err = '';
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
    if (out.includes('READY\n')) markReady();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      if (line === undefined) {
        reject(new Error(`instance ${op} exited ${code} without a result: ${err.slice(-400)}`));
        return;
      }
      resolve(JSON.parse(line.slice('RESULT '.length)) as Record<string, unknown>);
    });
  });
  return { child, ready, result };
}

/** Run one operation per instance with their critical sections released together. */
async function concurrently(
  ops: Array<[string, string[]]>,
  env: Record<string, string> = {}
): Promise<Array<Record<string, unknown>>> {
  const instances = ops.map(([op, args]) => startInstance(op, args, env));
  await Promise.all(instances.map((i) => i.ready));
  for (const i of instances) i.child.stdin.write('GO\n');
  return Promise.all(instances.map((i) => i.result));
}

async function main(): Promise<void> {
  const userId = randomUUID();
  await prisma.user.create({ data: { userId, name: 'Multi-instance fixture user' } });
  const integrationIds: string[] = [];

  try {
    await test('an AgentCard PKCE connect started on instance A completes on B', async () => {
      const state = `mi-${randomUUID()}`;
      const [put] = await concurrently([['pkce-put', [state, userId, 'verifier-xyz']]]);
      assert(put.ok === true, `put failed: ${JSON.stringify(put)}`);
      const [take] = await concurrently([['pkce-take', [state]]]);
      assert(take.found === true, 'instance B must find the PKCE state instance A stored');
      assert(take.userId === userId, 'the state must resolve to the starting user');
      const [again] = await concurrently([['pkce-take', [state]]]);
      assert(again.found === false, 'PKCE state must stay single-use across instances');
    });

    await test('the per-user SMS commit lock serializes commits across instances', async () => {
      const lockUser = randomUUID();
      const [a, b] = await concurrently([
        ['sms-lock', [lockUser, '1500']],
        ['sms-lock', [lockUser, '1500']],
      ]);
      const [first, second] = [a, b].sort(
        (x, y) => Number(x.enteredAt) - Number(y.enteredAt)
      ) as Array<{ enteredAt: number; leftAt: number }>;
      assert(
        second.enteredAt >= first.leftAt,
        `commits overlapped: second entered ${first.leftAt - second.enteredAt}ms before first left`
      );
    });

    await test('a WhatsApp redelivery that lands on the other instance is a duplicate', async () => {
      const wamid = `wamid.mi-${randomUUID()}`;
      const results = await concurrently([
        ['wa-dedupe', [wamid]],
        ['wa-dedupe', [wamid]],
      ]);
      const duplicates = results.filter((r) => r.duplicate === true).length;
      assert(duplicates === 1, `exactly one delivery must be a duplicate, got ${duplicates}`);
    });

    await test("two instances' Gmail sync ticks claim one integration once", async () => {
      const integration = await prisma.integration.create({
        data: {
          userId,
          type: 'DATA_SOURCE',
          name: 'gmail',
          status: 'CONNECTED',
          isActive: true,
          accountId: `mi-${randomUUID()}`,
        },
      });
      integrationIds.push(integration.id);
      const results = await concurrently([
        ['gmail-claim', [integration.id]],
        ['gmail-claim', [integration.id]],
      ]);
      const claims = results.filter((r) => r.claimed === true).length;
      assert(claims === 1, `exactly one instance may sync the integration, got ${claims}`);
    });

    await test('a Plaid item sync runs on one instance at a time', async () => {
      const itemRowId = `mi-${randomUUID()}`;
      const results = await concurrently([
        ['plaid-claim', [itemRowId, '1500']],
        ['plaid-claim', [itemRowId, '1500']],
      ]);
      const claims = results.filter((r) => r.claimed === true).length;
      assert(claims === 1, `exactly one instance may sync the item, got ${claims}`);
      const [after] = await concurrently([['plaid-claim', [itemRowId, '0']]]);
      assert(after.claimed === true, 'a released claim must be claimable again');
    });
    await test('concurrent AgentCard token refreshes rotate the refresh token once', async () => {
      // AgentCard rotates the refresh token on every use and rejects a reused one.
      let current = 'rt_0';
      let refreshes = 0;
      const server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const presented = new URLSearchParams(body).get('refresh_token');
          setTimeout(() => {
            res.setHeader('content-type', 'application/json');
            if (presented !== current) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'invalid_grant' }));
              return;
            }
            refreshes += 1;
            current = `rt_${refreshes}`;
            res.end(
              JSON.stringify({
                access_token: `at_${refreshes}`,
                refresh_token: current,
                token_type: 'bearer',
                expires_in: 3600,
              })
            );
          }, 800);
        });
      });
      server.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      const env = {
        AGENTCARD_TOKEN_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`,
        AGENTCARD_OAUTH_CLIENT_ID: 'multi-instance-test',
        AGENTCARD_PUBLIC_URL: 'http://localhost:9',
      };
      try {
        await saveUserToken(userId, {
          accessToken: 'at_expired',
          refreshToken: 'rt_0',
          tokenType: 'bearer',
          expiresAt: Date.now() - 60_000,
        });
        const results = await concurrently(
          [
            ['agentcard-refresh', [userId]],
            ['agentcard-refresh', [userId]],
          ],
          env
        );
        const errors = results.filter((r) => r.error !== undefined);
        assert(errors.length === 0, `a refresh failed: ${JSON.stringify(errors)}`);
        assert(refreshes === 1, `the refresh token must rotate once, rotated ${refreshes}x`);
        assert(
          results.every((r) => r.accessToken === 'at_1'),
          `both instances must use the one rotated token: ${JSON.stringify(results)}`
        );
      } finally {
        server.close();
      }
    });
    await test('a compute connect session owned by A can be polled and cancelled from B', async () => {
      const connectId = `claude-mi-${randomUUID()}`;
      const [host, peer] = await concurrently([
        ['connect-host', [connectId, userId, '8000']],
        ['connect-peer', [connectId, userId]],
      ]);
      const poll = peer.poll as { state?: string; stage?: string; liveViewUrl?: string };
      assert(
        poll.state === 'pending',
        `B must see the session pending, got ${JSON.stringify(poll)}`
      );
      assert(poll.stage === 'awaiting_human', `B must see the live stage, got ${poll.stage}`);
      assert(poll.liveViewUrl === 'https://live.example/mi', 'B must see the live view URL');
      const foreign = peer.foreign as { state?: string };
      assert(foreign.state === 'unknown', "another user must not read the session's snapshot");
      assert(host.released === true, "B's cancel must release the browser A owns");
    });
    await test('a held lease is renewed past its TTL, so no instance takes it over', async () => {
      const key = `mi-${randomUUID()}`;
      const [holder, peer] = await concurrently([
        ['lease-hold', [key, '3000', '9000']],
        ['lease-try', [key, '3000', '6000']],
      ]);
      assert(holder.held === true, 'the holder must acquire the lease');
      assert(peer.acquired === false, 'a renewed lease must not be taken over after its TTL');
      assert(holder.lost === false, 'the holder must not have lost its lease');
    });
    await test("a Plaid sync that lost its lease cannot overwrite the newer sync's cursor", async () => {
      const integration = await prisma.integration.create({
        data: {
          userId,
          type: 'DATA_SOURCE',
          name: 'plaid',
          status: 'CONNECTED',
          accountId: `mi-${randomUUID()}`,
        },
      });
      integrationIds.push(integration.id);
      const item = await prisma.plaidItem.create({
        data: {
          userId,
          integrationId: integration.id,
          plaidItemId: `mi-${randomUUID()}`,
          encryptedAccessToken: 'mi-not-a-token',
        },
      });
      const stale = await claimPlaidItemSync(item.id);
      assert(stale !== null, 'the first sync must claim the item');
      try {
        // The first sync stalls past its TTL and a newer sync takes the item over.
        await prisma.$executeRaw`
          UPDATE "SharedEphemeralState" SET "expiresAt" = now() - interval '1 second'
          WHERE namespace = 'plaid-item-sync' AND key = ${item.id}
        `;
        const fresh = await claimPlaidItemSync(item.id);
        assert(fresh !== null, 'the newer sync must take over the expired lease');
        try {
          assert(
            await markPlaidItemSyncSucceeded(item.id, 'cursor-new', undefined, fresh.fence),
            'the lease holder must write its cursor'
          );
          assert(
            !(await markPlaidItemSyncSucceeded(item.id, 'cursor-stale', undefined, stale.fence)),
            'the superseded sync must be fenced out'
          );
          const row = await prisma.plaidItem.findUnique({ where: { id: item.id } });
          assert(row?.cursor === 'cursor-new', `cursor must stay the newer sync's: ${row?.cursor}`);
        } finally {
          await fresh.release();
        }
      } finally {
        await stale.release();
        await prisma.plaidItem.deleteMany({ where: { id: item.id } });
      }
    });
  } finally {
    await prisma.integration.deleteMany({ where: { userId } });
    await prisma.integration.deleteMany({ where: { id: { in: integrationIds } } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  }

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`\n✅ multi-instance blackbox: ${passed}/${passed} passed`);
}

void main();
