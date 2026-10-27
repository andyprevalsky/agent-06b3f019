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
 *  - an SMS /clear on B supersedes a supervisor run in flight on A
 *  - an SMS /clear whose commit ack was lost advances the seq once
 *  - two instances minting one agent identity agree on one inbox
 *  - a revoked compute grant seen on two instances is re-minted once
 *  - B's Steel reaper skips a session A is still setting up
 *  - a WhatsApp redelivery that lands on the other instance is a duplicate
 *  - a WhatsApp claim whose commit ack was lost is not its own duplicate
 *  - two instances' Gmail sync ticks claim one integration once
 *  - a Plaid item sync runs on one instance at a time
 *  - concurrent AgentCard token refreshes rotate the refresh token once
 *  - a compute connect session owned by A can be polled and cancelled from B
 *  - a Mac on A serves a session that B starts, relays to and stops
 *  - an E2B code session created on A runs project commands from B
 *  - a held lease is renewed past its TTL, so no instance takes it over
 *  - a Plaid sync that lost its lease cannot overwrite the newer sync's cursor
 *
 * Usage: npx tsx src/tests/blackbox/multi-instance.blackbox.ts
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { createHmac, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { join } from 'node:path';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { retryWithBackoff } from '../../providers/retry';
import { saveUserToken } from '../../providers/agentcard/store';
import { claimPlaidItemSync } from '../../domains/integrations/service.plaidTransactions';
import { markPlaidItemSyncSucceeded } from '../../domains/integrations/repo.plaid';
import { createPrismaGrantStore, upsertAccountConnection } from '../../domains/compute-grants/repo';

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
  output: () => string;
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
  return { child, output: () => out, ready, result };
}

async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: count }, async () => {
      const server = createNetServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      return server;
    })
  );
  const ports = servers.map((server) => (server.address() as AddressInfo).port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const polls = Math.ceil(timeoutMs / 50);
  const met = await retryWithBackoff(async () => cond(), {
    maxRetries: polls,
    fixedDelays: Array<number>(polls).fill(50),
    shouldRetryResult: (ok) => !ok,
    component: 'MultiInstanceWait',
  });
  if (!met) throw new Error(`timed out waiting for ${what}`);
}

