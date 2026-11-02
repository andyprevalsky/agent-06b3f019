/**
 * integration-accounts blackbox: the Gmail sync pipeline reports progress on its
 * Integration row, survives Google's per-user quota wall (403 rateLimitExceeded)
 * and an access token that expires mid-sync without dropping messages, and a
 * failed run cools down before the next full sync. Gmail is faked at the fetch
 * boundary (integration-accounts.gmail-fake.ts).
 *
 * Registered through integration-accounts.pipelines.cases.ts.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { GOOGLE_OAUTH_SCOPES } from '../../domains/integrations/googleScopes';
import { runGmailSyncJob } from '../../services/integrations/gmailSync';
import { FakeGmail, fillMailbox } from './integration-accounts.gmail-fake';
import {
  anonymousSession,
  assert,
  bar,
  progressRow,
  type Session,
} from './integration-accounts.support';

type User = () => Session;

async function gmailCredential(
  userId: string,
  address: string,
  token: string,
  refreshToken = 'refresh-token'
) {
  const row = await prisma.integration.create({
    data: {
      userId,
      name: 'gmail',
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
      config: { userEmail: address },
    },
  });
  await prisma.emailIntegrationCredential.create({
    data: {
      userId,
      integrationId: row.id,
      provider: 'GMAIL',
      email: address,
      accessToken: token,
      refreshToken,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      scopes: [...GOOGLE_OAUTH_SCOPES],
    },
  });
}

async function gmailSyncReportsMessagesSaved(user: User): Promise<void> {
  const session = user();
  const address = `owner.${randomUUID().slice(0, 8)}@example.com`;
  const gmail = new FakeGmail();
  const box = gmail.mailbox(address, 500, '9001');
  const { selected } = fillMailbox(box, { contacts: 3, perContact: 2, newsletters: 4, tag: 'p' });
  await gmailCredential(session.userId, address, box.token);
  const restore = gmail.install();
  try {
    await runGmailSyncJob({ userIds: [session.userId] });
  } finally {
    restore();
  }
  const row = await progressRow(session.userId, 'gmail');
  assert(row.state === 'synced', `gmail: run synced, got ${row.state} (${row.lastError})`);
  assert(row.unit === 'messages', `gmail: unit messages, got ${row.unit}`);
  assert(row.total === 500n, `gmail: total is the mailbox messagesTotal, got ${row.total}`);
  const saved = await prisma.messageRecord.count({ where: { person: { userId: session.userId } } });
  assert(
    saved === selected.length,
    `gmail: saved the ${selected.length} wanted messages, got ${saved}`
  );
  assert(row.done === BigInt(saved), `gmail: done = ${saved} messages saved, got ${row.done}`);
  const account = await bar(session, 'gmail');
  assert(account.state === 'synced' && account.progress?.pct === 100, 'gmail: synced bar');
  assert(account.label === address, 'gmail: labelled by its address');
}

async function gmailFailureEndsFailed(): Promise<void> {
  const session = await anonymousSession();
  try {
    const address = `broken.${randomUUID().slice(0, 8)}@example.com`;
    const gmail = new FakeGmail();
    const box = gmail.mailbox(address, 10, '1');
    box.listStatus = 403;
    await gmailCredential(session.userId, address, box.token);
    const restore = gmail.install();
    try {
      await runGmailSyncJob({ userIds: [session.userId] });
    } finally {
      restore();
    }
    const account = await bar(session, 'gmail');
    assert(account.state === 'sync_failed', `gmail: failed run, got ${account.state}`);
    assert(
      account.lastError === 'Gmail sync failed',
      `gmail: error shown, got ${account.lastError}`
    );
    const row = await progressRow(session.userId, 'gmail');
    assert(row.state === 'failed' && row.finishedAt !== null, 'gmail: the run is terminal');
  } finally {
    const where = { userId: session.userId };
    await prisma.integrationSyncProgress.deleteMany({ where });
    await prisma.emailIntegrationCredential.deleteMany({ where });
    await prisma.integration.deleteMany({ where });
  }
}

/**
 * Google answers an over-quota mailbox with 403 rateLimitExceeded, not 429. The
 * sync must back off and finish with every wanted message -- never drop the
 * rejected ones or fail the run, which left the historyId unsaved and restarted
 * a 30k-message full sync every 5 minutes (prod, 2026-10-28).
 */
async function gmailQuotaWallStillSavesEverything(skip: number): Promise<void> {
  const session = await anonymousSession();
  try {
    const address = `quota.${randomUUID().slice(0, 8)}@example.com`;
    const gmail = new FakeGmail();
    const box = gmail.mailbox(address, 10, '4242');
    const { selected } = fillMailbox(box, { contacts: 3, perContact: 2, newsletters: 4, tag: 'q' });
    // Over quota for one second -- far shorter than Google's real minute window.
    box.quotaWall = { skip, forMs: 1_000 };
    await gmailCredential(session.userId, address, box.token);
    const restore = gmail.install();
    try {
      await runGmailSyncJob({ userIds: [session.userId] });
    } finally {
      restore();
    }
    assert(box.quotaRejected > 0, 'gmail: the sync ran into the quota wall');
    const row = await progressRow(session.userId, 'gmail');
    assert(row.state === 'synced', `gmail: run synced past the quota wall, got ${row.state}`);
    const saved = await prisma.messageRecord.count({
      where: { person: { userId: session.userId } },
    });
    assert(
      saved === selected.length,
      `gmail: saved all ${selected.length} wanted messages past the quota wall, got ${saved}`
    );
    const integration = await prisma.integration.findFirstOrThrow({
      where: { userId: session.userId, name: 'gmail' },
    });
    const historyIds = (integration.config as { historyIds?: Record<string, string> }).historyIds;
    assert(
      historyIds?.[address] === '4242',
      `gmail: historyId recorded, got ${historyIds?.[address]}`
    );
  } finally {
    const where = { userId: session.userId };
    await prisma.messageRecord.deleteMany({ where: { person: where } });
    await prisma.person.deleteMany({ where });
    await prisma.integrationSyncProgress.deleteMany({ where });
    await prisma.emailIntegrationCredential.deleteMany({ where });
    await prisma.integration.deleteMany({ where });
  }
}

