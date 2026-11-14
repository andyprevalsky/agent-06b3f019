/**
 * Agent-loop lease usage: the agent loop (agents/helpers/llm.py call_llm) builds
 * its lease without the login's integration id, so its usage heartbeat names
 * the token by credential fingerprint. The backend resolves that fingerprint
 * within the lease's own user only.
 *
 *   heartbeat { lineageKey, usage, credential }
 *     └─► lease (user source) ─► that user's CONNECTED logins
 *           └─► stored token fingerprint == credential ─► usage on that row only
 *
 * Invariants:
 *   - the usage lands on the login whose token the agent held, never a sibling
 *   - a fingerprint of another user's login records nothing
 *   - a heartbeat naming no login at all (no id, no fingerprint) records nothing
 */

import type { IntegrationType } from '@prisma/client';
import { credentialFingerprint } from '../../providers/codeLoginRejection';
import { prisma } from '../../providers/database';
import { encryptClaudeEnvelope } from './integrations.context';

interface LeaseAccountDto {
  accountId: string;
  usage: {
    fiveHour: { usedPct: number; resetsAt: string | null } | null;
    sevenDay: { usedPct: number; resetsAt: string | null } | null;
    source: string;
    status: string | null;
  } | null;
}

export interface LeaseUsageContext {
  test: (name: string, fn: () => Promise<void>) => void;
  listAccounts: (userId: string, provider?: string) => Promise<LeaseAccountDto[]>;
  run: string;
  baseUrl: string;
  apiKey: string;
  chatUsers: string[];
  leases: string[];
  integrationType: IntegrationType;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function registerLeaseUsageCases(ctx: LeaseUsageContext): void {
  const DAY_MS = 86_400_000;
  const isoIn = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  function newUser(label: string): string {
    const userId = `usage-lease-${ctx.run}-${label}-${ctx.chatUsers.length}`;
    ctx.chatUsers.push(userId);
    return userId;
  }

  /** A connected inference-only Claude login whose stored token is `token`. */
  async function seedLogin(userId: string, label: string, token: string) {
    const accountId = `${userId}-${label}`;
    const credentials = JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        refreshToken: '',
        expiresAt: Date.now() + 365 * DAY_MS,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      },
    });
    await prisma.computeAccountConnection.create({
      data: { userId, provider: 'claude', accountId, accountEmail: `${accountId}@example.com` },
    });
    await prisma.integration.create({
      data: {
        userId,
        type: ctx.integrationType,
        name: 'claude_code',
        status: 'CONNECTED',
        isActive: true,
        accountId,
        config: { encryptedCredentials: encryptClaudeEnvelope(credentials) },
      },
    });
    return accountId;
  }

  /** A live user-source Claude lease, as the agent loop holds it. */
  async function seedUserLease(userId: string) {
    const lineageKey = `usage-lease-${ctx.run}-${ctx.leases.length}`;
    ctx.leases.push(lineageKey);
    await prisma.computeTokenLineageLease.create({
      data: { lineageKey, tokenType: 'claude', tokenSource: 'user', tokenIdentity: userId, userId },
    });
    return lineageKey;
  }

  async function heartbeat(body: Record<string, unknown>) {
    const res = await fetch(
      `${ctx.baseUrl}/api/integrations/compute-code/token/lineage-heartbeat`,
      {
        method: 'POST',
        headers: { 'X-API-Key': ctx.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    assert(res.status === 200, `heartbeat returned ${res.status}`);
    return (await res.json()) as { ok: boolean; usageRecorded: boolean };
  }

  const snapshot = (sevenDayReset: string) => ({
    observedAt: isoIn(0),
    fiveHour: { usedPct: 2, resetsAt: isoIn(3 * 3_600_000) },
    sevenDay: { usedPct: 17, resetsAt: sevenDayReset },
    source: 'response',
    status: 'allowed',
  });

  ctx.test(
    'an agent-loop heartbeat naming its token by fingerprint records on that login only',
    async () => {
      const userId = newUser('loop');
      const tokenA = `loop-token-a-${ctx.run}`;
      const tokenB = `loop-token-b-${ctx.run}`;
      const accountA = await seedLogin(userId, 'a', tokenA);
      const accountB = await seedLogin(userId, 'b', tokenB);
      const lease = await seedUserLease(userId);
      const reset = isoIn(5 * DAY_MS);
      const res = await heartbeat({
        lineageKey: lease,
        credential: credentialFingerprint(tokenB),
        usage: snapshot(reset),
      });
      assert(res.ok && res.usageRecorded, `usage must be recorded, got ${JSON.stringify(res)}`);
      const accounts = await ctx.listAccounts(userId, 'claude');
      const rowA = accounts.find((a) => a.accountId === accountA);
      const rowB = accounts.find((a) => a.accountId === accountB);
      assert(
        rowB?.usage?.sevenDay?.usedPct === 17,
        `held login must show usage: ${JSON.stringify(rowB)}`
      );
      assert(
        rowB.usage.sevenDay.resetsAt === reset && rowB.usage.fiveHour?.usedPct === 2,
        `held login must show both windows and the reset: ${JSON.stringify(rowB.usage)}`
      );
      assert(
        rowA !== undefined && rowA.usage === null,
        `sibling login must stay unmeasured: ${JSON.stringify(rowA)}`
      );
    }
  );

  ctx.test("a fingerprint of another user's login records nothing", async () => {
    const owner = newUser('owner');
    const other = newUser('other');
    const ownerToken = `owner-token-${ctx.run}`;
    const ownerAccount = await seedLogin(owner, 'a', ownerToken);
    await seedLogin(other, 'a', `other-token-${ctx.run}`);
    const lease = await seedUserLease(other);
    const res = await heartbeat({
      lineageKey: lease,
      credential: credentialFingerprint(ownerToken),
      usage: snapshot(isoIn(5 * DAY_MS)),
    });
    assert(
      res.ok && !res.usageRecorded,
      `another user's login must not be written: ${JSON.stringify(res)}`
    );
    const ownerRow = (await ctx.listAccounts(owner, 'claude')).find(
      (a) => a.accountId === ownerAccount
    );
    assert(
      ownerRow !== undefined && ownerRow.usage === null,
      `owner row changed: ${JSON.stringify(ownerRow)}`
    );
  });

  ctx.test('a heartbeat naming no login at all records nothing', async () => {
    const userId = newUser('unnamed');
    await seedLogin(userId, 'a', `unnamed-token-a-${ctx.run}`);
    await seedLogin(userId, 'b', `unnamed-token-b-${ctx.run}`);
    const lease = await seedUserLease(userId);
    const res = await heartbeat({ lineageKey: lease, usage: snapshot(isoIn(5 * DAY_MS)) });
    assert(
      res.ok && !res.usageRecorded,
      `an unnamed login must not be guessed: ${JSON.stringify(res)}`
    );
    const accounts = await ctx.listAccounts(userId, 'claude');
    assert(
      accounts.every((a) => a.usage === null),
      `no row may be written: ${JSON.stringify(accounts)}`
    );
  });
}