/** A WebSocket that records text frames, with a promise for the next matching one. */
async function frames(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  const seen: string[] = [];
  ws.on('message', (raw) => seen.push(raw.toString()));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const next = async (
    match: (frame: Record<string, unknown> | string) => boolean,
    what: string
  ) => {
    let found: string | undefined;
    await waitFor(() => {
      found = seen.find((text) => {
        let parsed: Record<string, unknown> | string = text;
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // plain text frame
        }
        return match(parsed);
      });
      return found !== undefined;
    }, what);
    seen.splice(seen.indexOf(found as string), 1);
    try {
      return JSON.parse(found as string) as Record<string, unknown>;
    } catch {
      return { text: found };
    }
  };
  return { ws, next };
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

    await test("an SMS /clear on instance B supersedes A's in-flight supervisor run", async () => {
      const smsUser = randomUUID();
      await prisma.user.create({ data: { userId: smsUser, name: 'Multi-instance SMS user' } });
      try {
        const [run, clear] = await concurrently([
          ['sms-run', [smsUser, '1500']],
          ['sms-clear', [smsUser]],
        ]);
        assert(clear.cleared === true, `clear failed: ${JSON.stringify(clear)}`);
        assert(typeof run.mySeq === 'number', `run failed: ${JSON.stringify(run)}`);
        assert(run.ownsReply === false, "A's run must not reply after B cleared the session");
      } finally {
        await prisma.smsSession.deleteMany({ where: { userId: smsUser } });
        await prisma.user.deleteMany({ where: { userId: smsUser } });
      }
    });

    await test('an SMS /clear whose commit ack was lost advances the seq once', async () => {
      const smsUser = randomUUID();
      await prisma.user.create({ data: { userId: smsUser, name: 'Multi-instance SMS user' } });
      try {
        await prisma.smsSession.create({
          data: { userId: smsUser, messages: JSON.stringify([]), lastInboundSeq: 5 },
        });
        const [clear] = await concurrently([['sms-clear-lost-ack', [smsUser]]]);
        assert(
          clear.dropped === true,
          `the proxy must drop the commit ack: ${JSON.stringify(clear)}`
        );
        const row = await prisma.smsSession.findUnique({ where: { userId: smsUser } });
        assert(
          row?.lastInboundSeq === 6,
          `the replayed clear advanced the seq to ${row?.lastInboundSeq}`
        );
      } finally {
        await prisma.smsSession.deleteMany({ where: { userId: smsUser } });
        await prisma.user.deleteMany({ where: { userId: smsUser } });
      }
    });

    await test('two instances minting one agent identity agree on one inbox', async () => {
      const mintUser = randomUUID();
      await prisma.user.create({ data: { userId: mintUser, name: 'Multi-instance mint user' } });
      try {
        // An identity on a retired domain is replaced on the next auth request.
        await prisma.agentIdentity.create({
          data: { userId: mintUser, email: 'agent@retired-domain.example' },
        });
        const results = await concurrently(
          [
            ['auth-mint', [mintUser]],
            ['auth-mint', [mintUser]],
          ],
          {
            PRIMITIVE_API_KEY: 'multi-instance-primitive',
            PRIMITIVE_DOMAIN: 'mail.multi-instance.test',
            AGENTPHONE_API_KEY: '',
          }
        );
        const stored = await prisma.agentIdentity.findUnique({ where: { userId: mintUser } });
        assert(
          results.every((r) => typeof r.email === 'string' && r.email === stored?.email),
          `both instances must be told the stored identity ${stored?.email}: ${JSON.stringify(results)}`
        );
      } finally {
        await prisma.mintedAccount.deleteMany({ where: { userId: mintUser } });
        await prisma.agentIdentity.deleteMany({ where: { userId: mintUser } });
        await prisma.user.deleteMany({ where: { userId: mintUser } });
      }
    });

    await test('a revoked compute grant seen on two instances is re-minted once', async () => {
      const grantUser = `mi-grant-${randomUUID()}`;
      const accountId = 'acct-mi';
      try {
        await upsertAccountConnection({
          userId: grantUser,
          provider: 'claude',
          accountId,
          accountEmail: 'mi@example.com',
          session: `session-${grantUser}`,
        });
        const original = await createPrismaGrantStore('cloud').saveGrant({
          userId: grantUser,
          provider: 'claude',
          accountId,
          accessToken: 'sk-ant-oat01-mi-original',
        });
        const results = await concurrently([
          ['grant-remint', [grantUser, accountId, original.grantId]],
          ['grant-remint', [grantUser, accountId, original.grantId]],
        ]);
        const minted = await prisma.computeGrant.count({
          where: { userId: grantUser, id: { not: original.grantId } },
        });
        assert(minted === 1, `the account must be re-minted once, minted ${minted}x`);
        assert(
          results.every((r) => r.accessToken !== null && r.accessToken === results[0].accessToken),
          `both instances must retry on the one replacement: ${JSON.stringify(results)}`
        );
      } finally {
        await prisma.computeGrant.deleteMany({ where: { userId: grantUser } });
        await prisma.computeAccountConnection.deleteMany({ where: { userId: grantUser } });
      }
    });

    await test("B's Steel reaper does not release a session A is still setting up", async () => {
      const sessionId = randomUUID();
      const [setup, reap] = await concurrently([
        ['steel-setup', [sessionId, '3000']],
        ['steel-reap', [sessionId, '1000']],
      ]);
      assert(setup.registered === true, `setup failed: ${JSON.stringify(setup)}`);
      const released = reap.released as string[] | undefined;
      assert(Array.isArray(released), `reaper failed: ${JSON.stringify(reap)}`);
      assert(released.length === 0, `B released A's in-flight session: ${released.join(',')}`);
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

    await test('a WhatsApp claim whose commit ack was lost is not its own duplicate', async () => {
      const wamid = `wamid.mi-${randomUUID()}`;
      const [first] = await concurrently([['wa-dedupe-lost-ack', [wamid]]]);
      assert(
        first.dropped === true,
        `the proxy must drop the commit ack: ${JSON.stringify(first)}`
      );
      assert(first.duplicate === false, 'a fresh message must not be skipped as a duplicate');
      const [redelivery] = await concurrently([['wa-dedupe', [wamid]]]);
      assert(redelivery.duplicate === true, "Meta's redelivery must still be a duplicate");
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
    await test('a Mac on instance A serves a session started, relayed and stopped from B', async () => {
      const deviceId = randomUUID();
      const taskId = randomUUID();
      const [portA, portB] = await freePorts(2);
      const a = startInstance('hub-serve', [String(portA)]);
      const b = startInstance('hub-start', [String(portB), deviceId, taskId]);
      try {
        await Promise.all([a.ready, b.ready]);
        const deviceHeaders = {
          authorization: 'Bearer mi-device-token',
          'x-rose-device-id': deviceId,
        };
        // The Mac's control channel lands on A; its tunnel and the worker land on B.
        const control = await frames(
          `ws://127.0.0.1:${portA}/api/local-devices/control`,
          deviceHeaders
        );
        control.ws.send(
          JSON.stringify({ type: 'hello', sessions: [], sessions_root: '/Users/mi/rs' })
        );
        a.child.stdin.write('GO\n');
        b.child.stdin.write('GO\n');
        await control.next(
          (f) => typeof f === 'object' && f.type === 'start_session',
          'start_session on A'
        );
        control.ws.send(
          JSON.stringify({ type: 'session_started', task_id: taskId, folder: '~/mi' })
        );
        const tunnel = await frames(
          `ws://127.0.0.1:${portB}/api/local-code-relay/${taskId}/device`,
          deviceHeaders
        );
        await waitFor(() => b.output().includes('STARTED\n'), "B's start to resolve");
        const token = createHmac('sha256', 'mi-relay-secret')
          .update(`local-code-relay:${taskId}`)
          .digest('hex');
        const worker = await frames(
          `ws://127.0.0.1:${portB}/api/local-code-relay/${taskId}?token=${token}`
        );
        const open = await tunnel.next(
          (f) => typeof f === 'object' && f.op === 'open',
          'channel open'
        );
        worker.ws.send('ping-from-worker');
        await tunnel.next(
          (f) => typeof f === 'object' && f.op === 'data' && f.data === 'ping-from-worker',
          'worker frame at the Mac'
        );
        tunnel.ws.send(JSON.stringify({ op: 'data', ch: open.ch, data: 'pong-from-mac' }));
        await worker.next((f) => f === 'pong-from-mac', 'Mac frame at the worker');
        b.child.stdin.write('CHECK\n');
        await control.next(
          (f) => typeof f === 'object' && f.type === 'stop_session' && f.task_id === taskId,
          'stop_session on A'
        );
        const result = await b.result;
        assert(result.online === true, `B must see the Mac online: ${JSON.stringify(result)}`);
        assert(
          result.home === `/Users/mi/rs/${taskId}`,
          `B must see the session HOME: ${result.home}`
        );
        assert(result.folder === '~/mi', `B must get the started folder: ${result.folder}`);
        assert(result.live === true, 'B must see the session live');
        for (const ws of [control.ws, tunnel.ws, worker.ws]) ws.close();
        a.child.stdin.write('DONE\n');
        await a.result;
      } finally {
        // A failed case kills its instances; their pending results are moot.
        a.result.catch(() => undefined);
        b.result.catch(() => undefined);
        a.child.kill();
        b.child.kill();
      }
    });

    await test('an E2B code session created on A runs project commands from B', async () => {
      const session = await prisma.claudeCodeSession.create({
        data: {
          agentId: randomUUID(),
          sandboxId: `mi-sbx-${randomUUID()}`,
          goal: 'multi-instance',
        },
      });
      try {
        const [remote] = await concurrently([['workspace-exec', [session.id]]]);
        const connected = remote.connected as string[] | undefined;
        assert(
          Array.isArray(connected) && connected[0] === session.sandboxId,
          `B must reach the session's sandbox: ${JSON.stringify(remote)}`
        );
        assert(remote.homeDir === '/home/user', `unexpected HOME ${String(remote.homeDir)}`);
        assert(
          remote.stdout === 'ran:echo hi',
          `B's command must run there: ${String(remote.stdout)}`
        );
        const [local] = await concurrently([['workspace-exec', [randomUUID()]]]);
        assert(local.homeDir === null, 'an unknown session must not resolve an executor');
      } finally {
        await prisma.claudeCodeSession.deleteMany({ where: { id: session.id } });
      }
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
