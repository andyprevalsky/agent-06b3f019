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
      const release = await plaid.claimPlaidItemSync(args[0]);
      if (release === null) return { claimed: false };
      await sleep(Number(args[1]));
      await release();
      return { claimed: true };
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
