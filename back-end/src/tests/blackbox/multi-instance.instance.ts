#!/usr/bin/env tsx
/**
 * One simulated backend instance for multi-instance.blackbox.ts.
 *
 * Each invocation is a separate Node process with its own module memory, the
 * same isolation two Render instances have. It runs one shared-state operation
 * through the real module, against the runner's database, and prints one JSON
 * line. A READY/GO stdin barrier aligns sibling processes so their operations
 * overlap.
 *
 * Usage: multi-instance.instance.ts <op> [...args]
 */

import { config } from 'dotenv';

config();

/** Signal READY once modules are loaded, then block until the parent sends GO. */
async function barrier(): Promise<void> {
  process.stdout.write('READY\n');
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Route this process's database traffic through a proxy that drops the
 * connection on the first reply carrying one of `tags` (a CommandComplete):
 * the statement commits but its acknowledgement never arrives. Call before
 * anything imports the Prisma client.
 */
async function dropFirstCommitAck(tags: string[]): Promise<{ dropped: () => boolean }> {
  const net = await import('node:net');
  const upstream = new URL(process.env.DATABASE_URL ?? '');
  let dropped = false;
  const proxy = net.createServer((client) => {
    const server = net.connect(Number(upstream.port || 5432), upstream.hostname);
    client.on('data', (chunk) => server.write(chunk));
    server.on('data', (chunk: Buffer) => {
      if (!dropped && tags.some((tag) => chunk.includes(tag))) {
        dropped = true;
        client.destroy();
        server.destroy();
        return;
      }
      client.write(chunk);
    });
    client.on('error', () => server.destroy());
    server.on('error', () => client.destroy());
    client.on('close', () => server.destroy());
    server.on('close', () => client.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));
  const proxied = new URL(upstream.toString());
  proxied.hostname = '127.0.0.1';
  proxied.port = String((proxy.address() as { port: number }).port);
  // Plaintext, so the proxy can see the CommandComplete tag.
  proxied.searchParams.set('sslmode', 'disable');
  process.env.DATABASE_URL = proxied.toString();
  process.env.DIRECT_URL = proxied.toString();
  return { dropped: () => dropped };
}

/** A real HTTP server with the production (routed) local-device hub on `port`. */
async function serveRoutedHub(port: number) {
  const { createServer } = await import('node:http');
  const { RoutedLocalDeviceHub } = await import('../../providers/localDevices/routedHub');
  const hub = new RoutedLocalDeviceHub(
    {
      verifyUser: async (token) => (token === 'mi-device-token' ? 'mi-hub-user' : null),
      findDevice: async (id) => ({
        id,
        userId: 'mi-hub-user',
        name: 'Multi-instance Mac',
        platform: 'darwin',
        appVersion: null,
        lastSeenAt: new Date(),
      }),
      findActiveSession: async () => null,
      touchDevice: async () => undefined,
      relaySecret: () => 'mi-relay-secret',
      pingIntervalMs: 1_000,
    },
    `http://127.0.0.1:${port}`
  );
  const server = createServer((_req, res) => res.end());
  hub.attach(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  return {
    hub,
    close: async () => {
      hub.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Wait for the next line on stdin (the parent's step signal). */
const nextLine = () =>
  new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });

async function main(): Promise<unknown> {
  const [op, ...args] = process.argv.slice(2);
  switch (op) {
    case 'pkce-put': {
      const store = await import('../../providers/agentcard/store');
      await barrier();
      await store.putPendingAuth(args[0], args[1], args[2]);
      return { ok: true };
    }
    case 'pkce-take': {
      const store = await import('../../providers/agentcard/store');
      await barrier();
      const taken = await store.takePendingAuth(args[0]);
      return { found: taken !== undefined, userId: taken?.userId ?? null };
    }
    case 'sms-lock': {
      const { withCommitLock } = await import('../../providers/smsSupervisor/supervisorHandler');
      await barrier();
      return withCommitLock(args[0], async () => {
        const enteredAt = Date.now();
        await sleep(Number(args[1]));
        return { enteredAt, leftAt: Date.now() };
      });
    }
    case 'sms-run': {
      // A supervisor run on this instance: captures its inbound seq, then asks
      // the commit gate whether it may still reply after a peer's /clear.
      const store = await import('../../providers/smsSupervisor/sessionStore');
      const gate = await import('../../providers/smsSupervisor/supervisorHandler');
      const mySeq = await store.recordInboundSms(args[0], 'multi-instance inbound');
      await barrier();
      await sleep(Number(args[1]));
      return { mySeq, ownsReply: await gate.inboundSeqStillCurrent(args[0], mySeq) };
    }
    case 'sms-clear': {
      const repo = await import('../../domains/sms-webhook/repo');
      await barrier();
      await repo.clearSmsSession(args[0]);
      return { cleared: true };
    }
    case 'auth-mint': {
      // Asks for auth options on a realm with no saved login, which mints the
      // agent identity when the stored one is outdated.
      const { getAuthOptions } = await import('../../providers/authOptions');
      await barrier();
      const options = await getAuthOptions(args[0], 'https://multi-instance.example');
      return { email: options.minted?.email ?? null };
    }
    case 'grant-remint': {
      // A completion on this instance hits a revoked grant and asks for recovery.
      const [userId, accountId, grantId] = args;
      const { installGrantRecovery } = await import('../../domains/compute-grants/service');
      const hook = installGrantRecovery({
        minter: {
          async mint() {
            await sleep(1_500);
            return { accessToken: `sk-ant-oat01-mi-${process.pid}` };
          },
        },
      });
      await barrier();
      const outcome = await hook({
        userId,
        provider: 'claude',
        accountId,
        grantId,
        status: 401,
        body: '{"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}',
      });
      return { status: outcome.status, accessToken: outcome.accessToken ?? null };
    }
    case 'steel-setup': {
      // Instance A is still setting up a Steel session (no BrowserSession row yet).
      const identity = await import('../../providers/steel/sessionIdentity');
      await identity.registerInFlightSteelSession(args[0]);
      await barrier();
      await sleep(Number(args[1]));
      await identity.unregisterInFlightSteelSession(args[0]);
      return { registered: true };
    }
    case 'steel-reap': {
      // Instance B's reaper sweeps the shared Steel account while A sets up.
      const { reconcileOrphanedSteelSessions } =
        await import('../../providers/steel/sessionReaper');
      await barrier();
      await sleep(Number(args[1]));
      const released: string[] = [];
      await reconcileOrphanedSteelSessions({
        identity: () => 'render:multi-instance',
        isOwned: () => true,
        listLiveSessions: async () => [
          { id: args[0], createdAt: new Date(Date.now() - 11 * 60_000).toISOString() },
        ],
        heldSessionIds: async () => new Set(),
        release: async (id) => {
          released.push(id);
        },
      });
      return { released };
    }
    case 'wa-dedupe-lost-ack': {
      // The dedupe claim commits, then the connection drops before Postgres's
      // reply reaches this instance (Supavisor closing a client: P1017). The
      // query layer retries the INSERT; it must still see its own claim.
      const lostAck = await dropFirstCommitAck(['INSERT 0 1']);
      const wa = await import('../../domains/whatsapp-webhook/service');
      await barrier();
      const duplicate = await wa.alreadyProcessedMessage(args[0]);
      return { duplicate, dropped: lostAck.dropped() };
    }
    case 'sms-clear-lost-ack': {
      // Same lost ack on /clear: the replayed write must not clear again.
      const lostAck = await dropFirstCommitAck(['UPDATE 1', 'INSERT 0 1']);
      const repo = await import('../../domains/sms-webhook/repo');
      await barrier();
      await repo.clearSmsSession(args[0]);
      return { dropped: lostAck.dropped() };
    }
    case 'hub-serve': {
      // Owns the Mac's control channel; serves until the parent's next line.
      const served = await serveRoutedHub(Number(args[0]));
      await barrier();
      await nextLine();
      await served.close();
      return { served: true };
    }
    case 'hub-start': {
      // Another instance: starts, probes and stops a session on a Mac whose
      // control channel lives on the 'hub-serve' instance.
      const [port, deviceId, taskId] = args;
      const served = await serveRoutedHub(Number(port));
      await barrier();
      await sleep(1_500);
      const online = await served.hub.deviceOnline(deviceId);
      const home = await served.hub.sessionHome(deviceId, taskId);
      const { folder } = await served.hub.startSession({
        deviceId,
        userId: 'mi-hub-user',
        command: {
          type: 'start_session',
          task_id: taskId,
          agent_id: taskId,
          provider: 'claude',
          folder: null,
          envs: {},
          relay_path: `/api/local-code-relay/${taskId}/device`,
          home_files: [],
        },
        deadlineMs: 15_000,
      });
      process.stdout.write('STARTED\n');
      await nextLine();
      const live = await served.hub.sessionLive(deviceId, taskId);
      await served.hub.stopSession(taskId, deviceId);
      await served.close();
      return { online, home, folder, live };
    }
    case 'workspace-exec': {
      // An E2B code session created on another instance: this instance has no
      // registered executor, so it must reach the sandbox by the session's id.
      const workspace = await import('../../providers/projects/workspace');
      const connected: string[] = [];
      await barrier();
      const executor = await workspace.resolveWorkspaceExecutor(args[0], async (sandboxId) => {
        connected.push(sandboxId);
        return {
          files: { write: async () => undefined },
          commands: { run: async (cmd) => ({ exitCode: 0, stdout: `ran:${cmd}`, stderr: '' }) },
        };
      });
      const run = executor === null ? null : await executor.run('echo hi', { timeoutMs: 1_000 });
      return { connected, homeDir: executor?.homeDir ?? null, stdout: run?.stdout ?? null };
    }
    case 'wa-dedupe': {
      const wa = await import('../../domains/whatsapp-webhook/service');
      await barrier();
      return { duplicate: await wa.alreadyProcessedMessage(args[0]) };
    }
    case 'gmail-claim': {
      const gmail = await import('../../services/integrations/gmailSync');
      await barrier();
      return { claimed: await gmail.claimGmailIntegrationForSync(args[0]) };
    }
    case 'plaid-claim': {
      const plaid = await import('../../domains/integrations/service.plaidTransactions');
      await barrier();
      const claim = await plaid.claimPlaidItemSync(args[0]);
      if (claim === null) return { claimed: false };
      await sleep(Number(args[1]));
      await claim.release();
      return { claimed: true };
    }
    case 'lease-hold': {
      // Holds a short lease well past its TTL while the heartbeat renews it.
      const shared = await import('../../providers/sharedState');
      const [key, ttlMs, holdMs] = args;
      const token = await shared.acquireLease('mi-lease', key, Number(ttlMs));
      if (token === null) return { held: false };
      const lease = shared.holdLease('mi-lease', key, token, Number(ttlMs));
      await barrier();
      await sleep(Number(holdMs));
      const lost = lease.lost();
      await lease.release();
      return { held: true, lost };
    }
    case 'lease-try': {
      const shared = await import('../../providers/sharedState');
      const [key, ttlMs, afterMs] = args;
      await barrier();
      await sleep(Number(afterMs));
      return { acquired: (await shared.acquireLease('mi-lease', key, Number(ttlMs))) !== null };
    }
    case 'agentcard-refresh': {
      const runtime = await import('../../providers/agentcard/runtime');
      await barrier();
      return { accessToken: await runtime.getValidAccessToken(args[0]) };
    }
    case 'connect-host': {
      // Owns a live connect session (a stand-in for the remote browser) the way
      // startConnectSession does, and reports whether a peer's cancel released it.
      const [connectId, userId, holdMs] = args;
      const { pending } = await import('../../domains/compute-grants/connectSession.state');
      const shared: Record<string, unknown> =
        await import('../../domains/compute-grants/connectSession.shared').catch(() => ({}));
      let released = false;
      const entry = {
        stage: 'awaiting_human' as const,
        connectId,
        userId,
        provider: 'claude',
        steelSessionId: 'mi-session',
        cdpBase: null,
        liveViewUrl: 'https://live.example/mi',
        release: async () => {
          released = true;
        },
        cdp: null,
        deadline: Date.now() + 10 * 60 * 1000,
        done: false,
      };
      pending.set(connectId, entry);
      if (typeof shared.startSharedMirror === 'function') {
        (shared.startSharedMirror as (e: typeof entry) => void)(entry);
      }
      await barrier();
      const until = Date.now() + Number(holdMs);
      while (!released && Date.now() < until) await sleep(200);
      return { released };
    }
    case 'connect-peer': {
      const [connectId, userId] = args;
      const session = await import('../../domains/compute-grants/connectSession');
      await barrier();
      await sleep(2_500);
      const poll = await session.pollConnectSession(userId, connectId);
      const foreign = await session.pollConnectSession('someone-else', connectId);
      await session.cancelConnectSession(userId, connectId);
      return { poll, foreign };
    }
    default:
      throw new Error(`unknown op ${op}`);
  }
}

main()
  .then((result) => {
    process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
    process.exit(0);
  })
  .catch((error: unknown) => {
    process.stdout.write(
      `RESULT ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`
    );
    process.exit(1);
  });