/**
 * A quota-paced full sync of a large mailbox outlives Google's one-hour access
 * token. When Google starts answering 401 mid-sync, the run refreshes the token
 * once and finishes with every wanted message on the same mailbox budget.
 */
async function gmailTokenExpiryMidSyncRefreshes(): Promise<void> {
  const session = await anonymousSession();
  try {
    const address = `expiry.${randomUUID().slice(0, 8)}@example.com`;
    const gmail = new FakeGmail();
    const box = gmail.mailbox(address, 10, '5151');
    const { selected } = fillMailbox(box, { contacts: 3, perContact: 2, newsletters: 4, tag: 'e' });
    // The token dies after the profile, list and a few metadata reads.
    box.tokenLifetimeRequests = 5;
    await gmailCredential(session.userId, address, box.token, box.refreshToken);
    const restore = gmail.install();
    try {
      await runGmailSyncJob({ userIds: [session.userId] });
    } finally {
      restore();
    }
    assert(box.refreshes === 1, `gmail: one token refresh for the run, got ${box.refreshes}`);
    const row = await progressRow(session.userId, 'gmail');
    assert(row.state === 'synced', `gmail: run synced past token expiry, got ${row.state}`);
    const saved = await prisma.messageRecord.count({
      where: { person: { userId: session.userId } },
    });
    assert(
      saved === selected.length,
      `gmail: saved all ${selected.length} wanted messages past token expiry, got ${saved}`
    );
  } finally {
    const where = { userId: session.userId };
    await prisma.messageRecord.deleteMany({ where: { person: where } });
    await prisma.person.deleteMany({ where });
    await prisma.integrationSyncProgress.deleteMany({ where });
    await prisma.emailIntegrationCredential.deleteMany({ where });
    await prisma.integration.deleteMany({ where });
  }
}

/**
 * A failed run cools down before the next attempt, so a full sync that keeps
 * failing cannot re-read the whole mailbox (and spend the user's Gmail quota)
 * every 5-minute tick. Once the cooldown has passed the integration syncs again.
 */
async function gmailFailedSyncCoolsDown(): Promise<void> {
  const session = await anonymousSession();
  try {
    const address = `cooldown.${randomUUID().slice(0, 8)}@example.com`;
    const gmail = new FakeGmail();
    const box = gmail.mailbox(address, 10, '6161');
    fillMailbox(box, { contacts: 1, perContact: 2, newsletters: 1, tag: 'c' });
    await gmailCredential(session.userId, address, box.token);
    const where = { userId: session.userId, name: 'gmail' };
    await prisma.integration.updateMany({
      where,
      data: { status: 'SYNC_FAILED', lastFailedSyncAt: new Date() },
    });
    const restore = gmail.install();
    try {
      await runGmailSyncJob({ userIds: [session.userId] });
      assert(
        box.batchCalls === 0 && box.fullFetched.length === 0,
        'gmail: no sync while cooling down'
      );
      let row = await prisma.integration.findFirstOrThrow({ where });
      assert(
        row.status === 'SYNC_FAILED',
        `gmail: still SYNC_FAILED in cooldown, got ${row.status}`
      );

      await prisma.integration.updateMany({
        where,
        data: { lastFailedSyncAt: new Date(Date.now() - 31 * 60_000) },
      });
      await runGmailSyncJob({ userIds: [session.userId] });
      row = await prisma.integration.findFirstOrThrow({ where });
      assert(row.status === 'CONNECTED', `gmail: synced after the cooldown, got ${row.status}`);
    } finally {
      restore();
    }
  } finally {
    const where = { userId: session.userId };
    await prisma.messageRecord.deleteMany({ where: { person: where } });
    await prisma.person.deleteMany({ where });
    await prisma.integrationSyncProgress.deleteMany({ where });
    await prisma.emailIntegrationCredential.deleteMany({ where });
    await prisma.integration.deleteMany({ where });
  }
}

export function gmailCases(user: User): Array<{ name: string; fn: () => Promise<void> }> {
  return [
    {
      name: 'Gmail sync: messages saved of messagesTotal, ends synced',
      fn: () => gmailSyncReportsMessagesSaved(user),
    },
    { name: 'Gmail sync: a failed address ends the run sync_failed', fn: gmailFailureEndsFailed },
    {
      name: 'Gmail sync: 403 rateLimitExceeded on the profile read is retried, nothing dropped',
      fn: () => gmailQuotaWallStillSavesEverything(0),
    },
    {
      name: 'Gmail sync: 403 rateLimitExceeded on metadata reads is retried, nothing dropped',
      // the profile passes, then the wall rejects the metadata reads
      fn: () => gmailQuotaWallStillSavesEverything(1),
    },
    {
      name: 'Gmail sync: 403 rateLimitExceeded batch sub-requests are re-fetched, nothing dropped',
      // profile + 10 metadata pass, then the wall rejects the full-content batch
      fn: () => gmailQuotaWallStillSavesEverything(11),
    },
    {
      name: 'Gmail sync: an access token that expires mid-sync is refreshed once, nothing dropped',
      fn: gmailTokenExpiryMidSyncRefreshes,
    },
    {
      name: 'Gmail sync: a failed integration cools down 30 min before the next full sync',
      fn: gmailFailedSyncCoolsDown,
    },
  ];
}
